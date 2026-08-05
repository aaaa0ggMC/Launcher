import type { ParsedVar, RespTransform, TemplatePart, VarConstraint, VarType } from '../types'

// Only match {identifier} or {identifier:...} — not JSON { } objects
const VAR_RE = /\{([a-zA-Z_]\w*(?::[^}]*)?)\}/g

const VALID_TYPES: VarType[] = ['string', 'number', 'select', 'textarea', 'bool']

// Match default(value) at the end of the constraint string.
// (.*?) is lazy so it captures the minimum before :default
const DEF_RE = /(.*?):default\s*\(\s*(.+?)\s*\)$/s

function unquote(s: string): string {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

export function parseVar(raw: string): ParsedVar | null {
  const parts = raw.split(':')
  if (parts.length < 1) return null

  const name = parts[0].trim()
  if (!name || !/^[a-zA-Z_]\w*$/.test(name)) return null

  if (parts.length === 1) {
    return { name, type: 'string', constraint: null, defaultValue: undefined }
  }

  const typeStr = parts[1].trim().toLowerCase()
  const type: VarType = VALID_TYPES.includes(typeStr as VarType) ? (typeStr as VarType) : 'string'

  let constraint: VarConstraint | null = null
  let defaultValue: string | undefined

  if (parts.length >= 3) {
    const rest = parts.slice(2).join(':').trim()
    let constraintStr = rest

    // Extract default(value) — can appear anywhere in the constraint string
    const m = rest.match(DEF_RE)
    if (m) {
      constraintStr = m[1].trim()
      const rawDefVal = m[2].trim()
      defaultValue = type === 'bool' ? rawDefVal : unquote(rawDefVal)
    }

    if (constraintStr) {
      const c = parseConstraint(constraintStr)
      if (c) constraint = c
    }
  }

  // auto-detect number type if constraint is numeric
  if (
    constraint &&
    (constraint.kind === 'range' || constraint.kind === 'min' || constraint.kind === 'max')
  ) {
    return { name, type: 'number', constraint, defaultValue }
  }

  // auto-detect select type
  if (constraint?.kind === 'options') {
    return { name, type: 'select', constraint, defaultValue }
  }

  return { name, type, constraint, defaultValue }
}

function parseConstraint(s: string): VarConstraint | null {
  const rangeMatch = s.match(/^range\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/)
  if (rangeMatch) {
    return {
      kind: 'range',
      min: parseFloat(rangeMatch[1]),
      max: parseFloat(rangeMatch[2])
    }
  }

  const minMatch = s.match(/^min\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)$/)
  if (minMatch) return { kind: 'min', val: parseFloat(minMatch[1]) }

  const maxMatch = s.match(/^max\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)$/)
  if (maxMatch) return { kind: 'max', val: parseFloat(maxMatch[1]) }

  const optionsMatch = s.match(/^options\s*\(\s*(.+)\s*\)$/)
  if (optionsMatch) {
    const values = optionsMatch[1]
      .split(',')
      .map((v) => unquote(v.trim()))
      .filter(Boolean)
    if (values.length > 0) return { kind: 'options', values }
  }

  return null
}

export function parseTemplate(text: string): TemplatePart[] {
  const parts: TemplatePart[] = []
  let lastIndex = 0
  const re = new RegExp(VAR_RE.source, 'g')
  let match: RegExpExecArray | null

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ kind: 'text', value: text.slice(lastIndex, match.index) })
    }

    const raw = match[1].trim()
    const parsed = parseVar(raw)
    if (parsed) {
      parts.push({ kind: 'var', value: match[0], varInfo: parsed })
    } else {
      parts.push({ kind: 'text', value: match[0] })
    }

    lastIndex = re.lastIndex
  }

  if (lastIndex < text.length) {
    parts.push({ kind: 'text', value: text.slice(lastIndex) })
  }

  return parts
}

export function extractAllVars(templates: string[], exclude?: Set<string>): ParsedVar[] {
  const seen = new Set<string>()
  const vars: ParsedVar[] = []
  for (const tpl of templates) {
    for (const part of parseTemplate(tpl)) {
      if (
        part.kind === 'var' &&
        part.varInfo &&
        !seen.has(part.varInfo.name) &&
        !exclude?.has(part.varInfo.name)
      ) {
        seen.add(part.varInfo.name)
        vars.push(part.varInfo)
      }
    }
  }
  return vars
}

export function interpolate(text: string, values: Record<string, string>): string {
  return text.replace(VAR_RE, (_, key: string) => {
    const name = key.split(':')[0].trim()
    return values[name] ?? `{${key}}`
  })
}

// --- Response transform utilities ---

/** Walk a parsed JSON value using a dot/bracket path like ".choices[0].message.content" */
export function resolveJsonPath(root: unknown, path: string): unknown {
  const segments = path.match(/[^.[\]]+|\[(\d+)\]/g)
  if (!segments) return undefined
  let cur: unknown = root
  for (const seg of segments) {
    if (cur == null) return undefined
    if (seg.startsWith('[')) {
      const idx = parseInt(seg.slice(1, -1), 10)
      cur = (cur as unknown[])[idx]
    } else {
      cur = (cur as Record<string, unknown>)[seg]
    }
  }
  return cur
}

interface ParsedPath {
  raw: string
  /** segments of the path */
  segments: string[]
  /**
   * Group key. Same group => zipped together. Different groups => Cartesian.
   * - Explicit `[X]`: group key is the string "X".
   * - Implicit (auto-expandable array encountered at the first array ancestor):
   *   group key is the dot-path of the array being iterated.
   * - Scalar / single-index `[n]` paths with no array ancestor: null (constants).
   */
  groupKey: string | null
  /** number of values produced by this path's primary iteration (0 if scalar) */
  length: number
  /**
   * Segment index whose value is the array being implicitly iterated, or -1 if
   * none. When set, resolvePathScalar indexes that array by iterMap[groupKey].
   */
  implicitArrayAt: number
}

/**
 * Split a path like `data[X].id` or `choices[0].message.content` into segments.
 * Each segment is either a bare key, `[n]` (numeric index), or `[X]` (named
 * iterator placeholder, non-numeric).
 */
function splitPath(path: string): string[] {
  return path.match(/[^.[\]]+|\[[^\]]+\]/g) ?? []
}

/**
 * Resolve a path against a JSON value for one iteration step. Numeric `[n]`
 * indexes a single element. Named `[X]` indexes by iterMap[X]. Implicit arrays
 * (path.implicitArrayAt) index the array by iterMap[groupKey] before applying
 * the segment. Returns the leaf value.
 */
function resolvePathScalar(
  json: unknown,
  path: ParsedPath,
  iterMap: Record<string, number>
): unknown {
  let cur: unknown = json
  for (let i = 0; i < path.segments.length; i++) {
    const seg = path.segments[i]
    // Implicit/explicit array pivot: index the current array by the group index.
    if (i === path.implicitArrayAt && path.groupKey !== null && Array.isArray(cur)) {
      const idx = iterMap[path.groupKey] ?? 0
      cur = cur[idx]
      if (cur == null) return undefined
    }
    if (seg.startsWith('[')) {
      const inner = seg.slice(1, -1)
      const idx = /^\d+$/.test(inner) ? parseInt(inner, 10) : (iterMap[inner] ?? 0)
      cur = Array.isArray(cur) ? cur[idx] : undefined
    } else {
      cur = (cur as Record<string, unknown>)[seg]
    }
    if (cur == null && i < path.segments.length - 1) return undefined
  }
  return cur
}

/** Stringify a resolved leaf value for text output. */
function stringifyLeaf(v: unknown, rawPath: string): string {
  if (v === undefined || v === null) return `{.${rawPath}}`
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

interface TextTemplatePart {
  kind: 'text' | 'path'
  text?: string
  path?: string
}

/** Parse a format string into literal-text and `{.path}` parts. */
function parseFormatTemplate(format: string): TextTemplatePart[] {
  const parts: TextTemplatePart[] = []
  const re = /\{\.([^}]+)\}/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(format)) !== null) {
    if (m.index > last) parts.push({ kind: 'text', text: format.slice(last, m.index) })
    parts.push({ kind: 'path', path: m[1].trim() })
    last = re.lastIndex
  }
  if (last < format.length) parts.push({ kind: 'text', text: format.slice(last) })
  return parts
}

/** Compute the group key and length for a single path against the JSON. */
function classifyPath(json: unknown, path: string): ParsedPath {
  const segments = splitPath(path)
  // Walk to find the first array ancestor (implicit pivot) and any named [X].
  let cur: unknown = json
  let dotPath = ''
  let groupKey: string | null = null
  let length = 0
  let implicitKey: string | null = null
  let implicitArrayAt = -1
  let segIndex = 0
  for (const seg of segments) {
    if (seg.startsWith('[')) {
      const inner = seg.slice(1, -1)
      if (/^\d+$/.test(inner)) {
        // numeric index: descend without iterating
        const idx = parseInt(inner, 10)
        cur = Array.isArray(cur) ? cur[idx] : undefined
        dotPath += `[${idx}]`
      } else {
        // named iterator [X]: explicit group; the array is `cur` (before [X]).
        groupKey = inner
        implicitArrayAt = segIndex
        length = Array.isArray(cur) ? cur.length : 0
        dotPath += `[${inner}]`
      }
    } else {
      // bare key
      if (Array.isArray(cur)) {
        // implicit auto-expand: this key is applied per-element; mark the array
        // (current value, before applying the key) as the iteration pivot.
        implicitKey = dotPath
        implicitArrayAt = segIndex
        length = cur.length
        cur = cur[0] == null ? undefined : (cur[0] as Record<string, unknown>)[seg]
        dotPath += `.${seg}`
      } else if (cur != null && typeof cur === 'object') {
        cur = (cur as Record<string, unknown>)[seg]
        dotPath += dotPath ? `.${seg}` : seg
      } else {
        cur = undefined
        dotPath += dotPath ? `.${seg}` : seg
      }
    }
    segIndex++
  }
  // Resolve group key precedence: explicit [X] wins, else implicit array path.
  if (!groupKey && implicitKey !== null) groupKey = `@${implicitKey}`
  return { raw: path, segments, groupKey, length, implicitArrayAt }
}

/**
 * Render a format template against JSON, returning one string per iteration.
 * Iteration rules:
 *  - Paths sharing a group key are zipped (same index).
 *  - Paths with different group keys produce a Cartesian product across groups.
 *  - Scalar paths (groupKey null) are constants appearing in every row.
 *  - Explicit `[X]` tokens are bound to the array preceding them.
 *  - Implicit arrays (a `.key` hitting an array) iterate over all elements.
 * Returns at least one string; a single result means no iteration occurred.
 */
export function iterTemplate(format: string, json: unknown): string[] {
  const parts = parseFormatTemplate(format)
  const pathParts = parts.filter((p): p is TextTemplatePart & { path: string } => p.kind === 'path')
  if (pathParts.length === 0) {
    const text = parts.map((p) => p.text ?? '').join('')
    return text ? [text] : []
  }
  const classified = pathParts.map((p) => classifyPath(json, p.path!))

  // Group paths by groupKey (null groups are constants).
  const groupMap = new Map<string | null, number[]>()
  classified.forEach((c, i) => {
    const arr = groupMap.get(c.groupKey) ?? []
    arr.push(i)
    groupMap.set(c.groupKey, arr)
  })
  const groupKeys = [...groupMap.keys()].filter((k) => k !== null) as string[]
  // If no iterating groups, render once with all scalars.
  if (groupKeys.length === 0) {
    return [renderRowWithJson(json, parts, classified, {})]
  }
  // Group lengths (max length among paths in the group; usually they match).
  const groupLen = new Map<string, number>()
  for (const k of groupKeys) {
    const indices = groupMap.get(k)!
    groupLen.set(k, Math.max(0, ...indices.map((i) => classified[i].length)))
  }
  // Cartesian product over groups; each group iterates 0..len-1.
  const rows: string[] = []
  const combos = cartesian(
    groupKeys.map((k) => Array.from({ length: groupLen.get(k)! }, (_, i) => i))
  )
  for (const combo of combos) {
    const iterMap: Record<string, number> = {}
    groupKeys.forEach((k, gi) => {
      iterMap[k] = combo[gi]
    })
    rows.push(renderRowWithJson(json, parts, classified, iterMap))
  }
  return rows.length > 0 ? rows : [renderRowWithJson(json, parts, classified, {})]
}

/** Cartesian product of arrays of numbers. */
function cartesian(arrays: number[][]): number[][] {
  if (arrays.length === 0) return [[]]
  let result: number[][] = [[]]
  for (const arr of arrays) {
    const next: number[][] = []
    for (const r of result) {
      for (const v of arr) next.push([...r, v])
    }
    result = next
  }
  return result
}

/** Render one row of the template given an iteration index map. */
function renderRowWithJson(
  json: unknown,
  parts: TextTemplatePart[],
  classified: ParsedPath[],
  iterMap: Record<string, number>
): string {
  let out = ''
  let pi = 0
  for (const part of parts) {
    if (part.kind === 'text') {
      out += part.text ?? ''
    } else {
      const c = classified[pi]
      const val = resolvePathScalar(json, c, iterMap)
      out += stringifyLeaf(val, c.raw)
      pi++
    }
  }
  return out
}

/**
 * Resolve an `entry` path for img/audio/video transforms, returning a list of
 * leaf values. A path that ends on (or descends through) an array yields one
 * value per element; a scalar path yields a single value. `[n]` indexes a
 * single element. This mirrors the text-template iteration but for plain
 * `entry` strings (no format/interpolation).
 */
export function iterEntryValues(json: unknown, entry: string): unknown[] {
  const segments = splitPath(entry)
  if (segments.length === 0) return []
  let cur: unknown[] = [json]
  for (const seg of segments) {
    const next: unknown[] = []
    if (seg.startsWith('[')) {
      const inner = seg.slice(1, -1)
      const idx = /^\d+$/.test(inner) ? parseInt(inner, 10) : 0
      for (const v of cur) next.push(Array.isArray(v) ? v[idx] : undefined)
    } else {
      for (const v of cur) {
        if (Array.isArray(v)) {
          for (const item of v)
            next.push(item == null ? undefined : (item as Record<string, unknown>)[seg])
        } else if (v != null && typeof v === 'object') {
          next.push((v as Record<string, unknown>)[seg])
        } else {
          next.push(undefined)
        }
      }
    }
    cur = next
  }
  // Flatten one level: a leaf array value (e.g. ["u1","u2"]) should yield its
  // elements, not the array itself. Object-element arrays are already expanded
  // during the walk, so this only flattens remaining leaf arrays.
  const flat: unknown[] = []
  for (const v of cur) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) flat.push(...v)
    else flat.push(v)
  }
  return flat
}

/** Format an array of iteration results as an enumerated list, or a single string. */
function formatIterated(rows: string[]): string {
  if (rows.length === 0) return ''
  if (rows.length === 1) return rows[0]
  return rows.map((r, i) => `${i}. ${r}`).join('\n')
}

export interface TransformResult {
  kind: 'text' | 'img' | 'audio' | 'video'
  label: string
  value: string
  images?: string[]
  audioSrc?: string
  audioType?: string
  videoSrc?: string
  videoType?: string
  children?: TransformResult[]
}

function detectAudioMime(b64: string): string {
  const head = b64.slice(0, 20)
  if (head.startsWith('SUQz') || head.startsWith('//u')) return 'audio/mpeg'
  if (head.startsWith('UklGR')) return 'audio/wav'
  if (head.startsWith('T2dnUw')) return 'audio/ogg'
  if (head.startsWith('ZkxhQw')) return 'audio/flac'
  return 'audio/mpeg'
}

/** Convert a Blob to a data: URL string */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

/** Guess audio MIME from file extension in a URL */
function audioMimeFromExt(url: string): string {
  const m = url.match(/\.([a-z0-9]+)(?:\?|$)/i)
  switch (m?.[1]?.toLowerCase()) {
    case 'mp3':
    case 'mpeg':
      return 'audio/mpeg'
    case 'wav':
      return 'audio/wav'
    case 'ogg':
    case 'oga':
      return 'audio/ogg'
    case 'flac':
      return 'audio/flac'
    case 'aac':
      return 'audio/aac'
    case 'wma':
      return 'audio/x-ms-wma'
    case 'm4a':
      return 'audio/mp4'
    case 'webm':
      return 'audio/webm'
    default:
      return ''
  }
}

/** Guess video MIME from file extension in a URL */
function videoMimeFromExt(url: string): string {
  const m = url.match(/\.([a-z0-9]+)(?:\?|$)/i)
  switch (m?.[1]?.toLowerCase()) {
    case 'mp4':
    case 'm4v':
      return 'video/mp4'
    case 'webm':
      return 'video/webm'
    case 'ogg':
    case 'ogv':
      return 'video/ogg'
    case 'mov':
    case 'qt':
      return 'video/quicktime'
    case 'avi':
      return 'video/x-msvideo'
    case 'mkv':
      return 'video/x-matroska'
    case 'm3u8':
      return 'application/x-mpegURL'
    default:
      return ''
  }
}

/** Convert hex string to Uint8Array, handling large inputs */
function hexToBytes(hex: string): Uint8Array {
  // Strip any whitespace/non-hex chars
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  const len = Math.floor(clean.length / 2)
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/** Convert Uint8Array to base64 using chunked String.fromCharCode to avoid stack overflow */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000 // 32k chunks
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK)
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

/** Render a text transform: iterate the template, enumerate if multiple rows. */
function handleTextTransform(json: unknown, t: RespTransform): TransformResult {
  if (!t.format) return { kind: 'text', label: t.label, value: '' }
  const rows = iterTemplate(t.format, json)
  return { kind: 'text', label: t.label, value: formatIterated(rows) }
}

/** Render an image transform: enumerate every resolved image URL. */
function handleImgTransform(json: unknown, t: RespTransform): TransformResult {
  if (!t.entry) return { kind: 'text', label: t.label, value: '' }
  const vals = iterEntryValues(json, t.entry.trim())
  const urls = vals.filter((v): v is string => typeof v === 'string')
  if (urls.length === 0) return { kind: 'text', label: t.label, value: '' }
  return { kind: 'img', label: t.label, value: urls[0], images: urls }
}

/** Fetch a URL and return a data: URL plus detected MIME. */
async function fetchToDataUrl(
  url: string,
  detect: (b64: string, blob: Blob, url: string) => string,
  fallbackMime: string
): Promise<{ dataUrl: string; mime: string } | { error: string }> {
  try {
    const resp = await fetch(url)
    const blob = await resp.blob()
    const rawDataUrl = await blobToDataUrl(blob)
    const idx = rawDataUrl.indexOf(',')
    const b64 = idx >= 0 ? rawDataUrl.slice(idx + 1) : ''
    const mime = detect(b64, blob, url) || fallbackMime
    return { dataUrl: `data:${mime};base64,${b64}`, mime }
  } catch {
    return { error: `Failed to fetch: ${url}` }
  }
}

/** Render an audio-url transform: fetch each resolved URL, enumerate results. */
async function handleAudioUrlTransform(json: unknown, t: RespTransform): Promise<TransformResult> {
  if (!t.entry) return { kind: 'text', label: t.label, value: '' }
  const vals = iterEntryValues(json, t.entry.trim())
  const urls = vals.filter((v): v is string => typeof v === 'string' && /^https?:\/\//.test(v))
  if (urls.length === 0) return { kind: 'text', label: t.label, value: '' }
  const items = await Promise.all(
    urls.map((url) =>
      fetchToDataUrl(
        url,
        (b64, blob, u) =>
          t.audioMime || detectAudioMime(b64) || blob.type || audioMimeFromExt(u) || 'audio/mpeg',
        'audio/mpeg'
      ).then((r) => ('error' in r ? null : { url, dataUrl: r.dataUrl, mime: r.mime }))
    )
  )
  const ok = items.filter((r): r is { url: string; dataUrl: string; mime: string } => r !== null)
  if (ok.length === 0) return { kind: 'text', label: t.label, value: 'Failed to fetch' }
  if (ok.length === 1) {
    return {
      kind: 'audio',
      label: t.label,
      value: ok[0].url,
      audioSrc: ok[0].dataUrl,
      audioType: ok[0].mime
    }
  }
  return {
    kind: 'audio',
    label: t.label,
    value: `${ok.length} audio items`,
    audioSrc: ok[0].dataUrl,
    audioType: ok[0].mime,
    children: ok.map((r, i) => ({
      kind: 'audio' as const,
      label: `${i}`,
      value: r.url,
      audioSrc: r.dataUrl,
      audioType: r.mime
    }))
  }
}

/** Render a video-url transform: fetch each resolved URL, enumerate results. */
async function handleVideoUrlTransform(json: unknown, t: RespTransform): Promise<TransformResult> {
  if (!t.entry) return { kind: 'text', label: t.label, value: '' }
  const vals = iterEntryValues(json, t.entry.trim())
  const urls = vals.filter((v): v is string => typeof v === 'string' && /^https?:\/\//.test(v))
  if (urls.length === 0) return { kind: 'text', label: t.label, value: '' }
  const items = await Promise.all(
    urls.map((url) =>
      fetchToDataUrl(
        url,
        (_b, blob, u) => t.audioMime || blob.type || videoMimeFromExt(u) || 'video/mp4',
        'video/mp4'
      ).then((r) => ('error' in r ? null : { url, dataUrl: r.dataUrl, mime: r.mime }))
    )
  )
  const ok = items.filter((r): r is { url: string; dataUrl: string; mime: string } => r !== null)
  if (ok.length === 0) return { kind: 'text', label: t.label, value: 'Failed to fetch' }
  if (ok.length === 1) {
    return {
      kind: 'video',
      label: t.label,
      value: ok[0].url,
      videoSrc: ok[0].dataUrl,
      videoType: ok[0].mime
    }
  }
  return {
    kind: 'video',
    label: t.label,
    value: `${ok.length} video items`,
    videoSrc: ok[0].dataUrl,
    videoType: ok[0].mime,
    children: ok.map((r, i) => ({
      kind: 'video' as const,
      label: `${i}`,
      value: r.url,
      videoSrc: r.dataUrl,
      videoType: r.mime
    }))
  }
}

/** Decode a single inline-audio base64/hex value into a data: URL. */
function decodeAudioValue(val: string, t: RespTransform): { dataUrl: string; mime: string } | null {
  if (!val) return null
  if (val.startsWith('data:')) {
    const mime = t.audioMime || val.slice(5, val.indexOf(';'))
    return { dataUrl: val, mime }
  }
  const enc = t.encoding || 'base64'
  let b64: string
  if (enc === 'hex8') {
    try {
      b64 = bytesToBase64(hexToBytes(val))
    } catch {
      b64 = val
    }
  } else {
    b64 = val
  }
  const mime = t.audioMime || detectAudioMime(b64)
  return { dataUrl: `data:${mime};base64,${b64}`, mime }
}

/** Render an inline-audio transform: enumerate every resolved value. */
function handleAudioTransform(json: unknown, t: RespTransform): TransformResult {
  if (!t.entry) return { kind: 'text', label: t.label, value: '' }
  const vals = iterEntryValues(json, t.entry.trim()).filter(
    (v): v is string => typeof v === 'string'
  )
  const decoded = vals
    .map((v) => decodeAudioValue(v, t))
    .filter((r): r is { dataUrl: string; mime: string } => r !== null)
  if (decoded.length === 0) return { kind: 'text', label: t.label, value: '' }
  if (decoded.length === 1) {
    return {
      kind: 'audio',
      label: t.label,
      value: vals[0].slice(0, 40) + '\u2026',
      audioSrc: decoded[0].dataUrl,
      audioType: decoded[0].mime
    }
  }
  return {
    kind: 'audio',
    label: t.label,
    value: `${decoded.length} audio items`,
    audioSrc: decoded[0].dataUrl,
    audioType: decoded[0].mime,
    children: decoded.map((r, i) => ({
      kind: 'audio' as const,
      label: `${i}`,
      value: vals[i]?.slice(0, 40) + '\u2026',
      audioSrc: r.dataUrl,
      audioType: r.mime
    }))
  }
}

/**
 * Build the user-facing `context.transform` API for a script transform. Each
 * `add_*` call appends a section to the results array.
 */
function buildScriptContext(
  label: string,
  local: Record<string, string>
): {
  transform: {
    add_text: (lbl: string, text: string) => void
    add_img: (lbl: string, url: string | string[]) => void
    add_audio: (lbl: string, src: string, type?: string) => void
    add_video: (lbl: string, src: string, type?: string) => void
  }
  local: Record<string, string>
  results: TransformResult[]
} {
  const results: TransformResult[] = []
  return {
    transform: {
      add_text: (lbl, text) => {
        results.push({ kind: 'text', label: lbl ?? label, value: text ?? '' })
      },
      add_img: (lbl, url) => {
        const urls = Array.isArray(url)
          ? url.filter((u): u is string => typeof u === 'string')
          : [url].filter((u): u is string => typeof u === 'string')
        if (urls.length > 0)
          results.push({ kind: 'img', label: lbl ?? label, value: urls[0], images: urls })
      },
      add_audio: (lbl, src, type) => {
        if (typeof src === 'string' && src)
          results.push({
            kind: 'audio',
            label: lbl ?? label,
            value: src,
            audioSrc: src,
            audioType: type || 'audio/mpeg'
          })
      },
      add_video: (lbl, src, type) => {
        if (typeof src === 'string' && src)
          results.push({
            kind: 'video',
            label: lbl ?? label,
            value: src,
            videoSrc: src,
            videoType: type || 'video/mp4'
          })
      }
    },
    local,
    results
  }
}

/** Build the `context.local` object from a transform's localVars pairs. */
function buildLocalMap(t: RespTransform): Record<string, string> {
  const map: Record<string, string> = {}
  for (const v of t.localVars ?? []) {
    if (v.key) map[v.key] = v.value ?? ''
  }
  return map
}

/** Cache of compiled script functions, keyed by source text. Avoids
 * re-compiling (a `new Function` call) on every debounce-triggered re-run
 * while the user is editing other transforms or unrelated state. */
const scriptFnCache = new Map<string, (...args: unknown[]) => void>()

function compileScript(src: string): (...args: unknown[]) => void {
  let fn = scriptFnCache.get(src)
  if (!fn) {
    fn = new Function('object', 'global_vars', 'context', 'console', src) as (
      ...args: unknown[]
    ) => void
    scriptFnCache.set(src, fn)
    // Bound the cache so long editing sessions don't leak unbounded entries.
    if (scriptFnCache.size > 50) {
      const firstKey = scriptFnCache.keys().next().value
      if (firstKey !== undefined) scriptFnCache.delete(firstKey)
    }
  }
  return fn
}

/** Run a user script transform. `object` = parsed JSON, `global_vars` = globals. */
function handleScriptTransform(
  json: unknown,
  t: RespTransform,
  globals: Record<string, string>
): TransformResult[] {
  if (!t.script || !t.script.trim()) return []
  const ctx = buildScriptContext(t.label, buildLocalMap(t))
  try {
    const fn = compileScript(t.script)
    fn(json, globals, ctx, console)
  } catch (err) {
    ctx.results.push({
      kind: 'text',
      label: t.label,
      value: `Script error: ${err instanceof Error ? err.message : String(err)}`
    })
  }
  return ctx.results
}

/**
 * Per-transform result cache. When the user edits one transform (e.g. a
 * script), the others are unchanged — caching by (transform signature, body,
 * globals) lets us reuse their previous results (same object references), so
 * `memo(ResultItem)` skips re-rendering the 200+ items produced by a sibling
 * text transform. Only synchronous kinds are cached; fetch-based ones
 * (audio-url/video-url) are re-fetched to stay fresh.
 */
interface CacheEntry {
  key: string
  results: TransformResult[]
}
const transformCache = new Map<string, CacheEntry>()

/** Build a stable signature for a synchronous transform's inputs. */
function syncTransformKey(t: RespTransform, body: string, globalsSig: string): string | null {
  switch (t.type) {
    case 'text':
      return `text|${body}|${globalsSig}|${t.format}`
    case 'img':
    case 'audio':
      return `${t.type}|${body}|${globalsSig}|${t.entry}|${t.encoding}|${t.audioMime}`
    case 'script':
      // Script only re-executes when scriptVersion bumps (via the Update
      // button). Editing the source text alone must NOT change the cache key,
      // so typing stays smooth; the new script runs only on explicit Update.
      return `script|${body}|${globalsSig}|${t.scriptVersion ?? 0}|${JSON.stringify(t.localVars ?? [])}`
    default:
      return null // async / unknown — not cached
  }
}

/** Apply all response transforms to raw body text. */
export async function applyTransforms(
  rawBody: string,
  transforms: RespTransform[],
  globals: Record<string, string> = {}
): Promise<TransformResult[]> {
  if (!rawBody || transforms.length === 0) return []

  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    return []
  }

  const globalsSig = JSON.stringify(globals)

  const perTransform = await Promise.all(
    transforms.map(async (t): Promise<TransformResult[]> => {
      const sigKey = syncTransformKey(t, rawBody, globalsSig)
      // Reuse cached result for unchanged synchronous transforms.
      if (sigKey !== null) {
        const cached = transformCache.get(t.id)
        if (cached && cached.key === sigKey) return cached.results
      }
      let results: TransformResult[]
      switch (t.type) {
        case 'text':
          results = [handleTextTransform(json, t)]
          break
        case 'img':
          results = [handleImgTransform(json, t)]
          break
        case 'audio-url':
          return [await handleAudioUrlTransform(json, t)]
        case 'video-url':
          return [await handleVideoUrlTransform(json, t)]
        case 'audio':
          results = [handleAudioTransform(json, t)]
          break
        case 'script':
          results = handleScriptTransform(json, t, globals)
          break
        default:
          results = [{ kind: 'text', label: t.label, value: '' }]
      }
      if (sigKey !== null) {
        transformCache.set(t.id, { key: sigKey, results })
      }
      return results
    })
  )
  return perTransform.flat()
}

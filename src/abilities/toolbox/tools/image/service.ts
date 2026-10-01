import { Jimp, cssColorToHex, intToRGBA, rgbaToInt } from 'jimp'
import { imageDimensions } from './dimensions'
type JimpInstance = Omit<
  Awaited<ReturnType<typeof Jimp.read>>,
  'formats' | 'getBuffer' | 'getBase64'
> & {
  getBuffer(mime: 'image/png'): Promise<Buffer>
  getBuffer(mime: 'image/jpeg', options?: { quality: number }): Promise<Buffer>
}
import type { ToolArgs, ToolFile, ToolResult } from '../../types'

/**
 * 图片分组执行器。所有条目都是本地确定性计算：
 * 不联网、不落盘、不读用户目录；输入输出都是 base64 字符串。
 */

/** base64 字符串长度上限（32MB）。 */
const MAX_BASE64_CHARS = 32 * 1024 * 1024
/** 解码后字节数上限（32MB）。 */
const MAX_BYTES = 32 * 1024 * 1024
/** 单边像素上限。 */
const MAX_DIMENSION = 8192
/** 像素总量上限（1600 万）。 */
const MAX_PIXELS = 16 * 1024 * 1024
/** 单次工具调用允许的最大文本长度（词云）。 */
const MAX_TEXT_CHARS = 200000
/** 中日韩表意文字 / 兼容表意 / 全角区。 */
const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/

type OutFormat = 'png' | 'jpeg'

/* ------------------------------------------------------------------ */
/* 基础参数读取                                                        */
/* ------------------------------------------------------------------ */

function fail(error: string): ToolResult {
  return { ok: false, error }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function toNumber(raw: unknown, fallback: number, min: number, max: number): number {
  let value: number
  if (typeof raw === 'number') value = raw
  else if (typeof raw === 'string' && raw.trim() !== '') value = Number(raw)
  else value = fallback
  if (!Number.isFinite(value)) value = fallback
  return clamp(Math.round(value), min, max)
}

function toText(raw: unknown, fallback: string): string {
  return typeof raw === 'string' ? raw : fallback
}

function toBool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw
  if (raw === 'true') return true
  if (raw === 'false') return false
  return fallback
}

function toChoice(raw: unknown, fallback: string, allowed: readonly string[]): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return allowed.includes(value) ? value : fallback
}

/* ------------------------------------------------------------------ */
/* 输入校验                                                            */
/* ------------------------------------------------------------------ */

interface LoadedImage {
  image: JimpInstance
  bytes: number
  sourceName: string
  /** 源图是否 JPEG（决定「保持原格式」时的输出）。 */
  jpeg: boolean
}

/** 去掉空白并校验标准 base64 字符集；不合法时返回空串。 */
function cleanBase64(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const value = raw.replace(/\s+/g, '')
  if (!value || value.length % 4 !== 0) return ''
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return ''
  return value
}

function looksLikeJpeg(buffer: Buffer): boolean {
  return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
}

async function readImage(rawFile: unknown): Promise<LoadedImage> {
  if (!rawFile || typeof rawFile !== 'object') {
    throw new Error('缺少图片附件参数（应为 { name, mime, base64 }）')
  }
  const file = rawFile as Partial<ToolFile>
  const base64 = cleanBase64(file.base64)
  if (!base64) throw new Error('图片附件缺少有效的 base64 数据')
  if (base64.length > MAX_BASE64_CHARS) {
    throw new Error(`图片数据超出限制：base64 上限 ${MAX_BASE64_CHARS / 1024 / 1024}MB`)
  }
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) throw new Error('图片数据为空')
  if (buffer.length > MAX_BYTES) {
    throw new Error(`图片数据超出限制：解码后上限 ${MAX_BYTES / 1024 / 1024}MB`)
  }
  const [inputWidth, inputHeight] = imageDimensions(buffer)
  if (
    inputWidth < 1 ||
    inputHeight < 1 ||
    inputWidth > MAX_DIMENSION ||
    inputHeight > MAX_DIMENSION ||
    inputWidth * inputHeight > MAX_PIXELS
  ) {
    throw new Error('图片尺寸超出限制：单边最多 8192px，总像素最多 1600 万')
  }
  let image: JimpInstance
  try {
    image = await Jimp.read(buffer, {
      'image/jpeg': { maxResolutionInMP: 16, maxMemoryUsageInMB: 128 }
    })
  } catch {
    throw new Error('无法解析图片：仅支持 PNG / JPEG / GIF / BMP，或文件已损坏')
  }
  const width = image.bitmap.width
  const height = image.bitmap.height
  if (width < 1 || height < 1) throw new Error('图片尺寸无效')
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(`图片尺寸超出限制：单边上限 ${MAX_DIMENSION} 像素（当前 ${width}×${height}）`)
  }
  if (width * height > MAX_PIXELS) {
    throw new Error(
      `图片像素总量超出限制：上限 ${MAX_PIXELS / 10000} 万像素（当前 ${Math.round(width * height)}）`
    )
  }
  const mime = typeof file.mime === 'string' ? file.mime.toLowerCase() : ''
  return {
    image,
    bytes: buffer.length,
    sourceName: typeof file.name === 'string' ? file.name : '',
    jpeg: mime === 'image/jpeg' || mime === 'image/jpg' || looksLikeJpeg(buffer)
  }
}

/* ------------------------------------------------------------------ */
/* 输出辅助                                                            */
/* ------------------------------------------------------------------ */

/** 只保留安全字符，剥掉目录与危险符号，避免生成任何磁盘路径。 */
function safeStem(raw: string): string {
  let stem = raw.split(/[\\/]+/).pop() ?? ''
  stem = Array.from(stem)
    .filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127)
    .join('')
  stem = stem.replace(/[<>:"|?*]+/g, '_')
  stem = stem.replace(/\.+$/, '').trim()
  if (stem.length > 48) stem = stem.slice(0, 48)
  return stem
}

function outputFileName(sourceName: string, fallbackStem: string, ext: string): string {
  let stem = safeStem(sourceName).replace(/\.[A-Za-z0-9]{1,10}$/, '')
  if (!stem) stem = fallbackStem
  return `${stem}.${ext}`
}

function toFile(name: string, mime: string, buffer: Buffer): ToolFile {
  return { name, mime, base64: buffer.toString('base64') }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function parseColor(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return clamp(Math.trunc(raw), 0, 0xffffffff)
  }
  if (typeof raw !== 'string') return fallback
  const value = raw.trim().toLowerCase()
  if (!value) return fallback
  const hex = value.startsWith('#') ? value.slice(1) : value
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return rgbaToInt(
      parseInt(`${hex[0]}${hex[0]}`, 16),
      parseInt(`${hex[1]}${hex[1]}`, 16),
      parseInt(`${hex[2]}${hex[2]}`, 16),
      255
    )
  }
  if (/^[0-9a-f]{6}$/.test(hex)) {
    return rgbaToInt(
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
      255
    )
  }
  if (/^[0-9a-f]{8}$/.test(hex)) return Number(`0x${hex}`)
  try {
    const parsed = cssColorToHex(value)
    if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed
  } catch {
    // 无法识别的颜色回落默认值
  }
  return fallback
}

function hexColor(color: number): string {
  const rgba = intToRGBA(color)
  const part = (v: number): string => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')
  return `#${part(rgba.r)}${part(rgba.g)}${part(rgba.b)}`
}

async function encodeImage(
  image: {
    getBuffer(mime: 'image/png'): Promise<Buffer>
    getBuffer(mime: 'image/jpeg', options?: { quality: number }): Promise<Buffer>
  },
  format: OutFormat,
  quality: number
): Promise<{ buffer: Buffer; mime: string; ext: string }> {
  if (format === 'jpeg') {
    const buffer = await image.getBuffer('image/jpeg', { quality })
    return { buffer, mime: 'image/jpeg', ext: 'jpg' }
  }
  const buffer = await image.getBuffer('image/png')
  return { buffer, mime: 'image/png', ext: 'png' }
}

/** auto = 跟随源格式（JPEG 用 JPEG，其余用 PNG）；也可显式指定。 */
function resolveFormat(raw: unknown, jpegSource: boolean): OutFormat {
  const choice = toChoice(raw, 'auto', ['auto', 'png', 'jpeg'])
  if (choice === 'png' || choice === 'jpeg') return choice
  return jpegSource ? 'jpeg' : 'png'
}

/** 转义 XML 文本/属性，并剔除 XML 1.0 不允许的字符。 */
function escapeXml(value: string): string {
  let out = ''
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '&') out += '&amp;'
    else if (ch === '<') out += '&lt;'
    else if (ch === '>') out += '&gt;'
    else if (ch === '"') out += '&quot;'
    else if (ch === "'") out += '&apos;'
    else if (code < 0x20 && ch !== '\t' && ch !== '\n' && ch !== '\r') continue
    else if (code === 0xfffe || code === 0xffff || (code >= 0xd800 && code <= 0xdfff)) continue
    else out += ch
  }
  return out
}

function splitChars(value: string): string[] {
  return Array.from(value)
}

/** 粗估文字宽度（仅用于水印 / 词云定位，不依赖字体文件）。 */
function estimateTextWidth(chars: string[], fontSize: number): number {
  let width = 0
  for (const ch of chars) {
    const code = ch.codePointAt(0) ?? 0
    if (CJK_RE.test(ch) || code === 0x3000) width += fontSize
    else if (ch === ' ') width += fontSize * 0.3
    else width += fontSize * 0.56
  }
  return width
}

/* ------------------------------------------------------------------ */
/* 1. 图片压缩                                                         */
/* ------------------------------------------------------------------ */

async function toolCompress(args: ToolArgs): Promise<ToolResult> {
  const source = await readImage(args['image'])
  const maxWidth = toNumber(args['maxWidth'], 1920, 16, MAX_DIMENSION)
  const maxHeight = toNumber(args['maxHeight'], 1920, 16, MAX_DIMENSION)
  const quality = toNumber(args['quality'], 80, 10, 100)
  const format = resolveFormat(args['format'], source.jpeg)

  const notes: string[] = []
  const out = source.image
  if (out.bitmap.width > maxWidth || out.bitmap.height > maxHeight) {
    out.scaleToFit({ w: maxWidth, h: maxHeight })
  } else {
    notes.push('图片未超过设定尺寸，仅做了重新编码')
  }
  if (format === 'jpeg') {
    const fill = parseColor(args['flatten'], 0xffffffff)
    const flat = new Jimp({ width: out.bitmap.width, height: out.bitmap.height, color: fill })
    flat.composite(out, 0, 0)
    out.bitmap.data = flat.bitmap.data
    notes.push('JPEG 不支持透明，透明区域已填充为指定底色')
  }
  const encoded = await encodeImage(out, format, quality)
  const width = out.bitmap.width
  const height = out.bitmap.height
  const delta =
    source.bytes > 0 ? Math.round((1 - encoded.buffer.length / source.bytes) * 1000) / 10 : 0
  if (encoded.buffer.length >= source.bytes) {
    notes.push('输出没有变小：原图已高度压缩，或当前格式不适合该内容')
  }
  return {
    ok: true,
    files: [
      toFile(outputFileName(source.sourceName, 'image', encoded.ext), encoded.mime, encoded.buffer)
    ],
    text: `压缩完成：${formatBytes(source.bytes)} → ${formatBytes(encoded.buffer.length)}（${
      delta >= 0 ? '减少' : '增加'
    } ${Math.abs(delta)}%），输出 ${width}×${height}`,
    data: {
      beforeBytes: source.bytes,
      afterBytes: encoded.buffer.length,
      width,
      height,
      mime: encoded.mime,
      quality
    },
    note: notes.length > 0 ? notes.join('；') : undefined
  }
}

/* ------------------------------------------------------------------ */
/* 2. 裁剪 / 旋转                                                      */
/* ------------------------------------------------------------------ */

async function toolCrop(args: ToolArgs): Promise<ToolResult> {
  const source = await readImage(args['image'])
  const imageWidth = source.image.bitmap.width
  const imageHeight = source.image.bitmap.height
  const x = toNumber(args['x'], 0, 0, MAX_DIMENSION)
  const y = toNumber(args['y'], 0, 0, MAX_DIMENSION)
  const w = toNumber(args['w'], 1, 1, MAX_DIMENSION)
  const h = toNumber(args['h'], 1, 1, MAX_DIMENSION)
  const degrees = toNumber(args['rotate'], 0, 0, 360) % 360
  const format = resolveFormat(args['format'], source.jpeg)

  if (x + w > imageWidth || y + h > imageHeight) {
    return fail(
      `裁剪区域超出图片范围（图片 ${imageWidth}×${imageHeight}，请求 x=${x} y=${y} w=${w} h=${h}）`
    )
  }
  let out = source.image.crop({ x, y, w, h })
  if (degrees !== 0) out = out.rotate(degrees)
  const encoded = await encodeImage(out, format, toNumber(args['quality'], 90, 10, 100))
  return {
    ok: true,
    files: [
      toFile(outputFileName(source.sourceName, 'image', encoded.ext), encoded.mime, encoded.buffer)
    ],
    text: `裁剪完成：裁剪区 ${w}×${h}，旋转 ${degrees}° 后输出 ${out.bitmap.width}×${out.bitmap.height}`,
    data: {
      width: out.bitmap.width,
      height: out.bitmap.height,
      rotate: degrees,
      mime: encoded.mime
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. 滤镜                                                             */
/* ------------------------------------------------------------------ */

async function toolFilter(args: ToolArgs): Promise<ToolResult> {
  const source = await readImage(args['image'])
  const filter = toChoice(args['filter'], 'greyscale', [
    'greyscale',
    'invert',
    'brightness',
    'contrast',
    'pixelate',
    'comic'
  ])
  const strength = toNumber(args['strength'], 20, -100, 100)
  const blockSize = toNumber(args['blockSize'], 8, 2, 48)
  const format = resolveFormat(args['format'], source.jpeg)

  const image = source.image
  switch (filter) {
    case 'greyscale':
      image.greyscale()
      break
    case 'invert':
      image.invert()
      break
    case 'brightness':
      // Jimp 的 brightness 是通道乘法（0~2），这里用 -100~100 的强度映射
      image.brightness(clamp(1 + strength / 100, 0, 2))
      break
    case 'contrast':
      image.contrast(clamp(strength / 100, -1, 1))
      break
    case 'pixelate':
      image.pixelate(blockSize)
      break
    default:
      // 漫画风 = 色阶压缩 + 对比度 + 饱和度，纯本地滤镜
      image.posterize(6)
      image.contrast(0.35)
      image.color([{ apply: 'saturate', params: [30] }])
      break
  }
  const encoded = await encodeImage(image, format, toNumber(args['quality'], 90, 10, 100))
  return {
    ok: true,
    files: [
      toFile(outputFileName(source.sourceName, 'image', encoded.ext), encoded.mime, encoded.buffer)
    ],
    text: `滤镜「${filter}」已应用，输出 ${image.bitmap.width}×${image.bitmap.height}`,
    data: {
      filter,
      width: image.bitmap.width,
      height: image.bitmap.height,
      mime: encoded.mime
    },
    note:
      filter === 'comic'
        ? '漫画风是色阶压缩 + 对比度 + 饱和度增强的组合滤镜，效果确定可复现，不是 AI 生成'
        : undefined
  }
}

/* ------------------------------------------------------------------ */
/* 4. 纯色去底 / 替换底色                                              */
/* ------------------------------------------------------------------ */

/** 取边缘像素的主色作为背景色。 */
function detectBackgroundColor(image: JimpInstance): number {
  const { width, height, data } = image.bitmap
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
  const consider = (x: number, y: number): void => {
    const idx = (y * width + x) * 4
    const r = data[idx]
    const g = data[idx + 1]
    const b = data[idx + 2]
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const entry = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
    entry.n += 1
    entry.r += r
    entry.g += g
    entry.b += b
    buckets.set(key, entry)
  }
  for (let x = 0; x < width; x++) {
    consider(x, 0)
    consider(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    consider(0, y)
    consider(width - 1, y)
  }
  let best = { n: 0, r: 255, g: 255, b: 255 }
  for (const entry of buckets.values()) {
    if (entry.n > best.n) best = entry
  }
  const n = Math.max(1, best.n)
  return rgbaToInt(Math.round(best.r / n), Math.round(best.g / n), Math.round(best.b / n), 255)
}

async function toolBackground(args: ToolArgs): Promise<ToolResult> {
  const source = await readImage(args['image'])
  const mode = toChoice(args['mode'], 'transparent', ['transparent', 'replace'])
  const tolerance = toNumber(args['tolerance'], 12, 0, 100)
  const rawBg = toText(args['bgColor'], '').trim()
  const seedColor = rawBg ? parseColor(rawBg, 0xffffffff) : detectBackgroundColor(source.image)
  const target = intToRGBA(parseColor(args['newColor'], 0xff0000ff))

  const { width, height, data } = source.image.bitmap
  const seed = intToRGBA(seedColor)
  const threshold = (tolerance / 100) * Math.sqrt(3 * 255 * 255)
  const visited = new Uint8Array(width * height)
  const queue: number[] = []

  const push = (x: number, y: number): void => {
    const i = y * width + x
    if (visited[i]) return
    const idx = i * 4
    const dr = data[idx] - seed.r
    const dg = data[idx + 1] - seed.g
    const db = data[idx + 2] - seed.b
    if (Math.sqrt(dr * dr + dg * dg + db * db) > threshold) return
    visited[i] = 1
    queue.push(i)
  }

  // 只从四边种子做连通填充，图片内部同色但被其他颜色隔开的区域不受影响
  for (let x = 0; x < width; x++) {
    push(x, 0)
    push(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    push(0, y)
    push(width - 1, y)
  }
  let head = 0
  while (head < queue.length) {
    const i = queue[head]
    head += 1
    const x = i % width
    const y = (i - x) / width
    if (x > 0) push(x - 1, y)
    if (x < width - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < height - 1) push(x, y + 1)
  }

  let changed = 0
  for (let i = 0; i < visited.length; i++) {
    if (!visited[i]) continue
    changed += 1
    const idx = i * 4
    if (mode === 'transparent') {
      data[idx + 3] = 0
    } else {
      data[idx] = target.r
      data[idx + 1] = target.g
      data[idx + 2] = target.b
    }
  }

  const notes = [
    '只对接近纯色的背景有效：渐变、阴影、半透明混合或复杂背景无法处理，也不是 AI 人像抠图'
  ]
  if (changed === 0) {
    notes.push('未找到与指定底色接近的边缘像素，可尝试加大容差或指定更准确的背景色')
  }
  const format: OutFormat =
    mode === 'transparent' ? 'png' : resolveFormat(args['format'], source.jpeg)
  const encoded = await encodeImage(source.image, format, toNumber(args['quality'], 90, 10, 100))
  return {
    ok: true,
    files: [
      toFile(outputFileName(source.sourceName, 'image', encoded.ext), encoded.mime, encoded.buffer)
    ],
    text: `${mode === 'transparent' ? '去底' : '替换底色'}完成：处理 ${changed} 个像素（共 ${width * height}）`,
    data: {
      mode,
      changed,
      threshold: Math.round(threshold),
      seedColor: hexColor(seedColor),
      mime: encoded.mime
    },
    note: notes.join('；')
  }
}

/* ------------------------------------------------------------------ */
/* 5. Base64 / dataURL                                                 */
/* ------------------------------------------------------------------ */

const DATA_URL_RE = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i
const DECODE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/bmp',
  'image/x-ms-bmp',
  'image/tiff',
  'image/x-icon',
  'image/vnd.microsoft.icon'
])

/** 从 ICO 容器中取出最大的内嵌 PNG 条目。 */
function extractIcoPng(buffer: Buffer): Buffer {
  const failIco = (): never => {
    throw new Error('ICO 解析失败：仅支持内嵌 PNG 条目的 ICO 文件（BMP 条目暂不支持）')
  }
  if (buffer.length < 6) failIco()
  const reserved = buffer.readUInt16LE(0)
  const type = buffer.readUInt16LE(2)
  const count = buffer.readUInt16LE(4)
  if (reserved !== 0 || type !== 1 || count === 0 || 6 + 16 * count > buffer.length) failIco()
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  let best: Buffer | null = null
  for (let i = 0; i < count; i++) {
    const entry = 6 + 16 * i
    const bytesInRes = buffer.readUInt32LE(entry + 8)
    const imageOffset = buffer.readUInt32LE(entry + 12)
    if (imageOffset + bytesInRes > buffer.length) continue
    const payload = buffer.subarray(imageOffset, imageOffset + bytesInRes)
    if (payload.length < 8 || !payload.subarray(0, 4).equals(pngMagic)) continue
    if (!best || payload.length > best.length) best = payload
  }
  if (!best) return failIco()
  return best
}

async function toolBase64(args: ToolArgs): Promise<ToolResult> {
  const mode = toChoice(args['mode'], 'encode', ['encode', 'decode'])
  const quality = toNumber(args['quality'], 90, 10, 100)

  if (mode === 'encode') {
    const source = await readImage(args['image'])
    const format = resolveFormat(args['format'], source.jpeg)
    const encoded = await encodeImage(source.image, format, quality)
    return {
      ok: true,
      text: `data:${encoded.mime};base64,${encoded.buffer.toString('base64')}`,
      data: {
        mode,
        mime: encoded.mime,
        bytes: encoded.buffer.length,
        width: source.image.bitmap.width,
        height: source.image.bitmap.height
      }
    }
  }

  const raw = toText(args['dataUrl'], '').trim()
  const match = raw.match(DATA_URL_RE)
  if (!match) {
    return fail('dataURL 格式无效：应为 data:<mime>;base64,<数据>，且只能包含 base64 字符')
  }
  const mime = match[1].toLowerCase()
  if (!DECODE_MIMES.has(mime)) {
    return fail('不支持的图片类型（支持 PNG / JPEG / GIF / BMP / ICO）')
  }
  const base64 = cleanBase64(match[2])
  if (!base64) return fail('dataURL 的 base64 数据无效')
  if (base64.length > MAX_BASE64_CHARS) {
    return fail(`dataURL 超出限制：base64 上限 ${MAX_BASE64_CHARS / 1024 / 1024}MB`)
  }
  let buffer: Buffer = Buffer.from(base64, 'base64')
  let fromIco = false
  if (mime === 'image/x-icon' || mime === 'image/vnd.microsoft.icon') {
    buffer = extractIcoPng(buffer)
    fromIco = true
  }
  let payload: JimpInstance
  try {
    const [w, h] = imageDimensions(buffer)
    if (w < 1 || h < 1 || w > MAX_DIMENSION || h > MAX_DIMENSION || w * h > MAX_PIXELS)
      return fail('解码前图片尺寸超出限制')
    payload = await Jimp.read(buffer, {
      'image/jpeg': { maxResolutionInMP: 16, maxMemoryUsageInMB: 128 }
    })
  } catch {
    return fail('dataURL 解码失败：内容不是可识别的位图数据')
  }
  const width = payload.bitmap.width
  const height = payload.bitmap.height
  if (width < 1 || height < 1) return fail('解码后的图片尺寸无效')
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    return fail(`解码后的图片尺寸超出限制：单边上限 ${MAX_DIMENSION} 像素`)
  }
  if (width * height > MAX_PIXELS) {
    return fail(`解码后的图片像素总量超出限制：上限 ${MAX_PIXELS / 10000} 万像素`)
  }
  const format: OutFormat = mime === 'image/jpeg' || mime === 'image/jpg' ? 'jpeg' : 'png'
  const encoded = await encodeImage(payload, format, quality)
  return {
    ok: true,
    files: [toFile('decoded', encoded.mime, encoded.buffer)],
    text: `解码完成：${encoded.buffer.length} 字节，尺寸 ${width}×${height}`,
    data: { mode, mime: encoded.mime, bytes: encoded.buffer.length, width, height },
    note: fromIco ? '已从 ICO 中取出内嵌的 PNG 条目并还原为位图' : undefined
  }
}

/* ------------------------------------------------------------------ */
/* 6. ICO 图标                                                         */
/* ------------------------------------------------------------------ */

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

function parseIcoSizes(raw: string): number[] {
  const parts = raw
    .split(/[,，\s]+/)
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n))
  const sizes: number[] = []
  for (const part of parts) {
    const value = Math.round(part)
    if (!ICO_SIZES.includes(value)) {
      throw new Error(`不支持的图标尺寸 ${part}（可用：${ICO_SIZES.join('、')}）`)
    }
    if (!sizes.includes(value)) sizes.push(value)
  }
  if (sizes.length === 0) throw new Error('请至少指定一个尺寸（例如 16,32,48）')
  if (sizes.length > 6) throw new Error('单个 ICO 最多包含 6 个尺寸')
  return sizes.sort((a, b) => a - b)
}

async function toolIco(args: ToolArgs): Promise<ToolResult> {
  const source = await readImage(args['image'])
  const sizes = parseIcoSizes(toText(args['sizes'], '16,32,48'))

  const entries: Buffer[] = []
  for (const size of sizes) {
    const tile = source.image.clone().cover({ w: size, h: size })
    entries.push(await tile.getBuffer('image/png'))
  }

  // 标准 ICO 布局：目录（6 + 16*n 字节）在前，所有位图数据紧跟其后
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = 1 (icon)
  header.writeUInt16LE(sizes.length, 4)
  const dirEntries: Buffer[] = []
  const dataParts: Buffer[] = []
  let offset = 6 + 16 * sizes.length
  for (let i = 0; i < sizes.length; i++) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], 0) // width（0 表示 256）
    entry.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], 1) // height
    entry.writeUInt8(0, 2) // palette colors
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // color planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(entries[i].length, 8) // bytes in resource
    entry.writeUInt32LE(offset, 12) // image offset
    offset += entries[i].length
    dirEntries.push(entry)
    dataParts.push(entries[i])
  }
  const ico = Buffer.concat([header, ...dirEntries, ...dataParts])
  return {
    ok: true,
    files: [toFile(outputFileName(source.sourceName, 'icon', 'ico'), 'image/x-icon', ico)],
    text: `ICO 生成完成：${sizes.length} 个尺寸（${sizes.join('、')}），共 ${formatBytes(ico.length)}`,
    data: { sizes, bytes: ico.length },
    note: '每个条目都是标准 PNG（Vista 及以后的 Windows 与现代浏览器均支持）；ICO 不支持动画与多状态'
  }
}

/* ------------------------------------------------------------------ */
/* 7. 切图                                                             */
/* ------------------------------------------------------------------ */

/** 把 total 尽量平均切成 parts 份，余数分给前几份。 */
function splitEdges(total: number, parts: number): number[] {
  const base = Math.floor(total / parts)
  const remainder = total % parts
  const edges: number[] = []
  let cursor = 0
  for (let i = 0; i < parts; i++) {
    cursor += base + (i < remainder ? 1 : 0)
    edges.push(cursor)
  }
  return edges
}

async function toolGrid(args: ToolArgs): Promise<ToolResult> {
  const source = await readImage(args['image'])
  const grid = toChoice(args['grid'], '3x3', ['2x2', '3x3', '2x3', '3x2'])
  const format = toChoice(args['format'], 'png', ['png', 'jpeg']) === 'jpeg' ? 'jpeg' : 'png'
  const cols = Number(grid.split('x')[0])
  const rows = Number(grid.split('x')[1])
  const width = source.image.bitmap.width
  const height = source.image.bitmap.height
  if (width < cols || height < rows) {
    return fail(
      `图片太小：至少需要 ${cols}×${rows} 像素才能切成 ${cols}×${rows}（当前 ${width}×${height}）`
    )
  }

  const colEdges = splitEdges(width, cols)
  const rowEdges = splitEdges(height, rows)
  const stem = safeStem(source.sourceName).replace(/\.[A-Za-z0-9]{1,10}$/, '') || 'image'
  const files: ToolFile[] = []
  const tiles: { row: number; col: number; width: number; height: number; bytes: number }[] = []
  for (let r = 0; r < rows; r++) {
    const y = r === 0 ? 0 : rowEdges[r - 1]
    const h = rowEdges[r] - y
    for (let c = 0; c < cols; c++) {
      const x = c === 0 ? 0 : colEdges[c - 1]
      const w = colEdges[c] - x
      const tile = source.image.clone().crop({ x, y, w, h })
      const encoded = await encodeImage(tile, format, toNumber(args['quality'], 90, 10, 100))
      tiles.push({ row: r + 1, col: c + 1, width: w, height: h, bytes: encoded.buffer.length })
      files.push(toFile(`${stem}-${r + 1}-${c + 1}.${encoded.ext}`, encoded.mime, encoded.buffer))
    }
  }
  return {
    ok: true,
    files,
    text: `切图完成：${cols}×${rows} 共 ${files.length} 张，原图 ${width}×${height}`,
    data: { columns: cols, rows, tiles }
  }
}

/* ------------------------------------------------------------------ */
/* 8. 字符画                                                           */
/* ------------------------------------------------------------------ */

const ASCII_CHARSETS: Record<string, string> = {
  standard: ' .:-=+*#%@',
  blocks: ' ░▒▓█',
  simple: ' .oO@'
}

async function toolAscii(args: ToolArgs): Promise<ToolResult> {
  const source = await readImage(args['image'])
  const columns = toNumber(args['columns'], 80, 8, 240)
  const charsetKey = toChoice(args['charset'], 'standard', ['standard', 'blocks', 'simple'])
  const chars = ASCII_CHARSETS[charsetKey]
  const invert = toBool(args['invert'], false)
  const width = source.image.bitmap.width
  const height = source.image.bitmap.height
  // 等宽字符高宽比约 2:1，行数按 0.5 折算
  const rows = clamp(Math.round((height / width) * columns * 0.5), 1, 400)

  const small = source.image.clone().resize({ w: columns, h: rows })
  const data = small.bitmap.data
  const lines: string[] = []
  for (let y = 0; y < rows; y++) {
    let line = ''
    for (let x = 0; x < columns; x++) {
      const idx = (y * columns + x) * 4
      if (data[idx + 3] < 128) {
        line += ' '
        continue
      }
      const lum = (0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]) / 255
      const t = invert ? 1 - lum : lum
      line += chars[clamp(Math.round(t * (chars.length - 1)), 0, chars.length - 1)]
    }
    lines.push(line)
  }
  return {
    ok: true,
    text: lines.join('\n'),
    data: { columns, rows, charset: charsetKey }
  }
}

/* ------------------------------------------------------------------ */
/* 9. 文字水印（SVG 输出）                                             */
/* ------------------------------------------------------------------ */

const WATERMARK_ANCHOR: Record<string, string> = {
  tl: 'start',
  tc: 'middle',
  tr: 'end',
  ml: 'start',
  mc: 'middle',
  mr: 'end',
  bl: 'start',
  bc: 'middle',
  br: 'end'
}

async function toolWatermark(args: ToolArgs): Promise<ToolResult> {
  const source = await readImage(args['image'])
  const rawText = toText(args['text'], '')
  if (!rawText.trim()) return fail('水印文字不能为空')
  const fontSize = toNumber(args['fontSize'], 32, 8, 200)
  const fontFamily = escapeXml(toText(args['fontFamily'], 'sans-serif').trim() || 'sans-serif')
  const color = hexColor(parseColor(args['color'], 0xffffffff))
  const opacity = toNumber(args['opacity'], 45, 0, 100)
  const position = toChoice(args['position'], 'br', [
    'tl',
    'tc',
    'tr',
    'ml',
    'mc',
    'mr',
    'bl',
    'bc',
    'br',
    'tile'
  ])
  const margin = toNumber(args['margin'], 16, 0, 400)
  const rotation = toNumber(args['rotation'], 0, -45, 45)

  const lines = rawText.split(/\r?\n/)
  if (lines.length > 20) return fail('水印文字最多 20 行')
  const width = source.image.bitmap.width
  const height = source.image.bitmap.height
  const lineHeight = fontSize * 1.25
  const anchor = position === 'tile' ? 'start' : WATERMARK_ANCHOR[position]

  interface Mark {
    x: number
    y: number
    text: string
  }
  const marks: Mark[] = []

  if (position === 'tile') {
    const stepX =
      Math.max(...lines.map((line) => estimateTextWidth(splitChars(line), fontSize)), 1) +
      margin * 2
    for (let i = 0; i < lines.length; i++) {
      const baseY = margin + fontSize + i * (lineHeight + margin)
      if (baseY > height) break
      for (let x = margin; x < width + stepX * 0.5; x += stepX) {
        marks.push({ x, y: baseY, text: lines[i] })
      }
    }
    if (marks.length > 4000) return fail('平铺水印数量过多：请增大字号或边距')
  } else {
    const left = position.endsWith('l')
    const middle = position === 'mc' || position === 'tc' || position === 'bc'
    const baseX = left ? margin : middle ? width / 2 : width - margin
    const top = position.startsWith('t')
    const middleY = position === 'ml' || position === 'mc' || position === 'mr'
    const firstY = top
      ? margin + fontSize
      : middleY
        ? height / 2 - ((lines.length - 1) * lineHeight) / 2
        : height - margin - (lines.length - 1) * lineHeight
    for (let i = 0; i < lines.length; i++) {
      marks.push({ x: baseX, y: firstY + i * lineHeight, text: lines[i] })
    }
  }

  const embedded = (await source.image.getBuffer('image/png')).toString('base64')
  const dataUri = `data:image/png;base64,${embedded}`
  const body = marks
    .map((mark) => {
      const transform =
        rotation === 0
          ? ''
          : ` transform="rotate(${rotation} ${mark.x.toFixed(1)} ${(mark.y - fontSize * 0.35).toFixed(1)})"`
      return `<text x="${mark.x.toFixed(1)}" y="${mark.y.toFixed(1)}" text-anchor="${anchor}"${transform}>${escapeXml(mark.text)}</text>`
    })
    .join('')

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<image x="0" y="0" width="${width}" height="${height}" href="${dataUri}" xlink:href="${dataUri}"/>`,
    `<g fill="${color}" fill-opacity="${(opacity / 100).toFixed(3)}" font-family="${fontFamily}" font-size="${fontSize}">${body}</g>`,
    '</svg>'
  ].join('')

  return {
    ok: true,
    files: [
      toFile(
        outputFileName(source.sourceName, 'watermark', 'svg'),
        'image/svg+xml',
        Buffer.from(svg, 'utf8')
      )
    ],
    text: `水印已生成：SVG ${width}×${height}，位置 ${position}，${marks.length} 处文字，不透明度 ${opacity}%`,
    data: { format: 'svg', width, height, count: marks.length, opacity, position },
    note: '结果为 SVG：已内嵌原图 base64 并转义文字，未引用任何外部资源；中文显示依赖查看环境的本地字体'
  }
}

/* ------------------------------------------------------------------ */
/* 10. 词云                                                            */
/* ------------------------------------------------------------------ */

const CLOUD_WIDTH = 1024
const CLOUD_HEIGHT = 640

const ZH_STOPWORDS = new Set(
  '的 了 是 在 我 你 他 她 它 们 和 与 也 就 不 很 都 要 把 被 让 从 到 给 于 之 着 过 吗 呢 吧 啊 呀 嗯 这 那 些 个 上 下 中 后 前 里 外 又 再 还 但 而 或 如 若 因 为 所 以 其 此 怎 么 谁 哪 一 二 三 四 五 六 七 八 九 十 已 会 能 可 以 说 有 没 无 对 一 个 一 些 这 个 那 个 我 们 你 们 他 们 它 们 自 己'.split(
    /\s+/
  )
)

const EN_STOPWORDS = new Set(
  'the a an and or but if then else of to in on at by for with from as is are was were be been being it its this that these those i you he she they we me him her them my your his their our not no yes do does did done can could should would will shall may might must have has had having so such than too very just about into over under again further once here there when where why how all any both each few more most other some only own same s t don now'.split(
    /\s+/
  )
)

interface WordCount {
  word: string
  count: number
  first: number
}

interface WordSegment {
  segment: string
  isWordLike?: boolean
}

interface SegmenterLike {
  segment(input: string): Iterable<WordSegment>
}

function createSegmenter(locale: string): SegmenterLike | null {
  const ctor = (
    Intl as unknown as {
      Segmenter?: new (loc: string, opts: { granularity: 'word' }) => SegmenterLike
    }
  ).Segmenter
  if (!ctor) return null
  try {
    return new ctor(locale, { granularity: 'word' })
  } catch {
    return null
  }
}

/** 没有 Intl.Segmenter 时的保底分词：拉丁连续串 + 中日韩单字。 */
function fallbackSegment(text: string): WordSegment[] {
  const out: WordSegment[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer) out.push({ segment: buffer, isWordLike: true })
    buffer = ''
  }
  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      flush()
      out.push({ segment: ch, isWordLike: true })
    } else if (/[A-Za-z0-9'’-]/.test(ch)) {
      buffer += ch
    } else {
      flush()
    }
  }
  flush()
  return out
}

function countWords(text: string): WordCount[] {
  const hasCjk = /[\u2e80-\u9fff\uf900-\ufaff]/.test(text)
  const segmenter = createSegmenter(hasCjk ? 'zh' : 'en')
  const segments = segmenter ? Array.from(segmenter.segment(text)) : fallbackSegment(text)
  const counts = new Map<string, WordCount>()
  let order = 0
  for (const item of segments) {
    if (item.isWordLike === false) continue
    const raw = item.segment
    if (!raw) continue
    const isCjk = CJK_RE.test(raw)
    const word = isCjk ? raw : raw.toLowerCase()
    if (!isCjk && word.length < 2) continue
    if (ZH_STOPWORDS.has(word) || (!isCjk && EN_STOPWORDS.has(word))) continue
    const entry = counts.get(word)
    if (entry) entry.count += 1
    else counts.set(word, { word, count: 1, first: order })
    order += 1
  }
  return Array.from(counts.values()).sort((a, b) => b.count - a.count || a.first - b.first)
}

function charAdvance(ch: string, fontSize: number): number {
  return CJK_RE.test(ch) ? fontSize : fontSize * 0.56
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const rgb: number[] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x]
  const m = l - c / 2
  const part = (v: number): string =>
    clamp(Math.round((v + m) * 255), 0, 255)
      .toString(16)
      .padStart(2, '0')
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`
}

async function toolWordCloud(args: ToolArgs): Promise<ToolResult> {
  const text = toText(args['text'], '')
  if (!text.trim()) return fail('文本不能为空')
  if (text.length > MAX_TEXT_CHARS) return fail(`文本过长：上限 ${MAX_TEXT_CHARS} 字符`)
  const maxWords = toNumber(args['maxWords'], 80, 10, 300)
  const fontMin = toNumber(args['fontSizeMin'], 12, 8, 32)
  const fontMax = toNumber(args['fontSizeMax'], 56, 28, 120)
  const colorMode = toChoice(args['colorMode'], 'mono', ['mono', 'colorful'])
  const ink = hexColor(parseColor(args['inkColor'], 0x334155ff))

  const ranked = countWords(text).slice(0, maxWords)
  if (ranked.length === 0) return fail('没有统计到有效词语（可能全是停用词）')
  const maxCount = ranked[0].count
  const minCount = ranked[ranked.length - 1].count

  interface Box {
    x: number
    y: number
    w: number
    h: number
  }
  const boxes: Box[] = []
  const elements: string[] = []
  const placedWords: { word: string; count: number; fontSize: number }[] = []
  let skipped = 0

  const centerX = CLOUD_WIDTH / 2
  const centerY = CLOUD_HEIGHT / 2

  for (let i = 0; i < ranked.length; i++) {
    const item = ranked[i]
    const fontSize =
      maxCount === minCount
        ? fontMax
        : Math.round(
            fontMin + ((item.count - minCount) / (maxCount - minCount)) * (fontMax - fontMin)
          )
    const boxWidth = splitChars(item.word).reduce((sum, ch) => sum + charAdvance(ch, fontSize), 0)
    const boxHeight = fontSize * 1.15
    if (boxWidth + 8 >= CLOUD_WIDTH || boxHeight + 8 >= CLOUD_HEIGHT) {
      skipped += 1
      continue
    }
    let found: Box | null = null
    // 确定性螺旋：固定步长、固定尝试次数，不用随机数
    for (let attempt = 0; attempt < 1600; attempt++) {
      const theta = attempt * 0.22
      const radius = theta * 5.2
      const x = clamp(
        centerX + radius * Math.cos(theta) - boxWidth / 2,
        2,
        CLOUD_WIDTH - boxWidth - 2
      )
      const y = clamp(
        centerY + radius * Math.sin(theta) - boxHeight / 2,
        2,
        CLOUD_HEIGHT - boxHeight - 2
      )
      const candidate: Box = { x, y, w: boxWidth, h: boxHeight }
      const overlap = boxes.some(
        (b) =>
          candidate.x < b.x + b.w &&
          candidate.x + candidate.w > b.x &&
          candidate.y < b.y + b.h &&
          candidate.y + candidate.h > b.y
      )
      if (!overlap) {
        found = candidate
        break
      }
    }
    if (!found) {
      skipped += 1
      continue
    }
    boxes.push(found)
    const fill = colorMode === 'colorful' ? hslToHex((i * 37) % 360, 0.62, 0.45) : ink
    elements.push(
      `<text x="${(found.x + found.w / 2).toFixed(1)}" y="${(found.y + fontSize * 0.92).toFixed(1)}" font-family="sans-serif" font-size="${fontSize}" fill="${fill}" text-anchor="middle">${escapeXml(item.word)}</text>`
    )
    placedWords.push({ word: item.word, count: item.count, fontSize })
  }

  if (placedWords.length === 0) return fail('没有任何词语可以放入画布（可减小字号或词数）')

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CLOUD_WIDTH}" height="${CLOUD_HEIGHT}" viewBox="0 0 ${CLOUD_WIDTH} ${CLOUD_HEIGHT}">`,
    `<rect width="${CLOUD_WIDTH}" height="${CLOUD_HEIGHT}" fill="#ffffff"/>`,
    elements.join(''),
    '</svg>'
  ].join('')

  const top = placedWords
    .slice(0, 15)
    .map((w) => `${w.word}×${w.count}`)
    .join('、')
  return {
    ok: true,
    files: [toFile('word-cloud.svg', 'image/svg+xml', Buffer.from(svg, 'utf8'))],
    text: `词云生成：放置 ${placedWords.length} 个词，跳过 ${skipped} 个（画布 ${CLOUD_WIDTH}×${CLOUD_HEIGHT}）\n高频词：${top}`,
    data: {
      placed: placedWords.length,
      skipped,
      width: CLOUD_WIDTH,
      height: CLOUD_HEIGHT,
      words: placedWords
    },
    note: '中文按单字统计（未做分词），同义词不去重；排布为确定性螺旋，放不下的词会跳过'
  }
}

/* ------------------------------------------------------------------ */
/* 11. 图片叠加                                                        */
/* ------------------------------------------------------------------ */

async function toolMontage(args: ToolArgs): Promise<ToolResult> {
  const base = await readImage(args['base'])
  const overlay = await readImage(args['overlay'])
  const mode = toChoice(args['mode'], 'overlay', ['overlay', 'blend', 'badge'])
  const opacity = toNumber(args['opacity'], 100, 0, 100)
  const scale = toNumber(args['scale'], 25, 1, 100)
  const corner = toChoice(args['corner'], 'br', ['tl', 'tr', 'bl', 'br'])

  const baseWidth = base.image.bitmap.width
  const baseHeight = base.image.bitmap.height
  const over = overlay.image
  let x = toNumber(args['x'], 0, -MAX_DIMENSION, MAX_DIMENSION)
  let y = toNumber(args['y'], 0, -MAX_DIMENSION, MAX_DIMENSION)

  if (mode === 'blend') {
    over.cover({ w: baseWidth, h: baseHeight })
  } else if (mode === 'badge') {
    const targetWidth = clamp(Math.round((baseWidth * scale) / 100), 8, baseWidth)
    const targetHeight = clamp(
      Math.round((over.bitmap.height * targetWidth) / Math.max(1, over.bitmap.width)),
      8,
      baseHeight
    )
    over.scaleToFit({ w: targetWidth, h: targetHeight })
    const gap = Math.max(4, Math.round(baseWidth * 0.02))
    const left = corner === 'tl' || corner === 'bl'
    const top = corner === 'tl' || corner === 'tr'
    x = left ? gap : baseWidth - over.bitmap.width - gap
    y = top ? gap : baseHeight - over.bitmap.height - gap
  }

  if (
    x >= baseWidth ||
    y >= baseHeight ||
    x + over.bitmap.width <= 0 ||
    y + over.bitmap.height <= 0
  ) {
    return fail(
      `叠加图被完全放置到底图之外（底图 ${baseWidth}×${baseHeight}，叠加图 ${over.bitmap.width}×${over.bitmap.height}，位置 ${x},${y}）`
    )
  }
  base.image.composite(over, x, y, { opacitySource: opacity / 100 })
  const encoded = await encodeImage(base.image, 'png', 100)
  return {
    ok: true,
    files: [
      toFile(outputFileName(base.sourceName, 'montage', encoded.ext), encoded.mime, encoded.buffer)
    ],
    text: `叠加完成：${over.bitmap.width}×${over.bitmap.height} 放在 (${x}, ${y})，不透明度 ${opacity}%`,
    data: {
      mode,
      width: baseWidth,
      height: baseHeight,
      overlay: { width: over.bitmap.width, height: over.bitmap.height, x, y, opacity }
    },
    note: '仅按 alpha 通道做简单叠加（含不透明度调整），不做 AI 人脸检测、换脸或风格融合'
  }
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

const HANDLERS: Record<string, (args: ToolArgs) => Promise<ToolResult>> = {
  'image-compress': toolCompress,
  'image-crop': toolCrop,
  'image-filter': toolFilter,
  'image-background': toolBackground,
  'image-base64': toolBase64,
  'image-ico': toolIco,
  'image-grid': toolGrid,
  'image-ascii': toolAscii,
  'image-watermark': toolWatermark,
  'word-cloud': toolWordCloud,
  'image-montage': toolMontage
}

export async function execute(id: string, args: ToolArgs): Promise<ToolResult> {
  const handler = HANDLERS[id]
  if (!handler) return fail(`未知工具：${id}`)
  try {
    return await handler(args)
  } catch (error) {
    if (error instanceof RangeError) return fail('处理失败：数据量过大或内存不足')
    return fail(error instanceof Error ? error.message : '处理失败：未知错误')
  }
}

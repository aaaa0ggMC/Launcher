/**
 * ANSI escape sequence handling for console output in the renderer.
 * - Renders SGR (Select Graphic Rendition) sequences as inline-styled spans
 *   so colored process output (e.g. loggers) shows real colors.
 * - Drops all other escape sequences (cursor movement, OSC, etc.) so they
 *   never leak into the visible text.
 */

const ESC = '\u001b'

interface SgrState {
  fg: string
  bg: string
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  strikethrough: boolean
  reverse: boolean
}

const DEFAULT_STATE: SgrState = {
  fg: '',
  bg: '',
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strikethrough: false,
  reverse: false
}

const ANSI_COLORS: Record<number, string> = {
  0: '#1e1e1e',
  1: '#cd3131',
  2: '#0dbc79',
  3: '#b5ba00',
  4: '#2472c8',
  5: '#bc3fbc',
  6: '#11a8cd',
  7: '#e5e5e5',
  8: '#666666',
  9: '#f14c4c',
  10: '#23d18b',
  11: '#f5f543',
  12: '#3b8eea',
  13: '#d670d6',
  14: '#29b8db',
  15: '#e5e5e5'
}

function rgb(r: number, g: number, b: number): string {
  return `rgb(${r},${g},${b})`
}

function ansi256(n: number): string {
  if (n < 16) return ANSI_COLORS[n]
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return rgb(v, v, v)
  }
  n -= 16
  const r = Math.floor(n / 36)
  const g = Math.floor((n % 36) / 6)
  const b = n % 6
  return rgb(r ? 55 + r * 40 : 0, g ? 55 + g * 40 : 0, b ? 55 + b * 40 : 0)
}

function applySgr(params: string[], s: SgrState): void {
  let i = 0
  while (i < params.length) {
    let code = parseInt(params[i], 10)
    if (Number.isNaN(code)) code = 0
    switch (code) {
      case 0:
        Object.assign(s, DEFAULT_STATE)
        break
      case 1:
        s.bold = true
        s.dim = false
        break
      case 2:
        s.dim = true
        s.bold = false
        break
      case 22:
        s.bold = false
        s.dim = false
        break
      case 3:
        s.italic = true
        break
      case 23:
        s.italic = false
        break
      case 4:
        s.underline = true
        break
      case 24:
        s.underline = false
        break
      case 9:
        s.strikethrough = true
        break
      case 29:
        s.strikethrough = false
        break
      case 7:
        s.reverse = true
        break
      case 27:
        s.reverse = false
        break
      case 39:
        s.fg = ''
        break
      case 49:
        s.bg = ''
        break
      case 38:
      case 48: {
        const set = code === 38 ? 'fg' : 'bg'
        const mode = parseInt(params[i + 1], 10)
        if (mode === 5) {
          const n = parseInt(params[i + 2], 10)
          if (!Number.isNaN(n)) s[set] = ansi256(n)
          i += 3
        } else if (mode === 2) {
          const r = parseInt(params[i + 2], 10)
          const g = parseInt(params[i + 3], 10)
          const b = parseInt(params[i + 4], 10)
          if (![r, g, b].some(Number.isNaN)) s[set] = rgb(r, g, b)
          i += 5
        } else {
          i += 2
        }
        continue
      }
      default:
        if (code >= 30 && code <= 37) s.fg = ANSI_COLORS[code - 30]
        else if (code >= 40 && code <= 47) s.bg = ANSI_COLORS[code - 40]
        else if (code >= 90 && code <= 97) s.fg = ANSI_COLORS[code - 90 + 8]
        else if (code >= 100 && code <= 107) s.bg = ANSI_COLORS[code - 100 + 8]
    }
    i++
  }
}

function sgrCss(s: SgrState): string {
  const fg = s.reverse ? s.bg : s.fg
  const bg = s.reverse ? s.fg : s.bg
  const rules: string[] = []
  if (fg) rules.push(`color:${fg}`)
  if (bg) rules.push(`background:${bg}`)
  if (s.bold) rules.push('font-weight:600')
  if (s.dim) rules.push('opacity:.7')
  if (s.italic) rules.push('font-style:italic')
  if (s.underline) rules.push('text-decoration:underline')
  if (s.strikethrough) rules.push('text-decoration:line-through')
  return rules.join(';')
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

/**
 * Render a raw console line (may contain ANSI escapes) into safe HTML.
 * SGR sequences become colored spans; every other escape is discarded.
 */
export function ansiToHtml(line: string): string {
  if (line.indexOf(ESC) === -1) return escapeHtml(line)

  const s: SgrState = { ...DEFAULT_STATE }
  let out = ''
  let text = ''
  let i = 0

  const flush = (): void => {
    if (!text) return
    const style = sgrCss(s)
    out += style ? `<span style="${style}">${escapeHtml(text)}</span>` : escapeHtml(text)
    text = ''
  }

  while (i < line.length) {
    if (line[i] !== ESC) {
      text += line[i++]
      continue
    }
    // ESC '[' → CSI sequence (params until final byte @..~)
    if (line[i + 1] === '[') {
      let j = i + 2
      while (j < line.length && !/[@-~]/.test(line[j])) j++
      const body = line.slice(i + 2, j)
      if (j < line.length && line[j] === 'm') {
        flush()
        applySgr(body.split(/[;:]/), s)
      }
      i = j + 1
      continue
    }
    // ESC ']' → OSC sequence, consumed up to BEL or ESC '\'
    if (line[i + 1] === ']') {
      let j = i + 2
      while (j < line.length && line[j] !== '\u0007' && !(line[j] === ESC && line[j + 1] === '\\'))
        j++
      i = line[j] === '\u0007' ? j + 1 : j + 2
      continue
    }
    // Any other escape: consume ESC + next char and ignore.
    i += 2
  }
  flush()
  return out
}

/** Drop ANSI escape sequences entirely, keeping only the visible text. */
export function stripAnsi(line: string): string {
  if (line.indexOf(ESC) === -1) return line
  let out = ''
  let i = 0
  while (i < line.length) {
    if (line[i] !== ESC) {
      out += line[i++]
      continue
    }
    if (line[i + 1] === '[') {
      let j = i + 2
      while (j < line.length && !/[@-~]/.test(line[j])) j++
      i = j + 1
      continue
    }
    if (line[i + 1] === ']') {
      let j = i + 2
      while (j < line.length && line[j] !== '\u0007' && !(line[j] === ESC && line[j + 1] === '\\'))
        j++
      i = line[j] === '\u0007' ? j + 1 : j + 2
      continue
    }
    i += 2
  }
  return out
}

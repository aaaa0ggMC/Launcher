/**
 * Minimal, correct CSV parse/serialize used by sheet-convert / sheet-merge.
 *
 * RFC 4180 rules: fields may be quoted, embedded quotes doubled, newlines and
 * the delimiter may live inside quoted fields.
 */

export type CsvDelimiter = 'comma' | 'semicolon' | 'tab' | string

const DELIMITER_CHARS: Record<string, string> = {
  comma: ',',
  semicolon: ';',
  tab: '\t'
}

/** Map a select value to the real delimiter character. */
export function delimiterChar(value: string | undefined): string {
  return DELIMITER_CHARS[value ?? 'comma'] ?? ','
}

/**
 * Parse CSV text into rows. A trailing newline is ignored, and a leading UTF-8
 * BOM is stripped when present.
 */
export function parseCsv(input: string, delimiter = ','): string[][] {
  let text = input
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const d = delimiter || ','
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const pushField = (): void => {
    row.push(field)
    field = ''
  }
  const pushRow = (): void => {
    pushField()
    rows.push(row)
    row = []
  }
  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"' && field === '') {
      inQuotes = true
      i++
      continue
    }
    if (c === d) {
      pushField()
      i++
      continue
    }
    if (c === '\r') {
      if (text[i + 1] === '\n') i++
      pushRow()
      i++
      continue
    }
    if (c === '\n') {
      pushRow()
      i++
      continue
    }
    field += c
    i++
  }
  if (field !== '' || row.length > 0) pushRow()
  // Drop the empty row produced by a trailing newline.
  if (rows.length > 0) {
    const last = rows[rows.length - 1]
    if (last.length === 1 && last[0] === '') rows.pop()
  }
  return rows
}

/** Serialize rows to CSV text (LF row separators, quoting only when needed). */
export function toCsv(rows: string[][], delimiter = ','): string {
  const d = delimiter || ','
  const lines: string[] = []
  for (const row of rows) {
    const cells = row.map((cell) => {
      const s = cell ?? ''
      if (/["\r\n]/.test(s) || s.includes(d) || /^\s|\s$/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`
      }
      return s
    })
    lines.push(cells.join(d))
  }
  return lines.join('\n') + '\n'
}

/** Guess the delimiter of a CSV sample (used when importing .csv files). */
export function detectDelimiter(sample: string): string {
  const line = sample.split(/\r?\n/, 1)[0] ?? ''
  const counts: Array<[string, number]> = [
    [',', (line.match(/,/g) ?? []).length],
    [';', (line.match(/;/g) ?? []).length],
    ['\t', (line.match(/\t/g) ?? []).length]
  ]
  counts.sort((a, b) => b[1] - a[1])
  return counts[0][1] > 0 ? counts[0][0] : ','
}

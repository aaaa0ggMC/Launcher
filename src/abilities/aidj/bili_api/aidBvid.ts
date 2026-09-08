const XOR_CODE = 23442827791579n
const MASK_CODE = 2251799813685247n
const MAX_AID = 1n << 51n
const BASE = 58n

const DATA = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf'

export function bvid2aid(bvid: string): number {
  const arr = bvid.split('')
  ;[arr[3], arr[9]] = [arr[9], arr[3]]
  ;[arr[4], arr[7]] = [arr[7], arr[4]]

  const sub = arr.slice(3)
  let tmp = 0n
  for (const ch of sub) {
    const idx = BigInt(DATA.indexOf(ch))
    if (idx === -1n) {
      throw new Error(`Invalid BV character: ${ch}`)
    }
    tmp = tmp * BASE + idx
  }

  return Number((tmp & MASK_CODE) ^ XOR_CODE)
}

export function aid2bvid(aid: number | bigint): string {
  const bytes = 'BV1000000000'.split('')
  let bvIdx = 11
  let tmp = (MAX_AID | BigInt(aid)) ^ XOR_CODE

  while (tmp > 0n) {
    const mod = Number(tmp % BASE)
    bytes[bvIdx] = DATA[mod]
    tmp = tmp / BASE
    bvIdx -= 1
  }

  ;[bytes[3], bytes[9]] = [bytes[9], bytes[3]]
  ;[bytes[4], bytes[7]] = [bytes[7], bytes[4]]
  return bytes.join('')
}

/**
 * Extract BV id from a raw input string, which may be a URL, BV string, or av string.
 */
export function parseBvid(input: string): string | null {
  const raw = (input || '').trim()
  const bvMatch = /[bB][vV]1[0-9a-zA-Z]{9}/.exec(raw)
  if (bvMatch) {
    return 'BV' + bvMatch[0].slice(2)
  }
  const avMatch = /(?:^|\/|[^\w])[aA][vV](\d+)/.exec(raw)
  if (avMatch) {
    const aid = parseInt(avMatch[1], 10)
    if (!Number.isNaN(aid) && aid > 0) {
      return aid2bvid(aid)
    }
  }
  return null
}

/**
 * Extract all unique BV ids from raw input text containing multiple BV/AV IDs or URLs.
 */
export function parseAllBvids(input: string): string[] {
  const raw = input || ''
  const set = new Set<string>()

  // Match all BV numbers
  const bvRegex = /[bB][vV]1[0-9a-zA-Z]{9}/g
  let bvMatch: RegExpExecArray | null
  while ((bvMatch = bvRegex.exec(raw)) !== null) {
    set.add('BV' + bvMatch[0].slice(2))
  }

  // Match all AV numbers
  const avRegex = /(?:^|\/|[^\w])[aA][vV](\d+)/g
  let avMatch: RegExpExecArray | null
  while ((avMatch = avRegex.exec(raw)) !== null) {
    const aid = parseInt(avMatch[1], 10)
    if (!Number.isNaN(aid) && aid > 0) {
      try {
        set.add(aid2bvid(aid))
      } catch {
        /* skip invalid av */
      }
    }
  }

  return Array.from(set)
}

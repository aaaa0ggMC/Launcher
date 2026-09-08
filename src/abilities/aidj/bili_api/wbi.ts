import * as crypto from 'node:crypto'

const OE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
]

/**
 * Mix WBI imgKey and subKey to derive mixin_key.
 */
export function calculateMixinKey(imgKey: string, subKey: string): string {
  const rawKey = imgKey + subKey
  let mixinKey = ''
  for (const idx of OE) {
    if (idx < rawKey.length) {
      mixinKey += rawKey[idx]
    }
  }
  return mixinKey.slice(0, 32)
}

/**
 * Sign params with WBI MD5 hash.
 */
export function signWbi(
  params: Record<string, unknown>,
  mixinKey: string
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...params }
  delete result.w_rid

  result.wts = Math.floor(Date.now() / 1000)

  const keys = Object.keys(result).sort()
  const pairs: string[] = []

  for (const key of keys) {
    const val = result[key]
    if (val === undefined || val === null) continue
    const encodedVal = encodeURIComponent(String(val)).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    )
    pairs.push(`${encodeURIComponent(key)}=${encodedVal}`)
  }

  const queryStr = pairs.join('&')
  const w_rid = crypto
    .createHash('md5')
    .update(queryStr + mixinKey)
    .digest('hex')

  result.w_rid = w_rid
  return result
}

/**
 * Mock environmental params.
 */
export function encodeDm(params: Record<string, unknown>): Record<string, unknown> {
  const dmRand = 'ABCDEFGHIJK'
  const randomStr = (len = 2): string => {
    let s = ''
    for (let i = 0; i < len; i++) {
      s += dmRand[Math.floor(Math.random() * dmRand.length)]
    }
    return s
  }

  return {
    ...params,
    dm_img_list: '[]',
    dm_img_str: randomStr(2),
    dm_cover_img_str: randomStr(2),
    dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}'
  }
}

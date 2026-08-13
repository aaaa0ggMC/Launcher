/**
 * Built-in Netease search + lyric access (vendored, MIT — see ./LICENSE).
 * Used as the automatic fallback when the external NCM service is unreachable.
 */
export { ncmSearch } from './search'
export type { NcmSearchResult, NcmSongHit } from './search'
export { ncmLyric } from './lyric'
export type { NcmLyricResult } from './lyric'

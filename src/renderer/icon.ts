import { FALLBACK_ICON } from './abilities/types'

/**
 * Icon syntax for app entries, actions and ability sidebar entries:
 *  - `default/<name>`            game-icon-pack SVG, no padding
 *  - `default/<name>/padding`    game-icon-pack SVG, padded
 *  - `emoji/<emoji>`             raw emoji, e.g. emoji/😎
 *  - `file//abs/path` or `file/abs/path`  local image (both are absolute)
 *  - `gi:<name>`                 legacy curated sidebar icon (assets/icons)
 *  - bare emoji / bare absolute path       legacy shorthand
 *  - empty / `auto`              fallback cool emoji
 */
export type ParsedIcon =
  | { kind: 'game'; name: string; padding: boolean }
  | { kind: 'emoji'; emoji: string }
  | { kind: 'file'; path: string }

export function parseIcon(icon: string | null | undefined): ParsedIcon {
  if (!icon || icon === 'auto') return { kind: 'emoji', emoji: FALLBACK_ICON }
  if (icon.startsWith('emoji/'))
    return { kind: 'emoji', emoji: icon.slice('emoji/'.length) || FALLBACK_ICON }
  if (icon.startsWith('file/')) {
    let p = icon.slice('file/'.length)
    if (p.startsWith('//')) p = p.slice(1)
    else if (!p.startsWith('/')) p = `/${p}`
    return { kind: 'file', path: p }
  }
  if (icon.startsWith('default/')) {
    let rest = icon.slice('default/'.length)
    let padding = false
    if (rest.endsWith('/padding')) {
      padding = true
      rest = rest.slice(0, -'/padding'.length)
    }
    return rest ? { kind: 'game', name: rest, padding } : { kind: 'emoji', emoji: FALLBACK_ICON }
  }
  if (icon.startsWith('gi:')) return { kind: 'game', name: icon.slice(3), padding: false }
  if (icon.startsWith('/')) return { kind: 'file', path: icon }
  return { kind: 'emoji', emoji: icon || FALLBACK_ICON }
}

/** Build a cockpit-icon:// URL for a local file icon. */
export function fileIconUrl(path: string): string {
  return `cockpit-icon://${encodeURIComponent(path)}`
}

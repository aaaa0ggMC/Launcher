import { protocol, net } from 'electron'

/**
 * `cockpit-icon://<abs-path>` — serves local image files to the sandboxed
 * renderer (file:// is blocked in <img>). Path must be encodeURIComponent'd.
 */
export function registerIconProtocol(): void {
  protocol.handle('cockpit-icon', (request) => {
    try {
      const raw = request.url.slice('cockpit-icon://'.length)
      const path = decodeURIComponent(raw)
      return net.fetch('file://' + path)
    } catch {
      return new Response(null, { status: 400 })
    }
  })
}

/** Build a cockpit-icon:// URL from an absolute path. */
export function iconUrl(absPath: string): string {
  return `cockpit-icon://${encodeURIComponent(absPath)}`
}

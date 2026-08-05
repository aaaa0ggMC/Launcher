/**
 * Local download helpers for the response views. Downloads go through a
 * backend command (main-process fetch) so remote media never hits renderer
 * CORS, and the user picks the destination via the native save dialog.
 */

/** Map a MIME type to a sensible file extension (React's extFromMime). */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
  'audio/x-ms-wma': 'wma',
  'audio/mp4': 'm4a',
  'audio/webm': 'weba',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/x-matroska': 'mkv',
  'application/x-mpegURL': 'm3u8',
  'application/json': 'json',
  'text/plain': 'txt'
}

export function extFromMime(mime?: string): string | null {
  if (!mime) return null
  const base = mime.split(';')[0].trim().toLowerCase()
  return MIME_EXT[base] ?? null
}

/** Extract a usable base name from a URL (path segment + known extension). */
function nameFromUrl(url: string, mime?: string): string {
  let base = 'download'
  try {
    const u = new URL(url)
    base = u.pathname.split('/').filter(Boolean).pop() ?? 'download'
  } catch {
    // keep default
  }
  const stem = base.replace(/\.\w+$/, '')
  const ext = (base.match(/\.(\w+)$/)?.[1] ?? '') || extFromMime(mime) || ''
  return ext ? `${stem}.${ext}` : base
}

export interface DownloadMediaOptions {
  /** MIME type hint — drives the default extension when the URL has none. */
  mime?: string
  /** preferred base filename (without extension) */
  name?: string
  /** save-dialog title (defaults to localized "save to local") */
  title?: string
}

/** Pick a save path + download a remote URL to it via the main process. */
export async function downloadUrlToLocal(
  url: string,
  opts: DownloadMediaOptions = {}
): Promise<boolean> {
  try {
    const defaultPath = opts.name
      ? `${opts.name}${extFromMime(opts.mime) ? '.' + extFromMime(opts.mime) : ''}`
      : nameFromUrl(url, opts.mime)
    const path = await window.cockpit.pickSaveFile({
      title: opts.title ?? 'Download to local',
      defaultPath,
      filters: [{ name: 'All files', extensions: ['*'] }]
    })
    if (!path) return false
    const res = (await window.cockpit.command('playground.download-url', { url, path })) as {
      ok?: boolean
      error?: string
    } | null
    return res?.ok === true
  } catch {
    return false
  }
}

/** Download inline text (raw response) to a local file. */
export async function downloadTextToLocal(
  text: string,
  defaultName = 'response.txt',
  title?: string
): Promise<void> {
  try {
    const path = await window.cockpit.pickSaveFile({
      title: title ?? 'Download to local',
      defaultPath: defaultName,
      filters: [{ name: 'Text', extensions: ['txt', 'log', 'json'] }]
    })
    if (!path) return
    await window.cockpit.command('playground.download-url', {
      url: '',
      path,
      text
    })
  } catch {
    // ignore
  }
}

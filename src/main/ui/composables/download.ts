/**
 * Local download helpers for the response views. Downloads go through a
 * backend command (main-process fetch) so remote media never hits renderer
 * CORS, and the user picks the destination via the native save dialog.
 */

function nameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const base = u.pathname.split('/').filter(Boolean).pop() ?? 'download'
    // signed URLs bury the extension in query params — recover it from the path
    return base
  } catch {
    return 'download'
  }
}

/** Pick a save path + download a remote URL to it via the main process. */
export async function downloadUrlToLocal(url: string): Promise<boolean> {
  try {
    const path = await window.cockpit.pickSaveFile({
      title: '下载到本地',
      defaultPath: nameFromUrl(url),
      filters: [{ name: '文件', extensions: ['*'] }]
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
  defaultName = 'response.txt'
): Promise<void> {
  try {
    const path = await window.cockpit.pickSaveFile({
      title: '下载到本地',
      defaultPath: defaultName,
      filters: [{ name: '文本', extensions: ['txt', 'log', 'json'] }]
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

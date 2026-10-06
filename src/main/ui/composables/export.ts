/**
 * 导出目标：保存为文件，或复制到剪贴板。
 *
 * - 网页 / 无头：宿主文件选择器（HostFilePicker）的保存模式里多一个「复制到剪贴板」按钮。
 * - Electron：原生保存对话框加不了按钮，先弹一个小选择框（ExportTargetDialog），
 *   选「保存为文件…」再打开原生对话框。
 * - 没有外壳组件接应（AI 独立视图等）：直接走原来的保存对话框。
 *
 * 调用方拿到 `clipboard` 时自己准备文本再 `copyExportText`：文件写盘多半在主进程，
 * 剪贴板只需要同一份内容，不经过磁盘。
 */

export interface ExportSaveOptions {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

export type ExportTarget = { kind: 'file'; path: string } | { kind: 'clipboard' }

export interface ExportTargetRequest {
  opts: ExportSaveOptions
  resolve: (choice: 'file' | 'clipboard' | null) => void
  /** 外壳组件接下请求时同步置 true；没人接就退回保存对话框 */
  handled: boolean
}

export async function pickExportTarget(opts: ExportSaveOptions): Promise<ExportTarget | null> {
  const cockpit = window.cockpit
  if (cockpit.cap('file.save') === 'web') {
    // 与 web-shim 的 dialog:save-file 同一条路，只多带一个 clipboard 标记
    const picked = await new Promise<unknown>((resolve) =>
      window.dispatchEvent(
        new CustomEvent('cockpit:host-pick', {
          detail: { mode: 'save', opts: { ...opts, clipboard: true }, resolve }
        })
      )
    )
    if (picked && typeof picked === 'object' && (picked as { clipboard?: boolean }).clipboard)
      return { kind: 'clipboard' }
    return typeof picked === 'string' && picked ? { kind: 'file', path: picked } : null
  }
  if (cockpit.cap('file.save') !== 'none') {
    const choice = await new Promise<'file' | 'clipboard' | null>((resolve) => {
      const detail: ExportTargetRequest = { opts, resolve, handled: false }
      window.dispatchEvent(new CustomEvent('cockpit:export-target', { detail }))
      if (!detail.handled) resolve('file')
    })
    if (choice === 'clipboard') return { kind: 'clipboard' }
    if (choice !== 'file') return null
    const path = await cockpit.pickSaveFile(opts)
    return path ? { kind: 'file', path } : null
  }
  // 宿主没有保存能力：只剩剪贴板
  return { kind: 'clipboard' }
}

export async function copyExportText(text: string): Promise<void> {
  await window.cockpit.copyText(text)
}

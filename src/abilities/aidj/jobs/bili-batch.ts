import { registerJobHandler, type JobControl } from '../../../main/process/background-tasks'
import { loadAidjConfig } from '../services/config'
import { invalidateLibrary, scanMusicFiles } from '../services/library'
import { getBiliDefaultSlotName } from '../services/metadata-slots'
import { syncSlotsAndBroadcast } from '../commands/metadata-slots'
import { state } from '../commands/shared'
import { BiliClient, BiliCredential } from '../bili_api'
import { processBiliItem, type BiliImportItemSpec } from './bili-import'

export interface BiliBatchDownloadArgs {
  items: BiliImportItemSpec[]
  folder?: string
  audioOnly?: boolean
  slotName?: string
}

registerJobHandler(
  'aidj.bili-batch-download',
  async (control: JobControl, rawArgs: Record<string, unknown>) => {
    const effectiveArgs = (
      rawArgs.args && typeof rawArgs.args === 'object' && !Array.isArray(rawArgs.args)
        ? { ...rawArgs, ...(rawArgs.args as Record<string, unknown>) }
        : rawArgs
    ) as Record<string, unknown>
    const args = effectiveArgs as unknown as BiliBatchDownloadArgs
    const ac = new AbortController()
    control.setCancel(() => ac.abort())

    const config = await loadAidjConfig()
    if (!config) {
      control.pushLine('错误: AIDJ 配置未找到', 'stderr')
      control.finish('error')
      return
    }

    // Guard: User must have approved Bilibili disclaimer
    if (!config.preferences?.bilibili_approved) {
      control.pushLine(
        '错误: Bilibili API 未获授权批准。请先在设置中查看并同意免责声明，或运行 aidj.approve-bilibili',
        'stderr'
      )
      control.finish('error')
      return
    }

    const items = Array.isArray(args.items)
      ? args.items
      : Array.isArray(rawArgs.items)
        ? (rawArgs.items as BiliImportItemSpec[])
        : []
    if (items.length === 0) {
      control.pushLine('没有待下载的项目', 'stderr')
      control.finish('error')
      return
    }

    const targetSlot = args.slotName || (await getBiliDefaultSlotName())
    control.pushLine(`开始批量下载 ${items.length} 个视频/音频项目，目标元数据槽位: ${targetSlot}`)

    const { credential, sourcePath } = BiliCredential.resolve(
      config.preferences?.bili_credential_path
    )
    if (credential.hasSessdata()) {
      control.pushLine(`已加载 Bilibili 凭据 (来源: ${sourcePath || '本地配置'})`)
    } else {
      control.pushLine('未检测到 Bilibili 登录凭据，以游客身份访问（音画质可能受限）')
    }
    const client = new BiliClient({ credential })

    let successCount = 0
    let failedCount = 0

    for (let i = 0; i < items.length; i++) {
      if (ac.signal.aborted) {
        control.pushLine('用户取消了批量下载')
        control.finish('cancelled')
        return
      }

      const item = items[i]
      const indexNum = i + 1
      control.pushLine(
        `\n----------------------------------------\n[${indexNum}/${items.length}] 正在处理: ${item.title || item.bvid}`
      )

      const mergedItem: BiliImportItemSpec = {
        ...item,
        folder: item.folder || args.folder,
        audioOnly: item.audioOnly ?? args.audioOnly,
        slotName: item.slotName || targetSlot
      }

      try {
        const res = await processBiliItem(
          client,
          config,
          mergedItem,
          control,
          ac.signal,
          (itemPct) => {
            const overallPct = Math.round(((i + itemPct / 100) / items.length) * 100)
            control.setProgress(overallPct)
          }
        )

        if (res.ok) {
          successCount++
          control.pushLine(
            `✅ [${indexNum}/${items.length}] 完成: 《${res.cleanBase || res.title}》`
          )
        } else {
          failedCount++
          control.pushLine(
            `❌ [${indexNum}/${items.length}] 失败: ${res.error || '未知错误'}`,
            'stderr'
          )
        }
      } catch (e) {
        failedCount++
        const error = e instanceof Error ? e.message : String(e)
        control.pushLine(`❌ [${indexNum}/${items.length}] 异常: ${error}`, 'stderr')
      }

      control.setProgress(Math.round(((i + 1) / items.length) * 100))
    }

    invalidateLibrary()
    try {
      state.musicPaths = await scanMusicFiles(config.music_folders ?? [])
      await syncSlotsAndBroadcast()
    } catch {
      /* ignore */
    }
    control.pushLine(
      `\n🎉 批量下载任务完成！成功 ${successCount} 个，失败 ${failedCount} 个。元数据已更新至 ${targetSlot}。`
    )
    control.setProgress(100)
    control.finish('exited')
  }
)

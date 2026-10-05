import { registerJobHandler } from '../../../main/process/background-tasks'
import { makeLogger } from '../../../main/process/logger'
import { loadAidjConfig, ensureAidjDir } from '../services/config'
import { loadLibrary, invalidateLibrary } from '../services/library'
import { getActiveWriteSlotPath, invalidateSlotCache } from '../services/metadata-slots'
import { analyzeLoudness } from '../services/loudness'
import { readFile, writeFile } from 'fs/promises'

const log = makeLogger('aidj-loudness-backfill')

/**
 * aidj.loudness-backfill — 给曲库里【已有元数据但没有实测响度】的老歌补录
 * `loudness_lufs` / `loudness_peak_db`（EBU R128 integrated loudness + true
 * peak，ffprobe）。只补缺字段，不动 language/emotion/genre/loudness/review；
 *  ffprobe 缺失或分析失败的曲目跳过（向后兼容：字段缺席完全合法）。
 *
 * 为什么单独一个作业：新歌在元数据同步时顺手就写了（services/ncm.ts），老歌
 * 没有入口；AI 选曲时的「 softer / louder 」因此长期没有硬参考。
 */
registerJobHandler(
  'aidj.loudness-backfill',
  async (control, args: { force?: boolean; limit?: number }) => {
    const config = await loadAidjConfig()
    if (!config) {
      control.pushLine('错误: AIDJ 配置未找到', 'stderr')
      control.finish('error')
      return
    }

    const abort = new AbortController()
    control.setCancel(() => abort.abort())

    const force = args.force === true
    const limit = Number(args.limit) > 0 ? Number(args.limit) : 0

    await ensureAidjDir()
    const lib = await loadLibrary()
    const targets: { name: string; path: string }[] = []
    for (const [name, path] of lib.musicPaths) {
      if (abort.signal.aborted) break
      const meta = lib.metadata.get(name)
      if (meta && !force && meta.loudness_lufs != null) continue
      targets.push({ name, path })
    }
    if (limit && targets.length > limit) targets.length = limit

    if (!targets.length) {
      control.pushLine('所有歌曲都已有实测响度，无需补录')
      control.finish('exited')
      return
    }

    control.pushLine(`待补录 ${targets.length} 首（并发 2，ffprobe 全曲分析，约 1s/首）`)
    const slotPath = await getActiveWriteSlotPath()
    const written: { name: string; lufs: number; peak: number | null }[] = []

    // 逐首串行 + 两路并发：ffprobe 吃 CPU，手机上并发高了会拖垮播放
    let index = 0
    let done = 0
    const worker = async (): Promise<void> => {
      while (index < targets.length) {
        if (abort.signal.aborted) return
        const target = targets[index++]
        const info = await analyzeLoudness(target.path)
        done++
        if (!info || info.integrated_lufs == null) {
          control.pushLine(`跳过（测不出）：${target.name}`)
          control.setProgress(Math.round((done / targets.length) * 100))
          continue
        }
        const peak = info.peak_db
        written.push({ name: target.name, lufs: info.integrated_lufs, peak })
        control.pushLine(
          `${target.name} → ${info.integrated_lufs} LUFS${peak != null ? ` / ${peak} dBFS` : ''}`
        )
        control.setProgress(Math.round((done / targets.length) * 100))
      }
    }
    await Promise.all([worker(), worker()])

    if (abort.signal.aborted) {
      control.pushLine('已停止：本次测得的响度未写入')
      control.finish('cancelled')
      return
    }

    // 一次性把结果并进当前写入槽位（同曲目后写覆盖先写）
    if (written.length) {
      const raw = await readFile(slotPath, 'utf-8').catch(() => '')
      const lines = raw.split('\n').filter(Boolean)
      const byName = new Map(written.map((w) => [w.name, w]))
      const merged: string[] = []
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { name?: string; metadata?: Record<string, unknown> }
          const hit = entry.name ? byName.get(entry.name) : undefined
          if (entry.name && hit && entry.metadata) {
            entry.metadata.loudness_lufs = hit.lufs
            if (hit.peak != null) entry.metadata.loudness_peak_db = hit.peak
            byName.delete(entry.name)
            merged.push(JSON.stringify({ name: entry.name, metadata: entry.metadata }))
            continue
          }
        } catch {
          /* 保留无法解析的原行 */
        }
        merged.push(line)
      }
      for (const [name, w] of byName) {
        merged.push(
          JSON.stringify({
            name,
            metadata: {
              loudness_lufs: w.lufs,
              ...(w.peak != null ? { loudness_peak_db: w.peak } : {})
            }
          })
        )
      }
      await writeFile(slotPath, merged.join('\n') + '\n', 'utf-8')
      invalidateSlotCache(slotPath)
      invalidateLibrary()
      log.info('loudness backfill written', { count: written.length, slot: slotPath })
    }

    control.pushLine(`补录完成：${written.length} 首写入实测响度`)
    control.push({ data: { type: 'loudness_backfill_done', count: written.length } })
    control.finish('exited')
  }
)

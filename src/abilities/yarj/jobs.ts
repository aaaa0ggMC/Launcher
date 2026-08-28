/**
 * yarj 命名作业 — 扫描全部（或指定）图库目录，构建元数据库。
 * 由 commands.ts `import './jobs'` 注册；渲染端经 `btJob('yarj.scan', …)`
 * 或 `yarj.scan` 命令触发，任务存活于后台任务框架（跨页面）。
 */
import { registerJobHandler, type JobControl } from '../../main/process/background-tasks'
import { loadYarjConfig } from './service'
import { finishScanRun, startScanRun } from './db'
import { scanGalleryRoot, type RootScanSummary } from './scan'
import { generateLod, markLodDone, markLodRunning, writeLodData } from './lod'
import {
  generateHierarchy,
  markHierarchyDone,
  markHierarchyRunning,
  writeHierarchy
} from './hierarchy'
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('yarj-jobs')

registerJobHandler('yarj.scan', async (control: JobControl, args: Record<string, unknown>) => {
  const onlyRoot = typeof args.root === 'string' && args.root ? args.root : null
  const cfg = await loadYarjConfig()
  const roots = cfg.galleryRoots.filter((r) => !onlyRoot || r.path === onlyRoot)
  if (!roots.length) {
    control.pushLine('没有可扫描的图库目录（设置 → 旅行记录 → 图库目录）', 'stderr')
    control.finish('error')
    return
  }

  const ac = new AbortController()
  control.setCancel(() => ac.abort())

  const grand: RootScanSummary = { total: 0, scanned: 0, skipped: 0, withGps: 0, failed: 0 }

  for (let i = 0; i < roots.length; i++) {
    const root = roots[i].path
    const runId = startScanRun(root)
    control.pushLine(`[${i + 1}/${roots.length}] 扫描 ${root}`)
    try {
      const summary = await scanGalleryRoot(root, {
        signal: ac.signal,
        onLine: (l) => control.pushLine(l),
        onProgress: (p) => {
          const frac = p.total > 0 ? p.done / p.total : 0
          control.setProgress(Math.round(((i + frac) / roots.length) * 100))
        }
      })
      grand.total += summary.total
      grand.scanned += summary.scanned
      grand.skipped += summary.skipped
      grand.withGps += summary.withGps
      grand.failed += summary.failed
      if (ac.signal.aborted) {
        finishScanRun(runId, 'cancelled', summary.total, summary.withGps, summary.failed)
        control.pushLine('已取消', 'stderr')
        control.finish('cancelled')
        return
      }
      finishScanRun(runId, 'done', summary.total, summary.withGps, summary.failed)
      control.pushLine(
        `完成 ${root}: 解析 ${summary.scanned} / 含定位 ${summary.withGps} / 失败 ${summary.failed} / 跳过 ${summary.skipped}`
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('scan root failed', { root, error: msg })
      finishScanRun(runId, 'error', 0, 0, 0, msg)
      control.pushLine(`扫描失败 ${root}: ${msg}`, 'stderr')
      control.finish('error')
      return
    }
  }

  control.setProgress(100)
  control.pushLine(
    `全部完成: 共 ${grand.total} 张图片（解析 ${grand.scanned}，含定位 ${grand.withGps}，失败 ${grand.failed}）`
  )
  control.finish('exited')
})

/**
 * LOD 生成作业 — 后台解码矢量瓦片，提取行政区包围盒并缓存。
 * 渲染端首次打开地图且无缓存时自动触发；可取消、带进度。
 */
registerJobHandler('yarj.lod', async (control: JobControl, args: Record<string, unknown>) => {
  const onlyId = typeof args.id === 'string' && args.id ? args.id : null
  const cfg = await loadYarjConfig()
  const maps = cfg.maps.filter((m) => (!onlyId || m.id === onlyId) && m.enabled)
  if (!maps.length) {
    control.pushLine('没有可生成 LOD 的地图', 'stderr')
    control.finish('error')
    return
  }

  const ac = new AbortController()
  control.setCancel(() => ac.abort())

  for (let i = 0; i < maps.length; i++) {
    const map = maps[i]
    markLodRunning(map.id)
    control.pushLine(`[${i + 1}/${maps.length}] 生成 LOD: ${map.id}（${map.path}）`)
    try {
      const data = await generateLod(map, {
        signal: ac.signal,
        onProgress: (p) => {
          // 进度：缩放层占 70% + 要素数占 30%
          const zoomFrac = p.zoom / Math.max(1, p.maxZoom)
          control.setProgress(Math.round(((i + zoomFrac * 0.7) / maps.length) * 100))
          if (p.newThisZoom > 0) {
            control.pushLine(`  z${p.zoom}: 共 ${p.unique} 个区（新增 ${p.newThisZoom}）`)
          }
        }
      })
      writeLodData(map.id, data)
      markLodDone(map.id)
      control.pushLine(`完成 ${map.id}: ${data.count} 个行政区已缓存`)
    } catch (err) {
      markLodDone(map.id)
      if (ac.signal.aborted) {
        control.pushLine('已取消', 'stderr')
        control.finish('cancelled')
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      log.error('lod generation failed', { map: map.id, error: msg })
      control.pushLine(`LOD 生成失败 ${map.id}: ${msg}`, 'stderr')
      control.finish('error')
      return
    }
  }

  control.setProgress(100)
  control.pushLine('LOD 全部完成')
  control.finish('exited')
})

/**
 * 行政归属（市/县 → 省）生成作业 — 后台解码瓦片做空间包含推导并缓存。
 * 与 LOD 一起在打开地图时自动触发；可取消、带进度。
 */
registerJobHandler('yarj.hierarchy', async (control: JobControl, args: Record<string, unknown>) => {
  const onlyId = typeof args.id === 'string' && args.id ? args.id : null
  const cfg = await loadYarjConfig()
  const maps = cfg.maps.filter((m) => (!onlyId || m.id === onlyId) && m.enabled)
  if (!maps.length) {
    control.pushLine('没有可生成归属数据的地图', 'stderr')
    control.finish('error')
    return
  }

  const ac = new AbortController()
  control.setCancel(() => ac.abort())

  for (let i = 0; i < maps.length; i++) {
    const map = maps[i]
    markHierarchyRunning(map.id)
    control.pushLine(`[${i + 1}/${maps.length}] 推导行政归属: ${map.id}`)
    try {
      const data = await generateHierarchy(map, {
        signal: ac.signal,
        onLine: (l) => control.pushLine(l),
        onProgress: (done, total) =>
          control.setProgress(Math.round(((i + done / Math.max(1, total)) / maps.length) * 100))
      })
      writeHierarchy(map.id, data)
      markHierarchyDone(map.id)
      control.pushLine(
        `完成 ${map.id}: ${Object.keys(data.adm2).length} 个市/县已归属（未归属 ${data.unmatched.length}）`
      )
    } catch (err) {
      markHierarchyDone(map.id)
      if (ac.signal.aborted) {
        control.pushLine('已取消', 'stderr')
        control.finish('cancelled')
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      log.error('hierarchy generation failed', { map: map.id, error: msg })
      control.pushLine(`归属生成失败 ${map.id}: ${msg}`, 'stderr')
      control.finish('error')
      return
    }
  }

  control.setProgress(100)
  control.pushLine('行政归属全部完成')
  control.finish('exited')
})

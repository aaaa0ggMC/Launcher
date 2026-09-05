/**
 * yarj 命名作业 — 扫描全部（或指定）图库目录，构建元数据库。
 * 由 commands.ts `import './jobs'` 注册；渲染端经 `btJob('yarj.scan', …)`
 * 或 `yarj.scan` 命令触发，任务存活于后台任务框架（跨页面）。
 */
import { readdir, readFile } from 'fs/promises'
import { join, extname } from 'path'
import { registerJobHandler, type JobControl } from '../../main/process/background-tasks'
import type { Route, Photo } from './types'
import { loadYarjConfig } from './service'
import {
  finishScanRun,
  startScanRun,
  queryPhotos,
  batchUpdatePhotoGpsGuesses,
  batchUpdatePhotoGpsCorrections,
  clearAllGpsCorrections,
  upsertRoute,
  getRoute,
  queryRoutes,
  batchUpdatePhotoRouteGps,
  clearAllRouteGps,
  findMatchingPhotosForRoute,
  type BatchPhotoRouteGpsItem
} from './db'
import { scanGalleryRoot, type RootScanSummary } from './scan'
import { computeStaticGpsGuesses } from './photo-guess'
import { analyzeAndCorrectGpsDrifts } from './gps-corrector'
import { parseGpxToRoute } from './route-parser'
import { matchPhotoToRoute, getRoutePoints } from './route-geotag'
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

  const grand: RootScanSummary = {
    total: 0,
    scanned: 0,
    skipped: 0,
    moved: 0,
    withGps: 0,
    failed: 0
  }

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
      grand.moved += summary.moved
      grand.withGps += summary.withGps
      grand.failed += summary.failed
      if (ac.signal.aborted) {
        finishScanRun(runId, 'cancelled', summary.total, summary.withGps, summary.failed)
        control.pushLine('已取消', 'stderr')
        control.finish('cancelled')
        return
      }
      finishScanRun(runId, 'done', summary.total, summary.withGps, summary.failed)
      const movedPart = summary.moved > 0 ? ` / 迁移 ${summary.moved}` : ''
      control.pushLine(
        `完成 ${root}: 解析 ${summary.scanned}${movedPart} / 含定位 ${summary.withGps} / 失败 ${summary.failed} / 跳过 ${summary.skipped}`
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

  control.setProgress(95)
  const grandMoved = grand.moved > 0 ? `，移动迁移 ${grand.moved}` : ''
  control.pushLine(
    `基础扫描完成: 共 ${grand.total} 张图片（解析 ${grand.scanned}${grandMoved}，含定位 ${grand.withGps}，失败 ${grand.failed}）`
  )

  // 扫描末尾：对没有 GPS 的照片进行静态中点 GPS 猜测并持久化入库
  control.pushLine('正在对无定位照片进行时空邻近 GPS 猜测推算…')
  let totalGuessed = 0
  for (const r of roots) {
    if (ac.signal.aborted) break
    try {
      const photos = queryPhotos({ root: r.path })
      const guesses = computeStaticGpsGuesses(photos, {
        maxDistanceM: cfg.gpsGuessMaxDistanceM ?? 10000,
        maxTimeHours: cfg.gpsGuessMaxTimeHours ?? 4
      })
      batchUpdatePhotoGpsGuesses(guesses)
      totalGuessed += guesses.length
    } catch (err) {
      log.warn('static gps guess failed for root', { root: r.path, error: String(err) })
    }
  }
  control.pushLine(`完成 GPS 猜测推算: 共为 ${totalGuessed} 张照片推算中点坐标`)

  control.setProgress(100)
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

registerJobHandler(
  'yarj.correct-gps',
  async (control: JobControl, args: Record<string, unknown>) => {
    const maxSpeedKmh = typeof args.maxSpeedKmh === 'number' ? args.maxSpeedKmh : 800
    const minDriftKm = typeof args.minDriftKm === 'number' ? args.minDriftKm : 80
    const maxTimeGapHours = typeof args.maxTimeGapHours === 'number' ? args.maxTimeGapHours : 24
    const targetRoot = typeof args.root === 'string' && args.root ? args.root : undefined

    control.pushLine(
      `[GPS纠正] 启动时空速度合理性分析（速度上限: ${maxSpeedKmh} km/h, 最小漂移: ${minDriftKm} km, 时间窗口: ${maxTimeGapHours} h）...`
    )
    control.setProgress(10)

    const ac = new AbortController()
    control.setCancel(() => ac.abort())

    try {
      const allPhotos = queryPhotos({ root: targetRoot })
      control.pushLine(`[GPS纠正] 读取相册照片共 ${allPhotos.length} 张`)
      control.setProgress(30)

      if (ac.signal.aborted) {
        control.finish('cancelled')
        return
      }

      const items = analyzeAndCorrectGpsDrifts(allPhotos, {
        maxSpeedKmh,
        minDriftKm,
        maxTimeGapHours,
        root: targetRoot
      })

      control.setProgress(70)
      control.pushLine(`[GPS纠正] 智能分析完成，检测到 ${items.length} 张存在严重漂移的异常照片`)

      for (let i = 0; i < items.length; i++) {
        if (ac.signal.aborted) {
          control.finish('cancelled')
          return
        }
        const item = items[i]
        const name = item.photo.path.split('/').pop() || item.photo.path
        control.pushLine(
          `  - [漂移修复 #${i + 1}] ${name}: ${item.correction.reason} -> 纠正至 (${item.correction.lat}, ${item.correction.lon})`
        )
      }

      if (items.length > 0) {
        const updates = items.map((it) => ({
          path: it.photo.path,
          correction: it.correction
        }))
        const written = batchUpdatePhotoGpsCorrections(updates)
        control.pushLine(`[GPS纠正] 成功写入数据库 ${written} 条纠正记录`)
      } else {
        control.pushLine('[GPS纠正] 未发现超出速度与距离阈值的离群漂移点')
      }

      control.setProgress(100)
      control.pushLine('GPS 纠正分析处理完成')
      control.finish('exited')
    } catch (err) {
      if (ac.signal.aborted) {
        control.finish('cancelled')
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      log.error('gps correction failed', { error: msg })
      control.pushLine(`GPS纠正失败: ${msg}`, 'stderr')
      control.finish('error')
    }
  }
)

registerJobHandler(
  'yarj.clear-gps-correction',
  async (control: JobControl, args: Record<string, unknown>) => {
    const targetRoot = typeof args.root === 'string' && args.root ? args.root : undefined
    control.pushLine(
      `[取消GPS纠正] 准备重置${targetRoot ? `目录 ${targetRoot}` : '全部'}纠正记录...`
    )
    control.setProgress(30)
    try {
      const cleared = clearAllGpsCorrections(targetRoot)
      control.setProgress(100)
      control.pushLine(
        `[取消GPS纠正] 成功重置 ${cleared} 条纠正记录，所有照片恢复原始 GPS / 猜测 GPS 坐标`
      )
      control.finish('exited')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      control.pushLine(`重置失败: ${msg}`, 'stderr')
      control.finish('error')
    }
  }
)

/** 递归扫描指定目录下的所有 GPX 文件 */
async function findGpxFiles(dir: string, signal?: AbortSignal): Promise<string[]> {
  const result: string[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const ent of entries) {
      if (signal?.aborted) break
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        const sub = await findGpxFiles(full, signal)
        result.push(...sub)
      } else if (ent.isFile() && extname(ent.name).toLowerCase() === '.gpx') {
        result.push(full)
      }
    }
  } catch (err) {
    log.warn('read dir for gpx failed', { dir, error: String(err) })
  }
  return result
}

registerJobHandler(
  'yarj.scan-routes',
  async (control: JobControl, args: Record<string, unknown>) => {
    const onlyRoot = typeof args.root === 'string' && args.root ? args.root : null
    const cfg = await loadYarjConfig()
    const roots = (cfg.routeRoots ?? []).filter((r) => !onlyRoot || r.path === onlyRoot)

    if (!roots.length && !onlyRoot) {
      control.pushLine('未配置运动航线目录（设置 → 旅行记录 → 运动航线目录）', 'stderr')
      control.finish('error')
      return
    }

    const targetRoots = roots.length ? roots.map((r) => r.path) : onlyRoot ? [onlyRoot] : []
    const ac = new AbortController()
    control.setCancel(() => ac.abort())

    control.pushLine(`[航线扫描] 正在扫描 ${targetRoots.length} 个航线目录...`)
    control.setProgress(10)

    let totalFiles = 0
    let importedCount = 0
    let failedCount = 0

    for (let i = 0; i < targetRoots.length; i++) {
      const rootPath = targetRoots[i]
      control.pushLine(`[${i + 1}/${targetRoots.length}] 扫描目录: ${rootPath}`)
      const files = await findGpxFiles(rootPath, ac.signal)
      totalFiles += files.length
      control.pushLine(`发现 ${files.length} 个 GPX 轨迹文件`)

      for (let fIdx = 0; fIdx < files.length; fIdx++) {
        if (ac.signal.aborted) {
          control.pushLine('用户取消航线扫描', 'stderr')
          control.finish('cancelled')
          return
        }

        const fPath = files[fIdx]
        try {
          const xml = await readFile(fPath, 'utf-8')
          const route = parseGpxToRoute(xml, fPath)
          if (route) {
            upsertRoute(route)
            importedCount++
            control.pushLine(
              `解析成功: ${route.name} (${(route.totalDistanceM / 1000).toFixed(2)}km, 耗时 ${Math.round(route.durationSec / 60)}分)`
            )
          } else {
            failedCount++
            control.pushLine(`跳过空轨迹或解析无效: ${fPath}`, 'stderr')
          }
        } catch (err) {
          failedCount++
          const msg = err instanceof Error ? err.message : String(err)
          control.pushLine(`解析失败 ${fPath}: ${msg}`, 'stderr')
        }

        const frac = (fIdx + 1) / files.length
        control.setProgress(Math.round(10 + ((i + frac) / targetRoots.length) * 85))
      }
    }

    control.setProgress(100)
    control.pushLine(
      `[航线扫描完成] 共发现 ${totalFiles} 个文件，成功入库 ${importedCount} 条航线记录，失败 ${failedCount} 个`
    )
    control.finish('exited')
  }
)

registerJobHandler(
  'yarj.geotag-routes',
  async (control: JobControl, args: Record<string, unknown>) => {
    const routeId = typeof args.routeId === 'string' && args.routeId ? args.routeId : undefined
    const timeOffsetSec = typeof args.timeOffsetSeconds === 'number' ? args.timeOffsetSeconds : 0
    const targetRoot = typeof args.root === 'string' && args.root ? args.root : undefined

    const ac = new AbortController()
    control.setCancel(() => ac.abort())

    control.pushLine(
      `[足迹构建 - 航线匹配] 启动照片轨迹时序对齐 (时钟偏差补偿: ${timeOffsetSec >= 0 ? `+${timeOffsetSec}` : timeOffsetSec}s)...`
    )
    control.setProgress(10)

    try {
      // 1. 获取航线
      let routes: Route[] = []
      if (routeId) {
        const r = getRoute(routeId)
        if (!r) {
          control.pushLine(`未找到指定航线 ID: ${routeId}`, 'stderr')
          control.finish('error')
          return
        }
        routes = [r]
      } else {
        routes = queryRoutes()
      }

      if (!routes.length) {
        control.pushLine('系统中尚无任何运动航线，请先导入 GPX 文件', 'stderr')
        control.finish('error')
        return
      }

      control.pushLine(`已加载 ${routes.length} 条航线，开始利用时空索引检索候选照片并插值对齐...`)
      control.setProgress(20)

      let totalMatched = 0
      const updateBatch: BatchPhotoRouteGpsItem[] = []

      for (let rIdx = 0; rIdx < routes.length; rIdx++) {
        if (ac.signal.aborted) {
          control.finish('cancelled')
          return
        }

        const route = routes[rIdx]
        const points = getRoutePoints(route)
        if (!points.length) continue

        // 自动识别时序偏差（若外部未指定手动偏置时，自动比对 UTC 与本地伪 Z 时区差）
        let effectiveOffset = timeOffsetSec
        if (effectiveOffset === 0) {
          const matchInfo = findMatchingPhotosForRoute(route.id)
          effectiveOffset = matchInfo.detectedOffsetSec
        }

        // 仅抓取该航线时间窗口范围内的候选照片，极大提升几十万张大图库时的性能
        let candidatePhotos: Photo[] = []
        if (route.startTime && route.endTime) {
          const startMs = new Date(route.startTime).getTime()
          const endMs = new Date(route.endTime).getTime()
          if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) {
            const qStart = new Date(startMs - effectiveOffset * 1000 - 300000).toISOString()
            const qEnd = new Date(endMs - effectiveOffset * 1000 + 300000).toISOString()
            candidatePhotos = queryPhotos({ root: targetRoot, since: qStart, until: qEnd })
          }
        }
        if (!candidatePhotos.length && (!route.startTime || !route.endTime)) {
          candidatePhotos = queryPhotos(targetRoot ? { root: targetRoot } : {})
        }

        let routeMatches = 0
        for (const photo of candidatePhotos) {
          const matched = matchPhotoToRoute(photo, route, points, effectiveOffset)
          if (matched) {
            updateBatch.push({
              path: photo.path,
              trackGps: matched
            })
            routeMatches++
            totalMatched++
          }
        }

        control.pushLine(
          `航线【${route.name}】成功贴合 ${routeMatches} 张照片${effectiveOffset !== 0 ? ` (时区偏差补偿: ${effectiveOffset >= 0 ? '+' : ''}${effectiveOffset}s)` : ''}`
        )
        control.setProgress(Math.round(20 + ((rIdx + 1) / routes.length) * 60))
      }

      control.pushLine(`正在将 ${updateBatch.length} 条轨迹匹配数据批量写入元数据库...`)
      if (updateBatch.length > 0) {
        batchUpdatePhotoRouteGps(updateBatch)
      }

      control.setProgress(100)
      control.pushLine(
        `[轨迹构建完成] 成功将 ${totalMatched} 张照片精确对齐至真实运动轨迹点上 (gps_track 生效)`
      )
      control.finish('exited')
    } catch (err) {
      if (ac.signal.aborted) {
        control.finish('cancelled')
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      log.error('geotag routes job failed', { error: msg })
      control.pushLine(`轨迹对齐失败: ${msg}`, 'stderr')
      control.finish('error')
    }
  }
)

registerJobHandler(
  'yarj.clear-route-geotag',
  async (control: JobControl, args: Record<string, unknown>) => {
    const targetRoot = typeof args.root === 'string' && args.root ? args.root : undefined
    control.pushLine(
      `[重置轨迹匹配] 准备清除${targetRoot ? `目录 ${targetRoot}` : '全部'}照片的 gps_track 字段...`
    )
    control.setProgress(30)
    try {
      const cleared = clearAllRouteGps(targetRoot)
      control.setProgress(100)
      control.pushLine(
        `[重置轨迹匹配] 成功清除 ${cleared} 条航线匹配记录，照片坐标已恢复下一优先级`
      )
      control.finish('exited')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      control.pushLine(`重置失败: ${msg}`, 'stderr')
      control.finish('error')
    }
  }
)

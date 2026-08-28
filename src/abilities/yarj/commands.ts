/**
 * yarj 命令 — CLI-first：UI 按钮与 CLI REPL 共用同一 handler。
 * 模块加载时（abilities-loader eager 导入，早于 app ready）注册 yarj.scan
 * 命名作业与 cockpit-tile 协议的 startup hook（协议需 ready 后才可 handle）。
 */
import type { CommandSpec } from '../../main/process/commands/types'
import { makeLogger } from '../../main/process/logger'
import { startJobByName } from '../../main/process/background-tasks'
import {
  addGalleryRoot,
  addMapFile,
  hierarchyStatus,
  loadYarjConfig,
  lodStatus,
  mapInfo,
  moveGalleryRoot,
  removeGalleryRoot,
  removeMapFile,
  saveYarjConfig,
  scanStats,
  setMapEnabled,
  setMapZoom,
  listMaps,
  listProviders,
  setActiveProvider,
  getTileCacheStats,
  clearTileCache,
  forwardGeocode,
  reverseGeocode,
  pruneMissingPhotos
} from './service'
import { queryPhotos, updatePhoto } from './db'
import { readLodData } from './lod'
import { readHierarchy } from './hierarchy'
import { registerStartupHook } from '../../main/process/startup'
import { registerYarjTileProtocol, dropMbtilesCache } from './tile-protocol'
import './jobs'

const log = makeLogger('yarj')

// 瓦片协议必须等 app ready 后 protocol.handle 才可用（eager glob 在 ready 前
// 导入本模块），所以走框架的 startup hook（ready 后统一执行）。
registerStartupHook(() => registerYarjTileProtocol())

/** 解析可选 JSON 参数（字符串或对象）。 */
function parsePatch(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return (v ?? {}) as Record<string, unknown>
}

export default [
  {
    name: 'yarj.config',
    description: '读取 yarj 配置（图库目录 / 地图文件 / 探索半径）',
    usage: 'yarj.config',
    run: async () => loadYarjConfig()
  },
  {
    name: 'yarj.save-config',
    description: '保存配置 (--patch <json>)',
    usage: 'yarj.save-config --patch {"exploredRadiusM":2000}',
    run: async (ctx) => saveYarjConfig(parsePatch(ctx.named.patch))
  },
  {
    name: 'yarj.add-root',
    description: '添加图库目录 (--path)',
    usage: 'yarj.add-root --path /home/user/Pictures',
    run: async (ctx) => {
      const path = String(ctx.named.path ?? '')
      if (!path) {
        log.warn('yarj.add-root missing path')
        return { ok: false, error: '需要 --path' }
      }
      return addGalleryRoot(path)
    }
  },
  {
    name: 'yarj.remove-root',
    description: '移除图库目录 (--path)',
    usage: 'yarj.remove-root --path /home/user/Pictures',
    run: async (ctx) => {
      const path = String(ctx.named.path ?? '')
      if (!path) return { ok: false, error: '需要 --path' }
      return removeGalleryRoot(path)
    }
  },
  {
    name: 'yarj.move-root',
    description: '调整图库目录顺序 (--path --dir -1|1)',
    usage: 'yarj.move-root --path /home/user/Pictures --dir 1',
    run: async (ctx) => {
      const path = String(ctx.named.path ?? '')
      const dir = Number(ctx.named.dir ?? 0)
      if (!path || (dir !== -1 && dir !== 1)) return { ok: false, error: '需要 --path 与 --dir' }
      return moveGalleryRoot(path, dir as -1 | 1)
    }
  },
  {
    name: 'yarj.add-map',
    description: '添加 MBTiles 地图文件 (--path [--id])',
    usage: 'yarj.add-map --path ~/Desktop/GlobalMap_ADM0_2.mbtiles',
    run: async (ctx) => {
      const path = String(ctx.named.path ?? '')
      if (!path) return { ok: false, error: '需要 --path' }
      const id = typeof ctx.named.id === 'string' && ctx.named.id ? ctx.named.id : undefined
      const r = await addMapFile(path, id)
      if (r.error) return { ok: false, error: r.error, maps: r.maps }
      return { ok: true, maps: r.maps }
    }
  },
  {
    name: 'yarj.remove-map',
    description: '移除地图文件 (--id)',
    usage: 'yarj.remove-map --id global',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      if (!id) return { ok: false, error: '需要 --id' }
      const cfg = await loadYarjConfig()
      const target = cfg.maps.find((m) => m.id === id)
      if (target) dropMbtilesCache(target.path)
      return removeMapFile(id)
    }
  },
  {
    name: 'yarj.set-map-zoom',
    description: '设置地图默认缩放 (--id --zoom <n>)',
    usage: 'yarj.set-map-zoom --id global --zoom 3',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      const zoom = Number(ctx.named.zoom)
      if (!id || !Number.isFinite(zoom)) return { ok: false, error: '需要 --id 与 --zoom' }
      return setMapZoom(id, zoom)
    }
  },
  {
    name: 'yarj.set-map-enabled',
    description: '启用/禁用地图 (--id --enabled true|false)',
    usage: 'yarj.set-map-enabled --id global --enabled true',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      if (!id) return { ok: false, error: '需要 --id' }
      return setMapEnabled(id, ctx.named.enabled === true || ctx.named.enabled === 'true')
    }
  },
  {
    name: 'yarj.maps',
    description: '列出地图文件及 mbtiles 元数据',
    usage: 'yarj.maps',
    run: async () => listMaps()
  },
  {
    name: 'yarj.map-info',
    description: '单个地图信息 (--id)',
    usage: 'yarj.map-info --id global',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      if (!id) return { ok: false, error: '需要 --id' }
      return mapInfo(id)
    }
  },
  {
    name: 'yarj.scan',
    description: '扫描图库目录构建元数据 ([--root])',
    usage: 'yarj.scan',
    run: async (ctx) => {
      const root = typeof ctx.named.root === 'string' && ctx.named.root ? ctx.named.root : undefined
      const info = await startJobByName('yarj.scan', root ? { root } : {})
      if (!info) return { ok: false, error: '扫描作业启动失败' }
      return { ok: true, taskId: info.id }
    }
  },
  {
    name: 'yarj.scan-status',
    description: '扫描统计（照片总数 / 含定位 / 最近扫描记录）',
    usage: 'yarj.scan-status',
    run: async () => scanStats()
  },
  {
    name: 'yarj.prune',
    description: '清理数据库中在磁盘上已不存在的照片记录',
    usage: 'yarj.prune',
    run: async () => pruneMissingPhotos()
  },
  {
    name: 'yarj.photos',
    description: '查询照片 (--root --has-gps --since <iso> --q <kw> --bbox <json>)',
    usage: 'yarj.photos --has-gps true',
    run: async (ctx) => {
      const hasGps = ctx.named.hasGps === true || ctx.named.hasGps === 'true'
      const bbox = Array.isArray(ctx.named.bbox)
        ? (ctx.named.bbox as [number, number, number, number])
        : undefined
      return queryPhotos({
        root: typeof ctx.named.root === 'string' && ctx.named.root ? ctx.named.root : undefined,
        hasGps: hasGps || undefined,
        since: typeof ctx.named.since === 'string' ? ctx.named.since : undefined,
        q: typeof ctx.named.q === 'string' && ctx.named.q ? ctx.named.q : undefined,
        bbox
      })
    }
  },
  {
    name: 'yarj.update-photo',
    description: '更新照片 appendix 与 GPS 坐标 (--path --patch <json> --lat --lon --alt)',
    usage:
      'yarj.update-photo --path /abs/photo.jpg --patch {"tags":["东京"]} --lat 35.6895 --lon 139.6917',
    run: async (ctx) => {
      const path = String(ctx.named.path ?? '')
      if (!path) return { ok: false, error: '需要 --path' }
      const patch = ctx.named.patch ? parsePatch(ctx.named.patch) : undefined
      const lat =
        ctx.named.lat === null
          ? null
          : typeof ctx.named.lat === 'number'
            ? ctx.named.lat
            : typeof ctx.named.lat === 'string' && ctx.named.lat
              ? Number(ctx.named.lat)
              : undefined
      const lon =
        ctx.named.lon === null
          ? null
          : typeof ctx.named.lon === 'number'
            ? ctx.named.lon
            : typeof ctx.named.lon === 'string' && ctx.named.lon
              ? Number(ctx.named.lon)
              : undefined
      const alt =
        ctx.named.alt === null
          ? null
          : typeof ctx.named.alt === 'number'
            ? ctx.named.alt
            : typeof ctx.named.alt === 'string' && ctx.named.alt
              ? Number(ctx.named.alt)
              : undefined

      const photo = updatePhoto(path, { patch, lat, lon, alt })
      if (!photo) return { ok: false, error: '照片不在元数据库中，请先扫描' }
      return { ok: true, photo }
    }
  },
  {
    name: 'yarj.geocode',
    description: '地理编码：地名/文字地址 -> 经纬度坐标 (--query <text> [--lang <lang>])',
    usage: 'yarj.geocode --query "东京铁塔" --lang zh-CN',
    run: async (ctx) => {
      const query = String(ctx.named.query ?? '').trim()
      if (!query) return { ok: false, error: '需要 --query' }
      const lang = typeof ctx.named.lang === 'string' ? ctx.named.lang : undefined
      const results = await forwardGeocode(query, lang)
      return { ok: true, results }
    }
  },
  {
    name: 'yarj.reverse-geocode',
    description:
      '逆地理编码：经纬度坐标 -> 结构化文字地址 (--lat <lat> --lon <lon> [--lang <lang>])',
    usage: 'yarj.reverse-geocode --lat 35.6586 --lon 139.7454 --lang zh-CN',
    run: async (ctx) => {
      const lat = typeof ctx.named.lat === 'number' ? ctx.named.lat : Number(ctx.named.lat)
      const lon = typeof ctx.named.lon === 'number' ? ctx.named.lon : Number(ctx.named.lon)
      if (Number.isNaN(lat) || Number.isNaN(lon)) {
        return { ok: false, error: '需要有效的 --lat 和 --lon 坐标' }
      }
      const lang = typeof ctx.named.lang === 'string' ? ctx.named.lang : undefined
      const result = await reverseGeocode(lat, lon, lang)
      return { ok: true, result }
    }
  },
  {
    name: 'yarj.lod',
    description: '生成行政区 LOD 数据（后台作业，--id <mapId>）',
    usage: 'yarj.lod --id GlobalMap_ADM0_2-pa9bem',
    run: async (ctx) => {
      const id = typeof ctx.named.id === 'string' && ctx.named.id ? ctx.named.id : undefined
      const info = await startJobByName('yarj.lod', id ? { id } : {})
      if (!info) return { ok: false, error: 'LOD 作业启动失败' }
      return { ok: true, taskId: info.id }
    }
  },
  {
    name: 'yarj.lod-status',
    description: '查询各地图 LOD 生成状态',
    usage: 'yarj.lod-status',
    run: async () => lodStatus()
  },
  {
    name: 'yarj.lod-data',
    description: '读取地图 LOD 数据（--id <mapId>；未生成返回 null）',
    usage: 'yarj.lod-data --id GlobalMap_ADM0_2-pa9bem',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      if (!id) return { ok: false, error: '需要 --id' }
      return readLodData(id)
    }
  },
  {
    name: 'yarj.hierarchy',
    description: '推导市/县所属省份（后台作业，--id <mapId>）',
    usage: 'yarj.hierarchy --id GlobalMap_ADM0_2-pa9bem',
    run: async (ctx) => {
      const id = typeof ctx.named.id === 'string' && ctx.named.id ? ctx.named.id : undefined
      const info = await startJobByName('yarj.hierarchy', id ? { id } : {})
      if (!info) return { ok: false, error: '归属作业启动失败' }
      return { ok: true, taskId: info.id }
    }
  },
  {
    name: 'yarj.hierarchy-status',
    description: '查询各地图行政归属生成状态',
    usage: 'yarj.hierarchy-status',
    run: async () => hierarchyStatus()
  },
  {
    name: 'yarj.hierarchy-data',
    description: '读取市/县→省 归属数据（--id <mapId>；未生成返回 null）',
    usage: 'yarj.hierarchy-data --id GlobalMap_ADM0_2-pa9bem',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      if (!id) return { ok: false, error: '需要 --id' }
      return readHierarchy(id)
    }
  },
  {
    name: 'yarj.providers',
    description: '获取全部可用图源列表及当前激活图源',
    usage: 'yarj.providers',
    run: async () => listProviders()
  },
  {
    name: 'yarj.set-active-provider',
    description: '切换当前激活的图源 (--id <providerId>)',
    usage: 'yarj.set-active-provider --id google-hybrid',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      if (!id) return { ok: false, error: '需要 --id' }
      return setActiveProvider(id)
    }
  },
  {
    name: 'yarj.cache-stats',
    description: '获取瓦片本地磁盘缓存统计',
    usage: 'yarj.cache-stats',
    run: async () => getTileCacheStats()
  },
  {
    name: 'yarj.clear-cache',
    description: '清空瓦片本地磁盘缓存 ([--id <providerId>])',
    usage: 'yarj.clear-cache [--id google-hybrid]',
    run: async (ctx) => {
      const id = typeof ctx.named.id === 'string' && ctx.named.id ? ctx.named.id : undefined
      await clearTileCache(id)
      return { ok: true }
    }
  }
] satisfies CommandSpec[]

/** yarj 领域类型 — 不进 shared（渲染端 / 主进程共用）。 */

/** 图库根目录（v1 不做文件监视，watch 字段预留）。 */
export interface GalleryRoot {
  path: string
  watch?: boolean
}

/** 一个 MBTiles 地图文件配置。 */
export interface MapFile {
  /** 唯一 id（添加时自动生成：文件名 + 短哈希）。 */
  id: string
  /** mbtiles 绝对路径。 */
  path: string
  /** 打开该地图时的默认缩放级别（设置表格 ZoomLevel −/+ 调整）。 */
  defaultZoom: number
  enabled: boolean
}

/** 地图图源配置（在线切片服务或自定义图源）。 */
export interface MapProviderConfig {
  id: string
  name: string
  category:
    'google' | 'google-official' | 'carto' | 'arcgis' | 'osm' | 'tianditu' | 'custom' | 'mbtiles'
  type: 'raster' | 'vector'
  urlTemplate: string
  subdomains?: string[]
  minZoom?: number
  maxZoom?: number
  tileSize?: 256 | 512
  requireApiKey?: boolean
  attribution?: string
  ext?: string
}

export interface ProviderItem {
  id: string
  name: string
  category:
    'google' | 'google-official' | 'carto' | 'arcgis' | 'osm' | 'tianditu' | 'custom' | 'mbtiles'
  type: 'raster' | 'vector'
  maxZoom?: number
  minZoom?: number
  tileSize?: 256 | 512
  isCustom?: boolean
  isLocal?: boolean
  attribution?: string
}

/** 瓦片缓存统计。 */
export interface TileCacheStats {
  totalBytes: number
  tileCount: number
  maxBytes?: number
  maxMb?: number
  byProvider: Record<string, { bytes: number; count: number }>
}

/** 能力配置：~/.config/LinuxCockpit/yarj/config.json */
export interface YarjConfig {
  galleryRoots: GalleryRoot[]
  maps: MapFile[]
  /** 当前激活的图源 id（如 'google-hybrid', 'carto-dark', 'local:<mbtilesId>' 等）。 */
  activeProviderId?: string
  /** 谷歌地图 API Key */
  googleApiKey?: string
  /** 天地图 API Key */
  tiandituApiKey?: string
  /** 自定义在线瓦片 URL 模版 */
  customUrlTemplate?: string
  /** 自定义子域名列表 */
  customSubdomains?: string[]
  /** 是否开启本地瓦片磁盘缓存，默认 true */
  enableTileCache?: boolean
  /** 瓦片磁盘缓存上限大小（MB），默认 1024（1GB），0 表示不限制 */
  maxTileCacheMb?: number
  /** 地图注记语言偏好（'auto' | 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko' | 'local'） */
  mapLanguage?: string
  /** 照片点标记图层是否显示，默认 true */
  showPhotosLayer?: boolean
  /** 探索区域多边形图层是否显示，默认 true */
  showExploredLayer?: boolean
  /** 探索区域圆默认半径（米），可被照片 appendix.explored_radius_m 覆盖。 */
  exploredRadiusM: number
  /** 探索区域时空聚合粒度 ('fine' | 'standard' | 'trip' | 'coarse' | 'massive') */
  exploredGranularity?: ExploredGranularity
  /** 细节图层（省/市级边界等）显示的最低缩放级别，默认 4。 */
  detailMinZoom?: number
  /** ADM1（省级边界）回退缩放阈值（无 LOD 数据时），默认 4。 */
  adm1MinZoom?: number
  /** ADM2（县级边界）回退缩放阈值（无 LOD 数据时），默认 6。 */
  adm2MinZoom?: number
  /**
   * LOD 屏幕占比：某行政区经度跨度占视口宽度达到该比例时显示其边界（0–1）。
   * 默认 0.2（用户可指定）；值越小层级越早浮现。仅在有 LOD 数据时生效。
   */
  lodScreenFraction?: number
  /** 上次视图记忆（可选）。 */
  lastView?: {
    projection: 'globe' | 'mercator'
    center: [number, number]
    zoom: number
  } | null
}

/** LOD 要素：行政区包围盒（用于「区域占屏比例 → 显示层级」计算）。 */
export interface LodFeature {
  /** 行政级别：ADM1（省/州级）| ADM2（县/市级）。 */
  lvl: 'ADM1' | 'ADM2'
  /** 经度跨度（度）。 */
  w: number
  /** 纬度跨度（度）。 */
  h: number
  /** 区名（渲染端标签用）。 */
  name?: string
  /** 标签锚点 [lon, lat]（polylabel 多边形内点，保证不超出区域）。 */
  label?: [number, number]
}

/** 国家标签（adm0 层，LOD 同批收集）。 */
export interface LodCountry {
  name: string
  w: number
  h: number
  /** 标签锚点 [lon, lat]（polylabel 多边形内点，保证不超出区域）。无有效内点时不渲染。 */
  label?: [number, number]
}

/** LOD 缓存文件内容（~/.config/LinuxCockpit/yarj/lod/<mapId>.json）。 */
export interface LodData {
  generatedAt: string
  count: number
  /** shapeID → 包围盒。 */
  features: Record<string, LodFeature>
  /** 国家（adm0）标签锚点。 */
  countries: Record<string, LodCountry>
}

/** yarj.lod-status 返回值。 */
export interface LodStatus {
  mapId: string
  ready: boolean
  count: number
  generatedAt: string | null
  /** lod 作业是否正在运行。 */
  running: boolean
}

/** 地图文件 + 实时读出的 mbtiles 元数据（读失败时 error 非空）。 */
export interface MapFileInfo extends MapFile {
  minzoom?: number
  maxzoom?: number
  format?: string
  /** [minLon, minLat, maxLon, maxLat] */
  bounds?: [number, number, number, number]
  center?: [number, number]
  tileCount?: number
  /** 矢量瓦片的 source-layer id 列表（渲染端拼 style 用）。 */
  vectorLayers?: string[]
  error?: string
}

/** 元数据库中的一张照片（渲染端可序列化的精简视图）。 */
export interface Photo {
  id: number
  path: string
  root: string
  file_size?: number | null
  taken_at: string | null
  width: number | null
  height: number | null
  orientation?: number | null
  gps_lat: number | null
  gps_lon: number | null
  gps_alt: number | null
  camera_make: string | null
  camera_model: string | null
  lens_model?: string | null
  focal_length?: number | null
  f_number?: number | null
  exposure_time?: string | null
  iso?: number | null
  /** appendix 解析后的对象（tags, comment 等动态数据）。 */
  appendix: Record<string, unknown>
}

/** 地理编码结果（文字 -> 坐标） */
export interface GeocodeResult {
  formattedAddress: string
  lat: number
  lon: number
  placeId?: string
  provider: 'google' | 'nominatim'
}

/** 逆地理编码结果（坐标 -> 文字地址） */
export interface ReverseGeocodeResult {
  formattedAddress: string
  city?: string
  country?: string
  placeId?: string
  provider: 'google' | 'nominatim' | 'cache'
}

/** 一次扫描运行记录（scan_runs 表）。 */
export interface ScanRun {
  id: number
  root: string
  started_at: string
  finished_at: string | null
  status: 'running' | 'done' | 'cancelled' | 'error'
  total: number
  with_gps: number
  failed: number
  error: string | null
}

/** yarj.photos 查询条件。 */
export interface PhotoFilters {
  root?: string
  hasGps?: boolean
  /** ISO 时间下限。 */
  since?: string
  /** 模糊匹配路径 / 标签（appendix 内 tags）。 */
  q?: string
  /** [minLon, minLat, maxLon, maxLat] 经纬度框。 */
  bbox?: [number, number, number, number]
}

/** yarj.scan-status 返回的统计。 */
export interface ScanStats {
  photoCount: number
  withGps: number
  byRoot: { root: string; total: number; withGps: number }[]
  lastRuns: ScanRun[]
}

/** yarj 元数据 db 中的原始行（photos 表）。 */
export interface PhotoRow {
  id: number
  path: string
  root: string
  file_size: number
  mtime: number
  width: number | null
  height: number | null
  orientation: number | null
  taken_at: string | null
  camera_make: string | null
  camera_model: string | null
  lens_model: string | null
  focal_length: number | null
  f_number: number | null
  exposure_time: string | null
  iso: number | null
  gps_lat: number | null
  gps_lon: number | null
  gps_alt: number | null
  appendix: string
  scanned_at: string | null
}

/** 探索区域聚类粒度。 */
export type ExploredGranularity = 'fine' | 'standard' | 'trip' | 'coarse' | 'massive'

export interface GranularityConfig {
  id: ExploredGranularity
  nameKey: string
  defaultName: string
  /** 时间容差（小时） */
  timeWindowHours: number
  /** 最大连接距离（米）超出该距离不连为同一探索区 */
  maxLinkDistM: number
  /** 基础探索足迹半径（米） */
  baseRadiusM: number
}

export const GRANULARITY_PRESETS: Record<ExploredGranularity, GranularityConfig> = {
  fine: {
    id: 'fine',
    nameKey: 'yarj.granularity.fine',
    defaultName: '精细漫步 (45m 足迹 · 400m 连通)',
    timeWindowHours: 2,
    maxLinkDistM: 400,
    baseRadiusM: 45
  },
  standard: {
    id: 'standard',
    nameKey: 'yarj.granularity.standard',
    defaultName: '标准一日游 (60m 足迹 · 1.2km 连通)',
    timeWindowHours: 8,
    maxLinkDistM: 1200,
    baseRadiusM: 60
  },
  trip: {
    id: 'trip',
    nameKey: 'yarj.granularity.trip',
    defaultName: '全日自驾远足 (90m 足迹 · 4km 连通)',
    timeWindowHours: 24,
    maxLinkDistM: 4000,
    baseRadiusM: 90
  },
  coarse: {
    id: 'coarse',
    nameKey: 'yarj.granularity.coarse',
    defaultName: '跨日大区域 (140m 足迹 · 15km 连通)',
    timeWindowHours: 72,
    maxLinkDistM: 15000,
    baseRadiusM: 140
  },
  massive: {
    id: 'massive',
    nameKey: 'yarj.granularity.massive',
    defaultName: '广域探索 (200m 足迹 · 40km 连通)',
    timeWindowHours: 168,
    maxLinkDistM: 40000,
    baseRadiusM: 200
  }
}

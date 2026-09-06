/** yarj 领域类型 — 不进 shared（渲染端 / 主进程共用）。 */

/** 图库根目录（v1 不做文件监视，watch 字段预留）。 */
export interface GalleryRoot {
  path: string
  watch?: boolean
}

const VIDEO_EXT_SET = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.3gp'])

/** 检查文件路径是否为视频格式。 */
export function isVideoFile(pathOrExt: string): boolean {
  if (!pathOrExt) return false
  const dot = pathOrExt.lastIndexOf('.')
  if (dot === -1) return false
  return VIDEO_EXT_SET.has(pathOrExt.slice(dot).toLowerCase())
}

/** 获取图片/视频在 <img> 渲染时所用的缩略图 URL。 */
export function photoThumbUrl(filePath: string): string {
  if (!filePath) return ''
  return `cockpit-icon://${encodeURIComponent(filePath)}?thumb=1`
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
    | 'google'
    | 'google-official'
    | 'amap'
    | 'tencent'
    | 'carto'
    | 'arcgis'
    | 'osm'
    | 'tianditu'
    | 'custom'
    | 'mbtiles'
  type: 'raster' | 'vector'
  urlTemplate: string
  subdomains?: string[]
  minZoom?: number
  maxZoom?: number
  tileSize?: 256 | 512
  requireApiKey?: boolean
  attribution?: string
  ext?: string
  /** 坐标系类型：'wgs84' (标准无偏，如谷歌/OSM/天地图) | 'gcj02' (高德/腾讯火星加密偏移) */
  coordSystem?: 'wgs84' | 'gcj02' | 'bd09'
}

export interface ProviderItem {
  id: string
  name: string
  category:
    | 'google'
    | 'google-official'
    | 'amap'
    | 'tencent'
    | 'carto'
    | 'arcgis'
    | 'osm'
    | 'tianditu'
    | 'custom'
    | 'mbtiles'
  type: 'raster' | 'vector'
  maxZoom?: number
  minZoom?: number
  tileSize?: 256 | 512
  isCustom?: boolean
  isLocal?: boolean
  attribution?: string
  coordSystem?: 'wgs84' | 'gcj02' | 'bd09'
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
  /** 我的探索旅途漫游时空粒度记忆 ('fine' | 'standard' | 'trip' | 'coarse' | 'massive') */
  explorationGranularity?: ExploredGranularity
  /** 默认投影模式 ('globe' | 'mercator' | 'remember') */
  defaultProjection?: 'globe' | 'mercator' | 'remember'
  /** 初始视角规则 ('fit-all' | 'remember') */
  initialViewMode?: 'fit-all' | 'remember'
  /** 滚轮缩放速率 (0.5 - 2.0，默认 1.0) */
  zoomSpeed?: number
  /** 双击地图行为 ('zoom-in' | 'none') */
  doubleClickAction?: 'zoom-in' | 'none'
  /** 自动巡航单站驻留时间（秒，1.0 - 6.0，默认 2.2） */
  cruiseStayDurationSec?: number
  /** 相机飞行跃迁速度 ('smooth' | 'cinematic' | 'brisk' | 'instant') */
  flightSpeed?: 'smooth' | 'cinematic' | 'brisk' | 'instant'
  /** 漫游默认聚焦视距 ('focus3' | 'focus5' | 'focus8' | 'all') */
  defaultFocusRange?: 'focus3' | 'focus5' | 'focus8' | 'all'
  /** 进入漫游时是否自动开始播放 */
  autoPlayOnExplore?: boolean
  /** 巡航漫游时是否自动展开本站照片抽屉 */
  autoOpenDrawerOnCruise?: boolean
  /** 探索足迹填充不透明度 (0.2 - 0.9，默认 0.52) */
  footprintOpacity?: number
  /** 照片侧栏抽屉每次滑动加载数量 (20 / 30 / 50 / 100，默认 30) */
  drawerPageSize?: number
  /** 时空穿梭顶部 HUD 样式风格 ('prominent' | 'minimal' | 'compact') */
  timeShuttleStyle?: 'prominent' | 'minimal' | 'compact'
  /** 照片聚合密度 ('tight' | 'standard' | 'loose') */
  clusterDensity?: 'tight' | 'standard' | 'loose'
  /** 启动时自动增量扫描新照片 */
  autoScanOnStartup?: boolean
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
  /** 地图展示照片高级过滤规则。 */
  photoFilterRules?: PhotoFilterRule[]
  /** 运动航线目录列表（支持扫描 .gpx / .kml 等）。 */
  routeRoots?: GalleryRoot[]
  /** 运动航线图层是否显示，默认 true */
  showRoutesLayer?: boolean
  /** GPS 有效坐标解析优先级，默认 ['track', 'corrected', 'guess', 'db', 'exif'] */
  gpsPriority?: GpsPrioritySource[]
  /** GPS 智能猜测相邻照片最大距离（米），默认 10000（10公里） */
  gpsGuessMaxDistanceM?: number
  /** GPS 智能猜测相邻照片最大时间差（小时），默认 4 */
  gpsGuessMaxTimeHours?: number
  /** 是否开启航线轨迹平滑（消除 GPS 高频抖动），默认 true */
  routeSmoothing?: boolean
  /** 轨迹平滑窗口大小（点数，推荐 5，范围 3-15），默认 5 */
  routeSmoothingWindow?: number
  /** 是否开启相机跟随平滑缓冲（云台防抖阻尼），默认 true */
  routeCameraSmoothing?: boolean
  /** 航线播放期间其他航线显示模式 ('hide' 完全隐藏 | 'dim' 淡化 | 'show' 正常显示)，默认 'hide' */
  routePlaybackOtherRoutesMode?: 'hide' | 'dim' | 'show'
  /** 航线播放期间是否显示当前完整路线全貌，默认 true */
  routePlaybackShowFullRoute?: boolean
}

/** 过滤操作符 */
export type PhotoFilterOperator =
  | 'in'
  | 'not_in'
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'is_empty'
  | 'is_not_empty'
  | 'gt'
  | 'lt'

/** 地图照片高级筛选条件 */
export interface PhotoFilterRule {
  id: string
  enabled: boolean
  field: string
  operator: PhotoFilterOperator
  value: string
}

export const DEFAULT_YARJ_CONFIG: YarjConfig = {
  galleryRoots: [],
  routeRoots: [],
  maps: [],
  activeProviderId: 'google-hybrid',
  enableTileCache: true,
  maxTileCacheMb: 1024,
  mapLanguage: 'auto',
  showPhotosLayer: true,
  showExploredLayer: true,
  showRoutesLayer: true,
  routePlaybackOtherRoutesMode: 'hide',
  routePlaybackShowFullRoute: true,
  gpsPriority: ['track', 'corrected', 'guess', 'db', 'exif'],
  exploredRadiusM: 60,
  exploredGranularity: 'standard',
  explorationGranularity: 'standard',
  defaultProjection: 'remember',
  initialViewMode: 'fit-all',
  zoomSpeed: 1.0,
  doubleClickAction: 'zoom-in',
  cruiseStayDurationSec: 2.2,
  flightSpeed: 'smooth',
  defaultFocusRange: 'focus5',
  autoPlayOnExplore: false,
  autoOpenDrawerOnCruise: false,
  footprintOpacity: 0.52,
  drawerPageSize: 30,
  timeShuttleStyle: 'prominent',
  clusterDensity: 'standard',
  autoScanOnStartup: false,
  detailMinZoom: 4,
  adm1MinZoom: 4,
  adm2MinZoom: 6,
  lodScreenFraction: 0.2,
  lastView: null,
  photoFilterRules: [],
  gpsGuessMaxDistanceM: 10000,
  gpsGuessMaxTimeHours: 4,
  routeSmoothing: true,
  routeSmoothingWindow: 5,
  routeCameraSmoothing: true
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

export interface LodStatusRow {
  mapId: string
  ready: boolean
  count: number
  running: boolean
}

export interface HierarchyStatusRow {
  mapId: string
  ready: boolean
  count: number
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
  /** 文件 SHA-256 内容哈希。 */
  hash?: string | null
  /** appendix 解析后的对象（tags, comment, ai_generated 等动态数据）。 */
  appendix: PhotoAppendix
  /** 静态推算的 GPS 猜测（仅在没有真实 GPS 时推算并持久化）。 */
  gps_guess?: GuessedGps | null
  /** 时空速度合理性分析纠正的 GPS。 */
  gps_corrected?: CorrectedGps | null
  /** 基于运动航线 (GPX) 时序插值匹配的 GPS。 */
  gps_track?: TrackMatchedGps | null
}

/** 照片 AI 视觉分析元数据（存储在 appendix.ai_generated / appendix.aigenerated）。 */
export interface PhotoAiGenerated {
  type:
    | 'Document'
    | 'Blackboard'
    | 'Screenshot'
    | 'Portrait'
    | 'GroupPhoto'
    | 'Scenery'
    | 'Architecture'
    | 'Food'
    | 'Pet'
    | 'Object'
    | 'Interior'
    | 'Activity'
    | string
  brief: string
  ocr?: string
  model?: string
  judged_at?: string
}

/** 照片扩展元数据对象（存储在 SQLite photos.appendix JSON 列中）。 */
export interface PhotoAppendix {
  tags?: string[]
  comment?: string
  formatted_address?: string
  city?: string
  country?: string
  explored_radius_m?: number
  ai_generated?: PhotoAiGenerated
  aigenerated?: PhotoAiGenerated
  gps_guess?: GuessedGps
  gps_track?: TrackMatchedGps
  gps_source?: 'exif' | 'manual' | 'solidified_guess' | 'track' | string
  [key: string]: unknown
}

/** 照片 GPS 智能猜测元数据。 */
export interface GuessedGps {
  lat: number
  lon: number
  distanceM: number
  timeDiffSeconds: number
  prevPath: string
  nextPath: string
  prevTakenAt: string
  nextTakenAt: string
}

/** 照片 GPS 时空速度异常纠正元数据。 */
export interface CorrectedGps {
  lat: number
  lon: number
  /** 纠正原因（例如：速度异常漂移、跨区跳点） */
  reason: string
  /** 纠正前原始经度 */
  original_lon?: number | null
  /** 纠正前原始纬度 */
  original_lat?: number | null
  /** 漂移距离 (km) */
  drift_distance_km?: number
  /** 计算得出时速 (km/h) */
  speed_kmh?: number
  /** 参考前序锚点路径 */
  prevPath?: string
  /** 参考后序锚点路径 */
  nextPath?: string
  /** 纠正时间戳 */
  corrected_at: string
}

/** 基于运动轨迹 (GPX) 匹配的时空插值 GPS 元数据。 */
export interface TrackMatchedGps {
  lat: number
  lon: number
  alt?: number | null
  routeId: string
  routeName: string
  trackPointTime: string
  timeOffsetSeconds: number
  matchedAt: string
}

/** 运动轨迹单个采样点。 */
export interface RoutePoint {
  lat: number
  lon: number
  ele?: number | null
  time?: string | null
  distFromStartM: number
  speedKmh?: number | null
  hr?: number | null
  cadence?: number | null
}

/** 运动轨迹按公里划分的分段数据（splits）。 */
export interface RouteSplit {
  km: number
  durationSec: number
  avgSpeedKmh: number
  elevationGainM?: number
}

/** 心率五区间持续时间（秒） */
export interface RouteHeartRateZones {
  warmUpDurationSec?: number | null
  fatBurningDurationSec?: number | null
  aerobicDurationSec?: number | null
  anaerobicDurationSec?: number | null
  extremeDurationSec?: number | null
}

/** 深度扩展运动生理与设备指标 */
export interface RouteExtraMetrics {
  steps?: number | null
  avgCadence?: number | null
  maxCadence?: number | null
  avgStrideCm?: number | null
  avgPaceSec?: number | null
  maxPaceSec?: number | null
  minPaceSec?: number | null
  minHr?: number | null
  vo2Max?: number | null
  trainLoad?: number | null
  trainEffect?: number | null
  recoverTimeHours?: number | null
  deviceType?: string | null
  deviceId?: string | null
  hrZones?: RouteHeartRateZones | null
  rawRecord?: Record<string, unknown> | null
}

/** 运动航线 / 轨迹完整对象。 */
export interface Route {
  id: string
  path: string
  name: string
  desc?: string | null
  activityType?: string
  startTime: string | null
  endTime: string | null
  durationSec: number
  movingDurationSec: number
  totalDistanceM: number
  avgSpeedKmh: number
  maxSpeedKmh: number
  calories?: number | null
  elevationGainM?: number | null
  elevationLossM?: number | null
  minEle?: number | null
  maxEle?: number | null
  avgHr?: number | null
  maxHr?: number | null
  minHr?: number | null
  avgCadence?: number | null
  maxCadence?: number | null
  steps?: number | null
  avgStrideCm?: number | null
  avgPaceSec?: number | null
  maxPaceSec?: number | null
  minPaceSec?: number | null
  vo2Max?: number | null
  trainLoad?: number | null
  trainEffect?: number | null
  recoverTimeHours?: number | null
  deviceType?: string | null
  deviceId?: string | null
  hrZones?: RouteHeartRateZones | null
  extraMetrics?: RouteExtraMetrics | null
  bounds: [number, number, number, number]
  pointCount: number
  geojson: string
  splits?: RouteSplit[]
  createdAt?: string
  updatedAt?: string
}

/** GPS 优先级来源类型 */
export type GpsPrioritySource = 'track' | 'corrected' | 'guess' | 'db' | 'exif'

export const DEFAULT_GPS_PRIORITY: GpsPrioritySource[] = [
  'track',
  'corrected',
  'guess',
  'db',
  'exif'
]

export type GpsSourceType = 'track' | 'corrected' | 'guess' | 'db' | 'exif'

export interface ResolvedPhotoGps {
  lat: number
  lon: number
  source: GpsSourceType
}

/**
 * 按照指定优先级解析照片最终使用的有效坐标：
 * 默认顺序：track > corrected > guess > db > exif
 */
export function resolvePhotoGps(
  photo: Photo | null | undefined,
  priorityOrder?: GpsPrioritySource[]
): ResolvedPhotoGps | null {
  if (!photo) return null
  const order = priorityOrder && priorityOrder.length ? priorityOrder : DEFAULT_GPS_PRIORITY

  for (const src of order) {
    if (src === 'track') {
      if (
        photo.gps_track &&
        photo.gps_track.lat != null &&
        photo.gps_track.lon != null &&
        Number.isFinite(photo.gps_track.lat) &&
        Number.isFinite(photo.gps_track.lon)
      ) {
        return {
          lat: photo.gps_track.lat,
          lon: photo.gps_track.lon,
          source: 'track'
        }
      }
    } else if (src === 'corrected') {
      if (
        photo.gps_corrected &&
        photo.gps_corrected.lat != null &&
        photo.gps_corrected.lon != null &&
        Number.isFinite(photo.gps_corrected.lat) &&
        Number.isFinite(photo.gps_corrected.lon)
      ) {
        return {
          lat: photo.gps_corrected.lat,
          lon: photo.gps_corrected.lon,
          source: 'corrected'
        }
      }
    } else if (src === 'guess') {
      if (
        photo.gps_guess &&
        photo.gps_guess.lat != null &&
        photo.gps_guess.lon != null &&
        Number.isFinite(photo.gps_guess.lat) &&
        Number.isFinite(photo.gps_guess.lon)
      ) {
        return {
          lat: photo.gps_guess.lat,
          lon: photo.gps_guess.lon,
          source: 'guess'
        }
      }
    } else if (src === 'db') {
      if (
        photo.gps_lat != null &&
        photo.gps_lon != null &&
        Number.isFinite(photo.gps_lat) &&
        Number.isFinite(photo.gps_lon)
      ) {
        return {
          lat: photo.gps_lat,
          lon: photo.gps_lon,
          source: 'db'
        }
      }
    } else if (src === 'exif') {
      const exifGps = photo.appendix?.exif_gps as { lat?: number; lon?: number } | undefined
      if (
        exifGps &&
        exifGps.lat != null &&
        exifGps.lon != null &&
        Number.isFinite(exifGps.lat) &&
        Number.isFinite(exifGps.lon)
      ) {
        return {
          lat: exifGps.lat,
          lon: exifGps.lon,
          source: 'exif'
        }
      }
    }
  }

  return null
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
  /** 是否按有 GPS 优先排序。 */
  orderGpsFirst?: boolean
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
  hash: string | null
  appendix: string
  gps_guess?: string | null
  gps_corrected?: string | null
  gps_track?: string | null
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

/** 智能推测的交通方式。 */
export type TransportMode = 'plane' | 'train' | 'car' | 'walk' | 'ship' | 'stay'

export interface TransportModeMeta {
  mode: TransportMode
  nameKey: string
  defaultName: string
  icon: string
  color: string
}

/** 「我的探索」单个旅途阶段（站点）。 */
export interface JourneyStage {
  id: string
  index: number
  title: string
  photos: Photo[]
  center: [number, number]
  bounds: [number, number, number, number]
  startTime: number | null
  endTime: number | null
  formattedTimeRange: string
  locationName: string
}

/** 「我的探索」相邻两个阶段之间的航段 / 跃迁。 */
export interface JourneyLeg {
  id: string
  fromIndex: number
  toIndex: number
  fromStage: JourneyStage
  toStage: JourneyStage
  distanceM: number
  durationMs: number | null
  speedKmH: number | null
  mode: TransportMode
  modeMeta: TransportModeMeta
  /** 大圆航线 / 平滑曲线采样点坐标集合 [[lon, lat], ...] */
  arcCoordinates: [number, number][]
}

/** 「我的探索」完整旅途数据结构。 */
export interface JourneyData {
  stages: JourneyStage[]
  legs: JourneyLeg[]
  totalDistanceM: number
  totalPhotos: number
  startTime: number | null
  endTime: number | null
}

export type { GeotagPreviewResult, GeotagPreviewItem } from './route-geotag'

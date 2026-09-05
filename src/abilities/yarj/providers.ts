/**
 * Map Providers — 地图图源预设定义与 URL 模版格式化引擎。
 */
import type { MapProviderConfig } from './types'

export const DEFAULT_GOOGLE_API_KEY = 'AIzaSyASJjzjKnyusU1FWFCB25F3NIIrp3S-1kE'

export const BUILTIN_PROVIDERS: MapProviderConfig[] = [
  {
    id: 'google-hybrid',
    name: 'Google 卫星混合图',
    category: 'google',
    type: 'raster',
    urlTemplate:
      'https://mt{s}.google.com/vt/lyrs=y&hl={lang}&gl=CN&scale=2&x={x}&y={y}&z={z}&key={apiKey}',
    subdomains: ['0', '1', '2', '3'],
    minZoom: 0,
    maxZoom: 20,
    tileSize: 256,
    ext: 'jpg',
    coordSystem: 'gcj02',
    attribution: '© Google'
  },
  {
    id: 'google-sat',
    name: 'Google 纯卫星图',
    category: 'google',
    type: 'raster',
    urlTemplate:
      'https://mt{s}.google.com/vt/lyrs=s&hl={lang}&gl=CN&scale=2&x={x}&y={y}&z={z}&key={apiKey}',
    subdomains: ['0', '1', '2', '3'],
    minZoom: 0,
    maxZoom: 20,
    tileSize: 256,
    ext: 'jpg',
    coordSystem: 'gcj02',
    attribution: '© Google'
  },
  {
    id: 'google-roads',
    name: 'Google 街道图',
    category: 'google',
    type: 'raster',
    urlTemplate:
      'https://mt{s}.google.com/vt/lyrs=m&hl={lang}&gl=CN&scale=2&x={x}&y={y}&z={z}&key={apiKey}',
    subdomains: ['0', '1', '2', '3'],
    minZoom: 0,
    maxZoom: 20,
    tileSize: 256,
    ext: 'png',
    coordSystem: 'gcj02',
    attribution: '© Google'
  },
  {
    id: 'google-terrain',
    name: 'Google 地形图',
    category: 'google',
    type: 'raster',
    urlTemplate:
      'https://mt{s}.google.com/vt/lyrs=p&hl={lang}&gl=CN&scale=2&x={x}&y={y}&z={z}&key={apiKey}',
    subdomains: ['0', '1', '2', '3'],
    minZoom: 0,
    maxZoom: 20,
    tileSize: 256,
    ext: 'png',
    coordSystem: 'gcj02',
    attribution: '© Google'
  },
  {
    id: 'amap-roads',
    name: '高德 街道矢量图 (普通免翻直连)',
    category: 'amap',
    type: 'raster',
    urlTemplate:
      'https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}',
    subdomains: ['1', '2', '3', '4'],
    minZoom: 3,
    maxZoom: 18,
    tileSize: 256,
    ext: 'png',
    coordSystem: 'gcj02',
    attribution: '© 高德地图 AutoNavi (GCJ-02 国测局火星坐标系)'
  },
  {
    id: 'amap-sat',
    name: '高德 卫星影像 (普通免翻直连)',
    category: 'amap',
    type: 'raster',
    urlTemplate: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    subdomains: ['1', '2', '3', '4'],
    minZoom: 3,
    maxZoom: 18,
    tileSize: 256,
    ext: 'jpg',
    coordSystem: 'gcj02',
    attribution: '© 高德地图 AutoNavi (GCJ-02 国测局火星坐标系)'
  },
  {
    id: 'tencent-roads',
    name: '腾讯 街道图 (普通免翻直连)',
    category: 'tencent',
    type: 'raster',
    urlTemplate: 'https://rt{s}.map.gtimg.com/tile?z={z}&x={x}&y={-y}&styleid=1&version=297',
    subdomains: ['0', '1', '2', '3'],
    minZoom: 3,
    maxZoom: 18,
    tileSize: 256,
    ext: 'png',
    coordSystem: 'gcj02',
    attribution: '© 腾讯地图 Tencent Map (GCJ-02 国测局火星坐标系)'
  },
  {
    id: 'carto-dark',
    name: 'CartoDB 暗黑极简',
    category: 'carto',
    type: 'raster',
    urlTemplate: 'https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png',
    subdomains: ['a', 'b', 'c', 'd'],
    minZoom: 0,
    maxZoom: 20,
    tileSize: 256,
    ext: 'png',
    coordSystem: 'wgs84',
    attribution: '© CARTO © OpenStreetMap'
  },
  {
    id: 'carto-voyager',
    name: 'CartoDB 彩色街区',
    category: 'carto',
    type: 'raster',
    urlTemplate: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    subdomains: ['a', 'b', 'c', 'd'],
    minZoom: 0,
    maxZoom: 20,
    tileSize: 256,
    ext: 'png',
    coordSystem: 'wgs84',
    attribution: '© CARTO © OpenStreetMap'
  },
  {
    id: 'arcgis-sat',
    name: 'ArcGIS 全球高清卫星',
    category: 'arcgis',
    type: 'raster',
    urlTemplate:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    ext: 'jpg',
    coordSystem: 'wgs84',
    attribution: '© Esri, Maxar, Earthstar Geographics'
  },
  {
    id: 'osm',
    name: 'OpenStreetMap 标准',
    category: 'osm',
    type: 'raster',
    urlTemplate: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c'],
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    ext: 'png',
    coordSystem: 'wgs84',
    attribution: '© OpenStreetMap contributors'
  },
  {
    id: 'opentopo',
    name: 'OpenTopo 等高线地形图',
    category: 'osm',
    type: 'raster',
    urlTemplate: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c'],
    minZoom: 0,
    maxZoom: 17,
    tileSize: 256,
    ext: 'png',
    coordSystem: 'wgs84',
    attribution: '© OpenTopoMap © OpenStreetMap'
  },
  {
    id: 'tianditu-img',
    name: '天地图 卫星影像 (WGS-84/CGCS2000)',
    category: 'tianditu',
    type: 'raster',
    urlTemplate:
      'https://t{s}.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={apiKey}',
    subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'],
    minZoom: 0,
    maxZoom: 18,
    tileSize: 256,
    ext: 'jpg',
    requireApiKey: true,
    coordSystem: 'wgs84',
    attribution: '© 天地图 GS(2024)0001号'
  },
  {
    id: 'tianditu-vec',
    name: '天地图 街道矢量 (WGS-84/CGCS2000)',
    category: 'tianditu',
    type: 'raster',
    urlTemplate:
      'https://t{s}.tianditu.gov.cn/vec_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={apiKey}',
    subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'],
    minZoom: 0,
    maxZoom: 18,
    tileSize: 256,
    ext: 'png',
    requireApiKey: true,
    coordSystem: 'wgs84',
    attribution: '© 天地图 GS(2024)0001号'
  },
  {
    id: 'google-official-hybrid',
    name: 'Google 官方卫星混合 (Map Tiles API · 计费)',
    category: 'google-official',
    type: 'raster',
    urlTemplate: 'https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}',
    minZoom: 0,
    maxZoom: 22,
    tileSize: 512,
    ext: 'jpg',
    coordSystem: 'wgs84',
    attribution: '© Google Maps Platform'
  },
  {
    id: 'google-official-roadmap',
    name: 'Google 官方街道图 (Map Tiles API · 计费)',
    category: 'google-official',
    type: 'raster',
    urlTemplate: 'https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}',
    minZoom: 0,
    maxZoom: 22,
    tileSize: 512,
    ext: 'png',
    coordSystem: 'wgs84',
    attribution: '© Google Maps Platform'
  },
  {
    id: 'google-official-satellite',
    name: 'Google 官方纯卫星 (Map Tiles API · 计费)',
    category: 'google-official',
    type: 'raster',
    urlTemplate: 'https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}',
    minZoom: 0,
    maxZoom: 22,
    tileSize: 512,
    ext: 'jpg',
    coordSystem: 'wgs84',
    attribution: '© Google Maps Platform'
  },
  {
    id: 'google-official-terrain',
    name: 'Google 官方地形图 (Map Tiles API · 计费)',
    category: 'google-official',
    type: 'raster',
    urlTemplate: 'https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}',
    minZoom: 0,
    maxZoom: 22,
    tileSize: 512,
    ext: 'png',
    coordSystem: 'wgs84',
    attribution: '© Google Maps Platform'
  },
  {
    id: 'custom',
    name: '自定义在线瓦片',
    category: 'custom',
    type: 'raster',
    urlTemplate: '',
    subdomains: ['0', '1', '2', '3'],
    minZoom: 0,
    maxZoom: 20,
    tileSize: 256,
    coordSystem: 'wgs84',
    ext: 'png'
  }
]

export interface FormatTileOptions {
  subdomains?: string[]
  apiKey?: string
  isRetina?: boolean
  lang?: string
}

/**
 * 解析地图注记语言代码。
 * 支持 'auto'（跟随系统/应用），'zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'local' 等。
 */
export function resolveMapLanguage(mapLanguage?: string, appLang?: string): string {
  if (mapLanguage && mapLanguage !== 'auto') {
    if (mapLanguage === 'local') return ''
    return mapLanguage
  }
  const main = (appLang ?? 'zh').toLowerCase()
  if (main.startsWith('zh')) return 'zh-CN'
  if (main.startsWith('ja')) return 'ja'
  if (main.startsWith('ko')) return 'ko'
  if (main.startsWith('ru')) return 'ru'
  if (main.startsWith('fr')) return 'fr'
  if (main.startsWith('de')) return 'de'
  if (main.startsWith('es')) return 'es'
  return 'en'
}

/**
 * 将任意地图厂商的模版 URL 格式化为最终瓦片请求。
 * 支持占位符：{z}, {x}, {y}, {-y}, {s}, {r}, {lang}, {apiKey}
 */
export function formatTileUrl(
  template: string,
  z: number,
  x: number,
  y: number,
  options: FormatTileOptions = {}
): string {
  const subs = options.subdomains?.length ? options.subdomains : ['0', '1', '2', '3']
  const s = subs[Math.abs(x + y) % subs.length]
  const tmsY = (1 << z) - 1 - y
  const r = options.isRetina ? '@2x' : ''
  const key = options.apiKey ?? ''
  const lang = options.lang ?? 'zh-CN'

  let url = template
    .replaceAll('{z}', String(z))
    .replaceAll('{x}', String(x))
    .replaceAll('{y}', String(y))
    .replaceAll('{-y}', String(tmsY))
    .replaceAll('{s}', s)
    .replaceAll('{r}', r)
    .replaceAll('{lang}', lang)
    .replaceAll('{apiKey}', key)

  // 如果模版带 &key={apiKey} 但未给 key，清理掉空的 key 查询参数
  if (!key) {
    url = url.replace(/([?&])(?:key|tk)=&?/g, '$1').replace(/[?&]$/, '')
  }
  // 如果语言为空，清理掉空的 hl 查询参数
  if (!lang) {
    url = url.replace(/([?&])(?:hl)=&?/g, '$1').replace(/[?&]$/, '')
  }
  return url
}

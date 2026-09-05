import { defineAsyncComponent } from 'vue'
import type { Ability } from '../../main/ui/ability'
import YarjContainer from './YarjContainer.vue'

// 在应用启动空闲时预热加载 View.vue 及其依赖（如 maplibre-gl），
// 进一步减少用户点击打开旅行记录时的实际载入时间。
if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
  window.requestIdleCallback(
    () => {
      import('./View.vue')
    },
    { timeout: 4000 }
  )
}

/**
 * Yet Another Recorded Journey — 照片足迹地图。
 * EXIF GPS → 地图打点 + 探索区域；MBTiles 本地地图（globe / 平面）。
 */
export default {
  id: 'yarj',
  name: '旅行记录',
  icon: 'default/map',
  category: '旅行',
  keepAlive: true,
  component: YarjContainer,
  settings: [
    {
      key: 'yarj',
      label: '旅行记录',
      icon: 'mdi-map-marker-path',
      description: '图库目录与 MBTiles 地图文件配置',
      keywords: ['旅行', '足迹', '地图', '照片', 'EXIF', 'GPS', 'mbtiles', '图库'],
      items: [
        {
          key: 'gallery',
          label: '图库目录',
          icon: 'mdi-folder-multiple-image',
          description: '添加或移除照片图库目录（扫描元数据的数据源）',
          keywords: ['目录', '图库', '照片', '扫描', '根目录'],
          fullWidth: true,
          component: defineAsyncComponent(() => import('./components/GalleryFoldersSection.vue'))
        },
        {
          key: 'routes',
          label: '运动航线目录',
          icon: 'mdi-routes',
          description: '配置运动轨迹目录（GPX/KML）或手动导入文件，构建航线与足迹走廊',
          keywords: ['运动', '航线', '轨迹', 'GPX', 'kml', '跑步', '骑行', '健身'],
          fullWidth: true,
          component: defineAsyncComponent(() => import('./components/RouteFoldersSection.vue'))
        },
        {
          key: 'maps',
          label: '地图图源与配置',
          icon: 'mdi-map-legend',
          description:
            '配置在线底图服务（Google / CartoDB / ArcGIS / 天地图）、API 密钥、瓦片缓存与离线 MBTiles',
          keywords: [
            '地图',
            '图源',
            'Google',
            '谷歌',
            '卫星图',
            'MBTiles',
            'mbtiles',
            '缓存',
            '瓦片',
            'Key'
          ],
          fullWidth: true,
          component: defineAsyncComponent(() => import('./components/MapSourceSection.vue'))
        },
        {
          key: 'preferences',
          label: '偏好与行为设置',
          icon: 'mdi-tune-vertical',
          description:
            '配置地图投影、巡航漫游速度、战争迷雾足迹半径、照片高级筛选规则 (Filter) 与轨迹平滑防抖',
          keywords: [
            '偏好',
            '设置',
            '投影',
            '地球仪',
            '巡航',
            '漫游',
            '速度',
            '足迹',
            '半径',
            '迷雾',
            '性能',
            '抽屉',
            'filter',
            'filters',
            '规则',
            '筛选',
            '过滤',
            '平滑',
            '防抖',
            '抖动',
            'smooth',
            'smoothing'
          ],
          fullWidth: true,
          component: defineAsyncComponent(() => import('./components/MapPreferencesSection.vue'))
        }
      ]
    }
  ]
} satisfies Ability

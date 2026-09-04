import { defineAsyncComponent } from 'vue'
import type { Ability } from '../../main/ui/ability'

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
  component: defineAsyncComponent(() => import('./View.vue')),
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
          description: '配置地图投影、巡航漫游速度、战争迷雾足迹半径、抽屉滑动加载与性能调优',
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
            '抽屉'
          ],
          fullWidth: true,
          component: defineAsyncComponent(() => import('./components/MapPreferencesSection.vue'))
        }
      ]
    }
  ]
} satisfies Ability

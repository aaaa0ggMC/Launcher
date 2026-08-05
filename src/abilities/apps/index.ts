import { defineAsyncComponent } from 'vue'
import type { Ability } from '../types'
import './entry-actions'

export default {
  id: 'apps',
  name: '应用',
  icon: 'gi:apps',
  category: '系统',
  keepAlive: false,
  component: defineAsyncComponent(() => import('./View.vue')),
  settings: [
    {
      key: 'apps',
      label: '应用',
      icon: 'mdi-folder-search-outline',
      description: '应用注册表的扫描目录',
      keywords: ['应用', 'apps', '扫描', '注册表'],
      items: [
        {
          key: 'search-roots',
          label: '搜索目录',
          icon: 'mdi-folder-search-outline',
          description: '添加或移除应用扫描根目录',
          keywords: ['目录', '扫描', '搜索', 'apps.json', '根目录', 'watch'],
          fullWidth: true,
          component: defineAsyncComponent(() => import('./SearchRootsSection.vue'))
        }
      ]
    }
  ]
} satisfies Ability

import { defineAsyncComponent } from 'vue'
import type { Ability } from '../../main/ui/ability'

export default {
  id: 'dashboard',
  name: '总览',
  icon: 'gi:dashboard',
  category: '总览',
  component: defineAsyncComponent(() => import('./View.vue')),
  settings: [
    {
      key: 'dashboard',
      label: '总览',
      icon: 'mdi-view-dashboard-outline',
      description: '总览页卡片排版',
      keywords: ['总览', '排版', '布局', '卡片'],
      items: [
        {
          key: 'reset-layout',
          label: '总览排版',
          icon: 'mdi-view-dashboard-outline',
          description: '重置总览页卡片排版',
          keywords: ['重置', '排版', '布局', '卡片', '总览'],
          component: defineAsyncComponent(() => import('./items/DashboardSection.vue'))
        }
      ]
    }
  ]
} satisfies Ability

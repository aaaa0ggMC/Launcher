import { defineAsyncComponent } from 'vue'
import type { Ability } from '../types'

export default {
  id: 'apps',
  name: '应用',
  icon: 'gi:apps',
  category: '系统',
  keepAlive: false,
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies Ability

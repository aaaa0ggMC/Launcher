import { defineAsyncComponent } from 'vue'
import type { Ability } from '../types'

export default {
  id: 'logs',
  name: '日志',
  icon: 'gi:logs',
  category: '系统',
  keepAlive: false,
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies Ability

import { defineAsyncComponent } from 'vue'
import type { Ability } from '../types'

export default {
  id: 'autostart',
  name: '启动项',
  icon: '🚀',
  category: '系统',
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies Ability

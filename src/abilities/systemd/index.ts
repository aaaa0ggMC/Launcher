import { defineAsyncComponent } from 'vue'
import type { Ability } from '../types'

export default {
  id: 'systemd',
  name: '服务',
  icon: 'gi:systemd',
  category: '系统',
  keepAlive: false,
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies Ability

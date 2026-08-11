import { defineAsyncComponent } from 'vue'
import type { Ability } from '../../main/ui/ability'

export default {
  id: 'systemd',
  name: '服务',
  icon: 'gi:systemd',
  category: '系统',
  platforms: ['linux'],
  keepAlive: false,
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies Ability

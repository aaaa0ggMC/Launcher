import { defineAsyncComponent } from 'vue'
import type { Ability } from '../../main/ui/ability'

export default {
  id: 'autostart',
  name: '启动项',
  icon: 'gi:autostart',
  category: '系统',
  platforms: ['linux'],
  keepAlive: false,
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies Ability

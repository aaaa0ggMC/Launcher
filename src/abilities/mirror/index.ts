import { defineAsyncComponent } from 'vue'
import type { Ability } from '../types'

export default {
  id: 'mirror',
  name: '软件源',
  icon: 'gi:mirror',
  category: '系统',
  platforms: ['linux'],
  keepAlive: false,
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies Ability

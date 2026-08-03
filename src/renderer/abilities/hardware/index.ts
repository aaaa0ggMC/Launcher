import { defineAsyncComponent } from 'vue'
import type { Ability } from '../types'

export default {
  id: 'hardware',
  name: '硬件',
  icon: '🖥️',
  category: '硬件',
  keepAlive: false,
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies Ability

import { defineAsyncComponent } from 'vue'
import type { Ability } from '../types'

export default {
  id: 'apps',
  name: '应用',
  icon: '🗂️',
  category: '系统',
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies Ability

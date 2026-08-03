import { defineAsyncComponent } from 'vue'
import type { Ability } from '../types'

export default {
  id: 'display',
  name: '显示与壁纸',
  icon: '🖼️',
  category: '外观',
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies Ability

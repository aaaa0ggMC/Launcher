import { defineAsyncComponent } from 'vue'
import type { Ability } from '../types'

export default {
  id: 'ft',
  name: '傅里叶变换',
  icon: 'gi:ft',
  category: '杂项',
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies Ability

import { defineAsyncComponent } from 'vue'
import type { Ability } from '../types'

export default {
  id: 'dashboard',
  name: '总览',
  icon: '📊',
  category: '总览',
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies Ability

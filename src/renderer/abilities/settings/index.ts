import { defineAsyncComponent } from 'vue'
import type { Ability } from '../types'

export default {
  id: 'settings',
  name: '设置',
  icon: '⚙️',
  category: '系统',
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies Ability

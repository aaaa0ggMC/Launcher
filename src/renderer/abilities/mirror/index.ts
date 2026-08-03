import { defineAsyncComponent } from 'vue'
import type { Ability } from '../types'

export default {
  id: 'mirror',
  name: '软件源',
  icon: '🪞',
  category: '系统',
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies Ability

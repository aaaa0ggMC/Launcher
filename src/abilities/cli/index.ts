import { defineAsyncComponent } from 'vue'
import type { Ability } from '../../main/ui/ability'

export default {
  id: 'cli',
  name: '命令行',
  icon: 'gi:cli',
  category: '工具',
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies Ability

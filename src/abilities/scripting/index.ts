import { defineAsyncComponent } from 'vue'
import type { Ability } from '../../main/ui/ability'

export default {
  id: 'scripting',
  name: '脚本工作流',
  icon: 'gi:scripting',
  category: '开发',
  keepAlive: true,
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies Ability

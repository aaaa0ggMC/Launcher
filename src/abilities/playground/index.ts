import { defineAsyncComponent } from 'vue'
import type { Ability } from '../types'

/**
 * Provider Playground ability — an API request playground with template-driven
 * variable interpolation and response transforms (migrated from the standalone
 * ProviderPlayground project). Nearly all frontend; only import/export of
 * config goes through backend commands.
 */
export default {
  id: 'playground',
  name: '接口调试',
  icon: 'gi:playground',
  category: '工具',
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies Ability

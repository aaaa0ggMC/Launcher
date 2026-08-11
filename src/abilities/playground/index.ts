import { defineAsyncComponent, markRaw } from 'vue'
import type { Ability } from '../../main/ui/ability'
import { registerBtView } from '../../main/ui/bt-views'
import BtResponseView from './components/BtResponseView.vue'

/**
 * Provider Playground ability — an API request playground with template-driven
 * variable interpolation and response transforms (migrated from the standalone
 * ProviderPlayground project). Nearly all frontend; only import/export of
 * config goes through backend commands.
 *
 * The `pg-task` background job pushes structured `TransformResult` blocks with
 * `view: 'response'`; this registers the view that renders them in the global
 * background-task panel (see components/BtResponseView.vue).
 */
registerBtView('response', () => ({ component: markRaw(BtResponseView) }))

export default {
  id: 'playground',
  name: '接口调试',
  icon: 'gi:playground',
  category: '工具',
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies Ability

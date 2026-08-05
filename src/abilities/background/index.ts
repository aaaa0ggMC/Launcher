import type { Ability } from '../types'

/**
 * Background tasks ability — backend-only (no UI page). It exposes the
 * `background.*` commands that wrap the framework service
 * (`src/main/process/background-tasks.ts`). The global Background Tasks panel
 * (a shell component in App.vue) drives it; this ability stays hidden from the
 * sidebar but any ability can also start tasks programmatically.
 */
export default {
  id: 'background',
  name: '后台任务',
  icon: 'gi:background',
  category: '系统'
} satisfies Ability

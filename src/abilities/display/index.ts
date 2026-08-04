import type { Ability } from '../types'

/**
 * Display ability — backend-only (壁纸 / 显示输出). No UI page: it registers
 * the `display.*` commands via the main-process loader and stays hidden from
 * the sidebar (not listed in config/abilities.yaml).
 */
export default {
  id: 'display',
  name: '显示',
  icon: 'gi:display',
  category: '系统'
} satisfies Ability

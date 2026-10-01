import type { Ability } from '../../main/ui/ability'

/**
 * UI inspector — backend-only (no page). `ui.*` commands let scripts / AI read
 * the main window as an accessibility snapshot with refs, click / type / scroll
 * with trusted input, navigate pages and take privacy-masked screenshots.
 * See docs/agent-access-design.md §4.
 */
export default {
  id: 'inspector',
  name: 'UI 检查器',
  icon: 'default/search/padding',
  category: '系统'
} satisfies Ability

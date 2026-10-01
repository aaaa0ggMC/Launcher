import type { Ability } from '../../main/ui/ability'

/**
 * Privacy ability — backend-only (no page). Exposes the `privacy.*` commands
 * over the framework privacy SDK (`src/main/process/privacy.ts`): list scopes,
 * request clearance (agents), inspect current grants. Granting is NOT a
 * command — only the consent window can decide (docs/agent-access-design.md).
 */
export default {
  id: 'privacy',
  name: '隐私',
  icon: 'default/lock/padding',
  category: '系统'
} satisfies Ability

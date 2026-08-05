import { registerEntryActionProvider } from '@ui/entry-actions'

/**
 * Apps ability → entry action provider.
 *
 * Maps every entry's clustered `actions` (停止 / 重启 / 后台运行 / ...) into
 * the generic entry-action registry, so the quick-launch context menu and the
 * app card buttons share one source of truth. The entry's main "启动" is
 * injected by the shell itself (kind 'launch'), not here.
 */
registerEntryActionProvider(({ entry }) =>
  Object.entries(entry.actions ?? {}).map(([id, action]) => ({
    kind: 'action' as const,
    id,
    label: action.name || id,
    icon: action.icon,
    action
  }))
)

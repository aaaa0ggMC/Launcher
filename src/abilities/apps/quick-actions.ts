import type { AppEntry } from './types'
import { registerQuickActionProvider, type QuickAction } from '@ui/quick-actions'

/**
 * Apps ability → quick-action provider.
 *
 * Contributes one searchable quick action per app entry (the main launch) plus
 * its clustered actions as `children` (surfaced in the right-click menu). The
 * shell never interprets app shapes — it just activates the apps ability with
 * the opaque `target`; the apps page owns the confirm/transformer launch flow.
 */
registerQuickActionProvider(async () => {
  const res = (await window.cockpit.command('apps.list')) as {
    apps?: Record<string, AppEntry>
  } | null
  const out: QuickAction[] = []
  for (const [id, entry] of Object.entries(res?.apps ?? {})) {
    if (!entry || entry.missing) continue
    const root = entry.root ?? ''
    const base = { root, id }
    const children: QuickAction[] = Object.entries(entry.actions ?? {}).map(([aid, act]) => ({
      id: `apps:${id}:${aid}`,
      ability: 'apps',
      label: act.name || aid,
      description: act.description,
      icon: act.icon,
      risk: act.risk ?? entry.security?.risk ?? 'low',
      target: { ...base, actionId: aid }
    }))
    out.push({
      id: `apps:${id}`,
      ability: 'apps',
      label: entry.name,
      description: entry.description ?? entry.path,
      icon: entry.icon,
      risk: entry.security?.risk ?? 'low',
      target: base,
      children
    })
  }
  return out
})

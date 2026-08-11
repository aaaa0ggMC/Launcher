import type { AppEntry } from './types'
import { listAllApps } from './registry'
import { launchEntry, launchAction } from './launcher'
import { registerCliExtension } from '../../main/process/cli'
import { t, te } from '../../main/process/i18n'
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('apps-cli')

/**
 * Apps ability → CLI vocabulary.
 *
 * The framework CLI REPL is ability-agnostic; this module (loaded through
 * `apps/commands.ts`) contributes the app-facing subcommands (`list` / `info`
 * / `launch` / `run`) plus the bare-alias launch rule:
 *   - `<alias>` / `<alias> <action>`  launch an app (or one of its actions)
 *   - `launch <alias> [action]`, `info <alias>`, `list` / `ls`
 */

function formatEntry(e: AppEntry): string {
  const actions = Object.entries(e.actions ?? {})
  const lines = [
    te('cli.formatEntry.name', { val: e.name }),
    te('cli.formatEntry.alias', { val: e.alias ?? '' }),
    te('cli.formatEntry.path', { val: e.path }),
    te('cli.formatEntry.type', { val: e.exec.type, cmd: e.exec.command.join(' ') }),
    te('cli.formatEntry.risk', {
      val: e.security?.risk ?? 'low',
      note: e.security?.note ? `  (${e.security.note})` : ''
    }),
    te('cli.formatEntry.tags', {
      val: [...(e.tags ?? []), ...(e.tags_auto ?? [])].join(', ') || '—'
    })
  ]
  if (actions.length) {
    lines.push(
      te('cli.formatEntry.actions', {
        val: actions.map(([id, a]) => `${id} (${a.name})`).join(', ')
      })
    )
  }
  return lines.join('\n')
}

async function resolveByAlias(key: string): Promise<AppEntry | null> {
  const { apps } = await listAllApps()
  const k = key.toLowerCase()
  for (const [id, e] of Object.entries(apps)) {
    const alias = (e.alias || id).toLowerCase()
    const tags = (e.tags ?? []).map((t) => t.toLowerCase())
    if (alias === k || id.toLowerCase() === k || tags.includes(k)) return e
  }
  return null
}

async function launchByAlias(key: string, actionId?: string): Promise<string> {
  const e = await resolveByAlias(key)
  if (!e) return te('cli.launch.notFound', { key })
  if (actionId) {
    const action = e.actions?.[actionId]
    if (!action) {
      const known = Object.keys(e.actions ?? {}).join(', ') || '—'
      return te('cli.launch.actionNotFound', { action: actionId, known })
    }
    const res = await launchAction(e, action)
    if (!res.ok)
      log.error('cli action launch failed', {
        name: e.name,
        action: action.name,
        error: res.error
      })
    return res.ok
      ? te('cli.launch.executed', {
          name: e.name,
          action: action.name,
          pid: res.pid ? ` (pid ${res.pid})` : ''
        })
      : te('cli.launch.failed', { error: res.error ?? '' })
  }
  const res = await launchEntry(e)
  if (!res.ok) log.error('cli launch failed', { name: e.name, error: res.error })
  return res.ok
    ? te('cli.launch.started', {
        name: e.name,
        pid: res.pid ? ` (pid ${res.pid})` : ''
      })
    : te('cli.launch.failedStart', { error: res.error ?? '' })
}

async function listAppsCli(): Promise<string> {
  const { apps } = await listAllApps()
  if (Object.keys(apps).length === 0) return t('cli.list.empty')
  const rows = Object.entries(apps).map(([id, e]) => {
    const alias = e.alias && e.alias !== id ? e.alias : ''
    return `  ${(alias || id).padEnd(18)} ${e.name}`
  })
  return `${te('cli.list.count', { n: String(rows.length) })}\n${rows.join('\n')}`
}

registerCliExtension({
  helpLines: () => [
    t('cli.help.appCmds'),
    t('cli.help.aliasLaunch'),
    t('cli.help.aliasAction'),
    t('cli.help.launch'),
    t('cli.help.launchAction'),
    t('cli.help.info'),
    t('cli.help.list')
  ],
  builtins: [
    { name: 'list', help: t('cli.help.list'), run: async () => listAppsCli() },
    { name: 'ls', help: '', run: async () => listAppsCli() },
    {
      name: 'info',
      help: t('cli.help.info'),
      run: async (rest) => {
        const key = rest[0]
        if (!key) return t('cli.info.usage')
        const e = await resolveByAlias(key)
        if (!e) return te('cli.launch.notFound', { key })
        return formatEntry(e)
      }
    },
    {
      name: 'launch',
      help: t('cli.help.launch'),
      run: async (rest) => {
        const key = rest[0]
        if (!key) return t('cli.launch.usage')
        return await launchByAlias(key, rest[1])
      }
    },
    {
      name: 'run',
      help: '',
      run: async (rest) => {
        const key = rest[0]
        if (!key) return t('cli.launch.usage')
        return await launchByAlias(key, rest[1])
      }
    }
  ],
  resolveAlias: async (token) => {
    const e = await resolveByAlias(token)
    if (!e) return null
    return { run: async (rest) => launchByAlias(token, rest[0]) }
  }
})

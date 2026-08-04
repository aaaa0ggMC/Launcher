import type { AppEntry } from '../shared/types'
import { listAllApps } from './registry'
import { launchEntry, launchAction } from './launcher'
import { listCommands, tryRunCommand } from './commands'
import { t, te } from './i18n'

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

/**
 * CLI REPL backend.
 *  1. First token is a registered ability command (mirror.toggle, ...) → dispatch.
 *  2. Otherwise: <alias> launch, launch <alias>, info <alias>, list, help.
 */
export async function cliExec(input: string): Promise<string> {
  const tokens = input.trim().split(/\s+/)
  const [cmdRaw, ...rest] = tokens
  if (!cmdRaw) return ''
  const cmd = cmdRaw.toLowerCase()

  // Built-ins first.
  switch (cmd) {
    case 'help': {
      const cmds = listCommands()
      const grouped = new Map<string, string[]>()
      for (const c of cmds) {
        const ability = c.name.split('.')[0]
        const list = grouped.get(ability) ?? []
        list.push(`  ${c.name.padEnd(24)} ${t(c.name + '.desc', c.description)}`)
        grouped.set(ability, list)
      }
      const lines = [
        t('cli.help.appCmds'),
        t('cli.help.aliasLaunch'),
        t('cli.help.aliasAction'),
        t('cli.help.launch'),
        t('cli.help.launchAction'),
        t('cli.help.info'),
        t('cli.help.list'),
        t('cli.help.allCmds')
      ]
      for (const [ability, cmdsList] of grouped) {
        lines.push(`[${ability}]`)
        lines.push(...cmdsList)
      }
      return lines.join('\n')
    }
    case 'list':
    case 'ls': {
      const { apps } = await listAllApps()
      if (Object.keys(apps).length === 0) return t('cli.list.empty')
      const rows = Object.entries(apps).map(([id, e]) => {
        const alias = e.alias && e.alias !== id ? e.alias : ''
        return `  ${(alias || id).padEnd(18)} ${e.name}`
      })
      return `${te('cli.list.count', { n: String(rows.length) })}\n${rows.join('\n')}`
    }
    case 'info': {
      const key = rest[0]
      if (!key) return t('cli.info.usage')
      const e = await resolveByAlias(key)
      if (!e) return te('cli.launch.notFound', { key })
      return formatEntry(e)
    }
    case 'launch':
    case 'run': {
      const key = rest[0]
      if (!key) return t('cli.launch.usage')
      return await launchByAlias(key, rest[1])
    }
  }

  // Ability command dispatch (CLI-first).
  const commandOut = await tryRunCommand(input)
  if (commandOut !== null) return commandOut

  // Bare alias / tag → launch (optionally an action: <alias> <action>).
  const e = await resolveByAlias(cmdRaw)
  if (!e) return te('cli.error.unknown', { cmd: cmdRaw })
  return await launchByAlias(cmdRaw, rest[0])
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
    return res.ok
      ? te('cli.launch.executed', {
          name: e.name,
          action: action.name,
          pid: res.pid ? ` (pid ${res.pid})` : ''
        })
      : te('cli.launch.failed', { error: res.error ?? '' })
  }
  const res = await launchEntry(e)
  return res.ok
    ? te('cli.launch.started', {
        name: e.name,
        pid: res.pid ? ` (pid ${res.pid})` : ''
      })
    : te('cli.launch.failedStart', { error: res.error ?? '' })
}

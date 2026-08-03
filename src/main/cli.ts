import type { AppEntry } from '../shared/types'
import { listAllApps } from './registry'
import { launchEntry } from './launcher'
import { listCommands, tryRunCommand } from './commands'

function formatEntry(e: AppEntry): string {
  const lines = [
    `名称: ${e.name}`,
    `别名: ${e.alias ?? ''}`,
    `路径: ${e.path}`,
    `类型: ${e.exec.type}  →  ${e.exec.command.join(' ')}`,
    `风险: ${e.security?.risk ?? 'low'}${e.security?.note ? `  (${e.security.note})` : ''}`,
    `标签: ${[...(e.tags ?? []), ...(e.tags_auto ?? [])].join(', ') || '—'}`
  ]
  return lines.join('\n')
}

/**
 * CLI REPL backend.
 *  1. First token is a registered ability command (mirror.switch, ...) → dispatch.
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
        list.push(`  ${c.name.padEnd(24)} ${c.description}`)
        grouped.set(ability, list)
      }
      const lines = ['应用命令:', '  <alias>         直接启动应用 (别名/标签/id)', '  launch <alias>  启动应用', '  info <alias>    查看应用详情', '  list, ls        列出全部应用', '  所有能力命令均可直接输入 (Tab 补全):']
      for (const [ability, cmdsList] of grouped) {
        lines.push(`[${ability}]`)
        lines.push(...cmdsList)
      }
      return lines.join('\n')
    }
    case 'list':
    case 'ls': {
      const { apps } = await listAllApps()
      if (Object.keys(apps).length === 0) return '(空 — 没有找到应用)'
      const rows = Object.entries(apps).map(([id, e]) => {
        const alias = e.alias && e.alias !== id ? e.alias : ''
        return `  ${(alias || id).padEnd(18)} ${e.name}`
      })
      return `共 ${rows.length} 个应用:\n${rows.join('\n')}`
    }
    case 'info': {
      const key = rest[0]
      if (!key) return '用法: info <alias>'
      const e = await resolveByAlias(key)
      if (!e) return `未找到: ${key}`
      return formatEntry(e)
    }
    case 'launch':
    case 'run': {
      const key = rest[0]
      if (!key) return '用法: launch <alias>'
      return await launchByAlias(key)
    }
  }

  // Ability command dispatch (CLI-first).
  const commandOut = await tryRunCommand(input)
  if (commandOut !== null) return commandOut

  // Bare alias / tag → launch.
  const e = await resolveByAlias(cmdRaw)
  if (!e) return `未知命令: ${cmdRaw} (输入 help 查看全部命令)`
  return await launchByAlias(cmdRaw)
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

async function launchByAlias(key: string): Promise<string> {
  const e = await resolveByAlias(key)
  if (!e) return `未找到: ${key}`
  const res = await launchEntry(e)
  return res.ok ? `已启动 ${e.name}${res.pid ? ` (pid ${res.pid})` : ''}` : `启动失败: ${res.error}`
}

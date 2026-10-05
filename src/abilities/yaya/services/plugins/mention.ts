/**
 * Mention（PLAN 6.3）：用户在输入框 `@` 点名插件 / Skill / MCP / 单个工具，**从这条消息起本会话强制启用**。
 *
 * 宿主统一执行，三种来源共用：
 * - 候选：注册表里全部插件（含被全局禁用的——点名是用户主动选择）+ 每个工具；
 * - 效果：插件的 `mention()`，没有就按来源给缺省（builtin / mcp：启用整个插件；无工具的插件：只给附注）；
 * - 附注与随消息加载的内容**存进这条用户消息**（`meta.mentionNote`），组装历史时拼在它后面：
 *   之前的消息、系统提示词都不变，提示词缓存照常命中；
 * - 启用记在 `session.meta.mentions`，运行开始解析工具表时把点名的工具**追加在末尾**（顺序稳定、只追加）。
 *
 * 隐私边界不变：工具内部的 guard、`agent: 'deny'` 照旧；审批也照旧（点名 ≠ 免审批）。
 */
import { makeLogger } from '../../../../main/process/logger'
import { t, te } from '../../../../main/process/i18n'
import type { YayaConfig } from '../../types'
import { isPluginEnabled, listPlugins, wireName } from './registry'
import type { MentionEffect, YayaPlugin } from './types'

const log = makeLogger('yaya-mention')

/** 点名的引用：插件 id，或 `tool:<wire name>` */
export type MentionRef = string

/** 存进会话 / 消息的点名记录（显示用名字随点名时刻固定，插件改名不影响历史显示） */
export interface MentionRecord {
  ref: MentionRef
  label: string
  kind: 'builtin' | 'mcp' | 'skill' | 'tool'
}

export interface MentionCandidate extends MentionRecord {
  description: string
  icon?: string
  /** 全局是否启用（未启用的点名后本会话启用） */
  enabled: boolean
  /** 工具所属插件的显示名 */
  plugin?: string
}

const MAX_CANDIDATES = 60
/** 随消息加载的内容上限（Skill 正文等） */
const MAX_CONTENT_CHARS = 24_000

function pluginLabel(p: YayaPlugin): string {
  return p.labelKey ? t(p.labelKey, p.label) : p.label
}

function safeTools(p: YayaPlugin): ReturnType<YayaPlugin['tools']> {
  try {
    return p.tools()
  } catch {
    return []
  }
}

/** 输入框候选：插件在前，工具在后；按名字 / id / 描述模糊匹配 */
export function mentionCandidates(config: YayaConfig, query = ''): MentionCandidate[] {
  const q = query.trim().toLowerCase()
  const hit = (...xs: (string | undefined)[]): boolean =>
    !q || xs.some((x) => x?.toLowerCase().includes(q))
  const plugins: MentionCandidate[] = []
  const tools: MentionCandidate[] = []
  for (const p of listPlugins()) {
    const label = pluginLabel(p)
    const enabled = isPluginEnabled(p, config)
    const description = p.descriptionKey ? t(p.descriptionKey, p.description) : p.description
    if (hit(label, p.id, description))
      plugins.push({ ref: p.id, label, kind: p.kind, description, icon: p.icon, enabled })
    for (const tool of safeTools(p)) {
      const wire = wireName(p, tool)
      if (!hit(wire, tool.name, tool.description, label)) continue
      tools.push({
        ref: `tool:${wire}`,
        label: wire,
        kind: 'tool',
        description: tool.description.split('\n')[0].slice(0, 160),
        icon: p.icon,
        enabled: enabled && !(config.disabledTools ?? []).includes(wire),
        plugin: label
      })
    }
  }
  return [...plugins, ...tools].slice(0, MAX_CANDIDATES)
}

function findTarget(
  ref: MentionRef
): { plugin: YayaPlugin; tool?: ReturnType<YayaPlugin['tools']>[number]; wire?: string } | null {
  if (ref.startsWith('tool:')) {
    const wire = ref.slice(5)
    for (const p of listPlugins())
      for (const tool of safeTools(p))
        if (wireName(p, tool) === wire) return { plugin: p, tool, wire }
    return null
  }
  const plugin = listPlugins().find((p) => p.id === ref)
  return plugin ? { plugin } : null
}

/** 缺省效果：有工具 = 启用整个插件；没有工具 = 只给附注（显示类插件应自己实现 mention） */
function defaultEffect(plugin: YayaPlugin): MentionEffect {
  return safeTools(plugin).length ? { enable: 'plugin' } : {}
}

export interface ResolvedMentions {
  /** 存进用户消息 meta.mentions（显示） */
  records: MentionRecord[]
  /** 存进用户消息 meta.mentionNote（发给模型时拼在这条消息后面）；没有为 '' */
  note: string
  /** 本会话起要启用的（插件 id / tool:<wire>） */
  enable: MentionRef[]
}

/** 把一条消息里的点名解析成：显示记录 + 附注 + 本会话要启用的东西。未知 / 失败的点名跳过。 */
export async function resolveMentions(
  refs: MentionRef[],
  sessionId: string
): Promise<ResolvedMentions> {
  const out: ResolvedMentions = { records: [], note: '', enable: [] }
  const notes: string[] = []
  for (const ref of [...new Set(refs)].slice(0, 12)) {
    const target = findTarget(ref)
    if (!target) {
      log.warn('unknown mention', { ref })
      continue
    }
    const { plugin, wire } = target
    const label = wire ?? pluginLabel(plugin)
    out.records.push({ ref, label, kind: wire ? 'tool' : plugin.kind })
    if (wire) {
      out.enable.push(ref)
      notes.push(
        te('yaya.mention.note_tool', { name: wire }, '用户点名使用工具 {name}（本会话起可用）')
      )
      continue
    }
    let effect: MentionEffect
    try {
      effect = plugin.mention ? await plugin.mention({ sessionId }) : defaultEffect(plugin)
    } catch (e) {
      log.warn('mention handler failed', { plugin: plugin.id, error: String(e) })
      effect = defaultEffect(plugin)
    }
    if (effect.enable === 'plugin') out.enable.push(plugin.id)
    else if (Array.isArray(effect.enable)) {
      for (const bare of effect.enable) {
        const tool = safeTools(plugin).find((x) => x.name === bare)
        if (tool) out.enable.push(`tool:${wireName(plugin, tool)}`)
      }
    }
    const parts = [
      te('yaya.mention.note_plugin', { name: label }, '用户点名使用「{name}」'),
      effect.note?.trim()
    ].filter(Boolean)
    const text = (effect.content ?? [])
      .map((c) => (c.type === 'text' ? c.text : ''))
      .filter(Boolean)
      .join('\n\n')
    if (text)
      parts.push(text.length > MAX_CONTENT_CHARS ? `${text.slice(0, MAX_CONTENT_CHARS)}\n…` : text)
    if ((effect.content ?? []).some((c) => c.type === 'image'))
      log.warn('mention image content is not supported yet; skipped', { plugin: plugin.id })
    notes.push(parts.join('\n'))
  }
  if (notes.length)
    out.note = `[${t('yaya.mention.note_head', '用户在这条消息里点名')}]\n${notes.join('\n\n')}`
  return out
}

/** 合并进会话的点名列表（去重、保持先后顺序——工具表追加顺序由它决定） */
export function mergeSessionMentions(
  current: MentionRecord[] | undefined,
  records: MentionRecord[],
  enable: MentionRef[]
): MentionRecord[] {
  const list = [...(current ?? [])]
  const add = (rec: MentionRecord): void => {
    if (!list.some((x) => x.ref === rec.ref)) list.push(rec)
  }
  for (const ref of enable) {
    const rec = records.find((r) => r.ref === ref)
    if (rec) add(rec)
    else {
      // 插件经 mention() 只启用部分工具：记录工具本身
      add({ ref, label: ref.replace(/^tool:/, ''), kind: 'tool' })
    }
  }
  return list
}

/** 会话 meta 里的点名列表（容错） */
export function sessionMentions(meta: Record<string, unknown> | undefined): MentionRecord[] {
  const raw = meta?.mentions
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (x): x is MentionRecord =>
      !!x && typeof x === 'object' && typeof (x as MentionRecord).ref === 'string'
  )
}

/**
 * Mention（PLAN 6.3）：用户在输入框 `@` 点名**插件**（内置插件 / Skill / MCP 服务器），**从这条消息起本会话强制启用**。
 * 点名的单位是插件，不是单个工具：插件被点名 = 它的全部工具一起注入。
 *
 * 宿主统一执行，三种来源共用：
 * - 候选：注册表里全部插件（含被全局禁用的——点名是用户主动选择）；
 * - 效果：有工具的插件整个启用；插件的 `mention()` 只补充附注 / 随消息加载的内容（Skill 正文、显示类插件的用法）；
 * - 附注与随消息加载的内容**存进这条用户消息**（`meta.mentionNote`），组装历史时拼在它后面：
 *   之前的消息、系统提示词都不变，提示词缓存照常命中；
 * - 启用记在 `session.meta.mentions`，运行开始解析工具表时把点名插件的工具**追加在末尾**（顺序稳定、只追加）。
 *   旧会话里可能存着 `tool:<wire name>` 形式的记录，registry 仍兼容。
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
  /** 'tool' 只出现在旧会话的记录里（以前可以点名单个工具） */
  kind: 'builtin' | 'mcp' | 'skill' | 'tool'
}

export interface MentionCandidate extends MentionRecord {
  description: string
  icon?: string
  /** 全局是否启用（未启用的点名后本会话启用） */
  enabled: boolean
  /** 插件的工具数（点名后全部注入） */
  tools: number
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

/** 输入框候选：插件（含 Skill / MCP 服务器）；按名字 / id / 描述 / 工具名模糊匹配 */
export function mentionCandidates(config: YayaConfig, query = ''): MentionCandidate[] {
  const q = query.trim().toLowerCase()
  const hit = (...xs: (string | undefined)[]): boolean =>
    !q || xs.some((x) => x?.toLowerCase().includes(q))
  const out: MentionCandidate[] = []
  for (const p of listPlugins()) {
    const label = pluginLabel(p)
    const description = p.descriptionKey ? t(p.descriptionKey, p.description) : p.description
    const tools = safeTools(p)
    if (!hit(label, p.id, description, ...tools.map((x) => x.name))) continue
    out.push({
      ref: p.id,
      label,
      kind: p.kind,
      description,
      icon: p.icon,
      enabled: isPluginEnabled(p, config),
      tools: tools.length
    })
  }
  return out.slice(0, MAX_CANDIDATES)
}

/** 点名目标插件；旧格式 `tool:<wire name>` 归到它所属的插件 */
function findTarget(ref: MentionRef): YayaPlugin | null {
  if (ref.startsWith('tool:')) {
    const wire = ref.slice(5)
    return (
      listPlugins().find((p) => safeTools(p).some((tool) => wireName(p, tool) === wire)) ?? null
    )
  }
  return listPlugins().find((p) => p.id === ref) ?? null
}

/** 附注里列出的工具名上限（工具定义本身已在工具表里，这里只是让模型知道「点名的是哪些」） */
const MAX_NOTE_TOOLS = 30

export interface ResolvedMentions {
  /** 存进用户消息 meta.mentions（显示） */
  records: MentionRecord[]
  /** 存进用户消息 meta.mentionNote（发给模型时拼在这条消息后面）；没有为 '' */
  note: string
  /** 本会话起要启用的插件（点名的 + 它们 `mention().requires` 带上的） */
  enable: MentionRecord[]
}

/** 把一条消息里的点名解析成：显示记录 + 附注 + 本会话要启用的东西。未知 / 失败的点名跳过。 */
export async function resolveMentions(
  refs: MentionRef[],
  sessionId: string
): Promise<ResolvedMentions> {
  const out: ResolvedMentions = { records: [], note: '', enable: [] }
  const notes: string[] = []
  const seen = new Set<string>()
  for (const ref of [...new Set(refs)].slice(0, 12)) {
    const plugin = findTarget(ref)
    if (!plugin) {
      log.warn('unknown mention', { ref })
      continue
    }
    if (seen.has(plugin.id)) continue
    seen.add(plugin.id)
    const label = pluginLabel(plugin)
    out.records.push({ ref: plugin.id, label, kind: plugin.kind })
    const tools = safeTools(plugin)
    const enable = (p: YayaPlugin): void => {
      if (safeTools(p).length && !out.enable.some((x) => x.ref === p.id))
        out.enable.push({ ref: p.id, label: pluginLabel(p), kind: p.kind })
    }
    enable(plugin)
    let effect: MentionEffect = {}
    try {
      if (plugin.mention) effect = await plugin.mention({ sessionId })
    } catch (e) {
      log.warn('mention handler failed', { plugin: plugin.id, error: String(e) })
    }
    for (const id of effect.requires ?? []) {
      const dep = listPlugins().find((p) => p.id === id)
      if (dep) enable(dep)
    }
    const parts = [te('yaya.mention.note_plugin', { name: label }, '用户点名使用「{name}」')]
    if (tools.length) {
      const names = tools.slice(0, MAX_NOTE_TOOLS).map((tool) => wireName(plugin, tool))
      if (tools.length > MAX_NOTE_TOOLS) names.push('…')
      parts.push(
        te('yaya.mention.note_tools', { tools: names.join(', ') }, '本会话起可用的工具：{tools}')
      )
    }
    if (effect.note?.trim()) parts.push(effect.note.trim())
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
  enable: MentionRecord[]
): MentionRecord[] {
  const list = [...(current ?? [])]
  for (const rec of enable) if (!list.some((x) => x.ref === rec.ref)) list.push(rec)
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

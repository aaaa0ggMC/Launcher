/**
 * 渲染端插件 UI 注册表：收集 `plugins/<id>/ui.ts`，把工具的 wire name 映射回插件 / 裸工具名，
 * 给 ToolCallRow / AssistantTurn 查自定义视图与代码块渲染器，
 * 也给插件详情页查自定义配置界面（settingsView）。
 *
 * 插件启用状态：`fenceLangs` / `fenceViewFor` / `toolViewFor` 只算**已启用**插件的
 * （插件在设置里被禁用 → 代码块 / 工具结果按默认方式渲染）；启用状态按当前会话的助手算
 * （`setPluginAssistant`）。`settingsViewFor` 不设门控：
 * 用户正在插件详情页里操作，那里的启用开关自己也要能点。
 */
import { computed, defineAsyncComponent, ref, type Component } from 'vue'
import type { InlineTokenContext, InlineTokenView, MessageAction, PluginUi } from './plugin-ui'
import type { PluginInfo, PluginKind } from '../services/plugins/types'

const modules = import.meta.glob<PluginUi>('../plugins/*/ui.ts', { eager: true, import: 'default' })
const uis: PluginUi[] = Object.values(modules).filter(Boolean)

interface ToolRef {
  pluginId: string
  kind: PluginKind
  toolName: string
}

/** wire name → 插件 / 裸工具名（来自 yaya.plugins-list） */
const wireMap = ref(new Map<string, ToolRef>())
/** 插件 id → 是否启用（同样来自 yaya.plugins-list；命令失败时保持上一次的值） */
const pluginOn = ref(new Map<string, boolean>())
/** 插件 id → 非 secret 配置值（缺省值已填；显示类插件的界面按它渲染） */
const pluginValues = ref(new Map<string, Record<string, unknown>>())
let loading: Promise<void> | null = null
let subscribed = false
let refreshSequence = 0
/**
 * 当前会话所属的助手：插件的启用开关按助手生效（设置 → 助手 → 插件），
 * 渲染端的门控（朗读按钮、输入框扩展、代码块渲染器…）也要按它算，而不是全局配置。
 * 由 YAYA 页面在切换会话 / 助手时设置；没设置过 = 全局配置。
 */
let assistantId = ''

export function setPluginAssistant(id: string | null | undefined): void {
  const next = id ?? ''
  if (next === assistantId) return
  assistantId = next
  void refreshPluginMap()
}

export function refreshPluginMap(): Promise<void> {
  const sequence = ++refreshSequence
  loading = (async () => {
    try {
      const list = (await window.cockpit.command(
        'yaya.plugins-list',
        assistantId ? { assistant: assistantId } : {}
      )) as PluginInfo[]
      const map = new Map<string, ToolRef>()
      const on = new Map<string, boolean>()
      const values = new Map<string, Record<string, unknown>>()
      for (const p of list) {
        on.set(p.id, p.enabled)
        if (p.config) values.set(p.id, p.config.values)
        for (const t of p.tools)
          map.set(t.wireName, { pluginId: p.id, kind: p.kind, toolName: t.name })
      }
      if (sequence !== refreshSequence) return
      wireMap.value = map
      pluginOn.value = on
      pluginValues.value = values
    } catch {
      /* 拿不到就只用默认视图 */
    }
  })()
  return loading
}

/** 插件的非 secret 配置值（响应式；还没拉到时为空对象，调用方自己兜底默认值） */
export function pluginConfigValues(pluginId: string): Record<string, unknown> {
  ensurePluginMap()
  return pluginValues.value.get(pluginId) ?? {}
}

/** 首次使用时拉取一次，并跟随插件变化刷新 */
export function ensurePluginMap(): void {
  if (!loading) void refreshPluginMap()
  if (!subscribed) {
    subscribed = true
    window.cockpit.on('cockpit:yaya-plugins-changed', () => void refreshPluginMap())
    window.cockpit.on('cockpit:host-reconnected', () => void refreshPluginMap())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void refreshPluginMap()
    })
  }
}

const asyncCache = new Map<string, Component>()
function lazy(key: string, loader: () => Promise<unknown>): Component {
  let c = asyncCache.get(key)
  if (!c) {
    c = defineAsyncComponent(loader as () => Promise<Component>)
    asyncCache.set(key, c)
  }
  return c
}

function uiFor(pluginId: string, kind?: PluginKind): PluginUi | undefined {
  return uis.find((u) => u.pluginId === pluginId) ?? uis.find((u) => u.pluginId === `kind:${kind}`)
}

/**
 * 这个渲染端注册对应的插件此刻是否启用。`kind:<mcp|skill>` 是「同来源共用一份视图」，
 * 没有单一插件可关，永远放行；其余按插件 id 查启用表。查不到有两种情况：插件表还没拉到
 * （首次渲染）或命令失败——这时放行，宁可多渲染一次，也别让所有代码块退化成普通代码块。
 */
function uiEnabled(ui: PluginUi): boolean {
  if (ui.pluginId.startsWith('kind:')) return true
  return pluginOn.value.get(ui.pluginId) ?? true
}

/** 插件详情页的自定义配置界面（没有返回 null，走 schema 自动生成的表单） */
export function settingsViewFor(pluginId: string, kind?: PluginKind): Component | null {
  const ui = uiFor(pluginId, kind)
  const loader = ui?.settingsView
  if (!loader) return null
  return lazy(`settings:${ui!.pluginId}`, loader)
}

/** 插件详情页配置下面的附加面板（没有返回 null） */
export function settingsPanelFor(pluginId: string, kind?: PluginKind): Component | null {
  const ui = uiFor(pluginId, kind)
  const loader = ui?.settingsPanel
  if (!loader) return null
  return lazy(`panel:${ui!.pluginId}`, loader)
}

/** 用量统计里插件分区的自定义视图（没有返回 null，只显示分区的 stats） */
export function usageViewFor(pluginId: string): Component | null {
  const ui = uiFor(pluginId)
  const loader = ui?.usageView
  if (!loader) return null
  return lazy(`usage:${ui!.pluginId}`, loader)
}

export interface ResolvedToolView {
  component: Component
  pluginId: string
  toolName: string
}

/** 某个工具调用的自定义结果视图（没有返回 null，走默认字段视图） */
export function toolViewFor(wireName: string): ResolvedToolView | null {
  const ref = wireMap.value.get(wireName)
  if (!ref) return null
  // 插件被用户禁用 → 工具结果走默认字段视图
  if (pluginOn.value.get(ref.pluginId) === false) return null
  const ui = uiFor(ref.pluginId, ref.kind)
  const loader = ui?.toolViews?.[ref.toolName]
  if (!loader) return null
  return {
    component: lazy(`tool:${ui!.pluginId}:${ref.toolName}`, loader),
    pluginId: ref.pluginId,
    toolName: ref.toolName
  }
}

/** 某个工具调用的独立卡片视图（PluginUi.toolCards；没有返回 null）。不按启用状态门控 */
export function toolCardFor(wireName: string): ResolvedToolView | null {
  const ref = wireMap.value.get(wireName)
  if (!ref) return null
  const ui = uiFor(ref.pluginId, ref.kind)
  const loader = ui?.toolCards?.[ref.toolName]
  if (!loader) return null
  return {
    component: lazy(`toolcard:${ui!.pluginId}:${ref.toolName}`, loader),
    pluginId: ref.pluginId,
    toolName: ref.toolName
  }
}

/** 已注册了渲染器的代码块语言（小写；只算已启用插件的） */
export const fenceLangs = computed(() => {
  const set = new Set<string>()
  for (const u of uis) {
    if (!uiEnabled(u)) continue
    for (const lang of Object.keys(u.fences ?? {})) set.add(lang.toLowerCase())
  }
  return set
})

/**
 * 某种语言代码块的视图组件（插件被禁用 → null，按普通代码块渲染）。
 * 同一语言多个插件接管时按插件 id 字母序取第一个——后续需要逐插件优先级时再改这里。
 */
export function fenceViewFor(lang: string): Component | null {
  const key = lang.toLowerCase()
  const sorted = [...uis].sort((a, b) => a.pluginId.localeCompare(b.pluginId))
  for (const u of sorted) {
    if (!uiEnabled(u)) continue
    const loader = u.fences?.[key]
    if (loader) return lazy(`fence:${u.pluginId}:${key}`, loader)
  }
  return null
}

/** Composer extensions are enabled only after the backend confirms plugin availability. */
export const inputExtensions = computed(() =>
  [...uis]
    .sort((a, b) => a.pluginId.localeCompare(b.pluginId))
    .filter((ui) => pluginOn.value.get(ui.pluginId) === true && ui.inputExtension)
    .map((ui) => ({
      pluginId: ui.pluginId,
      component: lazy(`input:${ui.pluginId}`, ui.inputExtension!)
    }))
)

/**
 * 数据卡片的视图。不按启用状态门控：历史对话里的卡片在插件关掉后也要能看懂
 * （同 inlineTokens）。没有返回 null，显示卡片自带的 markdown。
 */
export function cardViewFor(pluginId: string | undefined, type: string): Component | null {
  if (!pluginId) return null
  const ui = uis.find((u) => u.pluginId === pluginId)
  const loader = ui?.cardViews?.[type]
  if (!loader) return null
  return lazy(`card:${pluginId}:${type}`, loader)
}

/** 回答操作栏里的插件按钮（只算已启用插件的，按插件 id 排序） */
export const messageActions = computed<{ pluginId: string; action: MessageAction }[]>(() =>
  [...uis]
    .sort((a, b) => a.pluginId.localeCompare(b.pluginId))
    .filter((ui) => pluginOn.value.get(ui.pluginId) === true && ui.messageActions?.length)
    .flatMap((ui) => ui.messageActions!.map((action) => ({ pluginId: ui.pluginId, action })))
)

// ---------------------------------------------------------------------------
// 正文记号（PluginUi.inlineTokens）
// ---------------------------------------------------------------------------

const tokenRules = uis.flatMap((u) => u.inlineTokens ?? [])

export type InlineTokenPart =
  { kind: 'text'; text: string } | { kind: 'token'; view: InlineTokenView }

/** 纯文本 → 文字 / 记号片段（用户气泡用） */
export function inlineTokenParts(text: string, ctx: InlineTokenContext): InlineTokenPart[] {
  let parts: InlineTokenPart[] = [{ kind: 'text', text }]
  for (const rule of tokenRules) {
    const next: InlineTokenPart[] = []
    for (const part of parts) {
      if (part.kind !== 'text') {
        next.push(part)
        continue
      }
      const re = new RegExp(
        rule.pattern.source,
        rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g'
      )
      let last = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(part.text))) {
        const view = rule.render(m, ctx)
        if (!view) continue
        if (m.index > last) next.push({ kind: 'text', text: part.text.slice(last, m.index) })
        next.push({ kind: 'token', view })
        last = m.index + m[0].length
        if (!m[0].length) re.lastIndex++
      }
      if (last < part.text.length) next.push({ kind: 'text', text: part.text.slice(last) })
    }
    parts = next
  }
  return parts
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  )
}

/** 记号的 HTML（回答走 v-html；文字一律转义） */
export function inlineTokenHtml(view: InlineTokenView): string {
  const attrs = [
    `class="yaya-token${view.tone === 'text' ? ' is-text' : ''}"`,
    view.title ? `title="${escapeHtml(view.title)}"` : '',
    view.privacy ? `data-privacy="${escapeHtml(view.privacy)}"` : ''
  ]
    .filter(Boolean)
    .join(' ')
  const icon =
    view.tone !== 'text' && view.icon
      ? `<i class="mdi ${escapeHtml(view.icon)}" aria-hidden="true"></i>`
      : ''
  return `<span ${attrs}>${icon}${escapeHtml(view.text)}</span>`
}

/** 已渲染的 Markdown HTML：只改标签之外的文字（文字里的 & < > 已是实体，记号本身不含这些字符） */
export function applyInlineTokensHtml(html: string, ctx: InlineTokenContext): string {
  if (!tokenRules.length) return html
  return html
    .split(/(<[^>]*>)/)
    .map((seg) => {
      if (!seg || seg.startsWith('<')) return seg
      const parts = inlineTokenParts(seg, ctx)
      if (parts.length === 1 && parts[0].kind === 'text') return seg
      // 文字片段来自已转义的 HTML，原样拼回；记号片段按 view 渲染（其中的文字都会转义）
      return parts.map((p) => (p.kind === 'text' ? p.text : inlineTokenHtml(p.view))).join('')
    })
    .join('')
}

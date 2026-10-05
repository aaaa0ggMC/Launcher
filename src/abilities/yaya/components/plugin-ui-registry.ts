/**
 * 渲染端插件 UI 注册表：收集 `plugins/<id>/ui.ts`，把工具的 wire name 映射回插件 / 裸工具名，
 * 给 ToolCallRow / AssistantTurn 查自定义视图与代码块渲染器，
 * 也给插件详情页查自定义配置界面（settingsView）。
 */
import { computed, defineAsyncComponent, ref, type Component } from 'vue'
import type { PluginUi } from './plugin-ui'
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
let loading: Promise<void> | null = null
let subscribed = false

export function refreshPluginMap(): Promise<void> {
  loading = (async () => {
    try {
      const list = (await window.cockpit.command('yaya.plugins-list')) as PluginInfo[]
      const map = new Map<string, ToolRef>()
      for (const p of list)
        for (const t of p.tools)
          map.set(t.wireName, { pluginId: p.id, kind: p.kind, toolName: t.name })
      wireMap.value = map
    } catch {
      /* 拿不到就只用默认视图 */
    }
  })()
  return loading
}

/** 首次使用时拉取一次，并跟随插件变化刷新 */
export function ensurePluginMap(): void {
  if (!loading) void refreshPluginMap()
  if (!subscribed) {
    subscribed = true
    window.cockpit.on('cockpit:yaya-plugins-changed', () => void refreshPluginMap())
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

/** 插件详情页的自定义配置界面（没有返回 null，走 schema 自动生成的表单） */
export function settingsViewFor(pluginId: string, kind?: PluginKind): Component | null {
  const ui = uiFor(pluginId, kind)
  const loader = ui?.settingsView
  if (!loader) return null
  return lazy(`settings:${ui!.pluginId}`, loader)
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
  const ui = uiFor(ref.pluginId, ref.kind)
  const loader = ui?.toolViews?.[ref.toolName]
  if (!loader) return null
  return {
    component: lazy(`tool:${ui!.pluginId}:${ref.toolName}`, loader),
    pluginId: ref.pluginId,
    toolName: ref.toolName
  }
}

/** 已注册了渲染器的代码块语言（小写） */
export const fenceLangs = computed(() => {
  const set = new Set<string>()
  for (const u of uis) for (const lang of Object.keys(u.fences ?? {})) set.add(lang.toLowerCase())
  return set
})

export function fenceViewFor(lang: string): Component | null {
  const key = lang.toLowerCase()
  for (const u of uis) {
    const loader = u.fences?.[key]
    if (loader) return lazy(`fence:${u.pluginId}:${key}`, loader)
  }
  return null
}

/**
 * Outsider SDK —— 浮在页面之上的小窗（桌宠 / 迷你播放器 / AI 在场提示 / 网页版授权弹窗）。
 *
 * - **能力注入**：能力在 `index.ts` 声明 `outsiders: [{ key, label, component, attrs }]`（同 `shortcuts`），
 *   完整 id = `<能力id>.<key>`；没声明的 id 一律打不开——外壳因此知道每个悬浮窗属于谁。
 *   页面 / 任意渲染端代码用 `openOutsider(id, props?)` / `closeOutsider(id)` 控制显示。
 * - **用户策略**（config.json `outsider`，设置 → 能力）：`enabled=false` 关掉全部能力悬浮窗，
 *   `blocked` 里的能力一律不弹（静默拒绝，保持页面纯净）。外壳自己的悬浮窗（`shell.*`：AI 在场 /
 *   授权）是安全控制，不受这份名单影响，各自有开关。agent 不能改 `outsider`（config.set 拒绝）。
 * - **对 AI 不可见、不可点**：悬浮层整体是 AI 禁区（快照只剩 `region [forbidden]`、截图被遮罩）；
 *   AI 经 CDP 注入鼠标事件期间 `<html>` 带 `agent-pass` 类，悬浮层 `pointer-events:none`，
 *   AI 的点击穿过它落到下面的元素上；命中测试也跳过 `[data-outsider-layer]`。悬浮窗不抢焦点，
 *   免得 AI 之后的按键落到悬浮窗的按钮上。
 * - AI 独立视图（MCP / Remote 的工作台）里不渲染任何悬浮窗。
 */
import { computed, defineAsyncComponent, reactive, ref, shallowRef, type Component } from 'vue'

export type OutsiderAnchor = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export interface OutsiderAttrs {
  /** 用户可拖动（缺省 true；`pinned` / `modal` 时无效） */
  draggable?: boolean
  /** 固定在 anchor + offset，不可拖动 */
  pinned?: boolean
  /** 初始停靠角（缺省 bottom-right） */
  anchor?: OutsiderAnchor
  /** 距停靠角的偏移（CSS px，缺省 16 / 16） */
  offset?: { x: number; y: number }
  /** 记住用户拖到的位置（缺省 true） */
  persist?: boolean
  /** 模态：居中 + 遮罩，挡住下面的页面（仅外壳使用，如授权弹窗） */
  modal?: boolean
  /** 拖到屏幕边缘时贴边收起、只露一条（缺省 true；不可拖动时无效） */
  dockable?: boolean
}

/** 贴边收起的那条边 */
export type OutsiderDock = 'left' | 'right' | 'top' | 'bottom'

/** 贴边后露在屏幕里的宽度（CSS px） */
export const DOCK_PEEK = 22

interface Box {
  left: number
  top: number
  width: number
  height: number
}

/**
 * 拖动松手时要不要贴边：悬浮窗被拖出了屏幕边，或指针贴着屏幕边（`edge` 以内）。
 * 几条边都满足时取「越界最多」的那条；不贴边返回 null。
 */
export function dockSideFor(
  box: Box,
  pointer: { x: number; y: number },
  view: { width: number; height: number },
  edge = 12
): OutsiderDock | null {
  const over: [OutsiderDock, number][] = [
    ['left', Math.max(-box.left, edge - pointer.x)],
    ['right', Math.max(box.left + box.width - view.width, pointer.x - (view.width - edge))],
    ['top', Math.max(-box.top, edge - pointer.y)],
    ['bottom', Math.max(box.top + box.height - view.height, pointer.y - (view.height - edge))]
  ]
  let best: OutsiderDock | null = null
  let most = 0
  for (const [side, v] of over) {
    if (v > most) {
      best = side
      most = v
    }
  }
  return best
}

/**
 * 同一条边上已经贴着别的悬浮窗时，沿边挪开，免得露出来的几条叠在一起：
 * 在 [min, max - size] 里找离 `start` 最近、不和任何 `others`（沿边的区间）重叠的位置。
 * 实在放不下就按原位（夹到范围内）。
 */
export function dockSlot(
  start: number,
  size: number,
  others: { start: number; size: number }[],
  min: number,
  max: number,
  gap = 6
): number {
  const fit = (v: number): number => Math.min(Math.max(v, min), Math.max(min, max - size))
  const free = (v: number): boolean =>
    others.every((o) => v + size + gap <= o.start || v >= o.start + o.size + gap)
  const candidates = [start]
  for (const o of others) candidates.push(o.start - size - gap, o.start + o.size + gap)
  let best: number | null = null
  for (const c of candidates.map(fit)) {
    if (!free(c)) continue
    if (best === null || Math.abs(c - start) < Math.abs(best - start)) best = c
  }
  return best ?? fit(start)
}

/** 能力 `index.ts` 里的声明 */
export interface AbilityOutsider {
  /** 能力内唯一 */
  key: string
  /** 显示名（中文原文，走 `label.<原文>` 翻译，同设置项约定） */
  label: string
  component: () => Promise<{ default: Component } | Component>
  attrs?: OutsiderAttrs
}

export interface OutsiderEntry {
  id: string
  /** 所属能力 id；外壳自己的 = 'shell' */
  owner: string
  label: string
  attrs: OutsiderAttrs
  component: Component
}

export interface OutsiderPolicy {
  enabled: boolean
  blocked: string[]
}

const entries = shallowRef(new Map<string, OutsiderEntry>())
/** 打开中的悬浮窗 → 传给组件的 props */
const opened = reactive(new Map<string, Record<string, unknown>>())
const policy = ref<OutsiderPolicy>({ enabled: true, blocked: [] })

function lazy(loader: AbilityOutsider['component']): Component {
  return defineAsyncComponent(loader as () => Promise<Component>)
}

/** 外壳自己的悬浮窗（不受能力名单影响） */
export function registerShellOutsider(def: AbilityOutsider): void {
  const id = `shell.${def.key}`
  const next = new Map(entries.value)
  next.set(id, {
    id,
    owner: 'shell',
    label: def.label,
    attrs: def.attrs ?? {},
    component: lazy(def.component)
  })
  entries.value = next
}

/** App.vue：能力列表变化时同步（平台 / 依赖 / 开关过滤后的能力） */
export function syncAbilityOutsiders(list: { owner: string; decl: AbilityOutsider }[]): void {
  const next = new Map<string, OutsiderEntry>()
  for (const [id, e] of entries.value) if (e.owner === 'shell') next.set(id, e)
  for (const { owner, decl } of list) {
    const id = `${owner}.${decl.key}`
    const prev = entries.value.get(id)
    next.set(id, {
      id,
      owner,
      label: decl.label,
      attrs: decl.attrs ?? {},
      // 复用已有的异步组件，免得能力列表刷新时悬浮窗重新挂载
      component: prev && prev.owner === owner ? prev.component : lazy(decl.component)
    })
  }
  for (const id of [...opened.keys()]) if (!next.has(id)) opened.delete(id)
  entries.value = next
}

/** App.vue：config.json `outsider` 变化时同步 */
export function setOutsiderPolicy(raw: unknown): void {
  policy.value = resolveOutsiderPolicy(raw)
}

export function resolveOutsiderPolicy(raw: unknown): OutsiderPolicy {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    enabled: r.enabled !== false,
    blocked: Array.isArray(r.blocked) ? r.blocked.map(String) : []
  }
}

export function isOutsiderAllowed(entry: OutsiderEntry, p: OutsiderPolicy = policy.value): boolean {
  if (entry.owner === 'shell') return true
  return p.enabled && !p.blocked.includes(entry.owner)
}

/** 打开（已打开则更新 props）。未声明 / 被策略禁止 → false（静默，不弹） */
export function openOutsider(id: string, props: Record<string, unknown> = {}): boolean {
  const e = entries.value.get(id)
  if (!e) {
    console.warn(`[outsider] 未声明的悬浮窗：${id}`)
    return false
  }
  if (!isOutsiderAllowed(e)) return false
  opened.set(id, props)
  return true
}

export function closeOutsider(id: string): void {
  opened.delete(id)
}

export function isOutsiderOpen(id: string): boolean {
  return opened.has(id)
}

/** 宿主（OutsiderLayer）渲染的列表：打开中且被允许的 */
export const visibleOutsiders = computed(() =>
  [...opened.entries()]
    .map(([id, props]) => ({ entry: entries.value.get(id), props }))
    .filter(
      (x): x is { entry: OutsiderEntry; props: Record<string, unknown> } =>
        !!x.entry && isOutsiderAllowed(x.entry)
    )
)

/** 设置页：全部已声明的能力悬浮窗（不含外壳的） */
export const declaredOutsiders = computed(() =>
  [...entries.value.values()].filter((e) => e.owner !== 'shell')
)

export const outsiderPolicy = computed(() => policy.value)

/** 悬浮窗组件里 `inject(OUTSIDER_CTX)` 拿到自己的 id 与关闭函数 */
export const OUTSIDER_CTX = Symbol('cockpit:outsider')
export interface OutsiderContext {
  id: string
  close: () => void
}

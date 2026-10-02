import { onScopeDispose, ref, type Ref } from 'vue'

/**
 * 独占 SDK 的渲染端状态（主进程核心见 `src/main/process/exclusive.ts`）。
 *
 * 模块级单例：App 外壳窄条（ExclusiveBanner）与标题栏 AI 图标条（AgentBar）共用，
 * 靠引用计数订阅 / 退订 `cockpit:exclusive` 广播，不会每个组件各订一份。
 *
 * 纯函数（formatHeld / describeOwner / leasesOf / heldParts / normalizeLeases）不依赖
 * Vue、不依赖 window，方便离线自检与复用。
 */

export type LeaseOwner = { kind: 'user' } | { kind: 'agent'; session: string; client: string }

/** 广播 / `exclusive.list` 返回的租约（带 idleMs / heldMs，便于界面直接阅读）。 */
export interface LeaseView {
  scope: string
  key: string
  /** 声明该范围的能力 id（defineExclusiveScopes 的第一个参数） */
  ability: string
  /** 范围名的翻译键 */
  label: string
  owner: LeaseOwner
  epoch: number
  acquiredAt: number
  lastActive: number
  /** 已持有毫秒数 */
  heldMs?: number
  /** 空闲毫秒数（距上次续期） */
  idleMs?: number
  /** 持有者的渲染进程（webContents id） */
  host?: number
}

export interface ExclusiveState {
  leases: Ref<LeaseView[]>
  /** 当前页面所属能力持有的租约（多 Ability 文件夹同时匹配 id 与 folder） */
  forAbility: (...ids: (string | null | undefined)[]) => LeaseView[]
  /** 某个 agent 会话持有的租约 */
  forSession: (session: string | null | undefined) => LeaseView[]
  refresh: () => Promise<void>
  /** 用户接管（AI 占用时点「接管」），失败会抛错 */
  takeOver: (scope: string, key: string) => Promise<void>
}

/* ------------------------------------------------------------------ 纯函数 */

/** 时长单位文案（中文带前导空格，英文紧跟数字，调用方按语言传入）。 */
export interface HeldUnits {
  sec: string
  min: string
  hour: string
}

export const HELD_UNITS_ZH: HeldUnits = { sec: ' 秒', min: ' 分', hour: ' 小时' }
export const HELD_UNITS_EN: HeldUnits = { sec: 's', min: 'm', hour: 'h' }

/** 毫秒 → { h, m, s }（向下取整，负值夹到 0）。 */
export function heldParts(ms: number): { h: number; m: number; s: number } {
  const total = Math.max(0, Math.floor(ms / 1000))
  return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 }
}

/**
 * 人类可读时长：`45 秒` / `3 分 12 秒` / `1 小时 5 分`。
 * 秒以下按秒计；有分时秒数为 0 则省略秒；有小时时省略秒。
 */
export function formatHeld(ms: number, units: HeldUnits = HELD_UNITS_ZH): string {
  const { h, m, s } = heldParts(ms)
  if (h > 0) return `${h}${units.hour} ${m}${units.min}`
  if (m > 0) return s > 0 ? `${m}${units.min} ${s}${units.sec}` : `${m}${units.min}`
  return `${s}${units.sec}`
}

export interface OwnerWords {
  user: string
  ai: string
}

export const OWNER_WORDS_ZH: OwnerWords = { user: '你', ai: 'AI' }
export const OWNER_WORDS_EN: OwnerWords = { user: 'you', ai: 'AI' }

/** 拥有者的人类可读名：`你` / `AI「client名」`（AI 没有 client 名时用会话短 id）。 */
export function describeOwner(owner: LeaseOwner, words: OwnerWords = OWNER_WORDS_ZH): string {
  if (owner.kind !== 'agent') return words.user
  const who = owner.client || owner.session.slice(0, 8) || 'agent'
  return `${words.ai}「${who}」`
}

/**
 * 匹配「属于这些能力」的租约：`ability` / `scope` 前缀任一命中（多 Ability 文件夹
 * 如 aidj + aidj-lyrics 共用 folder 前缀时也能对上）。
 */
export function leasesOf(
  list: LeaseView[],
  abilityIds: (string | null | undefined)[]
): LeaseView[] {
  const ids = abilityIds.filter((x): x is string => typeof x === 'string' && !!x)
  if (!ids.length) return []
  return list.filter((l) =>
    ids.some((id) => l.ability === id || l.scope === id || l.scope.startsWith(`${id}.`))
  )
}

/** 只保留 AI 持有的租约。 */
export function agentLeases(list: LeaseView[]): LeaseView[] {
  return list.filter((l) => l.owner.kind === 'agent')
}

/** 广播 / 命令返回的原始值 → LeaseView[]（带容错，坏数据当空列表）。 */
export function normalizeLeases(raw: unknown): LeaseView[] {
  if (!Array.isArray(raw)) return []
  const now = Date.now()
  const out: LeaseView[] = []
  for (const item of raw) {
    const l = item as Partial<LeaseView> | null
    if (!l || typeof l.scope !== 'string' || typeof l.key !== 'string') continue
    const owner = l.owner
    if (!owner || (owner.kind !== 'user' && owner.kind !== 'agent')) continue
    const acquiredAt = Number(l.acquiredAt) || now
    const lastActive = Number(l.lastActive) || acquiredAt
    out.push({
      scope: l.scope,
      key: l.key,
      ability: typeof l.ability === 'string' ? l.ability : l.scope.split('.')[0],
      label: typeof l.label === 'string' ? l.label : l.scope,
      owner,
      epoch: Number(l.epoch) || 0,
      acquiredAt,
      lastActive,
      heldMs: Number.isFinite(Number(l.heldMs)) ? Number(l.heldMs) : now - acquiredAt,
      idleMs: Number.isFinite(Number(l.idleMs)) ? Number(l.idleMs) : now - lastActive,
      ...(typeof l.host === 'number' ? { host: l.host } : {})
    })
  }
  return out.sort((a, b) => a.acquiredAt - b.acquiredAt)
}

/* -------------------------------------------------------------- 模块级单例 */

const leases = ref<LeaseView[]>([])
let consumers = 0
let off: (() => void) | null = null

async function refresh(): Promise<void> {
  try {
    leases.value = normalizeLeases(await window.cockpit.command('exclusive.list'))
  } catch {
    /* 命令不存在 / 失败时保留当前列表 */
  }
}

/**
 * 取独占租约状态。多个组件调用时只订阅一次广播；最后一个组件卸载时退订。
 * 必须在组件 setup（有 effect scope）里调用。
 */
export function useExclusive(): ExclusiveState {
  if (consumers === 0) {
    off = window.cockpit.on('cockpit:exclusive', (list) => {
      leases.value = normalizeLeases(list)
    })
    void refresh()
  }
  consumers++
  onScopeDispose(() => {
    consumers--
    if (consumers <= 0) {
      consumers = 0
      off?.()
      off = null
      leases.value = []
    }
  })

  return {
    leases,
    forAbility: (...ids) => leasesOf(leases.value, ids),
    forSession: (session) =>
      session
        ? leases.value.filter((l) => l.owner.kind === 'agent' && l.owner.session === session)
        : [],
    refresh,
    takeOver: async (scope, key) => {
      // agent 视图里的 IPC 一律算 agent-ui 来源，调不了「只有用户」的命令 → 走专用通道（主进程以用户身份接管）
      const inAgentView = new URLSearchParams(window.location.search).has('agent')
      if (inAgentView) {
        if (!(await window.cockpit.agentViewControl('take-over', { scope, key })))
          throw new Error('接管失败')
      } else {
        await window.cockpit.command('exclusive.take-over', { scope, key })
      }
      await refresh()
    }
  }
}

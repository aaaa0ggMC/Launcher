/**
 * 返回链 / 路由（网页与安卓 App 通用）
 *
 * 两级结构：
 * - **ability 级**：侧栏选择 / 跨能力跳转（齿轮、quick-launch、agent 跳转）。
 *   浏览器宿主写 history（`pushState`），浏览器返回逐个回退 ability；
 *   安卓 App 宿主只维护内存链——侧栏选择算「新根」（清空旧链），
 *   跨能力跳转入链，系统返回由 Java 问页面（见下）。
 * - **ability 内部级**：能力里的「整页切换」（设置分类、AIDJ 页面菜单子页），
 *   由能力自己用 `useNavStack` 管状态。浏览器宿主同样写 history（返回先弹内部层级），
 *   App 宿主不写（能力的返回处理器直接 pop 自己的栈）。
 *
 * 返回算法（两端一致）：**先关浮层 → 当前 ability 的内部返回 → pop ability 链 → 根**。
 * 根上：浏览器交给浏览器自己离开页面；App 由 Java 弹「再按一次退出」。
 *
 * keep-alive 保证 ability 级返回自动恢复内部状态，无需序列化路由。
 */
import { computed, shallowRef, type Ref } from 'vue'

/** history 里的一条记录。`internal` = ability 内部的整页切换（不是 ability 切换）。 */
interface NavEntry {
  ck: number
  ability: string
  internal: boolean
}

type Host = 'web' | 'app'

interface BackNavOptions {
  /** 启动时的 ability（会话记忆恢复后的当前能力） */
  initial: string
  /** 模块决定「切换到某个 ability」时回调（外壳负责 currentId 等副作用） */
  switchAbility: (id: string) => void
  /** 取当前 ability 的内部返回处理器（外壳从 abilityRef 上读 onBack） */
  getBackHandler: () => (() => boolean) | null
}

let host: Host = 'web'
let currentAbility = ''
let switchAbility: (id: string) => void = () => {}
let getBackHandler: () => (() => boolean) | null = () => null
/** App 宿主的 ability 内存链（浏览器宿主由 history 承担，不维护） */
let chain: string[] = []
/** 当前 ability 上、还在 history 里的内部层级数（浏览器宿主用于 reset 时回收） */
let internalDepth = 0
let seq = 0
let currentEntry: NavEntry | null = null
/** reset 回收 history 时 `history.go(-n)` 触发的补偿 popstate 次数（不当成用户返回） */
let syncPops = 0
/** 正在 popstate 回调里：此时 history 已被浏览器消费，内部栈只应用旧状态不再 back() */
let inPopState = false
let inited = false

/** 安卓 App（WebView 壳）里由 Java 问页面；浏览器 / Electron 用浏览器自己的返回。 */
export function isAppHost(): boolean {
  return !!window.cockpit?.client
}

function readState(): NavEntry | null {
  const s = window.history.state as NavEntry | null | undefined
  return s && typeof s === 'object' && typeof s.ability === 'string' ? s : null
}

function pushEntry(e: NavEntry): void {
  currentEntry = e
  window.history.pushState(e, '')
}

function replaceEntry(e: NavEntry): void {
  currentEntry = e
  window.history.replaceState(e, '')
}

/** 关掉最上层浮层（对话框 / 菜单 / 底部弹层）：与安卓 Java 侧同一套判定。 */
function dismissOverlay(): boolean {
  const overlays = document.querySelectorAll('.v-overlay--active:not(.v-snackbar):not(.v-tooltip)')
  if (!overlays.length) return false
  const target = document.activeElement ?? document.body
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })
  )
  return true
}

/** 初始化（外壳启动 / 会话记忆恢复后调一次）。 */
export function initBackNav(opts: BackNavOptions): void {
  host = isAppHost() ? 'app' : 'web'
  currentAbility = opts.initial
  chain = [opts.initial]
  switchAbility = opts.switchAbility
  getBackHandler = opts.getBackHandler
  internalDepth = 0
  seq = 0
  syncPops = 0
  currentEntry = { ck: 0, ability: opts.initial, internal: false }
  replaceEntry(currentEntry)
  // 安卓 App：Java 的返回键问页面要结果（'handled' = 这次返回被消化；'root' = 已在根上）
  window.__cockpitBack = (): 'handled' | 'root' => requestBack()
  if (host === 'web' && !inited) window.addEventListener('popstate', onPopState)
  inited = true
}

function onPopState(): void {
  const entry = readState()
  // reset 回收 history 的补偿 pop：只同步状态，不当成一次用户返回
  if (syncPops > 0) {
    syncPops--
    currentEntry = entry
    return
  }
  // 被弹出我们的条目之外（进入本 App 之前的历史）：交给浏览器，不干预
  if (!entry) return
  // 1) 浮层开着：关掉它，并把刚被消耗的条目补回来（吞掉这次返回）
  if (dismissOverlay()) {
    const back = currentEntry ?? { ck: ++seq, ability: currentAbility, internal: false }
    pushEntry(back)
    if (back.internal) internalDepth++
    return
  }
  const ability = entry.ability
  // 2) 落到别的 ability：ability 级返回（不写 history，浏览器已经 pop 过了）
  if (ability !== currentAbility) {
    internalDepth = 0
    currentAbility = ability
    currentEntry = entry
    switchAbility(ability)
    return
  }
  // 3) 同一个 ability：这次返回对应内部层级，交给能力自己的处理器
  internalDepth = entry.internal ? Math.max(0, internalDepth - 1) : 0
  currentEntry = entry
  inPopState = true
  try {
    getBackHandler()?.()
  } finally {
    inPopState = false
  }
}

/**
 * ability 级导航。
 * - `sidebar`：用户点侧栏（App 宿主算新根，清空旧链）；
 * - `jump`：跨能力跳转（齿轮 / quick-launch / agent），入链。
 */
export function navigateAbility(id: string, kind: 'sidebar' | 'jump'): void {
  if (!inited || id === currentAbility) return
  currentAbility = id
  internalDepth = 0
  const entry: NavEntry = { ck: ++seq, ability: id, internal: false }
  if (host === 'app') {
    chain = kind === 'sidebar' ? [id] : [...chain, id]
    replaceEntry(entry)
  } else {
    pushEntry(entry)
  }
}

/**
 * 请求返回（App 宿主的系统返回键 / 页面里主动调用）。
 * 浏览器宿主的「返回」由浏览器按键 → popstate → `onPopState` 驱动，不走这里。
 */
export function requestBack(): 'handled' | 'root' {
  if (host !== 'app') {
    // 浏览器宿主：交给浏览器（会触发 popstate → onPopState）。已在 App 的第一条
    // 条目上时没有可回退的，浏览器自己离开页面，正是「根上返回 = 离开 App」。
    if (currentEntry && currentEntry.ck !== 0) {
      window.history.back()
      return 'handled'
    }
    return 'root'
  }
  if (dismissOverlay()) return 'handled'
  if (getBackHandler()?.()) return 'handled'
  if (chain.length > 1) {
    chain = chain.slice(0, -1)
    switchAbility(chain[chain.length - 1])
    return 'handled'
  }
  return 'root'
}

/** ability 内部的整页切换：记一级（浏览器宿主同步写 history）。 */
export function pushInternal(): void {
  if (!inited) return
  internalDepth++
  if (host === 'web') pushEntry({ ck: ++seq, ability: currentAbility, internal: true })
}

/**
 * 清空当前 ability 的内部层级（着陆 / 重置）。
 * 浏览器宿主把对应的 history 条目一并回收，避免返回键时出现「按了没反应」。
 */
export function resetInternal(): void {
  if (!inited) return
  if (host === 'web' && internalDepth > 0) {
    syncPops = 1
    window.history.go(-internalDepth)
  }
  internalDepth = 0
}

// ---------------------------------------------------------------------------
// 能力侧 SDK
// ---------------------------------------------------------------------------

export interface NavStack<T> {
  /** 当前状态（模板里照旧读） */
  current: Readonly<Ref<T>>
  /** 内部导航到新状态：入链 + 浏览器宿主写 history */
  go: (state: T) => void
  /** 替换当前层（不增减层级）：用于「从菜单进全页浮层」——菜单层换成浮层层 */
  replace: (state: T) => void
  /** 返回上一级；没有可回退的返回 false。能力自己的「返回」按钮也调它。 */
  back: () => boolean
  /** 重置到某个状态并清空内部层级（跨能力跳转着陆 / 收起整个浮层组时用） */
  reset: (state: T) => void
}

/**
 * ability 内部「整页切换」的状态栈。设置分类、AIDJ 页面菜单子页都用它：
 *
 * ```ts
 * const step = useNavStack<MenuStep>('main')
 * step.go('sessions')   // 进入子页（入链）
 * step.back()           // 返回上一级（onBack 里调，外壳返回键经过它）
 * ```
 */
export function useNavStack<T>(initial: T): NavStack<T> {
  const stack = shallowRef<T[]>([initial])
  const current = computed(() => stack.value[stack.value.length - 1])
  return {
    current,
    go: (state: T): void => {
      if (state === current.value) return
      stack.value = [...stack.value, state]
      pushInternal()
    },
    replace: (state: T): void => {
      if (stack.value.length <= 1) return
      stack.value = [...stack.value.slice(0, -1), state]
      // 层级数不变：浏览器宿主把当前 history 条目改写掉（不进返回链）
      if (host === 'web') replaceEntry({ ck: ++seq, ability: currentAbility, internal: true })
    },
    back: (): boolean => {
      if (stack.value.length <= 1) return false
      if (host === 'web') {
        // popstate 链路里：history 已被浏览器消费，只应用旧状态
        if (inPopState) {
          stack.value = stack.value.slice(0, -1)
          return true
        }
        // 能力自己的返回按钮：让 popstate 链路来 pop，保证 history 与栈一致
        if (internalDepth <= 0) return false
        window.history.back()
        return true
      }
      stack.value = stack.value.slice(0, -1)
      return true
    },
    reset: (state: T): void => {
      if (stack.value.length === 1 && stack.value[0] === state) return
      stack.value = [state]
      resetInternal()
    }
  }
}

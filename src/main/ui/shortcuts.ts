import { onActivated, watch, onBeforeUnmount, onDeactivated, onMounted, reactive, ref } from 'vue'

/**
 * 应用内快捷键框架（渲染端，窗口有焦点时生效）。
 *
 * - 定义（注入）：能力在 `index.ts` 的 `shortcuts` 里声明（外壳自己的用 `registerShortcut`，group = 'shell'）——
 *   设置 → 快捷键 按能力分组列出，用户可改 / 清除 / 恢复默认，并检查冲突。
 * - 处理：页面里 `useShortcut(id, handler)`（可见时才绑定）；没有处理函数 = 该快捷键暂不生效。
 * - 所有快捷键默认都不绑定（避免互相冲突），用户在设置里自行启用；绑定存 config.json 的 `shortcuts: { [id]: combo }`。
 * - 组合键格式 `Ctrl+Shift+S`（顺序固定：Ctrl / Alt / Shift / Meta + 主键）；必须带修饰键，F1–F12 除外。
 * - 不是系统级全局快捷键：窗口失焦时不触发（Wayland 下 Electron 也拿不到全局键）。
 */
export interface ShortcutDef {
  id: string
  /** 翻译 key（框架翻译表） */
  label: string
  /** 翻译缺省文本 */
  fallback: string
  /** 归属：'shell'（外壳）或能力 id，设置页据此分组 */
  group: string
  /** 分组显示名（能力名），缺省用 group */
  groupLabel?: string
  /** 没有页面处理函数绑定时改跑这条命令（CLI-first；让页面没打开 / 全局触发也能用） */
  command?: { name: string; args?: Record<string, unknown> }
}

/** 全局快捷键的注册结果（主进程返回），设置页据此显示「被占用」等 */
export type GlobalShortcutError = 'invalid' | 'taken' | 'unsupported'
export const globalStatus = reactive<Record<string, { ok: boolean; error?: GlobalShortcutError }>>(
  {}
)

const defs = reactive(new Map<string, ShortcutDef>())
const handlers = new Map<string, () => void>()
/** 设置页录制新键时置位，期间分发器不触发任何快捷键 */
export const shortcutRecording = ref(false)

export function registerShortcut(def: ShortcutDef): void {
  defs.set(def.id, def)
}
/** 用能力注入的声明整体替换所有非外壳的定义（能力列表变化时调用） */
export function syncAbilityShortcuts(list: ShortcutDef[]): void {
  for (const [id, d] of [...defs]) if (d.group !== 'shell') defs.delete(id)
  for (const d of list) defs.set(d.id, d)
}
export function listShortcuts(): ShortcutDef[] {
  return [...defs.values()]
}

export function bindShortcut(id: string, handler: () => void): () => void {
  handlers.set(id, handler)
  return () => {
    if (handlers.get(id) === handler) handlers.delete(id)
  }
}

/** 页面里绑定快捷键处理函数：页面可见（挂载 / keep-alive 激活）时生效 */
export function useShortcut(id: string, handler: () => void): void {
  let off: (() => void) | null = null
  const on = (): void => {
    off ??= bindShortcut(id, handler)
  }
  const unbind = (): void => {
    off?.()
    off = null
  }
  onMounted(on)
  onActivated(on)
  onDeactivated(unbind)
  onBeforeUnmount(unbind)
}

/** 取某个动作当前生效的组合键（只有用户绑定过才有；空串 = 未绑定） */
export function effectiveCombo(id: string, user: Record<string, unknown> | undefined): string {
  const v = user?.[id]
  return typeof v === 'string' ? v : ''
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS'])

/** KeyboardEvent → 规范组合键；纯修饰键 / 没带修饰键（F 键除外）返回 null */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  let key: string
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5)
  else if (/^F\d{1,2}$/.test(e.key)) key = e.key
  else if (e.key === ' ') key = 'Space'
  else if (e.key.length === 1) key = e.key.toUpperCase()
  else key = e.key
  const fKey = /^F\d{1,2}$/.test(key)
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta']
    .filter(Boolean)
    .join('+')
  if (!mods && !fKey) return null
  return mods ? `${mods}+${key}` : key
}

/** 找出已被别的动作占用同一组合键的 id */
export function findConflict(
  combo: string,
  selfId: string,
  user: Record<string, unknown> | undefined,
  off: Set<string> = new Set()
): string | null {
  if (!combo) return null
  for (const d of defs.values()) {
    if (d.id === selfId || off.has(d.group)) continue
    if (effectiveCombo(d.id, user) === combo) return d.id
  }
  return null
}

/** 触发一个快捷键：页面处理函数优先，其次它声明的命令 */
export function fireShortcut(id: string): void {
  const fn = handlers.get(id)
  if (fn) return fn()
  const cmd = defs.get(id)?.command
  if (cmd) void window.cockpit.command(cmd.name, cmd.args ?? {})
}

/** 全局键必须带至少两个修饰键（与别的程序冲突的概率才低） */
export function isGlobalCapable(combo: string): boolean {
  return combo.split('+').filter(Boolean).length >= 3
}

/** config.json 的 `shortcutGroupsOff`：整组禁用的分组（'shell' 或能力 id） */
export function groupsOff(raw: unknown): Set<string> {
  return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [])
}

/** App 外壳安装一次：监听 keydown，按当前绑定分发 */
export function useShortcutDispatcher(
  userBindings: () => Record<string, unknown> | undefined,
  disabledGroups: () => unknown,
  globalIds: () => unknown,
  enabled: () => boolean
): void {
  function onKey(e: KeyboardEvent): void {
    if (e.repeat || shortcutRecording.value || !enabled()) return
    const combo = comboFromEvent(e)
    if (!combo) return
    const user = userBindings()
    const off = groupsOff(disabledGroups())
    for (const d of defs.values()) {
      if (off.has(d.group)) continue
      if (effectiveCombo(d.id, user) !== combo) continue
      // 已注册为全局的由系统级通道触发，这里不再重复
      if (globalStatus[d.id]?.ok) continue
      if (!handlers.has(d.id) && !d.command) continue
      e.preventDefault()
      e.stopPropagation()
      fireShortcut(d.id)
      return
    }
  }

  // 全局快捷键：把「已启用 + 标了全局 + 组合键合规」的条目同步给主进程
  function wantedGlobals(): { id: string; combo: string }[] {
    if (!enabled()) return []
    const user = userBindings()
    const off = groupsOff(disabledGroups())
    const ids = new Set(groupsOff(globalIds()))
    return [...defs.values()]
      .filter((d) => ids.has(d.id) && !off.has(d.group))
      .map((d) => ({ id: d.id, combo: effectiveCombo(d.id, user) }))
      .filter((x) => isGlobalCapable(x.combo))
  }
  async function syncGlobals(): Promise<void> {
    const wanted = wantedGlobals()
    const res = await window.cockpit.syncGlobalShortcuts(enabled() ? wanted : [])
    for (const k of Object.keys(globalStatus)) delete globalStatus[k]
    for (const [id, r] of Object.entries(res)) globalStatus[id] = r
  }
  let offGlobal: (() => void) | null = null
  onMounted(() => {
    window.addEventListener('keydown', onKey, true)
    offGlobal = window.cockpit.on('cockpit:global-shortcut', (id) => {
      if (typeof id !== 'string' || shortcutRecording.value) return
      const d = defs.get(id)
      if (d && !groupsOff(disabledGroups()).has(d.group)) fireShortcut(id)
    })
  })
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKey, true)
    offGlobal?.()
  })
  watch(
    () => JSON.stringify([wantedGlobals(), [...defs.keys()]]),
    () => void syncGlobals(),
    { immediate: true }
  )
}

import { globalShortcut, type WebContents } from 'electron'
import { makeLogger } from './logger'

const log = makeLogger('shortcuts')

/** 渲染端（仅用户的主窗口）同步过来的一条全局快捷键 */
export interface GlobalShortcutEntry {
  id: string
  /** 我们的组合键格式：`Ctrl+Alt+S` */
  combo: string
}
export interface GlobalShortcutStatus {
  ok: boolean
  /** 失败原因：invalid（组合键不合规）/ taken（被占用或系统拒绝）/ unsupported（平台不支持） */
  error?: 'invalid' | 'taken' | 'unsupported'
}

const KEY_MAP: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  ' ': 'Space',
  Meta: 'Super'
}

/** 全局键必须带至少两个修饰键（和别的程序冲突的概率才低），并转成 Electron accelerator */
export function toAccelerator(combo: string): string | null {
  const parts = combo.split('+').filter(Boolean)
  if (parts.length < 3) return null
  const mods = parts.slice(0, -1)
  const key = parts[parts.length - 1]
  if (!mods.every((m) => ['Ctrl', 'Alt', 'Shift', 'Meta'].includes(m))) return null
  return [...mods.map((m) => KEY_MAP[m] ?? m), KEY_MAP[key] ?? key].join('+')
}

/**
 * 整体替换已注册的全局快捷键。触发时给 `target`（用户的主窗口渲染进程）发 `cockpit:global-shortcut`，
 * 由渲染端的分发器执行（处理函数 / 命令）。这里只负责「按键 → 事件」，不执行任何动作。
 */
export function syncGlobalShortcuts(
  target: WebContents,
  entries: GlobalShortcutEntry[]
): Record<string, GlobalShortcutStatus> {
  globalShortcut.unregisterAll()
  const out: Record<string, GlobalShortcutStatus> = {}
  const used = new Set<string>()
  for (const { id, combo } of entries) {
    const acc = toAccelerator(combo)
    if (!acc) {
      out[id] = { ok: false, error: 'invalid' }
      continue
    }
    if (used.has(acc)) {
      out[id] = { ok: false, error: 'taken' }
      continue
    }
    try {
      const ok = globalShortcut.register(acc, () => {
        if (!target.isDestroyed()) target.send('cockpit:global-shortcut', id)
      })
      if (ok) used.add(acc)
      out[id] = ok ? { ok: true } : { ok: false, error: 'taken' }
      if (!ok) log.warn('global shortcut registration failed', { id, accelerator: acc })
    } catch (e) {
      out[id] = { ok: false, error: 'unsupported' }
      log.warn('global shortcut unsupported', {
        id,
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }
  return out
}

export function unregisterAllGlobalShortcuts(): void {
  globalShortcut.unregisterAll()
}

/**
 * Output-transformer runtime. A `transformer` in apps.json is JS source for a
 * constructor with `onNewLine(e, ui)`. `e` is each output line; `ui` is a
 * component factory (NOT DOM control) — the transformer composes descriptors:
 *
 *   ui.add(ui.NewAlign(ui.NewText('平台'), ui.NewStatus('$5.00')))
 *
 * or returns them from onNewLine (auto-appended). Available components:
 *   NewText(v, {size, mono}) / NewTitle(v) / NewAlign(...items) / NewBar(pct,label,color)
 *   NewStatus(v, color) / NewTable(head, rows) / clear() / add(...)
 * colors: 'ok' | 'warn' | 'err' | 'info'
 */

export type UiColor = 'ok' | 'warn' | 'err' | 'info'

export const statusColors: Record<UiColor, string> = {
  ok: 'success',
  warn: 'warning',
  err: 'error',
  info: 'info'
}

export type UiNode =
  | string
  | number
  | { t: 'text'; v: string; size?: 'sm' | 'md' | 'lg' | 'title'; mono?: boolean }
  | { t: 'align'; children: UiNode[]; gap?: number }
  | { t: 'bar'; pct: number; label?: string; color?: UiColor }
  | { t: 'status'; v: string; color?: UiColor }
  | { t: 'table'; head: string[]; rows: UiNode[][] }
  | { t: 'error'; v: string }

export interface UiApi {
  add: (...nodes: UiNode[]) => void
  clear: () => void
  NewText: (v: unknown, opts?: { size?: 'sm' | 'md' | 'lg' | 'title'; mono?: boolean }) => UiNode
  NewTitle: (v: unknown) => UiNode
  NewAlign: (...items: UiNode[]) => UiNode
  NewBar: (pct: number, label?: string, color?: UiColor) => UiNode
  NewStatus: (v: unknown, color?: UiColor) => UiNode
  NewTable: (head: unknown[], rows: unknown[][]) => UiNode
}

function normalize(v: unknown): UiNode {
  return typeof v === 'string' || typeof v === 'number'
    ? { t: 'text', v: String(v) }
    : (v as UiNode)
}

/** Build the ui API backed by the modal's reactive node buffer. */
export function createUi(buffer: UiNode[]): UiApi {
  return {
    add: (...nodes) => {
      buffer.push(...nodes.map(normalize))
    },
    clear: () => buffer.splice(0),
    NewText: (v, opts) => ({ t: 'text', v: String(v), ...(opts ?? {}) }),
    NewTitle: (v) => ({ t: 'text', v: String(v), size: 'title' }),
    NewAlign: (...items) => ({ t: 'align', children: items.map(normalize) }),
    NewBar: (pct, label, color = 'info') => ({
      t: 'bar',
      pct: Math.max(0, Math.min(100, Number(pct) || 0)),
      label,
      color
    }),
    NewStatus: (v, color = 'info') => ({ t: 'status', v: String(v), color }),
    NewTable: (head, rows) => ({
      t: 'table',
      head: head.map(String),
      rows: rows.map((r) => r.map(normalize))
    })
  }
}

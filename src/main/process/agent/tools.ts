/**
 * Agent 工具表 —— Remote 与 MCP 共用同一份定义（docs/agent-access-design.md §6.2）。
 *
 * 处理函数在调用方已设好的 origin（mcp / remote）下运行；真正的执行都走命令注册表
 * （`runCommand`），所以命令的 privacy 声明、inspector 的脱敏 / 守卫全部自动生效。
 */
import { z } from 'zod'
import { listCommands, runCommand } from '../commands/registry'
import { pageInfo } from '../inspector'
import {
  getPrivacyScope,
  hasClearance,
  isGrantable,
  listPendingRequests,
  listPrivacyScopes,
  listRunGrants,
  PrivacyDeniedError,
  requestClearance,
  waitClearance,
  GUARD_WAIT_MS
} from '../privacy'

export type ToolOutput =
  | { kind: 'json'; value: unknown }
  | { kind: 'image'; data: string; mimeType: string; meta: unknown }

export interface AgentTool {
  name: string
  title: string
  description: string
  shape: z.ZodRawShape
  readOnly?: boolean
  destructive?: boolean
  run: (args: Record<string, unknown>) => Promise<ToolOutput>
}

const json = (value: unknown): ToolOutput => ({ kind: 'json', value })

const USAGE_HINT = `Linux Cockpit is a desktop control center. Typical loop:
1. ui_snapshot → read the page; interactive elements carry [ref=eN].
2. ui_click / ui_type / ui_key / ui_scroll with those refs (every action waits for the page to settle).
3. ui_snapshot again (refs are only valid for the latest snapshot).
Use ui_navigate to switch pages, ui_screenshot to see layout / images.
Privacy: protected values appear as «redacted:<scope>»; [privacy-action=...] elements and
"privacy_pending" errors mean the user must approve in a consent window you cannot see —
call request_clearance / wait_clearance, then retry. Never try to work around a redaction.`

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'overview',
    title: 'Overview',
    description:
      'Start here. Current page, pages you can navigate to, privacy clearances you hold, and how to use the other tools.',
    shape: {},
    readOnly: true,
    run: async () => {
      const info = await pageInfo().catch(() => ({ page: '', abilities: [] }))
      return json({
        ...info,
        clearances: listPrivacyScopes()
          .filter((s) => hasClearance(s.id))
          .map((s) => s.id),
        runGrants: listRunGrants(),
        pendingRequests: listPendingRequests().length,
        usage: USAGE_HINT
      })
    }
  },
  {
    name: 'ui_snapshot',
    title: 'UI snapshot',
    description:
      'Accessibility-tree snapshot of the main window. Interactive elements have [ref=eN] for the ui_* tools; scrollable areas show their position ("more below" → scroll to load more). mode=full also includes plain text.',
    shape: { mode: z.enum(['interactive', 'full']).optional() },
    readOnly: true,
    run: async (a) => {
      const r = (await runCommand('ui.snapshot', { mode: a.mode })) as {
        text: string
        [k: string]: unknown
      }
      const { text, ...meta } = r
      return json({ ...meta, snapshot: text })
    }
  },
  {
    name: 'ui_navigate',
    title: 'Navigate',
    description: 'Switch to a page (same as clicking it in the sidebar). See overview for ids.',
    shape: { ability: z.string().describe('page id, e.g. "balance"') },
    run: async (a) => json(await runCommand('ui.navigate', { ability: a.ability }))
  },
  {
    name: 'ui_click',
    title: 'Click',
    description: 'Click an element by ref from the latest ui_snapshot.',
    shape: {
      ref: z.string().describe('e.g. "e12"'),
      button: z.enum(['left', 'right', 'middle']).optional(),
      double: z.boolean().optional()
    },
    run: async (a) => json(await runCommand('ui.click', a))
  },
  {
    name: 'ui_type',
    title: 'Type',
    description:
      'Type text into an input (click-focus first). clear=true replaces existing text; submit=true presses Enter.',
    shape: {
      ref: z.string(),
      text: z.string(),
      clear: z.boolean().optional(),
      submit: z.boolean().optional()
    },
    run: async (a) => json(await runCommand('ui.type', a))
  },
  {
    name: 'ui_key',
    title: 'Press key',
    description:
      'Press a key: Enter, Escape, Tab, Backspace, Delete, Space, Arrow*, PageUp/PageDown, Home/End.',
    shape: { key: z.string() },
    run: async (a) => json(await runCommand('ui.key', a))
  },
  {
    name: 'ui_scroll',
    title: 'Scroll',
    description:
      'Mouse-wheel scroll over an element (ref) or the page centre. dy > 0 scrolls down.',
    shape: { ref: z.string().optional(), dy: z.number().optional(), dx: z.number().optional() },
    run: async (a) => json(await runCommand('ui.scroll', a))
  },
  {
    name: 'ui_wait',
    title: 'Wait',
    description:
      'Wait for the page to settle, for some visible text to appear (timeout ms), or a fixed time.',
    shape: {
      text: z.string().optional(),
      timeout: z.number().optional(),
      ms: z.number().optional()
    },
    readOnly: true,
    run: async (a) => json(await runCommand('ui.wait', a))
  },
  {
    name: 'ui_screenshot',
    title: 'Screenshot',
    description:
      'Screenshot of the main window (or one element by ref). Protected regions are covered with labelled boxes.',
    shape: { ref: z.string().optional() },
    readOnly: true,
    run: async (a) => {
      const r = (await runCommand('ui.screenshot', { ref: a.ref, save: false })) as {
        data: string
        mime: string
        [k: string]: unknown
      }
      const { data, mime, ...meta } = r
      return { kind: 'image', data, mimeType: mime, meta }
    }
  },
  {
    name: 'commands_list',
    title: 'List commands',
    description:
      'Every backend command (CLI-first: each UI action is also a command). Optional substring filter. privacy.requires lists clearances needed.',
    shape: { filter: z.string().optional() },
    readOnly: true,
    run: async (a) => {
      const f = String(a.filter ?? '').toLowerCase()
      return json(
        listCommands()
          .filter((c) => !f || c.name.includes(f) || c.description.toLowerCase().includes(f))
          .filter((c) => c.privacy?.agent !== 'deny')
          .map((c) => ({
            name: c.name,
            description: c.description,
            usage: c.usage,
            privacy: c.privacy
          }))
      )
    }
  },
  {
    name: 'command_run',
    title: 'Run command',
    description: 'Run a backend command by name with structured args (see commands_list).',
    shape: {
      name: z.string(),
      args: z.record(z.string(), z.unknown()).optional()
    },
    run: async (a) =>
      json(await runCommand(String(a.name), (a.args as Record<string, unknown>) ?? {}))
  },
  {
    name: 'privacy_scopes',
    title: 'Privacy scopes',
    description:
      'All privacy scopes, their level, whether they can be requested, and whether you hold them.',
    shape: {},
    readOnly: true,
    run: async () =>
      json(
        listPrivacyScopes().map((s) => ({
          id: s.id,
          level: s.level,
          capability: s.capability,
          grantable: isGrantable(s.id),
          held: hasClearance(s.id)
        }))
      )
  },
  {
    name: 'request_clearance',
    title: 'Request clearance',
    description: `Ask the user to allow access to privacy scopes. The user decides in a window you cannot see; this waits up to ${GUARD_WAIT_MS / 1000}s, then returns status pending + requestId (use wait_clearance). Give an honest, specific reason.`,
    shape: { scopes: z.array(z.string()).min(1), reason: z.string() },
    run: async (a) => {
      const scopes = (a.scopes as string[]).filter((s) => getPrivacyScope(s) || s.includes('.'))
      return json(await requestClearance(scopes, String(a.reason ?? ''), { waitMs: GUARD_WAIT_MS }))
    }
  },
  {
    name: 'wait_clearance',
    title: 'Wait for clearance',
    description: `Keep waiting (up to ${GUARD_WAIT_MS / 1000}s) for a pending clearance request.`,
    shape: { request_id: z.string() },
    run: async (a) => json(await waitClearance(String(a.request_id), GUARD_WAIT_MS))
  }
]

/** 统一的错误描述：隐私错误带上 code / scopes / requestId，便于 agent 处理。 */
export function describeError(e: unknown): Record<string, unknown> {
  if (e instanceof PrivacyDeniedError) {
    return { error: e.message, code: e.code, scopes: e.scopes, requestId: e.requestId }
  }
  return { error: e instanceof Error ? e.message : String(e) }
}

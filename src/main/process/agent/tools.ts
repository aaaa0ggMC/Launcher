/**
 * Agent 工具表 —— Remote 与 MCP 共用同一份定义（docs/agent-access-design.md §6.2）。
 *
 * 处理函数在调用方已设好的 origin（mcp / remote）下运行；真正的执行都走命令注册表
 * （`runCommand`），所以命令的 privacy 声明、inspector 的脱敏 / 守卫全部自动生效。
 */
import { z } from 'zod'
import {
  listCommands,
  runCommand,
  commandUnavailableReason,
  CommandUnavailableError,
  UnknownCommandError
} from '../commands/registry'
import { commandOwnerOf } from '../ability-runtime'
import { pageInfo } from '../inspector'
import {
  clearanceInfo,
  collectRedactions,
  privacyNotice,
  type PrivacyNotice,
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

export type ToolOutput = (
  | { kind: 'json'; value: unknown }
  | { kind: 'image'; data: string; mimeType: string; meta: unknown }
) & {
  /** 本次结果里有被脱敏的值时附上：哪些 scope、是否授权过期、能否申请 */
  privacy?: PrivacyNotice
}

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

/**
 * 命令结果约定：顶层带 `$image: { data: <base64>, mimeType }` 的结果以图片返回，
 * 其余字段作为 meta（游戏画面等，不必为每个能力单独加网关工具）。
 */
function imageOrJson(value: unknown): ToolOutput {
  if (value && typeof value === 'object' && '$image' in value) {
    const { $image, ...meta } = value as { $image?: { data?: unknown; mimeType?: unknown } }
    if (typeof $image?.data === 'string' && typeof $image.mimeType === 'string')
      return { kind: 'image', data: $image.data, mimeType: $image.mimeType, meta }
  }
  return json(value)
}

const USAGE_HINT = `Linux Cockpit is a desktop control center. Typical loop:
1. ui_snapshot → read the page; interactive elements carry [ref=eN].
2. ui_click / ui_type / ui_key / ui_scroll with those refs (every action waits for the page to settle).
3. ui_snapshot again (refs are only valid for the latest snapshot).
Use ui_navigate to switch pages, ui_screenshot to see layout / images.
No ref (canvas, game, map)? Act like a person: take ui_screenshot and use its pixel coordinates with
ui_click_at / ui_move / ui_drag / ui_mouse / ui_scroll; ui_key supports hold_ms and down/up for games
(pass settle=false for fast repeated input). ui_snapshot boxes=true maps refs to screenshot pixels.
Backend: commands_list shows every command with available / unavailable_reason (mode-gated commands say
why), related commands/jobs and the UI entry points (ui) that trigger them. ability.describe --id <ability>
(via command_run) gives a generated per-ability manual incl. background jobs and help pages
(help.read --ability <id> --path <path>).
Privacy: protected values appear as «redacted:<scope>»; whenever a result contains them it also carries a
"privacy" notice (which scopes, whether your clearance EXPIRED, whether it can be requested). Clearances
from request_clearance may be time-limited (grants[].expiresAt) — after that, values are redacted again.
[privacy-action=...] elements, clicks that land in protected areas, and "privacy_pending" errors mean the
user must approve in a consent window you cannot see — call request_clearance / wait_clearance, then retry.
Never try to work around a redaction.`

/**
 * 网关（MCP / Remote）统一的工具执行入口：收集本次调用产生的脱敏，附上 privacy 说明。
 * 调用方需已在 agent origin 下（withOrigin）。
 */
export async function runAgentTool(
  tool: AgentTool,
  args: Record<string, unknown>
): Promise<ToolOutput> {
  const { value, redacted } = await collectRedactions(() => tool.run(args))
  const notice = privacyNotice(redacted)
  return notice ? { ...value, privacy: notice } : value
}

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
          .map((s) => clearanceInfo(s.id)),
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
      'Accessibility-tree snapshot of the main window. Interactive elements have [ref=eN] for the ui_* tools; <canvas> elements (games / charts) get a ref too. Scrollable areas show their position ("more below" → scroll to load more). boxes=true appends each ref\'s position on the screenshot as @(x,y wxh) in screenshot pixels. mode=full also includes plain text.',
    shape: {
      mode: z.enum(['interactive', 'full']).optional(),
      boxes: z.boolean().optional().describe('append @(x,y wxh) screenshot-pixel boxes to refs')
    },
    readOnly: true,
    run: async (a) => {
      const r = (await runCommand('ui.snapshot', { mode: a.mode, boxes: a.boxes })) as {
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
    title: 'Click (ref)',
    description: 'Click an element by ref from the latest ui_snapshot.',
    shape: {
      ref: z.string().describe('e.g. "e12"'),
      button: z.enum(['left', 'right', 'middle']).optional(),
      double: z.boolean().optional()
    },
    run: async (a) => json(await runCommand('ui.click', a))
  },
  {
    name: 'ui_click_at',
    title: 'Click (coordinates)',
    description:
      'Click at a point like a person would — for canvases, games, maps or anything without a ref. Coordinates are SCREENSHOT pixels by default (read them off ui_screenshot, or from ui_snapshot boxes=true); space="css" for CSS pixels. Returns what was under the point. Clicking inside a protected area asks the user first (privacy_pending) and forbidden areas are refused. A short marker shows the user where you clicked. settle=false skips waiting for the page to settle (fast game input).',
    shape: {
      x: z.number(),
      y: z.number(),
      button: z.enum(['left', 'right', 'middle']).optional(),
      double: z.boolean().optional(),
      space: z.enum(['image', 'css']).optional(),
      settle: z.boolean().optional()
    },
    run: async (a) => json(await runCommand('ui.click-at', a))
  },
  {
    name: 'ui_move',
    title: 'Move mouse',
    description:
      'Move the mouse to a point (hover). While a button is held (ui_mouse down) this is a drag move. Same coordinate rules as ui_click_at.',
    shape: {
      x: z.number(),
      y: z.number(),
      space: z.enum(['image', 'css']).optional(),
      settle: z.boolean().optional()
    },
    run: async (a) => json(await runCommand('ui.move', a))
  },
  {
    name: 'ui_mouse',
    title: 'Mouse button down / up',
    description:
      'Press or release a mouse button at a point (hold, then ui_move, then release — for custom drags or long-press). Pressing inside protected areas follows the same privacy rules as clicks.',
    shape: {
      action: z.enum(['down', 'up']),
      x: z.number(),
      y: z.number(),
      button: z.enum(['left', 'right', 'middle']).optional(),
      space: z.enum(['image', 'css']).optional(),
      settle: z.boolean().optional()
    },
    run: async (a) => json(await runCommand('ui.mouse', a))
  },
  {
    name: 'ui_drag',
    title: 'Drag',
    description:
      'Drag from one point to another (press → move in steps → release). Both ends are privacy-checked. Same coordinate rules as ui_click_at.',
    shape: {
      from_x: z.number(),
      from_y: z.number(),
      to_x: z.number(),
      to_y: z.number(),
      steps: z.number().optional(),
      duration_ms: z.number().optional(),
      button: z.enum(['left', 'right', 'middle']).optional(),
      space: z.enum(['image', 'css']).optional(),
      settle: z.boolean().optional()
    },
    run: async (a) =>
      json(
        await runCommand('ui.drag', {
          'from-x': a.from_x,
          'from-y': a.from_y,
          'to-x': a.to_x,
          'to-y': a.to_y,
          steps: a.steps,
          duration: a.duration_ms,
          button: a.button,
          space: a.space,
          settle: a.settle
        })
      )
  },
  {
    name: 'ui_type',
    title: 'Type',
    description:
      'Type text. With ref: click-focus that input first (clear=true replaces existing text). Without ref: type into whatever has focus. submit=true presses Enter.',
    shape: {
      ref: z.string().optional(),
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
      'Press a key: Enter, Escape, Tab, Backspace, Delete, Space, Arrow*, PageUp/PageDown, Home/End, Shift/Control/Alt/Meta, F1–F12, or any single letter / digit / symbol. hold_ms keeps it pressed (game movement). action="down"/"up" holds until you release it. modifiers for combos, e.g. key "a" + ["Control"].',
    shape: {
      key: z.string(),
      hold_ms: z.number().optional(),
      action: z.enum(['press', 'down', 'up']).optional(),
      modifiers: z.array(z.enum(['Shift', 'Control', 'Alt', 'Meta'])).optional(),
      settle: z.boolean().optional()
    },
    run: async (a) =>
      json(
        await runCommand('ui.key', {
          key: a.key,
          hold: a.hold_ms,
          action: a.action,
          modifiers: a.modifiers,
          settle: a.settle
        })
      )
  },
  {
    name: 'ui_scroll',
    title: 'Scroll',
    description:
      'Mouse-wheel scroll over an element (ref), at a point (x,y — same coordinate rules as ui_click_at), or the page centre. dy > 0 scrolls down.',
    shape: {
      ref: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      dy: z.number().optional(),
      dx: z.number().optional(),
      space: z.enum(['image', 'css']).optional(),
      settle: z.boolean().optional()
    },
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
      'Screenshot of the main window (or one element by ref). Protected regions are covered with labelled boxes. Pixel coordinates in this image can be passed straight to ui_click_at / ui_move / ui_drag / ui_scroll (scale = image pixels per CSS pixel is returned for reference).',
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
      'Every backend command (CLI-first: each UI action is also a command). Optional substring filter. available=false means it exists but cannot run right now (unavailable_reason says why, e.g. a player mode). related lists linked commands / jobs ("job:<name>" = start via background.job), ui lists the UI entry points that trigger it. privacy.requires lists clearances needed.',
    shape: {
      filter: z.string().optional(),
      available_only: z.boolean().optional().describe('hide commands that cannot run right now')
    },
    readOnly: true,
    run: async (a) => {
      const f = String(a.filter ?? '').toLowerCase()
      const specs = listCommands()
        .filter(
          (c) =>
            !f ||
            c.name.includes(f) ||
            c.description.toLowerCase().includes(f) ||
            (c.ui ?? []).some((u) => u.toLowerCase().includes(f))
        )
        .filter((c) => c.privacy?.agent !== 'deny')
      const rows = await Promise.all(
        specs.map(async (c) => {
          const reason = await commandUnavailableReason(c.name)
          return {
            name: c.name,
            ability: commandOwnerOf(c.name) || undefined,
            description: c.description,
            usage: c.usage,
            available: reason === null,
            unavailable_reason: reason ?? undefined,
            related: c.related,
            ui: c.ui,
            privacy: c.privacy
          }
        })
      )
      return json(a.available_only ? rows.filter((r) => r.available) : rows)
    }
  },
  {
    name: 'command_run',
    title: 'Run command',
    description:
      'Run a backend command by name with structured args (see commands_list). Commands whose result carries an image (e.g. gameboy.screen) return it as an image.',
    shape: {
      name: z.string(),
      args: z.record(z.string(), z.unknown()).optional()
    },
    run: async (a) =>
      imageOrJson(await runCommand(String(a.name), (a.args as Record<string, unknown>) ?? {}))
  },
  {
    name: 'privacy_scopes',
    title: 'Privacy scopes',
    description:
      'All privacy scopes, their level, whether they can be requested, whether you hold them, how (policy / run / once) and when a time-limited clearance expires (expires_in_s) or expired.',
    shape: {},
    readOnly: true,
    run: async () =>
      json(
        listPrivacyScopes().map((s) => {
          const info = clearanceInfo(s.id)
          return {
            id: s.id,
            level: s.level,
            capability: s.capability,
            grantable: isGrantable(s.id),
            held: info.held,
            via: info.via,
            expires_at: info.expiresAt,
            expires_in_s:
              info.expiresAt !== undefined
                ? Math.max(0, Math.round((info.expiresAt - Date.now()) / 1000))
                : undefined,
            expired_at: info.expiredAt
          }
        })
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
  if (e instanceof CommandUnavailableError) {
    return {
      error: e.message,
      code: 'command_unavailable',
      command: e.commandName,
      reason: e.reason
    }
  }
  if (e instanceof UnknownCommandError) {
    return {
      error: e.message,
      code: 'unknown_command',
      command: e.commandName,
      hint: 'see commands_list'
    }
  }
  return { error: e instanceof Error ? e.message : String(e) }
}

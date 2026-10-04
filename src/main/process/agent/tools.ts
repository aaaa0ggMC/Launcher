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
  currentOrigin,
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
import { setSessionStatus } from './sessions'
import { runAgentScript } from './script'
import { ExclusiveBusyError, LeaseLostError, StaleEpochError } from '../exclusive'

export type ToolOutput = (
  | { kind: 'json'; value: unknown }
  | { kind: 'image'; data: string; mimeType: string; meta: unknown }
  | { kind: 'images'; images: { data: string; mimeType: string; label: string }[]; meta: unknown }
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
(pass settle=false for fast repeated input). Real-time games (run + jump, charge, aim): your round-trips
take seconds, so script the moves with ui_input_timeline — one call, keys + mouse at exact millisecond
offsets, optional screenshots at chosen moments. ui_snapshot boxes=true maps refs to screenshot pixels.
Backend: commands_list shows every command with available / unavailable_reason (mode-gated commands say
why), related commands/jobs and the UI entry points (ui) that trigger them. ability.describe --id <ability>
(via command_run) gives a generated per-ability manual incl. background jobs and help pages
(help.read --ability <id> --path <path>).
Privacy: protected values appear as «redacted:<scope>»; whenever a result contains them it also carries a
"privacy" notice (which scopes, whether your clearance EXPIRED, whether it can be requested). Clearances
from request_clearance may be time-limited (grants[].expiresAt) — after that, values are redacted again.
[privacy-action=...] elements, clicks that land in protected areas, and "privacy_pending" errors mean the
user must approve in a consent window you cannot see — call request_clearance / wait_clearance, then retry.
Never try to work around a redaction.
Multi-step work ("operate → screenshot → decide → repeat", waiting for a state, batches of commands):
command_script runs one async function body in an isolated sandbox — only cockpit.command(name,args) /
cockpit.sleep(ms) / cockpit.log(...) / cockpit.show(ref,label) plus the \`args\` constant, no process /
require / fetch. Images come back as \`$imageRef\` handles; show() attaches up to 8 of them. Every command
keeps its privacy and exclusive rules, and limits (maxCalls / cpuMs / wallSec / memoryMB) can only be
lowered, never raised — a single step is still cheaper with command_run, real-time input with
ui_input_timeline.`

export function isHeadless(): boolean {
  return process.env.COCKPIT_HEADLESS === '1'
}

export function getActiveAgentTools(): AgentTool[] {
  if (isHeadless()) {
    return AGENT_TOOLS.filter((t) => !t.name.startsWith('ui_'))
  }
  return AGENT_TOOLS
}

/**
 * 网关（MCP / Remote）统一的工具执行入口：收集本次调用产生的脱敏，附上 privacy 说明。
 * 调用方需已在 agent origin 下（withOrigin）。
 */
export async function runAgentTool(
  tool: AgentTool,
  args: Record<string, unknown>
): Promise<ToolOutput> {
  if (isHeadless() && tool.name.startsWith('ui_')) {
    throw new Error(
      `UI tool '${tool.name}' is disabled in headless mode. Use capability commands (via command_run) or command_script instead.`
    )
  }
  const { value, redacted } = await collectRedactions(() => tool.run(args))
  const notice = privacyNotice(redacted)
  return notice ? { ...value, privacy: notice } : value
}

/**
 * `command_script` 的说明：写清沙箱里有什么、没有什么、限额与超限行为、适用 / 不适用场景 + 示例。
 * 限额的默认值不写死（用户在设置里改），只写「只能调小」。
 */
const COMMAND_SCRIPT_DESCRIPTION = `Run a multi-step job in ONE call — the same commands as command_run, but with loops, awaits and conditionals, so an "operate → screenshot → decide → repeat" cycle costs a single round-trip instead of one call per step.
\`code\` is an ASYNC FUNCTION BODY: you may \`await\` and \`return\` a JSON value; the object passed as \`args\` is available inside as the constant \`args\`.
Inside the sandbox there is ONLY: cockpit.command(name, args) — identical to command_run, so every privacy / exclusive rule still applies and the source stays your session; it throws a CommandError you can try/catch, with e.code such as exclusive_busy / privacy_denied / lease_lost / unknown_command. cockpit.sleep(ms) — host-side wait (max 10s per call), it does not consume the CPU budget. cockpit.log(...) — lines returned with the result. cockpit.show(ref, label) — copies an image into the tool result; only refs that came from a command result (\`$imageRef\`, e.g. from ui.screenshot or any image result), max 8 images.
NOT available: process, require, fetch, setTimeout, import(). Command results never contain base64 — images arrive as { $imageRef: n } and only cockpit.show copies them out, so a script cannot flood your context with screenshots.
Limits are set by the user in Settings → AI & remote → AI script; max_calls / wall_sec may only LOWER them, never raise them: maxCalls cockpit.command calls, cpuMs of pure computation (command waits and sleeps are not counted), wallSec overall wall time — the privacy consent window ALSO counts against it, so pass a larger wall_sec when a step may need the user to approve. Exceeding a limit ends the script and returns the logs and images collected so far plus which limit was hit.
Only one script may run per session at a time; the run shows up as an "AI 脚本" background task the user can stop at any moment.
Use it for: game or UI loops that need judgement between steps, waiting for some state, batches of commands. Do NOT use it for: a single operation (command_run is enough) or real-time input (ui_input_timeline).
Example:
const shot = await cockpit.command('ui.screenshot', {})
await cockpit.command('gameboy.press', { button: 'A', frames: 3 })
await cockpit.sleep(200)
cockpit.log('pressed A')
cockpit.show(shot.$imageRef, 'after A')
const st = await cockpit.command('gameboy.status', {})
return { hp: st.hp }`

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
      'Accessibility-tree snapshot of your Cockpit view (a private window of your own — the main window of the user is not affected; the user can watch it by clicking your avatar in the title bar). Interactive elements have [ref=eN] for the ui_* tools; <canvas> elements (games / charts) get a ref too. Scrollable areas show their position ("more below" → scroll to load more). boxes=true appends each ref\'s position on the screenshot as @(x,y wxh) in screenshot pixels. mode=full also includes plain text.',
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
    name: 'ui_input_timeline',
    title: 'Input timeline',
    description:
      'Play a scripted input sequence with exact timing — for real-time games and anything where the gap between separate tool calls (seconds) is too slow. Each event has t = ms from start; keyboard and mouse events can overlap freely (hold ArrowRight 0–900 while tapping Space at 150 for 300ms). key: action press (default; held hold_ms, default 50) / down / up, optional modifiers. mouse: move (duration_ms > 0 glides from the current position), down, up, click (hold_ms = long-press, double), wheel (dx/dy); coordinates as in ui_click_at. screenshot: captures a frame at that moment without pausing input (max 6) — frames come back as images labelled with their time. Does not wait for the page to settle. Keys / buttons still held at the end (or on error) are released automatically. Privacy: press points and the focused element are checked before starting (may need clearance); if the page changes mid-run and a press lands in an uncleared protected area the run aborts. Max 30 s, 500 events.',
    shape: {
      events: z
        .array(
          z.discriminatedUnion('type', [
            z.object({
              t: z.number().min(0),
              type: z.literal('key'),
              key: z.string(),
              action: z.enum(['press', 'down', 'up']).optional(),
              hold_ms: z.number().min(0).optional(),
              modifiers: z.array(z.enum(['Shift', 'Control', 'Alt', 'Meta'])).optional()
            }),
            z.object({
              t: z.number().min(0),
              type: z.literal('mouse'),
              action: z.enum(['move', 'down', 'up', 'click', 'wheel']),
              x: z.number(),
              y: z.number(),
              button: z.enum(['left', 'right', 'middle']).optional(),
              hold_ms: z.number().min(0).optional(),
              duration_ms: z.number().min(0).optional(),
              double: z.boolean().optional(),
              dx: z.number().optional(),
              dy: z.number().optional()
            }),
            z.object({
              t: z.number().min(0),
              type: z.literal('screenshot'),
              label: z.string().optional()
            })
          ])
        )
        .min(1)
        .max(500),
      space: z.enum(['image', 'css']).optional()
    },
    run: async (a) => {
      const r = (await runCommand('ui.input-timeline', {
        events: a.events,
        space: a.space,
        save: false
      })) as { frames: { t: number; at: number; label?: string; data?: string; mime: string }[] }
      const frames = r.frames ?? []
      const meta = { ...r, frames: frames.map((f) => ({ ...f, data: undefined })) }
      if (!frames.length) return json(meta)
      return {
        kind: 'images',
        images: frames.map((f) => ({
          data: f.data ?? '',
          mimeType: f.mime,
          label: `frame t=${f.t}ms (actual ${f.at}ms)${f.label ? ` — ${f.label}` : ''}`
        })),
        meta
      }
    }
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
    name: 'set_status',
    title: 'Set status',
    description:
      'Tell the user what you are busy with. Shown in the Cockpit title bar next to your avatar (hover) — keep it short, e.g. "Testing level 2 of Claude Adventure". Optional progress 0-100. Empty text clears it. It expires after ~2 minutes, so refresh it on long tasks. Display only; it changes nothing else.',
    shape: {
      text: z.string().max(200).describe('what you are doing, one short line; "" clears'),
      progress: z.number().min(0).max(100).optional()
    },
    readOnly: true,
    run: async (a) => {
      const id = currentOrigin().session
      if (id) setSessionStatus(id, String(a.text ?? ''), a.progress as number | undefined)
      return json({ ok: true })
    }
  },
  {
    name: 'ui_screenshot',
    title: 'Screenshot',
    description:
      'Screenshot of your Cockpit view (or one element by ref). Protected regions are covered with labelled boxes. Pixel coordinates in this image can be passed straight to ui_click_at / ui_move / ui_drag / ui_scroll (scale = image pixels per CSS pixel is returned for reference).',
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
    name: 'command_script',
    title: 'Run script',
    description: COMMAND_SCRIPT_DESCRIPTION,
    shape: {
      code: z.string().describe('async function body; may await and `return` a JSON value'),
      args: z.record(z.string(), z.unknown()).optional().describe('available inside as `args`'),
      max_calls: z.number().int().positive().optional().describe('lower the maxCalls limit'),
      wall_sec: z.number().positive().optional().describe('lower the wall-time limit (seconds)')
    },
    readOnly: false,
    destructive: true,
    run: async (a) =>
      runAgentScript({
        code: String(a.code),
        args: a.args,
        maxCalls: typeof a.max_calls === 'number' ? a.max_calls : undefined,
        wallSec: typeof a.wall_sec === 'number' ? a.wall_sec : undefined
      })
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
  if (e instanceof ExclusiveBusyError) {
    return {
      error: e.message,
      code: e.code,
      scope: e.scope,
      key: e.key,
      holder: e.holder,
      heldMs: e.sinceMs,
      idleMs: e.idleMs
    }
  }
  if (e instanceof LeaseLostError || e instanceof StaleEpochError) {
    return { error: e.message, code: e.code }
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

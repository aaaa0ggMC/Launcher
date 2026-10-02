/**
 * command_script 的执行入口（WP-B2）：配置 → 会话互斥 → 宿主 API → QuickJS 沙箱 → ToolOutput。
 * 设计见 docs/exclusive-and-script-design.md §二；沙箱本身在 `script-sandbox.ts`（WP-B1）。
 *
 * 要点：
 * - 命令仍走 `runCommand`（隐私 SDK / `agent: 'deny'` / 授权 / 独占全部照常生效，来源还是该 agent 会话）
 * - 命令结果里的图片 base64 **不进 VM**：换成 `{ $imageRef: n }` 句柄，`cockpit.show` 才附到返回里
 * - 同一会话同时只允许一个脚本；作为「AI 脚本」后台任务运行，用户可在面板里停止
 */
import { startJobTask } from '../background-tasks'
import { runCommand } from '../commands/registry'
import { makeLogger } from '../logger'
import { currentOrigin } from '../privacy'
import { scriptConfig } from './config'
import { runScript, type HostApi, type SandboxResult } from './script-sandbox'
import {
  CODE_MAX_BYTES,
  ImageHandleStore,
  ShownImages,
  hostErrorOf,
  jsonClone,
  resolveLimits,
  resolveShowRef,
  sanitizeCommandResult
} from './script-utils'
import type { ToolOutput } from './tools'

const log = makeLogger('agent-script')

const json = (value: unknown): ToolOutput => ({ kind: 'json', value })

/** 后台任务面板里的名字（固定，便于用户认出是 AI 提交的脚本） */
const TASK_NAME = 'AI 脚本'
/** 任务描述用代码开头的一段（压平空白，避免把整个文件塞进一行） */
const DESC_CHARS = 60

export interface RunAgentScriptInput {
  code: string
  args?: unknown
  /** 只能把配置里的 maxCalls 调小 */
  maxCalls?: number
  /** 只能把配置里的 wallSec 调小（秒） */
  wallSec?: number
  /**
   * 外部中止信号（客户端断开 / 会话结束）。当前 MCP / Remote 拿不到调用方的 signal
   * （见 `agent/mcp.ts` / `agent/remote.ts` 的 tool.run），所以只有后台面板的「停止」会中断；
   * 留参数是为了会话级中断接入时不用改签名。
   */
  signal?: AbortSignal
}

/** 沙箱里脚本 catch 到的命令错误：name 固定 `CommandError`，code 如 `exclusive_busy` / `privacy_denied`。 */
export class ScriptCommandError extends Error {
  readonly command?: string
  constructor(
    readonly code: string,
    message: string,
    command?: string
  ) {
    super(message)
    this.name = 'CommandError'
    this.command = command
  }
}

/** 同一会话的键：没有会话（内部定时器等）算 'anonymous'。 */
export function scriptSessionKey(): string {
  return currentOrigin().session ?? 'anonymous'
}

/** 多个 signal 任一触发即中止（Node 没有可移植的 AbortSignal.any 时自己合并）。 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const ac = new AbortController()
  for (const s of signals) {
    if (s.aborted) {
      ac.abort()
      break
    }
    s.addEventListener('abort', () => ac.abort(), { once: true })
  }
  return ac.signal
}

/** 每个会话同时在跑的脚本数（0 / 1） */
const RUNNING = new Set<string>()

export async function runAgentScript(input: RunAgentScriptInput): Promise<ToolOutput> {
  const cfg = await scriptConfig()
  if (!cfg.enabled) {
    return json({
      ok: false,
      error: { name: 'Disabled', message: 'command_script 已在设置中关闭' },
      code: 'command_script_disabled'
    })
  }

  const code = typeof input.code === 'string' ? input.code : ''
  if (!code.trim()) {
    return json({
      ok: false,
      error: { name: 'InvalidInput', message: '脚本代码不能为空' },
      code: 'script_invalid'
    })
  }
  if (Buffer.byteLength(code, 'utf8') > CODE_MAX_BYTES) {
    return json({
      ok: false,
      error: { name: 'InvalidInput', message: `脚本代码超过 ${CODE_MAX_BYTES} 字节上限` },
      code: 'script_too_large'
    })
  }

  // 同一会话同时只允许一个脚本（避免交错操作同一个游戏 / 页面）
  const key = scriptSessionKey()
  if (RUNNING.has(key)) {
    return json({
      ok: false,
      error: { name: 'Busy', message: '该会话已有脚本在运行' },
      code: 'script_busy'
    })
  }

  const limits = resolveLimits(cfg, { maxCalls: input.maxCalls, wallSec: input.wallSec })
  const images = new ImageHandleStore()
  const shown = new ShownImages()
  const args = jsonClone(input.args ?? {})

  // 后台任务：面板可见每次命令调用，可「停止」→ 中断沙箱
  const ac = new AbortController()
  let callIdx = 0
  /** 已经写进面板的调用序号（command 与 onCall 两条路径去重，避免同一次调用记两行） */
  let loggedIdx = 0
  let finished = false
  const control = startJobTask({
    name: TASK_NAME,
    description: code.replace(/\s+/g, ' ').trim().slice(0, DESC_CHARS),
    onCancel: () => ac.abort()
  })
  const finish = (status: 'exited' | 'error' | 'cancelled'): void => {
    if (finished) return
    finished = true
    control.finish(status)
  }

  const host: HostApi = {
    async command(name: string, cmdArgs: unknown): Promise<unknown> {
      callIdx++
      if (callIdx > loggedIdx) {
        // 沙箱没调 onCall 时兜底记录
        control.pushLine(`[${callIdx}] ${name}`)
        loggedIdx = callIdx
      }
      let result: unknown
      try {
        result = await runCommand(
          name,
          (cmdArgs && typeof cmdArgs === 'object' ? cmdArgs : {}) as Record<string, unknown>
        )
      } catch (e) {
        const d = hostErrorOf(e)
        throw new ScriptCommandError(d.code, d.message, name)
      }
      return sanitizeCommandResult(result, images)
    },
    show(ref: unknown, label: string): void {
      const n = resolveShowRef(ref, images)
      shown.add(n, typeof label === 'string' ? label : String(label ?? ''))
    },
    onCall(info: { index: number; name: string }): void {
      if (info.index > loggedIdx) {
        control.pushLine(`[${info.index}] ${info.name}`)
        loggedIdx = info.index
      }
    }
  }

  RUNNING.add(key)
  const started = Date.now()
  const externalSignal = input.signal ? anySignal([ac.signal, input.signal]) : ac.signal
  let result: SandboxResult
  try {
    result = await runScript(code, args, host, limits, externalSignal)
  } catch (e) {
    // 沙箱自身炸了（内部错误 / 尚未实现）：也按一次失败的运行收尾
    const d = hostErrorOf(e)
    log.warn('script sandbox threw', { session: key, error: d.message })
    result = {
      ok: false,
      logs: [],
      calls: callIdx,
      elapsedMs: Date.now() - started,
      error: { name: d.name, message: d.message, code: d.code }
    }
  } finally {
    RUNNING.delete(key)
  }

  const calls = result.calls ?? callIdx
  const elapsedMs = result.elapsedMs ?? Date.now() - started
  const meta: Record<string, unknown> = {
    ok: result.ok === true,
    result: result.result,
    logs: Array.isArray(result.logs) ? result.logs : [],
    calls,
    elapsedMs
  }
  if (result.error) meta.error = result.error
  const summary = result.ok
    ? `ok · ${calls} 次命令 · ${elapsedMs}ms`
    : `失败（${result.error?.name ?? 'Error'}）· ${calls} 次命令 · ${elapsedMs}ms`
  control.pushLine(summary)

  const shownList = shown.list()
  if (shownList.length) control.pushLine(`附上 ${shownList.length} 张图片`)

  // 面板「停止」已经把任务置成 cancelled，这里只是兜底标注状态
  finish(ac.signal.aborted ? 'cancelled' : result.ok ? 'exited' : 'error')

  const out = shownList.flatMap((s) => {
    const img = images.get(s.ref)
    return img ? [{ data: img.data, mimeType: img.mimeType, label: s.label }] : []
  })
  if (!out.length) return json(meta)
  return { kind: 'images', images: out, meta }
}

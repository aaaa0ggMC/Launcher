import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import pidusage from 'pidusage'
import { run } from './util'
import { makeLogger } from './logger'
import type { BtOutputMessage, BtTaskInfo } from '../../shared/types'

/**
 * Background task framework — architectural, not tied to any ability.
 *
 * Any module in the main process can open a task that keeps running in the
 * app's shadow while the user switches pages. A global panel (the Background
 * Tasks dialog) lists every task, streams its console, and lets the user
 * interact (stdin writes, signals like SIGINT, stop/kill).
 *
 * Two task kinds:
 *  - `process` — a real child process with piped stdio. Gets rough resource
 *    stats (CPU / memory via pidusage, GPU via nvidia-smi when present), live
 *    console output, and interactive control.
 *  - `job` — an abstract long-running operation (download, transform, ...).
 *    The creator pushes output/progress and can cancel; no process involved.
 *
 * Tasks are attached to this program: children are NOT detached and are killed
 * when the app quits. Output lines go into a bounded ring buffer per task.
 */

const log = makeLogger('background')

const MAX_OUTPUT_LINES = 5000
const POLL_MS = 2000

export type BackgroundEvent =
  | { type: 'changed'; tasks: BtTaskInfo[] }
  | { type: 'output'; id: string; messages: BtOutputMessage[] }
  | { type: 'exit'; id: string; code: number | null }

type Broadcast = (event: BackgroundEvent) => void

let broadcast: Broadcast = () => {}

export function setBackgroundBroadcast(fn: Broadcast): void {
  broadcast = fn
}

export interface StartProcessOptions {
  name: string
  description?: string
  /** how the panel renders this task's output; default 'log' */
  view?: string
  /** arbitrary tags — e.g. `['aidj-playback']` to mark playback-control tasks */
  tags?: string[]
  argv: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface StartJobOptions {
  name: string
  description?: string
  /** how the panel renders this task's output; default 'log' */
  view?: string
  /** arbitrary tags — e.g. `['aidj-playback']` to mark playback-control tasks */
  tags?: string[]
  /** called when the user stops/cancels the task */
  onCancel?: () => void | Promise<void>
}

/** Control handle returned for `job` tasks. */
export interface JobControl {
  id: string
  /** append a console line to the task's output (default log view) */
  pushLine: (line: string, stream?: 'stdout' | 'stderr') => void
  /** emit an arbitrary message — structured data, base64 binary, progress */
  push: (message: BtOutputMessage) => void
  /** 0–100 progress, undefined to switch to indeterminate */
  setProgress: (p?: number) => void
  /** mark the job finished (status defaults to `exited`) */
  finish: (status?: BtTaskInfo['status']) => void
  /** register an abort/cancel callback (e.g. destroy an AbortController) */
  setCancel: (fn: () => void | Promise<void>) => void
}

/**
 * Named job handler — a backend function run inside a background task. The
 * renderer starts it by name via `background.job`, so arbitrary long-running
 * work (downloads, transforms, ...) can be frontend-triggered while the actual
 * I/O + persistence happens in the main process. The handler receives a
 * JobControl to stream output / progress, and may register an onCancel.
 */
export type JobHandler = (
  control: JobControl,
  args: Record<string, unknown>
) => void | Promise<void>

/** Optional runtime gate — when it resolves false `startJobByName` treats the
 *  handler as unknown (mode-gated features are not startable). */
export type JobHandlerGate = () => boolean | Promise<boolean>

interface RegisteredJob {
  handler: JobHandler
  gate?: JobHandlerGate
}

const jobHandlers = new Map<string, RegisteredJob>()

/** Register a named job handler (called once at ability/service load). An
 *  optional `gate` controls whether the handler is startable right now. */
export function registerJobHandler(name: string, handler: JobHandler, gate?: JobHandlerGate): void {
  if (jobHandlers.has(name)) throw new Error(`重复作业处理器: ${name}`)
  jobHandlers.set(name, { handler, gate })
}

interface InternalTask {
  info: BtTaskInfo
  /** process tasks only */
  child?: ChildProcessWithoutNullStreams
  output: BtOutputMessage[]
  /** write to the process stdin (process tasks) */
  write?: (data: string) => void
  /** user-supplied cancellation for job tasks */
  cancel?: () => void | Promise<void>
  /** set when stopTask() sent SIGTERM — marks the eventual exit as "stopped" */
  stopRequested?: boolean
  forceTimer?: NodeJS.Timeout
}

let seq = 0
const tasks = new Map<string, InternalTask>()
let pollTimer: NodeJS.Timeout | null = null

function nextId(): string {
  seq++
  return `bt-${Date.now().toString(36)}-${seq}`
}

function snapshot(t: InternalTask): BtTaskInfo {
  return { ...t.info, stats: { ...t.info.stats } }
}

function broadcastChanged(): void {
  // A structural change supersedes any pending throttled status update.
  if (statusTimer) {
    clearTimeout(statusTimer)
    statusTimer = null
    statusDirty = false
  }
  const list = [...tasks.values()].map(snapshot)
  try {
    broadcast({ type: 'changed', tasks: list })
  } catch {
    // never break the task pipeline on broadcast errors
  }
}

/**
 * Status delivery — THROTTLED to STATUS_BATCH_MS (100ms).
 *
 * `setProgress` can be called in a tight loop (e.g. a download updating every
 * chunk); broadcasting the full task list per call would flood the socket.
 * Progress updates are coalesced into one broadcast per 100ms window, while
 * structural changes (start/stop/exit/remove) still broadcast immediately via
 * `broadcastChanged()`. The renderer therefore sees progress lag at most one
 * window behind, and log output stays real-time.
 */
const STATUS_BATCH_MS = 100
let statusTimer: NodeJS.Timeout | null = null
let statusDirty = false

function scheduleStatusChanged(): void {
  statusDirty = true
  if (statusTimer) return
  statusTimer = setTimeout(() => {
    statusTimer = null
    if (!statusDirty) return
    statusDirty = false
    broadcastChanged()
  }, STATUS_BATCH_MS)
}

/**
 * Output delivery — REAL TIME.
 *
 * Every message is broadcast at the end of the current event-loop tick via
 * queueMicrotask: a synchronous burst from the task (e.g. one big stdout chunk)
 * is coalesced into a single IPC push, but there is NO artificial delay —
 * a sparse task's line shows up immediately. This keeps log / structured
 * output live, exactly as the user expects.
 */
const OUTPUT_BATCH_MAX = 500

/** per-task id → pending messages not yet broadcast */
const pendingOutput = new Map<string, BtOutputMessage[]>()

function flushOutput(): void {
  if (!pendingOutput.size) return
  for (const [id, messages] of pendingOutput) {
    pendingOutput.delete(id)
    if (!messages.length) continue
    try {
      broadcast({ type: 'output', id, messages })
    } catch {
      // never break the task pipeline on broadcast errors
    }
  }
}

function appendOutput(t: InternalTask, message: BtOutputMessage): void {
  t.output.push(message)
  if (t.output.length > MAX_OUTPUT_LINES) t.output.splice(0, t.output.length - MAX_OUTPUT_LINES)
  t.info.outputCount = t.output.length

  const q = pendingOutput.get(t.info.id) ?? []
  q.push(message)
  pendingOutput.set(t.info.id, q)

  // Real-time: flush at end of tick; bursty tasks beyond the cap flush early.
  queueMicrotask(flushOutput)
  if (q.length >= OUTPUT_BATCH_MAX) flushOutput()
}

/** Flush a task's queued messages immediately (used on exit so the tail isn't delayed). */
function flushTaskOutput(id: string): void {
  const q = pendingOutput.get(id)
  if (!q?.length) return
  pendingOutput.delete(id)
  try {
    broadcast({ type: 'output', id, messages: q })
  } catch {
    // ignore
  }
}

/** Split a raw chunk into lines, emitting complete ones; keeps the rest buffered. */
function streamLines(
  t: InternalTask,
  stream: 'stdout' | 'stderr',
  chunk: string,
  buffer: { rest: string }
): void {
  buffer.rest += chunk
  let idx: number
  while ((idx = buffer.rest.indexOf('\n')) >= 0) {
    const line = buffer.rest.slice(0, idx)
    buffer.rest = buffer.rest.slice(idx + 1)
    if (line.trim() || stream === 'stderr') appendOutput(t, { stream, line })
  }
}

function onExit(t: InternalTask, code: number | null, signal: string | null = null): void {
  // Killed by stop/kill (SIGTERM/SIGKILL) → "stopped"; otherwise natural exit.
  const stopped = signal === 'SIGTERM' || signal === 'SIGKILL' || t.stopRequested === true
  t.info.status = stopped ? 'stopped' : 'exited'
  t.info.exitCode = code
  t.info.endedAt = Date.now()
  t.child = undefined
  t.stopRequested = false
  if (t.forceTimer) {
    clearTimeout(t.forceTimer)
    t.forceTimer = undefined
  }
  flushTaskOutput(t.info.id) // deliver any queued tail lines immediately
  try {
    broadcast({ type: 'exit', id: t.info.id, code })
  } catch {
    // ignore
  }
  broadcastChanged()
  maybeStopPolling()
}

// ---------------------------------------------------------------------------
// Resource stats
// ---------------------------------------------------------------------------

/**
 * Poll stats for one process task via `pidusage` (cross-platform: /proc on
 * Linux, PowerShell on Windows, ps on macOS). CPU is an instantaneous percent
 * measured between calls; memory is resident bytes.
 */
async function pollProcessTask(t: InternalTask): Promise<void> {
  const pid = t.info.pid
  if (!pid || !t.child) return
  try {
    const stat = await pidusage(pid)
    t.info.stats.cpu = Math.max(0, Math.round(stat.cpu))
    t.info.stats.mem = Math.round(stat.memory / 1024 / 1024)
  } catch {
    // process gone / not inspectable → keep last known stats
  }
}

/** Query GPU memory (MB) for the given pids via nvidia-smi compute-apps. */
async function pollGpu(pids: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>()
  if (!pids.length) return map
  const out = await run(
    'nvidia-smi',
    ['--query-compute-apps=pid,used_gpu_memory', '--format=csv,noheader,nounits'],
    { timeout: 3000 }
  ).catch(() => '')
  if (!out) return map
  for (const line of out.split('\n')) {
    const m = line.match(/(\d+)\s*,\s*(\d+)/)
    if (m) map.set(Number(m[1]), Number(m[2]))
  }
  return map
}

async function poll(): Promise<void> {
  const running = [...tasks.values()].filter((t) => t.info.status === 'running')
  if (!running.length) {
    maybeStopPolling()
    return
  }
  const pids = running.map((t) => t.info.pid).filter((p): p is number => typeof p === 'number')
  const [gpuMap] = await Promise.all([pollGpu(pids)])
  for (const t of running) {
    if (t.info.status !== 'running') continue
    await pollProcessTask(t)
    if (t.info.pid && gpuMap.has(t.info.pid)) t.info.stats.gpu = gpuMap.get(t.info.pid)
  }
  broadcastChanged()
}

function ensurePolling(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    poll().catch((e) => log.warn('background poll failed', e))
  }, POLL_MS)
}

function maybeStopPolling(): void {
  if (![...tasks.values()].some((t) => t.info.status === 'running' && t.child)) {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Start a process-based background task. Returns the task info. */
export function startProcessTask(opts: StartProcessOptions): BtTaskInfo {
  const id = nextId()
  const [cmd, ...args] = opts.argv
  if (!cmd) throw new Error('background.start requires argv')
  log.info('start process task', { id, name: opts.name, argv: opts.argv })

  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe']
  })

  const t: InternalTask = {
    info: {
      id,
      name: opts.name,
      description: opts.description,
      view: opts.view ?? 'log',
      kind: 'process',
      status: 'running',
      pid: child.pid,
      command: opts.argv.join(' '),
      startedAt: Date.now(),
      stats: {},
      outputCount: 0,
      canInput: true,
      canSignal: true,
      tags: opts.tags
    },
    output: [],
    child,
    write: (data) => {
      try {
        child.stdin.write(data)
      } catch (e) {
        log.warn('stdin write failed', { id, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  tasks.set(id, t)

  const outBuf = { rest: '' }
  const errBuf = { rest: '' }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d: string) => streamLines(t, 'stdout', d, outBuf))
  child.stderr.on('data', (d: string) => streamLines(t, 'stderr', d, errBuf))
  child.on('error', (err) => {
    log.error('process task error', { id, error: err.message })
    appendOutput(t, { stream: 'stderr', line: `[spawn error] ${err.message}` })
    onExit(t, null)
  })
  child.on('exit', (code, signal) => onExit(t, code, signal))

  broadcastChanged()
  ensurePolling()
  return snapshot(t)
}

/**
 * Start an abstract job task (no process). Returns a control handle for the
 * creator to push output / progress and finish.
 */
export function startJobTask(opts: StartJobOptions): JobControl {
  const id = nextId()
  log.info('start job task', { id, name: opts.name, view: opts.view })
  const t: InternalTask = {
    info: {
      id,
      name: opts.name,
      description: opts.description,
      view: opts.view ?? 'log',
      kind: 'job',
      status: 'running',
      startedAt: Date.now(),
      stats: {},
      outputCount: 0,
      canInput: false,
      canSignal: false,
      tags: opts.tags
    },
    output: [],
    cancel: opts.onCancel
  }
  tasks.set(id, t)
  broadcastChanged()

  return {
    id,
    pushLine: (line, stream = 'stdout') => appendOutput(t, { stream, line }),
    push: (message) => appendOutput(t, message),
    setProgress: (p) => {
      t.info.progress = p
      scheduleStatusChanged()
    },
    finish: (status = 'exited') => {
      if (t.info.status !== 'running') return
      t.info.status = status
      t.info.endedAt = Date.now()
      broadcastChanged()
    },
    setCancel: (fn) => {
      t.cancel = fn
    }
  }
}

/**
 * Start a job by its registered handler name. This is the frontend-facing
 * entry point: the renderer calls `background.job --name <handler> --args
 * <json>` and the actual work (download, transform, ...) runs here in the main
 * process, keeping the task alive across page switches.
 *
 * The handler runs in the background (never awaited by the caller): this
 * function returns the task snapshot immediately, so the IPC/command that
 * started it doesn't block for the whole job. The handler's promise resolving
 * → task finishes; rejecting → task marked errored.
 */
export async function startJobByName(
  name: string,
  args: Record<string, unknown> = {}
): Promise<BtTaskInfo | null> {
  const reg = jobHandlers.get(name)
  if (!reg) {
    log.warn('job handler not found', { name })
    return null
  }
  // Mode/platform gate closed → treat as unknown handler.
  if (reg.gate) {
    let ok = true
    try {
      ok = await reg.gate()
    } catch {
      ok = false
    }
    if (!ok) {
      log.warn('job handler gated off', { name })
      return null
    }
  }
  const { handler } = reg
  log.info('start job by name', { name, taskName: String(args.name ?? name) })
  const rawTags = args.tags
  const control = startJobTask({
    name: String(args.name ?? name),
    description: args.description ? String(args.description) : undefined,
    view: typeof args.view === 'string' ? args.view : 'log',
    tags: Array.isArray(rawTags) ? rawTags.map((x) => String(x)) : undefined,
    onCancel: undefined
  })
  // Fire-and-forget: do not await the job — return control to the caller.
  Promise.resolve()
    .then(() => handler(control, args))
    .then(() => control.finish('exited'))
    .catch((e) => {
      log.error('job handler failed', { name, error: e instanceof Error ? e.message : String(e) })
      control.pushLine(`[error] ${e instanceof Error ? e.message : String(e)}`, 'stderr')
      control.finish('error')
    })
  const t = [...tasks.values()].find((x) => x.info.id === control.id)
  return t ? snapshot(t) : null
}

/** Snapshot of every live background task. */
export function listTasks(): BtTaskInfo[] {
  return [...tasks.values()].map(snapshot)
}

/** Number of tasks currently running (used for quit-confirmation). */
export function runningTaskCount(): number {
  let n = 0
  for (const t of tasks.values()) {
    if (t.info.status === 'running') n++
  }
  return n
}

/** Buffered output messages of a task (oldest → newest). */
export function getTaskOutput(id: string): BtOutputMessage[] {
  const t = tasks.get(id)
  return t ? [...t.output] : []
}

/** Clear a task's buffered output (displayed output stays; buffer resets). */
export function clearTaskOutput(id: string): boolean {
  const t = tasks.get(id)
  if (!t) return false
  t.output = []
  t.info.outputCount = 0
  pendingOutput.delete(id)
  broadcastChanged()
  return true
}

/** Write raw data into a task's stdin (process tasks only). */
export function writeTaskInput(id: string, data: string): boolean {
  const t = tasks.get(id)
  if (!t?.write || t.info.status !== 'running') return false
  t.write(data)
  return true
}

/** Send a POSIX signal to a process task (e.g. SIGINT for Ctrl+C). */
export function signalTask(id: string, signal: NodeJS.Signals): boolean {
  const t = tasks.get(id)
  if (!t?.child) return false
  try {
    t.child.kill(signal)
    return true
  } catch {
    return false
  }
}

/**
 * Stop a task. Process: SIGTERM, escalate to SIGKILL after 3s. Job: call its
 * `onCancel`. Final status reflects how it stopped.
 */
export async function stopTask(id: string): Promise<boolean> {
  const t = tasks.get(id)
  if (!t || t.info.status !== 'running') return false
  if (t.child) {
    log.info('stopping process task', { id, name: t.info.name })
    t.stopRequested = true
    try {
      t.child.kill('SIGTERM')
    } catch {
      // ignore
    }
    t.forceTimer = setTimeout(() => {
      const cur = tasks.get(id)
      if (cur?.child) {
        try {
          cur.child.kill('SIGKILL')
        } catch {
          // ignore
        }
      }
    }, 3000)
    // status updates via the child's exit event
    return true
  }
  // job task
  t.info.status = 'cancelled'
  t.info.endedAt = Date.now()
  try {
    await t.cancel?.()
  } catch (e) {
    log.warn('job cancel failed', { id, error: e instanceof Error ? e.message : String(e) })
  }
  broadcastChanged()
  return true
}

/** Force-kill a process task immediately (SIGKILL). */
export function killTask(id: string): boolean {
  const t = tasks.get(id)
  if (!t?.child) return false
  try {
    t.child.kill('SIGKILL')
    return true
  } catch {
    return false
  }
}

/** Remove a finished/errored task from the registry. */
export function removeTask(id: string): boolean {
  const t = tasks.get(id)
  if (!t) return false
  if (t.info.status === 'running') return false
  if (t.forceTimer) clearTimeout(t.forceTimer)
  tasks.delete(id)
  broadcastChanged()
  return true
}

/** Remove every task that is no longer running (stopped / exited / error). */
export function clearFinishedTasks(): number {
  const removed: string[] = []
  for (const [id, t] of tasks) {
    if (t.info.status === 'running') continue
    if (t.forceTimer) clearTimeout(t.forceTimer)
    removed.push(id)
  }
  for (const id of removed) tasks.delete(id)
  if (removed.length) broadcastChanged()
  return removed.length
}

/** Kill every running child on app shutdown (tasks are attached to the app). */
export function shutdownBackgroundTasks(): void {
  for (const t of tasks.values()) {
    if (t.child && t.info.status === 'running') {
      try {
        t.child.kill('SIGKILL')
      } catch {
        // ignore
      }
    }
  }
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (statusTimer) {
    clearTimeout(statusTimer)
    statusTimer = null
  }
  statusDirty = false
  pendingOutput.clear()
}

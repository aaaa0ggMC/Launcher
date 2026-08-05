import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { readFile } from 'fs/promises'
import { run } from './util'
import { makeLogger } from './logger'
import type { BtTaskInfo } from '../../shared/types'

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
 *    stats (CPU / memory / GPU) polled from /proc, live console output, and
 *    interactive control.
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
  | { type: 'output'; id: string; lines: { stream: 'stdout' | 'stderr'; line: string }[] }
  | { type: 'exit'; id: string; code: number | null }

type Broadcast = (event: BackgroundEvent) => void

let broadcast: Broadcast = () => {}

export function setBackgroundBroadcast(fn: Broadcast): void {
  broadcast = fn
}

export interface StartProcessOptions {
  name: string
  description?: string
  argv: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface StartJobOptions {
  name: string
  description?: string
  /** called when the user stops/cancels the task */
  onCancel?: () => void | Promise<void>
}

/** Control handle returned for `job` tasks. */
export interface JobControl {
  id: string
  /** append a console line to the task's output */
  pushLine: (line: string, stream?: 'stdout' | 'stderr') => void
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

const jobHandlers = new Map<string, JobHandler>()

/** Register a named job handler (called once at ability/service load). */
export function registerJobHandler(name: string, handler: JobHandler): void {
  if (jobHandlers.has(name)) throw new Error(`重复作业处理器: ${name}`)
  jobHandlers.set(name, handler)
}

interface InternalTask {
  info: BtTaskInfo
  /** process tasks only */
  child?: ChildProcessWithoutNullStreams
  output: { stream: 'stdout' | 'stderr'; line: string }[]
  /** write to the process stdin (process tasks) */
  write?: (data: string) => void
  /** user-supplied cancellation for job tasks */
  cancel?: () => void | Promise<void>
  /** set when stopTask() sent SIGTERM — marks the eventual exit as "stopped" */
  stopRequested?: boolean
  lastCpu?: { utime: number; stime: number; at: number }
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
  const list = [...tasks.values()].map(snapshot)
  try {
    broadcast({ type: 'changed', tasks: list })
  } catch {
    // never break the task pipeline on broadcast errors
  }
}

/**
 * Output batching: live console lines are buffered and pushed to the renderer
 * every OUTPUT_BATCH_MS (100ms), not per-line. This keeps high-volume tasks
 * (log spam) from flooding the IPC socket — the panel refreshes in bounded
 * 100ms chunks instead of per-line sends. `cockpit:log` (the logging pipeline)
 * stays per-line real-time; this batching applies only to background-task
 * console output.
 */
const OUTPUT_BATCH_MS = 100
const OUTPUT_BATCH_MAX = 500

/** per-task id → pending lines not yet broadcast */
const pendingOutput = new Map<string, { stream: 'stdout' | 'stderr'; line: string }[]>()
let outputTimer: NodeJS.Timeout | null = null

function flushOutput(): void {
  outputTimer = null
  if (!pendingOutput.size) return
  for (const [id, lines] of pendingOutput) {
    pendingOutput.delete(id)
    if (!lines.length) continue
    try {
      broadcast({ type: 'output', id, lines })
    } catch {
      // never break the task pipeline on broadcast errors
    }
  }
}

function scheduleFlush(): void {
  if (outputTimer) return
  outputTimer = setTimeout(flushOutput, OUTPUT_BATCH_MS)
}

function appendOutput(t: InternalTask, stream: 'stdout' | 'stderr', line: string): void {
  t.output.push({ stream, line })
  if (t.output.length > MAX_OUTPUT_LINES) t.output.splice(0, t.output.length - MAX_OUTPUT_LINES)
  t.info.outputCount = t.output.length

  const q = pendingOutput.get(t.info.id) ?? []
  q.push({ stream, line })
  pendingOutput.set(t.info.id, q)
  scheduleFlush()
  // hard cap: a bursty task must not grow the pending buffer unbounded —
  // flush early if we've already queued a lot since the last window.
  if (q.length >= OUTPUT_BATCH_MAX) flushOutput()
}

/** Flush a task's queued lines immediately (used on exit so the tail isn't delayed). */
function flushTaskOutput(id: string): void {
  const q = pendingOutput.get(id)
  if (!q?.length) return
  pendingOutput.delete(id)
  try {
    broadcast({ type: 'output', id, lines: q })
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
    if (line.trim() || stream === 'stderr') appendOutput(t, stream, line)
  }
}

function onExit(t: InternalTask, code: number | null, signal: string | null = null): void {
  // Killed by stop/kill (SIGTERM/SIGKILL) → "stopped"; otherwise natural exit.
  const stopped = signal === 'SIGTERM' || signal === 'SIGKILL' || t.stopRequested === true
  t.info.status = stopped ? 'stopped' : 'exited'
  t.info.exitCode = code
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

/** Parse /proc/<pid>/stat → { utime, stime } in clock ticks. */
async function readProcStat(pid: number): Promise<{ utime: number; stime: number } | null> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf-8')
    // comm may contain spaces/parens — split on the first ')'
    const afterComm = raw.slice(raw.indexOf(')') + 1).trimStart()
    const f = afterComm.split(/\s+/)
    // fields: state=0 ppid=1 ... utime=11 stime=12
    const utime = Number(f[11]) || 0
    const stime = Number(f[12]) || 0
    return { utime, stime }
  } catch {
    return null
  }
}

/** Parse /proc/<pid>/status → resident memory in MB. */
async function readProcMem(pid: number): Promise<number | undefined> {
  try {
    const raw = await readFile(`/proc/${pid}/status`, 'utf-8')
    const m = raw.match(/VmRSS:\s+(\d+)\s*kB/)
    if (!m) return undefined
    return Math.round(Number(m[1]) / 1024)
  } catch {
    return undefined
  }
}

/** Poll stats for one process task (CPU delta + RSS + optional GPU). */
async function pollProcessTask(t: InternalTask): Promise<void> {
  const pid = t.info.pid
  if (!pid || !t.child) return
  const stat = await readProcStat(pid)
  const mem = await readProcMem(pid)
  if (mem !== undefined) t.info.stats.mem = mem

  // CPU: delta of utime+stime over wall time (assume 100 ticks/s, Linux).
  if (stat) {
    const total = stat.utime + stat.stime
    if (t.lastCpu) {
      const dt = (Date.now() - t.lastCpu.at) / 1000
      const dTicks = total - (t.lastCpu.utime + t.lastCpu.stime)
      if (dt > 0 && dTicks >= 0) {
        t.info.stats.cpu = Math.max(0, Math.round((dTicks / 100 / dt) * 100))
      }
    }
    t.lastCpu = { utime: stat.utime, stime: stat.stime, at: Date.now() }
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
      kind: 'process',
      status: 'running',
      pid: child.pid,
      command: opts.argv.join(' '),
      startedAt: Date.now(),
      stats: {},
      outputCount: 0,
      canInput: true,
      canSignal: true
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
    appendOutput(t, 'stderr', `[spawn error] ${err.message}`)
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
  log.info('start job task', { id, name: opts.name })
  const t: InternalTask = {
    info: {
      id,
      name: opts.name,
      description: opts.description,
      kind: 'job',
      status: 'running',
      startedAt: Date.now(),
      stats: {},
      outputCount: 0,
      canInput: false,
      canSignal: false
    },
    output: [],
    cancel: opts.onCancel
  }
  tasks.set(id, t)
  broadcastChanged()

  return {
    id,
    pushLine: (line, stream = 'stdout') => appendOutput(t, stream, line),
    setProgress: (p) => {
      t.info.progress = p
      broadcastChanged()
    },
    finish: (status = 'exited') => {
      if (t.info.status !== 'running') return
      t.info.status = status
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
export function startJobByName(
  name: string,
  args: Record<string, unknown> = {}
): BtTaskInfo | null {
  const handler = jobHandlers.get(name)
  if (!handler) {
    log.warn('job handler not found', { name })
    return null
  }
  log.info('start job by name', { name, taskName: String(args.name ?? name) })
  const control = startJobTask({
    name: String(args.name ?? name),
    description: args.description ? String(args.description) : undefined,
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

/** Buffered output lines of a task (oldest → newest). */
export function getTaskOutput(id: string): { stream: 'stdout' | 'stderr'; line: string }[] {
  const t = tasks.get(id)
  return t ? [...t.output] : []
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
  if (outputTimer) {
    clearTimeout(outputTimer)
    outputTimer = null
  }
  pendingOutput.clear()
}

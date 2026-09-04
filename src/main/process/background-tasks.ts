import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process'
import http from 'http'
import pidusage from 'pidusage'
import { run } from './util'
import { makeLogger } from './logger'
import type { BtGpuInfo, BtNetworkPort, BtOutputMessage, BtTaskInfo } from '../../shared/types'

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
  options?: StartProcessOptions
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
// Resource & network port stats (Cross-platform)
// ---------------------------------------------------------------------------

/** Cache probed web ports (TTL: 15s) */
const webProbeCache = new Map<
  number,
  { type: 'web' | 'tcp' | 'udp'; url?: string; title?: string; expires: number }
>()

/** Probe a TCP port to determine if it hosts a Web (HTTP) service */
function probeWebPort(
  port: number
): Promise<{ type: 'web' | 'tcp' | 'udp'; url?: string; title?: string }> {
  const now = Date.now()
  const cached = webProbeCache.get(port)
  if (cached && cached.expires > now) {
    return Promise.resolve({ type: cached.type, url: cached.url, title: cached.title })
  }

  return new Promise((resolve) => {
    let resolved = false
    const done = (res: { type: 'web' | 'tcp' | 'udp'; url?: string; title?: string }): void => {
      if (resolved) return
      resolved = true
      webProbeCache.set(port, { ...res, expires: Date.now() + 15000 })
      resolve(res)
    }

    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/',
        headers: { Accept: 'text/html,application/xhtml+xml,application/json,*/*' },
        timeout: 500
      },
      (res) => {
        let rawBody = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          rawBody = (rawBody + chunk).slice(0, 2048)
        })
        res.on('end', () => {
          let title: string | undefined
          const match = rawBody.match(/<title[^>]*>([^<]+)<\/title>/i)
          if (match) title = match[1].trim()
          done({
            type: 'web',
            url: `http://127.0.0.1:${port}`,
            title
          })
        })
      }
    )

    req.on('error', () => {
      // If plain HTTP fails, maybe it's raw TCP
      done({ type: 'tcp' })
    })

    req.on('timeout', () => {
      req.destroy()
      done({ type: 'tcp' })
    })
  })
}

/** Recursively collect child process PIDs for a root PID */
async function getProcessTreePids(rootPid: number): Promise<number[]> {
  const pids = new Set<number>([rootPid])
  if (process.platform === 'linux' || process.platform === 'darwin') {
    try {
      const out = await run('pgrep', ['-P', String(rootPid)], { timeout: 1000 }).catch(() => '')
      if (out) {
        for (const line of out.split('\n')) {
          const childPid = parseInt(line.trim(), 10)
          if (!isNaN(childPid) && childPid > 0 && !pids.has(childPid)) {
            pids.add(childPid)
            const grandchildren = await getProcessTreePids(childPid).catch(() => [childPid])
            for (const gc of grandchildren) pids.add(gc)
          }
        }
      }
    } catch {
      // ignore
    }
  } else if (process.platform === 'win32') {
    try {
      const out = await run(
        'wmic',
        ['process', 'where', `(ParentProcessId=${rootPid})`, 'get', 'ProcessId'],
        { timeout: 1000 }
      ).catch(() => '')
      if (out) {
        for (const line of out.split('\n')) {
          const childPid = parseInt(line.trim(), 10)
          if (!isNaN(childPid) && childPid > 0 && !pids.has(childPid)) {
            pids.add(childPid)
          }
        }
      }
    } catch {
      // ignore
    }
  }
  return [...pids]
}

/** Kill an entire process tree (cross-platform). */
async function killProcessTree(rootPid: number, signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(rootPid)])
    } catch {
      // ignore
    }
    return
  }

  try {
    const pids = await getProcessTreePids(rootPid)
    const pidList = [...pids].reverse()
    for (const pid of pidList) {
      try {
        process.kill(pid, signal)
      } catch {
        // already exited
      }
    }
    try {
      process.kill(-rootPid, signal)
    } catch {
      // ignore
    }
  } catch {
    try {
      process.kill(rootPid, signal)
    } catch {
      // ignore
    }
  }
}

/** Query listening and occupied network ports for given PIDs */
async function getListeningPorts(pids: number[]): Promise<BtNetworkPort[]> {
  if (!pids.length) return []
  const pidSet = new Set(pids)
  const results: BtNetworkPort[] = []
  const seenKey = new Set<string>()

  if (process.platform === 'linux') {
    // 1. Try ss -H -tulpn
    try {
      const out = await run('ss', ['-H', '-tulpn'], { timeout: 1500 }).catch(() => '')
      if (out) {
        for (const line of out.split('\n')) {
          if (!line.trim()) continue
          let matched = false
          for (const p of pidSet) {
            if (line.includes(`pid=${p},`) || line.includes(`pid=${p})`)) {
              matched = true
              break
            }
          }
          if (!matched) continue

          const parts = line.trim().split(/\s+/)
          if (parts.length < 5) continue
          const proto = parts[0].toLowerCase().startsWith('udp')
            ? ('udp' as const)
            : ('tcp' as const)
          const state = parts[1]
          const local = parts[4]
          const lastColon = local.lastIndexOf(':')
          if (lastColon < 0) continue
          const localAddress = local.slice(0, lastColon)
          const port = parseInt(local.slice(lastColon + 1), 10)
          if (isNaN(port) || port <= 0) continue

          const key = `${proto}:${port}`
          if (seenKey.has(key)) continue
          seenKey.add(key)

          let type: 'web' | 'tcp' | 'udp' = proto === 'udp' ? 'udp' : 'tcp'
          let url: string | undefined
          let title: string | undefined

          if (proto === 'tcp') {
            const probe = await probeWebPort(port)
            type = probe.type
            url = probe.url
            title = probe.title
          }

          results.push({
            proto,
            localAddress,
            port,
            state,
            type,
            url,
            title
          })
        }
      }
    } catch {
      // ignore
    }

    // Fallback to lsof
    if (!results.length) {
      try {
        const out = await run('lsof', ['-iTCP', '-iUDP', '-P', '-n', '-a', '-p', pids.join(',')], {
          timeout: 1500
        }).catch(() => '')
        if (out) {
          for (const line of out.split('\n')) {
            if (line.startsWith('COMMAND') || !line.trim()) continue
            const parts = line.trim().split(/\s+/)
            if (parts.length < 9) continue
            const protoStr = parts[7]?.toLowerCase() ?? ''
            const proto = protoStr.includes('udp') ? ('udp' as const) : ('tcp' as const)
            const nameField = parts[8] ?? ''
            const state = parts[9] ? parts[9].replace(/[()]/g, '') : undefined
            const lastColon = nameField.lastIndexOf(':')
            if (lastColon < 0) continue
            const localAddress = nameField.slice(0, lastColon)
            const port = parseInt(nameField.slice(lastColon + 1), 10)
            if (isNaN(port) || port <= 0) continue

            const key = `${proto}:${port}`
            if (seenKey.has(key)) continue
            seenKey.add(key)

            let type: 'web' | 'tcp' | 'udp' = proto === 'udp' ? 'udp' : 'tcp'
            let url: string | undefined
            let title: string | undefined

            if (proto === 'tcp') {
              const probe = await probeWebPort(port)
              type = probe.type
              url = probe.url
              title = probe.title
            }

            results.push({
              proto,
              localAddress,
              port,
              state,
              type,
              url,
              title
            })
          }
        }
      } catch {
        // ignore
      }
    }
  } else if (process.platform === 'win32') {
    try {
      const out = await run('netstat', ['-ano'], { timeout: 2000 }).catch(() => '')
      if (out) {
        for (const line of out.split('\n')) {
          const parts = line.trim().split(/\s+/)
          if (parts.length < 4) continue
          const lastPart = parts[parts.length - 1]
          const pid = parseInt(lastPart, 10)
          if (!pidSet.has(pid)) continue

          const protoStr = parts[0].toLowerCase()
          const proto = protoStr.startsWith('udp') ? ('udp' as const) : ('tcp' as const)
          const local = parts[1]
          const lastColon = local.lastIndexOf(':')
          if (lastColon < 0) continue
          const localAddress = local.slice(0, lastColon)
          const port = parseInt(local.slice(lastColon + 1), 10)
          if (isNaN(port) || port <= 0) continue
          const state = proto === 'tcp' ? parts[3] : undefined

          const key = `${proto}:${port}`
          if (seenKey.has(key)) continue
          seenKey.add(key)

          let type: 'web' | 'tcp' | 'udp' = proto === 'udp' ? 'udp' : 'tcp'
          let url: string | undefined
          let title: string | undefined

          if (proto === 'tcp') {
            const probe = await probeWebPort(port)
            type = probe.type
            url = probe.url
            title = probe.title
          }

          results.push({
            proto,
            localAddress,
            port,
            state,
            type,
            url,
            title
          })
        }
      }
    } catch {
      // ignore
    }
  } else if (process.platform === 'darwin') {
    try {
      const out = await run('lsof', ['-iTCP', '-iUDP', '-P', '-n', '-a', '-p', pids.join(',')], {
        timeout: 1500
      }).catch(() => '')
      if (out) {
        for (const line of out.split('\n')) {
          if (line.startsWith('COMMAND') || !line.trim()) continue
          const parts = line.trim().split(/\s+/)
          if (parts.length < 9) continue
          const protoStr = parts[7]?.toLowerCase() ?? ''
          const proto = protoStr.includes('udp') ? ('udp' as const) : ('tcp' as const)
          const nameField = parts[8] ?? ''
          const state = parts[9] ? parts[9].replace(/[()]/g, '') : undefined
          const lastColon = nameField.lastIndexOf(':')
          if (lastColon < 0) continue
          const localAddress = nameField.slice(0, lastColon)
          const port = parseInt(nameField.slice(lastColon + 1), 10)
          if (isNaN(port) || port <= 0) continue

          const key = `${proto}:${port}`
          if (seenKey.has(key)) continue
          seenKey.add(key)

          let type: 'web' | 'tcp' | 'udp' = proto === 'udp' ? 'udp' : 'tcp'
          let url: string | undefined
          let title: string | undefined

          if (proto === 'tcp') {
            const probe = await probeWebPort(port)
            type = probe.type
            url = probe.url
            title = probe.title
          }

          results.push({
            proto,
            localAddress,
            port,
            state,
            type,
            url,
            title
          })
        }
      }
    } catch {
      // ignore
    }
  }

  return results
}

/**
 * Poll CPU & memory stats for one process task and its child process tree via `pidusage`.
 */
async function pollProcessTask(t: InternalTask, pids: number[]): Promise<void> {
  if (!pids.length || !t.child) return
  try {
    let totalCpu = 0
    let totalMem = 0
    let ppid: number | undefined
    let elapsed: number | undefined

    for (const p of pids) {
      try {
        const stat = await pidusage(p)
        totalCpu += stat.cpu
        totalMem += stat.memory
        if (p === t.info.pid) {
          ppid = stat.ppid
          elapsed = stat.elapsed
        }
      } catch {
        // child might have exited
      }
    }

    t.info.stats.cpu = Math.max(0, Math.round(totalCpu))
    const memMb = Math.round(totalMem / 1024 / 1024)
    t.info.stats.mem = memMb
    t.info.stats.memDetails = { rss: memMb }
    if (ppid) t.info.stats.ppid = ppid
    if (elapsed) t.info.stats.elapsed = elapsed
  } catch {
    // process gone / not inspectable → keep last known stats
  }
}

/** Query GPU details and memory via nvidia-smi. */
async function pollGpuInfo(pids: number[]): Promise<{
  globalGpu?: BtGpuInfo
  processVramMap: Map<number, number>
}> {
  const processVramMap = new Map<number, number>()
  let globalGpu: BtGpuInfo | undefined

  try {
    const gpuOut = await run(
      'nvidia-smi',
      [
        '--query-gpu=index,name,utilization.gpu,memory.total,memory.used,temperature.gpu',
        '--format=csv,noheader,nounits'
      ],
      { timeout: 3000 }
    ).catch(() => '')
    if (gpuOut) {
      const line = gpuOut.trim().split('\n')[0]
      if (line) {
        const [, name, util, total, used, temp] = line.split(',').map((s) => s.trim())
        globalGpu = {
          name,
          utilization: util ? Number(util) : undefined,
          totalMemory: total ? Number(total) : undefined,
          usedMemory: used ? Number(used) : undefined,
          temperature: temp ? Number(temp) : undefined
        }
      }
    }

    if (pids.length) {
      const appOut = await run(
        'nvidia-smi',
        ['--query-compute-apps=pid,used_gpu_memory', '--format=csv,noheader,nounits'],
        { timeout: 3000 }
      ).catch(() => '')
      if (appOut) {
        for (const line of appOut.split('\n')) {
          const m = line.match(/(\d+)\s*,\s*(\d+)/)
          if (m) processVramMap.set(Number(m[1]), Number(m[2]))
        }
      }
    }
  } catch {
    // ignore
  }

  return { globalGpu, processVramMap }
}

async function poll(): Promise<void> {
  const running = [...tasks.values()].filter((t) => t.info.status === 'running')
  if (!running.length) {
    maybeStopPolling()
    return
  }

  const taskPidsMap = new Map<string, number[]>()
  const allPids: number[] = []

  for (const t of running) {
    if (t.info.pid) {
      const tree = await getProcessTreePids(t.info.pid)
      taskPidsMap.set(t.info.id, tree)
      allPids.push(...tree)
    }
  }

  const { globalGpu, processVramMap } = await pollGpuInfo(allPids)

  for (const t of running) {
    if (t.info.status !== 'running') continue
    const treePids = taskPidsMap.get(t.info.id) ?? (t.info.pid ? [t.info.pid] : [])
    await pollProcessTask(t, treePids)

    // GPU stats
    let totalProcVram = 0
    let hasProcVram = false
    for (const p of treePids) {
      if (processVramMap.has(p)) {
        totalProcVram += processVramMap.get(p)!
        hasProcVram = true
      }
    }
    if (hasProcVram) {
      t.info.stats.gpu = totalProcVram
    }
    if (globalGpu) {
      t.info.stats.gpuInfo = {
        ...globalGpu,
        processMemory: hasProcVram ? totalProcVram : undefined
      }
    }

    // Network ports
    if (treePids.length) {
      const ports = await getListeningPorts(treePids)
      t.info.stats.ports = ports
    }
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
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
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
      argv: opts.argv,
      cwd: opts.cwd,
      startedAt: Date.now(),
      stats: {},
      outputCount: 0,
      canInput: true,
      canSignal: true,
      tags: opts.tags
    },
    options: opts,
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
    if (t.child === child) {
      log.error('process task error', { id, error: err.message })
      appendOutput(t, { stream: 'stderr', line: `[spawn error] ${err.message}` })
      onExit(t, null)
    }
  })
  child.on('exit', (code, signal) => {
    if (t.child === child) {
      onExit(t, code, signal)
    }
  })

  broadcastChanged()
  ensurePolling()
  return snapshot(t)
}

/**
 * Restart a background process task using its original launch options.
 */
export async function restartTask(id: string): Promise<boolean> {
  const t = tasks.get(id)
  if (!t) return false
  if (t.info.kind !== 'process' || !t.options) {
    log.warn('restartTask: task is not a restartable process', { id })
    return false
  }

  log.info('restarting process task', { id, name: t.info.name })

  // 1. Cleanly terminate and unbind existing child process if still running
  const oldChild = t.child
  if (oldChild) {
    oldChild.removeAllListeners('exit')
    oldChild.removeAllListeners('error')
    oldChild.removeAllListeners('close')
    if (oldChild.stdout) oldChild.stdout.removeAllListeners()
    if (oldChild.stderr) oldChild.stderr.removeAllListeners()
    if (oldChild.pid) {
      await killProcessTree(oldChild.pid, 'SIGKILL')
    }
    t.child = undefined
  }
  if (t.forceTimer) {
    clearTimeout(t.forceTimer)
    t.forceTimer = undefined
  }

  // 2. Append visually striking restart banner to output (bright ANSI colors & divider)
  const time = new Date().toLocaleTimeString()
  appendOutput(t, {
    line: `\x1b[1;36m\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`
  })
  appendOutput(t, {
    line: `\x1b[1;97;44m 🚀 [${time}] 任务已触发重启 / Restarting Task... \x1b[0m`
  })
  appendOutput(t, {
    line: `\x1b[1;36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n`
  })

  // 3. Re-spawn process with saved options
  const opts = t.options
  const [cmd, ...args] = opts.argv
  try {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })

    t.child = child
    t.info.status = 'running'
    t.info.pid = child.pid
    t.info.startedAt = Date.now()
    t.info.endedAt = undefined
    t.info.exitCode = undefined
    t.info.stats = {}

    t.write = (data) => {
      try {
        child.stdin.write(data)
      } catch (e) {
        log.warn('stdin write failed', { id, error: e instanceof Error ? e.message : String(e) })
      }
    }

    const outBuf = { rest: '' }
    const errBuf = { rest: '' }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => streamLines(t, 'stdout', d, outBuf))
    child.stderr.on('data', (d: string) => streamLines(t, 'stderr', d, errBuf))
    child.on('error', (err) => {
      if (t.child === child) {
        log.error('process task error', { id, error: err.message })
        appendOutput(t, { stream: 'stderr', line: `[spawn error] ${err.message}` })
        onExit(t, null)
      }
    })
    child.on('exit', (code, signal) => {
      if (t.child === child) {
        onExit(t, code, signal)
      }
    })

    broadcastChanged()
    ensurePolling()
    return true
  } catch (err) {
    log.error('process task restart spawn threw', {
      id,
      error: err instanceof Error ? err.message : String(err)
    })
    appendOutput(t, {
      stream: 'stderr',
      line: `[restart error] ${err instanceof Error ? err.message : String(err)}`
    })
    t.info.status = 'error'
    broadcastChanged()
    return false
  }
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
  if (t.child && t.child.pid) {
    const pid = t.child.pid
    log.info('stopping process task', { id, name: t.info.name })
    t.stopRequested = true
    void killProcessTree(pid, 'SIGTERM')
    t.forceTimer = setTimeout(() => {
      const cur = tasks.get(id)
      if (cur?.child && cur.child.pid) {
        void killProcessTree(cur.child.pid, 'SIGKILL')
      }
    }, 3000)
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
  if (!t?.child || !t.child.pid) return false
  void killProcessTree(t.child.pid, 'SIGKILL')
  return true
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
    if (t.child && t.child.pid && t.info.status === 'running') {
      if (process.platform === 'win32') {
        try {
          spawnSync('taskkill', ['/F', '/T', '/PID', String(t.child.pid)])
        } catch {
          // ignore
        }
      } else {
        try {
          process.kill(-t.child.pid, 'SIGKILL')
        } catch {
          // ignore
        }
        try {
          t.child.kill('SIGKILL')
        } catch {
          // ignore
        }
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

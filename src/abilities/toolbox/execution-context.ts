import { AsyncLocalStorage } from 'node:async_hooks'
import type { ChildProcess } from 'node:child_process'

const signalContext = new AsyncLocalStorage<AbortSignal>()
const children = new Map<ChildProcess, boolean>()
export function withToolSignal<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  return signalContext.run(signal, run)
}
export function toolSignal(): AbortSignal | undefined {
  return signalContext.getStore()
}
export function killToolProcess(child: ChildProcess, detached = false): void {
  if (!child.pid || child.exitCode !== null) return
  if (detached && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      /* Process group already exited. */
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* Process already exited. */
  }
}
export function trackToolProcess(child: ChildProcess, detached: boolean): () => void {
  children.set(child, detached)
  const signal = toolSignal()
  const abort = (): void => killToolProcess(child, detached)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const cleanup = (): void => {
    children.delete(child)
    signal?.removeEventListener('abort', abort)
  }
  child.once('close', cleanup)
  return cleanup
}
export function stopToolProcesses(): void {
  for (const [child, detached] of children) killToolProcess(child, detached)
}
process.once('exit', stopToolProcesses)

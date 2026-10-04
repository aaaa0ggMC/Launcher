import { spawn } from 'node:child_process'

/** 取消 Shell 时清理整组子进程，避免只杀掉 shell 而让脚本继续写文件。 */
export function runShell(
  command: string,
  opts: { cwd: string; timeout: number; maxBuffer: number; signal: AbortSignal }
): Promise<{ stdout: string; stderr: string }> {
  opts.signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], {
      cwd: opts.cwd,
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let failure: Error | null = null
    const terminate = (error: Error): void => {
      if (failure) return
      failure = error
      if (!child.pid) return
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore'
        })
        killer.on('error', () => child.kill())
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
    }
    const collect = (target: Buffer[], data: Buffer): void => {
      const remaining = Math.max(0, opts.maxBuffer - bytes)
      target.push(data.subarray(0, remaining))
      bytes += data.length
      if (bytes > opts.maxBuffer) terminate(new Error('Shell output exceeded its size limit'))
    }
    child.stdout.on('data', (data: Buffer) => collect(stdout, data))
    child.stderr.on('data', (data: Buffer) => collect(stderr, data))
    const onAbort = (): void => terminate(new Error('Shell execution aborted'))
    opts.signal.addEventListener('abort', onAbort, { once: true })
    if (opts.signal.aborted) onAbort()
    const timer = setTimeout(() => terminate(new Error('Shell execution timed out')), opts.timeout)
    const cleanup = (): void => {
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
    }
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('close', (code) => {
      cleanup()
      const output = {
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString()
      }
      if (failure || code !== 0) {
        reject(
          Object.assign(failure ?? new Error(`Shell exited with code ${code}`), output, { code })
        )
      } else resolve(output)
    })
  })
}

import { createWriteStream } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname, resolve } from 'path'
import { homedir } from 'os'
import { registerJobHandler, type JobControl } from '../../main/process/background-tasks'
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('background-jobs')

/**
 * Registered job handlers for the background-task framework.
 *
 * These demonstrate the "frontend-triggered, backend-run" pattern: the renderer
 * calls `background.job --name download ...` (or any ability calls
 * `startJobByName('download', ...)`), and the actual I/O runs here in the main
 * process. The task outlives page switches and can be stopped/cancelled from
 * the global Background Tasks panel.
 */

/** Expand `~/` and relative paths against the home dir. */
function resolveOut(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2))
  return resolve(p)
}

/**
 * Stream a URL to a local file. Supports cancellation (aborts the fetch and
 * cleans up the partial file). `args`:
 *  - name?: display name
 *  - url: source URL
 *  - out: destination path (supports `~/`)
 */
registerJobHandler('download', async (control: JobControl, args: Record<string, unknown>) => {
  const url = String(args.url ?? '')
  const out = resolveOut(String(args.out ?? ''))
  if (!url || !args.out) {
    control.pushLine('缺少参数: 需要 --args {"url": "...", "out": "..."}', 'stderr')
    control.finish('error')
    return
  }

  const started = Date.now()
  log.info('job download start', { url, out })
  control.pushLine(`下载 ${url}`)
  control.pushLine(`保存到 ${out}`)
  control.setProgress(undefined)

  const ac = new AbortController()
  control.setCancel(() => {
    ac.abort()
  })

  await mkdir(dirname(out), { recursive: true })

  let res: Response
  try {
    res = await fetch(url, { signal: ac.signal })
  } catch (e) {
    if (ac.signal.aborted) {
      control.pushLine('已取消', 'stderr')
      control.finish('cancelled')
    } else {
      control.pushLine(`请求失败: ${e instanceof Error ? e.message : String(e)}`, 'stderr')
      control.finish('error')
    }
    return
  }
  if (!res.ok || !res.body) {
    control.pushLine(`HTTP ${res.status} ${res.statusText}`, 'stderr')
    log.warn('job download http error', { url, out, status: res.status })
    control.finish('error')
    return
  }

  const total = Number(res.headers.get('content-length')) || 0
  const writer = createWriteStream(out)
  const reader = res.body.getReader()
  let received = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      writer.write(Buffer.from(value))
      if (total > 0) {
        control.setProgress(Math.min(99, Math.round((received / total) * 100)))
      }
    }
    await new Promise<void>((resolveStream, rejectStream) => {
      writer.end((err) => (err ? rejectStream(err) : resolveStream()))
    })
    control.setProgress(100)
    control.pushLine(`完成: ${received} 字节 → ${out}`)
    control.finish('exited')
    log.info('job download done', { url, out, received, total, durationMs: Date.now() - started })
  } catch (e) {
    if (ac.signal.aborted) {
      control.pushLine('已取消，删除不完整文件', 'stderr')
      control.finish('cancelled')
    } else {
      control.pushLine(`下载失败: ${e instanceof Error ? e.message : String(e)}`, 'stderr')
      control.finish('error')
    }
  }
})

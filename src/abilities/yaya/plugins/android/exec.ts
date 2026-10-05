/**
 * 安卓控制插件的命令执行层：Termux:API（`termux-*`）与 Shizuku（`rish`）都是本机命令。
 * 固定程序 + 参数数组（execFile，不经 shell）；`rish -c` 的命令行由调用方决定，属于 system.exec。
 */
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

/** PATH 里有没有这个可执行文件（结果缓存 30 秒：分组状态在每次解析工具表时都会查） */
const found = new Map<string, { at: number; ok: boolean }>()
export function hasCommand(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const hit = found.get(name)
  if (hit && Date.now() - hit.at < 30_000) return hit.ok
  let ok = false
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    try {
      accessSync(join(dir, name), constants.X_OK)
      ok = true
      break
    } catch {
      /* 下一个目录 */
    }
  }
  found.set(name, { at: Date.now(), ok })
  return ok
}

/** 测试用：清掉探测缓存 */
export function resetCommandCache(): void {
  found.clear()
}

export interface RunResult {
  stdout: Buffer
  stderr: string
}

export function run(
  cmd: string,
  args: string[],
  opts: { signal: AbortSignal; timeoutMs?: number; input?: string }
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      {
        encoding: 'buffer',
        maxBuffer: 32 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 30_000,
        signal: opts.signal
      },
      (err, stdout, stderr) => {
        const errText = stderr.toString('utf8').trim()
        if (err) {
          const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
          reject(
            new Error(
              missing
                ? `\`${cmd}\` is not installed on the host`
                : `${cmd} failed: ${errText || err.message}`.slice(0, 2000)
            )
          )
        } else resolve({ stdout, stderr: errText })
      }
    )
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })
}

/** termux-* 大多输出 JSON；解析失败就原样返回文本 */
export function parseOutput(buf: Buffer): unknown {
  const text = buf.toString('utf8').trim()
  if (!text) return { ok: true }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

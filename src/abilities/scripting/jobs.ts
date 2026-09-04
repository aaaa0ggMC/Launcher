import { registerJobHandler, type JobControl } from '../../main/process/background-tasks'
import { executeScript } from './service'
import type { ConsoleLineType, ScriptLanguage } from './types'

/**
 * Register background job handler for scripts.
 * Enables long-running workflows to run asynchronously in the background.
 */
registerJobHandler('script-run', async (control: JobControl, args: Record<string, unknown>) => {
  const code = String(args.code ?? '')
  const language = (args.language as ScriptLanguage) || 'ts'
  const ac = new AbortController()

  control.setCancel(() => {
    ac.abort()
  })

  control.pushLine(`[Script] 后台任务启动 (${language.toUpperCase()})`)

  const res = await executeScript(code, language, {
    signal: ac.signal,
    onProgress: (pct, msg) => {
      control.setProgress(pct)
      if (msg) control.push({ label: msg })
    },
    onLog: (type: ConsoleLineType, text: string) => {
      const stream = type === 'error' || type === 'stderr' ? 'stderr' : 'stdout'
      control.pushLine(`[${type}] ${text}`, stream)
    }
  })

  if (ac.signal.aborted) {
    control.pushLine('[Script] 任务已取消', 'stderr')
    control.finish('cancelled')
  } else if (!res.ok) {
    control.pushLine(`[Script] 执行失败: ${res.error}`, 'stderr')
    control.finish('error')
  } else {
    control.setProgress(100)
    control.pushLine(`[Script] 任务执行完成 (耗时 ${res.durationMs}ms)`)
    if (res.result !== undefined) {
      control.push({ data: res.result })
    }
    control.finish('exited')
  }
})

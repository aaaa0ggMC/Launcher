import { registerJobHandler, type JobControl } from '../../main/process/background-tasks'
import type { RespTransform } from './types'
import {
  resolveJsonPath,
  interpolate,
  applyTransforms,
  type TransformResult
} from './parser/variableParser'
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('playground')

interface PollState {
  transformId: string
  label: string
  status: 'polling' | 'done' | 'failed'
  statusText: string
  failReason: string
  results: TransformResult[]
}

/**
 * Poll a set of task transforms until they settle, then apply their nested
 * transforms. Recurses into `taskTransforms` (a task whose sub-transforms
 * include further tasks), so arbitrarily nested async pipelines work.
 *
 * Returns the combined TransformResults: each top-level task becomes a
 * `text` wrapper whose `children` are its sub-results (or an Error child).
 */
async function pollTaskTransforms(
  transforms: RespTransform[],
  initialResponse: string,
  variables: Record<string, string>,
  signal: AbortSignal,
  pollMs: number
): Promise<TransformResult[]> {
  let json: unknown
  try {
    json = JSON.parse(initialResponse)
  } catch {
    return []
  }

  const tfList = transforms.filter((t) => t.type === 'task' && t.taskAddr)
  if (!tfList.length) return []

  const states: PollState[] = tfList.map((t) => ({
    transformId: t.id,
    label: t.label || 'Task',
    status: 'polling',
    statusText: 'Starting...',
    failReason: '',
    results: []
  }))

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal.aborted) throw new DOMException('cancelled', 'AbortError')
    let allDone = true
    for (let i = 0; i < states.length; i++) {
      if (states[i].status !== 'polling') continue
      const tf = tfList[i]
      if (!tf) continue
      try {
        // Address/query templates support BOTH {var} interpolation and
        // {.jsonpath} extraction from the initial response, plus {task_id}.
        const taskId = resolveJsonPath(json, tf.entry?.trim() ?? '')
        const resolveAddr = (tpl: string): string =>
          interpolate(tpl, variables)
            .replace(/\{\.([^}]+)\}/g, (_, path: string) =>
              String(resolveJsonPath(json, path.trim()) ?? '')
            )
            .replace(/\{task_id\}/g, String(taskId ?? ''))
        const taskAddr = resolveAddr(tf.taskAddr ?? '')
        const taskQueryRaw = resolveAddr(tf.taskQuery ?? '')
        const taskHeaders = resolveAddr(tf.taskHeaders ?? '')

        let queryStr: string
        if (taskQueryRaw) {
          queryStr = taskQueryRaw
          // task_id is already resolved from {.task_id} or {task_id} above;
          // only append it when the template didn't carry one.
          if (taskId != null && !/task_id=/.test(queryStr)) {
            queryStr += (queryStr ? '&' : '') + `task_id=${taskId}`
          }
        } else {
          queryStr = `task_id=${taskId ?? ''}`
        }
        // The resolved taskAddr may already embed task_id — avoid duplicating it.
        const sep = taskAddr.includes('?') ? '&' : '?'
        const base = taskAddr.includes('task_id=') ? taskAddr : taskAddr
        const url =
          base.includes('task_id=') && queryStr.startsWith('task_id=')
            ? base
            : base + sep + queryStr

        const headers: Record<string, string> = {}
        if (taskHeaders) {
          for (const line of taskHeaders.split('\n')) {
            const idx = line.indexOf(':')
            if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
          }
        }
        const resp = await fetch(url, {
          method: tf.taskMethod || 'GET',
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          signal
        })
        const text = await resp.text()
        if (resp.status === 400) {
          states[i] = { ...states[i], status: 'failed', statusText: text, failReason: text }
          log.warn('pg-task transform failed', {
            transformId: tf.id,
            taskUrl: url,
            httpStatus: resp.status,
            failReason: text.slice(0, 500)
          })
          continue
        }
        let respJson: unknown
        try {
          respJson = JSON.parse(text)
        } catch {
          respJson = {}
        }
        const statusVal = String(resolveJsonPath(respJson, tf.taskStatusPath) ?? '')
        const failReason = String(resolveJsonPath(respJson, tf.taskFailReasonPath) ?? '')
        if (tf.taskFailVal && statusVal === tf.taskFailVal) {
          states[i] = {
            ...states[i],
            status: 'failed',
            statusText: failReason || statusVal,
            failReason: failReason || statusVal
          }
          log.warn('pg-task transform failed', {
            transformId: tf.id,
            taskUrl: url,
            httpStatus: resp.status,
            statusVal,
            failReason: failReason || statusVal
          })
        } else if (statusVal === tf.taskStatusVal) {
          // Sub-transforms may themselves contain tasks → recurse.
          const nested = await pollTaskTransforms(
            tf.taskTransforms ?? [],
            text,
            variables,
            signal,
            pollMs
          )
          const rest = (tf.taskTransforms ?? []).filter((s) => s.type !== 'task')
          const results = rest.length ? await applyTransforms(text, rest) : []
          const rawResult: TransformResult = { kind: 'text', label: 'Raw Response', value: text }
          states[i] = {
            ...states[i],
            status: 'done',
            statusText: 'Success',
            results: [rawResult, ...results, ...nested]
          }
        } else {
          states[i] = { ...states[i], statusText: statusVal || 'Processing...' }
          allDone = false
        }
        log.debug('pg-task transform poll', {
          transformId: tf.id,
          taskUrl: url,
          httpStatus: resp.status,
          statusVal,
          failReason
        })
      } catch (err) {
        if (signal.aborted) throw err
        states[i] = {
          ...states[i],
          status: 'failed',
          statusText: err instanceof Error ? err.message : String(err),
          failReason: err instanceof Error ? err.message : String(err)
        }
        log.warn('pg-task transform failed', {
          transformId: tf.id,
          failReason: err instanceof Error ? err.message : String(err)
        })
      }
    }
    if (allDone) break
    await new Promise((r) => setTimeout(r, pollMs))
  }

  return states.map((s) => {
    const children =
      s.status === 'failed'
        ? [{ kind: 'text' as const, label: 'Error', value: s.failReason }]
        : s.results
    return { kind: 'text', label: s.label, value: '', children }
  })
}

/**
 * Playground async-task job — runs in the main process so the poll survives
 * page switches. Progress is pushed as `progress` messages while polling; the
 * final structured TransformResults are pushed as one `data` message for the
 * task's `response` view. Supports nested tasks via recursion.
 */
registerJobHandler('pg-task', async (control: JobControl, args: Record<string, unknown>) => {
  const transforms = (args.transforms ?? []) as RespTransform[]
  const initialResponse = String(args.initialResponse ?? '')
  const pollMs = Number(args.pollMs ?? 2000)

  control.pushLine('任务轮询中…')
  const ac = new AbortController()
  control.setCancel(() => ac.abort())

  const taskTransforms = transforms.filter((t) => t.type === 'task' && t.taskAddr)
  if (!taskTransforms.length) {
    control.push({ data: [] })
    control.finish('exited')
    return
  }

  // Periodic progress ticks while polling.
  const tick = setInterval(() => {
    if (!ac.signal.aborted) {
      control.push({ label: '轮询中…' })
    }
  }, 1500)

  try {
    const allResults = await pollTaskTransforms(
      taskTransforms,
      initialResponse,
      (args.variables ?? {}) as Record<string, string>,
      ac.signal,
      pollMs
    )
    const done = allResults.filter((r) => r.children?.[0]?.label !== 'Error').length
    log.info('pg-task done', {
      taskTransforms: taskTransforms.length,
      results: allResults.length,
      done,
      failed: allResults.length - done
    })
    control.setProgress(100)
    control.push({ data: allResults })
    control.finish('exited')
  } catch (err) {
    if (ac.signal.aborted) {
      control.pushLine('已取消', 'stderr')
      control.finish('cancelled')
    } else {
      const msg = err instanceof Error ? err.message : String(err)
      control.push({ data: [{ kind: 'text', label: 'Error', value: msg }] })
      control.finish('error')
    }
  } finally {
    clearInterval(tick)
  }
})

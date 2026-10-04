/**
 * YAYA 后台作业 — ChatGPT (conversations.json) 导入。
 *
 * 导入可能有好几万个节点、耗时几十秒：跑在后台任务框架上，页面切走不中断，
 * 面板里能看进度 / 摘要日志，也能随时「停止」（经 AbortController 在会话之间中断）。
 * 完成时 push 结构化结果并广播 `cockpit:yaya-sessions-changed` 让会话列表刷新。
 */
import { readFile, stat } from 'node:fs/promises'
import { registerJobHandler, type JobControl } from '../../main/process/background-tasks'
import { makeLogger } from '../../main/process/logger'
import { getBroadcast } from '../../main/process/broadcast'
import { t, te } from '../../main/process/i18n'
import { importOpenAiConversations, type ImportResult } from './services/importers/openai'

const log = makeLogger('yaya-io')

/** 超过该大小的 conversations.json 直接拒绝（512MB），避免把内存吃光 */
const MAX_IMPORT_BYTES = 512 * 1024 * 1024

/** 每处理多少个会话输出一行摘要 */
const SUMMARY_EVERY = 5

function fail(control: JobControl, message: string): void {
  control.pushLine(message, 'stderr')
  control.finish('error')
  log.warn('yaya import job failed', { message })
}

registerJobHandler(
  'yaya.import-openai',
  async (control: JobControl, args: Record<string, unknown>) => {
    const file = String(args.path ?? '').trim()
    if (!file) {
      fail(control, t('yaya.io.err_no_path', '缺少参数：需要 --path <文件路径>'))
      return
    }

    control.setProgress(undefined)
    control.pushLine(`${t('yaya.io.import_reading', '读取')}: ${file}`)

    // 面板「停止」→ abort，在会话之间检查
    const ac = new AbortController()
    control.setCancel(() => ac.abort())

    let raw: string
    try {
      const st = await stat(file)
      if (st.size > MAX_IMPORT_BYTES) {
        const mb = Math.round(MAX_IMPORT_BYTES / 1024 / 1024)
        fail(
          control,
          te(
            'yaya.io.err_import_too_large',
            { mb: String(mb) },
            '导入文件过大（超过 {mb} MB），请分批导出'
          )
        )
        return
      }
      raw = await readFile(file, 'utf8')
    } catch (e) {
      fail(
        control,
        `${t('yaya.io.err_import_read', '读取导入文件失败')}: ${e instanceof Error ? e.message : String(e)}`
      )
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      fail(
        control,
        `${t('yaya.io.err_import_parse', '导入文件不是合法的 JSON')}: ${e instanceof Error ? e.message : String(e)}`
      )
      return
    }
    raw = ''

    let result: ImportResult
    try {
      result = importOpenAiConversations(
        Array.isArray(parsed) ? parsed : [parsed],
        (p) => {
          control.setProgress(p.total > 0 ? Math.round((p.done / p.total) * 100) : undefined)
          if (p.done > 0 && (p.done % SUMMARY_EVERY === 0 || p.done === p.total)) {
            control.pushLine(
              te(
                'yaya.io.import_progress',
                { done: String(p.done), total: String(p.total) },
                '已处理 {done}/{total} 个会话'
              )
            )
          }
        },
        ac.signal
      )
    } catch (e) {
      fail(
        control,
        `${t('yaya.io.err_import_invalid', '导入数据格式不正确')}: ${e instanceof Error ? e.message : String(e)}`
      )
      return
    }

    if (ac.signal.aborted) {
      control.pushLine(t('yaya.io.import_cancelled', '已取消导入'), 'stderr')
      control.finish('cancelled')
      return
    }

    for (const err of result.errors)
      control.pushLine(`${t('yaya.io.import_error_prefix', '失败')}: ${err}`, 'stderr')
    control.pushLine(
      te(
        'yaya.io.import_done',
        {
          sessions: String(result.importedSessions),
          messages: String(result.importedMessages),
          skipped: String(result.skippedSessions)
        },
        '导入完成：新增 {sessions} 个会话 / {messages} 条消息，跳过 {skipped} 个已存在会话'
      )
    )
    control.push({ data: result })
    control.setProgress(100)
    control.finish('exited')
    getBroadcast()('cockpit:yaya-sessions-changed', {})
    log.info('yaya import job done', { ...result })
  }
)

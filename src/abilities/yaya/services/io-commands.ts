/**
 * YAYA 会话导入 / 导出命令（主进程）。
 *
 * CLI-first：界面按钮与这里共享同一套 handler。
 *  - `yaya.session-export`：只返回文本，无额外授权；
 *  - `yaya.session-export-file`：由调用方决定写到哪个路径，需要 system.exec 许可；
 *  - `yaya.import`（旧名 `yaya.import-openai`）：读任意路径并启动后台作业（同样是调用方决定读什么），
 *    自动识别 ChatGPT / Claude / DeepSeek 导出与 Rikkahub 备份。
 */
import { writeFile } from 'node:fs/promises'
import { SCOPE_EXEC } from '../../../main/process/privacy'
import type { CommandSpec } from '../../../main/process/commands/types'
import { startJobByName } from '../../../main/process/background-tasks'
import { t, te } from '../../../main/process/i18n'
import { getSession } from './db'
import { exportSessionJsonl, exportSessionMarkdown, type ExportScope } from './export'
import { IMPORT_FORMATS, type ImportFormat } from './importers/load'

/** 文件名消毒：去掉路径分隔符和控制字符，限长 */
function sanitizeFilename(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]+/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/_+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/ ?_ ?|_ ?/g, '_')
    .replace(/^_+|_+$/g, '')
    .trim()
  return cleaned.slice(0, 60) || 'session'
}

function resolveExport(
  id: string,
  format: string,
  scope: string
): { content: string; ext: string } {
  const sc: ExportScope = scope === 'tree' ? 'tree' : 'branch'
  if (format === 'jsonl') return { content: exportSessionJsonl(id, sc), ext: 'jsonl' }
  if (format === 'md' || format === 'markdown')
    return { content: exportSessionMarkdown(id, sc), ext: 'md' }
  throw new Error(
    te('yaya.io.err_bad_format', { format }, '不支持的导出格式: {format}（可选 md / jsonl）')
  )
}

export const ioCommands: CommandSpec[] = [
  // 导出会话内容为文本（Markdown / JSONL），不落盘
  {
    name: 'yaya.session-export',
    description: t('yaya.io.cmd_export_desc', '导出会话为 Markdown 或 JSONL 文本'),
    usage: t(
      'yaya.io.cmd_export_usage',
      'yaya.session-export --session <id> [--format md|jsonl] [--scope branch|tree]'
    ),
    run: async (ctx) => {
      const sessionId = String(ctx.named.session ?? '')
      if (!sessionId) {
        return {
          ok: false,
          error: t('yaya.io.err_no_session', '缺少参数：需要 --session <会话 id>')
        }
      }
      const format = String(ctx.named.format ?? 'md').toLowerCase()
      const scope = String(ctx.named.scope ?? 'branch').toLowerCase()
      try {
        const { content, ext } = resolveExport(sessionId, format, scope)
        const title = getSession(sessionId)?.title ?? sessionId
        return { ok: true, content, filename: `${sanitizeFilename(title)}.${ext}` }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  },

  // 导出并写入调用方指定的路径（写哪里由调用方决定 → system.exec）
  {
    name: 'yaya.session-export-file',
    description: t('yaya.io.cmd_export_file_desc', '导出会话内容并写入指定文件路径'),
    usage: t(
      'yaya.io.cmd_export_file_usage',
      'yaya.session-export-file --session <id> --out <path> [--format md|jsonl] [--scope branch|tree]'
    ),
    privacy: { requires: [SCOPE_EXEC] },
    run: async (ctx) => {
      const sessionId = String(ctx.named.session ?? '')
      const out = String(ctx.named.out ?? '')
      if (!sessionId) {
        return {
          ok: false,
          error: t('yaya.io.err_no_session', '缺少参数：需要 --session <会话 id>')
        }
      }
      if (!out) {
        return {
          ok: false,
          error: t('yaya.io.err_no_out', '缺少参数：需要 --out <目标文件路径>')
        }
      }
      const format = String(ctx.named.format ?? 'md').toLowerCase()
      const scope = String(ctx.named.scope ?? 'branch').toLowerCase()
      try {
        const { content } = resolveExport(sessionId, format, scope)
        await writeFile(out, content, 'utf8')
        return { ok: true, path: out, bytes: Buffer.byteLength(content, 'utf8') }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  },

  // 导入会话 —— 跑在后台任务上（yaya.import 作业）；yaya.import-openai 是旧名字
  importCommand('yaya.import', 'auto'),
  importCommand('yaya.import-openai', 'openai')
]

function importCommand(name: string, defaultFormat: ImportFormat): CommandSpec {
  return {
    name,
    description:
      defaultFormat === 'openai'
        ? t(
            'yaya.io.cmd_import_desc',
            '从 ChatGPT 导出的 conversations.json 导入会话（后台任务，完成后自动刷新列表）'
          )
        : t(
            'yaya.io.cmd_import_any_desc',
            '导入其它聊天应用的会话：ChatGPT / Claude / DeepSeek 导出的 conversations.json 或整个 zip、Rikkahub 备份 zip / 数据库（自动识别，后台任务）'
          ),
    usage:
      defaultFormat === 'openai'
        ? t('yaya.io.cmd_import_usage', 'yaya.import-openai --path <conversations.json>')
        : 'yaya.import --path <file> [--format auto|openai|claude|deepseek|rikkahub]',
    privacy: { requires: [SCOPE_EXEC] },
    related: [`job:${name}`],
    run: async (ctx) => {
      const path = String(ctx.named.path ?? '')
      if (!path) {
        return { ok: false, error: t('yaya.io.err_no_path', '缺少参数：需要 --path <文件路径>') }
      }
      const format = IMPORT_FORMATS.includes(ctx.named.format as ImportFormat)
        ? (ctx.named.format as ImportFormat)
        : defaultFormat
      const task = await startJobByName(name, {
        path,
        format,
        name: t('yaya.io.job_import_any_title', '导入会话')
      })
      if (!task) {
        return {
          ok: false,
          error: t('yaya.io.err_import_start', '无法启动导入任务：导入作业未注册')
        }
      }
      return { ok: true, taskId: task.id }
    }
  }
}

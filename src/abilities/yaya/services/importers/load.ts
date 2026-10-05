/**
 * 统一导入入口：识别文件（zip / SQLite / JSON）与来源格式，交给对应解析器 + 写入层。
 *
 * - zip：内含 `rikka_hub.db` → Rikkahub；否则找 `conversations.json`（ChatGPT / Claude / DeepSeek 的导出都是这个名字）；
 * - SQLite 文件 → Rikkahub；
 * - JSON → 按结构自动识别（`chat_messages` = Claude，`mapping` + `fragments` = DeepSeek，`mapping` + `author` = ChatGPT），
 *   也可以用 `format` 指定。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { t } from '../../../../main/process/i18n'
import { importOpenAiConversations, type ImportProgress, type ImportResult } from './openai'
import { writeImportedConversations, type ImportedConversation } from './common'
import { isClaudeExport, parseClaudeExport } from './claude'
import { isDeepseekExport, parseDeepseekExport } from './deepseek'
import { extractRikkahubDb, parseRikkahubDb, zipHasRikkahub } from './rikkahub'
import { findEntry, isZip, readZip } from './zip'

export type ImportFormat = 'auto' | 'openai' | 'claude' | 'deepseek' | 'rikkahub'
export const IMPORT_FORMATS: ImportFormat[] = ['auto', 'openai', 'claude', 'deepseek', 'rikkahub']

export interface PreparedImport {
  format: Exclude<ImportFormat, 'auto'>
  /** 会话数（进度总数） */
  total: number
  run(onProgress?: (p: ImportProgress) => void, signal?: AbortSignal): ImportResult
}

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1')

/** JSON 结构 → 来源格式；认不出返回 null */
export function detectJsonFormat(data: unknown): Exclude<ImportFormat, 'auto' | 'rikkahub'> | null {
  if (isClaudeExport(data)) return 'claude'
  if (isDeepseekExport(data)) return 'deepseek'
  const first = Array.isArray(data) ? data[0] : data
  if (first && typeof first === 'object' && 'mapping' in (first as object)) return 'openai'
  return null
}

function fromConversations(
  format: 'claude' | 'deepseek' | 'rikkahub',
  convs: ImportedConversation[]
): PreparedImport {
  return {
    format,
    total: convs.length,
    run: (onProgress, signal) => writeImportedConversations(convs, onProgress, signal)
  }
}

function prepareRikkahubDb(path: string): PreparedImport {
  return fromConversations('rikkahub', parseRikkahubDb(path))
}

export function prepareImportFromJson(data: unknown, format: ImportFormat): PreparedImport {
  const fmt = format === 'auto' ? detectJsonFormat(data) : format
  if (fmt === 'claude') return fromConversations('claude', parseClaudeExport(data))
  if (fmt === 'deepseek') return fromConversations('deepseek', parseDeepseekExport(data))
  if (fmt === 'openai') {
    const list = Array.isArray(data) ? data : [data]
    return {
      format: 'openai',
      total: list.length,
      run: (onProgress, signal) => importOpenAiConversations(list, onProgress, signal)
    }
  }
  if (fmt === 'rikkahub')
    throw new Error(t('yaya.io.err_rikkahub_json', 'Rikkahub 需要备份 zip 或数据库文件，不是 JSON'))
  throw new Error(
    t(
      'yaya.io.err_import_unknown',
      '认不出导入文件的格式：支持 ChatGPT / Claude / DeepSeek 导出的 conversations.json（或整个 zip）与 Rikkahub 备份'
    )
  )
}

/** 读入的文件内容 → 准备好的导入（解析在这里完成，写库在 run 里） */
export function prepareImport(buf: Buffer, format: ImportFormat = 'auto'): PreparedImport {
  if (isZip(buf)) {
    const entries = readZip(buf)
    if (format === 'rikkahub' || (format === 'auto' && zipHasRikkahub(entries))) {
      const { path, cleanup } = extractRikkahubDb(entries)
      try {
        return prepareRikkahubDb(path)
      } finally {
        cleanup()
      }
    }
    const json = findEntry(entries, 'conversations.json')
    if (!json)
      throw new Error(
        t('yaya.io.err_zip_no_conversations', '压缩包里没有 conversations.json 或 rikka_hub.db')
      )
    return prepareImportFromJson(JSON.parse(json.read().toString('utf8')), format)
  }
  if (buf.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
    const dir = mkdtempSync(join(tmpdir(), 'yaya-import-db-'))
    try {
      const path = join(dir, 'import.db')
      writeFileSync(path, buf)
      return prepareRikkahubDb(path)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  let data: unknown
  try {
    data = JSON.parse(buf.toString('utf8'))
  } catch (e) {
    throw new Error(
      `${t('yaya.io.err_import_parse', '导入文件不是合法的 JSON')}: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  return prepareImportFromJson(data, format)
}

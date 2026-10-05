/**
 * 附件 → 与 Provider 无关的中间形态。各家 Provider 再把它翻译成自己的内容块
 * （Anthropic `image` / `document`，Gemini `inlineData`）。规则与 OpenAI 兼容 Provider 一致：
 * 图片发原图；文本 ≤ 200KB 内联；其余只给路径，让模型需要时用工具读。
 */
import type { MessageAttachment } from '../../types'
import { readAssetData, resolveAssetLocalPath, isTextMime } from '../assets'
import { outline } from '../../plugins/documents/search'

/** 文本附件内联上限：再大就只告诉模型路径 */
export const INLINE_TEXT_LIMIT = 200 * 1024
/** 原生 PDF 上限：base64 后还要放进单个请求（各家请求体上限 20–32MB） */
const NATIVE_PDF_LIMIT = 10 * 1024 * 1024

export type LoadedAttachment =
  | { kind: 'image'; mimeType: string; base64: string }
  | { kind: 'pdf'; base64: string; name: string }
  | { kind: 'text'; text: string }

/**
 * @param pdf Provider 是否原生支持 PDF（Anthropic `document` / Gemini `inlineData` 都支持）
 */
export async function loadAttachment(
  att: MessageAttachment,
  opts: { pdf?: boolean } = {}
): Promise<LoadedAttachment> {
  const localPath = resolveAssetLocalPath(att.assetPath) ?? att.assetPath
  if (att.mimeType.startsWith('image/')) {
    const data = await readAssetData(att.assetPath)
    if (data) return { kind: 'image', mimeType: att.mimeType, base64: data.toString('base64') }
  } else if (opts.pdf && att.mimeType === 'application/pdf' && att.size <= NATIVE_PDF_LIMIT) {
    const data = await readAssetData(att.assetPath)
    if (data) return { kind: 'pdf', base64: data.toString('base64'), name: att.name }
  } else if (isTextMime(att.mimeType) && att.size <= INLINE_TEXT_LIMIT) {
    const data = await readAssetData(att.assetPath)
    if (data) {
      return {
        kind: 'text',
        text: `<attachment name="${att.name}" path="${localPath}">\n${data.toString('utf8')}\n</attachment>`
      }
    }
  }
  return { kind: 'text', text: await attachmentRefNote(att) }
}

/**
 * 没有内联的附件：给 id / 路径 / 开头摘要，告诉模型怎么按需取内容
 * （长文档检索插件 `docs_search` / `docs_read`，或 `read_file`）。
 */
export async function attachmentRefNote(att: MessageAttachment): Promise<string> {
  const localPath = resolveAssetLocalPath(att.assetPath) ?? att.assetPath
  let summary = att.summary ?? ''
  if (!summary && isTextMime(att.mimeType)) {
    const data = await readAssetData(att.assetPath)
    if (data) summary = outline(data.subarray(0, 16 * 1024).toString('utf8'))
  }
  const attr = (s: string): string => s.replace(/"/g, "'")
  const sum = summary ? ` summary="${attr(summary)}"` : ''
  const docLike = isTextMime(att.mimeType) || att.mimeType === 'application/pdf'
  const hint = docLike
    ? '（内容未内联：用 docs_search / docs_read 按 id 检索、分段读取；或用 read_file 读取该路径）'
    : '（内容未内联，需要时用 read_file 读取该路径）'
  return `<attachment id="${att.id}" name="${attr(att.name)}" mime="${att.mimeType}" size="${att.size}" path="${localPath}"${sum} />${hint}`
}

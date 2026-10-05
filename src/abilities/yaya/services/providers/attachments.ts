/**
 * 附件 → 与 Provider 无关的中间形态。各家 Provider 再把它翻译成自己的内容块
 * （Anthropic `image` / `document`，Gemini `inlineData`）。规则与 OpenAI 兼容 Provider 一致：
 * 图片发原图；文本 ≤ 200KB 内联；其余只给路径，让模型需要时用工具读。
 */
import type { MessageAttachment } from '../../types'
import { readAssetData, resolveAssetLocalPath, isTextMime } from '../assets'

/** 文本附件内联上限：再大就只告诉模型路径 */
export const INLINE_TEXT_LIMIT = 200 * 1024

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
  } else if (opts.pdf && att.mimeType === 'application/pdf') {
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
  const summary = att.summary ? ` summary="${att.summary}"` : ''
  return {
    kind: 'text',
    text: `<attachment name="${att.name}" mime="${att.mimeType}" size="${att.size}" path="${localPath}"${summary} />（内容未内联，需要时用 read_file 读取该路径）`
  }
}

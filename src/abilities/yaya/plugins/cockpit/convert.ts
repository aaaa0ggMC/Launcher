/**
 * 把 Cockpit 的 agent 工具输出（`src/main/process/agent/tools.ts` 的 `ToolOutput`）转换成
 * YAYA 插件契约里的结构化工具结果（`ToolContentResult`），以及 zod shape → JSON Schema。
 *
 * 这个文件刻意保持「纯」：只 import zod 与**类型**，不碰主进程运行时
 * （winston / electron / 用户配置），所以 `convert.test.ts` 能在普通 node:test 里跑。
 */
import { z } from 'zod'
import type { ToolOutput } from '../../../../main/process/agent/tools'
import type { ToolContentPart, ToolContentResult } from '../../services/plugins/types'

/** 与插件注册表 `clipText` 一致的截断上限（不 import 注册表，避免拉起 assets / electron） */
const MAX_TOOL_RESULT_CHARS = 32_000

/** 脱敏说明的兜底文案（index.ts 会传翻译后的版本） */
export const DEFAULT_REDACTED_PREFIX = '部分值已脱敏：'

export interface ConvertOptions {
  /** 脱敏说明的前缀（调用方已翻译），例如「部分值已脱敏：」 */
  redactedPrefix?: string
}

// ---------------------------------------------------------------------------
// 参数 schema
// ---------------------------------------------------------------------------

/** JSON Schema 缓存：同一工具每次逐字节相同（工具顺序 / schema 变化会击穿提示词缓存） */
const schemaCache = new Map<string, string>()

/**
 * zod shape → JSON Schema（去掉 `$schema`）。结果按工具名缓存并深拷贝返回，
 * 调用方拿到的是独立对象，改不动缓存；两次调用逐字节相同。
 */
export function toolParameters(name: string, shape: z.ZodRawShape): Record<string, unknown> {
  const hit = schemaCache.get(name)
  if (hit !== undefined) return JSON.parse(hit) as Record<string, unknown>
  let json: Record<string, unknown>
  try {
    json = z.toJSONSchema(z.object(shape)) as Record<string, unknown>
  } catch {
    // 理论上不会发生（AGENT_TOOLS 的 shape 都是标准 zod v4）；兜底至少保证是合法 schema
    json = { type: 'object', properties: {} }
  }
  delete json.$schema
  const text = JSON.stringify(json)
  schemaCache.set(name, text)
  return JSON.parse(text) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// 工具输出 → ToolContentResult
// ---------------------------------------------------------------------------

function clip(text: string, max = MAX_TOOL_RESULT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text
}

function textPart(text: string): ToolContentPart[] {
  return text ? [{ type: 'text', text }] : []
}

/** meta 的 JSON 文本；没有 meta 时返回空串（调用方据此省略整段文本） */
function metaText(meta: unknown): string {
  if (!meta || typeof meta !== 'object') return ''
  if (Object.keys(meta as object).length === 0) return ''
  return clip(JSON.stringify(meta, null, 2))
}

/** 有内容的 meta 才作为 display 交给界面；空对象 / 非对象时留给宿主默认视图（{ text, images }） */
function metaDisplay(meta: unknown): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  return Object.keys(meta).length ? (meta as Record<string, unknown>) : undefined
}

/**
 * 单张 / 多张图片的说明文本：`images` 先把各图 label 列出来，模型才知道每张是什么。
 * 单张图只有 meta 时附上（截图会带缩放比例等）。
 */
function imageContent(out: Extract<ToolOutput, { kind: 'image' | 'images' }>): ToolContentPart[] {
  if (out.kind === 'image')
    return [...textPart(metaText(out.meta)), imagePart(out.data, out.mimeType)]
  const labels = textPart(out.images.map((im, i) => `${i + 1}. ${im.label || 'image'}`).join('\n'))
  return [...labels, ...out.images.map((im) => imagePart(im.data, im.mimeType))]
}

function imagePart(data: string, mimeType: string): ToolContentPart {
  return { type: 'image', mimeType, data }
}

/** 有隐私脱敏时在文本末尾补一句「哪些 scope 被遮住了」，模型据此知道值不是空的 */
function withPrivacy(
  result: ToolContentResult,
  redacted: string[] | undefined,
  opts: ConvertOptions
): ToolContentResult {
  if (!redacted || redacted.length === 0) return result
  const line = `${opts.redactedPrefix ?? DEFAULT_REDACTED_PREFIX}${redacted.join(', ')}`
  const content = [...result.content]
  const last = content.length - 1
  if (last >= 0 && content[last].type === 'text') {
    const prev = content[last] as { type: 'text'; text: string }
    content[last] = { type: 'text', text: `${prev.text}\n${line}` }
  } else {
    content.push({ type: 'text', text: line })
  }
  return { ...result, content }
}

/**
 * `runAgentTool` 的返回 → 交给模型的 content（长文本截断）+ 只给界面看的 display。
 * 约定：json → 一段等宽 JSON 文本（display = 原值，交给工具视图按结构渲染）；
 * image / images → 说明文本 + 图片（display = meta，图片本体走会话资产）。
 */
export function convertToolOutput(out: ToolOutput, opts: ConvertOptions = {}): ToolContentResult {
  if (out.kind === 'image' || out.kind === 'images') {
    return withPrivacy(
      {
        content: imageContent(out),
        display: metaDisplay(out.meta)
      },
      out.privacy?.redacted,
      opts
    )
  }
  return withPrivacy(
    {
      content: textPart(clip(JSON.stringify(out.value ?? null, null, 2))),
      display: out.value
    },
    out.privacy?.redacted,
    opts
  )
}

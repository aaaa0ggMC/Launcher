/**
 * Anthropic Messages API 原生 Provider（`POST /v1/messages`）。
 *
 * - 流式：SSE 事件 `message_start / content_block_* / message_delta`，文本、思考摘要、工具参数分别累积；
 * - 工具：`tools[].input_schema`；结果用 user 消息里的 `tool_result` 块回传（同一步的多个结果合成一条），
 *   工具产出的图片直接放进 `tool_result` 的内容里；
 * - 思考：`thinking: {type: 'adaptive', display: 'summarized'}` + `output_config.effort`；
 *   返回的 thinking 块（含签名）存进 `native`，同一模型继续对话 / 工具循环时原样放回 assistant 消息开头；
 * - 提示词缓存：顶层 `cache_control` 自动缓存（工具表与系统提示词本来就逐字节稳定）；
 * - 端点 / 网关不认识的可选字段（thinking / output_config / cache_control）收到 400 后去掉重试并记住；
 * - 自带搜索：服务端工具 `web_search_20250305`（Anthropic 那边执行，不进工具循环），
 *   查询词在 `server_tool_use`、来源在 `web_search_tool_result` 块。
 */
import type { ProviderConfig, ToolCallItem, TokenUsage, MessageAttachment } from '../../types'
import type {
  AIProvider,
  NativeState,
  ProviderGenerateOptions,
  ProviderGenerateResult,
  ProviderMessage,
  ProviderTool
} from './types'
import { loadAttachment } from './attachments'
import { cleanBase, ensureOk, ProviderHttpError, readSse, tryParseJson } from './http'
import {
  BuiltinSearchUnsupportedError,
  rejectBuiltinSearch,
  SearchCollector
} from './builtin-search'
import { makeLogger } from '../../../../main/process/logger'

const log = makeLogger('yaya-provider-anthropic')

export const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com'
const API_VERSION = '2023-06-01'
const STREAM_MAX_TOKENS = 32000
const NON_STREAM_MAX_TOKENS = 16000
/** 老模型（Claude 3 系列）输出上限，端点拒绝大 max_tokens 时退回它 */
const LEGACY_MAX_TOKENS = 8192

/** 可以去掉的可选字段：端点不认识时 400，去掉重试 */
const OPTIONAL_FIELDS = ['thinking', 'output_config', 'cache_control'] as const
type OptionalField = (typeof OPTIONAL_FIELDS)[number]

type Block = Record<string, unknown> & { type: string }
interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: Block[]
}

/** `/v1` 可写可不写 */
export function anthropicUrl(baseUrl: string | undefined, path: string): string {
  const base = cleanBase(baseUrl, ANTHROPIC_DEFAULT_BASE)
  return /\/v1$/.test(base) ? `${base}${path}` : `${base}/v1${path}`
}

export function anthropicHeaders(apiKey: string | undefined): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': API_VERSION
  }
  if (apiKey) h['x-api-key'] = apiKey
  return h
}

/** tool_use id 只允许 `[A-Za-z0-9_-]`（导入的历史里可能有别的字符）；两侧用同一个函数保证对得上 */
function toolId(id: string): string {
  return (id || 'call_0').replace(/[^A-Za-z0-9_-]/g, '_')
}

/** 列出可用模型（`GET /v1/models`，分页） */
export async function listAnthropicModels(
  baseUrl: string | undefined,
  apiKey: string | undefined,
  signal?: AbortSignal
): Promise<string[]> {
  const out: string[] = []
  let after = ''
  for (let page = 0; page < 10; page++) {
    const url = anthropicUrl(baseUrl, `/models?limit=1000${after ? `&after_id=${after}` : ''}`)
    const res = await fetch(url, { headers: anthropicHeaders(apiKey), signal })
    await ensureOk(res, 'Anthropic /v1/models')
    const data = (await res.json()) as {
      data?: Array<{ id?: string }>
      has_more?: boolean
      last_id?: string
    }
    for (const m of data.data ?? []) if (m.id) out.push(m.id)
    if (!data.has_more || !data.last_id) break
    after = encodeURIComponent(data.last_id)
  }
  return out
}

/** 思考强度 → 请求字段。default = 不发（模型默认）；off = 不开思考、最低强度 */
export function anthropicReasoning(
  effort: ProviderGenerateOptions['reasoning']
): Partial<Record<'thinking' | 'output_config', unknown>> {
  switch (effort) {
    case 'off':
      return { output_config: { effort: 'low' } }
    case 'low':
    case 'medium':
    case 'high':
      return {
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort }
      }
    default:
      return {}
  }
}

export function toAnthropicUsage(u: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!u) return undefined
  const num = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0)
  const input = num('input_tokens')
  const cacheRead = num('cache_read_input_tokens')
  const cacheWrite = num('cache_creation_input_tokens')
  const output = num('output_tokens')
  const prompt = input + cacheRead + cacheWrite
  return {
    prompt,
    completion: output,
    total: prompt + output,
    ...(cacheRead ? { cached: cacheRead } : {})
  }
}

export class AnthropicProvider implements AIProvider {
  public id: string
  /** 被端点拒绝过的可选字段，之后不再发送 */
  private dropped = new Set<OptionalField>()
  private legacyMaxTokens = false

  constructor(public config: ProviderConfig) {
    if (/^enc:v[12]:/.test(config.apiKey ?? '')) {
      throw new Error('Provider credentials could not be decrypted')
    }
    this.id = config.id
  }

  async listModels(): Promise<string[]> {
    try {
      return await listAnthropicModels(this.config.baseUrl, this.config.apiKey)
    } catch (e) {
      log.warn(`Failed to list models for provider ${this.id}`, { error: String(e) })
      return this.config.models
    }
  }

  async generate(options: ProviderGenerateOptions): Promise<ProviderGenerateResult> {
    const { system, messages } = await formatAnthropicMessages(options.messages, options.model)
    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.stream ? STREAM_MAX_TOKENS : NON_STREAM_MAX_TOKENS,
      messages,
      cache_control: { type: 'ephemeral' },
      ...anthropicReasoning(options.reasoning)
    }
    if (system) body.system = system
    const tools: Record<string, unknown>[] = (options.tools ?? []).map(toAnthropicTool)
    if (options.builtinSearch) tools.push(WEB_SEARCH_TOOL)
    if (tools.length) body.tools = tools
    if (options.stream) body.stream = true

    let res: Response
    try {
      res = await this.send(body, options.signal)
    } catch (e) {
      const msg = e instanceof ProviderHttpError ? `${e.message} ${e.body}` : ''
      if (
        options.builtinSearch &&
        e instanceof ProviderHttpError &&
        e.status === 400 &&
        /web_search/.test(msg)
      ) {
        rejectBuiltinSearch(this.id, options.model)
        throw new BuiltinSearchUnsupportedError(this.id, options.model, msg)
      }
      throw e
    }
    const result = await (options.stream
      ? this.readStream(res, options)
      : this.readJson(res, options.model, options.onToolCall))
    return options.builtinSearch ? result : { ...result, search: undefined }
  }

  /** 发请求；可选字段 / 过大的 max_tokens 被拒时去掉重试 */
  private async send(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const payload: Record<string, unknown> = { ...body }
      for (const f of this.dropped) delete payload[f]
      if (this.legacyMaxTokens) payload.max_tokens = LEGACY_MAX_TOKENS
      const res = await fetch(anthropicUrl(this.config.baseUrl, '/messages'), {
        method: 'POST',
        headers: anthropicHeaders(this.config.apiKey),
        body: JSON.stringify(payload),
        signal
      })
      try {
        await ensureOk(res, 'Anthropic')
        return res
      } catch (e) {
        if (!(e instanceof ProviderHttpError) || e.status !== 400 || signal?.aborted) throw e
        const msg = `${e.message} ${e.body}`
        const field = OPTIONAL_FIELDS.find(
          (f) => f in payload && (msg.includes(f) || (f === 'output_config' && /effort/i.test(msg)))
        )
        if (field) {
          log.warn(`Provider ${this.id} rejected ${field}; retrying without it`, {
            error: e.message.slice(0, 300)
          })
          this.dropped.add(field)
          continue
        }
        if (!this.legacyMaxTokens && /max_tokens/.test(msg)) {
          this.legacyMaxTokens = true
          continue
        }
        throw e
      }
    }
    throw new Error('Anthropic: request rejected repeatedly')
  }

  private async readJson(
    res: Response,
    model: string,
    onToolCall?: (call: ToolCallItem) => void
  ): Promise<ProviderGenerateResult> {
    const data = (await res.json()) as {
      content?: Block[]
      usage?: Record<string, unknown>
      stop_reason?: string
      stop_details?: { category?: string; explanation?: string } | null
    }
    return finishAnthropic(data.content ?? [], data.usage, data.stop_reason, data.stop_details, {
      model,
      onToolCall
    })
  }

  private async readStream(
    res: Response,
    options: ProviderGenerateOptions
  ): Promise<ProviderGenerateResult> {
    const blocks: Block[] = []
    const partialJson: Record<number, string> = {}
    let usage: Record<string, unknown> = {}
    let stopReason: string | undefined
    let stopDetails: { category?: string; explanation?: string } | null | undefined

    for await (const ev of readSse(res, options.signal)) {
      if (options.signal?.aborted) break
      if (!ev.data || ev.data === '[DONE]') continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(ev.data)
      } catch {
        continue
      }
      const type = msg.type as string
      if (type === 'message_start') {
        const m = msg.message as { usage?: Record<string, unknown> } | undefined
        usage = { ...usage, ...(m?.usage ?? {}) }
      } else if (type === 'content_block_start') {
        const idx = msg.index as number
        const block = { ...(msg.content_block as Block) }
        if (block.type === 'text') block.text = ''
        if (block.type === 'thinking') block.thinking = block.thinking ?? ''
        blocks[idx] = block
        if (block.type === 'tool_use' || block.type === 'server_tool_use') partialJson[idx] = ''
      } else if (type === 'content_block_delta') {
        const idx = msg.index as number
        const block = blocks[idx]
        const delta = msg.delta as Record<string, unknown>
        if (!block || !delta) continue
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          block.text = String(block.text ?? '') + delta.text
          options.onToken?.(delta.text)
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          block.thinking = String(block.thinking ?? '') + delta.thinking
          options.onReasoning?.(delta.thinking)
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          block.signature = String(block.signature ?? '') + delta.signature
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          partialJson[idx] = (partialJson[idx] ?? '') + delta.partial_json
        }
      } else if (type === 'content_block_stop') {
        const idx = msg.index as number
        const block = blocks[idx]
        if ((block?.type === 'tool_use' || block?.type === 'server_tool_use') && partialJson[idx])
          block.input = tryParseJson(partialJson[idx])
      } else if (type === 'message_delta') {
        const d = msg.delta as { stop_reason?: string; stop_details?: typeof stopDetails }
        if (d?.stop_reason) stopReason = d.stop_reason
        if (d?.stop_details) stopDetails = d.stop_details
        usage = { ...usage, ...((msg.usage as Record<string, unknown>) ?? {}) }
      } else if (type === 'error') {
        const err = msg.error as { message?: string; type?: string } | undefined
        throw new Error(`Anthropic stream error: ${err?.message ?? err?.type ?? ev.data}`)
      }
    }
    return finishAnthropic(blocks.filter(Boolean), usage, stopReason, stopDetails, {
      model: options.model,
      onToolCall: options.onToolCall
    })
  }
}

/** 内容块 → 统一结果；thinking 块（含签名）进 native，供下次原样回传 */
export function finishAnthropic(
  blocks: Block[],
  usage: Record<string, unknown> | undefined,
  stopReason: string | undefined,
  stopDetails: { category?: string; explanation?: string } | null | undefined,
  opts: { model: string; onToolCall?: (call: ToolCallItem) => void }
): ProviderGenerateResult {
  let content = ''
  let reasoning = ''
  const toolCalls: ToolCallItem[] = []
  const thinkingBlocks: Block[] = []
  const search = new SearchCollector()
  for (const b of blocks) {
    if (b.type === 'server_tool_use' && b.name === 'web_search') {
      search.query((b.input as { query?: unknown } | undefined)?.query)
    } else if (b.type === 'web_search_tool_result') {
      if (Array.isArray(b.content))
        for (const r of b.content as Array<{ url?: string; title?: string }>)
          search.source(r.url, r.title)
    } else if (b.type === 'text') content += String(b.text ?? '')
    else if (b.type === 'thinking') {
      reasoning += String(b.thinking ?? '')
      thinkingBlocks.push({ type: 'thinking', thinking: b.thinking ?? '', signature: b.signature })
    } else if (b.type === 'redacted_thinking') {
      thinkingBlocks.push({ type: 'redacted_thinking', data: b.data })
    } else if (b.type === 'tool_use') {
      const input = b.input
      const call: ToolCallItem = {
        id: String(b.id ?? `call_${toolCalls.length}`),
        name: String(b.name ?? ''),
        args:
          input && typeof input === 'object'
            ? (input as Record<string, unknown>)
            : typeof input === 'string'
              ? input
              : {},
        status: 'pending'
      }
      opts.onToolCall?.(call)
      toolCalls.push(call)
    }
  }
  if (stopReason === 'refusal' && !content.trim() && !toolCalls.length) {
    const why = [stopDetails?.category, stopDetails?.explanation].filter(Boolean).join(': ')
    throw new Error(`The model declined this request (refusal${why ? `, ${why}` : ''})`)
  }
  const native: NativeState | undefined = thinkingBlocks.length
    ? { type: 'anthropic', model: opts.model, data: thinkingBlocks }
    : undefined
  return {
    content,
    reasoningContent: reasoning || undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    usage: toAnthropicUsage(usage),
    ...(native ? { native } : {}),
    // display: summarized 给的是思考摘要
    ...(reasoning ? { reasoningSummary: true } : {}),
    ...(search.result() ? { search: search.result() } : {})
  }
}

/** Anthropic 服务端执行的网页搜索（与 GenericSearch 的 web_search 二选一，不会同时出现） */
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }

function toAnthropicTool(t: ProviderTool): Record<string, unknown> {
  return {
    name: t.name,
    description: t.description,
    input_schema:
      t.parameters && typeof t.parameters === 'object' && Object.keys(t.parameters).length
        ? t.parameters
        : { type: 'object', properties: {} }
  }
}

async function attachmentBlocks(att: MessageAttachment): Promise<Block[]> {
  const a = await loadAttachment(att, { pdf: true })
  if (a.kind === 'image')
    return [{ type: 'image', source: { type: 'base64', media_type: a.mimeType, data: a.base64 } }]
  if (a.kind === 'pdf')
    return [
      {
        type: 'document',
        title: a.name,
        source: { type: 'base64', media_type: 'application/pdf', data: a.base64 }
      }
    ]
  return [{ type: 'text', text: a.text }]
}

/**
 * 统一消息 → Anthropic 消息：system 拼到顶层；连续的 tool 结果合成一条 user 消息；
 * 同一模型上次返回的 thinking 块放回 assistant 消息开头。
 */
export async function formatAnthropicMessages(
  input: ProviderMessage[],
  model: string
): Promise<{ system: string; messages: AnthropicMessage[] }> {
  const systemParts: string[] = []
  const out: AnthropicMessage[] = []
  const push = (role: 'user' | 'assistant', content: Block[]): void => {
    if (!content.length) return
    const last = out[out.length - 1]
    // 同角色相邻：合并成一条（tool_result 必须紧跟在对应 tool_use 的下一条 user 消息里）
    if (last && last.role === role)
      last.content.push(
        // thinking 块只能在一条 assistant 消息的开头
        ...content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking')
      )
    else out.push({ role, content })
  }

  for (const m of input) {
    if (m.role === 'system') {
      if (m.content.trim()) systemParts.push(m.content)
    } else if (m.role === 'assistant') {
      const blocks: Block[] = []
      if (
        m.native?.type === 'anthropic' &&
        m.native.model === model &&
        Array.isArray(m.native.data)
      )
        blocks.push(...(m.native.data as Block[]))
      if (m.content?.trim()) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls ?? []) {
        const args = typeof tc.args === 'string' ? tryParseJson(tc.args) : tc.args
        blocks.push({
          type: 'tool_use',
          id: toolId(tc.id),
          name: tc.name,
          input: typeof args === 'object' && args ? args : {}
        })
      }
      // 只有 thinking 块、没有正文和工具调用的 assistant 消息没有意义
      if (blocks.some((b) => b.type === 'text' || b.type === 'tool_use')) push('assistant', blocks)
    } else if (m.role === 'tool') {
      const content: Block[] = [{ type: 'text', text: m.content || '(empty)' }]
      for (const att of m.attachments ?? []) {
        if (att.mimeType.startsWith('image/')) content.push(...(await attachmentBlocks(att)))
      }
      push('user', [{ type: 'tool_result', tool_use_id: toolId(m.toolCallId ?? ''), content }])
    } else {
      const blocks: Block[] = []
      for (const att of m.attachments ?? []) blocks.push(...(await attachmentBlocks(att)))
      if (m.content?.trim()) blocks.push({ type: 'text', text: m.content })
      push('user', blocks)
    }
  }
  // 第一条必须是 user（导入的历史可能以 assistant 开头）
  if (out[0]?.role === 'assistant')
    out.unshift({ role: 'user', content: [{ type: 'text', text: '…' }] })
  return { system: systemParts.join('\n\n'), messages: out }
}

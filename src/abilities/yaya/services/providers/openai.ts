/**
 * OpenAI 及其兼容端点（Codex-Proxy, DeepSeek, Ollama, vLLM 等）Provider 实现
 */
import OpenAI from 'openai'
import type { ProviderConfig, ToolCallItem, MessageAttachment, TokenUsage } from '../../types'
import type {
  AIProvider,
  ProviderGenerateOptions,
  ProviderGenerateResult,
  ProviderMessage,
  ProviderTool
} from './types'
import { readAssetData, resolveAssetLocalPath, isTextMime } from '../assets'
import { reasoningParams, resolveReasoningStyle } from './reasoning'
import { makeLogger } from '../../../../main/process/logger'

const log = makeLogger('yaya-provider-openai')

export class OpenAICompatibleProvider implements AIProvider {
  public id: string
  private client: OpenAI

  constructor(public config: ProviderConfig) {
    if (/^enc:v[12]:/.test(config.apiKey ?? '')) {
      throw new Error('Provider credentials could not be decrypted')
    }
    this.id = config.id
    this.client = new OpenAI({
      apiKey: config.apiKey || 'dummy',
      baseURL: config.baseUrl || 'https://api.openai.com/v1',
      timeout: 120_000
    })
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await this.client.models.list()
      return res.data.map((m) => m.id)
    } catch (e) {
      log.warn(`Failed to list models for provider ${this.id}`, { error: String(e) })
      return this.config.models
    }
  }

  async generate(options: ProviderGenerateOptions): Promise<ProviderGenerateResult> {
    const formattedMessages = await this.formatMessages(options.messages)
    const formattedTools =
      options.tools && options.tools.length > 0 ? options.tools.map(toOpenAiTool) : undefined

    if (options.stream) {
      return this.generateStream(formattedMessages, formattedTools, options)
    } else {
      return this.generateNonStream(formattedMessages, formattedTools, options)
    }
  }

  private async generateNonStream(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
    options: ProviderGenerateOptions
  ): Promise<ProviderGenerateResult> {
    const res = await this.withReasoningFallback(options, (extra) =>
      this.client.chat.completions.create(
        {
          model: options.model,
          messages,
          tools,
          temperature: options.temperature ?? 0.7,
          ...extra
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        { signal: options.signal }
      )
    )

    const choice = res.choices[0]
    const msg = choice?.message
    const rawToolCalls = msg?.tool_calls

    const toolCalls: ToolCallItem[] = []
    if (rawToolCalls) {
      for (const call of rawToolCalls) {
        if (call.type === 'function') {
          toolCalls.push({
            id: call.id,
            name: call.function.name,
            args: tryParseJson(call.function.arguments),
            status: 'pending'
          })
        }
      }
    }

    // 处理某些推理模型（如 DeepSeek R1）的 reasoning_content
    const reasoningContent = (msg as { reasoning_content?: string })?.reasoning_content

    return {
      content: msg?.content ?? '',
      reasoningContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: res.usage ? toUsage(res.usage) : undefined
    }
  }

  /** 端点不认识思考参数（400 且提到参数名 / unknown 之类）后记住，不再发送 */
  private reasoningUnsupported = false

  /** 带上思考参数发请求；端点拒绝这些参数时去掉重试一次 */
  private async withReasoningFallback<T>(
    options: ProviderGenerateOptions,
    send: (extra: Record<string, unknown>) => Promise<T>
  ): Promise<T> {
    const extra = this.reasoningUnsupported
      ? {}
      : reasoningParams(
          resolveReasoningStyle(this.config),
          options.reasoning ?? 'default',
          this.config.type
        )
    const keys = Object.keys(extra)
    if (!keys.length) return send({})
    try {
      return await send(extra)
    } catch (e) {
      const msg = String(e)
      const status = (e as { status?: number }).status
      const rejected =
        status === 400 &&
        (keys.some((k) => msg.includes(k)) ||
          /unrecognized|unknown|unexpected|extra|not permitted|unsupported|invalid param/i.test(
            msg
          ))
      if (!rejected || options.signal?.aborted) throw e
      log.warn(`Provider ${this.id} rejected reasoning params; sending without them`, {
        keys,
        error: msg.slice(0, 300)
      })
      this.reasoningUnsupported = true
      return send({})
    }
  }

  /** 端点拒绝 `stream_options` 后记住，不再发送 */
  private streamUsageUnsupported = false

  private async generateStream(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
    options: ProviderGenerateOptions
  ): Promise<ProviderGenerateResult> {
    type ChunkStream = AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
    const create = (withUsage: boolean): Promise<ChunkStream> =>
      this.withReasoningFallback(options, (extra) =>
        this.client.chat.completions.create(
          {
            model: options.model,
            messages,
            tools,
            temperature: options.temperature ?? 0.7,
            stream: true,
            ...(withUsage ? { stream_options: { include_usage: true } } : {}),
            ...extra
          } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
          { signal: options.signal }
        )
      )
    let stream: ChunkStream
    try {
      stream = await create(!this.streamUsageUnsupported)
    } catch (e) {
      // 部分兼容网关不认识 stream_options：去掉重试一次
      if (this.streamUsageUnsupported || !/stream_options|include_usage/i.test(String(e))) throw e
      this.streamUsageUnsupported = true
      stream = await create(false)
    }

    let usage: ProviderGenerateResult['usage']
    let content = ''
    let reasoningContent = ''
    const toolCallAccumulator: Record<number, { id: string; name: string; args: string }> = {}

    for await (const chunk of stream) {
      if (options.signal?.aborted) break
      if (chunk.usage) usage = toUsage(chunk.usage)
      const delta = chunk.choices[0]?.delta
      if (!delta) continue

      // 文本 Token
      if (delta.content) {
        content += delta.content
        options.onToken?.(delta.content)
      }

      // 思考 / 推理过程（DeepSeek reasoning_content 或 OpenAI Responses 思考）
      // OpenRouter 等用 `reasoning` 字段
      const d = delta as { reasoning_content?: string; reasoning?: unknown }
      const reasoning =
        d.reasoning_content || (typeof d.reasoning === 'string' ? d.reasoning : undefined)
      if (reasoning) {
        reasoningContent += reasoning
        options.onReasoning?.(reasoning)
      }

      // 流式聚合 Tool Calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index
          if (!toolCallAccumulator[idx]) {
            toolCallAccumulator[idx] = { id: tc.id ?? `call_${idx}`, name: '', args: '' }
          }
          if (tc.id) toolCallAccumulator[idx].id = tc.id
          if (tc.function?.name) toolCallAccumulator[idx].name += tc.function.name
          if (tc.function?.arguments) toolCallAccumulator[idx].args += tc.function.arguments
        }
      }
    }

    const toolCalls: ToolCallItem[] = Object.values(toolCallAccumulator).map((tc) => {
      const parsedArgs = tryParseJson(tc.args)
      const callItem: ToolCallItem = {
        id: tc.id,
        name: tc.name,
        args: parsedArgs,
        status: 'pending'
      }
      options.onToolCall?.(callItem)
      return callItem
    })

    return {
      content,
      reasoningContent: reasoningContent || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage
    }
  }

  private async formatMessages(
    messages: ProviderMessage[]
  ): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
    const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
    // 工具产出的图片：tool 消息不能带图，且同一步的 tool 结果必须连续，
    // 所以攒到这一串 tool 消息结束后，作为一条 user 消息交给模型
    let toolImages: MessageAttachment[] = []
    const flushToolImages = async (): Promise<void> => {
      if (!toolImages.length) return
      const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
        { type: 'text', text: '[Images returned by the tool calls above]' }
      ]
      for (const att of toolImages) parts.push(...(await attachmentParts(att)))
      out.push({ role: 'user', content: parts })
      toolImages = []
    }

    for (const m of messages) {
      if (m.role !== 'tool') await flushToolImages()
      if (m.role === 'system') {
        out.push({ role: 'system', content: m.content })
      } else if (m.role === 'assistant') {
        const hasContent = Boolean(m.content && m.content.trim().length > 0)
        const hasTools = Boolean(m.toolCalls && m.toolCalls.length > 0)
        // OpenAI / DeepSeek 严格要求：若没有 tool_calls，content 必须为非空字符串，不可为 null 或空字符串
        if (!hasContent && !hasTools) {
          continue
        }
        const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: hasContent ? m.content! : null
        }
        if (hasTools) {
          msg.tool_calls = m.toolCalls!.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args)
            }
          }))
        }
        out.push(msg)
      } else if (m.role === 'tool') {
        out.push({
          role: 'tool',
          tool_call_id: m.toolCallId || 'call_0',
          content: m.content
        })
        for (const att of m.attachments ?? []) {
          if (att.mimeType.startsWith('image/')) toolImages.push(att)
        }
      } else if (m.role === 'user') {
        // 多模态处理：如果有图片附件，转为 OpenAI Vision 格式
        if (m.attachments && m.attachments.length > 0) {
          const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = []
          if (m.content) {
            parts.push({ type: 'text', text: m.content })
          }

          for (const att of m.attachments) {
            parts.push(...(await attachmentParts(att)))
          }

          out.push({ role: 'user', content: parts })
        } else {
          out.push({ role: 'user', content: m.content })
        }
      }
    }
    await flushToolImages()

    return out
  }
}

/** 文本附件内联上限：再大就只告诉模型路径，让它用 read_file 按需读 */
const INLINE_TEXT_LIMIT = 200 * 1024

async function attachmentParts(
  att: MessageAttachment
): Promise<OpenAI.Chat.Completions.ChatCompletionContentPart[]> {
  const localPath = resolveAssetLocalPath(att.assetPath) ?? att.assetPath
  if (att.mimeType.startsWith('image/')) {
    const data = await readAssetData(att.assetPath)
    if (data) {
      return [
        {
          type: 'image_url',
          image_url: { url: `data:${att.mimeType};base64,${data.toString('base64')}` }
        }
      ]
    }
  } else if (isTextMime(att.mimeType) && att.size <= INLINE_TEXT_LIMIT) {
    const data = await readAssetData(att.assetPath)
    if (data) {
      return [
        {
          type: 'text',
          text: `<attachment name="${att.name}" path="${localPath}">\n${data.toString('utf8')}\n</attachment>`
        }
      ]
    }
  }
  const summary = att.summary ? ` summary="${att.summary}"` : ''
  return [
    {
      type: 'text',
      text: `<attachment name="${att.name}" mime="${att.mimeType}" size="${att.size}" path="${localPath}"${summary} />（内容未内联，需要时用 read_file 读取该路径）`
    }
  ]
}

function toOpenAiTool(t: ProviderTool): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>
    }
  }
}

function tryParseJson(str: string): Record<string, unknown> | string {
  try {
    return JSON.parse(str)
  } catch {
    return str
  }
}

/** 各家 usage 字段归一：缓存命中（OpenAI prompt_tokens_details / DeepSeek prompt_cache_hit_tokens）、推理 token */
function toUsage(u: OpenAI.Completions.CompletionUsage): TokenUsage {
  const x = u as OpenAI.Completions.CompletionUsage & { prompt_cache_hit_tokens?: number }
  const cached = x.prompt_tokens_details?.cached_tokens ?? x.prompt_cache_hit_tokens
  const reasoning = x.completion_tokens_details?.reasoning_tokens
  return {
    prompt: u.prompt_tokens,
    completion: u.completion_tokens,
    total: u.total_tokens,
    ...(typeof cached === 'number' ? { cached } : {}),
    ...(typeof reasoning === 'number' ? { reasoning } : {})
  }
}

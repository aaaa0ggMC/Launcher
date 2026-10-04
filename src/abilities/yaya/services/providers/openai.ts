/**
 * OpenAI 及其兼容端点（Codex-Proxy, DeepSeek, Ollama, vLLM 等）Provider 实现
 */
import OpenAI from 'openai'
import type { ProviderConfig, ToolDefinition, ToolCallItem, MessageAttachment } from '../../types'
import type {
  AIProvider,
  ProviderGenerateOptions,
  ProviderGenerateResult,
  ProviderMessage
} from './types'
import { readAssetData, resolveAssetLocalPath, isTextMime } from '../assets'
import { makeLogger } from '../../../../main/process/logger'

const log = makeLogger('yaya-provider-openai')

export class OpenAICompatibleProvider implements AIProvider {
  public id: string
  private client: OpenAI

  constructor(public config: ProviderConfig) {
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
    const res = await this.client.chat.completions.create(
      {
        model: options.model,
        messages,
        tools,
        temperature: options.temperature ?? 0.7
      },
      { signal: options.signal }
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
      usage: res.usage
        ? {
            prompt: res.usage.prompt_tokens,
            completion: res.usage.completion_tokens,
            total: res.usage.total_tokens
          }
        : undefined
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
      this.client.chat.completions.create(
        {
          model: options.model,
          messages,
          tools,
          temperature: options.temperature ?? 0.7,
          stream: true,
          ...(withUsage ? { stream_options: { include_usage: true } } : {})
        },
        { signal: options.signal }
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
      if (chunk.usage) {
        usage = {
          prompt: chunk.usage.prompt_tokens,
          completion: chunk.usage.completion_tokens,
          total: chunk.usage.total_tokens
        }
      }
      const delta = chunk.choices[0]?.delta
      if (!delta) continue

      // 文本 Token
      if (delta.content) {
        content += delta.content
        options.onToken?.(delta.content)
      }

      // 思考 / 推理过程（DeepSeek reasoning_content 或 OpenAI Responses 思考）
      const reasoning = (delta as { reasoning_content?: string })?.reasoning_content
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

    for (const m of messages) {
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

function toOpenAiTool(t: ToolDefinition): OpenAI.Chat.Completions.ChatCompletionTool {
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

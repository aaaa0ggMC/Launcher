/**
 * Google Gemini 原生 Provider（Generative Language API `models/{model}:generateContent`）。
 *
 * - 流式：`:streamGenerateContent?alt=sse`，每个 SSE 事件是一份完整的 GenerateContentResponse 增量；
 * - 工具：`functionDeclarations[].parametersJsonSchema`（完整 JSON Schema；端点不认识时退回
 *   `parameters` + 去掉不支持的关键字）；结果用 user 角色的 `functionResponse` 回传；
 * - 思考：2.x 用 `thinkingBudget`，3.x 用 `thinkingLevel`；`includeThoughts` 拿思考摘要；
 *   模型返回的 parts（含 `thoughtSignature`）存进 `native`，同一模型继续时原样放回，
 *   否则 Gemini 3 的多步工具调用会 400；
 * - 端点不认识思考配置 / JSON Schema 字段时去掉重试并记住；
 * - 自带搜索：`tools` 里加 `{google_search: {}}`，查询词与来源在 `groundingMetadata`；
 *   端点不让它和函数调用同时用（Gemini 2.x）时抛 BuiltinSearchUnsupportedError，运行器换回 GenericSearch。
 */
import { randomUUID } from 'node:crypto'
import type { MessageAttachment, ProviderConfig, ToolCallItem, TokenUsage } from '../../types'
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

const log = makeLogger('yaya-provider-gemini')

export const GEMINI_DEFAULT_BASE = 'https://generativelanguage.googleapis.com'

type Part = Record<string, unknown>
interface GeminiContent {
  role: 'user' | 'model'
  parts: Part[]
}

/** `/v1beta`（或 `/v1`）可写可不写 */
export function geminiUrl(baseUrl: string | undefined, path: string): string {
  const base = cleanBase(baseUrl, GEMINI_DEFAULT_BASE)
  return /\/v1(beta\d*)?$/.test(base) ? `${base}${path}` : `${base}/v1beta${path}`
}

function headers(apiKey: string | undefined): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) h['x-goog-api-key'] = apiKey
  return h
}

/** 模型名可能带 `models/` 前缀（列表接口返回的就是这种） */
function bareModel(model: string): string {
  return model.replace(/^models\//, '')
}

export async function listGeminiModels(
  baseUrl: string | undefined,
  apiKey: string | undefined,
  signal?: AbortSignal
): Promise<string[]> {
  const out: string[] = []
  let token = ''
  for (let page = 0; page < 10; page++) {
    const url = geminiUrl(
      baseUrl,
      `/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`
    )
    const res = await fetch(url, { headers: headers(apiKey), signal })
    await ensureOk(res, 'Gemini /models')
    const data = (await res.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>
      nextPageToken?: string
    }
    for (const m of data.models ?? []) {
      if (!m.name) continue
      const methods = m.supportedGenerationMethods
      if (methods && !methods.includes('generateContent')) continue
      out.push(bareModel(m.name))
    }
    if (!data.nextPageToken) break
    token = data.nextPageToken
  }
  return out
}

const BUDGETS = { low: 1024, medium: 8192, high: 24576 } as const

/** 思考强度 → thinkingConfig。default 只要摘要，不改模型默认的思考深度 */
export function geminiThinking(
  model: string,
  effort: ProviderGenerateOptions['reasoning']
): Record<string, unknown> {
  const legacy = /gemini-(1|2)\./.test(bareModel(model))
  switch (effort) {
    case 'off':
      return legacy ? { thinkingBudget: 0 } : { thinkingLevel: 'low' }
    case 'low':
    case 'medium':
    case 'high':
      return legacy
        ? { thinkingBudget: BUDGETS[effort], includeThoughts: true }
        : { thinkingLevel: effort, includeThoughts: true }
    default:
      return { includeThoughts: true }
  }
}

export function toGeminiUsage(u: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!u) return undefined
  const num = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0)
  const prompt = num('promptTokenCount')
  const thoughts = num('thoughtsTokenCount')
  const completion = num('candidatesTokenCount') + thoughts
  const cached = num('cachedContentTokenCount')
  return {
    prompt,
    completion,
    total: num('totalTokenCount') || prompt + completion,
    ...(cached ? { cached } : {}),
    ...(thoughts ? { reasoning: thoughts } : {})
  }
}

/** Gemini 旧版 `parameters`（OpenAPI 子集）不认识的 JSON Schema 关键字 */
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'additionalProperties',
  'patternProperties',
  'const',
  'examples',
  'default',
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else'
])

/** 退回 `parameters` 时用：递归去掉不支持的关键字 */
export function toOpenApiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toOpenApiSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(k)) continue
    if (k === 'type' && Array.isArray(v)) {
      // ["string", "null"] → string + nullable
      const types = v.filter((x) => x !== 'null')
      out.type = types[0] ?? 'string'
      if (types.length !== v.length) out.nullable = true
      continue
    }
    out[k] =
      k === 'properties' && v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toOpenApiSchema(pv)]))
        : toOpenApiSchema(v)
  }
  return out
}

function hasParams(p: Record<string, unknown> | undefined): boolean {
  if (!p || typeof p !== 'object') return false
  const props = p.properties as Record<string, unknown> | undefined
  return Boolean(props && Object.keys(props).length)
}

export class GeminiProvider implements AIProvider {
  public id: string
  private noThinking = false
  private legacySchema = false

  constructor(public config: ProviderConfig) {
    if (/^enc:v[12]:/.test(config.apiKey ?? '')) {
      throw new Error('Provider credentials could not be decrypted')
    }
    this.id = config.id
  }

  async listModels(): Promise<string[]> {
    try {
      return await listGeminiModels(this.config.baseUrl, this.config.apiKey)
    } catch (e) {
      log.warn(`Failed to list models for provider ${this.id}`, { error: String(e) })
      return this.config.models
    }
  }

  private buildTools(tools: ProviderTool[] | undefined, search?: boolean): unknown[] | undefined {
    const out: unknown[] = search ? [{ google_search: {} }] : []
    if (!tools?.length) return out.length ? out : undefined
    return [
      ...out,
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          ...(hasParams(t.parameters)
            ? this.legacySchema
              ? { parameters: toOpenApiSchema(t.parameters) }
              : { parametersJsonSchema: t.parameters }
            : {})
        }))
      }
    ]
  }

  async generate(options: ProviderGenerateOptions): Promise<ProviderGenerateResult> {
    const model = bareModel(options.model)
    const { system, contents } = await formatGeminiMessages(options.messages, model)
    const path = options.stream
      ? `/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
      : `/models/${encodeURIComponent(model)}:generateContent`

    let res: Response | null = null
    for (let attempt = 0; attempt < 3 && !res; attempt++) {
      const body: Record<string, unknown> = { contents }
      if (system) body.systemInstruction = { parts: [{ text: system }] }
      const tools = this.buildTools(options.tools, options.builtinSearch)
      if (tools) body.tools = tools
      if (!this.noThinking)
        body.generationConfig = { thinkingConfig: geminiThinking(model, options.reasoning) }
      const r = await fetch(geminiUrl(this.config.baseUrl, path), {
        method: 'POST',
        headers: headers(this.config.apiKey),
        body: JSON.stringify(body),
        signal: options.signal
      })
      try {
        await ensureOk(r, 'Gemini')
        res = r
      } catch (e) {
        if (!(e instanceof ProviderHttpError) || e.status !== 400 || options.signal?.aborted)
          throw e
        const msg = `${e.message} ${e.body}`
        if (options.builtinSearch && /google_search|search|function calling/i.test(msg)) {
          log.warn(`Provider ${this.id} rejected google_search for ${model}`)
          rejectBuiltinSearch(this.id, model)
          throw new BuiltinSearchUnsupportedError(this.id, model, msg)
        }
        if (!this.noThinking && /thinking/i.test(msg)) {
          log.warn(`Provider ${this.id} rejected thinkingConfig; retrying without it`)
          this.noThinking = true
        } else if (!this.legacySchema && /parametersJsonSchema|parameters_json_schema/.test(msg)) {
          log.warn(`Provider ${this.id} rejected parametersJsonSchema; using parameters`)
          this.legacySchema = true
        } else throw e
      }
    }
    if (!res) throw new Error('Gemini: request rejected repeatedly')

    const acc = new GeminiAccumulator(options)
    if (options.stream) {
      for await (const ev of readSse(res, options.signal)) {
        if (options.signal?.aborted) break
        if (!ev.data || ev.data === '[DONE]') continue
        let chunk: Record<string, unknown>
        try {
          chunk = JSON.parse(ev.data)
        } catch {
          continue
        }
        acc.add(chunk)
      }
    } else {
      acc.add((await res.json()) as Record<string, unknown>)
    }
    const result = acc.finish(model)
    return options.builtinSearch ? { ...result, search: acc.searchInfo() } : result
  }
}

/** 把一份或多份响应（流式增量）累积成统一结果 */
export class GeminiAccumulator {
  private parts: Part[] = []
  private content = ''
  private reasoning = ''
  private calls: ToolCallItem[] = []
  private usage: Record<string, unknown> | undefined
  private finishReason = ''
  private blockReason = ''
  private search = new SearchCollector()

  constructor(private options: Pick<ProviderGenerateOptions, 'onToken' | 'onReasoning'>) {}

  add(chunk: Record<string, unknown>): void {
    if (chunk.error) {
      const err = chunk.error as { message?: string }
      throw new Error(`Gemini stream error: ${err.message ?? JSON.stringify(chunk.error)}`)
    }
    if (chunk.usageMetadata) this.usage = chunk.usageMetadata as Record<string, unknown>
    const feedback = chunk.promptFeedback as { blockReason?: string } | undefined
    if (feedback?.blockReason) this.blockReason = feedback.blockReason
    const cand = (chunk.candidates as Array<Record<string, unknown>> | undefined)?.[0]
    if (!cand) return
    if (typeof cand.finishReason === 'string') this.finishReason = cand.finishReason
    const grounding = cand.groundingMetadata as
      | {
          webSearchQueries?: unknown[]
          groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>
        }
      | undefined
    if (grounding) {
      for (const q of grounding.webSearchQueries ?? []) this.search.query(q)
      for (const c of grounding.groundingChunks ?? []) this.search.source(c.web?.uri, c.web?.title)
    }
    const parts = ((cand.content as { parts?: Part[] } | undefined)?.parts ?? []) as Part[]
    for (const p of parts) {
      if (typeof p.text === 'string') {
        if (p.thought) {
          this.reasoning += p.text
          if (p.text) this.options.onReasoning?.(p.text)
          // 思考摘要本身不用回传，但签名要
          if (p.thoughtSignature)
            this.parts.push({ text: '', thoughtSignature: p.thoughtSignature })
          continue
        }
        this.content += p.text
        if (p.text) this.options.onToken?.(p.text)
        const last = this.parts[this.parts.length - 1]
        // 相邻的普通文本合并（签名留在它出现的那一块上）
        if (
          last &&
          typeof last.text === 'string' &&
          !last.thoughtSignature &&
          !p.thoughtSignature &&
          !last.thought
        )
          last.text = String(last.text) + p.text
        else this.parts.push({ ...p })
      } else if (p.functionCall) {
        const fc = p.functionCall as { name?: string; args?: unknown; id?: string }
        const args = fc.args
        this.calls.push({
          id: fc.id || `call_${randomUUID().slice(0, 8)}`,
          name: String(fc.name ?? ''),
          args:
            args && typeof args === 'object'
              ? (args as Record<string, unknown>)
              : typeof args === 'string'
                ? tryParseJson(args)
                : {},
          status: 'pending'
        })
        this.parts.push({ ...p })
      } else if (p.thoughtSignature) {
        this.parts.push({ ...p })
      }
    }
  }

  searchInfo(): ProviderGenerateResult['search'] {
    return this.search.result()
  }

  finish(model: string): ProviderGenerateResult {
    if (this.blockReason && !this.content && !this.calls.length)
      throw new Error(`Gemini blocked the prompt (${this.blockReason})`)
    if (
      !this.content &&
      !this.calls.length &&
      /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(this.finishReason)
    )
      throw new Error(`Gemini stopped without output (${this.finishReason})`)
    const native: NativeState | undefined = this.parts.some((p) => p.thoughtSignature)
      ? { type: 'gemini', model, data: this.parts }
      : undefined
    return {
      content: this.content,
      reasoningContent: this.reasoning || undefined,
      // includeThoughts 给的是思考摘要（分段，带加粗小标题），不是原始思维链
      ...(this.reasoning ? { reasoningSummary: true } : {}),
      toolCalls: this.calls.length ? this.calls : undefined,
      usage: toGeminiUsage(this.usage),
      ...(native ? { native } : {})
    }
  }
}

async function attachmentParts(att: MessageAttachment): Promise<Part[]> {
  const a = await loadAttachment(att, { pdf: true })
  if (a.kind === 'image') return [{ inlineData: { mimeType: a.mimeType, data: a.base64 } }]
  if (a.kind === 'pdf') return [{ inlineData: { mimeType: 'application/pdf', data: a.base64 } }]
  return [{ text: a.text }]
}

/** functionResponse.response 必须是对象：JSON 结果原样放 result，文本也放 result */
function responseObject(content: string): Record<string, unknown> {
  const parsed = tryParseJson(content)
  return { result: typeof parsed === 'string' ? content : parsed }
}

/**
 * 统一消息 → Gemini contents：system 进 systemInstruction；assistant = model；
 * tool 结果 = user 里的 functionResponse（按调用的名字对应）。同模型上次的 parts（含签名）原样放回。
 */
export async function formatGeminiMessages(
  input: ProviderMessage[],
  model: string
): Promise<{ system: string; contents: GeminiContent[] }> {
  const systemParts: string[] = []
  const contents: GeminiContent[] = []
  const callNames = new Map<string, string>()
  const push = (role: 'user' | 'model', parts: Part[]): void => {
    if (!parts.length) return
    const last = contents[contents.length - 1]
    if (last && last.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }

  for (const m of input) {
    if (m.role === 'system') {
      if (m.content.trim()) systemParts.push(m.content)
    } else if (m.role === 'assistant') {
      for (const tc of m.toolCalls ?? []) callNames.set(tc.id, tc.name)
      if (
        m.native?.type === 'gemini' &&
        bareModel(m.native.model) === model &&
        Array.isArray(m.native.data)
      ) {
        push(
          'model',
          (m.native.data as Part[]).map((p) => ({ ...p }))
        )
        continue
      }
      const parts: Part[] = []
      if (m.content?.trim()) parts.push({ text: m.content })
      for (const tc of m.toolCalls ?? []) {
        const args = typeof tc.args === 'string' ? tryParseJson(tc.args) : tc.args
        parts.push({
          functionCall: { name: tc.name, args: typeof args === 'object' && args ? args : {} }
        })
      }
      push('model', parts)
    } else if (m.role === 'tool') {
      const name = m.name || callNames.get(m.toolCallId ?? '') || 'tool'
      const parts: Part[] = [
        { functionResponse: { name, response: responseObject(m.content ?? '') } }
      ]
      for (const att of m.attachments ?? []) {
        if (att.mimeType.startsWith('image/')) parts.push(...(await attachmentParts(att)))
      }
      push('user', parts)
    } else {
      const parts: Part[] = []
      for (const att of m.attachments ?? []) parts.push(...(await attachmentParts(att)))
      if (m.content?.trim()) parts.push({ text: m.content })
      push('user', parts)
    }
  }
  if (contents[0]?.role === 'model') contents.unshift({ role: 'user', parts: [{ text: '…' }] })
  return { system: systemParts.join('\n\n'), contents }
}

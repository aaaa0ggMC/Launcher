import { it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  GeminiProvider,
  formatGeminiMessages,
  geminiThinking,
  geminiUrl,
  toGeminiUsage,
  toOpenApiSchema
} from './gemini'
import type { ProviderConfig } from '../../types'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const cfg: ProviderConfig = {
  id: 'gem',
  name: 'Gemini',
  type: 'gemini',
  apiKey: 'k',
  enabled: true,
  models: []
}

function sse(chunks: Array<Record<string, unknown>>): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join('')
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

it('URL：缺省 v1beta，已带版本号就不再加', () => {
  assert.equal(
    geminiUrl(undefined, '/models'),
    'https://generativelanguage.googleapis.com/v1beta/models'
  )
  assert.equal(geminiUrl('https://g.dev/v1beta/', '/models'), 'https://g.dev/v1beta/models')
  assert.equal(geminiUrl('https://g.dev/v1', '/models'), 'https://g.dev/v1/models')
})

it('思考：2.x 用预算，3.x 用档位；default 只要摘要', () => {
  assert.deepEqual(geminiThinking('gemini-2.5-flash', 'off'), { thinkingBudget: 0 })
  assert.deepEqual(geminiThinking('models/gemini-2.5-pro', 'high'), {
    thinkingBudget: 24576,
    includeThoughts: true
  })
  assert.deepEqual(geminiThinking('gemini-3-pro-preview', 'low'), {
    thinkingLevel: 'low',
    includeThoughts: true
  })
  assert.deepEqual(geminiThinking('gemini-3-pro-preview', 'default'), { includeThoughts: true })
})

it('usage：思考 token 计入输出并单列', () => {
  assert.deepEqual(
    toGeminiUsage({
      promptTokenCount: 10,
      candidatesTokenCount: 4,
      thoughtsTokenCount: 6,
      cachedContentTokenCount: 3,
      totalTokenCount: 20
    }),
    { prompt: 10, completion: 10, total: 20, cached: 3, reasoning: 6 }
  )
})

it('旧版 parameters：去掉不支持的关键字，可空类型转 nullable', () => {
  assert.deepEqual(
    toOpenApiSchema({
      $schema: 'x',
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: ['string', 'null'], default: 'q' } }
    }),
    { type: 'object', properties: { a: { type: 'string', nullable: true } } }
  )
})

it('消息格式：tool 结果按名字回传，同模型 parts（含签名）原样放回', async () => {
  const nativeParts = [{ functionCall: { name: 'f', args: { a: 1 } }, thoughtSignature: 'SIG' }]
  const { system, contents } = await formatGeminiMessages(
    [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'f', args: { a: 1 } }],
        native: { type: 'gemini', model: 'models/gemini-3-pro', data: nativeParts }
      },
      { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' },
      {
        role: 'assistant',
        content: 'done',
        native: { type: 'gemini', model: 'gemini-2.5-pro', data: [{ text: 'x' }] }
      }
    ],
    'gemini-3-pro'
  )
  assert.equal(system, 'sys')
  assert.deepEqual(
    contents.map((c) => c.role),
    ['user', 'model', 'user', 'model']
  )
  assert.deepEqual(contents[1].parts, nativeParts)
  assert.deepEqual(contents[2].parts[0], {
    functionResponse: { name: 'f', response: { result: { ok: true } } }
  })
  assert.deepEqual(contents[3].parts, [{ text: 'done' }])
})

it('流式：思考摘要 / 文本 / 函数调用累积，带签名时存 native', async () => {
  let url = ''
  let sent: Record<string, unknown> = {}
  globalThis.fetch = (async (u: string, init: RequestInit) => {
    url = u
    sent = JSON.parse(String(init.body))
    return sse([
      { candidates: [{ content: { role: 'model', parts: [{ text: '嗯', thought: true }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: '好' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: '的' }] } }] },
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'f', args: { q: 'x' } }, thoughtSignature: 'S' }]
            },
            finishReason: 'STOP'
          }
        ],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 }
      }
    ])
  }) as typeof fetch
  const tokens: string[] = []
  const res = await new GeminiProvider(cfg).generate({
    model: 'models/gemini-3-pro',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        name: 'f',
        description: 'd',
        parameters: { type: 'object', properties: { q: { type: 'string' } } }
      },
      { name: 'g', description: 'no params', parameters: {} }
    ],
    stream: true,
    onToken: (t) => tokens.push(t)
  })
  assert.match(url, /\/v1beta\/models\/gemini-3-pro:streamGenerateContent\?alt=sse$/)
  const decls = (sent.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>)[0]
    .functionDeclarations
  assert.ok(decls[0].parametersJsonSchema)
  assert.ok(!('parametersJsonSchema' in decls[1]))
  assert.equal(res.content, '好的')
  assert.equal(res.reasoningContent, '嗯')
  assert.deepEqual(tokens, ['好', '的'])
  assert.equal(res.toolCalls?.[0].name, 'f')
  assert.deepEqual(res.toolCalls?.[0].args, { q: 'x' })
  assert.deepEqual(res.native?.data, [
    { text: '好的' },
    { functionCall: { name: 'f', args: { q: 'x' } }, thoughtSignature: 'S' }
  ])
  assert.deepEqual(res.usage, { prompt: 2, completion: 3, total: 5 })
})

it('端点拒绝思考配置：去掉重试', async () => {
  const bodies: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    bodies.push(body)
    if (body.generationConfig)
      return new Response(
        JSON.stringify({ error: { message: 'Thinking is not supported for this model' } }),
        { status: 400 }
      )
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
      { status: 200 }
    )
  }) as typeof fetch
  const res = await new GeminiProvider(cfg).generate({
    model: 'gemini-2.0-flash',
    messages: [{ role: 'user', content: 'x' }]
  })
  assert.equal(res.content, 'ok')
  assert.equal(bodies.length, 2)
  assert.equal(res.native, undefined)
})

it('提示被拦截且没有输出：报错', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), {
      status: 200
    })) as typeof fetch
  await assert.rejects(
    new GeminiProvider(cfg).generate({ model: 'g', messages: [{ role: 'user', content: 'x' }] }),
    /blocked the prompt \(SAFETY\)/
  )
})

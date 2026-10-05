import { it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  AnthropicProvider,
  anthropicReasoning,
  anthropicUrl,
  formatAnthropicMessages,
  toAnthropicUsage
} from './anthropic'
import type { ProviderConfig } from '../../types'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const cfg: ProviderConfig = {
  id: 'claude',
  name: 'Claude',
  type: 'anthropic',
  apiKey: 'sk-test',
  enabled: true,
  models: ['claude-opus-5-5']
}

function sse(events: Array<Record<string, unknown>>): Response {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  // 故意切成小块，覆盖跨块的行拼接
  const bytes = new TextEncoder().encode(text)
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7))
      c.close()
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

it('URL 兼容带不带 /v1 的 baseUrl，缺省走官方地址', () => {
  assert.equal(anthropicUrl(undefined, '/messages'), 'https://api.anthropic.com/v1/messages')
  assert.equal(anthropicUrl('https://x.dev/v1/', '/models'), 'https://x.dev/v1/models')
  assert.equal(anthropicUrl('https://x.dev/api', '/messages'), 'https://x.dev/api/v1/messages')
})

it('思考强度：default 不发参数，off 只降强度，其余 adaptive + effort', () => {
  assert.deepEqual(anthropicReasoning('default'), {})
  assert.deepEqual(anthropicReasoning('off'), { output_config: { effort: 'low' } })
  assert.deepEqual(anthropicReasoning('high'), {
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: 'high' }
  })
})

it('usage：缓存读写都计入输入，cached = 缓存命中', () => {
  assert.deepEqual(
    toAnthropicUsage({
      input_tokens: 10,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 5,
      output_tokens: 7
    }),
    { prompt: 115, completion: 7, total: 122, cached: 100 }
  )
})

it('消息格式：system 顶层、tool 结果合并进一条 user、同模型才回传 thinking 块', async () => {
  const thinking = [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }]
  const { system, messages } = await formatAnthropicMessages(
    [
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        native: { type: 'anthropic', model: 'claude-opus-5-5', data: thinking },
        toolCalls: [
          { id: 'call:1', name: 'a', args: { x: 1 } },
          { id: 'call_2', name: 'b', args: '{"y":2}' }
        ]
      },
      { role: 'tool', toolCallId: 'call:1', content: 'r1' },
      { role: 'tool', toolCallId: 'call_2', content: 'r2' },
      {
        role: 'assistant',
        content: 'done',
        native: { type: 'anthropic', model: 'claude-sonnet-5-5', data: thinking }
      },
      { role: 'user', content: 'next' }
    ],
    'claude-opus-5-5'
  )
  assert.equal(system, 'be nice')
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant', 'user']
  )
  const first = messages[1].content
  assert.equal(first[0].type, 'thinking')
  assert.deepEqual(first[1], { type: 'tool_use', id: 'call_1', name: 'a', input: { x: 1 } })
  assert.deepEqual(first[2].input, { y: 2 })
  const results = messages[2].content
  assert.equal(results.length, 2)
  assert.equal(results[0].tool_use_id, 'call_1')
  // 别的模型产生的 thinking 块不回传
  assert.deepEqual(messages[3].content, [{ type: 'text', text: 'done' }])
})

it('以 assistant 开头的历史前面补一条 user', async () => {
  const { messages } = await formatAnthropicMessages([{ role: 'assistant', content: 'hello' }], 'm')
  assert.equal(messages[0].role, 'user')
})

it('流式：文本 / 思考 / 签名 / 工具参数分块累积，thinking 块进 native', async () => {
  let sent: Record<string, unknown> = {}
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body))
    return sse([
      {
        type: 'message_start',
        message: { usage: { input_tokens: 3, cache_read_input_tokens: 2 } }
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'S' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_time', input: {} }
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"tz":' }
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '"UTC"}' }
      },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' }
    ])
  }) as typeof fetch

  const tokens: string[] = []
  const thoughts: string[] = []
  const res = await new AnthropicProvider(cfg).generate({
    model: 'claude-opus-5-5',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'time?' }
    ],
    tools: [{ name: 'get_time', description: 'd', parameters: {} }],
    stream: true,
    reasoning: 'medium',
    onToken: (t) => tokens.push(t),
    onReasoning: (t) => thoughts.push(t)
  })
  assert.equal(sent.system, 'sys')
  assert.equal(sent.stream, true)
  assert.deepEqual(sent.output_config, { effort: 'medium' })
  assert.deepEqual((sent.tools as Array<Record<string, unknown>>)[0].input_schema, {
    type: 'object',
    properties: {}
  })
  assert.equal(res.content, '你好')
  assert.equal(res.reasoningContent, '想')
  assert.deepEqual(tokens, ['你好'])
  assert.deepEqual(thoughts, ['想'])
  assert.deepEqual(res.toolCalls?.[0].args, { tz: 'UTC' })
  assert.deepEqual(res.native, {
    type: 'anthropic',
    model: 'claude-opus-5-5',
    data: [{ type: 'thinking', thinking: '想', signature: 'S' }]
  })
  assert.deepEqual(res.usage, { prompt: 5, completion: 9, total: 14, cached: 2 })
})

it('端点拒绝 thinking 字段：去掉重试并记住', async () => {
  const bodies: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    bodies.push(body)
    if ('thinking' in body)
      return new Response(
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'thinking: unknown' } }),
        { status: 400 }
      )
    return new Response(
      JSON.stringify({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 }
      }),
      { status: 200 }
    )
  }) as typeof fetch
  const p = new AnthropicProvider(cfg)
  const opts = {
    model: 'claude-haiku-4-5',
    messages: [{ role: 'user' as const, content: 'x' }],
    reasoning: 'high' as const
  }
  assert.equal((await p.generate(opts)).content, 'ok')
  assert.equal((await p.generate(opts)).content, 'ok')
  assert.equal(bodies.length, 3)
  assert.ok(!('thinking' in bodies[2]))
})

it('refusal 且没有任何输出：报错说明原因', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        content: [],
        stop_reason: 'refusal',
        stop_details: { category: 'cyber', explanation: 'nope' }
      }),
      { status: 200 }
    )) as typeof fetch
  await assert.rejects(
    new AnthropicProvider(cfg).generate({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }]
    }),
    /refusal, cyber: nope/
  )
})

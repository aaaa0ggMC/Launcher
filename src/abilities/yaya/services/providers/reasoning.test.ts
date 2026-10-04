import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEffort, reasoningParams, resolveReasoningStyle } from './reasoning'

test('思考参数格式：按地址识别，显式设置优先', () => {
  assert.equal(
    resolveReasoningStyle({ type: 'openai', baseUrl: 'https://api.deepseek.com/v1' }),
    'deepseek'
  )
  assert.equal(
    resolveReasoningStyle({ type: 'openai', baseUrl: 'https://openrouter.ai/api/v1' }),
    'openrouter'
  )
  assert.equal(
    resolveReasoningStyle({
      type: 'openai',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    }),
    'qwen'
  )
  assert.equal(
    resolveReasoningStyle({ type: 'openai', baseUrl: 'http://127.0.0.1:8080/v1' }),
    'llamacpp'
  )
  assert.equal(
    resolveReasoningStyle({ type: 'openai', baseUrl: 'https://api.openai.com/v1' }),
    'openai'
  )
  assert.equal(
    resolveReasoningStyle({
      type: 'openai',
      baseUrl: 'https://api.deepseek.com',
      reasoningStyle: 'none'
    }),
    'none'
  )
})

test('思考参数：default / none 不发，其余按格式', () => {
  assert.deepEqual(reasoningParams('openai', 'default'), {})
  assert.deepEqual(reasoningParams('none', 'high'), {})
  assert.deepEqual(reasoningParams('openai', 'high'), { reasoning_effort: 'high' })
  assert.deepEqual(reasoningParams('openai', 'off'), { reasoning_effort: 'minimal' })
  assert.deepEqual(reasoningParams('openai', 'off', 'ollama'), { reasoning_effort: 'none' })
  assert.deepEqual(reasoningParams('deepseek', 'off'), { thinking: { type: 'disabled' } })
  assert.deepEqual(reasoningParams('deepseek', 'low'), { thinking: { type: 'enabled' } })
  assert.deepEqual(reasoningParams('qwen', 'off'), { enable_thinking: false })
  assert.deepEqual(reasoningParams('qwen', 'medium'), {
    enable_thinking: true,
    thinking_budget: 4096
  })
  assert.deepEqual(reasoningParams('openrouter', 'off'), { reasoning: { enabled: false } })
  assert.deepEqual(reasoningParams('llamacpp', 'off'), {
    chat_template_kwargs: { enable_thinking: false }
  })
  assert.equal(normalizeEffort('bogus'), 'default')
  assert.equal(normalizeEffort('high'), 'high')
})

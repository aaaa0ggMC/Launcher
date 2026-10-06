/**
 * 模型元数据存储与费用计算的单测。HOME 指向 /tmp 临时目录（model-meta.json 写在那里）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { before, it } from 'node:test'

process.env.HOME = mkdtempSync('/tmp/yaya-models-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`
if (!process.env.HOME.startsWith('/tmp/')) {
  throw new Error('拒绝运行：HOME 必须是 /tmp 下的临时目录，避免改写真实用户配置')
}

let store: typeof import('./store')
let plugin: typeof import('./index')
before(async () => {
  store = await import('./store')
  plugin = await import('./index')
})

it('合并写入、null 清除字段、非法值丢掉', () => {
  store.setMeta('*', 'gpt-5', store.normalizeMetaPatch({ input: 1.25, output: '10' }), 'ai')
  const e = store.setMeta(
    '*',
    'gpt-5',
    store.normalizeMetaPatch({ cachedInput: 0.125, output: -1, contextWindow: 400000.4 }),
    'user'
  )
  assert.equal(e.input, 1.25)
  assert.equal(e.output, 10)
  assert.equal(e.cachedInput, 0.125)
  assert.equal(e.contextWindow, 400000)
  assert.equal(e.updatedBy, 'user')
  const cleared = store.setMeta(
    '*',
    'gpt-5',
    store.normalizeMetaPatch({ cachedInput: null }),
    'user'
  )
  assert.equal(cleared.cachedInput, undefined)
  assert.ok(!('cachedInput' in cleared))
})

it('查找：精确 → * → 去掉厂商前缀', () => {
  store.setMeta('prov-a', 'gpt-5', { input: 2, output: 20 }, 'user')
  assert.equal(store.lookupMeta('prov-a', 'gpt-5')?.input, 2)
  assert.equal(store.lookupMeta('prov-b', 'gpt-5')?.input, 1.25)
  assert.equal(store.lookupMeta('prov-b', 'openai/GPT-5')?.input, 1.25)
  assert.equal(store.lookupMeta('prov-b', 'claude'), null)
  store.__resetModelMetaCacheForTest()
  assert.equal(store.lookupMeta('prov-a', 'gpt-5')?.input, 2, '重新从磁盘读')
})

it('费用：缓存命中按缓存价，没有价格的模型单独计数', () => {
  const meta = { input: 1, cachedInput: 0.1, output: 10, currency: 'USD' }
  const lookup = (_p: string, m: string): typeof meta | null => (m === 'priced' ? meta : null)
  const call = (
    model: string,
    prompt: number,
    cached: number,
    completion: number
  ): import('../../services/usage').UsageCall => ({
    messageId: model,
    at: 0,
    model,
    provider: 'p',
    prompt,
    cached,
    completion,
    reasoning: 0,
    total: prompt + completion,
    active: true
  })
  const data = plugin.computeCost(
    { calls: [call('priced', 1_000_000, 500_000, 100_000), call('free', 10, 0, 10)] },
    () => 'P',
    lookup
  )
  // 50 万非缓存 × $1 + 50 万缓存 × $0.1 + 10 万输出 × $10 = 0.5 + 0.05 + 1
  assert.equal(data.totals.USD.toFixed(4), '1.5500')
  assert.equal(data.missing, 1)
  assert.equal(data.rows[0].model, 'priced')
  assert.equal(data.rows[1].cost, null)
  assert.equal(store.formatMoney(1.55, 'USD'), '$1.55')
  assert.equal(store.formatMoney(0.00123, 'CNY'), '¥0.0012')
})

it('删除只删指定 key', () => {
  assert.equal(store.deleteMeta('prov-a', 'gpt-5'), true)
  assert.equal(store.deleteMeta('prov-a', 'gpt-5'), false)
  assert.equal(store.lookupMeta('prov-a', 'gpt-5')?.input, 1.25)
})

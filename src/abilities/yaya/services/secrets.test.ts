/**
 * SecretPlugin 存储与变换的单测。HOME 指向 /tmp 临时目录（加密主密钥与 secret 文件都写在那里）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { before, it } from 'node:test'

process.env.HOME = mkdtempSync('/tmp/yaya-secrets-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`
if (!process.env.HOME.startsWith('/tmp/')) {
  throw new Error('拒绝运行：HOME 必须是 /tmp 下的临时目录，避免改写真实用户配置')
}

let s: typeof import('./secrets')
before(async () => {
  s = await import('./secrets')
})

it('#Secret("…") 换成引用，值加密落盘，同一个值复用 id', () => {
  const r = s.extractSecrets(
    'sess1',
    '用 #Secret("sk-abc\\"123") 和 #Secret(“密码 2”) 再来 #Secret("sk-abc\\"123")'
  )
  assert.equal(r.ids.length, 3)
  assert.equal(r.ids[0], r.ids[2])
  assert.doesNotMatch(r.text, /sk-abc|密码 2/)
  assert.match(r.text, /^用 \[\[secret_[a-z0-9]{4}\]\] 和 \[\[secret_[a-z0-9]{4}\]\] 再来/)
  const file = readFileSync(
    `${process.env.HOME}/.config/LinuxCockpit/yaya/secrets/sess1.json`,
    'utf-8'
  )
  assert.doesNotMatch(file, /sk-abc|密码 2/)
  assert.deepEqual(Object.values(s.secretValues('sess1')).sort(), ['sk-abc"123', '密码 2'])
})

it('工具参数里替换成真值，结果里换回引用；别的会话不受影响', () => {
  const [id] = s.listSecretIds('sess1')
  const value = s.secretValues('sess1')[id]
  const args = s.substituteSecrets('sess1', {
    header: `Bearer [[${id}]]`,
    list: [`[[${id}]]`],
    n: 1
  })
  assert.deepEqual(args, { header: `Bearer ${value}`, list: [value], n: 1 })
  assert.equal(s.substituteSecrets('other', `[[${id}]]`), `[[${id}]]`)
  const out = s.scrubSecrets('sess1', { text: `echo: ${value}!`, nested: [{ v: value }] })
  assert.deepEqual(out, { text: `echo: [[${id}]]!`, nested: [{ v: `[[${id}]]` }] })
})

it('没有 #Secret 的文本原样返回；删除会话清掉 secret', () => {
  assert.deepEqual(s.extractSecrets('sess2', 'hello'), { text: 'hello', ids: [] })
  s.deleteSessionSecrets('sess1')
  s.__resetSecretCacheForTest()
  assert.deepEqual(s.listSecretIds('sess1'), [])
})

it('插件启用时经注册表的钩子生效（runner / manager 调的就是这些）', async () => {
  const registry = await import('./plugins/registry')
  const config = await import('./config')
  const plugin = (await import('../plugins/secret/index')).default
  registry.__resetPluginsForTest()
  registry.registerPlugin(plugin)
  const cfg = config.loadYayaConfig()
  registry.refreshPlugins(cfg)
  const text = registry.applyUserTextHooks('sess3', 'k=#Secret("v-1234")', cfg)
  const id = s.listSecretIds('sess3')[0]
  assert.equal(text, `k=[[${id}]]`)
  assert.deepEqual(registry.applyToolArgsHooks('sess3', 't', { a: `[[${id}]]` }, cfg), {
    a: 'v-1234'
  })
  assert.equal(registry.applyToolResultHooks('sess3', 't', 'got v-1234', cfg), `got [[${id}]]`)
  // 关掉插件：钩子不再生效
  const off = { ...cfg, pluginEnabled: { ...cfg.pluginEnabled, secret: false } }
  assert.deepEqual(registry.applyToolArgsHooks('sess3', 't', { a: `[[${id}]]` }, off), {
    a: `[[${id}]]`
  })
})

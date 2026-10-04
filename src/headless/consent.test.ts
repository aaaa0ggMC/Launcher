import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'

// 会读写 ~/.config/LinuxCockpit（日志）：先把 HOME 指到临时目录，再动态 import（AGENTS §11.7）
const home = mkdtempSync(join('/tmp', 'cockpit-consent-test-'))
process.env.HOME = home
process.env.XDG_CONFIG_HOME = join(home, '.config')
if (!process.env.HOME.startsWith('/tmp/'))
  throw new Error('拒绝运行：HOME 必须是 /tmp 下的临时目录，避免改写真实用户配置')

test('网页版授权：nonce 只经推送下发，错 / 旧 nonce 拒绝，用后作废', async () => {
  const privacy = await import('../main/process/privacy')
  const consent = await import('./consent')

  privacy.definePrivacyScopes('consent-test', { private: { level: 'sensitive' } })
  const pushed: { id: string; nonce: string }[][] = []
  consent.initHeadlessConsent((_ch, list) => pushed.push(list))

  const agent = { kind: 'local-agent' as const, session: 'yaya:t:1' }
  const granted = privacy.withOrigin(agent, () =>
    privacy.guard('consent-test.private', '测试', { waitMs: 5000 })
  )
  await new Promise((r) => setTimeout(r, 20))
  const frame = pushed.at(-1)!
  assert.equal(frame.length, 1)
  const { id, nonce } = frame[0]
  assert.ok(nonce && nonce.length >= 24)

  assert.equal(consent.decideFromPage({ id, nonce: 'wrong', decision: 'once' }).ok, false)
  assert.equal(consent.decideFromPage({ id, decision: 'once' }).ok, false)
  assert.equal(consent.decideFromPage({ id, nonce, decision: 'bogus' }).ok, false)
  assert.equal(consent.decideFromPage({ id, nonce, decision: 'once' }).ok, true)
  await granted
  // 用后作废：同一个 nonce 不能再用
  assert.equal(consent.decideFromPage({ id, nonce, decision: 'once' }).ok, false)
})

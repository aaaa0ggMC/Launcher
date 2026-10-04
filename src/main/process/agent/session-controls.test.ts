import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'

// 会读写 ~/.config/LinuxCockpit（日志）：先把 HOME 指到临时目录，再动态 import（AGENTS §11.7）
const home = mkdtempSync(join('/tmp', 'cockpit-session-controls-test-'))
process.env.HOME = home
process.env.XDG_CONFIG_HOME = join(home, '.config')
if (!process.env.HOME.startsWith('/tmp/'))
  throw new Error('拒绝运行：HOME 必须是 /tmp 下的临时目录，避免改写真实用户配置')

test('「本次执行都允许」只对该 agent 会话有效，会话结束即撤销', async () => {
  const privacy = await import('../privacy')
  const sessions = await import('./sessions')
  privacy.definePrivacyScopes('run-test', { data: { level: 'sensitive' } })
  privacy.setConsentPresenter((list) => {
    for (const r of list) privacy.decideConsent(r.id, 'agent')
  })
  const a = { kind: 'local-agent' as const, session: 'yaya:s:1' }
  const b = { kind: 'local-agent' as const, session: 'yaya:s:2' }
  sessions.touchSession(a.session, 'local', 'YAYA')
  await privacy.withOrigin(a, () => privacy.guard('run-test.data', 't'))
  assert.equal(privacy.hasClearance('run-test.data', a), true)
  assert.equal(privacy.clearanceInfo('run-test.data', a).via, 'agent')
  assert.equal(privacy.hasClearance('run-test.data', b), false, '别的执行拿不到')
  sessions.endSession(a.session)
  assert.equal(privacy.hasClearance('run-test.data', a), false, '执行结束即撤销')
})

test('会话控制：批准 / 拒绝转给控制器，attention 可设可清', async () => {
  const sessions = await import('./sessions')
  const id = 'yaya:s:3'
  sessions.touchSession(id, 'local', 'YAYA')
  const seen: boolean[] = []
  sessions.setSessionControl(id, { approve: (ok) => seen.push(ok) }, 'yaya', { session: 's' })
  sessions.setSessionAttention(id, { kind: 'approval', tool: 'run_bash' })
  assert.deepEqual(sessions.getSession(id)?.attention, { kind: 'approval', tool: 'run_bash' })
  assert.equal(sessions.getSession(id)?.controls?.approve, true)
  assert.equal(sessions.controlSession(id, 'approve'), true)
  assert.equal(sessions.controlSession(id, 'reject'), true)
  assert.deepEqual(seen, [true, false])
  assert.equal(sessions.controlSession(id, 'pause'), false, '没登记暂停就不能暂停')
  sessions.setSessionAttention(id, null)
  assert.equal(sessions.getSession(id)?.attention, undefined)
  sessions.endSession(id)
})

test('AI 操作的页面：按命令所属能力记录，框架命令与 ui.* 不算', async () => {
  const privacy = await import('../privacy')
  const sessions = await import('./sessions')
  const id = 'yaya:s:4'
  sessions.touchSession(id, 'local', 'YAYA')
  const o = { kind: 'local-agent' as const, session: id }
  privacy.withOrigin(o, () => sessions.noteAgentCommand('gameboy.press'))
  assert.equal(sessions.getSession(id)?.focus, 'gameboy')
  privacy.withOrigin(o, () => sessions.noteAgentCommand('ui.click'))
  privacy.withOrigin(o, () => sessions.noteAgentCommand('agent.sessions'))
  assert.equal(sessions.getSession(id)?.focus, 'gameboy')
  // 用户自己的调用不影响
  sessions.noteAgentCommand('aidj.next')
  assert.equal(sessions.getSession(id)?.focus, 'gameboy')
  sessions.endSession(id)
})

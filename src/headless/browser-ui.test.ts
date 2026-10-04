import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'

// 会读写 ~/.config/LinuxCockpit（日志）：先把 HOME 指到临时目录，再动态 import（AGENTS §11.7）
const home = mkdtempSync(join('/tmp', 'cockpit-browser-ui-test-'))
process.env.HOME = home
process.env.XDG_CONFIG_HOME = join(home, '.config')
if (!process.env.HOME.startsWith('/tmp/'))
  throw new Error('拒绝运行：HOME 必须是 /tmp 下的临时目录，避免改写真实用户配置')

const CLIENT_A = '11111111-1111-4111-8111-111111111111'
const CLIENT_B = '22222222-2222-4222-8222-222222222222'

interface Frame {
  channel: string
  args: unknown[]
}

interface Req {
  id: string
  method: string
  args: Record<string, unknown>
  session?: string
}

const frames: Frame[] = []
const sender = (channel: string, args: unknown[]): void => {
  frames.push({ channel, args })
}

function lastUiReq(): Req | null {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].channel !== 'cockpit:browser-ui') continue
    const req = frames[i].args[0] as Req | undefined
    if (req && typeof req.id === 'string') return req
  }
  return null
}

/** 等新的 cockpit:browser-ui 请求帧出现（重试在 guard 之后才发出）。 */
async function nextUiReq(from: number, timeoutMs = 2000): Promise<Req> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    for (let i = frames.length - 1; i >= from; i--) {
      if (frames[i].channel !== 'cockpit:browser-ui') continue
      const req = frames[i].args[0] as Req | undefined
      if (req && typeof req.id === 'string') return req
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('no new browser-ui request frame')
}

test('浏览器 UI 桥：关联 / 应答匹配 / 超时 / 断开 / 来源守卫 / 主机不打标记', async () => {
  const mod = await import('../main/process/browser-ui')
  const privacy = await import('../main/process/privacy')
  const { withOrigin } = privacy

  // 重复 clientId 被拒绝（不顶掉另一个标签页）
  assert.equal(mod.registerBrowserClient(CLIENT_A, sender), true)
  assert.equal(
    mod.registerBrowserClient(CLIENT_A, () => {}),
    false
  )

  const yaya = { kind: 'local-agent' as const, session: 'yaya:test-session' }

  // 1) 关联 + 应答匹配：请求定向发给登记的客户端；张冠李戴 / 来路不明 / 缺 id 的应答都被拒绝
  const before = frames.length
  const call = withOrigin(yaya, () =>
    mod.withBrowserClient(CLIENT_A, () =>
      mod.browserUiCall({ method: 'click', args: { ref: 'e1' } })
    )
  )
  const req = lastUiReq() as Req
  assert.ok(req)
  assert.equal(req.method, 'click')
  assert.equal(req.session, 'yaya:test-session')
  assert.equal(req.args.ref, 'e1')
  // agent 输入标记由页面执行时自己打，主机不预先打（避免排队期间用户操作被误算）
  assert.equal(
    frames.slice(before).some((f) => f.channel === 'cockpit:agent-input'),
    false,
    '主机不应发 agent 输入标记'
  )

  assert.equal(
    mod.submitBrowserUiReply({ clientId: CLIENT_B, id: req.id, ok: true, result: 1 }).ok,
    false,
    'clientId 不匹配必须拒绝'
  )
  assert.equal(mod.submitBrowserUiReply({ clientId: CLIENT_A, id: 'nope', ok: true }).ok, false)
  assert.equal(mod.submitBrowserUiReply({ clientId: CLIENT_A, ok: true }).ok, false)
  assert.equal(
    mod.submitBrowserUiReply({ clientId: CLIENT_A, id: req.id, ok: true, result: 42 }).ok,
    true
  )
  assert.deepEqual(await call, { ok: true, result: 42 })

  // 2) 超时：没有应答就失败（绝不假成功）
  await assert.rejects(
    withOrigin(yaya, () =>
      mod.withBrowserClient(CLIENT_A, () => mod.browserUiCall({ method: 'wait', timeoutMs: 1200 }))
    ),
    /browser_ui_timeout|没有在/
  )

  // 3) 断开：该客户端的 pending 立刻失败
  const dropped = withOrigin(yaya, () =>
    mod.withBrowserClient(CLIENT_A, () => mod.browserUiCall({ method: 'click', timeoutMs: 15000 }))
  )
  mod.unregisterBrowserClient(CLIENT_A)
  await assert.rejects(dropped, /browser_disconnected|断开/)

  // 4) 来源守卫：CLI / 远程 Agent / 没有浏览器上下文都不能用这座桥
  await assert.rejects(
    mod.withBrowserClient(CLIENT_A, () =>
      withOrigin({ kind: 'cli' }, () => mod.browserUiCall({ method: 'snapshot' }))
    ),
    /browser_ui_unsupported|只对 YAYA/
  )
  await assert.rejects(
    withOrigin({ kind: 'remote', session: 'mcp:1' }, () =>
      mod.withBrowserClient(CLIENT_A, () => mod.browserUiCall({ method: 'snapshot' }))
    ),
    /browser_ui_unsupported|只对 YAYA/
  )
  await assert.rejects(
    withOrigin(yaya, () => mod.browserUiCall({ method: 'snapshot' })),
    /browser_ui_no_target|没有可操作的浏览器/
  )

  // 5) 只读方法不打 agent 输入标记
  mod.registerBrowserClient(CLIENT_B, sender)
  const beforeRo = frames.length
  const ro = withOrigin(yaya, () =>
    mod.withBrowserClient(CLIENT_B, () => mod.browserUiCall({ method: 'snapshot' }))
  )
  const roReq = lastUiReq() as Req
  mod.submitBrowserUiReply({ clientId: CLIENT_B, id: roReq.id, ok: true, result: { text: '' } })
  assert.deepEqual(await ro, { ok: true, result: { text: '' } })
  assert.equal(
    frames.slice(beforeRo).some((f) => f.channel === 'cockpit:agent-input'),
    false,
    'snapshot 不应打 agent 输入标记'
  )
  mod.unregisterBrowserClient(CLIENT_B)

  // 6) 受保护动作：预检（不执行）→ guard → 主机按 hasClearance 推导许可 → 页面复核后重试
  privacy.definePrivacyScopes('test', { scope: { level: 'sensitive' } })
  privacy.setConsentPresenter((list) => {
    for (const r of list) privacy.decideConsent(r.id, 'once')
  })
  mod.registerBrowserClient(CLIENT_A, sender)
  const guarded = withOrigin(yaya, () =>
    mod.withBrowserClient(CLIENT_A, () =>
      mod.browserUiGuardedCall({ method: 'click', args: { ref: 'e2' }, action: '点击' })
    )
  )
  const preReq = lastUiReq() as Req
  const preIndex = frames.length - 1
  mod.submitBrowserUiReply({
    clientId: CLIENT_A,
    id: preReq.id,
    ok: false,
    code: 'clearance_required',
    scopes: ['test.scope'],
    token: 'tok-1',
    label: '某按钮'
  })
  const retryReq = await nextUiReq(preIndex + 1)
  assert.ok(retryReq, 'guard 通过后应重试')
  const permitted = retryReq.args.permitted
  assert.deepEqual(permitted, ['test.scope'], '许可应由主机按 hasClearance 推导，不信任页面')
  assert.equal(retryReq.args.token, 'tok-1')
  mod.submitBrowserUiReply({ clientId: CLIENT_A, id: retryReq.id, ok: true, result: { ok: true } })
  assert.deepEqual(await guarded, { ok: true })
  mod.unregisterBrowserClient(CLIENT_A)
})

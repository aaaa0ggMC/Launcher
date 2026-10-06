import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'

// 会读写 ~/.config/LinuxCockpit（日志、uploads）：先把 HOME 指到临时目录，再动态 import（AGENTS §11.7）
const home = mkdtempSync(join('/tmp', 'cockpit-server-test-'))
process.env.HOME = home
process.env.XDG_CONFIG_HOME = join(home, '.config')
if (!process.env.HOME.startsWith('/tmp/'))
  throw new Error('拒绝运行：HOME 必须是 /tmp 下的临时目录，避免改写真实用户配置')

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

test('网页宿主：鉴权 + SSE 广播载荷里的 cockpit-*:// 会改写成 /_p/ 路由', async () => {
  const { startServer, pushEvent } = await import('./server')
  const port = await freePort()
  const token = 'test-token-123'
  const server = await startServer({ host: '127.0.0.1', port, token, webRoot: home })
  const base = `http://127.0.0.1:${port}`

  // 未带 token → 401
  assert.equal((await fetch(`${base}/api/info`)).status, 401)
  const info = await fetch(`${base}/api/info`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(info.status, 200)

  // 订阅 SSE，再广播一条带 audioUrl 的载荷（和 aidj 的 cockpit:aidj-webplayer 同形状）
  const ctl = new AbortController()
  const res = await fetch(`${base}/api/events?token=${token}`, { signal: ctl.signal })
  assert.equal(res.status, 200)
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  // `: ok` 注释帧 + hello
  let head = ''
  while (!head.includes('event: hello')) head += dec.decode((await reader.read()).value)
  pushEvent('cockpit:aidj-webplayer', {
    queue: [
      { url: 'cockpit-audio://%2Fhome%2Fx%2Fa%20b.mp3', cover: 'data:image/png;base64,AAAA' }
    ],
    n: 1
  })
  let text = head.slice(head.indexOf('event: hello'))
  while (!/^data: \{"channel".*$/m.test(text)) text += dec.decode((await reader.read()).value)
  ctl.abort()
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
  const frame = JSON.parse(/^data: (\{"channel".*)$/m.exec(text)![1])
  assert.equal(frame.channel, 'cockpit:aidj-webplayer')
  assert.equal(frame.args[0].queue[0].url, '/_p/cockpit-audio/%2Fhome%2Fx%2Fa%20b.mp3')
  assert.equal(frame.args[0].queue[0].cover, 'data:image/png;base64,AAAA') // 非自定义协议的原样保留
  assert.equal(frame.args[0].n, 1)
})

test('SSE reconnect with the same clientId takes over; UI replies require auth and correlation', async () => {
  const { startServer } = await import('./server')
  const bridge = await import('../main/process/browser-ui')
  const port = await freePort()
  const token = 'offline-browser-test'
  const clientId = '00000000-0000-4000-8000-000000000001'
  const server = await startServer({ host: '127.0.0.1', port, token, webRoot: home })
  const base = `http://127.0.0.1:${port}`
  const ctl = new AbortController()
  try {
    const res = await fetch(`${base}/api/events?token=${token}&clientId=${clientId}`, {
      signal: ctl.signal
    })
    assert.equal(res.status, 200)
    assert.equal(bridge.hasBrowserClient(clientId), true)
    // EventSource 自动重连用同一个 clientId：必须 200 并顶替旧连接（409 会让浏览器永久放弃重连）
    const ctl2 = new AbortController()
    const res2 = await fetch(`${base}/api/events?token=${token}&clientId=${clientId}`, {
      signal: ctl2.signal
    })
    assert.equal(res2.status, 200)
    assert.equal(bridge.hasBrowserClient(clientId), true)
    // 旧连接随后关闭，不能把新连接注销掉
    ctl.abort()
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(bridge.hasBrowserClient(clientId), true)
    ctl2.abort()
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(bridge.hasBrowserClient(clientId), false)
    assert.equal((await fetch(`${base}/api/ui-result`, { method: 'POST', body: '{}' })).status, 401)
    assert.equal(
      (
        await fetch(`${base}/api/ui-result`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'not-pending', clientId, ok: true })
        })
      ).status,
      400
    )
  } finally {
    ctl.abort()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

/** 读 SSE 直到 pred 满足（或超时），返回累计文本 */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pred: (text: string) => boolean,
  ms = 3000
): Promise<string> {
  const dec = new TextDecoder()
  let text = ''
  const deadline = Date.now() + ms
  while (!pred(text)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting, got: ${text.slice(0, 400)}`)
    const r = await Promise.race([
      reader.read(),
      new Promise<null>((res) => setTimeout(() => res(null), 200))
    ])
    if (r && !r.done) text += dec.decode(r.value)
  }
  return text
}

test('事件流断线重连：带 lastEventId 补发错过的广播；补不上时 hello 报告 resumed=false', async () => {
  const { startServer, pushEvent } = await import('./server')
  const port = await freePort()
  const token = 'replay-token'
  const server = await startServer({ host: '127.0.0.1', port, token, webRoot: home })
  const base = `http://127.0.0.1:${port}`
  try {
    const ctl = new AbortController()
    const res = await fetch(`${base}/api/events?token=${token}`, { signal: ctl.signal })
    const reader = res.body!.getReader()
    await readUntil(reader, (t) => t.includes('event: hello'))
    pushEvent('t:a', 1)
    const got = await readUntil(reader, (t) => /\nid: \S+/.test(t))
    const lastId = /\nid: (\S+)/.exec(got)![1]
    ctl.abort() // 手机切后台，连接断了
    await new Promise((r) => setTimeout(r, 50))
    pushEvent('t:b', 2) // 断线期间的广播
    pushEvent('t:c', 3)

    const ctl2 = new AbortController()
    const res2 = await fetch(`${base}/api/events?token=${token}&lastEventId=${lastId}`, {
      signal: ctl2.signal
    })
    const text = await readUntil(res2.body!.getReader(), (t) => t.includes('"t:c"'))
    ctl2.abort()
    assert.match(text, /event: hello\ndata: \{"resumed":true\}/)
    assert.ok(text.indexOf('"t:b"') < text.indexOf('"t:c"'))
    assert.ok(!text.includes('"t:a"'), '已经收到过的帧不重复')

    // 别的进程纪元（宿主重启过）→ 补不上
    const ctl3 = new AbortController()
    const res3 = await fetch(`${base}/api/events?token=${token}&lastEventId=00000000-1`, {
      signal: ctl3.signal
    })
    const t3 = await readUntil(res3.body!.getReader(), (t) => t.includes('event: hello'))
    ctl3.abort()
    assert.match(t3, /"resumed":false/)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('命令结果找回：响应连接断掉后，用 reqId 从 /api/command-result 取回', async () => {
  const { startServer } = await import('./server')
  const { registerAll } = await import('../main/process/commands/registry')
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  registerAll([
    {
      name: 'test.slow-recover',
      description: 'test',
      usage: 'test.slow-recover',
      run: async () => {
        await gate
        return { answer: 42 }
      }
    }
  ])
  const port = await freePort()
  const token = 'recover-token'
  const server = await startServer({ host: '127.0.0.1', port, token, webRoot: home })
  const base = `http://127.0.0.1:${port}`
  const post = (path: string, body: unknown, signal?: AbortSignal): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal
    })
  try {
    const reqId = '0f0e0d0c-1111-4222-8333-444455556666'
    const ctl = new AbortController()
    const pending = post('/api/command', { name: 'test.slow-recover', args: {}, reqId }, ctl.signal)
    await new Promise((r) => setTimeout(r, 100))
    assert.deepEqual(await (await post('/api/command-result', { reqId })).json(), {
      state: 'pending'
    })
    ctl.abort() // 连接断了（手机切后台）
    await pending.catch(() => {})
    release() // 宿主照样把命令跑完
    await new Promise((r) => setTimeout(r, 50))
    const r = (await (await post('/api/command-result', { reqId })).json()) as {
      state: string
      response: { ok: boolean; result: { answer: number } }
    }
    assert.equal(r.state, 'done')
    assert.equal(r.response.ok, true)
    assert.equal(r.response.result.answer, 42)
    assert.deepEqual(
      await (
        await post('/api/command-result', { reqId: 'ffffffff-0000-4000-8000-000000000000' })
      ).json(),
      { state: 'unknown' }
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

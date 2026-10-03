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
  await reader.read() // `: ok` 注释帧
  pushEvent('cockpit:aidj-webplayer', {
    queue: [
      { url: 'cockpit-audio://%2Fhome%2Fx%2Fa%20b.mp3', cover: 'data:image/png;base64,AAAA' }
    ],
    n: 1
  })
  let text = ''
  while (!text.includes('\n\n')) text += dec.decode((await reader.read()).value)
  ctl.abort()
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
  const frame = JSON.parse(text.replace(/^data: /, ''))
  assert.equal(frame.channel, 'cockpit:aidj-webplayer')
  assert.equal(frame.args[0].queue[0].url, '/_p/cockpit-audio/%2Fhome%2Fx%2Fa%20b.mp3')
  assert.equal(frame.args[0].queue[0].cover, 'data:image/png;base64,AAAA') // 非自定义协议的原样保留
  assert.equal(frame.args[0].n, 1)
})

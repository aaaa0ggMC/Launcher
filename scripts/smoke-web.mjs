// 网页 / 无头宿主冒烟测试（docs/headless-web-plan.md A3）：
//   构建一个只带框架能力的无头版本到 out/.smoke（不覆盖正在使用的 out/headless、out/web）→
//   用临时 HOME 启动 → 检查静态页、鉴权、命令、SSE、/_p/ Range → 关掉。
// 运行：pnpm test:web   （约 10 秒）
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
// 放在仓库里（而不是 /tmp）：外置依赖要能从 node_modules 解析
const out = join(root, 'out/.smoke')
const home = mkdtempSync('/tmp/cockpit-smoke-')
if (!home.startsWith('/tmp/')) throw new Error('HOME 必须是 /tmp 下的临时目录')

const step = (msg) => console.log(`  · ${msg}`)

console.log('[smoke] build (--only cli,logs) →', out)
execFileSync(
  process.execPath,
  [join(root, 'scripts/build-headless.mjs'), '--only', 'cli,logs', '--out', out],
  { stdio: ['ignore', 'ignore', 'inherit'], cwd: root }
)

const port = await new Promise((res) => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port
    s.close(() => res(p))
  })
})

const child = spawn(
  process.execPath,
  [join(out, 'headless/index.js'), '--port', String(port), '--host', '127.0.0.1'],
  {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') },
    stdio: ['ignore', 'pipe', 'pipe']
  }
)
let logs = ''
child.stderr.on('data', (d) => (logs += d))

let failed = false
try {
  const token = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('宿主 20 秒内没有启动\n' + logs)), 20_000)
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
      logs += d
      const m = /\?token=([0-9a-f]+)/.exec(buf)
      if (m) {
        clearTimeout(timer)
        res(m[1])
      }
    })
    child.on('exit', (code) => rej(new Error(`宿主提前退出 code=${code}\n${logs}`)))
  })
  const base = `http://127.0.0.1:${port}`
  const auth = { authorization: `Bearer ${token}` }

  const page = await fetch(`${base}/`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<script/)
  step('静态页 200')

  assert.equal((await fetch(`${base}/api/info`)).status, 401)
  const info = await (await fetch(`${base}/api/info`, { headers: auth })).json()
  assert.equal(info.headless, true)
  step('鉴权：无 token 401，有 token 200')

  const cmds = await (await fetch(`${base}/api/commands`, { headers: auth })).json()
  assert.ok(Array.isArray(cmds) && cmds.some((c) => c.name === 'logs.query'), '命令表里没有 logs.query')
  const run = await (
    await fetch(`${base}/api/command`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'logs.query', args: {} })
    })
  ).json()
  assert.equal(run.ok, true, JSON.stringify(run).slice(0, 300))
  const unknown = await (
    await fetch(`${base}/api/command`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'no.such-command', args: {} })
    })
  ).json()
  assert.equal(unknown.ok, false)
  step(`命令：${cmds.length} 条，logs.query 可调，未知命令报错`)

  const ac = new AbortController()
  const sse = await fetch(`${base}/api/events?token=${token}`, { signal: ac.signal })
  assert.equal(sse.status, 200)
  const reader = sse.body.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  assert.match(first, /^: ok/)
  ac.abort()
  step('SSE 连接 200')

  const file = join(home, 'clip.mp4')
  writeFileSync(file, Buffer.alloc(4096, 7))
  const ranged = await fetch(`${base}/_p/cockpit-icon/${encodeURIComponent(file)}`, {
    headers: { ...auth, range: 'bytes=100-199' }
  })
  assert.equal(ranged.status, 206)
  assert.equal((await ranged.arrayBuffer()).byteLength, 100)
  step('/_p/ 协议转发 + Range 206')

  console.log('[smoke] OK')
} catch (e) {
  failed = true
  console.error('[smoke] FAILED:', e instanceof Error ? e.message : e)
} finally {
  child.kill('SIGTERM')
  rmSync(home, { recursive: true, force: true })
  rmSync(out, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)

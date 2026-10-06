import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, it } from 'node:test'

process.env.HOME = mkdtempSync('/tmp/yaya-android-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`

let mod: typeof import('./index')
let exec: typeof import('./exec')
const bin = mkdtempSync('/tmp/yaya-android-bin-')
const realPlatform = process.platform

function stub(name: string, body: string): void {
  const p = join(bin, name)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
}

before(async () => {
  assert.ok(process.env.HOME?.startsWith('/tmp/'), 'HOME must be isolated under /tmp/')
  mod = await import('./index')
  exec = await import('./exec')
})

function tool(name: string): (args: Record<string, unknown>) => Promise<unknown> {
  const t = mod.default.tools().find((x) => x.name === name)!
  return (args) =>
    t.run(args, { sessionId: 's', pluginId: 'android', signal: new AbortController().signal })
}
function status(group: string): string {
  return mod.default
    .groups!()
    .find((g) => g.id === group)!
    .status!().state
}

it('不在安卓上：分组不可用、没有 instructions', () => {
  assert.equal(status('termux-api'), 'idle')
  assert.equal(status('shizuku'), 'idle')
  assert.equal(mod.default.instructions!(), '')
  assert.equal(mod.default.defaultEnabled, false)
})

it('安卓上：按 PATH 里的命令判断分组状态；Termux:API 与 rish 调用', async () => {
  Object.defineProperty(process, 'platform', { value: 'android' })
  const oldPath = process.env.PATH
  try {
    process.env.PATH = `${bin}:/usr/bin:/bin`
    exec.resetCommandCache()
    assert.equal(status('termux-api'), 'error')
    stub('termux-battery-status', `echo '{"percentage": 87, "status": "CHARGING"}'`)
    stub('rish', `echo "$@"`)
    exec.resetCommandCache()
    assert.equal(status('termux-api'), 'ready')
    assert.equal(status('shizuku'), 'ready')
    assert.deepEqual(await tool('battery')({}), { percentage: 87, status: 'CHARGING' })
    // rish 收到的是 -c 加一整条命令
    const shell = (await tool('shell')({ command: 'getprop ro.product.model' })) as {
      stdout: string
    }
    assert.equal(shell.stdout.trim(), '-c getprop ro.product.model')
    await assert.rejects(tool('tap')({ x: -1, y: 5 }), /x must be/)
    await assert.rejects(tool('launch_app')({ package: 'x; rm -rf /' }), /invalid package/)
    await assert.rejects(tool('open_url')({ url: 'tel:110' }), /phone calls/)
    assert.match(mod.default.instructions!(), /Android phone/)
  } finally {
    process.env.PATH = oldPath
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

it('输入文字：空格写成 %s，单引号安全转义', () => {
  assert.equal(mod.inputTextCommand('hi there'), "input text 'hi%sthere'")
  assert.equal(mod.inputTextCommand("it's"), "input text 'it'\\''s'")
  assert.equal(mod.shQuote("a'b"), "'a'\\''b'")
})

it('桌面快捷方式：深链接参数校验与编码', () => {
  assert.equal(
    mod.pinShortcutUrl({ package: 'com.tencent.mm', label: '聊天 & 工作' }),
    'linuxcockpit://pin?package=com.tencent.mm&label=%E8%81%8A%E5%A4%A9+%26+%E5%B7%A5%E4%BD%9C'
  )
  assert.equal(mod.pinShortcutUrl({ ability: 'aidj' }), 'linuxcockpit://pin?ability=aidj')
  assert.throws(() => mod.pinShortcutUrl({}), /exactly one/)
  assert.throws(() => mod.pinShortcutUrl({ package: 'a.b', ability: 'aidj' }), /exactly one/)
  assert.throws(() => mod.pinShortcutUrl({ package: 'x; rm' }), /invalid package/)
  assert.throws(() => mod.pinShortcutUrl({ ability: 'aidj', icon_url: 'file:///x' }), /http/)
})

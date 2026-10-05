import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// 会读写 ~/.config/LinuxCockpit（日志）：先把 HOME 指到临时目录，再动态 import（AGENTS §11.7）
const home = mkdtempSync(join('/tmp', 'cockpit-hostfs-test-'))
process.env.HOME = home
process.env.XDG_CONFIG_HOME = join(home, '.config')
if (!process.env.HOME.startsWith('/tmp/'))
  throw new Error('拒绝运行：HOME 必须是 /tmp 下的临时目录，避免改写真实用户配置')

interface Listing {
  path: string
  parent: string | null
  entries: { name: string; type: 'dir' | 'file' }[]
  roots: { label: string; path: string }[]
  error?: string
}

let registered = false
/** 经命令注册表执行（与网页端 `window.cockpit.command` 同一条路） */
async function listPath(path?: string): Promise<Listing> {
  const { runCommand } = await import('../main/process/commands/registry')
  if (!registered) {
    const { registerHostCommands } = await import('./commands')
    registerHostCommands()
    registered = true
  }
  return (await runCommand('host.fs.list', path === undefined ? {} : { path })) as Listing
}

test('host.fs.list：手输路径归一化——重复斜杠、尾斜杠、~ 展开（手机上手打路径的场景）', async () => {
  const scratch = join(home, 'scratch')
  mkdirSync(join(scratch, 'sub'), { recursive: true })

  // //storage/emulated/0/xxx 这种双斜杠写法：Termux 里手打很常见
  const doubleSlash = (await listPath(join(scratch, 'sub').replace(home, `//${home}`))).path
  assert.equal(doubleSlash, join(scratch, 'sub'))

  // 尾斜杠 / 中间多余斜杠
  assert.equal((await listPath(`${scratch}//sub///`)).path, join(scratch, 'sub'))

  // ~ / ~/… 展开到宿主的家目录
  assert.equal((await listPath('~')).path, homedir())
  assert.equal((await listPath('~/scratch')).path, scratch)

  // 相对路径按宿主进程的工作目录解析
  assert.equal((await listPath('scratch/sub')).path, join(process.cwd(), 'scratch/sub'))
})

test('host.fs.list：缺省 / 空串 / 纯空格都是家目录，且列出内容与快捷入口', async () => {
  mkdirSync(join(home, 'music'), { recursive: true })

  for (const arg of [undefined, '', '   ']) {
    const l = await listPath(arg)
    assert.equal(l.path, homedir())
    assert.equal(l.error, undefined)
    assert.ok(l.entries.some((e) => e.name === 'music' && e.type === 'dir'))
    assert.ok(l.roots.some((r) => r.label === 'home' && r.path === homedir()))
  }

  // 读不了的目录给 error 码，而不是把调用炸掉（网页端据此提示）
  const missing = await listPath(join(home, 'nope'))
  assert.equal(missing.error, 'ENOENT')
  assert.deepEqual(missing.entries, [])
})

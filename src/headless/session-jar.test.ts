import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartition, importCookieHeader, resetSessions } from './session-jar'

// 目录在每次读写时才取环境变量：静态 import 之后再设也来得及，不会碰真实配置
process.env.COCKPIT_SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'cockpit-sess-'))

test('导入 Cookie 头：落到上一级域、按 URL 取得到、子域也取得到', async () => {
  const ses = fromPartition('persist:balance-test')
  const n = await importCookieHeader(
    ses.cookies,
    'https://platform.xiaomimimo.com/console',
    'serviceToken=abc; userId=42; bad'
  )
  assert.equal(n, 2)
  const got = await ses.cookies.get({ url: 'https://api.xiaomimimo.com/x' })
  assert.deepEqual(got.map((c) => c.name).sort(), ['serviceToken', 'userId'])
  assert.equal(got[0].domain, '.xiaomimimo.com')
  assert.equal((await ses.cookies.get({ url: 'https://example.com/' })).length, 0)
})

test('持久化到 600 文件，重开会话还在；过期的自动丢', async () => {
  resetSessions()
  const ses = fromPartition('persist:balance-test')
  assert.equal((await ses.cookies.get({})).length, 2)
  const file = join(
    process.env.COCKPIT_SESSIONS_DIR!,
    'headless-sessions',
    'persist_balance-test.json'
  )
  assert.equal(statSync(file).mode & 0o777, 0o600)
  await ses.cookies.set({ url: 'https://a.com/', name: 'old', value: '1', expirationDate: 1 })
  assert.equal((await ses.cookies.get({ name: 'old' })).length, 0)
  assert.ok(!readFileSync(file, 'utf8').includes('"old"'))
})

test('set 同名覆盖、remove、clearStorageData', async () => {
  const ses = fromPartition('persist:other')
  await ses.cookies.set({ url: 'https://b.com/', name: 'k', value: '1' })
  await ses.cookies.set({ url: 'https://b.com/', name: 'k', value: '2' })
  const got = await ses.cookies.get({ domain: 'b.com' })
  assert.equal(got.length, 1)
  assert.equal(got[0].value, '2')
  await ses.cookies.remove('https://b.com/', 'k')
  assert.equal((await ses.cookies.get({})).length, 0)
  await ses.cookies.set({ url: 'https://b.com/', name: 'k', value: '3' })
  await ses.clearStorageData()
  assert.equal((await ses.cookies.get({})).length, 0)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'

// 会读写 ~/.config/LinuxCockpit：先把 HOME 指到临时目录，再动态 import 项目模块（AGENTS.md §11.7）
const home = mkdtempSync(join('/tmp', 'cockpit-encrypt-test-'))
process.env.HOME = home
process.env.XDG_CONFIG_HOME = join(home, '.config')
if (!process.env.HOME.startsWith('/tmp/'))
  throw new Error('拒绝运行：HOME 必须是 /tmp 下的临时目录，避免改写真实用户配置')

test('scrypt 包裹的主密钥可原样解回（safeStorage → scrypt 迁移的落盘路径）', async () => {
  const { __testing, rewrapMasterToScrypt, encryptSecret, decryptSecret, vaultStatus } =
    await import('./encrypt')
  // 无 safeStorage 环境：首次 ensureVault 会建 scrypt 主密钥；rewrap 对 scrypt 是 no-op
  const enc = encryptSecret('sk-test')
  assert.equal(decryptSecret(enc), 'sk-test')
  assert.equal(rewrapMasterToScrypt().changed, false)
  assert.equal(vaultStatus().method, 'scrypt')

  // 迁移的核心：任意 32 字节主密钥 → writeScryptMaster → loadMasterKey 原样读回
  const key = Buffer.alloc(32, 7)
  __testing.writeScryptMaster(key)
  assert.ok(__testing.loadMasterKey().equals(key))
})

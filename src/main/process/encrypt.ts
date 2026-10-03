/**
 * 框架级本地密钥保险箱（主进程 only）。
 *
 * 设计目标：
 *  - 能力把敏感字段（密码 / API Key）写成磁盘前 `encryptSecret`，读出后 `decryptSecret`
 *  - 首次启动自动生成 32 字节主密钥；之后整机复用，不随配置文件明文出现
 *  - 跨平台优先 Electron `safeStorage`（Win DPAPI / macOS Keychain / Linux libsecret|kwallet）
 *    包住主密钥；不可用时退回 scrypt(机器指纹, salt) 包住主密钥
 *  - 业务密文统一 AES-256-GCM，带随机 IV + 认证 tag；格式 `enc:v2:...`
 *
 * 注意：这是「本机防随手翻看 / 防配置文件被拷走直接读」的保护，
 * 不是防本机 root / 已登录用户的绝对安全（那需要用户口令或硬件密钥）。
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
  renameSync
} from 'node:fs'
import { homedir, hostname, userInfo, cpus, platform, arch } from 'node:os'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { USER_CONFIG_DIR } from './paths'
import { makeLogger } from './logger'
import { noteSecretValue } from './privacy'

const log = makeLogger('encrypt')

/** 业务密文前缀（AES-GCM，主密钥）。 */
export const SECRET_PREFIX_V2 = 'enc:v2:'
/** 旧 balance 能力遗留前缀（机器派生密钥，无主密钥文件）。 */
export const SECRET_PREFIX_V1 = 'enc:v1:'

const MASTER_DIR = join(USER_CONFIG_DIR, 'secrets')
const MASTER_FILE = join(MASTER_DIR, 'master.json')

const MASTER_KEY_BYTES = 32
const GCM_IV_BYTES = 12
const SCRYPT_SALT_BYTES = 16
/** scrypt 参数：交互式可接受延迟，足够拖慢暴力。 */
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1

type WrapMethod = 'safeStorage' | 'scrypt'

interface MasterFileV2 {
  v: 2
  method: WrapMethod
  /** scrypt 用盐；safeStorage 时也可有（备用迁移） */
  salt?: string
  /** base64：被包住的主密钥密文 */
  wrapped: string
}

let masterKey: Buffer | null = null
let vaultReady = false

/* -------------------------------- 机器指纹 -------------------------------- */

/** 跑一条短命令拿 stdout；失败 / 超时返回空串（不抛）。 */
function runCapture(argv: string[], timeoutMs = 3000): string {
  try {
    return execFileSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return ''
  }
}

/** Windows：注册表 HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid。 */
function readWindowsMachineGuid(): string {
  const out = runCapture([
    'reg',
    'query',
    'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
    '/v',
    'MachineGuid'
  ])
  const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{8,})/i.exec(out)
  if (m) return m[1].trim()
  // 有些精简环境 reg 不在 PATH；退回 PowerShell 读同一键值。
  const ps = runCapture([
    'powershell',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '(Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Cryptography").MachineGuid'
  ])
  return ps.trim()
}

/** macOS：IOPlatformUUID（ioreg，重启后保持不变，比序列号更稳定）。 */
function readMacPlatformUuid(): string {
  const out = runCapture(['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice', '-k', 'IOPlatformUUID'])
  const m = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{8,})"/.exec(out)
  return m ? m[1] : ''
}

/**
 * 稳定的本机身份串（按平台取最权威的 ID，都没有才退化为 host+user+home+cpu 哈希）。
 * 只用于「无 safeStorage 时」包主密钥，不直接当业务密钥。
 */
export function getMachineFingerprint(): string {
  // 1) Linux / *BSD：systemd / dbus 机器 ID
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      if (!existsSync(p)) continue
      const id = readFileSync(p, 'utf8').trim()
      if (id) return id
    } catch {
      /* try next */
    }
  }

  // 2) Windows：注册表 MachineGuid
  if (platform() === 'win32') {
    const guid = readWindowsMachineGuid()
    if (guid) return guid.toLowerCase()
  }

  // 3) macOS：IOPlatformUUID
  if (platform() === 'darwin') {
    const uuid = readMacPlatformUuid()
    if (uuid) return uuid.toLowerCase()
  }

  // 4) 兜底：host + user + home + cpu 指纹
  const raw = [
    platform(),
    arch(),
    hostname(),
    userInfo().username,
    homedir(),
    String(cpus().length)
  ].join(':')
  return createHash('sha256').update(raw).digest('hex')
}

/* -------------------------------- 主密钥生命周期 -------------------------------- */

function ensureSecretsDir(): void {
  mkdirSync(MASTER_DIR, { recursive: true })
  try {
    chmodSync(MASTER_DIR, 0o700)
  } catch {
    /* Windows 等可能不支持 */
  }
}

function writeMasterFile(data: MasterFileV2): void {
  ensureSecretsDir()
  writeFileSync(MASTER_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(MASTER_FILE, 0o600)
  } catch {
    /* ignore */
  }
}

function wrapWithAes(key: Buffer, plain: Buffer): string {
  const iv = randomBytes(GCM_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct]).toString('base64')
}

function unwrapWithAes(key: Buffer, wrappedB64: string): Buffer {
  const buf = Buffer.from(wrappedB64, 'base64')
  if (buf.length < GCM_IV_BYTES + 16) throw new Error('wrapped master key too short')
  const iv = buf.subarray(0, GCM_IV_BYTES)
  const tag = buf.subarray(GCM_IV_BYTES, GCM_IV_BYTES + 16)
  const ct = buf.subarray(GCM_IV_BYTES + 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

function deriveScryptWrapKey(salt: Buffer): Buffer {
  const fingerprint = getMachineFingerprint()
  return scryptSync(fingerprint, salt, MASTER_KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P
  })
}

function safeStorageAvailable(): boolean {
  try {
    // safeStorage 在 app ready 前可能抛错 / 返回 false
    if (!app?.isReady?.()) return false
    return (
      typeof safeStorage?.isEncryptionAvailable === 'function' &&
      safeStorage.isEncryptionAvailable()
    )
  } catch {
    return false
  }
}

/** 生成并落盘主密钥（首次启动）。 */
function createMasterKey(): Buffer {
  const key = randomBytes(MASTER_KEY_BYTES)
  if (safeStorageAvailable()) {
    const wrapped = safeStorage.encryptString(key.toString('base64')).toString('base64')
    writeMasterFile({ v: 2, method: 'safeStorage', wrapped })
    log.info('vault master key created (safeStorage)')
  } else {
    const salt = randomBytes(SCRYPT_SALT_BYTES)
    const wrapKey = deriveScryptWrapKey(salt)
    const wrapped = wrapWithAes(wrapKey, key)
    writeMasterFile({
      v: 2,
      method: 'scrypt',
      salt: salt.toString('hex'),
      wrapped
    })
    log.info('vault master key created (scrypt/machine-fingerprint fallback)')
  }
  return key
}

/** 从磁盘解包主密钥。 */
function loadMasterKey(): Buffer {
  if (!existsSync(MASTER_FILE)) return createMasterKey()
  const raw = JSON.parse(readFileSync(MASTER_FILE, 'utf8')) as MasterFileV2
  if (!raw || raw.v !== 2 || !raw.wrapped) {
    throw new Error('invalid master key file')
  }
  if (raw.method === 'safeStorage') {
    if (!safeStorageAvailable()) {
      throw new Error('master key was wrapped with safeStorage, but encryption is unavailable now')
    }
    const bin = Buffer.from(raw.wrapped, 'base64')
    const b64 = safeStorage.decryptString(bin)
    return Buffer.from(b64, 'base64')
  }
  if (raw.method === 'scrypt') {
    if (!raw.salt) throw new Error('scrypt master key missing salt')
    const salt = Buffer.from(raw.salt, 'hex')
    const wrapKey = deriveScryptWrapKey(salt)
    return unwrapWithAes(wrapKey, raw.wrapped)
  }
  throw new Error(`unknown master wrap method: ${String((raw as { method?: string }).method)}`)
}

/** 用 scrypt（机器指纹）包住主密钥并**原子**落盘（先写临时文件再 rename）。 */
function writeScryptMaster(key: Buffer): void {
  const salt = randomBytes(SCRYPT_SALT_BYTES)
  const data: MasterFileV2 = {
    v: 2,
    method: 'scrypt',
    salt: salt.toString('hex'),
    wrapped: wrapWithAes(deriveScryptWrapKey(salt), key)
  }
  ensureSecretsDir()
  const tmp = `${MASTER_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, MASTER_FILE)
}

/**
 * 把主密钥从 `safeStorage`（系统钥匙环，只有 Electron 读得到）改包成 `scrypt`（机器指纹派生），
 * 这样无头宿主（纯 Node，没有钥匙环）也能解开同一份密文。**保护强度降低**：同一台机器上的同用户进程
 * 都能解开，换来 Electron / 网页模式共享同一份加密配置；调用方需要用户明确同意。
 *
 * 主密钥本身不变，已有的 enc:v2 密文无需重写。改写前备份为 `master.json.bak-<时间戳>`，
 * 改写后重新解包校验，不一致则回滚。
 */
export function rewrapMasterToScrypt(): { changed: boolean; backup?: string } {
  ensureVault()
  if (!masterKey)
    throw new Error('encrypt vault unavailable（先在能解开主密钥的环境里运行，如 Electron）')
  const cur = JSON.parse(readFileSync(MASTER_FILE, 'utf8')) as MasterFileV2
  if (cur.method === 'scrypt') return { changed: false }
  const backup = `${MASTER_FILE}.bak-${Date.now()}`
  copyFileSync(MASTER_FILE, backup)
  try {
    writeScryptMaster(masterKey)
    const check = loadMasterKey()
    if (check.length !== masterKey.length || !timingSafeEqual(check, masterKey)) {
      throw new Error('rewrapped key mismatch')
    }
  } catch (e) {
    copyFileSync(backup, MASTER_FILE)
    throw e
  }
  log.warn('vault master key rewrapped: safeStorage → scrypt', { backup })
  return { changed: true, backup }
}

/** 仅测试用：把给定主密钥以 scrypt 方式落盘 / 读回。 */
export const __testing = { writeScryptMaster, loadMasterKey }

/**
 * 启动时调用一次（`app.whenReady` 之后）：确保主密钥存在并载入内存。
 * 幂等；失败时打日志但不抛 —— 后续 encrypt 会再试 / 明文友好降级由调用方决定。
 */
export function ensureVault(): void {
  if (vaultReady && masterKey) return
  try {
    masterKey = loadMasterKey()
    if (masterKey.length !== MASTER_KEY_BYTES) {
      throw new Error(`bad master key length ${masterKey.length}`)
    }
    vaultReady = true
    log.info('vault ready', {
      method: existsSync(MASTER_FILE)
        ? (JSON.parse(readFileSync(MASTER_FILE, 'utf8')) as MasterFileV2).method
        : 'new',
      safeStorage: safeStorageAvailable()
    })
  } catch (e) {
    masterKey = null
    vaultReady = false
    log.error('vault init failed', { error: e instanceof Error ? e.message : String(e) })
  }
}

function getMasterKey(): Buffer {
  if (!masterKey) ensureVault()
  if (!masterKey) throw new Error('encrypt vault unavailable')
  return masterKey
}

/* -------------------------------- 业务加解密 -------------------------------- */

export function isEncryptedSecret(value: string): boolean {
  return (
    typeof value === 'string' &&
    (value.startsWith(SECRET_PREFIX_V2) || value.startsWith(SECRET_PREFIX_V1))
  )
}

/** AES-256-GCM 加密；空串原样返回；已是 enc:v* 的不二次加密。 */
export function encryptSecret(plainText: string): string {
  if (!plainText) return ''
  if (isEncryptedSecret(plainText)) return plainText
  const key = getMasterKey()
  const iv = randomBytes(GCM_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return (
    SECRET_PREFIX_V2 +
    [iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.')
  )
}

/** 解密；非密文原样返回；失败返回空串（避免把密文当密码用出去）。 */
export function decryptSecret(cipherText: string): string {
  if (!cipherText) return ''
  let plain = cipherText
  if (cipherText.startsWith(SECRET_PREFIX_V2)) plain = decryptV2(cipherText)
  else if (cipherText.startsWith(SECRET_PREFIX_V1)) plain = decryptV1Legacy(cipherText)
  // 登记明文指纹：agent 读日志 / 任务输出时，出现这个值就替换成占位符（privacy.scrubForAgent）。
  noteSecretValue(plain)
  return plain
}

function decryptV2(cipherText: string): string {
  try {
    const body = cipherText.slice(SECRET_PREFIX_V2.length)
    const [ivB64, tagB64, dataB64] = body.split('.')
    if (!ivB64 || !tagB64 || !dataB64) return ''
    const key = getMasterKey()
    const iv = Buffer.from(ivB64, 'base64url')
    const tag = Buffer.from(tagB64, 'base64url')
    const data = Buffer.from(dataB64, 'base64url')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch (e) {
    log.warn('decrypt v2 failed', { error: e instanceof Error ? e.message : String(e) })
    return ''
  }
}

/**
 * 兼容 balance 旧格式 `enc:v1:iv:tag:data`（hex + 机器派生密钥）。
 * 读到后能力侧再 save 会自动升到 v2。
 */
function decryptV1Legacy(cipherText: string): string {
  try {
    const raw = cipherText.slice(SECRET_PREFIX_V1.length)
    const [ivHex, tagHex, dataHex] = raw.split(':')
    if (!ivHex || !tagHex || !dataHex) return ''
    const machineId = getMachineFingerprint()
    // 旧 balance 用 getMachineId（/etc/machine-id 优先，与 fingerprint 在 Linux 上通常一致）
    // 派生串固定为 cockpit:balance:vault: 以兼容已落盘数据
    const key = createHash('sha256').update(`cockpit:balance:vault:${machineId}`).digest()
    const iv = Buffer.from(ivHex, 'hex')
    const tag = Buffer.from(tagHex, 'hex')
    const data = Buffer.from(dataHex, 'hex')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    // 再试一次 balance 旧 fallback 指纹（hostname:user:home:cpus）
    try {
      const fallbackRaw = `${hostname()}:${userInfo().username}:${homedir()}:${cpus().length}`
      const machineId = createHash('sha256').update(fallbackRaw).digest('hex')
      const key = createHash('sha256').update(`cockpit:balance:vault:${machineId}`).digest()
      const raw = cipherText.slice(SECRET_PREFIX_V1.length)
      const [ivHex, tagHex, dataHex] = raw.split(':')
      if (!ivHex || !tagHex || !dataHex) return ''
      const iv = Buffer.from(ivHex, 'hex')
      const tag = Buffer.from(tagHex, 'hex')
      const data = Buffer.from(dataHex, 'hex')
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
    } catch {
      return ''
    }
  }
}

/** 常量时间比较两个密文是否指向同一明文（都解密后再比；失败当不等）。 */
export function secretsEqual(a: string, b: string): boolean {
  const da = Buffer.from(decryptSecret(a), 'utf8')
  const db = Buffer.from(decryptSecret(b), 'utf8')
  if (da.length !== db.length) return false
  try {
    return timingSafeEqual(da, db)
  } catch {
    return false
  }
}

/** 诊断信息（设置页 / 日志，不含密钥材料）。 */
export function vaultStatus(): {
  ready: boolean
  method: WrapMethod | null
  safeStorage: boolean
  path: string
} {
  let method: WrapMethod | null = null
  try {
    if (existsSync(MASTER_FILE)) {
      method = (JSON.parse(readFileSync(MASTER_FILE, 'utf8')) as MasterFileV2).method
    }
  } catch {
    method = null
  }
  return {
    ready: vaultReady && !!masterKey,
    method,
    safeStorage: safeStorageAvailable(),
    path: MASTER_FILE
  }
}

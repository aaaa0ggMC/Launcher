import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { homedir, hostname, userInfo, cpus } from 'os'

const MAGIC_PREFIX = 'enc:v1:'

/**
 * Reads the machine ID or computes a stable hardware/user identity signature.
 */
export function getMachineId(): string {
  try {
    if (existsSync('/etc/machine-id')) {
      const id = readFileSync('/etc/machine-id', 'utf8').trim()
      if (id) return id
    }
  } catch {
    // Ignore and fallback
  }

  try {
    if (existsSync('/var/lib/dbus/machine-id')) {
      const id = readFileSync('/var/lib/dbus/machine-id', 'utf8').trim()
      if (id) return id
    }
  } catch {
    // Ignore and fallback
  }

  // Cross-platform fallback based on host, user and hardware signature
  const fallbackRaw = `${hostname()}:${userInfo().username}:${homedir()}:${cpus().length}`
  return createHash('sha256').update(fallbackRaw).digest('hex')
}

/**
 * Derives a 256-bit AES key from the machine identity.
 */
function getDerivedKey(): Buffer {
  const machineId = getMachineId()
  return createHash('sha256').update(`cockpit:balance:vault:${machineId}`).digest()
}

/**
 * Encrypts a plaintext string using AES-256-GCM tied to the current machine.
 */
export function encryptSecret(plainText: string): string {
  if (!plainText) return ''
  // If already encrypted, do not re-encrypt
  if (plainText.startsWith(MAGIC_PREFIX)) return plainText

  const key = getDerivedKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)

  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return `${MAGIC_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

/**
 * Decrypts a machine-encrypted string. If not encrypted or decryption fails, handles gracefully.
 */
export function decryptSecret(cipherText: string): string {
  if (!cipherText) return ''
  if (!cipherText.startsWith(MAGIC_PREFIX)) {
    // Plaintext string
    return cipherText
  }

  try {
    const raw = cipherText.slice(MAGIC_PREFIX.length)
    const [ivHex, tagHex, dataHex] = raw.split(':')
    if (!ivHex || !tagHex || !dataHex) return cipherText

    const key = getDerivedKey()
    const iv = Buffer.from(ivHex, 'hex')
    const tag = Buffer.from(tagHex, 'hex')
    const data = Buffer.from(dataHex, 'hex')

    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)

    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
    return decrypted
  } catch {
    // Decryption failed (e.g. file copied to different machine)
    return ''
  }
}

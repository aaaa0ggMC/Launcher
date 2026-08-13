/**
 * Netease weapi encryption — adapted from NeteaseCloudMusicApi
 * (https://github.com/Binaryify/NeteaseCloudMusicApi), MIT licensed.
 *
 * The MIT License (MIT) — Copyright (c) 2013-2022 Binaryify
 * (see ./LICENSE)
 *
 * Rewritten onto Node's built-in `crypto` module (no crypto-js / node-forge):
 *  - CryptoJS AES-128-CBC(Pkcs7) ↔ createCipheriv('aes-128-cbc', …)
 *  - forge RSA "NONE" padding       ↔ publicEncrypt(…, RSA_NO_PADDING)
 * Only the pieces needed by search + lyric are kept.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  publicEncrypt,
  randomBytes,
  constants
} from 'crypto'

const iv = '0102030405060708'
const presetKey = '0CoJUm6Qyw8W8jud'
const eapiKey = 'e82ckenh8dichen8'
const base62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const publicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`

function aesEncrypt(text: string, key: string): string {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'))
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64')
}

/** Raw RSA (NONE padding) → hex. forge's NONE treats the short message as a
 *  BigInteger (implicitly left-padded to the modulus size); Node's
 *  RSA_NO_PADDING demands exactly 128 bytes (1024-bit key), so pad explicitly
 *  — same integer, same ciphertext. */
function rsaEncrypt(str: string): string {
  const buf = Buffer.from(str, 'utf8')
  const padded = Buffer.alloc(128)
  buf.copy(padded, 128 - buf.length)
  const encrypted = publicEncrypt({ key: publicKey, padding: constants.RSA_NO_PADDING }, padded)
  return encrypted.toString('hex')
}

/** Build the weapi payload for a Netease request body object. */
export function weapi(object: Record<string, unknown>): { params: string; encSecKey: string } {
  const text = JSON.stringify(object)
  let secretKey = ''
  for (let i = 0; i < 16; i++) secretKey += base62.charAt(Math.round(Math.random() * 61))
  return {
    params: aesEncrypt(aesEncrypt(text, presetKey), secretKey),
    encSecKey: rsaEncrypt(secretKey.split('').reverse().join(''))
  }
}

/** AES-128-ECB encrypt → uppercase hex (eapi params). */
function eapiAes(text: string): string {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(eapiKey, 'utf8'), null)
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    .toString('hex')
    .toUpperCase()
}

/** AES-128-ECB decrypt of the eapi response body. */
function eapiDecryptBytes(cipher: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(eapiKey, 'utf8'), null)
  return Buffer.concat([decipher.update(cipher), decipher.final()])
}

/**
 * Build the eapi payload for `route` (the API route path, e.g.
 * `/api/song/lyric/v1`) and a body object — the newer word-level endpoints.
 */
export function eapi(route: string, object: Record<string, unknown>): { params: string } {
  const text = JSON.stringify(object)
  const digest = createHash('md5').update(`nobody${route}use${text}md5forencrypt`).digest('hex')
  const data = `${route}-36cd479b6b5-${text}-36cd479b6b5-${digest}`
  return { params: eapiAes(data) }
}

/** Decrypt an eapi response arraybuffer into its plaintext JSON string.
 *  The body is the AES ciphertext delivered as a hex string in UTF-8 bytes. */
export function eapiDecrypt(body: Buffer): string {
  const hexStr = body.toString('utf8').trim()
  const cipher = Buffer.from(hexStr, 'hex')
  return eapiDecryptBytes(cipher).toString('utf8')
}

/** Random NMTID cookie value (request identity). */
export function randomNmtId(): string {
  return randomBytes(16).toString('hex')
}

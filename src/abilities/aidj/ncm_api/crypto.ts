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
import { createCipheriv, publicEncrypt, randomBytes, constants } from 'crypto'

const iv = '0102030405060708'
const presetKey = '0CoJUm6Qyw8W8jud'
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

/** Random NMTID cookie value (request identity). */
export function randomNmtId(): string {
  return randomBytes(16).toString('hex')
}

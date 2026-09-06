import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { weapi, eapi, eapiDecrypt, randomNmtId } from './crypto'

describe('Netease crypto', () => {
  it('randomNmtId returns a 32-character hex string', () => {
    const id1 = randomNmtId()
    const id2 = randomNmtId()
    assert.match(id1, /^[0-9a-f]{32}$/)
    assert.match(id2, /^[0-9a-f]{32}$/)
    assert.notEqual(id1, id2)
  })

  it('weapi encrypts object into base64 params and 256-hex encSecKey', () => {
    const payload = { id: 123456, type: 1 }
    const res = weapi(payload)
    assert.ok(res.params && typeof res.params === 'string')
    assert.ok(res.encSecKey && typeof res.encSecKey === 'string')
    // 128 bytes RSA ciphertext in hex is 256 characters
    assert.equal(res.encSecKey.length, 256)
    assert.match(res.encSecKey, /^[0-9a-f]{256}$/)
    // params is base64 string
    assert.match(res.params, /^[A-Za-z0-9+/=]+$/)
  })

  it('eapi encrypts and eapiDecrypt decrypts back to original data', () => {
    const route = '/api/song/lyric/v1'
    const obj = { id: '9999', cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0 }
    const { params } = eapi(route, obj)
    assert.ok(params && typeof params === 'string')
    assert.match(params, /^[0-9A-F]+$/)

    // Decrypt the hex string wrapped as a buffer
    const decrypted = eapiDecrypt(Buffer.from(params, 'utf8'))
    assert.ok(decrypted.startsWith(route))
    assert.ok(decrypted.includes(JSON.stringify(obj)))
  })
})

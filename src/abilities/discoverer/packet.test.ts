import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ANNOUNCE_HEADER_BYTES,
  ANNOUNCE_TAIL_BYTES,
  VERIFY_REPLY,
  VERIFY_REQUEST,
  VERIFY_WINDOW_MS,
  bytesToIpv4,
  bytesToIpv6,
  decodeAnnounce,
  decodeVerify,
  encodeAnnounce,
  encodeVerify,
  ipv4ToBytes,
  ipv6ToBytes,
  randomVerifyPadding,
  verifyFresh
} from './packet'

describe('discoverer packet', () => {
  const sample = {
    name: '书房台式机',
    ipv4: '192.168.1.5',
    ipv6: '2408:8207:78a:1c57::42',
    platform: 1 as const,
    flavor: 1 as const
  }

  test('announce roundtrip', () => {
    const buf = encodeAnnounce(sample)
    assert.ok(buf)
    if (!buf) return
    const decoded = decodeAnnounce(buf)
    assert.ok(decoded)
    assert.equal(decoded?.name, sample.name)
    assert.equal(decoded?.ipv4, sample.ipv4)
    assert.equal(decoded?.ipv6, sample.ipv6)
    assert.equal(decoded?.platform, 1)
    assert.equal(decoded?.flavor, 1)
  })

  test('announce length is fixed overhead + name bytes', () => {
    const buf = encodeAnnounce(sample)
    assert.ok(buf)
    const nameBytes = Buffer.from(sample.name, 'utf8').length
    assert.equal(buf?.length, ANNOUNCE_HEADER_BYTES + nameBytes + ANNOUNCE_TAIL_BYTES)
    assert.equal(nameBytes + ANNOUNCE_HEADER_BYTES + ANNOUNCE_TAIL_BYTES, 20 + nameBytes + 22)
  })

  test('announce hides content: fresh key per packet, no plaintext leakage', () => {
    const a = encodeAnnounce(sample)
    const b = encodeAnnounce(sample)
    assert.ok(a && b)
    if (!a || !b) return
    // 同一内容两次编码，密文（含密钥）必须不同
    assert.notDeepEqual(a, b)
    // 明文字节不出现在报文里
    const nameBytes = Buffer.from(sample.name, 'utf8')
    assert.ok(!a.includes(nameBytes))
    const v4 = ipv4ToBytes(sample.ipv4)
    assert.ok(!a.subarray(ANNOUNCE_HEADER_BYTES).includes(v4))
  })

  test('announce rejects bad input', () => {
    assert.equal(encodeAnnounce({ ...sample, name: '' }), null)
    assert.equal(encodeAnnounce({ ...sample, name: 'x'.repeat(65) }), null)
    assert.equal(encodeAnnounce({ ...sample, ipv6: 'not-an-ip' }), null)
    // 太短 / 长度字段越界 / 截断的密文
    assert.equal(decodeAnnounce(Buffer.alloc(10)), null)
    const buf = encodeAnnounce(sample)
    assert.ok(buf)
    if (!buf) return
    const truncated = buf.subarray(0, buf.length - 5)
    assert.equal(decodeAnnounce(truncated), null)
    const badLen = Buffer.from(buf)
    badLen.writeUInt32BE(9999, 16)
    assert.equal(decodeAnnounce(badLen), null)
  })

  test('empty addresses are preserved as "none"', () => {
    const buf = encodeAnnounce({ ...sample, ipv4: '', ipv6: '' })
    assert.ok(buf)
    if (!buf) return
    const decoded = decodeAnnounce(buf)
    assert.equal(decoded?.ipv4, '')
    assert.equal(decoded?.ipv6, '')
  })

  test('platform / flavor are clamped to the known enum range', () => {
    // 编码端归一化：越界值夹到已知范围
    const buf = encodeAnnounce({ ...sample, platform: 9 as never, flavor: 9 as never })
    assert.ok(buf)
    if (!buf) return
    const decoded = decodeAnnounce(buf)
    assert.equal(decoded?.platform, 4)
    assert.equal(decoded?.flavor, 8)
    // 合法值原样通过
    const okBuf = encodeAnnounce({ ...sample, platform: 2, flavor: 7 })
    assert.ok(okBuf)
    if (!okBuf) return
    const ok = decodeAnnounce(okBuf)
    assert.equal(ok?.platform, 2)
    assert.equal(ok?.flavor, 7)
  })
})

describe('discoverer ip helpers', () => {
  test('ipv4 bytes roundtrip', () => {
    assert.equal(bytesToIpv4(ipv4ToBytes('10.0.0.1')), '10.0.0.1')
    assert.equal(bytesToIpv4(ipv4ToBytes('255.255.255.0')), '255.255.255.0')
    assert.equal(bytesToIpv4(ipv4ToBytes('bogus')), '0.0.0.0')
  })

  test('ipv6 bytes roundtrip with compression', () => {
    // 输出统一为压缩表示法（:: 合并最长全零段）
    const cases: [string, string][] = [
      ['2408:8207:78a:1c57::42', '2408:8207:78a:1c57::42'],
      ['::1', '::1'],
      ['fe80::1', 'fe80::1'],
      ['2001:db8:0:0:0:0:2:1', '2001:db8::2:1'],
      ['::ffff:192.168.1.1', '::ffff:192.168.1.1'],
      ['2a00:1450:4001:81b::200e', '2a00:1450:4001:81b::200e']
    ]
    for (const [input, canonical] of cases) {
      const bytes = ipv6ToBytes(input)
      assert.ok(bytes, `${input} should parse`)
      assert.equal(bytes?.length, 16)
      assert.equal(bytesToIpv6(bytes!), canonical)
      // 压缩形式再解析回来必须一致（幂等）
      assert.deepEqual(ipv6ToBytes(canonical), bytes)
    }
    assert.equal(ipv6ToBytes('nope'), null)
    assert.equal(ipv6ToBytes('1:2:3:4:5:6:7:8:9'), null)
    assert.equal(ipv6ToBytes('fe80::1%eth0')?.length, 16)
  })
})

describe('discoverer verify packet', () => {
  const password = 'lan-trust-2026'

  test('roundtrip with the right password', () => {
    const now = 1_800_000_000_000
    const buf = encodeVerify(password, VERIFY_REQUEST, '书房台式机', now, randomVerifyPadding())
    const decoded = decodeVerify(password, buf)
    assert.ok(decoded)
    assert.equal(decoded?.kind, VERIFY_REQUEST)
    assert.equal(decoded?.time, now)
    assert.equal(decoded?.name, '书房台式机')
  })

  test('wrong password / garbage fails to decode', () => {
    const buf = encodeVerify(password, VERIFY_REQUEST, 'A', Date.now(), Buffer.alloc(8))
    assert.equal(decodeVerify('other-password', buf), null)
    assert.equal(decodeVerify(password, Buffer.alloc(64)), null)
    assert.equal(decodeVerify(password, Buffer.alloc(4)), null)
  })

  test('padding randomizes length (obfuscation)', () => {
    const lens = new Set<number>()
    for (let i = 0; i < 40; i++) {
      lens.add(encodeVerify(password, VERIFY_REPLY, 'A', 1, randomVerifyPadding()).length)
    }
    assert.ok(lens.size > 3, `expected varied lengths, got ${[...lens].join(',')}`)
  })

  test('freshness window', () => {
    const now = 1_800_000_000_000
    assert.ok(verifyFresh(now, now))
    assert.ok(verifyFresh(now - VERIFY_WINDOW_MS + 1000, now))
    assert.ok(!verifyFresh(now - VERIFY_WINDOW_MS - 1000, now))
    assert.ok(!verifyFresh(now + VERIFY_WINDOW_MS + 1000, now))
  })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateAddress, isPrivateUrl } from './net-guard'

test('受限地址判定', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1'
  ])
    assert.equal(isPrivateAddress(ip), true, ip)
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111'])
    assert.equal(isPrivateAddress(ip), false, ip)
})

test('URL 主机判定（不联网的部分）', async () => {
  assert.equal(await isPrivateUrl(new URL('http://localhost:47810/api')), true)
  assert.equal(await isPrivateUrl(new URL('http://foo.localhost/')), true)
  assert.equal(await isPrivateUrl(new URL('http://[::1]:8080/')), true)
  assert.equal(await isPrivateUrl(new URL('http://192.168.0.1/')), true)
  assert.equal(await isPrivateUrl(new URL('https://1.1.1.1/')), false)
})

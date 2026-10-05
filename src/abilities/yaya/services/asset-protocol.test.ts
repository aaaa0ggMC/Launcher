import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { before, it } from 'node:test'

process.env.HOME = mkdtempSync('/tmp/yaya-asset-proto-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`

let proto: typeof import('./asset-protocol')
let assets: typeof import('./assets')
before(async () => {
  assert.ok(process.env.HOME?.startsWith('/tmp/'), 'HOME must be isolated under /tmp/')
  proto = await import('./asset-protocol')
  assets = await import('./assets')
})

it('图片：整读 / Range；非媒体 403；越界 400；不存在 404', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000', 'hex')
  const att = await assets.saveAsset('sess1', 'shot.png', png, 'image/png')

  const full = await proto.handleAssetRequest(new Request(`${att.assetPath}?v=1`))
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), png)

  const part = await proto.handleAssetRequest(
    new Request(att.assetPath, { headers: { Range: 'bytes=2-4' } })
  )
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), `bytes 2-4/${png.length}`)
  assert.equal((await part.arrayBuffer()).byteLength, 3)

  const txt = await assets.saveAsset('sess1', 'a.txt', Buffer.from('hi'), 'text/plain')
  assert.equal((await proto.handleAssetRequest(new Request(txt.assetPath))).status, 403)
  assert.equal(
    (await proto.handleAssetRequest(new Request('yaya-asset://sess1/..%2F..%2Fetc.png'))).status,
    400
  )
  assert.equal(
    (await proto.handleAssetRequest(new Request('yaya-asset://sess1/missing.png'))).status,
    404
  )
})

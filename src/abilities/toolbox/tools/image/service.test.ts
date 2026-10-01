import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { Jimp } from 'jimp'
import { execute } from './service'
import { definitions } from './definitions'
import type { ToolArgs, ToolFile } from '../../types'

/* 纯生成小图做输入，不读写任何用户文件，也不调用 Electron。 */

async function imageFile(options: {
  width: number
  height: number
  color?: number
  paint?: (image: InstanceType<typeof Jimp>) => void
  name?: string
}): Promise<ToolFile> {
  const image = new Jimp({
    width: options.width,
    height: options.height,
    color: options.color ?? 0xffffffff
  })
  options.paint?.(image)
  const buffer = await image.getBuffer('image/png')
  return {
    name: options.name ?? 'input.png',
    mime: 'image/png',
    base64: buffer.toString('base64')
  }
}

function decode(file: ToolFile | undefined): Buffer {
  assert.ok(file, '缺少输出文件')
  return Buffer.from(file.base64, 'base64')
}

describe('image 工具 · 定义', () => {
  test('id 唯一且都带中英文标题与关键词', () => {
    const ids = definitions.map((d) => d.id)
    assert.strictEqual(new Set(ids).size, ids.length)
    for (const def of definitions) {
      assert.ok(def.title.length > 0, `${def.id} 缺少中文标题`)
      assert.ok(def.titleEn.length > 0, `${def.id} 缺少英文标题`)
      assert.ok(def.description.length > 0, `${def.id} 缺少描述`)
      assert.ok(def.keywords.length > 0, `${def.id} 缺少关键词`)
      assert.strictEqual(def.category, 'image')
      assert.ok(def.icon.startsWith('default/'), `${def.id} 图标应为单色 SVG`)
    }
  })

  test('service 覆盖所有定义', async () => {
    for (const def of definitions) {
      const result = await execute(def.id, {})
      assert.strictEqual(result.ok, false, `${def.id} 空参数应报错`)
      assert.ok(typeof result.error === 'string' && result.error.length > 0)
    }
    const unknown = await execute('image-not-exists', {})
    assert.strictEqual(unknown.ok, false)
  })
})

describe('image 工具 · 压缩', () => {
  test('缩小尺寸并报告前后大小', async () => {
    const file = await imageFile({ width: 200, height: 100 })
    const result = await execute('image-compress', {
      image: file,
      maxWidth: 50,
      format: 'png'
    } as ToolArgs)
    assert.strictEqual(result.ok, true, result.error)
    assert.strictEqual(result.files?.length, 1)
    const out = await Jimp.read(decode(result.files?.[0]))
    assert.strictEqual(out.bitmap.width, 50)
    assert.strictEqual(out.bitmap.height, 25)
    const data = result.data as { beforeBytes: number; afterBytes: number }
    assert.ok(data.beforeBytes > 0 && data.afterBytes > 0)
  })

  test('不会放大小图', async () => {
    const file = await imageFile({ width: 20, height: 10 })
    const result = await execute('image-compress', { image: file, maxWidth: 500, format: 'png' })
    assert.strictEqual(result.ok, true, result.error)
    const out = await Jimp.read(decode(result.files?.[0]))
    assert.strictEqual(out.bitmap.width, 20)
    assert.strictEqual(out.bitmap.height, 10)
  })

  test('JPEG 输出时透明区域被填充', async () => {
    const file = await imageFile({
      width: 16,
      height: 16,
      paint: (image) => {
        for (let i = 0; i < image.bitmap.data.length; i += 4) image.bitmap.data[i + 3] = 0
      }
    })
    const result = await execute('image-compress', {
      image: file,
      format: 'jpeg',
      flatten: '#112233',
      quality: 70
    })
    assert.strictEqual(result.ok, true, result.error)
    assert.strictEqual(result.files?.[0].mime, 'image/jpeg')
    const out = await Jimp.read(decode(result.files?.[0]))
    const color = out.getPixelColor(0, 0)
    // JPEG 有损，允许 ±6 的偏差
    const r = (color >>> 24) & 0xff
    const g = (color >>> 16) & 0xff
    const b = (color >>> 8) & 0xff
    assert.ok(Math.abs(r - 0x11) <= 6, `R=${r}`)
    assert.ok(Math.abs(g - 0x22) <= 6, `G=${g}`)
    assert.ok(Math.abs(b - 0x33) <= 6, `B=${b}`)
    assert.strictEqual(color & 0xff, 255, 'JPEG 输出必须不透明')
  })
})

describe('image 工具 · 裁剪', () => {
  test('裁剪并旋转 90 度后宽高互换', async () => {
    const file = await imageFile({ width: 40, height: 20, color: 0x3366ccff })
    const result = await execute('image-crop', {
      image: file,
      x: 0,
      y: 0,
      w: 40,
      h: 20,
      rotate: 90
    })
    assert.strictEqual(result.ok, true, result.error)
    const out = await Jimp.read(decode(result.files?.[0]))
    assert.strictEqual(out.bitmap.width, 20)
    assert.strictEqual(out.bitmap.height, 40)
  })

  test('裁剪区域越界返回错误', async () => {
    const file = await imageFile({ width: 10, height: 10 })
    const result = await execute('image-crop', { image: file, x: 5, y: 5, w: 10, h: 10 })
    assert.strictEqual(result.ok, false)
    assert.match(result.error ?? '', /范围/)
  })
})

describe('image 工具 · 滤镜', () => {
  test('灰度后 RGB 相等', async () => {
    const file = await imageFile({ width: 8, height: 8, color: 0xff0000ff })
    const result = await execute('image-filter', { image: file, filter: 'greyscale' })
    assert.strictEqual(result.ok, true, result.error)
    const out = await Jimp.read(decode(result.files?.[0]))
    const color = out.getPixelColor(4, 4)
    const r = (color >>> 24) & 0xff
    const g = (color >>> 16) & 0xff
    const b = (color >>> 8) & 0xff
    assert.strictEqual(r, g)
    assert.strictEqual(g, b)
  })

  test('像素化与漫画风可运行', async () => {
    const file = await imageFile({ width: 32, height: 32, color: 0x00ff00ff })
    const pixelate = await execute('image-filter', {
      image: file,
      filter: 'pixelate',
      blockSize: 8
    })
    assert.strictEqual(pixelate.ok, true, pixelate.error)
    const comic = await execute('image-filter', { image: file, filter: 'comic' })
    assert.strictEqual(comic.ok, true, comic.error)
    assert.match(comic.note ?? '', /不是 AI/)
  })
})

describe('image 工具 · 纯色去底', () => {
  test('白色背景变透明，内部色块保留', async () => {
    const file = await imageFile({
      width: 20,
      height: 20,
      paint: (image) => {
        for (let x = 5; x < 15; x++) {
          for (let y = 5; y < 15; y++) image.setPixelColor(0xff0000ff, x, y)
        }
      }
    })
    const result = await execute('image-background', {
      image: file,
      mode: 'transparent',
      bgColor: '#ffffff',
      tolerance: 8
    })
    assert.strictEqual(result.ok, true, result.error)
    const out = await Jimp.read(decode(result.files?.[0]))
    assert.strictEqual(out.getPixelColor(0, 0) & 0xff, 0, '背景应为透明')
    assert.strictEqual(out.getPixelColor(10, 10) & 0xff, 255, '内部应为不透明')
    assert.strictEqual((out.getPixelColor(10, 10) >>> 24) & 0xff, 255)
  })

  test('替换底色', async () => {
    const file = await imageFile({ width: 12, height: 12, color: 0xffffffff })
    const result = await execute('image-background', {
      image: file,
      mode: 'replace',
      bgColor: '#ffffff',
      newColor: '#0000ff',
      tolerance: 5
    })
    assert.strictEqual(result.ok, true, result.error)
    const out = await Jimp.read(decode(result.files?.[0]))
    assert.strictEqual(out.getPixelColor(6, 6), 0x0000ffff)
  })
})

describe('image 工具 · Base64', () => {
  test('dataURL 往返', async () => {
    const file = await imageFile({ width: 24, height: 18, color: 0x123456ff })
    const encoded = await execute('image-base64', { image: file, mode: 'encode', format: 'png' })
    assert.strictEqual(encoded.ok, true, encoded.error)
    assert.match(encoded.text ?? '', /^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
    const decoded = await execute('image-base64', { dataUrl: encoded.text, mode: 'decode' })
    assert.strictEqual(decoded.ok, true, decoded.error)
    const out = await Jimp.read(decode(decoded.files?.[0]))
    assert.strictEqual(out.bitmap.width, 24)
    assert.strictEqual(out.bitmap.height, 18)
  })

  test('非法 dataURL 报错', async () => {
    const bad = await execute('image-base64', {
      dataUrl: 'https://example.com/a.png',
      mode: 'decode'
    })
    assert.strictEqual(bad.ok, false)
    const badMime = await execute('image-base64', {
      dataUrl: 'data:image/svg+xml;base64,AAAA',
      mode: 'decode'
    })
    assert.strictEqual(badMime.ok, false)
    const notImage = await execute('image-base64', {
      dataUrl: `data:image/png;base64,${Buffer.from('not an image').toString('base64')}`,
      mode: 'decode'
    })
    assert.strictEqual(notImage.ok, false)
  })

  test('ICO dataURL 取回内嵌 PNG', async () => {
    const file = await imageFile({ width: 32, height: 32, color: 0xabcdef12 })
    const ico = await execute('image-ico', { image: file, sizes: '16' })
    const icoDataUrl = `data:image/x-icon;base64,${ico.files?.[0].base64}`
    const decoded = await execute('image-base64', { dataUrl: icoDataUrl, mode: 'decode' })
    assert.strictEqual(decoded.ok, true, decoded.error)
    const out = await Jimp.read(decode(decoded.files?.[0]))
    assert.strictEqual(out.bitmap.width, 16)
  })
})

describe('image 工具 · ICO', () => {
  test('目录结构合法且内嵌 PNG', async () => {
    const file = await imageFile({ width: 64, height: 64, color: 0x00ff00ff })
    const result = await execute('image-ico', { image: file, sizes: '16,32' })
    assert.strictEqual(result.ok, true, result.error)
    const ico = decode(result.files?.[0])
    assert.strictEqual(ico.readUInt16LE(0), 0, 'reserved 必须为 0')
    assert.strictEqual(ico.readUInt16LE(2), 1, 'type 必须为 1 (icon)')
    const count = ico.readUInt16LE(4)
    assert.strictEqual(count, 2)
    let total = 6 + 16 * count
    for (let i = 0; i < count; i++) {
      const entry = 6 + 16 * i
      const w = ico.readUInt8(entry)
      const h = ico.readUInt8(entry + 1)
      const bytes = ico.readUInt32LE(entry + 8)
      const offset = ico.readUInt32LE(entry + 12)
      assert.strictEqual(w, h)
      assert.ok([16, 32].includes(w))
      assert.strictEqual(offset, total)
      assert.deepStrictEqual(
        Array.from(ico.subarray(offset, offset + 4)),
        [0x89, 0x50, 0x4e, 0x47],
        '条目必须是 PNG'
      )
      total += bytes
    }
    assert.strictEqual(ico.length, total, '文件长度应等于目录 + 数据')
  })

  test('尺寸参数校验', async () => {
    const file = await imageFile({ width: 16, height: 16 })
    const bad = await execute('image-ico', { image: file, sizes: '17' })
    assert.strictEqual(bad.ok, false)
    const many = await execute('image-ico', { image: file, sizes: '16,24,32,48,64,128,256' })
    assert.strictEqual(many.ok, false)
  })
})

describe('image 工具 · 切图', () => {
  test('2x2 切图尺寸正确', async () => {
    const file = await imageFile({ width: 40, height: 20, color: 0x445566ff })
    const result = await execute('image-grid', { image: file, grid: '2x2', format: 'png' })
    assert.strictEqual(result.ok, true, result.error)
    assert.strictEqual(result.files?.length, 4)
    for (const out of result.files ?? []) {
      const tile = await Jimp.read(decode(out))
      assert.strictEqual(tile.bitmap.width, 20)
      assert.strictEqual(tile.bitmap.height, 10)
    }
    const data = result.data as { columns: number; rows: number; tiles: unknown[] }
    assert.deepStrictEqual([data.columns, data.rows], [2, 2])
    assert.strictEqual(data.tiles.length, 4)
  })

  test('奇数尺寸按余数分配', async () => {
    const file = await imageFile({ width: 10, height: 10 })
    const result = await execute('image-grid', { image: file, grid: '3x3', format: 'png' })
    assert.strictEqual(result.ok, true, result.error)
    const data = result.data as { tiles: { width: number; height: number }[] }
    // 10px 切 3 份：列/行边界都是 [4, 7, 10]，逐行展开
    const sizes = data.tiles.map((t) => `${t.width}x${t.height}`)
    assert.deepStrictEqual(sizes, ['4x4', '3x4', '3x4', '4x3', '3x3', '3x3', '4x3', '3x3', '3x3'])
  })
})

describe('image 工具 · 字符画', () => {
  test('输出纯字符文本', async () => {
    const file = await imageFile({ width: 60, height: 30, color: 0x80808080 })
    const result = await execute('image-ascii', { image: file, columns: 40 })
    assert.strictEqual(result.ok, true, result.error)
    const lines = (result.text ?? '').split('\n')
    assert.ok(lines.length >= 1)
    for (const line of lines) assert.match(line, /^[ .:\-=+*#%@]+$/)
    const data = result.data as { columns: number; rows: number }
    assert.strictEqual(data.columns, 40)
  })
})

describe('image 工具 · 水印', () => {
  test('SVG 内嵌图片并转义文字', async () => {
    const file = await imageFile({ width: 40, height: 20 })
    const result = await execute('image-watermark', {
      image: file,
      text: '<script>alert("x")</script> & \'q\'',
      fontSize: 16,
      opacity: 50,
      position: 'br'
    })
    assert.strictEqual(result.ok, true, result.error)
    const svg = decode(result.files?.[0]).toString('utf8')
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
    assert.match(svg, /data:image\/png;base64,[A-Za-z0-9+/=]+/)
    assert.ok(!svg.includes('<script>'), '不得包含未转义脚本文本')
    assert.ok(svg.includes('&lt;script&gt;'))
    assert.match(svg, /fill-opacity="0\.500"/)
    assert.ok(!/xlink:href="(?!data:)/.test(svg), '不得引用外部资源')
  })

  test('平铺水印', async () => {
    const file = await imageFile({ width: 600, height: 400 })
    const result = await execute('image-watermark', {
      image: file,
      text: 'Cockpit',
      position: 'tile'
    })
    assert.strictEqual(result.ok, true, result.error)
    const data = result.data as { count: number }
    assert.ok(data.count > 4, `平铺数量应大于 4，实际 ${data.count}`)
  })

  test('空文字报错', async () => {
    const file = await imageFile({ width: 10, height: 10 })
    const result = await execute('image-watermark', { image: file, text: '   ' })
    assert.strictEqual(result.ok, false)
  })
})

describe('image 工具 · 词云', () => {
  test('词频统计与确定性输出', async () => {
    const args: ToolArgs = { text: 'alpha beta beta gamma gamma gamma delta', maxWords: 10 }
    const first = await execute('word-cloud', args)
    const second = await execute('word-cloud', args)
    assert.strictEqual(first.ok, true, first.error)
    assert.strictEqual(second.ok, true, second.error)
    assert.strictEqual(
      first.files?.[0].base64,
      second.files?.[0].base64,
      '同样的输入必须得到同样的结果'
    )
    const data = first.data as { words: { word: string; count: number }[]; skipped: number }
    assert.strictEqual(data.words[0].word, 'gamma')
    assert.strictEqual(data.words[0].count, 3)
    assert.ok(!data.words.some((w) => w.word === 'the'))
    const svg = decode(first.files?.[0]).toString('utf8')
    assert.strictEqual(svg.match(/<text/g)?.length, data.words.length, '每个词一个 text')
  })

  test('中文词频（Intl.Segmenter 分词）', async () => {
    const result = await execute('word-cloud', { text: '测试测试数据数据数据', maxWords: 5 })
    assert.strictEqual(result.ok, true, result.error)
    const data = result.data as { words: { word: string; count: number }[] }
    assert.strictEqual(data.words[0].word, '数据')
    assert.strictEqual(data.words[0].count, 3)
    assert.ok(data.words.some((w) => w.word === '测试' && w.count === 2))
  })
})

describe('image 工具 · 叠加', () => {
  test('定点叠加混合 alpha', async () => {
    const base = await imageFile({ width: 20, height: 20, color: 0x000000ff })
    const overlay = await imageFile({ width: 10, height: 10, color: 0xff0000ff })
    const result = await execute('image-montage', {
      base,
      overlay,
      mode: 'overlay',
      x: 0,
      y: 0,
      opacity: 100
    })
    assert.strictEqual(result.ok, true, result.error)
    const out = await Jimp.read(decode(result.files?.[0]))
    assert.strictEqual(out.bitmap.width, 20)
    // getPixelColor 返回 0xRRGGBBAA：alpha 在低字节
    assert.strictEqual(out.getPixelColor(2, 2) & 0xff, 255, '叠加区域应不透明')
    assert.strictEqual(out.getPixelColor(2, 2) >>> 24, 255, '叠加区域应为红色')
    assert.strictEqual(out.getPixelColor(15, 15) & 0xff, 255, '底图区域应不透明')
  })

  test('角标模式自动贴角', async () => {
    const base = await imageFile({ width: 100, height: 100 })
    const overlay = await imageFile({ width: 20, height: 10 })
    const result = await execute('image-montage', {
      base,
      overlay,
      mode: 'badge',
      scale: 25,
      corner: 'br'
    })
    assert.strictEqual(result.ok, true, result.error)
    const data = result.data as { overlay: { x: number; y: number; width: number } }
    assert.strictEqual(data.overlay.width, 25)
    // 边距 = max(4, round(100 * 0.02)) = 4；缩放后高度 = round(10 * 25 / 20) = 13
    assert.strictEqual(data.overlay.x, 100 - 25 - 4)
    assert.strictEqual(data.overlay.y, 100 - 13 - 4)
  })

  test('完全越界报错', async () => {
    const base = await imageFile({ width: 20, height: 20 })
    const overlay = await imageFile({ width: 10, height: 10 })
    const result = await execute('image-montage', { base, overlay, mode: 'overlay', x: 30, y: 30 })
    assert.strictEqual(result.ok, false)
  })
})

describe('image 工具 · 输入校验', () => {
  test('空 base64 / 非图片数据报错', async () => {
    const empty = await execute('image-compress', {
      image: { name: 'a.png', mime: 'image/png', base64: '' }
    })
    assert.strictEqual(empty.ok, false)
    const notImage = await execute('image-compress', {
      image: { name: 'a.png', mime: 'image/png', base64: Buffer.from('hello').toString('base64') }
    })
    assert.strictEqual(notImage.ok, false)
    const missing = await execute('image-compress', {})
    assert.strictEqual(missing.ok, false)
  })
})

test('拒绝图片解码炸弹：在解码前检查 PNG 尺寸', async () => {
  const header = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header)
  header.writeUInt32BE(100000, 16)
  header.writeUInt32BE(100000, 20)
  const result = await execute('image-compress', {
    image: { name: 'huge.png', mime: 'image/png', base64: header.toString('base64') }
  })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /尺寸超出/)
})

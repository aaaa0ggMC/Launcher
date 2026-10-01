import { test } from 'node:test'
import assert from 'node:assert/strict'
import { definitions } from './definitions'
import { execute } from './service'

function dataOf(result: { data?: unknown }): Record<string, unknown> {
  return result.data as Record<string, unknown>
}

function decodeFile(
  result: { files?: { name: string; mime: string; base64: string }[] },
  ext: string
): string {
  const file = result.files?.find((f) => f.name === ext)
  assert.ok(file, `缺少结果附件 ${ext}`)
  assert.equal(file.mime, ext === 'qrcode.png' ? 'image/png' : 'image/svg+xml')
  return Buffer.from(file.base64, 'base64').toString('binary')
}

test('人民币大写：零、角分、零位与负数边界', async () => {
  const cases: [string, string][] = [
    ['0', '人民币零元整'],
    ['0.05', '人民币伍分'],
    ['0.5', '人民币伍角整'],
    ['1.05', '人民币壹元零伍分'],
    ['1.5', '人民币壹元伍角整'],
    ['10', '人民币壹拾元整'],
    ['105', '人民币壹佰零伍元整'],
    ['10000', '人民币壹万元整'],
    ['10005', '人民币壹万零伍元整'],
    ['100000005', '人民币壹亿零伍元整'],
    ['123456789.12', '人民币壹亿贰仟叁佰肆拾伍万陆仟柒佰捌拾玖元壹角贰分'],
    ['-12.34', '人民币负壹拾贰元叁角肆分'],
    ['¥1,000.10', '人民币壹仟元壹角整'],
    ['999999999999.99', '人民币玖仟玖佰玖拾玖亿玖仟玖佰玖拾玖万玖仟玖佰玖拾玖元玖角玖分']
  ]
  for (const [amount, expected] of cases) {
    const result = await execute('rmb-uppercase', { amount })
    assert.equal(result.ok, true, `${amount} 应成功`)
    assert.equal(result.text, expected, amount)
  }
})

test('人民币大写：精度与范围校验（拒绝浮点式输入）', async () => {
  for (const bad of ['abc', '1.234', '1234567890123', '-', '1e3', '']) {
    const result = await execute('rmb-uppercase', { amount: bad })
    assert.equal(result.ok, false, `${bad} 应被拒绝`)
    assert.ok(result.error)
  }
  // '.5' / '1.' 这类缺省写法被规范化为 0.50 / 1.00
  assert.equal((await execute('rmb-uppercase', { amount: '.5' })).text, '人民币伍角整')
  assert.equal((await execute('rmb-uppercase', { amount: '1.' })).text, '人民币壹元整')
  // 默认值兜底（CLI 不带参数）
  const fallback = await execute('rmb-uppercase', {})
  assert.equal(fallback.text, '人民币壹仟贰佰叁拾肆元伍角陆分')
  assert.equal(dataOf(fallback).normalized, '1234.56')
})

test('SVG 输出严格转义用户文本', async () => {
  const icon = await execute('icon-generator', { text: '<&>"', bg: '#123456', fg: '#abcdef' })
  assert.equal(icon.ok, true)
  const iconXml = decodeFile(icon, 'icon.svg')
  assert.ok(iconXml.includes('&lt;&amp;&gt;&quot;'))
  assert.ok(!iconXml.includes('<&>') && !iconXml.includes('<b>'))

  const signature = await execute('signature', { text: '<script>alert(1)</script>' })
  assert.equal(signature.ok, false, '超长/含控制字符之外的标记文本必须失败或转义')
  const short = await execute('signature', { text: '<b>' })
  assert.equal(short.ok, true)
  assert.ok(decodeFile(short, 'signature.svg').includes('&lt;b&gt;'))

  const stamp = await execute('stamp-generator', { top: '<a&b>', shape: 'circle' })
  assert.equal(stamp.ok, true)
  assert.ok(decodeFile(stamp, 'stamp.svg').includes('&lt;a&amp;b&gt;'))

  // 颜色只接受十六进制，防止属性注入
  assert.equal((await execute('icon-generator', { text: 'A', bg: 'red' })).ok, false)
  assert.equal(
    (await execute('stamp-generator', { top: '测试', color: '#fff" onload="alert(1)' })).ok,
    false
  )
})

test('二维码：SVG 与 PNG 都能真实生成', async () => {
  const svg = await execute('qrcode', { content: 'hello 世界' })
  assert.equal(svg.ok, true)
  assert.equal(svg.files?.[0].name, 'qrcode.svg')
  const svgXml = decodeFile(svg, 'qrcode.svg')
  assert.ok(svgXml.startsWith('<svg') && svgXml.includes('xmlns="http://www.w3.org/2000/svg"'))
  assert.equal(dataOf(svg).format, 'svg')

  const png = await execute('qrcode', { content: 'hello', format: 'png', size: 200 })
  assert.equal(png.ok, true)
  const pngBytes = Buffer.from(png.files?.[0].base64 ?? '', 'base64')
  assert.equal(pngBytes[0], 0x89)
  assert.equal(pngBytes[1], 0x50)
  assert.ok(pngBytes.length > 500)

  const overflow = await execute('qrcode', { content: 'A'.repeat(5000) })
  assert.equal(overflow.ok, false)
  assert.ok(overflow.error)
})

test('密码生成：加密随机、字符集与默认兜底', async () => {
  const first = await execute('password-generator', { length: 24 })
  assert.equal(first.ok, true)
  const firstPassword = dataOf(first).passwords as string[]
  assert.equal(firstPassword[0].length, 24)
  assert.match(firstPassword[0], /^[A-Za-z0-9]+$/)

  const second = await execute('password-generator', { length: 24, symbols: true })
  const secondPassword = dataOf(second).passwords as string[]
  assert.notEqual(firstPassword[0], secondPassword[0], '两次生成不应相同')

  const strict = await execute('password-generator', {
    length: 20,
    count: 3,
    excludeAmbiguous: true,
    upper: false,
    symbols: false
  })
  const strictPasswords = dataOf(strict).passwords as string[]
  assert.equal(strictPasswords.length, 3)
  for (const pwd of strictPasswords) {
    assert.match(pwd, /^[a-km-np-z2-9]{20}$/)
  }

  assert.equal(
    (await execute('password-generator', { upper: false, lower: false, digits: false })).ok,
    false
  )
  assert.equal((await execute('password-generator', { length: 1 })).ok, false)
  assert.equal((await execute('password-generator', { length: 8 })).ok, true)

  const def = definitions.find((d) => d.id === 'password-generator')
  assert.equal(def?.agentDenied, true)
})

test('随机选择：不重复抽取与错误输入', async () => {
  const picked = await execute('choice', { options: '苹果\n香蕉\n橙子', count: 2 })
  assert.equal(picked.ok, true)
  const result = dataOf(picked).picked as string[]
  assert.equal(result.length, 2)
  assert.equal(new Set(result).size, 2)
  for (const item of result) assert.ok(['苹果', '香蕉', '橙子'].includes(item))

  assert.equal((await execute('choice', { options: '只有一项', count: 2 })).ok, false)
  assert.equal((await execute('choice', { options: '  \n  ' })).ok, false)
  const defaults = await execute('choice', { options: '一\n二' })
  assert.equal((dataOf(defaults).picked as string[]).length, 1)
})

test('亲戚称谓：常见链可推断，歧义组合明确报错', async () => {
  const resolved: [string, string][] = [
    ['妈妈的哥哥', '舅舅（舅父）'],
    ['爸爸的爸爸', '爷爷（祖父）'],
    ['老婆的妈', '岳母'],
    ['女儿的丈夫', '女婿'],
    ['哥哥的妻子', '嫂子'],
    ['妈妈的姐姐的儿子', '表哥或表弟'],
    ['爸爸的弟弟的女儿', '堂姐或堂妹']
  ]
  for (const [chain, expected] of resolved) {
    const result = await execute('kinship', { chain })
    assert.equal(result.ok, true, `${chain}: ${result.error ?? ''}`)
    assert.equal(dataOf(result).name, expected, chain)
  }

  const deep = await execute('kinship', { chain: '爸爸的妈妈的姐姐' })
  assert.equal(deep.ok, false)
  assert.match(deep.error ?? '', /「奶奶（祖母）」的「姐姐」这一组合暂不支持/)

  const ambiguous = await execute('kinship', { chain: '爷爷的儿子' })
  assert.equal(ambiguous.ok, false)
  assert.match(ambiguous.error ?? '', /无法确定/)
  assert.match(ambiguous.error ?? '', /第 2 步|的儿子/)

  const unknown = await execute('kinship', { chain: '外星人的哥哥' })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error ?? '', /无法识别关系词「外星人」/)
})

test('拼音 / 分词 / 简繁转换', async () => {
  const full = await execute('chinese-pinyin', { text: '中国' })
  assert.equal(full.text, 'zhōng guó')
  assert.equal((await execute('chinese-pinyin', { text: '中国', mode: 'plain' })).text, 'zhong guo')
  assert.equal(
    (await execute('chinese-pinyin', { text: '中国', mode: 'numeric' })).text,
    'zhong1 guo2'
  )
  assert.equal((await execute('chinese-pinyin', { text: '中国', mode: 'first' })).text, 'z g')
  assert.equal((await execute('chinese-pinyin', { text: '中国', mode: 'initial' })).text, 'zh g')
  assert.equal(
    (await execute('chinese-pinyin', { text: '中国', letterCase: 'upper' })).text,
    'ZHŌNG GUÓ'
  )
  const multiple = await execute('chinese-pinyin', { text: '重要', multiple: true })
  assert.match(multiple.text ?? '', /\//)

  const segment = await execute('chinese-segment', { text: '我喜欢编程，也喜欢咖啡。' })
  assert.equal(segment.ok, true)
  const tokens = dataOf(segment).tokens as string[]
  assert.ok(tokens.includes('我'))
  assert.ok(tokens.length >= 6)
  assert.equal(
    (await execute('chinese-segment', { text: '测试', granularity: 'grapheme', keepPunct: true }))
      .ok,
    true
  )
  assert.equal((await execute('chinese-segment', { text: ' ' })).ok, false)

  assert.equal((await execute('chinese-convert', { text: '汉字简繁转换' })).text, '漢字簡繁轉換')
  assert.equal((await execute('chinese-convert', { text: '漢字', target: 't2s' })).text, '汉字')
  assert.equal((await execute('chinese-convert', { text: 'x', target: 'nope' })).ok, false)
})

test('字符统计、文本对比与文本清理', async () => {
  const stats = await execute('char-statistics', { text: 'Hello 世界 123\n第二行' })
  assert.equal(stats.ok, true)
  const counted = dataOf(stats)
  assert.equal(counted.codePoints, 16)
  assert.equal(counted.chineseCharacters, 5)
  assert.equal(counted.latinLetters, 5)
  assert.equal(counted.digits, 3)
  assert.equal(counted.whitespace, 3)
  assert.equal(counted.words, 6)
  assert.equal(counted.lines, 2)
  assert.equal((await execute('char-statistics', { text: '   ' })).ok, false)

  const diff = await execute('text-diff', { original: 'a\nb\nc', modified: 'a\nc\nd' })
  assert.equal(diff.ok, true)
  const rows = dataOf(diff).rows as { type: string; text: string }[]
  assert.deepEqual(
    rows.map((r) => `${r.type}:${r.text}`),
    ['same:a', 'del:b', 'same:c', 'add:d']
  )
  assert.equal((await execute('text-diff', { original: '', modified: '' })).ok, false)

  const clean = await execute('text-clean', {
    text: ' b \n\na\nb',
    trimLines: true,
    dropEmpty: true,
    dedupe: true,
    sort: 'asc'
  })
  assert.equal(clean.text, 'a\nb')
  assert.equal((await execute('text-clean', { text: 'x\nx', dedupe: false })).text, 'x\nx')
})

test('ASCII 艺术字与未知工具', async () => {
  const art = await execute('ascii-art', { text: 'Hi', font: 'Standard' })
  assert.equal(art.ok, true)
  assert.ok((art.text ?? '').includes('_'))
  assert.equal((await execute('ascii-art', { text: '你好' })).ok, false, 'FIGlet 字体仅 ASCII')
  assert.equal((await execute('ascii-art', { text: 'Hi', font: '不存在的字体' })).ok, false)
  assert.equal((await execute('不存在的工具', {})).ok, false)
})

test('definitions：元数据完整且无娱乐工具', () => {
  const ids = definitions.map((d) => d.id)
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一')
  for (const def of definitions) {
    assert.equal(def.category, 'text')
    assert.ok(def.title && def.titleEn, `${def.id} 缺少标题`)
    assert.ok(def.description && def.descriptionEn, `${def.id} 缺少说明`)
    assert.ok(def.icon.startsWith('mdi-'), `${def.id} 应用单色 mdi 图标`)
    assert.ok(def.keywords.length >= 4, `${def.id} 关键词过少`)
    assert.ok(def.fields.length >= 1, `${def.id} 缺少字段`)
    const keys = def.fields.map((f) => f.key)
    assert.equal(new Set(keys).size, keys.length, `${def.id} 字段 key 重复`)
  }
  const expected = [
    'char-statistics',
    'text-diff',
    'text-clean',
    'chinese-pinyin',
    'chinese-segment',
    'chinese-convert',
    'ascii-art',
    'rmb-uppercase',
    'choice',
    'qrcode',
    'password-generator',
    'kinship',
    'signature',
    'stamp-generator',
    'icon-generator'
  ]
  assert.deepEqual([...ids].sort(), [...expected].sort())
})

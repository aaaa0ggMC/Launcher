import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execute } from './service'

/**
 * Offline tests for the developer toolbox. They only touch the pure service
 * functions — no Electron, no network, no user config.
 */

test('json-format sorts keys and minifies', async () => {
  const pretty = await execute('json-format', {
    input: '{"b":2,"a":{"d":1,"c":[3,1]}}',
    indent: '2',
    sortKeys: true
  })
  assert.equal(pretty.ok, true)
  assert.equal(
    pretty.text,
    '{\n  "a": {\n    "c": [\n      3,\n      1\n    ],\n    "d": 1\n  },\n  "b": 2\n}'
  )

  const minified = await execute('json-format', { input: '{"a": 1, "b": [2, 3]}', compact: true })
  assert.equal(minified.ok, true)
  assert.equal(minified.text, '{"a":1,"b":[2,3]}')
})

test('json-format sortKeys keeps a literal __proto__ key', async () => {
  const result = await execute('json-format', {
    input: '{"__proto__":{"x":1},"b":2}',
    sortKeys: true
  })
  assert.equal(result.ok, true)
  const parsed = JSON.parse(result.text ?? '{}') as Record<string, unknown>
  assert.deepEqual(Object.keys(parsed), ['__proto__', 'b'])
  assert.deepEqual(parsed['__proto__'], { x: 1 })
  assert.equal(({} as Record<string, unknown>).x, undefined, 'Object.prototype must stay clean')
})

test('json-format rejects invalid input', async () => {
  const bad = await execute('json-format', { input: '{oops}' })
  assert.equal(bad.ok, false)
  assert.match(bad.error ?? '', /JSON 解析失败/)
})

test('json-escape round-trips through JSON.parse', async () => {
  const escaped = await execute('json-escape', { input: 'a"b\\c\n换行', mode: 'escape' })
  assert.equal(escaped.ok, true)
  const reParsed = JSON.parse(escaped.text ?? '')
  assert.equal(reParsed, 'a"b\\c\n换行')

  const back = await execute('json-escape', { input: escaped.text ?? '', mode: 'unescape' })
  assert.equal(back.ok, true)
  assert.equal(back.text, 'a"b\\c\n换行')

  const invalid = await execute('json-escape', { input: 'not quoted', mode: 'unescape' })
  assert.equal(invalid.ok, false)
})

test('config-convert round-trips JSON -> YAML -> JSON', async () => {
  const yaml = await execute('config-convert', {
    input: '{"name":"cockpit","port":8080,"debug":true}',
    from: 'json',
    to: 'yaml'
  })
  assert.equal(yaml.ok, true)
  assert.match(yaml.text ?? '', /port: 8080/)

  const back = await execute('config-convert', { input: yaml.text ?? '', from: 'yaml', to: 'json' })
  assert.equal(back.ok, true)
  assert.deepEqual(JSON.parse(back.text ?? ''), { name: 'cockpit', port: 8080, debug: true })
})

test('config-convert handles TOML and rejects invalid input', async () => {
  const toml = await execute('config-convert', {
    input: '{"server":{"host":"127.0.0.1","ports":[80,443]}}',
    from: 'json',
    to: 'toml'
  })
  assert.equal(toml.ok, true)
  assert.match(toml.text ?? '', /host = "127.0.0.1"/)
  const back = await execute('config-convert', { input: toml.text ?? '', from: 'toml', to: 'json' })
  assert.equal(back.ok, true)
  assert.deepEqual(JSON.parse(back.text ?? ''), { server: { host: '127.0.0.1', ports: [80, 443] } })

  const bad = await execute('config-convert', { input: '{a: [', from: 'json', to: 'yaml' })
  assert.equal(bad.ok, false)
})

test('properties parsing does not pollute Object.prototype', async () => {
  const result = await execute('config-convert', {
    input: [
      'app.name=cockpit',
      'app.note=line1\\nline2',
      '__proto__=evil',
      'constructor=plain'
    ].join('\n'),
    from: 'properties',
    to: 'json'
  })
  assert.equal(result.ok, true)
  const parsed = JSON.parse(result.text ?? '{}') as Record<string, string>
  assert.equal(parsed['app.name'], 'cockpit')
  // \n inside the value is an escaped newline, not a line separator.
  assert.equal(parsed['app.note'], 'line1\nline2')
  assert.equal(parsed['__proto__'], 'evil')
  assert.equal(parsed.constructor, 'plain')
  assert.equal(Object.prototype.hasOwnProperty.call({}, 'evil'), false)
  assert.equal(({} as Record<string, unknown>).evil, undefined)
  assert.equal(
    ({ constructor: 'still-original' } as Record<string, unknown>).constructor,
    'still-original'
  )
})

test('properties joins continuation lines and rejects separator-less lines', async () => {
  const result = await execute('config-convert', {
    input: 'a=one\\\ntwo\nb=plain',
    from: 'properties',
    to: 'json'
  })
  assert.equal(result.ok, true)
  const parsed = JSON.parse(result.text ?? '{}') as Record<string, string>
  assert.equal(parsed.a, 'onetwo')
  assert.equal(parsed.b, 'plain')

  const bad = await execute('config-convert', {
    input: 'no separator here',
    from: 'properties',
    to: 'json'
  })
  assert.equal(bad.ok, false)
})

test('properties output round-trips through the parser', async () => {
  const original = { a: { 'b c': 'x=y\nsecond' }, list: [1, 2], empty: null, flag: true }
  const dumped = await execute('config-convert', {
    input: JSON.stringify(original),
    from: 'json',
    to: 'properties'
  })
  assert.equal(dumped.ok, true)

  const back = await execute('config-convert', {
    input: dumped.text ?? '',
    from: 'properties',
    to: 'json'
  })
  assert.equal(back.ok, true)
  assert.deepEqual(JSON.parse(back.text ?? '{}'), {
    'a.b c': 'x=y\nsecond',
    'list.0': '1',
    'list.1': '2',
    empty: '',
    flag: 'true'
  })
})

test('code-format runs standalone prettier', async () => {
  const result = await execute('code-format', { input: 'const a={b:1}', language: 'javascript' })
  assert.equal(result.ok, true)
  assert.match(result.text ?? '', /const a = \{ b: 1 \}/)

  const ts = await execute('code-format', {
    input: 'const f=(x:number):number=>x*2',
    language: 'typescript'
  })
  assert.equal(ts.ok, true)
  assert.match(ts.text ?? '', /\(x: number\)/)

  const bad = await execute('code-format', { input: 'const =(', language: 'javascript' })
  assert.equal(bad.ok, false)
})

test('js-minify keeps string contents intact', async () => {
  const result = await execute('js-minify', {
    input: 'function greet(name) {\n  const msg = "Hello,  " + name;\n  return msg;\n}'
  })
  assert.equal(result.ok, true)
  // The double space inside the string literal must survive minification.
  assert.equal(result.text?.includes('"Hello,  "'), true)

  const bad = await execute('js-minify', { input: 'function (' })
  assert.equal(bad.ok, false)
})

test('css minify keeps selector structure, calc spacing and url()', async () => {
  const result = await execute('css-format', {
    input:
      '/* drop me */\n.a > .b .c { content: "x , y"; background: url("a b.png"); width: calc(100% - 10px) }',
    mode: 'minify'
  })
  assert.equal(result.ok, true)
  const text = result.text ?? ''
  assert.equal(text.includes('drop me'), false)
  assert.equal(text.includes('.a>.b .c'), true, 'descendant combinator must survive')
  assert.equal(text.includes('content:"x , y"'), true)
  assert.equal(text.includes('url("a b.png")'), true)
  assert.equal(text.includes('calc(100% - 10px)'), true)
})

test('css format beautifies via prettier', async () => {
  const result = await execute('css-format', { input: '.a{color:red}', mode: 'format' })
  assert.equal(result.ok, true)
  assert.match(result.text ?? '', /color: red/)
})

test('html minify preserves preformatted, inline and scripted content', async () => {
  const result = await execute('html-format', {
    input:
      '<div style="white-space:pre"> a   b </div><pre>  keep\n   me</pre><script>var x = 1</script><style>.a { color: red }</style><!-- note -->',
    mode: 'minify'
  })
  assert.equal(result.ok, true)
  const text = result.text ?? ''
  assert.equal(text.includes(' a   b '), true, 'inline white-space:pre text must survive')
  assert.equal(text.includes('  keep\n   me'), true, 'pre content must survive')
  assert.equal(text.includes('var x = 1'), true, 'script content must survive')
  assert.equal(text.includes('.a { color: red }'), true, 'style content must survive')
  assert.equal(text.includes('note'), false, 'only comments are dropped')
  assert.match(text ?? '', /style="white-space:pre"/)
})

test('html format beautifies via prettier', async () => {
  const result = await execute('html-format', { input: '<ul><li>a</li></ul>', mode: 'format' })
  assert.equal(result.ok, true)
  assert.match(result.text ?? '', /<li>a<\/li>/)
})

test('sql-format uppercases keywords', async () => {
  const result = await execute('sql-format', {
    input: 'select id from t where id=1',
    dialect: 'mysql',
    keywordCase: 'upper'
  })
  assert.equal(result.ok, true)
  assert.match(result.text ?? '', /SELECT/)
  assert.match(result.text ?? '', /FROM/)
  assert.match(result.text ?? '', /WHERE/)
})

test('regex-test returns matches and capture groups', async () => {
  const result = await execute('regex-test', {
    pattern: '(\\d{4})-(\\d{2})-(\\d{2})',
    flags: 'g',
    text: '2026-10-01 and 2027-01-15',
    maxMatches: 10,
    timeout: 2000
  })
  assert.equal(result.ok, true)
  const data = result.data as { count: number; matches: { match: string; groups: string[] }[] }
  assert.equal(data.count, 2)
  assert.equal(data.matches[0].match, '2026-10-01')
  assert.deepEqual(data.matches[0].groups, ['2026', '10', '01'])
})

test('regex-test kills catastrophic backtracking', async () => {
  const result = await execute('regex-test', {
    pattern: '(a+)+$',
    flags: '',
    text: `${'a'.repeat(30)}b`,
    timeout: 400,
    maxMatches: 5
  })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /超时|提前退出|终止/)
})

test('regex-test reports syntax errors and bad flags', async () => {
  const syntax = await execute('regex-test', {
    pattern: '(unclosed',
    flags: '',
    text: 'x',
    timeout: 2000
  })
  assert.equal(syntax.ok, false)
  assert.match(syntax.error ?? '', /正则语法错误/)

  const flags = await execute('regex-test', { pattern: 'a', flags: 'zz', text: 'x' })
  assert.equal(flags.ok, false)
  assert.match(flags.error ?? '', /不支持的修饰符/)
})

test('uuid generates v4 values', async () => {
  const result = await execute('uuid', { count: 5, uppercase: true })
  assert.equal(result.ok, true)
  const values = (result.data as { values: string[] }).values
  assert.equal(values.length, 5)
  assert.equal(new Set(values).size, 5)
  for (const value of values) {
    assert.match(value, /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/)
  }
  const compact = await execute('uuid', { count: 2, compact: true })
  assert.equal((compact.data as { values: string[] }).values[0].includes('-'), false)
})

test('mock-data escapes CSV and SQL quotes', async () => {
  const csv = await execute('mock-data', {
    type: 'custom',
    fields: 'na"me',
    count: 1,
    format: 'csv'
  })
  assert.equal(csv.ok, true)
  assert.equal(csv.text, '"na""me"\n"mock-na""me-1"\n')

  const sql = await execute('mock-data', {
    type: 'custom',
    fields: "it's name",
    count: 1,
    format: 'sql'
  })
  assert.equal(sql.ok, true)
  assert.match(sql.text ?? '', /'示例it''s name-1'/)
})

test('mock-data builds JSON rows', async () => {
  const result = await execute('mock-data', { type: 'product', count: 3, format: 'json' })
  const rows = JSON.parse(result.text ?? '[]')
  assert.equal(rows.length, 3)
  assert.equal(rows[0].name, '示例商品-1')
  assert.equal(typeof rows[0].price, 'number')
})

test('cron explains fields and previews local runs', async () => {
  const result = await execute('cron', {
    expression: '*/5 * * * *',
    nextCount: 4,
    from: '2026-10-01T08:03:30'
  })
  assert.equal(result.ok, true)
  assert.match(result.text ?? '', /表达式: \*\/5 \* \* \* \*/)
  assert.match(result.text ?? '', /分钟 = \*\/5/)
  const runs = (result.data as { runs: string[] }).runs.map((run) => new Date(run))
  assert.equal(runs.length, 4)
  assert.equal(runs[0].getMinutes(), 5)
  for (const run of runs) {
    assert.equal(run.getMinutes() % 5, 0)
    assert.equal(run.getSeconds(), 0)
    assert.equal(run.getMilliseconds(), 0)
  }
})

test('cron crosses a month boundary from January 31', async () => {
  const result = await execute('cron', {
    expression: '0 0 1 3 *',
    from: '2026-01-31T12:00:00',
    nextCount: 1
  })
  assert.equal(result.ok, true)
  const run = new Date((result.data as { runs: string[] }).runs[0])
  assert.equal(run.getMonth(), 2, 'March')
  assert.equal(run.getDate(), 1)
  assert.equal(run.getHours(), 0)
  assert.equal(run.getMinutes(), 0)
})

test('cron handles month names and OR day matching', async () => {
  const monthly = await execute('cron', {
    expression: '0 0 1 JAN *',
    from: '2026-06-10T00:00:00',
    nextCount: 1
  })
  assert.equal(monthly.ok, true)
  const run = new Date((monthly.data as { runs: string[] }).runs[0])
  assert.equal(run.getMonth(), 0)
  assert.equal(run.getDate(), 1)
  assert.equal(run.getHours(), 0)

  const or = await execute('cron', {
    expression: '0 0 13 * 5',
    from: '2026-06-10T00:00:00',
    nextCount: 3
  })
  assert.equal(or.ok, true)
  assert.equal((or.data as { runs: string[] }).runs.length, 3)
})

test('cron rejects garbage expressions', async () => {
  const bad = await execute('cron', { expression: '99 * * * *' })
  assert.equal(bad.ok, false)
  assert.match(bad.error ?? '', /分钟/)

  const short = await execute('cron', { expression: '* * *' })
  assert.equal(short.ok, false)

  const badFrom = await execute('cron', { expression: '* * * * *', from: 'not a date' })
  assert.equal(badFrom.ok, false)
})

test('markdown converts to html and provides a download', async () => {
  const result = await execute('markdown', { input: '# 标题\n\n**粗体**\n' })
  assert.equal(result.ok, true)
  assert.match(result.text ?? '', /<h1[^>]*>标题<\/h1>/)
  assert.match(result.text ?? '', /<strong>粗体<\/strong>/)
  const file = result.files?.[0]
  assert.equal(file?.name, 'document.html')
  const html = Buffer.from(file?.base64 ?? '', 'base64').toString('utf8')
  assert.match(html, /<html lang="zh-CN">/)
})

test('json-tree renders structure', async () => {
  const result = await execute('json-tree', {
    input: '{"name":"app","tags":["a","b"],"empty":{},"raw":null}'
  })
  assert.equal(result.ok, true)
  const text = result.text ?? ''
  assert.match(text, /object\{4\}/)
  assert.match(text, /name: string "app"/)
  assert.match(text, /tags: array\(2\)/)
  assert.match(text, /└─ 1: string "b"/)
  assert.match(text, /empty: object\{0\}/)
  assert.match(text, /raw: null/)

  const bad = await execute('json-tree', { input: 'nope' })
  assert.equal(bad.ok, false)
})

test('base64 handles unicode and rejects invalid input', async () => {
  const encoded = await execute('base64', { input: '世界 🛠', mode: 'encode' })
  assert.equal(encoded.ok, true)
  const decoded = await execute('base64', { input: encoded.text ?? '', mode: 'decode' })
  assert.equal(decoded.ok, true)
  assert.equal(decoded.text, '世界 🛠')

  const bad = await execute('base64', { input: '****not base64****', mode: 'decode' })
  assert.equal(bad.ok, false)
  const short = await execute('base64', { input: 'abcde', mode: 'decode' })
  assert.equal(short.ok, false)
})

test('url-codec round-trips and rejects broken escapes', async () => {
  const encoded = await execute('url-codec', { input: 'https://a.b/c?q=你好 x', mode: 'encode' })
  assert.equal(encoded.ok, true)
  assert.equal(encoded.text?.includes(' '), false)
  const decoded = await execute('url-codec', { input: encoded.text ?? '', mode: 'decode' })
  assert.equal(decoded.text, 'https://a.b/c?q=你好 x')

  const full = await execute('url-codec', {
    input: 'https://a.b/c?q=你好',
    mode: 'encode',
    kind: 'full'
  })
  assert.match(full.text ?? '', /^https:\/\/a\.b\/c\?q=%/)

  const bad = await execute('url-codec', { input: '%E0%A4', mode: 'decode' })
  assert.equal(bad.ok, false)
})

test('hash matches known digests and accepts empty input', async () => {
  const sha = await execute('hash', { input: 'abc', algorithm: 'sha256' })
  assert.equal(sha.text, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')

  const upper = await execute('hash', { input: '', algorithm: 'md5', uppercase: true })
  assert.equal(upper.ok, true)
  assert.equal(upper.text, 'D41D8CD98F00B204E9800998ECF8427E')

  const emptyFile = await execute('hash', {
    algorithm: 'md5',
    file: { name: 'empty.bin', mime: 'application/octet-stream', base64: '' }
  })
  assert.equal(emptyFile.ok, true)
  assert.equal(emptyFile.text, 'd41d8cd98f00b204e9800998ecf8427e')

  const missing = await execute('hash', { algorithm: 'sha256' })
  assert.equal(missing.ok, false)
})

test('radix converts negatives and rejects illegal digits', async () => {
  const hex = await execute('radix', { input: '-255', from: '10', to: '16' })
  assert.equal(hex.ok, true)
  assert.equal(hex.text, '-ff')

  const binary = await execute('radix', { input: 'ff', from: '16', to: '2' })
  assert.equal(binary.text, '11111111')

  const back = await execute('radix', { input: '0o377', from: '8', to: '10' })
  assert.equal(back.text, '255')

  const bad = await execute('radix', { input: '10129', from: '2', to: '10' })
  assert.equal(bad.ok, false)
  assert.match(bad.error ?? '', /不是合法的 2 进制数字/)

  const mismatch = await execute('radix', { input: '0x10', from: '10', to: '2' })
  assert.equal(mismatch.ok, false)
})

test('color converts between hex, rgb and hsl', async () => {
  const fromHex = await execute('color', { input: '#4A90D9' })
  assert.equal(fromHex.ok, true)
  assert.match(fromHex.text ?? '', /HEX : #4a90d9/)
  assert.match(fromHex.text ?? '', /RGB : rgb\(74, 144, 217\)/)

  const fromRgb = await execute('color', { input: 'rgb(74, 144, 217)' })
  assert.equal(fromRgb.ok, true)
  assert.match(fromRgb.text ?? '', /HEX : #4a90d9/)

  const fromHsl = await execute('color', { input: 'hsl(210, 65%, 57%)' })
  assert.equal(fromHsl.ok, true)
  assert.match(fromHsl.text ?? '', /HEX : #4a91d9/)
  assert.match(fromHsl.text ?? '', /RGB : rgb\(74, 145, 217\)/)

  const bad = await execute('color', { input: 'not-a-color' })
  assert.equal(bad.ok, false)
})

test('linux-dictionary searches static entries only', async () => {
  const result = await execute('linux-dictionary', { query: 'tar' })
  assert.equal(result.ok, true)
  assert.match(result.text ?? '', /^tar — /)
  const data = result.data as { total: number; matched: number }
  assert.ok(data.total > 20)

  const none = await execute('linux-dictionary', { query: 'zzzz-no-such-command' })
  assert.equal(none.ok, false)
})

test('unknown tool id fails cleanly', async () => {
  const result = await execute('nope', {})
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /未知工具/)
})

test('missing input is reported instead of throwing', async () => {
  for (const [id, args] of [
    ['json-format', {}],
    ['code-format', {}],
    ['hash', {}],
    ['base64', {}],
    ['cron', { expression: '  ' }],
    ['color', {}]
  ] as [string, Record<string, unknown>][]) {
    const result = await execute(id, args)
    assert.equal(result.ok, false, `${id} should fail on empty input`)
  }
})

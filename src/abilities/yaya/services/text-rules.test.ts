import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyTextRule,
  applyTextRules,
  checkTextRule,
  compileRule,
  parseTextRules,
  type TextRule
} from './text-rules'

test('解析：字段缺省与脏数据', () => {
  assert.deepEqual(parseTextRules(''), [])
  assert.deepEqual(parseTextRules('not json'), [])
  assert.deepEqual(parseTextRules('{"a":1}'), [])
  assert.deepEqual(parseTextRules('[1, null, {"noPattern":true}]'), [])
  const rules = parseTextRules(
    JSON.stringify([
      { pattern: 'a', replacement: 'b' },
      { pattern: 'c', replacement: 'd', target: 'user', mode: 'raw', format: 'html', flags: 'i' },
      { pattern: '', replacement: 'x' },
      {
        pattern: 'e',
        replacement: 'f',
        target: 'nope',
        mode: 'weird',
        format: 'zzz',
        enabled: false
      }
    ])
  )
  assert.equal(rules.length, 3)
  assert.deepEqual(rules[0], {
    id: undefined,
    enabled: true,
    pattern: 'a',
    flags: undefined,
    replacement: 'b',
    target: 'ai',
    mode: 'visual',
    format: 'regex'
  })
  assert.equal(rules[1].target, 'user')
  assert.equal(rules[1].mode, 'raw')
  assert.equal(rules[1].format, 'html')
  // 非法枚举值回落到默认
  assert.equal(rules[2].target, 'ai')
  assert.equal(rules[2].mode, 'visual')
  assert.equal(rules[2].format, 'regex')
  assert.equal(rules[2].enabled, false)
})

test('编译与校验：缺省补 g、非法正则不抛', () => {
  assert.ok(compileRule({ pattern: 'a', replacement: '' })?.global)
  assert.ok(compileRule({ pattern: 'a', flags: 'gi', replacement: '' })?.global)
  assert.equal(compileRule({ pattern: '(', replacement: '' }), null)
  assert.equal(checkTextRule({ pattern: '', replacement: '' }), 'pattern 不能为空')
  assert.notEqual(checkTextRule({ pattern: '(', replacement: '' }), null)
  assert.notEqual(checkTextRule({ pattern: 'a', replacement: 'x$y' }), null)
  assert.equal(checkTextRule({ pattern: 'a', replacement: 'x$1$$' }), null)
})

test('执行：全局替换 + $1 / $& / $$', () => {
  assert.equal(applyTextRule({ pattern: '(h)(i)', replacement: '$2-$1' }, 'hi hi'), 'i-h i-h')
  assert.equal(applyTextRule({ pattern: 'cat', replacement: '[$&]' }, 'cat cat'), '[cat] [cat]')
  assert.equal(applyTextRule({ pattern: 'a', replacement: '$$' }, 'aaa'), '$$$')
  assert.equal(applyTextRule({ pattern: 'x', replacement: 'y' }, 'zzz'), 'zzz')
  // 非法正则原样返回
  assert.equal(applyTextRule({ pattern: '(', replacement: 'y' }, 'ab'), 'ab')
  // 空匹配不自旋
  assert.equal(applyTextRule({ pattern: 'x*', replacement: '-' }, 'ab'), '-a-b-')
})

test('html 规则：模板原样、捕获内容转义（模型文本不能借模板注入）', () => {
  const rule: TextRule = {
    pattern: '<b>(.*?)</b>',
    replacement: '<span class="hl">$1</span>',
    format: 'html'
  }
  assert.equal(applyTextRule(rule, 'x <b>hi</b> y'), 'x <span class="hl">hi</span> y')
  const evil = applyTextRule(rule, 'x <b><script>alert(1)</script></b>')
  assert.ok(!evil.includes('<script>'))
  assert.ok(evil.includes('&lt;script&gt;'))
  // 同一条规则在 regex 模式下不转义（用户侧纯文本）
  assert.equal(
    applyTextRule({ ...rule, format: 'regex' }, 'x <b>a&b</b>'),
    'x <span class="hl">a&b</span>'
  )
})

test('筛选：target / mode / enabled / 用户侧跳过 html', () => {
  const rules: TextRule[] = [
    { pattern: '1', replacement: 'A', target: 'user', mode: 'visual' },
    { pattern: '2', replacement: 'B', target: 'ai', mode: 'visual' },
    { pattern: '3', replacement: 'C', target: 'both', mode: 'raw' },
    { pattern: '4', replacement: 'D', target: 'user', mode: 'visual', format: 'html' },
    { pattern: '5', replacement: 'E', target: 'ai', mode: 'visual', enabled: false }
  ]
  const run = (side: 'user' | 'ai', mode: 'visual' | 'raw', text: string): string =>
    applyTextRules(text, rules, { side, mode })
  // 用户 + 仅视觉：只有第 1 条（第 4 条是 html → 用户侧跳过；第5条关着）
  assert.equal(run('user', 'visual', '12345'), 'A2345')
  // AI + 仅视觉：第 2 条
  assert.equal(run('ai', 'visual', '12345'), '1B345')
  // 原始模式：只有第 3 条（两边都算）
  assert.equal(run('user', 'raw', '12345'), '12C45')
  assert.equal(run('ai', 'raw', '12345'), '12C45')
  // 依次执行（同一侧多条按顺序叠加）
  const two: TextRule[] = [
    { pattern: 'a', replacement: 'b' },
    { pattern: 'b', replacement: 'c' }
  ]
  assert.equal(applyTextRules('a', two, { side: 'ai', mode: 'visual' }), 'c')
})

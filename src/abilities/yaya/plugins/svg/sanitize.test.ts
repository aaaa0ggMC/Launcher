import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeElement, sanitizeSvg, type SanitizeElement, type SvgDom } from './sanitize'

// --------------------------------------------------------------------------
// 测试用的最小 DOM：够 sanitize 用（标签 + 属性 + 子节点 + remove），
// 附带一个只处理测试用例结构的极简 XML 文本解析 + 序列化。
// 不引入 jsdom / xmldom 等任何依赖。
// --------------------------------------------------------------------------

interface TestNode {
  tag: string
  attrs: Record<string, string>
  children: TestNode[]
  parent: TestNode | null
}

function node(
  tag: string,
  attrs: Record<string, string> = {},
  children: TestNode[] = []
): TestNode {
  const n: TestNode = { tag, attrs, children, parent: null }
  for (const c of children) c.parent = n
  return n
}

function collect(n: TestNode, out: TestNode[] = []): TestNode[] {
  for (const c of n.children) {
    out.push(c)
    collect(c, out)
  }
  return out
}

function wrap(n: TestNode): SanitizeElement {
  return {
    get tag() {
      return n.tag
    },
    attributeNames: () => Object.keys(n.attrs),
    getAttribute: (name) => n.attrs[name] ?? null,
    removeAttribute: (name) => {
      delete n.attrs[name]
    },
    descendants: () => collect(n).map(wrap),
    remove: () => {
      if (!n.parent) return
      const i = n.parent.children.indexOf(n)
      if (i >= 0) n.parent.children.splice(i, 1)
      n.parent = null
    }
  }
}

function serialize(n: TestNode): string {
  const attrs = Object.entries(n.attrs)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join('')
  const inner = n.children.map(serialize).join('')
  return `<${n.tag}${attrs}>${inner}</${n.tag}>`
}

/** 极简 XML 解析：只处理测试用例里出现的结构（标签 / 属性 / 自闭合 / 文本忽略） */
const TOKEN_RE = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)\s*|[^<]+/g

function parseXml(text: string): TestNode {
  const doc = node('#document')
  const stack: TestNode[] = [doc]
  TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m[2] === undefined) continue // 文本节点（用例里不用）
    const [, closing, tag, attrText, selfClose] = m
    if (closing) {
      if (stack.length > 1) stack.pop()
      continue
    }
    const attrs: Record<string, string> = {}
    for (const am of attrText.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[am[1]] = am[2]
    const el = node(tag.toLowerCase(), attrs)
    el.parent = stack[stack.length - 1]
    stack[stack.length - 1].children.push(el)
    if (!selfClose) stack.push(el)
  }
  return doc
}

function testDom(): SvgDom {
  const roots = new WeakMap<SanitizeElement, TestNode>()
  return {
    parse(text) {
      const first = parseXml(text).children[0] ?? null
      if (!first || first.tag !== 'svg') return null
      const wrapped = wrap(first)
      roots.set(wrapped, first)
      return wrapped
    },
    serialize(root) {
      const n = roots.get(root)
      return n ? serialize(n) : ''
    }
  }
}

// --------------------------------------------------------------------------
// sanitizeElement（纯规则，手写树）
// --------------------------------------------------------------------------

describe('sanitizeElement', () => {
  it('drops script and foreignObject subtrees', () => {
    const root = node('svg', {}, [
      node('script', { type: 'text/javascript' }, [node('rect', {})]),
      node('foreignObject', { width: '100' }, [node('div', {})]),
      node('rect', { width: '10' })
    ])
    sanitizeElement(wrap(root))
    assert.deepEqual(
      root.children.map((c) => c.tag),
      ['rect']
    )
  })

  it('removes every on* attribute and keeps the rest', () => {
    const root = node('svg', {}, [
      node('rect', { width: '10', onclick: 'alert(1)', onload: 'x()', fill: 'red' })
    ])
    sanitizeElement(wrap(root))
    assert.deepEqual(root.children[0].attrs, { width: '10', fill: 'red' })
  })

  it('keeps # references but strips external href / xlink:href', () => {
    const root = node('svg', {}, [
      node('use', { 'xlink:href': '#icon-a' }),
      node('image', { href: 'https://evil.example/x.png' }),
      node('a', { 'xlink:href': 'http://evil.example/' }),
      node('image', { href: 'data:image/png;base64,AAAA' })
    ])
    sanitizeElement(wrap(root))
    assert.deepEqual(root.children[0].attrs, { 'xlink:href': '#icon-a' })
    assert.deepEqual(root.children[1].attrs, {})
    assert.deepEqual(root.children[2].attrs, {})
    assert.deepEqual(root.children[3].attrs, {})
  })

  it('handles nested subtrees and mixed-case tags / attributes', () => {
    const root = node('svg', {}, [
      node('g', {}, [
        node('SCRIPT', {}, [node('rect', {})]),
        node('circle', { OnClick: 'x()', r: '2' })
      ])
    ])
    sanitizeElement(wrap(root))
    const g = root.children[0]
    assert.deepEqual(
      g.children.map((c) => c.tag),
      ['circle']
    )
    assert.deepEqual(g.children[0].attrs, { r: '2' })
  })
})

// --------------------------------------------------------------------------
// sanitizeSvg（字符串进、字符串出）
// --------------------------------------------------------------------------

describe('sanitizeSvg', () => {
  const dom = testDom()

  it('round-trips a clean svg unchanged (modulo attribute order)', () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>',
      dom
    )
    assert.equal(out, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>')
  })

  it('strips script / handlers / external refs end to end', () => {
    const src =
      '<svg viewBox="0 0 10 10">' +
      '<script>alert(1)</script>' +
      '<rect width="10" height="10" onclick="steal()" fill="#00f"/>' +
      '<use href="#a"/>' +
      '<image href="https://evil.example/x.png"/>' +
      '<foreignObject><body onload="boom()"/></foreignObject>' +
      '</svg>'
    const out = sanitizeSvg(src, dom) ?? ''
    assert.ok(!out.includes('script'))
    assert.ok(!out.includes('alert'))
    assert.ok(!out.includes('onclick'))
    assert.ok(!out.includes('foreignObject'))
    assert.ok(!out.includes('evil.example'))
    assert.ok(out.includes('fill="#00f"'))
    assert.ok(out.includes('href="#a"'))
  })

  it('returns null when the root is not svg / input is not xml', () => {
    assert.equal(sanitizeSvg('<html><body>hi</body></html>', dom), null)
    assert.equal(sanitizeSvg('not svg at all', dom), null)
    assert.equal(sanitizeSvg('', dom), null)
  })
})

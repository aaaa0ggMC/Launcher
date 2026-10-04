import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import MarkdownIt from 'markdown-it'
import { mathPlugin } from './markdown-math'

const md = new MarkdownIt({ html: false })
mathPlugin(md, (tex, display) => `[${display ? 'D' : 'I'}:${tex}]`)
const r = (s: string): string => md.render(s).trim()

describe('mathPlugin', () => {
  it('renders inline $…$ and \\(…\\)', () => {
    assert.equal(r('a $x^2$ b'), '<p>a [I:x^2] b</p>')
    assert.equal(r('a \\(\\frac{1}{2}\\) b'), '<p>a [I:\\frac{1}{2}] b</p>')
  })
  it('renders display blocks $$…$$ and \\[…\\], single and multi line', () => {
    assert.equal(r('$$E=mc^2$$'), '<div class="md-math-display">[D:E=mc^2]</div>')
    assert.equal(r('\\[\na+b\n\\]'), '<div class="md-math-display">[D:a+b]</div>')
    assert.equal(r('$$\n\\sum_i x_i\n$$'), '<div class="md-math-display">[D:\\sum_i x_i]</div>')
  })
  it('renders display math inside a paragraph', () => {
    assert.equal(
      r('see \\[x\\] here'),
      '<p>see <span class="md-math-display">[D:x]</span> here</p>'
    )
  })
  it('does not treat prices or spaced dollars as math', () => {
    assert.equal(r('costs $5 and $10'), '<p>costs $5 and $10</p>')
    assert.equal(r('echo $HOME and $ PATH $'), '<p>echo $HOME and $ PATH $</p>')
  })
  it('keeps escaped dollars and code spans literal', () => {
    assert.equal(r('\\$x$'), '<p>$x$</p>')
    assert.equal(r('`$x$`'), '<p><code>$x$</code></p>')
  })
})

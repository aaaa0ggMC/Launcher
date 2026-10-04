import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { argFields, resultFields } from './tool-view'

describe('argFields', () => {
  it('shows shell commands as highlighted code, not escaped JSON', () => {
    const f = argFields({ command: 'echo "hi" | head -n1', timeoutMs: 3000 })
    assert.deepEqual(f[0], {
      key: 'command',
      kind: 'code',
      lang: 'bash',
      value: 'echo "hi" | head -n1'
    })
    assert.deepEqual(f[1], { key: 'timeoutMs', kind: 'inline', value: '3000' })
  })
  it('parses JSON-string args and keeps long text as blocks', () => {
    const f = argFields(JSON.stringify({ path: '/tmp/a', content: 'x\ny' }))
    assert.equal(f[0].kind, 'inline')
    assert.equal(f[1].kind, 'block')
  })
  it('falls back to JSON for nested values and raw strings', () => {
    assert.equal(argFields({ args: { a: 1 } })[0].kind, 'json')
    assert.deepEqual(argFields('not json'), [{ key: '', kind: 'inline', value: 'not json' }])
    assert.deepEqual(argFields({}), [])
  })
})

describe('resultFields', () => {
  it('splits run_bash output into status line + stdout / stderr blocks', () => {
    const f = resultFields({
      ok: false,
      exitCode: 1,
      stdout: 'out',
      stderr: 'boom',
      error: 'failed'
    })
    assert.deepEqual(
      f.map((x) => [x.key, x.kind, !!x.danger]),
      [
        ['ok', 'inline', false],
        ['exitCode', 'inline', false],
        ['error', 'inline', true],
        ['stdout', 'block', false],
        ['stderr', 'block', true]
      ]
    )
  })
  it('skips empty bodies and handles small / complex objects', () => {
    assert.deepEqual(
      resultFields({ ok: true, stdout: 'x', stderr: '' }).map((x) => x.key),
      ['ok', 'stdout']
    )
    assert.equal(resultFields({ iso: 't', tz: 'UTC' })[0].kind, 'inline')
    assert.equal(resultFields({ data: { nested: [1, 2] } })[0].kind, 'json')
    assert.deepEqual(resultFields(null), [])
  })
})

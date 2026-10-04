import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { McpServerConfig } from '../../../types'
import {
  connectionSignature,
  convertCallToolResult,
  namespaceOf,
  normalizeTools,
  plainHeaders,
  redactSecrets,
  safeUrl,
  sameConnectionConfig,
  sanitizeServerId,
  sanitizeToolName
} from './client'

function server(partial: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'demo',
    name: 'Demo',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    headers: {},
    enabled: true,
    ...partial
  }
}

describe('safeUrl', () => {
  it('accepts http / https and rejects everything else', () => {
    assert.equal(safeUrl('https://a.example/mcp').protocol, 'https:')
    assert.equal(safeUrl('http://127.0.0.1:8000/mcp').protocol, 'http:')
    assert.throws(() => safeUrl('file:///etc/passwd'), /unsupported url scheme/)
    assert.throws(() => safeUrl('javascript:alert(1)'), /unsupported url scheme/)
    assert.throws(() => safeUrl('not a url'), /invalid url/)
    assert.throws(() => safeUrl(''), /invalid url/)
  })
})

describe('plainHeaders', () => {
  it('drops empty values, invalid names and values with control characters', () => {
    const out = plainHeaders({
      Authorization: 'Bearer t0ken',
      'X-Api-Key': '',
      'Bad Name': 'x',
      'X-NL': 'a\r\nInjected: 1',
      'X-Ok': 'v1'
    })
    assert.deepEqual(out, { Authorization: 'Bearer t0ken', 'X-Ok': 'v1' })
  })

  it('keeps undefined / null safe', () => {
    assert.deepEqual(plainHeaders(undefined), {})
  })
})

describe('redactSecrets', () => {
  it('replaces header values with «redacted» including short credentials', () => {
    const text = 'fetch failed for https://x.dev with header Bearer sup3r-secret and ab'
    assert.equal(
      redactSecrets(text, ['sup3r-secret']),
      'fetch failed for https://x.dev with header Bearer «redacted» and ab'
    )
    assert.equal(redactSecrets('code abc here', ['abc']), 'code «redacted» here')
    assert.equal(redactSecrets('nothing', ['', 'x']), 'nothing')
  })
})

describe('sanitizeServerId / namespaceOf', () => {
  it('keeps plugin ids in [a-z0-9-] and namespaces in [a-z0-9_]', () => {
    assert.equal(sanitizeServerId('My Server'), 'my-server')
    assert.equal(sanitizeServerId('__Weird__ID__'), 'weird-id')
    assert.equal(sanitizeServerId('--'), 'server')
    assert.equal(sanitizeServerId(''), 'server')
    assert.equal(namespaceOf('My Server'), 'mcp_my_server')
  })
})

describe('sanitizeToolName', () => {
  it('replaces illegal characters and keeps the rest', () => {
    assert.equal(sanitizeToolName('read.file'), 'read_file')
    assert.equal(sanitizeToolName('search repo'), 'search_repo')
    assert.equal(sanitizeToolName('get/thing'), 'get_thing')
    assert.equal(sanitizeToolName('  '), 'tool')
    // 连字符保留（插件 id 规则允许 `-`；wire name 由注册表统一 sanitize）
    assert.equal(sanitizeToolName('a--b'), 'a--b')
  })
})

describe('connectionSignature / sameConnectionConfig', () => {
  it('is stable for the same config and ignores header name case / order', () => {
    const a = server({ headers: { Authorization: 'Bearer x', 'X-Api-Key': 'k' } })
    const b = server({ headers: { 'x-api-key': 'k', authorization: 'Bearer x' } })
    assert.equal(sameConnectionConfig(a, b), true)
    assert.equal(connectionSignature(a), connectionSignature(b))
  })

  it('changes when any connection-relevant field changes', () => {
    const base = server()
    assert.equal(sameConnectionConfig(base, server({ url: 'https://other.dev/mcp' })), false)
    assert.equal(sameConnectionConfig(base, server({ transport: 'sse' })), false)
    assert.equal(sameConnectionConfig(base, server({ timeoutMs: 1000 })), false)
    assert.equal(sameConnectionConfig(base, server({ headers: { Authorization: 'x' } })), false)
  })

  it('ignores fields that do not affect the connection', () => {
    const base = server()
    assert.equal(sameConnectionConfig(base, server({ name: 'Renamed' })), true)
    assert.equal(sameConnectionConfig(base, server({ enabled: false })), true)
    assert.equal(sameConnectionConfig(base, server({ headersSet: ['Authorization'] })), true)
  })
})

describe('convertCallToolResult', () => {
  it('maps text and image parts', () => {
    const out = convertCallToolResult({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'QUJD', mimeType: 'image/png' }
      ]
    })
    assert.deepEqual(out.content, [
      { type: 'text', text: 'hello' },
      { type: 'image', mimeType: 'image/png', data: 'QUJD' }
    ])
    assert.equal(out.isError, false)
    assert.equal(out.display, undefined)
  })

  it('degrades audio / blob resources / resource links to text placeholders', () => {
    const out = convertCallToolResult({
      content: [
        { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
        {
          type: 'resource',
          resource: { uri: 'file:///a.bin', blob: 'ZZZ', mimeType: 'application/zip' }
        },
        { type: 'resource_link', name: 'readme', uri: 'https://x.dev/readme.md' },
        { type: 'unknown', payload: 1 }
      ]
    })
    assert.deepEqual(
      out.content.map((p) => (p.type === 'text' ? p.text : p.type)),
      [
        '[audio: audio/wav]',
        '[resource: file:///a.bin (application/zip)]',
        '[link: readme https://x.dev/readme.md]',
        '{\n  "type": "unknown",\n  "payload": 1\n}'
      ]
    )
  })

  it('keeps embedded resource text and passes isError through', () => {
    const out = convertCallToolResult({
      content: [{ type: 'resource', resource: { uri: 'file:///a.txt', text: 'body' } }],
      isError: true
    })
    assert.deepEqual(out.content, [{ type: 'text', text: 'body' }])
    assert.equal(out.isError, true)
  })

  it('puts structuredContent in display, and in a text part when content is empty', () => {
    const withContent = convertCallToolResult({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { rows: 2 }
    })
    assert.deepEqual(withContent.content, [{ type: 'text', text: 'ok' }])
    assert.deepEqual(withContent.display, { rows: 2 })

    const onlyStructured = convertCallToolResult({ content: [], structuredContent: { rows: 2 } })
    assert.deepEqual(onlyStructured.content, [
      { type: 'text', text: JSON.stringify({ rows: 2 }, null, 2) }
    ])
    assert.deepEqual(onlyStructured.display, { rows: 2 })

    const taskVariant = convertCallToolResult({ toolResult: { ok: true } })
    assert.deepEqual(taskVariant.content, [
      { type: 'text', text: JSON.stringify({ ok: true }, null, 2) }
    ])
  })

  it('survives garbage input', () => {
    const out = convertCallToolResult({})
    assert.deepEqual(out.content, [])
    assert.equal(out.isError, false)
  })
})

describe('normalizeTools', () => {
  it('sanitizes names, keeps the raw name and defaults the schema / approval', () => {
    const specs = normalizeTools(
      [
        {
          name: 'read.file',
          description: ' read ',
          inputSchema: { type: 'object', properties: { p: {} } }
        },
        { name: 'do.write', annotations: { readOnlyHint: true } },
        { name: 'do/write', description: 'dup' },
        { name: '' }
      ] as never,
      1234
    )
    assert.deepEqual(
      specs.map((s) => [s.name, s.rawName, s.approval, s.timeoutMs]),
      [
        ['read_file', 'read.file', 'ask', 1234],
        ['do_write', 'do.write', 'auto', 1234]
      ]
    )
    assert.deepEqual(specs[0].parameters, { type: 'object', properties: { p: {} } })
    assert.deepEqual(specs[1].parameters, { type: 'object', properties: {} })
    assert.equal(specs[0].description, 'read')
  })
})

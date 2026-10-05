import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeConfigSnapshot } from './config-sync'

test('remote MCP additions appear while a local server toggle remains unsaved', () => {
  const base = { mcpServers: [{ id: 'a', name: 'A', enabled: false }], assistantName: 'Agent' }
  const local = { ...base, mcpServers: [{ ...base.mcpServers[0], enabled: true }] }
  const remote = {
    ...base,
    assistantName: 'Updated',
    mcpServers: [...base.mcpServers, { id: 'b', name: 'B', enabled: true }]
  }
  assert.deepEqual(mergeConfigSnapshot(base, local, remote), {
    assistantName: 'Updated',
    mcpServers: [
      { id: 'a', name: 'A', enabled: true },
      { id: 'b', name: 'B', enabled: true }
    ]
  })
  assert.equal(base.mcpServers[0].enabled, false)
})
test('server edits merge field by field and unchanged remote deletions stay deleted', () => {
  const base = {
    mcpServers: [
      { id: 'a', name: 'A', enabled: false },
      { id: 'b', name: 'B', enabled: true }
    ]
  }
  const local = { mcpServers: [{ ...base.mcpServers[0], enabled: true }, base.mcpServers[1]] }
  const remote = { mcpServers: [{ ...base.mcpServers[0], name: 'Renamed' }] }
  assert.deepEqual(mergeConfigSnapshot(base, local, remote), {
    mcpServers: [{ id: 'a', name: 'Renamed', enabled: true }]
  })
})
test('local deletions and overrides survive a concurrent remote refresh', () => {
  const base = {
    mcpServers: [{ id: 'a', enabled: false }],
    pluginEnabled: { one: true, two: true } as Record<string, boolean>
  }
  const local = { mcpServers: [], pluginEnabled: { two: false } }
  const remote = {
    mcpServers: [{ id: 'a', enabled: true }],
    pluginEnabled: { one: true, two: true, three: true }
  }
  assert.deepEqual(mergeConfigSnapshot(base, local, remote), {
    mcpServers: [],
    pluginEnabled: { two: false, three: true }
  })
})
test('save acknowledgement clears submitted secrets but preserves newer input', () => {
  const submitted = { providers: [{ id: 'p', apiKey: 'fake-test-value', name: 'Provider' }] }
  const remote = { providers: [{ id: 'p', apiKey: '', name: 'Provider', apiKeySet: true }] }
  assert.deepEqual(mergeConfigSnapshot(submitted, submitted, remote), remote)
  const newer = { providers: [{ ...submitted.providers[0], apiKey: 'new-fake-test-value' }] }
  assert.equal(
    mergeConfigSnapshot(submitted, newer, remote).providers[0].apiKey,
    'new-fake-test-value'
  )
})

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserUiRequest } from './browser-ui'

const home = mkdtempSync('/tmp/yaya-browser-ui-test-')
process.env.HOME = home
process.env.XDG_CONFIG_HOME = join(home, '.config')
if (!home.startsWith('/tmp/')) throw new Error('isolated HOME required')

let bridge: typeof import('./browser-ui')
let privacy: typeof import('./privacy')
before(async () => {
  bridge = await import('./browser-ui')
  privacy = await import('./privacy')
})
const agent = { kind: 'local-agent', session: 'browser-test-agent' } as const
const asBrowser = <T>(id: string, fn: () => T): T =>
  bridge.withBrowserClient(id, () => privacy.withOrigin(agent, fn))

test('browser UI routes only to the originating client and validates reply correlation', async () => {
  let request: BrowserUiRequest | undefined
  let otherCalls = 0
  assert.equal(
    bridge.registerBrowserClient('test-a', (channel, args) => {
      if (channel === bridge.BROWSER_UI_CHANNEL) request = args[0] as BrowserUiRequest
    }),
    true
  )
  assert.equal(
    bridge.registerBrowserClient('test-a', () => {}),
    false
  )
  bridge.registerBrowserClient('test-b', () => {
    otherCalls++
  })
  try {
    const result = asBrowser('test-a', () => bridge.browserUiCall({ method: 'snapshot' }))
    assert.ok(request)
    assert.equal(otherCalls, 0)
    assert.equal(
      bridge.submitBrowserUiReply({ id: request.id, clientId: 'test-b', ok: true }).ok,
      false
    )
    assert.equal(
      bridge.submitBrowserUiReply({
        id: request.id,
        clientId: 'test-a',
        ok: true,
        result: 'masked'
      }).ok,
      true
    )
    assert.deepEqual(await result, { ok: true, result: 'masked' })
    assert.equal(
      bridge.submitBrowserUiReply({ id: request.id, clientId: 'test-a', ok: true }).ok,
      false
    )
  } finally {
    bridge.unregisterBrowserClient('test-a')
    bridge.unregisterBrowserClient('test-b')
  }
})

test('missing context and remote callers cannot fall back to another connected tab', () => {
  bridge.registerBrowserClient('test-a', () => {})
  try {
    for (const kind of ['cli', 'mcp', 'remote', 'script-agent', 'agent-ui'] as const) {
      assert.throws(
        () =>
          bridge.withBrowserClient('test-a', () =>
            privacy.withOrigin({ kind, session: 'other' }, () => bridge.browserUiTarget())
          ),
        /YAYA/
      )
    }
    assert.throws(() => privacy.withOrigin(agent, () => bridge.browserUiTarget()), /浏览器/)
    assert.throws(() => asBrowser('missing', () => bridge.browserUiTarget()), /断开/)
  } finally {
    bridge.unregisterBrowserClient('test-a')
  }
})

test('disconnect rejects pending requests and stale replies cannot revive them', async () => {
  let request: BrowserUiRequest | undefined
  bridge.registerBrowserClient('test-a', (channel, args) => {
    if (channel === bridge.BROWSER_UI_CHANNEL) request = args[0] as BrowserUiRequest
  })
  const result = asBrowser('test-a', () => bridge.browserUiCall({ method: 'snapshot' }))
  bridge.unregisterBrowserClient('test-a')
  await assert.rejects(result, { code: 'browser_disconnected' })
  assert.equal(
    bridge.submitBrowserUiReply({ id: request!.id, clientId: 'test-a', ok: true }).ok,
    false
  )
})

test('denied privacy precheck never replays the action', async () => {
  privacy.__resetPrivacyState()
  privacy.definePrivacyScopes('browser-test', { private: { level: 'sensitive' } })
  privacy.setConsentPresenter((requests) => {
    if (requests.length) privacy.decideConsent(requests[0].id, 'deny')
  })
  let calls = 0
  bridge.registerBrowserClient('test-a', (channel, args) => {
    if (channel !== bridge.BROWSER_UI_CHANNEL) return
    calls++
    const request = args[0] as BrowserUiRequest
    bridge.submitBrowserUiReply({
      clientId: 'test-a',
      id: request.id,
      ok: false,
      code: 'clearance_required',
      scopes: ['browser-test.private'],
      token: 'target'
    })
  })
  try {
    await assert.rejects(
      asBrowser('test-a', () => bridge.browserUiGuardedCall({ method: 'click', action: 'click' })),
      { code: 'privacy_denied' }
    )
    assert.equal(calls, 1)
  } finally {
    bridge.unregisterBrowserClient('test-a')
    privacy.__resetPrivacyState()
  }
})

test('abort cancels pending page work and a late approval cannot execute a stopped action', async () => {
  privacy.__resetPrivacyState()
  privacy.definePrivacyScopes('browser-cancel', { private: { level: 'sensitive' } })
  const controller = new AbortController()
  const channels: string[] = []
  bridge.registerBrowserClient('test-a', (channel) => {
    channels.push(channel)
  })
  const request = bridge.withBrowserClient(
    'test-a',
    () => privacy.withOrigin(agent, () => bridge.browserUiCall({ method: 'click' })),
    controller.signal
  )
  controller.abort()
  await assert.rejects(request, { name: 'AbortError' })
  assert.ok(channels.includes('cockpit:browser-ui-cancel'))
  bridge.unregisterBrowserClient('test-a')

  const next = new AbortController()
  let calls = 0
  let consentId = ''
  privacy.setConsentPresenter((requests) => {
    consentId = requests[0]?.id ?? consentId
  })
  bridge.registerBrowserClient('test-a', (channel, args) => {
    if (channel !== bridge.BROWSER_UI_CHANNEL) return
    calls++
    const request = args[0] as BrowserUiRequest
    bridge.submitBrowserUiReply({
      clientId: 'test-a',
      id: request.id,
      ok: false,
      code: 'clearance_required',
      scopes: ['browser-cancel.private'],
      token: 'target'
    })
  })
  try {
    const action = bridge.withBrowserClient(
      'test-a',
      () =>
        privacy.withOrigin(agent, () =>
          bridge.browserUiGuardedCall({ method: 'click', action: 'click' })
        ),
      next.signal
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.ok(consentId)
    next.abort()
    privacy.decideConsent(consentId, 'once')
    await assert.rejects(action, { name: 'AbortError' })
    assert.equal(calls, 1)
  } finally {
    bridge.unregisterBrowserClient('test-a')
    privacy.__resetPrivacyState()
  }
})

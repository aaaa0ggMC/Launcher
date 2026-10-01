import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetPrivacyState,
  __setPrivacyClock,
  definePrivacyScopes,
  withOrigin,
  shield,
  secret,
  shieldFields,
  redactSecretKeys,
  hasClearance,
  guard,
  requestClearance,
  decideConsent,
  listPendingRequests,
  setConsentPresenter,
  setPrivacyPolicy,
  normalizePrivacyPolicy,
  noteSecretValue,
  scrubForAgent,
  revokeSessionGrants,
  clearanceInfo,
  collectRedactions,
  privacyNotice,
  PrivacyDeniedError,
  SCOPE_EXEC,
  SCOPE_CONTROL,
  ONCE_GRANT_MS,
  DENY_COOLDOWN_MS,
  type CallOrigin
} from './privacy'

const P = definePrivacyScopes('t', {
  id: { level: 'sensitive' },
  fans: { level: 'personal' },
  pub: { level: 'public' },
  key: { level: 'secret' }
})
const AGENT: CallOrigin = { kind: 'mcp', session: 's1', client: 'test' }
const asAgent = <T>(fn: () => T): T => withOrigin(AGENT, fn)

beforeEach(() => __resetPrivacyState())

test('non-agent origins see everything', () => {
  assert.equal(shield(P.id, 'U2025'), 'U2025')
  assert.equal(secret('pw'), 'pw')
  assert.equal(
    withOrigin({ kind: 'cli' }, () => shield(P.id, 'U2025')),
    'U2025'
  )
  assert.equal(
    withOrigin({ kind: 'script' }, () => secret('pw')),
    'pw'
  )
})

test('agent: sensitive redacted, personal/public visible, secret never', () => {
  asAgent(() => {
    assert.equal(shield(P.id, 'U2025'), '«redacted:t.id»')
    assert.equal(shield(P.id, 42), '«redacted:t.id»')
    assert.equal(shield(P.id, ''), '')
    assert.equal(shield(P.id, null), null)
    assert.equal(shield(P.fans, 1000), 1000)
    assert.equal(shield(P.pub, 'x'), 'x')
    assert.equal(secret('pw'), '«redacted:secret»')
    assert.equal(hasClearance(P.key), false)
    assert.equal(hasClearance('unknown.scope'), false)
  })
})

test('policy: personal=ask, alwaysAllow, alwaysAllowAll excludes exec', () => {
  setPrivacyPolicy(normalizePrivacyPolicy({ personal: 'ask', alwaysAllow: [P.id] }))
  asAgent(() => {
    assert.equal(shield(P.fans, 1), '«redacted:t.fans»')
    assert.equal(shield(P.id, 'U'), 'U')
  })
  setPrivacyPolicy(normalizePrivacyPolicy({ alwaysAllowAll: true, control: 'ask' }))
  asAgent(() => {
    assert.equal(hasClearance(P.id), true)
    assert.equal(hasClearance(SCOPE_CONTROL), true)
    assert.equal(hasClearance(SCOPE_EXEC), false)
    assert.equal(hasClearance(P.key), false)
  })
  setPrivacyPolicy(normalizePrivacyPolicy({}))
  asAgent(() => assert.equal(hasClearance(SCOPE_CONTROL), true))
})

test('shieldFields: nested + function resolver + objects replaced whole', () => {
  const data = {
    fields: [
      { label: '学号', value: 'U2025', sensitive: true },
      { label: '学院', value: 'CS' }
    ],
    card: { balance: 12.5 },
    password: 'pw'
  }
  const out = asAgent(() =>
    shieldFields(data, (k, _v, parent) => {
      if (k === 'value' && parent.sensitive) return P.id
      if (k === 'card') return P.id
      if (k === 'password') return 'secret'
      return null
    })
  )
  assert.deepEqual(out, {
    fields: [
      { label: '学号', value: '«redacted:t.id»', sensitive: true },
      { label: '学院', value: 'CS' }
    ],
    card: '«redacted:t.id»',
    password: '«redacted:secret»'
  })
  assert.equal(data.fields[0].value, 'U2025', 'input not mutated')
  assert.equal(shieldFields(data, { password: 'secret' }), data, 'ui origin returns input')
})

test('redactSecretKeys fallback', () => {
  const out = asAgent(() =>
    redactSecretKeys({ user: 'a', apiKey: 'sk-1', nested: { Cookie: 'c', token: '' } })
  )
  assert.deepEqual(out, {
    user: 'a',
    apiKey: '«redacted:secret»',
    nested: { Cookie: '«redacted:secret»', token: '' }
  })
})

test('scrubForAgent replaces known secret values in text', () => {
  noteSecretValue('hunter2-secret')
  noteSecretValue('abc') // too short, ignored
  const out = asAgent(() => scrubForAgent([{ message: 'login with hunter2-secret ok abc' }]))
  assert.deepEqual(out, [{ message: 'login with «redacted:secret» ok abc' }])
})

test('guard: once grant, expiry, session revoke', async () => {
  let t = 1_000_000
  __setPrivacyClock(() => t)
  let shown = 0
  setConsentPresenter((list) => {
    if (list.length) {
      shown++
      decideConsent(list[0].id, 'once')
    }
  })
  await asAgent(() => guard(P.id, 'need it'))
  assert.equal(shown, 1)
  asAgent(() => assert.equal(shield(P.id, 'U'), 'U'))
  // other session does not inherit a once grant
  withOrigin({ kind: 'mcp', session: 's2' }, () => assert.equal(hasClearance(P.id), false))
  t += ONCE_GRANT_MS + 1
  asAgent(() => assert.equal(hasClearance(P.id), false))
  t -= ONCE_GRANT_MS + 1
  revokeSessionGrants('s1')
  asAgent(() => assert.equal(hasClearance(P.id), false))
})

test('guard: session grant applies to every agent session', async () => {
  setConsentPresenter((list) => list.length && decideConsent(list[0].id, 'session'))
  await asAgent(() => guard(P.id))
  withOrigin({ kind: 'remote', session: 'other' }, () => assert.equal(hasClearance(P.id), true))
})

test('guard: deny throws, cooldown auto-denies without presenting', async () => {
  let t = 5_000_000
  __setPrivacyClock(() => t)
  let shown = 0
  setConsentPresenter((list) => {
    if (list.length) {
      shown++
      decideConsent(list[0].id, 'deny')
    }
  })
  await assert.rejects(
    asAgent(() => guard(P.id)),
    (e: unknown) => e instanceof PrivacyDeniedError && e.code === 'privacy_denied'
  )
  const r = await asAgent(() => requestClearance([P.id], 'again'))
  assert.equal(r.status, 'denied')
  assert.equal(shown, 1)
  t += DENY_COOLDOWN_MS + 1
  await assert.rejects(asAgent(() => guard(P.id)))
  assert.equal(shown, 2)
})

test('guard: secret scope throws immediately, no request', async () => {
  let shown = 0
  setConsentPresenter(() => shown++)
  await assert.rejects(
    asAgent(() => guard(P.key)),
    (e: unknown) => e instanceof PrivacyDeniedError && e.code === 'privacy_secret'
  )
  assert.equal(shown, 0)
})

test('requestClearance: waitMs → pending, request reused, later grant', async () => {
  const r1 = await asAgent(() => requestClearance([P.id, P.key], 'why', { waitMs: 10 }))
  assert.equal(r1.status, 'pending')
  assert.deepEqual(r1.refused, [P.key])
  const r2 = await asAgent(() => requestClearance([P.id], 'why', { waitMs: 10 }))
  assert.equal(r2.requestId, r1.requestId, 'same session + scopes → same request')
  assert.equal(listPendingRequests().length, 1)
  decideConsent(r1.requestId!, 'once')
  const r3 = await asAgent(() => requestClearance([P.id], 'why', { waitMs: 10 }))
  assert.equal(r3.status, 'granted')
  assert.deepEqual(r3.granted, [P.id])
})

test('decideConsent is a no-op for unknown ids', () => {
  assert.equal(decideConsent('nope', 'session'), false)
})

test('agent-ui: reads pass through (user UI), actions still guarded', async () => {
  const ui: CallOrigin = { kind: 'agent-ui', session: 's1' }
  withOrigin(ui, () => {
    assert.equal(shield(P.id, 'U2025'), 'U2025')
    assert.equal(secret('pw'), 'pw')
    assert.equal(hasClearance(P.id), false)
  })
  let shown = 0
  setConsentPresenter((list) => {
    if (list.length) {
      shown++
      decideConsent(list[0].id, 'deny')
    }
  })
  await assert.rejects(withOrigin(ui, () => guard(SCOPE_EXEC)))
  assert.equal(shown, 1)
})

test('guard: undecided within waitMs → privacy_pending, request kept, retry succeeds', async () => {
  await assert.rejects(
    asAgent(() => guard(P.id, 'slow user', { waitMs: 10 })),
    (e: unknown) => e instanceof PrivacyDeniedError && e.code === 'privacy_pending' && !!e.requestId
  )
  const [req] = listPendingRequests()
  assert.ok(req, 'request still pending')
  decideConsent(req.id, 'once')
  await asAgent(() => guard(P.id))
})

test('clearanceInfo: once grant has expiresAt; after expiry it reports expiredAt', async () => {
  let t = 1_000_000
  __setPrivacyClock(() => t)
  setConsentPresenter((list) => list.forEach((r) => decideConsent(r.id, 'once')))
  const res = await asAgent(() => requestClearance([P.id], 'need it'))
  assert.equal(res.status, 'granted')
  assert.deepEqual(res.grants, [
    { scope: P.id, held: true, via: 'once', expiresAt: t + ONCE_GRANT_MS }
  ])
  t += ONCE_GRANT_MS + 1
  const info = asAgent(() => clearanceInfo(P.id))
  assert.equal(info.held, false)
  assert.equal(info.expiredAt, 1_000_000 + ONCE_GRANT_MS)
  revokeSessionGrants('s1')
  assert.equal(asAgent(() => clearanceInfo(P.id)).expiredAt, undefined)
})

test('collectRedactions + privacyNotice: redaction is signalled, expiry flagged', async () => {
  let t = 5_000_000
  __setPrivacyClock(() => t)
  const clean = await asAgent(() => collectRedactions(async () => shield(P.fans, 1)))
  assert.deepEqual(clean.redacted, [])
  assert.equal(privacyNotice(clean.redacted), null)

  const r1 = await asAgent(() =>
    collectRedactions(async () => shieldFields({ a: 'x', b: { c: 1 } }, { a: P.id, b: P.id }))
  )
  assert.deepEqual(r1.redacted, [P.id])
  const n1 = asAgent(() => privacyNotice(r1.redacted))
  assert.deepEqual(n1?.expired, [])
  assert.deepEqual(n1?.requestable, [P.id])

  setConsentPresenter((list) => list.forEach((r) => decideConsent(r.id, 'once')))
  await asAgent(() => guard(P.id))
  assert.equal(
    asAgent(() => shield(P.id, 'U1')),
    'U1'
  )
  t += ONCE_GRANT_MS + 1
  const r2 = await asAgent(() => collectRedactions(async () => shield(P.id, 'U1')))
  const n2 = asAgent(() => privacyNotice(r2.redacted))
  assert.equal(n2?.expired[0]?.scope, P.id)
  assert.match(n2?.hint ?? '', /EXPIRED/)

  const r3 = await asAgent(() => collectRedactions(async () => secret('pw')))
  assert.deepEqual(asAgent(() => privacyNotice(r3.redacted))?.requestable, [])
})

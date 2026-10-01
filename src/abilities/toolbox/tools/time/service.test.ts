import test from 'node:test'
import assert from 'node:assert/strict'
import { execute, parseDate } from './service'

test('nanosecond precision and negative Unix timestamps survive conversion', async () => {
  const result = await execute('epoch-converter', {
    timestamp: '-0.000000001',
    unit: 's',
    zone: 'UTC'
  })
  assert.equal(result.ok, true)
  assert.equal((result.data as Record<string, string>).UTC, '1969-12-31T23:59:59.999999999Z')
  assert.equal((result.data as Record<string, string>).nanoseconds, '-1')
  const date = await execute('epoch-converter', {
    direction: 'to-epoch',
    date: '2026-10-01T12:34:56.123456789+08:00',
    zone: 'UTC'
  })
  assert.equal((date.data as Record<string, string>).UTC, '2026-10-01T04:34:56.123456789Z')
})
test('rejects invalid dates and nonexistent or ambiguous DST wall times', () => {
  assert.throws(() => parseDate('2026-02-30 00:00:00', 'UTC'))
  assert.throws(() => parseDate('2026-03-08 02:30:00', 'America/New_York'))
  assert.throws(() => parseDate('2026-11-01 01:30:00', 'America/New_York'))
  const earlier = parseDate('2026-11-01 01:30:00', 'America/New_York', 'earlier')
  const later = parseDate('2026-11-01 01:30:00', 'America/New_York', 'later')
  assert.equal(later - earlier, 3_600_000_000_000n)
})
test('calendar boundaries follow DST while date addition means elapsed time', async () => {
  const result = await execute('period-boundary', {
    date: '2026-03-08 12:00:00',
    zone: 'America/New_York',
    period: 'day'
  })
  const data = result.data as { start: { seconds: string }; endExclusive: { seconds: string } }
  assert.equal(Number(data.endExclusive.seconds) - Number(data.start.seconds), 23 * 3600)
})
test('batch errors are isolated and alternate epochs resolve Unix zero', async () => {
  const batch = await execute('epoch-batch', { input: '0\ninvalid\n-1', unit: 's', zone: 'UTC' })
  const rows = batch.data as { error?: string; UTC?: string }[]
  assert.equal(rows.length, 3)
  assert.ok(rows[1].error)
  assert.ok(rows[2].UTC?.startsWith('1969-12-31'))
  for (const [format, value] of [
    ['filetime', '116444736000000000'],
    ['dotnet', '621355968000000000'],
    ['webkit', '11644473600000000'],
    ['excel', '25569']
  ]) {
    const result = await execute('special-epoch', { format, value, zone: 'UTC' })
    assert.equal((result.data as { seconds: string }).seconds, '0')
  }
})

test('negative OADate fractions use positive time of day', async () => {
  const result = await execute('special-epoch', { format: 'excel', value: '-1.25', zone: 'UTC' })
  assert.equal(result.ok, true)
  assert.equal((result.data as { UTC: string }).UTC, '1899-12-29T06:00:00.000000000Z')
})

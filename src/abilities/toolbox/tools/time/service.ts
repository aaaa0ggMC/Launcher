import type { ToolArgs, ToolResult } from '../../types'
const NS_PER_MS = 1_000_000n
const factors: Record<string, bigint> = { s: 1_000_000_000n, ms: NS_PER_MS, us: 1_000n, ns: 1n }
const DATE_LIMIT_MS = 8_640_000_000_000_000n
function zoneName(value: unknown): string {
  const zone =
    value === 'local' ? Intl.DateTimeFormat().resolvedOptions().timeZone : String(value ?? 'UTC')
  new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0)
  return zone
}
function decimalNs(value: unknown, factor: bigint): bigint {
  if (String(value).length > 100) throw new Error('数值长度超过限制')
  const match = String(value)
    .trim()
    .match(/^([+-]?)(\d+)(?:\.(\d+))?$/)
  if (!match) throw new Error('请输入有效数字 / Invalid number')
  const fraction = match[3] ?? ''
  const scale = 10n ** BigInt(fraction.length)
  const n = BigInt(match[2]) * factor + (fraction ? (BigInt(fraction) * factor) / scale : 0n)
  if (fraction && (BigInt(fraction) * factor) % scale !== 0n)
    throw new Error('精度超过纳秒 / Precision exceeds nanoseconds')
  return match[1] === '-' ? -n : n
}
function floorDiv(n: bigint, d: bigint): bigint {
  const q = n / d
  return n < 0n && n % d !== 0n ? q - 1n : q
}
function decimal(n: bigint, d: bigint): string {
  const sign = n < 0n ? '-' : ''
  const a = n < 0n ? -n : n
  const fraction = (a % d)
    .toString()
    .padStart(d.toString().length - 1, '0')
    .replace(/0+$/, '')
  return `${sign}${a / d}${fraction ? '.' + fraction : ''}`
}
function dateFromNs(ns: bigint): Date {
  const ms = floorDiv(ns, NS_PER_MS)
  if (ms < -DATE_LIMIT_MS || ms > DATE_LIMIT_MS) throw new Error('日期超出范围 / Date out of range')
  const date = new Date(Number(ms))
  if (!Number.isFinite(date.getTime())) throw new Error('无效日期 / Invalid date')
  return date
}
function parts(ms: number, zone: string): number[] {
  const values = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(ms)
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map((key) =>
    Number(values.find((p) => p.type === key)?.value)
  )
}
function utcMs(p: number[]): number {
  const d = new Date(0)
  d.setUTCFullYear(p[0], p[1] - 1, p[2])
  d.setUTCHours(p[3] ?? 0, p[4] ?? 0, p[5] ?? 0, 0)
  return d.getTime()
}
/** Strict wall-clock resolution rejects nonexistent times and exposes DST overlaps. */
export function parseDate(value: unknown, zone: string, overlap = 'reject'): bigint {
  const raw = String(value).trim()
  const wall = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/i
  )
  if (!wall) throw new Error('日期格式应为 YYYY-MM-DD HH:mm:ss 或 ISO 8601')
  const target = wall.slice(1, 7).map((p) => Number(p ?? 0))
  if (
    target[0] < 1 ||
    target[1] < 1 ||
    target[1] > 12 ||
    target[2] < 1 ||
    target[2] > 31 ||
    target[3] > 23 ||
    target[4] > 59 ||
    target[5] > 59
  )
    throw new Error('日期字段超出范围')
  const wallMs = utcMs(target)
  const check = parts(wallMs, 'UTC')
  if (check.some((p, i) => p !== target[i])) throw new Error('不存在的日历日期')
  let chosen: number
  if (wall[8]) {
    const offset = wall[8].toUpperCase()
    const offsetMatch = offset.match(/^([+-])(\d{2}):?(\d{2})$/)
    let offsetMinutes = 0
    if (offsetMatch) {
      if (Number(offsetMatch[2]) > 23 || Number(offsetMatch[3]) > 59)
        throw new Error('无效时区偏移')
      offsetMinutes =
        (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3])) * (offsetMatch[1] === '-' ? -1 : 1)
    }
    chosen = wallMs - offsetMinutes * 60_000
  } else {
    const offsets = new Set<number>()
    for (const delta of [-2, -1, 0, 1, 2]) {
      const probe = wallMs + delta * 86_400_000
      offsets.add(utcMs(parts(probe, zone)) - probe)
    }
    const candidates = [...offsets]
      .map((offset) => wallMs - offset)
      .filter((ms) => parts(ms, zone).every((p, i) => p === target[i]))
      .sort((a, b) => a - b)
    if (!candidates.length) throw new Error('该时区不存在这个时刻（可能处于夏令时跳时）')
    if (candidates.length > 1 && overlap === 'reject')
      throw new Error('夏令时重复时刻，请选择较早／较晚或提供明确 UTC 偏移')
    chosen = overlap === 'later' ? candidates.at(-1)! : candidates[0]
  }
  return BigInt(chosen) * NS_PER_MS + BigInt((wall[7] ?? '').padEnd(9, '0') || '0')
}
export function epochResult(ns: bigint, zone: string): ToolResult {
  const date = dateFromNs(ns)
  const fraction = (((ns % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n)
    .toString()
    .padStart(9, '0')
  const iso = date.toISOString().replace(/\.\d{3}Z$/, `.${fraction}Z`)
  const data = {
    UTC: iso,
    timeZone: zone,
    zonedDate:
      parts(date.getTime(), zone)
        .map((v, i) => String(v).padStart(i === 0 ? 4 : 2, '0'))
        .join('-')
        .replace(/^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})-(\d{2})$/, '$1 $2:$3:$4') + ` (${zone})`,
    seconds: decimal(ns, factors.s),
    milliseconds: decimal(ns, factors.ms),
    microseconds: decimal(ns, factors.us),
    nanoseconds: ns.toString()
  }
  return {
    ok: true,
    text: Object.entries(data)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
    data
  }
}
export async function execute(id: string, args: ToolArgs): Promise<ToolResult> {
  try {
    const zone = zoneName(args.zone)
    const factor = factors[String(args.unit ?? 's')]
    if (['epoch-converter', 'epoch-batch'].includes(id) && !factor)
      throw new Error('未知时间戳单位')
    switch (id) {
      case 'epoch-converter':
        return epochResult(
          args.direction === 'to-epoch'
            ? parseDate(args.date, zone, String(args.disambiguation ?? 'reject'))
            : decimalNs(args.timestamp ?? '0', factor),
          zone
        )
      case 'epoch-batch': {
        const lines = String(args.input ?? '')
          .split(/\r?\n/)
          .filter((v) => v.trim())
        if (lines.length > 10_000) throw new Error('最多转换 10000 行')
        const rows = lines.map((input): Record<string, string> => {
          try {
            const result = epochResult(decimalNs(input, factor), zone)
            return { input, ...(result.data as Record<string, string>) }
          } catch (e) {
            return { input, error: e instanceof Error ? e.message : '转换失败' }
          }
        })
        return {
          ok: true,
          text: rows.map((r) => `${r.input}\t${r.UTC ?? r.error}`).join('\n'),
          data: rows
        }
      }
      case 'date-difference': {
        const diff = parseDate(args.end, zone) - parseDate(args.start, zone)
        return {
          ok: true,
          text: `Seconds: ${decimal(diff, factors.s)}\nDays (24h): ${Number(diff) / 86_400e9}`,
          data: {
            nanoseconds: diff.toString(),
            seconds: decimal(diff, factors.s),
            days: Number(diff) / 86_400e9
          }
        }
      }
      case 'date-add': {
        const periods: Record<string, bigint> = {
          second: 1n,
          minute: 60n,
          hour: 3600n,
          day: 86400n
        }
        const p = periods[String(args.period ?? 'day')]
        if (!p) throw new Error('未知单位')
        return epochResult(
          parseDate(args.date, zone) + decimalNs(args.amount ?? 1, p * factors.s),
          zone
        )
      }
      case 'period-boundary': {
        const p = parts(dateFromNs(parseDate(args.date, zone)).getTime(), zone)
        const period = String(args.period ?? 'day')
        if (!['day', 'month', 'year'].includes(period)) throw new Error('未知区间')
        if (period === 'year') {
          p[1] = 1
          p[2] = 1
        } else if (period === 'month') p[2] = 1
        p[3] = p[4] = p[5] = 0
        const label = (v: number[]): string =>
          `${String(v[0]).padStart(4, '0')}-${String(v[1]).padStart(2, '0')}-${String(v[2]).padStart(2, '0')} 00:00:00`
        const start = parseDate(label(p), zone, 'earlier')
        const next = new Date(utcMs(p))
        if (period === 'year') next.setUTCFullYear(next.getUTCFullYear() + 1)
        else if (period === 'month') next.setUTCMonth(next.getUTCMonth() + 1)
        else next.setUTCDate(next.getUTCDate() + 1)
        const endExclusive = parseDate(label(parts(next.getTime(), 'UTC')), zone, 'earlier')
        const data = {
          start: epochResult(start, zone).data,
          endInclusive: epochResult(endExclusive - 1n, zone).data,
          endExclusive: epochResult(endExclusive, zone).data
        }
        return { ok: true, text: JSON.stringify(data, null, 2), data }
      }
      case 'duration': {
        const ns = decimalNs(args.seconds ?? '0', factors.s)
        const sign = ns < 0n ? '-' : ''
        let seconds = (ns < 0n ? -ns : ns) / factors.s
        const days = seconds / 86400n
        seconds %= 86400n
        const hours = seconds / 3600n
        seconds %= 3600n
        const minutes = seconds / 60n
        seconds %= 60n
        const remainder = decimal(
          seconds * factors.s + ((ns < 0n ? -ns : ns) % factors.s),
          factors.s
        )
        return {
          ok: true,
          text: `${sign}${days}d ${hours}h ${minutes}m ${remainder}s\n${sign}P${days}DT${hours}H${minutes}M${remainder}S`
        }
      }
      case 'special-epoch': {
        const value = String(args.value ?? '').trim()
        if (value.length > 100) throw new Error('数值长度超过限制')
        let ns: bigint
        switch (args.format ?? 'filetime') {
          case 'filetime':
            ns = (BigInt(value) - 116444736000000000n) * 100n
            break
          case 'dotnet':
            ns = (BigInt(value) - 621355968000000000n) * 100n
            break
          case 'webkit':
            ns = BigInt(value) * 1000n - 11644473600n * factors.s
            break
          case 'excel': {
            const day = 86400n * factors.s
            const oa = decimalNs(value, day)
            // OADate's negative fractional part still denotes positive time of day.
            const elapsed = oa < 0n ? (oa / day) * day - (oa % day) : oa
            ns = elapsed - 25569n * day
            break
          }
          case 'discord': {
            const n = BigInt(value)
            if (n < 0n || n > (1n << 64n) - 1n) throw new Error('Snowflake 超出 64 位范围')
            ns = ((n >> 22n) + 1420070400000n) * NS_PER_MS
            break
          }
          case 'hex': {
            if (!/^[+-]?(?:0x)?[\da-f]+$/i.test(value)) throw new Error('无效十六进制')
            const negative = value.startsWith('-')
            const raw = value.replace(/^[+-]/, '').replace(/^0x/i, '')
            ns = BigInt(`0x${raw}`) * factors.s * (negative ? -1n : 1n)
            break
          }
          default:
            throw new Error('未知时间戳格式')
        }
        return epochResult(ns, zone)
      }
      case 'world-clock': {
        const ns = String(args.date ?? '').trim()
          ? parseDate(args.date, 'UTC')
          : BigInt(Date.now()) * NS_PER_MS
        const zones = String(args.zones ?? 'UTC\nAsia/Shanghai')
          .split(/\r?\n/)
          .filter((z) => z.trim())
        if (zones.length > 100) throw new Error('最多显示100个时区')
        const data = zones.map((z): Record<string, string> => ({
          zone: z.trim(),
          ...(epochResult(ns, zoneName(z.trim())).data as Record<string, string>)
        }))
        return { ok: true, text: data.map((r) => `${r.zone}: ${r.zonedDate}`).join('\n'), data }
      }
      default:
        return { ok: false, error: '未知时间工具' }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '时间转换失败' }
  }
}

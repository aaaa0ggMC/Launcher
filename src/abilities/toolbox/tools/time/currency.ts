import type { ToolArgs, ToolResult } from '../../types'

interface RateTable {
  rates: Record<string, number>
  date: string
  source: string
}
const TTL_MS = 60 * 60 * 1000
const cache = new Map<string, { at: number; table: RateTable }>()

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
async function fromErApi(base: string): Promise<RateTable> {
  const json = (await getJson(`https://open.er-api.com/v6/latest/${base}`)) as {
    result?: string
    rates?: Record<string, number>
    time_last_update_utc?: string
  }
  if (json.result !== 'success' || !json.rates) throw new Error('bad response')
  return { rates: json.rates, date: json.time_last_update_utc ?? '', source: 'open.er-api.com' }
}
async function fromFawaz(base: string): Promise<RateTable> {
  const key = base.toLowerCase()
  const json = (await getJson(
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${key}.json`
  )) as Record<string, unknown>
  const raw = json[key] as Record<string, number> | undefined
  if (!raw) throw new Error('bad response')
  const rates = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toUpperCase(), v]))
  return { rates, date: String(json.date ?? ''), source: 'fawazahmed0/currency-api' }
}
async function table(base: string): Promise<RateTable> {
  const hit = cache.get(base)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.table
  let result: RateTable
  try {
    result = await fromErApi(base)
  } catch {
    try {
      result = await fromFawaz(base)
    } catch {
      throw new Error(
        '无法获取汇率，请检查网络 / Failed to fetch exchange rates, check your network'
      )
    }
  }
  cache.set(base, { at: Date.now(), table: result })
  return result
}
function code(value: unknown): string {
  const c = String(value ?? '')
    .trim()
    .toUpperCase()
  if (!/^[A-Z]{3}$/.test(c))
    throw new Error('请输入 3 位货币代码，如 USD / Use a 3-letter code, e.g. USD')
  return c
}

export async function currency(args: ToolArgs): Promise<ToolResult> {
  const amount = Number(String(args.amount ?? '').trim())
  if (!Number.isFinite(amount)) throw new Error('请输入有效金额 / Invalid amount')
  const from = code(args.from)
  const targets = String(args.to ?? '')
    .split(/[\s,，]+/)
    .filter(Boolean)
    .map(code)
  if (!targets.length) throw new Error('请输入目标货币 / Enter target currencies')
  if (targets.length > 30) throw new Error('最多 30 种目标货币')
  const { rates, date, source } = await table(from)
  const data = targets.map((to) => {
    const rate = rates[to]
    if (rate === undefined) throw new Error(`不支持的货币 / Unsupported currency: ${to}`)
    return { from, to, rate, amount, result: amount * rate }
  })
  const fmt = (n: number): string =>
    n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 6 : 4 })
  const text = [
    ...data.map(
      (r) =>
        `${fmt(r.amount)} ${r.from} = ${fmt(r.result)} ${r.to}  (1 ${r.from} = ${r.rate} ${r.to})`
    ),
    '',
    `${source} · ${date}`
  ].join('\n')
  return { ok: true, text, data, note: `${source} ${date}` }
}

/**
 * 信息源的取数层（仅主进程）：渲染 URL → （私网地址先要授权）→ 拉取 → 交给类型抽取。
 *
 * - 网络统一走 Electron `net.fetch`（跟随系统代理），无头 / 测试回落全局 fetch（同 web-search 的做法）；
 * - 超时 8s，每个渠道独立成败——一个渠道挂了不影响其它渠道（和多引擎搜索同一取舍）；
 * - 指向本机 / 局域网的模板要 `guard(SCOPE_EXEC)`（同 `fetch_url` 的规则，防被套走内网数据）。
 */
import { net } from 'electron'
import { SCOPE_EXEC, guard } from '../../../../main/process/privacy'
import { isPrivateUrl } from '../system/net-guard'
import { buildUrl, sourceType, type InfoInstance, type InfoItem } from '../../services/info-sources'

const TIMEOUT_MS = 8000

async function httpGet(url: string, signal: AbortSignal): Promise<string> {
  const u = new URL(url)
  if (await isPrivateUrl(u)) await guard(SCOPE_EXEC)
  const init: RequestInit = {
    signal,
    headers: { accept: '*/*, application/json, application/atom+xml' }
  }
  const res = net?.fetch ? await net.fetch(url, init) : await fetch(url, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `：${text.slice(0, 120)}` : ''}`)
  return text
}

export async function fetchSource(
  instance: InfoInstance,
  query: string
): Promise<{ items?: InfoItem[]; error?: string }> {
  const type = sourceType(instance.type)
  if (!type) return { error: `未知类型 ${instance.type}` }
  if (!type.template && !instance.template?.trim()) return { error: '自定义模板没有填 URL' }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const body = await httpGet(buildUrl(instance, type, query), ac.signal)
    let data: unknown
    if (type.as === 'json') {
      try {
        data = JSON.parse(body)
      } catch {
        return { error: `响应不是 JSON：${body.slice(0, 120)}` }
      }
    } else data = body
    return { items: type.extract(data, { query }) }
  } catch (e) {
    const msg =
      e instanceof Error ? (e.name === 'AbortError' ? '超时（8s）' : e.message) : String(e)
    return { error: msg }
  } finally {
    clearTimeout(timer)
  }
}

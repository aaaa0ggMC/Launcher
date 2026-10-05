/**
 * 原生（非 OpenAI 兼容）Provider 共用的 HTTP 小工具：JSON 请求、SSE 解析、错误归一。
 *
 * 不引入各家 SDK：YAYA 的 Provider 层只需要「发消息 + 流式 + 工具调用 + 列模型」，
 * 直接按 HTTP 协议写，同时兼容用户自建的转发网关（只换 baseUrl）。
 */

/** 带 HTTP 状态码的错误（Provider 据此决定要不要去掉思考参数重试） */
export class ProviderHttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: string
  ) {
    super(message)
    this.name = 'ProviderHttpError'
  }
}

/** 请求失败时把响应体里的错误信息拼进异常（各家格式：`{error:{message}}` / `{error:{message,status}}`） */
export async function ensureOk(res: Response, label: string): Promise<void> {
  if (res.ok) return
  const body = await res.text().catch(() => '')
  let detail = body.slice(0, 500)
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; type?: string } }
    if (parsed.error?.message) detail = parsed.error.message
  } catch {
    /* 非 JSON 响应体：原样截断 */
  }
  throw new ProviderHttpError(res.status, `${label} ${res.status}: ${detail}`, body)
}

export interface SseEvent {
  event: string
  data: string
}

/** 逐个产出 SSE 事件（`event:` + 多行 `data:`，空行分隔）；中止信号触发即停 */
export async function* readSse(res: Response, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let event = ''
  let data: string[] = []
  const flush = (): SseEvent | null => {
    if (!data.length && !event) return null
    const out = { event: event || 'message', data: data.join('\n') }
    event = ''
    data = []
    return out
  }
  try {
    while (true) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line === '') {
          const ev = flush()
          if (ev) yield ev
        } else if (line.startsWith(':')) {
          continue
        } else {
          const idx = line.indexOf(':')
          const field = idx < 0 ? line : line.slice(0, idx)
          let value = idx < 0 ? '' : line.slice(idx + 1)
          if (value.startsWith(' ')) value = value.slice(1)
          if (field === 'event') event = value
          else if (field === 'data') data.push(value)
        }
      }
    }
    buf += decoder.decode()
    if (buf.trim()) {
      for (const line of buf.split(/\r?\n/)) {
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        else if (line.startsWith('event:')) event = line.slice(6).trim()
      }
    }
    const last = flush()
    if (last) yield last
  } finally {
    reader.releaseLock()
  }
}

export function tryParseJson(str: string): Record<string, unknown> | string {
  if (!str.trim()) return {}
  try {
    const v = JSON.parse(str)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : str
  } catch {
    return str
  }
}

/** baseUrl 去尾斜杠；空 = 用默认地址 */
export function cleanBase(baseUrl: string | undefined, fallback: string): string {
  return (baseUrl?.trim() || fallback).replace(/\/+$/, '')
}

/**
 * YAYA 模型端点动态嗅探与拉取服务
 * 支持 OpenAI 兼容端点 (/v1/models)、Ollama (/api/tags) 等动态发现模型。
 */
import { makeLogger } from '../../../main/process/logger'
import type { ProviderType } from '../types'
import { listAnthropicModels } from './providers/anthropic'
import { listGeminiModels } from './providers/gemini'

const log = makeLogger('yaya-models')

export interface FetchModelsOptions {
  baseUrl?: string
  apiKey?: string
  type?: ProviderType
  timeoutMs?: number
}

export interface FetchModelsResult {
  ok: boolean
  models: string[]
  error?: string
}

export async function fetchModelsFromEndpoint(
  options: FetchModelsOptions
): Promise<FetchModelsResult> {
  const { baseUrl, apiKey, type = 'openai', timeoutMs = 8000 } = options
  if (type === 'anthropic' || type === 'gemini')
    return fetchNativeModels(type, baseUrl, apiKey, timeoutMs)
  if (!baseUrl) {
    return { ok: false, models: [], error: '未提供 Base URL' }
  }

  const cleanBase = baseUrl.replace(/\/+$/, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    // 1. Ollama 端点优先探测 /api/tags，其次 /v1/models
    if (type === 'ollama') {
      try {
        const ollamaRes = await fetch(`${cleanBase}/api/tags`, {
          signal: controller.signal
        })
        if (ollamaRes.ok) {
          const data = (await ollamaRes.json()) as {
            models?: Array<{ name?: string; model?: string }>
          }
          if (Array.isArray(data.models) && data.models.length > 0) {
            const list = data.models
              .map((m) => m.name || m.model || '')
              .filter(Boolean)
              .sort()
            return { ok: true, models: list }
          }
        }
      } catch (err) {
        log.warn('Ollama /api/tags probe failed, trying /models fallback', { error: String(err) })
      }
    }

    // 2. 通用 OpenAI / 兼容端点探测 (GET /models 或 /v1/models)
    const url = cleanBase.endsWith('/models') ? cleanBase : `${cleanBase}/models`
    const headers: Record<string, string> = {
      Accept: 'application/json'
    }
    if (apiKey && apiKey !== 'dummy') {
      headers.Authorization = `Bearer ${apiKey}`
    }

    const res = await fetch(url, {
      headers,
      signal: controller.signal
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        ok: false,
        models: [],
        error: `端点响应异常 (${res.status}): ${text.slice(0, 120)}`
      }
    }

    const json = (await res.json()) as {
      data?: Array<{ id: string }>
      models?: Array<{ name?: string; model?: string }>
    }

    let parsedModels: string[] = []
    if (Array.isArray(json.data)) {
      parsedModels = json.data.map((item) => item.id).filter(Boolean)
    } else if (Array.isArray(json.models)) {
      parsedModels = json.models.map((item) => item.name || item.model || '').filter(Boolean)
    }

    if (parsedModels.length === 0) {
      return {
        ok: false,
        models: [],
        error: '端点返回了数据但未包含有效模型列表'
      }
    }

    parsedModels.sort()
    return { ok: true, models: parsedModels }
  } catch (e: unknown) {
    const isTimeout = (e as Error)?.name === 'AbortError'
    const errorMsg = isTimeout ? '连接端点超时，请检查服务地址是否可达' : String(e)
    log.error('Fetch models failed', { baseUrl, error: errorMsg })
    return { ok: false, models: [], error: errorMsg }
  } finally {
    clearTimeout(timer)
  }
}

/** 原生协议的模型列表（baseUrl 可空 = 官方地址） */
async function fetchNativeModels(
  type: ProviderType,
  baseUrl: string | undefined,
  apiKey: string | undefined,
  timeoutMs: number
): Promise<FetchModelsResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const list = type === 'gemini' ? listGeminiModels : listAnthropicModels
    const models = await list(baseUrl, apiKey, controller.signal)
    if (!models.length)
      return { ok: false, models: [], error: '端点返回了数据但未包含有效模型列表' }
    return { ok: true, models: models.sort() }
  } catch (e: unknown) {
    const isTimeout = (e as Error)?.name === 'AbortError'
    const errorMsg = isTimeout ? '连接端点超时，请检查服务地址是否可达' : String(e)
    log.error('Fetch models failed', { type, baseUrl, error: errorMsg })
    return { ok: false, models: [], error: errorMsg }
  } finally {
    clearTimeout(timer)
  }
}

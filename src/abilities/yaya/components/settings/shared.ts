import type { ProviderType } from '../../types'

export interface ProviderTypeItem {
  title: string
  value: ProviderType
}

/** 添加服务商弹窗里的草稿（不含 id，由外壳落库） */
export interface ProviderDraft {
  name: string
  type: ProviderType
  baseUrl: string
  apiKey: string
  models: string[]
}

/** 协议类型下拉项（标题走翻译，由各传入自己的 t） */
export function providerTypeItems(
  t: (key: string, fallback?: string) => string
): ProviderTypeItem[] {
  return [
    {
      title: t(
        'yaya.settings.type_openai',
        'OpenAI 兼容协议（OpenAI / DeepSeek / SiliconFlow 等）'
      ),
      value: 'openai'
    },
    { title: t('yaya.settings.type_ollama', 'Ollama（本地部署）'), value: 'ollama' },
    {
      title: t('yaya.settings.type_codex_proxy', 'Codex Proxy（本地代理）'),
      value: 'codex-proxy'
    }
  ]
}

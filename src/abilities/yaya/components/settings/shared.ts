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

/** 外壳注入给各分区的保存接口（配置改为「改了即保存」） */
export interface YayaSettingsSaveApi {
  /** 立刻保存一次：密钥写入等不适合走防抖的字段用 */
  saveNow: () => void
}

/** provide / inject 的 key：由 YayaSettingsSection.vue 提供，分区组件按需取用 */
export const YAYA_SAVE_API_KEY = 'yaya:settings-save'

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
    {
      title: t('yaya.settings.type_anthropic', 'Anthropic 原生（Claude Messages API）'),
      value: 'anthropic'
    },
    { title: t('yaya.settings.type_ollama', 'Ollama（本地部署）'), value: 'ollama' },
    {
      title: t('yaya.settings.type_codex_proxy', 'Codex Proxy（本地代理）'),
      value: 'codex-proxy'
    }
  ]
}

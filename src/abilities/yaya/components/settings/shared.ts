import type { Ref } from 'vue'
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

/**
 * 窄屏层级导航：头部只有一个「返回」。子视图（插件详情、助手详情）注册拦截器先自己退一层，
 * 都不处理才回到分区列表——不再出现「返回」+「返回插件列表」两个返回按钮叠在一起。
 */
export interface YayaSettingsNav {
  /** 注册拦截器（后注册的先问），返回注销函数；拦截器返回 true = 已处理 */
  onBack: (handler: () => boolean) => () => void
  /** 窄屏层级模式：头部已有返回按钮，子视图不用再放自己的 */
  narrow: Readonly<Ref<boolean>>
}

export const YAYA_SETTINGS_NAV_KEY = 'yaya:settings-nav'

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
    {
      title: t('yaya.settings.type_gemini', 'Google Gemini 原生（Generative Language API）'),
      value: 'gemini'
    },
    { title: t('yaya.settings.type_ollama', 'Ollama（本地部署）'), value: 'ollama' },
    {
      title: t('yaya.settings.type_codex_proxy', 'Codex Proxy（本地代理）'),
      value: 'codex-proxy'
    }
  ]
}

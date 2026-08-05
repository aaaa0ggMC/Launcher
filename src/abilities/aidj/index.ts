import { defineAsyncComponent } from 'vue'
import type { Ability } from '../types'

export default {
  id: 'aidj',
  name: 'AI DJ',
  icon: 'gi:audio-waves',
  category: '工具',
  keepAlive: true,
  component: defineAsyncComponent(() => import('./View.vue')),
  settings: [
    {
      key: 'aidj',
      label: 'AI DJ',
      icon: 'mdi-radio-tower',
      description: 'AI DJ 的 API 密钥、模型选择、播放偏好等配置',
      items: [
        {
          key: 'general',
          label: 'AI DJ 配置',
          fullWidth: true,
          component: defineAsyncComponent(
            () => import('./components/AidjSettingsSection.vue')
          )
        }
      ]
    }
  ]
} satisfies Ability
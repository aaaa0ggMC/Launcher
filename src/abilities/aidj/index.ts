import { defineAsyncComponent, markRaw } from 'vue'
import type { Ability } from '../types'
import { registerBtView } from '../../main/ui/bt-views'
import ContinuousView from './components/ContinuousView.vue'
import BtChatView from './components/BtChatView.vue'

registerBtView('continuous', () => ({ component: markRaw(ContinuousView) }))
registerBtView('chat', () => ({ component: markRaw(BtChatView) }))

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
          component: defineAsyncComponent(() => import('./components/AidjSettingsSection.vue'))
        }
      ]
    }
  ]
} satisfies Ability

import { defineAsyncComponent } from 'vue'
import type { Ability } from '../../main/ui/ability'

export default {
  id: 'balance',
  name: '余额',
  icon: 'default/bitcoin/padding',
  category: '工具',
  keepAlive: true,
  component: defineAsyncComponent(() => import('./View.vue')),
  settings: [
    {
      key: 'balance',
      label: '余额设置',
      icon: 'mdi-wallet-outline',
      description: 'AI 平台账户余额、硬件加密密钥与自动轮询配置',
      keywords: [
        '余额',
        'balance',
        'token',
        'credits',
        'deepseek',
        'openrouter',
        'ppio',
        'openai',
        'tavily',
        'api key',
        '密钥'
      ],
      items: [
        {
          key: 'general',
          label: '余额配置',
          icon: 'mdi-tune',
          description: '管理平台凭据、测试连接与轮询参数',
          fullWidth: true,
          component: defineAsyncComponent(() => import('./components/BalanceSettingsSection.vue'))
        }
      ]
    }
  ]
} satisfies Ability

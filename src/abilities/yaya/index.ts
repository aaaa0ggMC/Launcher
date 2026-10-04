import { defineAsyncComponent } from 'vue'
import type { Ability } from '../../main/ui/ability'

export default {
  id: 'yaya',
  name: 'YAYA',
  icon: 'default/message-02/padding',
  category: '工具',
  keepAlive: true,
  component: defineAsyncComponent(() => import('./View.vue')),
  settings: [
    {
      key: 'yaya',
      label: 'YAYA Agent',
      icon: 'mdi-robot-outline',
      description: 'YAYA 智能体端点、模型参数与 MCP 工具服务配置',
      items: [
        {
          key: 'general',
          label: 'YAYA 配置',
          fullWidth: true,
          component: defineAsyncComponent(() => import('./components/YayaSettingsSection.vue'))
        }
      ]
    }
  ]
} satisfies Ability

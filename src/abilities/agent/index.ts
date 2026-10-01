import { defineAsyncComponent } from 'vue'
import type { Ability } from '../../main/ui/ability'

/**
 * AI 与远程（Remote / MCP 网关）— backend-only ability: no sidebar page, only a
 * settings category. The gateway itself lives in `src/main/process/agent/`.
 * See docs/agent-access-design.md.
 */
export default {
  id: 'agent',
  name: 'AI 与远程',
  icon: 'gi:settings',
  category: '系统',
  settings: [
    {
      key: 'agent',
      label: 'AI 与远程',
      icon: 'mdi-robot-outline',
      description: 'MCP / Remote 接入、访问令牌、已连接会话与隐私策略',
      keywords: [
        'AI',
        'MCP',
        'remote',
        '远程',
        'agent',
        '令牌',
        'token',
        '隐私',
        'privacy',
        'Claude'
      ],
      items: [
        {
          key: 'general',
          label: 'AI 与远程',
          icon: 'mdi-robot-outline',
          description: '开关 MCP / Remote，管理令牌与会话',
          fullWidth: true,
          component: defineAsyncComponent(() => import('./components/AgentSettingsSection.vue'))
        }
      ]
    }
  ]
} satisfies Ability

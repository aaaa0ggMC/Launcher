import { defineAsyncComponent } from 'vue'
import type { Ability } from '../../main/ui/ability'
import { registerQuickActionProvider } from '../../main/ui/quick-actions'
import { tools } from './registry'

registerQuickActionProvider(() =>
  tools.map((tool) => ({
    id: `toolbox:${tool.id}`,
    ability: 'toolbox',
    label: tool.title,
    description: tool.description,
    icon: 'default/tool-kit/padding',
    keywords: [
      tool.id,
      tool.title.replace(/\s+/g, ''),
      tool.titleEn,
      tool.titleEn.replace(/\s+/g, ''),
      ...tool.keywords,
      '工具箱',
      'toolbox',
      'offline'
    ],
    target: { tool: tool.id }
  }))
)

export default {
  id: 'toolbox',
  name: '工具箱',
  icon: 'default/tool-kit/padding',
  category: '工具',
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies Ability

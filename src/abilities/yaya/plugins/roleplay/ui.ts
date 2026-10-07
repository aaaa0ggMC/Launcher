/**
 * roleplay 插件的界面注入：
 * - inlineTokens：正文里的 `[[main]]`（主角）显示成配置里的「主角显示名」，没配就是「主角」小标签；
 * - cardViews：开局设定 / 存档导出（带复制）；命令帮助用默认的 Markdown 卡片。
 */
import { definePluginUi } from '../../components/plugin-ui'
import { pluginConfigValues } from '../../components/plugin-ui-registry'

export default definePluginUi({
  pluginId: 'roleplay',
  inlineTokens: [
    {
      pattern: /\[\[main\]\]/gi,
      render: (_m, ctx) => {
        const name = String(pluginConfigValues('roleplay').main_name ?? '').trim()
        if (name) return { text: name, tone: 'text' }
        return {
          text: ctx.t('yaya.rp.main', '主角'),
          icon: 'mdi-account-star-outline',
          title: ctx.t('yaya.rp.main_title', '主角（设置 → 插件 → 角色扮演 → 主角显示名）')
        }
      }
    }
  ],
  cardViews: {
    'roleplay-setup': () => import('./RoleplayCard.vue'),
    'roleplay-export': () => import('./RoleplayCard.vue')
  }
})

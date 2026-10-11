import { definePluginUi } from '../../components/plugin-ui'
import { pluginConfigValues } from '../../components/plugin-ui-registry'

/**
 * 拟真对话的渲染端：
 * - `inlineTags`：接管正文里的 `<||…/>`，切成多个气泡（`components/chat-tags.ts`）；
 * - `turnChrome`：隐藏回答下方的内置操作栏、决定过程卡片怎么显示、给运行中加「输入中」提示。
 *
 * 两者都按插件启用状态门控——关掉插件后 DOM 与没有这个插件时一致。
 */
export default definePluginUi({
  pluginId: 'waifu',
  inlineTags: [{ prefix: '<||', kind: 'split' }],
  turnChrome: (ctx) => {
    void ctx
    const cfg = pluginConfigValues('waifu')
    const process = cfg.process
    return {
      hideActions: typeof cfg.hideActions === 'boolean' ? cfg.hideActions : true,
      process: process === 'open' || process === 'hidden' ? process : 'collapsed',
      // 空串 = 用框架默认文案（「对方输入中…」）
      typingLabel: typeof cfg.typingLabel === 'string' ? cfg.typingLabel : ''
    }
  }
})

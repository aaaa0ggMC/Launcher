import { definePluginUi } from '../../components/plugin-ui'

/**
 * 表情回应的渲染端注入（R1：react 是 plugin）：
 * - `messageReactions` = 消息 / 气泡下面的回应条组件——按启用状态门控，
 *   插件关掉时 `reactionBarFor()` 返回 null，消息下面连一块 DOM 都不剩；
 * - 组件本体暂仍在 `components/ReactionBar.vue`（选择器、表情集逻辑都聚在那），
 *   引用关系归本插件，后续要搬家只动这一个 import。
 */
export default definePluginUi({
  pluginId: 'react',
  messageReactions: () => import('../../components/ReactionBar.vue'),
  // R6：输入框「+」面板的表情项——与回应条同一张面板，选中插进消息正文
  inputExtension: () => import('./EmojiInput.vue')
})

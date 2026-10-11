import { definePluginUi } from '../../components/plugin-ui'

/**
 * 对话小游戏的渲染端：`<g|ttt|…>` 块级标记 → 井字棋棋盘（渲染在回答末尾，
 * 旁白文字在它上方）。棋盘点格子会发一条 `<g|ttt|move=N>` 的用户消息，
 * 所以标记在**用户气泡里也要剥掉**（roles 两侧都声明）。
 */
export default definePluginUi({
  pluginId: 'interactgame',
  inlineTags: [{ prefix: '<g|', kind: 'block', roles: ['user', 'assistant'] }],
  blockViews: { ttt: () => import('./TicTacToe.vue') }
})

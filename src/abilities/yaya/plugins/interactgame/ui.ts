import { definePluginUi } from '../../components/plugin-ui'

/**
 * 对话小游戏的渲染端（**C1 重设计**：棋盘只有一块、悬浮常驻实时更新）：
 * - `<g|ttt|…>` 块级标记 → `BoardAnchor.vue`：**不画可见棋盘**，把标记汇聚成
 *   `gameView` 喂给悬浮面板（`yaya.game-board`，能力 index.ts 声明）；
 *   悬浮窗被用户禁用时自动**内联回退**成老的棋盘卡（TicTacToe.vue）。
 * - 标记在**用户气泡里也要剥掉**（roles 两侧都声明）；
 * - 用户的走子消息显示成人话（`<g|ttt|move=4>` → 「你落子第 5 格」）。
 */
export default definePluginUi({
  pluginId: 'interactgame',
  inlineTags: [{ prefix: '<g|', kind: 'block', roles: ['user', 'assistant'] }],
  blockViews: { ttt: () => import('./BoardAnchor.vue') },
  blockEchoes: {
    ttt: (payload, t) => {
      const m = /move=(\d)/.exec(payload)
      if (!m) return ''
      return t('yaya.game.you_moved', '你落子第 {n} 格').replace('{n}', String(Number(m[1]) + 1))
    }
  }
})

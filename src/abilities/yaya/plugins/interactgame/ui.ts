import { definePluginUi } from '../../components/plugin-ui'

/**
 * 对话小游戏的渲染端（**C1 修正版**：棋盘钉在聊天窗口底部的固定条带、原地实时更新，
 * 消息在它上面出现——用户澄清原意：**不是悬浮窗**）：
 * - `<g|ttt|…>` 块级标记 → `BoardAnchor.vue`：**不画可见棋盘**，把标记汇聚成
 *   `gameView` 喂给输入框上方的条带（`bottomStrip` → GameBoard.vue）；
 * - 标记在**用户气泡里也要剥掉**（roles 两侧都声明）；
 * - 用户的走子消息显示成人话（`<g|ttt|move=4>` → 「你落子第 5 格」）。
 */
export default definePluginUi({
  pluginId: 'interactgame',
  inlineTags: [{ prefix: '<g|', kind: 'block', roles: ['user', 'assistant'] }],
  blockViews: { ttt: () => import('./BoardAnchor.vue') },
  bottomStrip: () => import('./GameBoard.vue'),
  blockEchoes: {
    ttt: (payload, t) => {
      const m = /move=(\d)/.exec(payload)
      if (!m) return ''
      return t('yaya.game.you_moved', '你落子第 {n} 格').replace('{n}', String(Number(m[1]) + 1))
    }
  }
})

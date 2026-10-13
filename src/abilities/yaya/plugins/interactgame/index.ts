/**
 * 内置「对话小游戏」插件：AI 在聊天里直接和你下井字棋。
 *
 * 没有工具——棋盘是**底部固定条带**（C1 修正：钉在聊天窗口底部、消息在它上面出现，
 * 不悬浮不遮消息）：AI 在回答里写 `<g|ttt|X.O.X...|turn=O>`，界面把它汇聚成当前对局
 * 显示在输入框上方的条带里（旁白与「AI 思考中」也在条带上）；你点格子 = 发一条
 * `<g|ttt|move=4>` 的用户消息，AI 用新棋盘回你。渲染端见同目录 ui.ts / GameBoard.vue。
 */
import type { YayaPlugin } from '../../services/plugins/types'

/** 固定英文（与其他插件的 instructions 一致：不随界面语言变，提示词缓存不失效） */
const INSTRUCTIONS = [
  '## Tic-tac-toe (floating board)',
  'You can play tic-tac-toe with the user right inside the conversation:',
  '- Every reply that continues the game contains exactly one board tag',
  '  `<g|ttt|STATE|turn=WHO|note=ONE-LINE>`:',
  "  STATE is exactly 9 characters, row-major order: `X` = your mark, `O` = the user's, `.` = empty.",
  "  `turn` is `O` when it is the user's move (the board accepts clicks) and `X` when it is yours",
  '  (read-only). Omit it after the game ends.',
  '  NEVER leave the board at `turn=X` — every reply that continues the game places YOUR mark',
  '  in the same tag; `turn=X` alone is a dead end for the user.',
  '  `note` is your short commentary shown ON the board — put the playful narration there,',
  '  and never use the `|` character inside it.',
  '- The board is ONE floating panel that updates in place (it is not re-posted into the chat):',
  '  never paste boards into the surrounding text, and keep that text to at most one short line.',
  '- The user moves by replying with a tag like `<g|ttt|move=4>` (cells 0..8, row-major). Then',
  '  answer with your move as an updated board tag. If their move is invalid (occupied, out of range,',
  '  or not their turn), say so instead of cheating and repeat the current board.',
  '- You play X and make the first move.'
].join('\n')

const plugin: YayaPlugin = {
  id: 'interactgame',
  kind: 'builtin',
  // 默认关：想在对话里下棋时再打开
  defaultEnabled: false,
  label: '对话小游戏',
  labelKey: 'yaya.plugin.interactgame.label',
  description: 'AI 在聊天里直接和你下井字棋（棋盘是常驻悬浮面板、实时更新，点格子就落子）',
  descriptionKey: 'yaya.plugin.interactgame.desc',
  icon: 'mdi-grid',
  tools: () => [],
  instructions: () => INSTRUCTIONS
}

export default plugin

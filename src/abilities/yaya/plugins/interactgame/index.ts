/**
 * 内置「对话小游戏」插件：AI 在聊天里直接和你下井字棋。
 *
 * 没有工具——棋盘是**块级小部件**：AI 在回答里写 `<g|ttt|X.O.X...|turn=O>`，
 * 界面把它渲染成可点的棋盘（旁白文字照常显示在它上方）；你点格子 = 发一条
 * `<g|ttt|move=4>` 的用户消息，AI 用新棋盘回你。渲染端见同目录 ui.ts / TicTacToe.vue。
 */
import type { YayaPlugin } from '../../services/plugins/types'

/** 固定英文（与其他插件的 instructions 一致：不随界面语言变，提示词缓存不失效） */
const INSTRUCTIONS = [
  '## Tic-tac-toe in the chat',
  'You can play tic-tac-toe with the user right inside the conversation:',
  '- Put a board anywhere in your reply with a single tag `<g|ttt|STATE|turn=WHO>`:',
  "  STATE is exactly 9 characters, row-major order: `X` = your mark, `O` = the user's, `.` = empty.",
  "  `turn` is `O` when it is the user's move (the board accepts clicks) and `X` when it is yours",
  '  (the board is read-only). Omit it after the game ends.',
  '- The board is rendered at the end of your message, so narration goes in the surrounding text',
  '  and shows up above the board.',
  '- The user moves by replying with a tag like `<g|ttt|move=4>` (cells 0..8, row-major). Then',
  '  answer with your move as an updated board. If their move is invalid (occupied, out of range,',
  '  or not their turn), say so instead of cheating and repeat the current board.',
  '- Show an updated board after every move; keep the narration short and playful.',
  '- You play X and make the first move.'
].join('\n')

const plugin: YayaPlugin = {
  id: 'interactgame',
  kind: 'builtin',
  // 默认关：想在对话里下棋时再打开
  defaultEnabled: false,
  label: '对话小游戏',
  labelKey: 'yaya.plugin.interactgame.label',
  description: 'AI 在聊天里直接和你下井字棋（棋盘是对话内小部件，点格子就落子）',
  descriptionKey: 'yaya.plugin.interactgame.desc',
  icon: 'mdi-grid',
  tools: () => [],
  instructions: () => INSTRUCTIONS
}

export default plugin

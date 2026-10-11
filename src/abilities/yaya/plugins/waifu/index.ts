/**
 * 内置 waifu 插件（拟真对话）：把回答切成多个气泡、收起回答下方的操作栏、
 * 运行中显示「对方输入中…」，让界面接近真实聊天。
 *
 * 没有工具；启用时给系统提示词加一段固定的英文说明（不翻译、不随配置变化，提示词缓存稳定），
 * 告诉模型怎么自己切分气泡、怎么给气泡命名与撤回。程序**不**替模型切分。
 * 渲染端见同目录 ui.ts（`inlineTags` + `turnChrome`），分段逻辑在 `components/chat-tags.ts`。
 */
import type { YayaPlugin } from '../../services/plugins/types'

/** 固定英文（与其他插件的 instructions 一致：不随界面语言变，提示词缓存不失效） */
const INSTRUCTIONS = [
  '## Realistic chat mode',
  'Your replies are displayed as a series of short chat bubbles, like an instant-messenger',
  'conversation. You split them yourself with the `<||.../>` marker (never inside code blocks):',
  '- `<||/>` ends the current bubble. Unnamed bubbles get ids b1, b2, ... in order of appearance.',
  '- `<||s2/>` ends the current bubble and names it `s2`. **The marker names the bubble BEFORE it**;',
  '  to name the last bubble, put a marker right after it (nothing follows, so no empty bubble).',
  '- `<||1.2s/>` ends the current bubble and makes the next one appear after 1.2 seconds',
  '  (unit suffix s or ms, max 10s).',
  '- `<||-s1/>` retracts the bubble named `s1`; the user sees a retracted placeholder instead.',
  'Style: write like texting — one to three short, spoken sentences per bubble, natural and warm;',
  'avoid headings, bullet lists and code blocks unless the user asks for them. Keep the ids you',
  'invent stable for the whole conversation: the user can react to a specific bubble, and those',
  'reactions are reported back to you together with that id.'
].join('\n')

const plugin: YayaPlugin = {
  id: 'waifu',
  kind: 'builtin',
  // 默认关：只有想拟真对话的会话 / 助手才打开
  defaultEnabled: false,
  label: '拟真对话',
  labelKey: 'yaya.plugin.waifu.label',
  description: '把回答切成多条气泡、收起操作栏、显示「对方输入中」，接近真实聊天',
  descriptionKey: 'yaya.plugin.waifu.desc',
  icon: 'mdi-chat-sleep-outline',
  // 没有工具：切分全靠模型按 instructions 自己写标记
  tools: () => [],
  instructions: () => INSTRUCTIONS,
  // 只影响界面怎么显示（渲染端经 plugins-list 读到），不进工具表 / instructions
  configSchema: [
    {
      key: 'hideActions',
      type: 'boolean',
      label: '隐藏回答下方的操作栏',
      labelKey: 'yaya.plugin.waifu.cfg_hide_actions',
      description: '复制 / 重新生成 / 更多 / 用量都收起；右键或长按气泡仍能用全部操作',
      descriptionKey: 'yaya.plugin.waifu.cfg_hide_actions_desc',
      default: true
    },
    {
      key: 'process',
      type: 'select',
      label: '中途的思考与工具调用',
      labelKey: 'yaya.plugin.waifu.cfg_process',
      description: '「收起」仍可点开看；「不显示」最接近纯对话，审批与提问卡片不受影响',
      descriptionKey: 'yaya.plugin.waifu.cfg_process_desc',
      default: 'collapsed',
      options: [
        {
          value: 'collapsed',
          label: '显示（默认收起）',
          labelKey: 'yaya.plugin.waifu.proc_collapse'
        },
        { value: 'open', label: '显示并展开', labelKey: 'yaya.plugin.waifu.proc_open' },
        { value: 'hidden', label: '不显示', labelKey: 'yaya.plugin.waifu.proc_hidden' }
      ]
    },
    {
      key: 'typingLabel',
      type: 'string',
      label: '输入中提示',
      labelKey: 'yaya.plugin.waifu.cfg_typing',
      description: '运行中气泡下方的提示文字；留空用默认的「对方输入中…」',
      descriptionKey: 'yaya.plugin.waifu.cfg_typing_desc',
      default: ''
    }
  ]
}

export default plugin

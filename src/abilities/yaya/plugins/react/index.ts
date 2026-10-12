/**
 * 内置「表情回应」插件 —— **react 必须是 plugin**（R1）：整个 GitHub 式 react 特性的开关。
 * 关掉 = 消息 / 气泡下的回应条与选择器、模型收到的表情回传 note、AI 的表态工具一并消失。
 *
 * 分工：
 * - 渲染端 UI（回应条 + 选择器）经 `ui.ts` 的 `PluginUi.messageReactions` 注入，
 *   组件本体暂仍在 `components/ReactionBar.vue`（引用关系归插件，物理位置不动，避免大搬家）；
 * - 数据与纯逻辑在 `services/reactions.ts`；`yaya.reaction-set` 命令是能力级基础设施
 *   （用户动作，`agent: 'deny'`——AI 永远不能替用户表态）；
 * - 本插件提供 AI 侧工具 `react_to_user`（R2）：AI 对**用户的消息**表态（`by: 'ai'`）。
 *   语义上这是「AI 自己的动作」，与上面的 deny 不冲突。
 */
import { getBroadcast } from '../../../../main/process/broadcast'
import { getMessage, getSessionMessages, updateMessage } from '../../services/db'
import {
  mergeReactions,
  readAllReactions,
  readReactions,
  toggleReaction
} from '../../services/reactions'
import type { MessageNode } from '../../types'
import type { PluginTool, YayaPlugin } from '../../services/plugins/types'

const fail = (text: string): { content: { type: 'text'; text: string }[]; isError: boolean } => ({
  content: [{ type: 'text' as const, text }],
  isError: true
})

const reactToUser: PluginTool = {
  name: 'react_to_user',
  approval: 'auto',
  description:
    '给用户的一条消息（缺省 = 最近一条）点一个表情回应，如 👍 ❤️ 😂 🎯——你的表态会显示在消息下面并进入后续上下文；remove=true 撤下你点过的',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '一个 emoji（或已注册表情集里的图标名）' },
      message: {
        type: 'string',
        description: '消息 id；缺省或 "last" = 本会话最近一条**用户**消息'
      },
      remove: { type: 'boolean', description: 'true = 撤下你自己之前点的表情' }
    },
    required: ['key']
  },
  docs: [
    '对用户的最新消息做一个快速的可见表态（点赞 / 有意思 / 好主意）。',
    '',
    '- 只能点在**用户**的消息上（你不能给自己的回答点赞）；',
    '- 一次一个表情，同一消息重复点同一个 key = 切换（再点一次就撤下）；',
    '- 撤下也会写进上下文（`[you removed your reaction …]`），用户能看出你收回了表态；',
    '- 收敛使用：干活途中不要连续点，别让它打断正事。'
  ].join('\n'),
  async run(args, ctx) {
    const key = String(args.key ?? '').trim()
    if (!key) return fail('missing key（一个 emoji，如 👍）')
    const remove = args.remove === true

    let target: MessageNode | null = null
    const want = String(args.message ?? '').trim()
    if (want && want !== 'last') {
      target = getMessage(want)
      if (!target || target.sessionId !== ctx.sessionId) return fail('消息不在本会话')
    } else {
      const msgs = getSessionMessages(ctx.sessionId)
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          target = msgs[i]
          break
        }
      }
    }
    if (!target) return fail('本会话还没有用户消息')
    if (target.role !== 'user') return fail('react_to_user 只能点在用户的消息上')

    const before = readReactions(target.meta)
    const next = mergeReactions(
      readAllReactions(target.meta),
      undefined,
      toggleReaction(before, key, { remove, by: 'ai' })
    )
    const meta = { ...(target.meta ?? {}) }
    if (next.length) meta.reactions = next
    else delete meta.reactions
    updateMessage(target.id, { meta })
    // 与用户点表情同一条广播：界面即时刷新，无需轮询
    getBroadcast()('cockpit:yaya-reactions', {
      session: ctx.sessionId,
      message: target.id,
      reactions: next
    })
    const excerpt = target.content.replace(/\s+/g, ' ').slice(0, 60)
    return {
      content: [
        {
          type: 'text' as const,
          text: remove
            ? `已撤下 ${key}`
            : `已给用户的消息点 ${key}：“${excerpt}${target.content.length > 60 ? '…' : ''}”`
        }
      ]
    }
  }
}

/** 固定英文：不随界面语言 / 配置变（提示词缓存稳定） */
const INSTRUCTIONS = [
  '## react — reaction emojis on messages',
  "- `react_to_user` puts one of **your** reactions (a single emoji) on the user's latest",
  '  message — use it when a message deserves a quick visible response (thanks, funny,',
  '  good idea). `remove: true` takes yours back. Use it sparingly: never mid-task,',
  '  at most a couple per conversation.',
  "- The user's reactions on your messages and on their own messages are appended to",
  '  message tails you receive, e.g. `[user reacted to your segment "b2": 👍]`. When they',
  '  remove one you get `[user removed their reaction: …]` instead — read both as feedback.',
  "- Your own past reactions show up as `[you reacted to this user's message: …]`.",
  '- Never narrate these bracket lines; they are context metadata, not chat text.'
].join('\n')

const plugin: YayaPlugin = {
  id: 'react',
  kind: 'builtin',
  // 点表情是基础体验，默认开；关掉 = 特性整体消失（R1）
  defaultEnabled: true,
  label: '表情回应',
  labelKey: 'yaya.react.label',
  description:
    'GitHub 式表情回应：消息 / 气泡下点表情，取消也让 AI 知情；AI 可给你的消息表态（react_to_user）。关掉 = 整个特性消失',
  descriptionKey: 'yaya.react.desc',
  icon: 'mdi-emoticon-excited-outline',
  tools: () => [reactToUser],
  instructions: () => INSTRUCTIONS
}

export default plugin

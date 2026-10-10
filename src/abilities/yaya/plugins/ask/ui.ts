/**
 * ask 插件的界面注入：`ask_user` 的每次调用在回答里显示成一张提问卡片（toolCards），
 * 运行中可以点选 / 填写并提交，结束后显示问答记录。
 */
import { definePluginUi } from '../../components/plugin-ui'

export default definePluginUi({
  pluginId: 'ask',
  toolCards: {
    user: () => import('./AskCard.vue')
  },
  // 过程卡片里展开这次调用时，结果区也用同一张卡片的只读形态
  toolViews: {
    user: () => import('./AskCard.vue')
  }
})

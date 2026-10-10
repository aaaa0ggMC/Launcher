/**
 * deputy 插件的界面：`deputy_dispatch` 的结果显示成每个副代理一行（状态、工具调用数、轮数），
 * 展开看任务与报告。副代理运行中的工具调用在过程卡片里（每个副代理一步）。
 */
import { definePluginUi } from '../../components/plugin-ui'

export default definePluginUi({
  pluginId: 'deputy',
  toolViews: {
    dispatch: () => import('./DeputyResultView.vue')
  }
})

/**
 * search 插件的界面视图注册：把 `web_search` 的结构化结果渲染成「人能读」的结果卡片
 * （回答、引用来源、编号结果列表 + 来源引擎小标签、两行截断的摘要）。
 *
 * 只做显示层变换——数据库与发给模型的历史永远是工具原文，所以不影响提示词缓存。
 * 组件按需加载，key 是后端插件的裸工具名（wire name = `web_search`）。
 */
import { definePluginUi } from '../../components/plugin-ui'

export default definePluginUi({
  pluginId: 'search',
  toolViews: {
    search: () => import('./SearchResultView.vue')
  },
  settingsPanel: () => import('./SearchTestPanel.vue')
})

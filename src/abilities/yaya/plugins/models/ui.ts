/**
 * models 插件的界面：用量统计里的「费用」分区（usageView），设置页里的元数据列表（settingsPanel）。
 * 模型选择里的价格标签走后端 hooks.modelHint，不需要这里注册。
 */
import { definePluginUi } from '../../components/plugin-ui'

export default definePluginUi({
  pluginId: 'models',
  usageView: () => import('./UsageCost.vue'),
  settingsPanel: () => import('./MetaPanel.vue')
})

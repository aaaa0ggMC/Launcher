import { definePluginUi } from '../../components/plugin-ui'

/**
 * 信息源的渲染端：实例编辑器（第二个 `settingsView` 消费）。
 * 规则同 Regex：配置里的 JSON 驱动，保存后广播 → 工具与编辑器即时同步。
 */
export default definePluginUi({
  pluginId: 'infosource',
  settingsView: () => import('./InfoSourcesView.vue')
})

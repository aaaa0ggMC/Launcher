/**
 * widget 插件的界面视图注册：接管回答里的 ```widget 代码块。
 * 只做显示层变换——数据库与发给模型的历史永远是模型原文。
 */
import { definePluginUi } from '../../components/plugin-ui'

export default definePluginUi({
  pluginId: 'widget',
  fences: {
    widget: () => import('./WidgetView.vue')
  }
})

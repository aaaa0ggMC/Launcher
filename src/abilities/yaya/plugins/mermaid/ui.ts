/**
 * mermaid 插件的界面视图注册：接管回答里的 ```mermaid 代码块。
 *
 * 只做显示层变换——数据库与发给模型的历史永远是模型原文，所以不影响提示词缓存。
 * 组件按需加载（`import()`），首次遇到 mermaid 代码块才会把 mermaid 引擎拉下来。
 */
import { definePluginUi } from '../../components/plugin-ui'

export default definePluginUi({
  pluginId: 'mermaid',
  fences: {
    mermaid: () => import('./MermaidView.vue')
  }
})

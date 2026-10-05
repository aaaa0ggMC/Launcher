/**
 * svg 插件的界面视图注册：接管回答里的 ```svg 代码块。
 *
 * 只接 `svg` 语言——`fences` 只能按语言接管，接不了「xml 代码块里内容恰好是 <svg …>」
 * 这种情况；要覆盖它得改渲染分段的 markdown.ts（不在本插件范围）。
 *
 * 只做显示层变换——数据库与发给模型的历史永远是模型原文，所以不影响提示词缓存。
 */
import { definePluginUi } from '../../components/plugin-ui'

export default definePluginUi({
  pluginId: 'svg',
  fences: {
    svg: () => import('./SvgView.vue')
  }
})

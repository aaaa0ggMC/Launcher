/**
 * mention 插件的界面视图注册：输入框扩展（`@` 点名 + 工具栏 @ 按钮）。
 *
 * `inputExtension` 由 ChatInputBox 按插件启用状态挂载：插件被禁用 = 组件卸载 = 界面一起消失。
 * 组件按需加载（`import()`），只有 YAYA 页面第一次出现输入框时才拉到这段代码。
 */
import { definePluginUi } from '../../components/plugin-ui'

export default definePluginUi({
  pluginId: 'mention',
  inputExtension: () => import('./MentionInput.vue')
})

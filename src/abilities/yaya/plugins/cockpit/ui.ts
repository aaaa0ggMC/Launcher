/**
 * cockpit 插件的界面视图注册：把结构化工具结果渲染成「人能读」的视图。
 *
 * 只做显示层变换——数据库与发给模型的历史永远是工具原文，所以这里不影响提示词缓存。
 * 组件按需加载（`import()`），key 是后端插件的裸工具名（wire name = `cockpit_<工具名>`）。
 */
import { definePluginUi } from '../../components/plugin-ui'

export default definePluginUi({
  pluginId: 'cockpit',
  toolViews: {
    // 截图 / 输入时间线（可能一次带回多帧）→ 缩略图网格 + 放大对话框
    ui_screenshot: () => import('./ImageResultView.vue'),
    ui_input_timeline: () => import('./ImageResultView.vue'),
    // 命令表 → 可搜索列表（窄容器自动堆叠成小卡）
    commands_list: () => import('./CommandsTableView.vue'),
    // 无障碍树 → 等宽文本，[ref=eN] 高亮
    ui_snapshot: () => import('./SnapshotView.vue'),
    // 单条命令执行 → 命令名 + 成败 + 键值表 / 折叠 JSON
    command_run: () => import('./CommandRunView.vue')
  }
})

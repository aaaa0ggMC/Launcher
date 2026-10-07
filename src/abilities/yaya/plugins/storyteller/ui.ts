/**
 * storyteller 插件的界面注入：
 * - cardViews：「故事状态」卡片（每轮开头，章节 / 地点 / 张力 / 命运骰 / 出场角色）；
 * - inputExtension：输入框「+」→「故事档案」（完整设定浮层）。
 */
import { definePluginUi } from '../../components/plugin-ui'

export default definePluginUi({
  pluginId: 'storyteller',
  cardViews: {
    'story-state': () => import('./StoryStateCard.vue')
  },
  inputExtension: () => import('./StoryInput.vue')
})

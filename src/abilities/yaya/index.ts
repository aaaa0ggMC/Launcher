import { defineAsyncComponent } from 'vue'
import type { Ability } from '../../main/ui/ability'

export default {
  id: 'yaya',
  name: 'YAYA',
  icon: 'default/message-02/padding',
  category: '工具',
  keepAlive: true,
  // 安卓 App 的系统分享：文件变成附件、文字放进输入框
  shareTarget: true,
  component: defineAsyncComponent(() => import('./View.vue')),
  // 语音插件的朗读播放器（悬浮在页面上；被禁用时 YAYA 页面里内嵌显示）
  outsiders: [
    {
      key: 'tts-player',
      label: 'YAYA 朗读播放器',
      component: () => import('./plugins/speech/TtsPlayer.vue'),
      attrs: { anchor: 'bottom-right', offset: { x: 16, y: 96 } }
    },
    // C1：井字棋悬浮棋盘——一整局只有一块、原地实时更新；旁白与「AI 思考中」显示在板上。
    // 被禁用时 BoardAnchor 自动内联回退成老棋盘卡。
    {
      key: 'game-board',
      label: '对话小游戏棋盘',
      component: () => import('./plugins/interactgame/GameBoard.vue'),
      attrs: { anchor: 'bottom-left', offset: { x: 16, y: 96 }, draggable: true, persist: true }
    }
  ],
  settings: [
    {
      key: 'yaya',
      label: 'YAYA',
      icon: 'mdi-robot-outline',
      description: '助手名称、服务商与模型、工具权限',
      items: [
        {
          key: 'general',
          label: '智能体配置',
          fullWidth: true,
          component: defineAsyncComponent(() => import('./components/YayaSettingsSection.vue'))
        }
      ]
    }
  ]
} satisfies Ability

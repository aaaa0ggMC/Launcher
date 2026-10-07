/**
 * speech 插件的界面注入：
 * - inputExtension：「+」面板里的「语音输入」+ 录音条（SpeechInput.vue）；
 * - messageActions：回答操作栏里的「朗读」（player.ts，播放器是悬浮窗 `yaya.tts-player`）。
 */
import { definePluginUi } from '../../components/plugin-ui'
import { isSpeaking, speak } from './player'

export default definePluginUi({
  pluginId: 'speech',
  inputExtension: () => import('./SpeechInput.vue'),
  messageActions: [
    {
      id: 'speak',
      icon: 'mdi-volume-high',
      label: '朗读',
      labelKey: 'yaya.speech.speak',
      activeIcon: 'mdi-stop-circle-outline',
      activeLabel: '停止朗读',
      activeLabelKey: 'yaya.speech.player.stop',
      visible: (ctx) => !!ctx.text.trim(),
      active: (ctx) => isSpeaking(ctx.messageId),
      run: (ctx) => speak(ctx.messageId, ctx.text)
    }
  ]
})

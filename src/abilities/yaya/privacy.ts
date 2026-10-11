/**
 * YAYA 的隐私 scope（隐私 SDK：src/main/process/privacy.ts）。
 * 安卓控制插件（plugins/android）：手机上的这些数据都能关联到真人 → sensitive；
 * SecretPlugin（plugins/secret）：用户存的 Secret 真值 → secret。
 */
import { definePrivacyScopes } from '../../main/process/privacy'

export const P = definePrivacyScopes('yaya', {
  // 用户在消息 / 气泡上的表情回应：本地个人表达，默认对 AI 可见（回传时由
  // sanitizeHistory 拼进对应 assistant 消息，命令本身 agent 不可调）
  reactions: {
    level: 'personal',
    label: 'yaya.privacy.reactions',
    description: 'yaya.privacy.reactions_desc'
  },
  android_location: {
    level: 'sensitive',
    label: 'yaya.privacy.android_location',
    description: 'yaya.privacy.android_location_desc'
  },
  android_camera: {
    level: 'sensitive',
    label: 'yaya.privacy.android_camera',
    description: 'yaya.privacy.android_camera_desc'
  },
  android_clipboard: {
    level: 'sensitive',
    label: 'yaya.privacy.android_clipboard',
    description: 'yaya.privacy.android_clipboard_desc'
  },
  android_screen: {
    level: 'sensitive',
    label: 'yaya.privacy.android_screen',
    description: 'yaya.privacy.android_screen_desc'
  },
  // SecretPlugin 的真值（「在回答里显示真值」时出现在界面上）：凭据，AI 永远不可读
  secret_value: {
    level: 'secret',
    label: 'yaya.privacy.secret_value',
    description: 'yaya.privacy.secret_value_desc'
  }
})

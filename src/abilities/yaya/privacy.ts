/**
 * YAYA 的隐私 scope（隐私 SDK：src/main/process/privacy.ts）。
 * 目前只有安卓控制插件（plugins/android）用到：手机上的这些数据都能关联到真人 → sensitive。
 */
import { definePrivacyScopes } from '../../main/process/privacy'

export const P = definePrivacyScopes('yaya', {
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
  }
})

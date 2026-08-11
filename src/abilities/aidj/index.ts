import { defineAsyncComponent, markRaw } from 'vue'
import type { Ability } from '../types'
import { registerBtView } from '../../main/ui/bt-views'
import ContinuousView from './components/ContinuousView.vue'
import BtChatView from './components/BtChatView.vue'

registerBtView('continuous', () => ({ component: markRaw(ContinuousView) }))
registerBtView('chat', () => ({ component: markRaw(BtChatView) }))

/**
 * AIDJ registers TWO abilities from one folder:
 *  - `aidj`          — the main AI DJ chat / continuous playback page
 *  - `aidj-lyrics`   — a full-page lyrics display that fully depends on AIDJ's
 *                      DBus binding + lyric store (its commands are all `aidj.*`).
 */
export default [
  {
    id: 'aidj',
    name: 'AI DJ',
    icon: 'gi:audio-waves',
    category: '工具',
    keepAlive: true,
    component: defineAsyncComponent(() => import('./View.vue')),
    settings: [
      {
        key: 'aidj',
        label: 'AI DJ',
        icon: 'mdi-radio-tower',
        description: 'AI DJ 的 API 密钥、模型选择、播放偏好等配置',
        items: [
          {
            key: 'general',
            label: 'AI DJ 配置',
            fullWidth: true,
            component: defineAsyncComponent(() => import('./components/AidjSettingsSection.vue'))
          }
        ]
      }
    ]
  },
  {
    id: 'aidj-lyrics',
    name: '歌词',
    icon: 'default/music/padding',
    category: '工具',
    keepAlive: false,
    component: defineAsyncComponent(() => import('./LyricsView.vue')),
    settings: [
      {
        key: 'lyrics-page',
        label: 'AIDJ Lyrics',
        icon: 'mdi-music-note-outline',
        description: '歌词页显示模式（卡拉OK / 滚动）与排版',
        keywords: ['歌词', 'lyrics', '卡拉OK', '滚动', '字体', '排版'],
        items: [
          {
            key: 'display',
            label: '歌词页配置',
            icon: 'mdi-tune-variant',
            description: '卡拉OK 逐字高亮、歌词滚动跟随、字号/行高/字重/位置偏移',
            keywords: ['卡拉OK', 'karaoke', '滚动', '字体', '字号', '行高', '字重', '偏移'],
            fullWidth: true,
            component: defineAsyncComponent(
              () => import('./components/LyricsPageSettingsSection.vue')
            )
          }
        ]
      }
    ]
  }
] satisfies Ability[]

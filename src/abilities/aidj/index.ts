import { defineAsyncComponent, markRaw } from 'vue'
import type { Ability } from '../../main/ui/ability'
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
  },
  {
    id: 'aidj-player',
    name: '播放器',
    icon: 'default/headset/padding',
    category: '工具',
    keepAlive: true,
    component: defineAsyncComponent(() => import('./PlayerView.vue')),
    settings: [
      {
        key: 'player',
        label: '播放器',
        icon: 'mdi-play-speed',
        description:
          '内置播放器的音频处理与遥控配置（淡入淡出 / EQ / 倍速 / 音量 / 频谱 / 局域网遥控）',
        keywords: [
          '播放器',
          'player',
          '淡入淡出',
          'crossfade',
          'EQ',
          '均衡器',
          '倍速',
          '音量',
          '频谱',
          '局域网',
          '遥控',
          'web remote'
        ],
        items: [
          {
            key: 'playback',
            label: '内置播放器配置',
            description: '淡入淡出时长、均衡器预设、默认倍速/音量、频谱与局域网遥控端口',
            keywords: [
              '播放器',
              'player',
              '淡入淡出',
              'crossfade',
              'EQ',
              '均衡器',
              '倍速',
              '音量',
              '频谱',
              '局域网',
              '遥控'
            ],
            fullWidth: true,
            component: defineAsyncComponent(() => import('./components/PlayerSettingsSection.vue'))
          }
        ]
      }
    ]
  }
] satisfies Ability[]

import { defineAsyncComponent } from 'vue'
import type { Ability } from '../../main/ui/ability'

export default {
  id: 'settings',
  name: '设置',
  icon: 'gi:settings',
  category: '系统',
  component: defineAsyncComponent(() => import('./View.vue')),
  settings: [
    {
      key: 'appearance',
      label: '外观',
      icon: 'mdi-palette-outline',
      description: '主题、界面缩放、窗口边框、背景与 Fuse 蒙层、启动与关于',
      keywords: ['外观', '显示', '界面', 'appearance'],
      items: [
        {
          key: 'theme',
          label: '主题',
          icon: 'mdi-palette',
          description: '多套配色方案 / 跟随系统',
          keywords: [
            '深色',
            '纯黑',
            '亮色',
            '月光',
            '森林',
            '极光',
            '玫瑰',
            '石板',
            '羊皮纸',
            '跟随系统',
            '明亮',
            'dark',
            'theme',
            'color scheme'
          ],
          component: defineAsyncComponent(() => import('./items/ThemeSection.vue'))
        },
        {
          key: 'zoom',
          label: '界面缩放',
          icon: 'mdi-magnify-plus-outline',
          description: '整体 UI 等比缩放比例',
          keywords: ['缩放', '大小', '比例', 'zoom', 'scale'],
          component: defineAsyncComponent(() => import('./items/ZoomSection.vue'))
        },
        {
          key: 'window',
          label: '窗口',
          icon: 'mdi-window-maximize',
          description: '无边框、圆角、背景与 Fuse 蒙层',
          keywords: ['无边框', '圆角', '背景', '图片', '壁纸', '蒙层', '模糊', '透明', '不透明'],
          fullWidth: true,
          component: defineAsyncComponent(() => import('./items/WindowSection.vue'))
        },
        {
          key: 'animations',
          label: '界面动画',
          icon: 'mdi-motion-play-outline',
          description: '现代动效总开关、切换能力页面的过渡动画',
          keywords: [
            '动画',
            '过渡',
            '切换',
            '淡入淡出',
            '滑动',
            '现代动效',
            'transition',
            'motion'
          ],
          component: defineAsyncComponent(() => import('./items/AnimationSection.vue'))
        },
        {
          key: 'language',
          label: '语言',
          icon: 'mdi-translate',
          description: 'Interface language (中文 / English)',
          keywords: ['语言', 'language', '翻译', 'translate', 'i18n'],
          component: defineAsyncComponent(() => import('./items/LanguageSection.vue'))
        },
        {
          key: 'sidebar',
          label: '侧边栏',
          icon: 'mdi-view-dashboard-outline',
          description: '侧栏排序规则：字母序 / 使用频次 / 最近使用',
          keywords: ['侧边栏', '排序', '顺序', '频次', '最近', 'sidebar', 'sort', 'frequency'],
          component: defineAsyncComponent(() => import('./items/SidebarSection.vue'))
        },
        {
          key: 'launch',
          label: '启动',
          icon: 'mdi-rocket-launch-outline',
          description: '启动前确认行为',
          keywords: ['启动', '确认', 'confirm', '弹窗'],
          component: defineAsyncComponent(() => import('./items/LaunchSection.vue'))
        },
        {
          key: 'about',
          label: '关于',
          icon: 'mdi-information-outline',
          description: '版本与技术栈',
          keywords: ['版本', '关于', 'electron', 'vue', 'vuetify'],
          component: defineAsyncComponent(() => import('./items/AboutSection.vue'))
        }
      ]
    },
    {
      key: 'abilities',
      label: '能力',
      icon: 'mdi-puzzle-outline',
      description: '运行时启用/禁用能力（临时，不持久化；禁用后侧边栏与命令即时隐藏）',
      keywords: ['能力', '启用', '禁用', 'enable', 'disable', 'ability'],
      items: [
        {
          key: 'ability-toggle',
          label: '能力开关',
          icon: 'mdi-toggle-switch-outline',
          description: '切换各能力的可用状态',
          keywords: ['启用', '禁用', 'enable', 'disable', 'toggle'],
          fullWidth: true,
          component: defineAsyncComponent(() => import('./items/AbilityToggleSection.vue'))
        }
      ]
    }
  ]
} satisfies Ability

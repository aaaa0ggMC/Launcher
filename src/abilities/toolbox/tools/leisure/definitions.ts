/**
 * 休闲/效率类工具定义（纯数据，渲染端可直接导入）。
 * 这里只放 metadata：执行逻辑在 ./service.ts，界面在 LeisurePanel.vue。
 */
import type { ToolDefinition } from '../../types'

export const definitions: ToolDefinition[] = [
  {
    id: 'pomodoro',
    title: '番茄钟',
    titleEn: 'Pomodoro Timer',
    description:
      '本地番茄工作法计时器：按「专注 → 休息」循环计时，用结束时刻倒计时避免漂移，可暂停/恢复/重置并统计完成数。不联网、不发通知。',
    descriptionEn:
      'Local pomodoro timer: cycles focus and break phases with deadline-based countdown (drift-free), pause/resume/reset, and completion stats. Offline, no notifications.',
    category: 'leisure',
    icon: 'mdi-timer-outline',
    keywords: [
      '番茄钟',
      '番茄',
      '专注',
      '休息',
      '计时',
      '计时器',
      '工作法',
      '效率',
      'pomodoro',
      'timer',
      'focus',
      'break',
      'productivity'
    ],
    fields: [
      {
        key: 'focusMinutes',
        label: '专注分钟',
        labelEn: 'Focus minutes',
        type: 'number',
        default: 25,
        min: 1,
        max: 180,
        required: true,
        placeholder: '25',
        hint: '每轮专注时长（分钟）'
      },
      {
        key: 'breakMinutes',
        label: '休息分钟',
        labelEn: 'Break minutes',
        type: 'number',
        default: 5,
        min: 1,
        max: 60,
        required: true,
        placeholder: '5',
        hint: '每轮专注后的休息时长（分钟）'
      }
    ],
    view: 'pomodoro'
  }
]

import { defineAsyncComponent } from 'vue'
import type { Component } from 'vue'

/**
 * Background presets — registered like abilities. Each preset is a small
 * component rendered inside <BackgroundLayer>; adding a new one only needs a
 * component file + an entry here. The active preset comes from config
 * `window.background` and persists across restarts.
 */
export interface BackgroundDef {
  id: string
  name: string
  description: string
  component: Component
}

export const backgrounds: BackgroundDef[] = [
  {
    id: 'transparent',
    name: '透明',
    description: '不绘制背景，仅由 Fuse 半透明蒙层提供底色',
    component: defineAsyncComponent(() => import('./transparent.vue'))
  },
  {
    id: 'image',
    name: '图片',
    description: '自定义图片路径，可高斯模糊',
    component: defineAsyncComponent(() => import('./image.vue'))
  },
  {
    id: 'wallpaper',
    name: '桌面壁纸',
    description: '自动读取 KDE 桌面壁纸，可高斯模糊',
    component: defineAsyncComponent(() => import('./wallpaper.vue'))
  }
]

export function findBackground(id: string): BackgroundDef | undefined {
  return backgrounds.find((b) => b.id === id)
}

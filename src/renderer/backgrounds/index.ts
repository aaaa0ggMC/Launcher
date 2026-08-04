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
    name: 'Transparent',
    description: 'No background drawn; Fuse translucent overlay provides the base tint.',
    component: defineAsyncComponent(() => import('./transparent.vue'))
  },
  {
    id: 'image',
    name: 'Image',
    description: 'Custom image path, supports Gaussian blur.',
    component: defineAsyncComponent(() => import('./image.vue'))
  },
  {
    id: 'wallpaper',
    name: 'Desktop Wallpaper',
    description: 'Automatically reads the KDE desktop wallpaper, supports Gaussian blur.',
    component: defineAsyncComponent(() => import('./wallpaper.vue'))
  }
]

export function findBackground(id: string): BackgroundDef | undefined {
  return backgrounds.find((b) => b.id === id)
}

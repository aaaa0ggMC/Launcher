import { defineAsyncComponent } from 'vue'
import type { BackgroundDef } from '../types'

export default {
  id: 'wallpaper',
  name: 'Desktop Wallpaper',
  description: 'Automatically reads the KDE desktop wallpaper, supports Gaussian blur.',
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies BackgroundDef

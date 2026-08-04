import { defineAsyncComponent } from 'vue'
import type { BackgroundDef } from '../types'

export default {
  id: 'image',
  name: 'Image',
  description: 'Custom image path, supports Gaussian blur.',
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies BackgroundDef

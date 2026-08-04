import { defineAsyncComponent } from 'vue'
import type { BackgroundDef } from '../types'

export default {
  id: 'transparent',
  name: 'Transparent',
  description: 'No background drawn; Fuse translucent overlay provides the base tint.',
  component: defineAsyncComponent(() => import('./View.vue'))
} satisfies BackgroundDef

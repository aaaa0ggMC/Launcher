import type { Component } from 'vue'

/** One background preset, default-exported by `background/<type>/index.ts`. */
export interface BackgroundDef {
  id: string
  name: string
  description: string
  component: Component
}

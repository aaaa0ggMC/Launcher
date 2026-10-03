import type { Component } from 'vue'

/** One background preset, default-exported by `background/<type>/index.ts`. */
export interface BackgroundDef {
  id: string
  name: string
  description: string
  component: Component
  /** 需要的宿主能力（`window.cockpit.hasCap` 的 id）；宿主不具备时该背景不出现、已存配置回落 transparent */
  requires?: string[]
}

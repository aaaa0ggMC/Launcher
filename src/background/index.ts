import type { BackgroundDef } from './types'

/**
 * Background loader — collects every `background/<type>/index.ts` orchestrator.
 * Each preset is a small component rendered inside <BackgroundLayer>; adding a
 * new one only needs a folder (`index.ts` + `View.vue`). The active preset
 * comes from config `window.background` and persists across restarts.
 */
const backgroundModules = import.meta.glob<{ default: BackgroundDef }>('./*/index.ts', {
  eager: true
})

export const backgrounds: BackgroundDef[] = Object.keys(backgroundModules)
  .sort()
  .map((key) => backgroundModules[key].default)
  .filter((b): b is BackgroundDef => Boolean(b?.id))

/** 当前宿主是否满足该背景的能力要求（网页模式没有桌面壁纸等） */
export function isBackgroundAvailable(b: BackgroundDef): boolean {
  return (b.requires ?? []).every((cap) => window.cockpit.hasCap(cap))
}

export function findBackground(id: string): BackgroundDef | undefined {
  return backgrounds.find((b) => b.id === id)
}

export type { BackgroundDef }

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

export function findBackground(id: string): BackgroundDef | undefined {
  return backgrounds.find((b) => b.id === id)
}

export type { BackgroundDef }

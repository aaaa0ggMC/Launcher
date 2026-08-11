import type { Component } from 'vue'

/**
 * Child-window view registry — every `.vue` in this folder is a possible root
 * for a managed child window. The main process passes `?view=<key>` and the
 * renderer mounts the matching component here (never an arbitrary path).
 *
 * Two sources feed the registry:
 *  - framework-built windows: `<key>.vue` in this folder
 *  - ability-owned windows: `<abilityId>/<File>.vue` under the ability folder
 *    `windows/` (convention — e.g. the AIDJ lyrics overlay lives in aidj).
 * The view key is resolved against both.
 */
export type WindowViewLoader = () => Promise<{ default: Component }>

const builtinViews = import.meta.glob('./*.vue') as Record<string, WindowViewLoader>

const abilityViews = import.meta.glob('../../../abilities/*/windows/*.vue') as Record<
  string,
  WindowViewLoader
>

/** Resolve a child-window view key to its lazy component loader. */
export function resolveWindowView(view: string): WindowViewLoader | undefined {
  const builtinKey = './' + view + '.vue'
  const abilityKey = '../../../abilities/' + view + '.vue'
  const builtin = builtinViews[builtinKey]
  if (builtin) return builtin
  return abilityViews[abilityKey]
}

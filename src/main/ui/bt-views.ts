import { markRaw } from 'vue'
import type { Component } from 'vue'
import type { BtOutputMessage, BtTaskInfo } from '@shared/types'
import BtLogView from './components/BackgroundTaskViews/BtLogView.vue'
import BtResponseView from './components/BackgroundTaskViews/BtResponseView.vue'

/**
 * Background task view registry — architectural.
 *
 * Each background task carries a `view` id. The global panel resolves it here
 * and renders the matching component in the detail area. `log` (the default
 * console) is built in; any ability can register a custom view (e.g. a
 * structured response view) via `registerBtView`.
 *
 * Views receive the task + its messages and render them however they like;
 * the lifecycle toolbar (stop/kill/remove) is rendered by the panel itself and
 * is NOT part of a view.
 */
export interface BtViewFactoryInput {
  task: BtTaskInfo
  messages: BtOutputMessage[]
}

type ViewFactory = (input: BtViewFactoryInput) => {
  component: Component
  props?: Record<string, unknown>
}

const views = new Map<string, ViewFactory>()

export function registerBtView(id: string, factory: ViewFactory): void {
  views.set(id, factory)
}

// Built-in default: log console (existing behavior).
registerBtView('log', () => ({ component: markRaw(BtLogView) }))

// Structured response view — renders TransformResults pushed by the task as
// structured messages. Registered globally so any ability can use it.
registerBtView('response', () => ({ component: markRaw(BtResponseView) }))

/** Resolve the component for a task's view id. */
export function resolveBtView(task: BtTaskInfo): {
  component: Component
  props?: Record<string, unknown>
} {
  const factory = views.get(task.view) ?? views.get('log')!
  return factory({ task, messages: [] })
}

export function hasBtView(id: string): boolean {
  return views.has(id)
}

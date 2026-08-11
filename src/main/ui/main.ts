import { createApp } from 'vue'
import type { Component } from 'vue'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import '@mdi/font/css/materialdesignicons.css'
import 'vuetify/styles'
import './styles/global.css'
import App from './App.vue'
import { windowViews } from './windows'
import { buildThemeDefinitions, DEFAULT_SCHEME_ID } from './color_schemes'

const vuetify = createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: DEFAULT_SCHEME_ID,
    themes: buildThemeDefinitions()
  },
  defaults: {
    global: {
      density: 'compact'
    },
    VCard: { rounded: 'lg' },
    VDialog: { rounded: 'lg' }
  }
})

// ---------------------------------------------------------------------------
// Renderer → main log forwarding: console.warn/error + uncaught errors land in
// the main-process log pipeline (logs ability can then show them).
// ---------------------------------------------------------------------------
// Cooldown guard against a log loop: if a renderer error was just forwarded,
// the broadcast → handler → console.error round-trip could re-forward the same
// message indefinitely. Dropping an identical message within 1s breaks it.
let lastPost = { msg: '', ts: 0 }
function postLog(level: 'warn' | 'error', args: unknown[]): void {
  const message = args
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ')
    .slice(0, 2000)
  if (!message) return
  // Skip known-benign browser noise so the log stays meaningful.
  if (/ResizeObserver loop/.test(message)) return
  const now = Date.now()
  if (lastPost.msg === message && now - lastPost.ts < 1000) return
  lastPost = { msg: message, ts: now }
  window.cockpit.command('logs.post', { level, scope: 'renderer', message }).catch(() => {})
}

function safeStringify(a: unknown): string {
  try {
    if (a instanceof Error) return a.stack ?? a.message
    if (typeof a === 'object' && a !== null) return JSON.stringify(a)
    return String(a)
  } catch {
    return String(a)
  }
}

function forwardConsoleErrors(): void {
  const origError = console.error
  const origWarn = console.warn
  console.error = (...args: unknown[]) => {
    origError(...args)
    postLog('error', args)
  }
  console.warn = (...args: unknown[]) => {
    origWarn(...args)
    postLog('warn', args)
  }
  window.addEventListener('error', (e) => postLog('error', [e.error ?? e.message]))
  window.addEventListener('unhandledrejection', (e) => postLog('error', [e.reason]))
}

forwardConsoleErrors()

/**
 * Root switch: the SAME renderer entry serves both the main shell and every
 * managed child window. A child window loads with `?view=<key>`; if the key
 * exists in the windows/ glob registry we mount that component instead of the
 * full App shell (sidebar / background layers / quit guard are all skipped).
 */
async function mountRoot(): Promise<void> {
  let root: Component = App
  const view = new URLSearchParams(location.search).get('view')
  if (view) {
    const loader = windowViews[`./${view}.vue`]
    if (loader) {
      const mod = (await loader()) as { default: Component }
      root = mod.default
    }
  }
  createApp(root).use(vuetify).mount('#app')
}

void mountRoot()

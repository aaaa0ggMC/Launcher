import { createApp } from 'vue'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import '@mdi/font/css/materialdesignicons.css'
import 'vuetify/styles'
import './styles/global.css'
import App from './App.vue'
import { dark, pureblack } from './styles/theme'

const vuetify = createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: 'dark',
    themes: { dark, pureblack }
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

createApp(App).use(vuetify).mount('#app')

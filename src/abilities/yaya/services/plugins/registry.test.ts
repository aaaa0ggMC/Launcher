import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { before, beforeEach, it } from 'node:test'
import type { YayaConfig } from '../../types'
import type { YayaPlugin } from './types'

process.env.HOME = mkdtempSync('/tmp/yaya-registry-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`

let registry: typeof import('./registry')
before(async () => {
  assert.ok(process.env.HOME?.startsWith('/tmp/'), 'HOME must be isolated under /tmp/')
  registry = await import('./registry')
})
beforeEach(() => registry.__resetPluginsForTest())

const config = { disabledTools: [], pluginEnabled: {} } as unknown as YayaConfig
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function plugin(run: () => Promise<unknown> = async () => 'ok'): YayaPlugin {
  return {
    id: 'demo',
    kind: 'builtin',
    label: 'Demo',
    description: '',
    tools: () => [{ name: 'action', description: '', parameters: {}, run }]
  }
}

it('abort rejects promptly even when a tool ignores the signal; pre-abort never starts it', async () => {
  let calls = 0
  const p = plugin(() => {
    calls++
    return new Promise(() => {})
  })
  const resolved = { plugin: p, tool: p.tools()[0], wireName: 'demo_action' }
  const ac = new AbortController()
  const run = registry.runPluginTool(resolved, {}, { sessionId: 'test', signal: ac.signal })
  ac.abort(new Error('stopped'))
  await assert.rejects(run, /stopped/)
  await assert.rejects(
    registry.runPluginTool(resolved, {}, { sessionId: 'test', signal: ac.signal }),
    /stopped/
  )
  assert.equal(calls, 1)
})

it('stopping during start closes the late connection before a subsequent restart', async () => {
  const ready = deferred()
  let starts = 0
  let stops = 0
  const p = {
    ...plugin(),
    start: async () => {
      starts++
      await ready.promise
    },
    stop: async () => {
      stops++
    }
  }
  registry.registerPlugin(p)
  registry.refreshPlugins(config)
  const resolving = registry.resolveTools(config)
  await tick()
  const stopping = registry.stopAllPlugins()
  ready.resolve()
  await Promise.all([resolving, stopping])
  assert.equal(stops, 1)
  await registry.resolveTools(config)
  assert.equal(starts, 2)
})

it('replacement with the same id starts its own connection and disabled tools stay absent', async () => {
  let active = plugin()
  let starts = 0
  active.start = async () => {
    starts++
  }
  registry.registerPluginProvider({ id: 'test', sync: () => [active] })
  registry.refreshPlugins(config)
  await registry.resolveTools(config)
  active = {
    ...plugin(),
    start: async () => {
      starts++
    }
  }
  registry.refreshPlugins(config)
  assert.equal(
    (await registry.resolveTools({ ...config, disabledTools: ['demo_action'] })).length,
    0
  )
  assert.equal(starts, 2)
})

it('system file and shell tools cannot bypass the execution guard', async () => {
  const privacy = await import('../../../../main/process/privacy')
  const system = (await import('../../plugins/system/index')).default
  privacy.setConsentPresenter((pending) => {
    for (const request of pending) privacy.decideConsent(request.id, 'deny')
  })
  for (const name of ['read_file', 'write_file', 'run_bash']) {
    const tool = system.tools().find((t) => t.name === name)!
    await assert.rejects(
      privacy.withOrigin({ kind: 'local-agent', session: 'denied' }, () =>
        tool.run(
          { path: '/unused', command: 'unused' },
          { sessionId: 'test', pluginId: 'system', signal: new AbortController().signal }
        )
      )
    )
  }
})

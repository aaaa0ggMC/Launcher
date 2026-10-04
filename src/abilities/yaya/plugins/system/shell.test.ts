import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { it } from 'node:test'
import { join } from 'node:path'
import { runShell } from './shell'

it(
  'cancelling a shell kills its child before a delayed write',
  { skip: process.platform === 'win32' },
  async () => {
    const home = mkdtempSync('/tmp/yaya-shell-test-')
    assert.ok(home.startsWith('/tmp/'))
    const ac = new AbortController()
    const run = runShell('sleep 0.4; touch sentinel', {
      cwd: home,
      timeout: 5000,
      maxBuffer: 1024,
      signal: ac.signal
    })
    setTimeout(() => ac.abort(), 30)
    await assert.rejects(run, /aborted/)
    await new Promise((r) => setTimeout(r, 450))
    assert.equal(existsSync(join(home, 'sentinel')), false)
  }
)

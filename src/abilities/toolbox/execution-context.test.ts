import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { toolSignal, withToolSignal, trackToolProcess, killToolProcess } from './execution-context'

test('tool cancellation context remains isolated across concurrent jobs', async () => {
  const a = new AbortController()
  const b = new AbortController()
  await Promise.all(
    [a, b].map((controller) =>
      withToolSignal(controller.signal, async () => {
        await Promise.resolve()
        assert.equal(toolSignal(), controller.signal)
      })
    )
  )
  assert.equal(toolSignal(), undefined)
})
test('cancelled file jobs kill their own process group', { timeout: 4000 }, async () => {
  const controller = new AbortController()
  await withToolSignal(controller.signal, async () => {
    const detached = process.platform !== 'win32'
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached,
      stdio: 'ignore'
    })
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    trackToolProcess(child, detached)
    try {
      controller.abort()
      await closed
      assert.equal(child.killed || child.signalCode !== null, true)
    } finally {
      killToolProcess(child, detached)
    }
  })
})

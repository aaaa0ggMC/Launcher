import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPromptVars, collectPromptVars } from './prompt-vars'

test('fills known variables and keeps unknown braces', async () => {
  const prompt = 'I am {name} on {system}, {date} {time} ({weekday}), battery {power}. {unknown} {}'
  let powerCalls = 0
  const vars = await collectPromptVars(prompt, {
    name: 'YAYA',
    model: 'm1',
    now: new Date(2026, 9, 6, 9, 5),
    readSystem: () => 'Arch Linux',
    readPower: async () => {
      powerCalls++
      return '80% (Charging)'
    }
  })
  assert.equal(
    applyPromptVars(prompt, vars),
    'I am YAYA on Arch Linux, 2026-10-06 09:05 (Tuesday), battery 80% (Charging). {unknown} {}'
  )
  assert.equal(powerCalls, 1)
})

test('skips slow readers when the prompt does not use them', async () => {
  let called = false
  const vars = await collectPromptVars('Hello {name}', {
    name: 'YAYA',
    readPower: async () => {
      called = true
      return 'x'
    },
    readSystem: () => {
      called = true
      return 'x'
    }
  })
  assert.equal(called, false)
  assert.equal(vars.power, undefined)
})

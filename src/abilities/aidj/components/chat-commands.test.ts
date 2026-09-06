import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CHAT_COMMANDS, filterChatCommands, applyChatCommand } from './chat-commands'

describe('AIDJ chat-commands', () => {
  it('has expected predefined commands', () => {
    const names = CHAT_COMMANDS.map((c) => c.name)
    assert.ok(names.includes('random'))
    assert.ok(names.includes('pr'))
    assert.ok(names.includes('explore'))
    assert.ok(names.includes('ftop'))
    assert.ok(names.includes('analyse'))
    assert.ok(names.includes('filter'))
    assert.ok(names.includes('persist'))
    assert.ok(names.includes('persist-stop'))
  })

  it('filterChatCommands returns empty list when input does not start with /', () => {
    assert.deepEqual(filterChatCommands(''), [])
    assert.deepEqual(filterChatCommands('hello /random'), [])
    assert.deepEqual(filterChatCommands('random'), [])
  })

  it('filterChatCommands matches prefix of commands', () => {
    const r1 = filterChatCommands('/')
    assert.equal(r1.length, CHAT_COMMANDS.length)

    const r2 = filterChatCommands('/p')
    const names = r2.map((c) => c.name)
    assert.ok(names.includes('pr'))
    assert.ok(names.includes('persist'))
    assert.ok(names.includes('persist-stop'))
    assert.ok(!names.includes('random'))

    const r3 = filterChatCommands('/ran')
    assert.equal(r3.length, 1)
    assert.equal(r3[0]?.name, 'random')
  })

  it('filterChatCommands pins to exact command when arguments are typed', () => {
    const res = filterChatCommands('/random 10')
    assert.equal(res.length, 1)
    assert.equal(res[0]?.name, 'random')

    const persistRes = filterChatCommands('/persist some prompt')
    assert.equal(persistRes.length, 1)
    assert.equal(persistRes[0]?.name, 'persist')
  })

  it('filterChatCommands returns empty for unknown command', () => {
    const res = filterChatCommands('/nonexistent')
    assert.deepEqual(res, [])
  })

  it('applyChatCommand replaces leading token and preserves args', () => {
    const cmd = CHAT_COMMANDS.find((c) => c.name === 'random')!
    assert.ok(cmd)

    assert.equal(applyChatCommand('/ran', cmd), '/random ')
    assert.equal(applyChatCommand('/ran 5', cmd), '/random 5')
    assert.equal(applyChatCommand('/r 20', cmd), '/random 20')
  })
})

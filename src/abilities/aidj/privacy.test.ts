import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'node:test'
import type { CommandSpec } from '../../main/process/commands/types'
import { canonicalAidjName, withPrivacy } from './privacy'

const spec = (name: string): CommandSpec => ({ name, description: '', run: () => null })

it('快捷别名与原命令套同一份隐私声明（别名不能绕过 agent: deny）', () => {
  const [dot, dash] = withPrivacy([spec('aidj.approve-ncm'), spec('aidj-approve-ncm')])
  assert.equal(dot.privacy?.agent, 'deny')
  assert.deepEqual(dash.privacy, dot.privacy)
})

it('源码里所有 aidj-xxx 别名都映射到有声明的原命令（或原命令本身没有声明）', () => {
  // 别名的 run 直接调原命令的 run，绕过注册表中间件：凡是原命令有声明的，别名也必须拿到
  const dir = join(import.meta.dirname, 'commands')
  const src = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
  const aliases = [...src.matchAll(/name: '(aidj-[a-z0-9-]+)'/g)].map((m) => m[1])
  assert.ok(aliases.length >= 2)
  for (const alias of aliases) {
    const [target, wrapped] = withPrivacy([spec(canonicalAidjName(alias)), spec(alias)])
    assert.deepEqual(wrapped.privacy, target.privacy, alias)
  }
})

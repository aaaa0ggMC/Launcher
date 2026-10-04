import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  closeOutsider,
  isOutsiderOpen,
  openOutsider,
  registerShellOutsider,
  resolveOutsiderPolicy,
  setOutsiderPolicy,
  syncAbilityOutsiders,
  visibleOutsiders
} from './outsider'

const comp = async (): Promise<{ default: object }> => ({ default: {} })

test('Outsider SDK：声明 / 策略 / 外壳悬浮窗不受名单影响', () => {
  registerShellOutsider({ key: 'presence', label: 'p', component: comp })
  syncAbilityOutsiders([
    { owner: 'aidj', decl: { key: 'mini', label: 'mini', component: comp } },
    { owner: 'yarj', decl: { key: 'map', label: 'map', component: comp } }
  ])

  // 未声明的 id 打不开
  assert.equal(openOutsider('aidj.nope'), false)

  assert.equal(openOutsider('aidj.mini', { a: 1 }), true)
  assert.equal(openOutsider('yarj.map'), true)
  assert.equal(openOutsider('shell.presence'), true)
  assert.equal(visibleOutsiders.value.length, 3)

  // 单独禁止某个能力：已打开的立即隐藏，新的打不开；外壳的不受影响
  setOutsiderPolicy({ enabled: true, blocked: ['aidj'] })
  assert.deepEqual(visibleOutsiders.value.map((x) => x.entry.id).sort(), [
    'shell.presence',
    'yarj.map'
  ])
  closeOutsider('aidj.mini')
  assert.equal(openOutsider('aidj.mini'), false)

  // 总开关关闭：只剩外壳的
  setOutsiderPolicy({ enabled: false })
  assert.deepEqual(
    visibleOutsiders.value.map((x) => x.entry.id),
    ['shell.presence']
  )

  // 能力被移除（禁用）→ 它打开中的悬浮窗一并关掉，外壳的保留
  setOutsiderPolicy({})
  syncAbilityOutsiders([])
  assert.equal(isOutsiderOpen('yarj.map'), false)
  assert.equal(isOutsiderOpen('shell.presence'), true)
})

test('Outsider 策略归一化', () => {
  assert.deepEqual(resolveOutsiderPolicy(undefined), { enabled: true, blocked: [] })
  assert.deepEqual(resolveOutsiderPolicy({ enabled: false, blocked: ['x', 1] }), {
    enabled: false,
    blocked: ['x', '1']
  })
})

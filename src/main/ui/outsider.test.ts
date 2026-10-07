import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  closeOutsider,
  dockSideFor,
  dockSlot,
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

test('Outsider 贴边：拖出屏幕边 / 指针贴边才贴，取越界最多的那条边', () => {
  const view = { width: 1000, height: 800 }
  const mid = { x: 500, y: 400 }
  // 在屏幕中间：不贴
  assert.equal(dockSideFor({ left: 300, top: 300, width: 200, height: 100 }, mid, view), null)
  // 拖出左边 30px
  assert.equal(dockSideFor({ left: -30, top: 300, width: 200, height: 100 }, mid, view), 'left')
  // 右边
  assert.equal(dockSideFor({ left: 850, top: 300, width: 200, height: 100 }, mid, view), 'right')
  // 窗口没越界，但指针贴着下边
  assert.equal(
    dockSideFor({ left: 300, top: 600, width: 200, height: 100 }, { x: 400, y: 795 }, view),
    'bottom'
  )
  // 左上角两边都越界：越得多的那条
  assert.equal(dockSideFor({ left: -50, top: -10, width: 200, height: 100 }, mid, view), 'left')
  assert.equal(dockSideFor({ left: -5, top: -60, width: 200, height: 100 }, mid, view), 'top')
})

test('Outsider 贴边：同一条边上几个悬浮窗沿边错开', () => {
  // 没有邻居：原位
  assert.equal(dockSlot(300, 100, [], 8, 800), 300)
  // 和 [280, 380) 重叠：挪到最近的空位（上方 280-100-6 = 174 比下方 386 远，选下方）
  assert.equal(dockSlot(300, 100, [{ start: 280, size: 100 }], 8, 800), 386)
  assert.equal(dockSlot(200, 100, [{ start: 280, size: 100 }], 8, 800), 174)
  // 夹在范围内
  assert.equal(dockSlot(760, 100, [], 8, 800), 700)
  // 三个叠着贴：互不重叠
  const placed: { start: number; size: number }[] = []
  for (let i = 0; i < 3; i++) placed.push({ start: dockSlot(300, 100, placed, 8, 800), size: 100 })
  for (const a of placed)
    for (const b of placed)
      if (a !== b) assert.ok(a.start + a.size <= b.start || b.start + b.size <= a.start)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  deriveMinWidth,
  estimateTextWidth,
  groupMinWidth,
  planRow,
  planSignature,
  resolveItemWidth,
  resolveRowItems,
  rowSlots,
  shouldReplan,
  type RowItem,
  type RowItemInput
} from './engine'

const GAP = 8

function item(
  id: string,
  minWidth: number,
  priority: RowItem['priority'],
  grow = false,
  group?: string
): RowItem {
  return { id, minWidth, priority, grow, group }
}

/* ---------------------------------------------------------------------------
 * 原 6 个用例
 * ------------------------------------------------------------------------- */

test('一行装得下：全部元素排在一条线上，没有隐藏', () => {
  const items = [
    item('name', 120, 'primary'),
    item('slider', 120, 'primary'),
    item('value', 56, 'secondary')
  ]
  const r = planRow(items, 400, { gap: GAP })
  assert.deepEqual(
    r.lines.map((l) => l.map((i) => i.id)),
    [['name', 'slider', 'value']]
  )
  assert.deepEqual(r.hidden, [])
})

test('必须换行：装不下时把当前行收起，剩余元素开新行', () => {
  const items = [
    item('name', 120, 'primary'),
    item('slider', 120, 'primary'),
    item('value', 56, 'primary')
  ]
  // 120 + 8 + 120 = 248 放得下 name+slider；再加 8 + 56 = 312 > 300 → value 换行
  const r = planRow(items, 300, { gap: GAP })
  assert.deepEqual(
    r.lines.map((l) => l.map((i) => i.id)),
    [['name', 'slider'], ['value']]
  )
  assert.deepEqual(r.hidden, [])
})

test('隐藏次要元素后装下：腾位优先于换行', () => {
  // 行里已有 name + tag(secondary)，新来的 primary 按钮装不下 →
  // 先隐藏该行尾部的 tag 腾地方，装得下就不换行
  const items = [
    item('name', 120, 'primary'),
    item('tag', 80, 'secondary'),
    item('ok', 96, 'primary')
  ]
  const r = planRow(items, 224, { gap: GAP })
  assert.deepEqual(
    r.lines.map((l) => l.map((i) => i.id)),
    [['name', 'ok']]
  )
  assert.deepEqual(r.hidden, ['tag'])
})

test('primary 不被隐藏：全是 primary 时宁可换行', () => {
  const items = [item('a', 120, 'primary'), item('b', 120, 'primary'), item('c', 120, 'primary')]
  const r = planRow(items, 200, { gap: GAP })
  assert.deepEqual(
    r.lines.map((l) => l.map((i) => i.id)),
    [['a'], ['b'], ['c']]
  )
  assert.deepEqual(r.hidden, [])
})

test('空 items：没有行也没有隐藏', () => {
  assert.deepEqual(planRow([], 300, { gap: GAP }), { lines: [], hidden: [] })
})

test('单元素超宽：primary 独占一行，可丢的进 hidden', () => {
  // primary：永不隐藏——独占一行，由调用方夹取宽度（resolveRowItems）+ CSS 收缩兜底
  const r = planRow([item('wide', 500, 'primary')], 300, { gap: GAP })
  assert.deepEqual(
    r.lines.map((l) => l.map((i) => i.id)),
    [['wide']]
  )
  assert.deepEqual(r.hidden, [])
  // secondary / tertiary：本来就装不下，藏掉好过溢出（策略顺序里的「隐藏」先于「换行」）
  const r2 = planRow([item('wide', 500, 'secondary')], 300, { gap: GAP })
  assert.deepEqual(r2.lines, [])
  assert.deepEqual(r2.hidden, ['wide'])
})

/* ---------------------------------------------------------------------------
 * 隐藏顺序 / 事务性 / 分组
 * ------------------------------------------------------------------------- */

test('隐藏顺序 tertiary → secondary，primary 永不隐藏', () => {
  const items = [
    item('name', 120, 'primary'),
    item('a', 100, 'secondary'),
    item('b', 60, 'tertiary'),
    item('c', 60, 'tertiary'),
    item('ok', 120, 'primary')
  ]
  // 一路装到 name+a+b（120+8+100+8+60 = 296）时 c 装不下 → 先藏 tertiary c；
  // ok(120) 来了还装不下 → 继续藏 tertiary b，再藏 secondary a；
  // 仍装不下才轮到 primary——primary 不参与，于是 name+ok 换到同一行
  const r = planRow(items, 300, { gap: GAP })
  assert.deepEqual(r.hidden.sort(), ['a', 'b', 'c'])
  assert.deepEqual(
    r.lines.map((l) => l.map((i) => i.id)),
    [['name', 'ok']]
  )
})

test('腾位是事务性的：腾不成就换行，不丢已渲染的内容', () => {
  // 行尾 tag 可藏，但藏了它（60）也装不下 big(200)——分文不取，直接换行，tag 留在第一行
  const items = [
    item('name', 120, 'primary'),
    item('tag', 60, 'secondary'),
    item('big', 200, 'primary')
  ]
  const r = planRow(items, 200, { gap: GAP })
  assert.deepEqual(
    r.lines.map((l) => l.map((i) => i.id)),
    [['name', 'tag'], ['big']]
  )
  assert.deepEqual(r.hidden, [])
})

test('primary 之间互不隐藏：装不下就换行', () => {
  // name + slider 两个 primary：120 + 8 + 120 = 248 > 224，没有可藏的候选 → 换行
  const items = [
    item('name', 120, 'primary'),
    item('slider', 120, 'primary'),
    item('value', 56, 'secondary')
  ]
  const r = planRow(items, 224, { gap: GAP })
  assert.deepEqual(
    r.lines.map((l) => l.map((i) => i.id)),
    [['name'], ['slider', 'value']]
  )
  assert.deepEqual(r.hidden, [])
})

test('同级优先隐藏「新元素的次要部分」，已渲染内容不闪动', () => {
  // 行尾 tag 与新来的 value 同为 secondary：隐藏新来的 value，tag 留在行内
  const items = [
    item('name', 120, 'primary'),
    item('tag', 60, 'secondary'),
    item('value', 80, 'secondary')
  ]
  const r = planRow(items, 200, { gap: GAP })
  assert.deepEqual(
    r.lines.map((l) => l.map((i) => i.id)),
    [['name', 'tag']]
  )
  assert.deepEqual(r.hidden, ['value'])
})

test('当前行刚好满时，隐藏次要元素优先于换行', () => {
  // name + slider 正好占满 216，value(secondary) 没地方 → 藏掉，不换行
  const items = [
    item('name', 120, 'primary'),
    item('slider', 88, 'primary'),
    item('value', 64, 'secondary')
  ]
  const r = planRow(items, 216, { gap: GAP })
  assert.deepEqual(
    r.lines.map((l) => l.map((i) => i.id)),
    [['name', 'slider']]
  )
  assert.deepEqual(r.hidden, ['value'])
})

test('Group 内部优先同行：组成员捆成一个规划单元', () => {
  const items = [
    item('name', 120, 'primary'),
    item('slider', 120, 'primary', false, 'row1'),
    item('value', 56, 'secondary', false, 'row1'),
    item('extra', 200, 'primary')
  ]
  // slider+value 成组（120 + 8 + 56 = 184）；400 宽下 name + 组 = 312 装得下 → 三个同一行；
  // extra(200) 装不下 → 自己一行。组没有被拆散。
  const r = planRow(items, 400, { gap: GAP })
  assert.deepEqual(
    r.lines.map((l) => l.map((i) => i.id)),
    [['name', 'slider', 'value'], ['extra']]
  )
  assert.deepEqual(r.hidden, [])
})

test('Group 装不下时整组换行，不拆散（成员都是 primary 时）', () => {
  const items = [
    item('name', 120, 'primary'),
    item('slider', 120, 'primary', false, 'row1'),
    item('value', 56, 'primary', false, 'row1'),
    item('extra', 200, 'primary')
  ]
  // 260 宽：name + 组(184) = 312 > 260，且组内没有可藏的 → 整组换到第二行
  const r = planRow(items, 260, { gap: GAP })
  assert.deepEqual(
    r.lines.map((l) => l.map((i) => i.id)),
    [['name'], ['slider', 'value'], ['extra']]
  )
  assert.deepEqual(r.hidden, [])
})

test('Group 连自己一行都装不下时拆成单个元素，不整组消失', () => {
  const items = [
    item('a', 200, 'primary', false, 'g'),
    item('b', 200, 'primary', false, 'g'),
    item('c', 60, 'primary')
  ]
  // 组宽 408 > 300，且全是 primary 无法隐藏 → 拆开各自竞争：a 一行，b 与 c 一行
  const r = planRow(items, 300, { gap: GAP })
  assert.deepEqual(r.hidden, [])
  assert.deepEqual(
    r.lines.map((l) => l.map((i) => i.id)),
    [['a'], ['b', 'c']]
  )
})

test('groupMinWidth = 成员 minWidth 之和 + 成员间 gap', () => {
  const group = [item('slider', 120, 'primary'), item('value', 56, 'secondary')]
  assert.equal(groupMinWidth(group, GAP), 184)
  assert.equal(groupMinWidth([item('solo', 90, 'primary')], GAP), 90)
  assert.equal(groupMinWidth([], GAP), 0)
})

test('rowSlots：摊平规划结果，隐藏元素排在可见元素之后', () => {
  // 130 宽：name(120) 一行；slider(120) 装不下换行；value(56) 也没地方 → 隐藏
  const r = planRow(
    [item('name', 120, 'primary'), item('slider', 120, 'primary'), item('value', 56, 'secondary')],
    130,
    { gap: GAP }
  )
  const slots = rowSlots(r)
  assert.deepEqual(
    slots.map((s) => `${s.id}:${s.order}:${s.visible}`),
    ['name:0:true', 'slider:1:true', 'value:2:false']
  )
})

/* ---------------------------------------------------------------------------
 * 下限从哪来：声明 > 实测缓存 > 内容推导
 * ------------------------------------------------------------------------- */

test('内容推导：中英文标签按 ch 估算（含图标与内边距）', () => {
  // 3 个汉字 × 14px = 42px
  assert.equal(estimateTextWidth('设置项'), 42)
  // 10 个拉丁字符 × 0.55 × 14 = 77px
  assert.equal(estimateTextWidth('Brightness'), 77)
  // 2 个汉字 × 14 = 28px，+ 控件内边距 8
  const zh = deriveMinWidth({ id: 'a', priority: 'primary', kind: 'label', text: '音量' })
  const en = deriveMinWidth({ id: 'a', priority: 'primary', kind: 'label', text: 'Volume' })
  assert.equal(zh, 28 + 8)
  assert.equal(en, Math.ceil(6 * 0.55 * 14) + 8)
  // 带前置图标：+ 图标 20 + 间距 8
  const withIcon = deriveMinWidth({
    id: 'a',
    priority: 'primary',
    kind: 'label',
    text: '音量',
    icon: true
  })
  assert.equal(withIcon, zh + 28)
})

test('内容推导：不同类型控件有类型默认值，手机档更窄', () => {
  const slider = { id: 's', priority: 'primary', kind: 'slider' } as const
  assert.equal(deriveMinWidth(slider), 120)
  assert.equal(deriveMinWidth(slider, { narrow: true }), 88)
  assert.equal(deriveMinWidth({ id: 'n', priority: 'secondary', kind: 'number' }), 64)
  assert.equal(deriveMinWidth({ id: 'i', priority: 'primary', kind: 'icon' }), 40)
  assert.equal(deriveMinWidth({ id: 'c', priority: 'primary', kind: 'control' }), 88)
  // 带文字的控件取「类型默认值」与「文字宽度」的较大者
  assert.equal(deriveMinWidth({ id: 'b', priority: 'primary', kind: 'control', text: '确定' }), 88)
  // 9 个汉字 × 14 = 126 + 8 = 134 > 类型默认 88
  assert.equal(
    deriveMinWidth({ id: 'b', priority: 'primary', kind: 'control', text: '这是一个很长的按钮' }),
    134
  )
})

test('下限解析：声明 > 实测缓存 > 内容推导', () => {
  // 声明说了算
  assert.equal(
    resolveItemWidth({ id: 'a', priority: 'primary', minWidth: 200, kind: 'slider' }),
    200
  )
  // 实测缓存：clamp(natural × 0.6, 类型下限, natural)
  assert.equal(
    resolveItemWidth({ id: 'a', priority: 'primary', kind: 'label', naturalWidth: 200 }),
    120
  )
  assert.equal(
    resolveItemWidth({ id: 'a', priority: 'primary', kind: 'slider', naturalWidth: 100 }),
    88
  )
  assert.equal(
    resolveItemWidth({ id: 'a', priority: 'primary', kind: 'slider', naturalWidth: 300 }),
    180
  )
  // 都没有时退回内容推导
  assert.equal(resolveItemWidth({ id: 'a', priority: 'primary', kind: 'number' }), 64)
  // resolveRowItems 把下限夹到可用宽度内（防超宽）
  const resolved = resolveRowItems([{ id: 'a', priority: 'primary', minWidth: 500 }], 300, {})
  assert.equal(resolved[0].minWidth, 300)
})

test('滞回：宽度变化不超过阈值、结构没变就不重规划', () => {
  const items = [item('a', 120, 'primary')]
  const sig = planSignature(items)
  const prev = { width: 300, signature: sig }
  assert.equal(shouldReplan(null, prev), true)
  assert.equal(shouldReplan(prev, { width: 306, signature: sig }), false, '±8px 内不重规划')
  assert.equal(shouldReplan(prev, { width: 309, signature: sig }), true, '超过阈值才重规划')
  assert.equal(
    shouldReplan(prev, { width: 300, signature: sig + '|x' }),
    true,
    '结构变化必须重规划'
  )
  // 签名覆盖 id / 优先级 / 下限 / 分组 / grow
  assert.notEqual(
    planSignature([item('a', 120, 'primary')]),
    planSignature([item('a', 120, 'primary', true)])
  )
  assert.notEqual(
    planSignature([item('a', 120, 'primary')]),
    planSignature([{ ...item('a', 120, 'primary'), group: 'g' }])
  )
})

/* ---------------------------------------------------------------------------
 * 典型用例：同一行设置在 1280 / 720 / 390 三档宽度下的规划结果
 * ------------------------------------------------------------------------- */

/** 设置项 `[名字] [slider] [数值]`：名字可省略号，slider 与数值是硬控件 */
function settingsRow(natural: number): RowItemInput[] {
  return [
    { id: 'name', priority: 'primary', kind: 'label', text: '主音量', naturalWidth: natural },
    { id: 'slider', priority: 'primary', kind: 'slider' },
    { id: 'value', priority: 'secondary', kind: 'number' }
  ]
}

function planAt(width: number, narrow: boolean, inputs: RowItemInput[]): PlanShape {
  const resolved = resolveRowItems(inputs, width, { narrow })
  return shape(planRow(resolved, width, { gap: GAP }))
}

interface PlanShape {
  lines: string[][]
  hidden: string[]
}

function shape(r: ReturnType<typeof planRow>): PlanShape {
  return { lines: r.lines.map((l) => l.map((i) => i.id)), hidden: r.hidden }
}

test('三档宽度下的规划结果：1280 一行 / 720 一行 / 390 隐藏数值框', () => {
  // 1280：宽屏，名字、滑块、数值框全部同行
  assert.deepEqual(planAt(1280, false, settingsRow(56)), {
    lines: [['name', 'slider', 'value']],
    hidden: []
  })
  // 720：桌面窄档仍装得下（名字 32 + slider 120 + 数值 64 + 间距 16 = 232）
  assert.deepEqual(planAt(720, false, settingsRow(56)), {
    lines: [['name', 'slider', 'value']],
    hidden: []
  })
  // 390：手机档，名字下限 32 + slider 88 + 数值 64 + 间距 16 = 200 仍装得下
  assert.deepEqual(planAt(390, true, settingsRow(56)), {
    lines: [['name', 'slider', 'value']],
    hidden: []
  })
})

test('三档宽度下的退化：窄屏先隐藏数值框，再窄才换行', () => {
  const inputs = settingsRow(56)
  // 184（名字 32 + 手机 slider 88 + 间距 8）刚好装下 name+slider → 隐藏数值框
  assert.deepEqual(planAt(184, true, inputs), {
    lines: [['name', 'slider']],
    hidden: ['value']
  })
  // 96：连 slider 都装不下（名字 32 + 8 + 88 = 128 > 96）→ 名字一行、slider 一行、数值框隐藏
  assert.deepEqual(planAt(96, true, inputs), {
    lines: [['name'], ['slider']],
    hidden: ['value']
  })
  // 长名字（实测 200 → 下限 120）在 200 宽度下：name+slider 装不下 → 换行；数值框还有位置，不隐藏
  assert.deepEqual(planAt(200, true, settingsRow(200)), {
    lines: [['name'], ['slider', 'value']],
    hidden: []
  })
  // 同样长名字在 216 宽度下：name+slider 刚好一行，数值框（secondary）被隐藏
  assert.deepEqual(planAt(216, true, settingsRow(200)), {
    lines: [['name', 'slider']],
    hidden: ['value']
  })
})

/* ---------------------------------------------------------------------------
 * 不变量：随机输入下不丢元素、不溢出（除单元素自身超宽）
 * ------------------------------------------------------------------------- */

test('不变量：任何输入下不丢元素，行宽不超 availableWidth', () => {
  let seed = 42
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  const priorities: RowItem['priority'][] = ['primary', 'secondary', 'tertiary']
  for (let round = 0; round < 300; round++) {
    const count = rand(7)
    const items: RowItem[] = []
    for (let i = 0; i < count; i++) {
      items.push({
        id: `i${i}`,
        minWidth: 1 + rand(160),
        priority: priorities[rand(3)],
        grow: rand(2) === 0,
        group: rand(3) === 0 ? `g${rand(2)}` : undefined
      })
    }
    const width = 40 + rand(400)
    const gap = rand(12)
    const r = planRow(items, width, { gap })
    // 1) 不丢元素：lines ∪ hidden == 输入，且互不相交
    const seen = r.lines
      .flat()
      .map((i) => i.id)
      .concat(r.hidden)
    assert.equal(new Set(seen).size, items.length, '每个元素恰好出现一次')
    assert.equal(seen.length, items.length, '没有重复')
    // 2) primary 永不隐藏
    const primaryIds = items.filter((i) => i.priority === 'primary').map((i) => i.id)
    for (const id of r.hidden) assert.ok(!primaryIds.includes(id), 'primary 不应被隐藏')
    // 3) 除单元素超宽外，行宽不超 availableWidth
    for (const line of r.lines) {
      if (line.length === 1 && line[0].minWidth > width) continue
      let sum = 0
      for (const it of line) sum += it.minWidth
      sum += gap * (line.length - 1)
      assert.ok(sum <= width + 0.001, `行宽 ${sum} 超过可用宽度 ${width}`)
    }
  }
})

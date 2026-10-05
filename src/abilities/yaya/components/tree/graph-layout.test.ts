/**
 * graph-layout 的离线自检（纯函数，不碰文件系统 / 网络 / DOM，无需隔离 HOME）。
 * 跑法：pnpm exec tsx --test src/abilities/yaya/components/tree/graph-layout.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TreeTurn } from '../../types'
import {
  COMPACT_METRICS,
  DRAG_THRESHOLD,
  SCALE_MAX,
  SCALE_MIN,
  WIDE_METRICS,
  activePath,
  buildEdges,
  buildGraph,
  clampScale,
  exceedsDrag,
  fitTransform,
  metricsFor,
  nodeEdgePath,
  packChains,
  PACK_PREFIX,
  subtreeSizes,
  zoomAt,
  type GraphNode
} from './graph-layout'

let clock = 1000
function turn(id: string, parent: string | null, extra: Partial<TreeTurn> = {}): TreeTurn {
  return {
    id,
    kind: 'user',
    parent,
    endId: id,
    preview: id,
    tools: 0,
    createdAt: ++clock,
    active: false,
    ...extra
  }
}

/** 每个深度里的行号必须严格递增（同层节点不重叠） */
function rowsByDepth(nodes: Array<{ depth: number; row: number }>): number[][] {
  const byDepth: number[][] = []
  for (const n of nodes) {
    const list = byDepth[n.depth] ?? (byDepth[n.depth] = [])
    list.push(n.row)
  }
  for (const list of byDepth) list.sort((a, b) => a - b)
  return byDepth
}

describe('buildGraph：长链', () => {
  it('不分叉的连续对话只占一行，深度递增、每个节点一条边', () => {
    const turns = [turn('u1', null), turn('a1', 'u1'), turn('u2', 'a1'), turn('a2', 'u2')]
    const g = buildGraph(turns)
    const m = g.metrics
    assert.equal(g.roots.length, 1)
    assert.equal(g.nodes.length, 4)
    assert.equal(g.edges.length, 3)
    assert.deepEqual(
      g.nodes.map((n) => n.row),
      [0, 0, 0, 0]
    )
    assert.deepEqual(
      g.nodes.map((n) => n.depth),
      [0, 1, 2, 3]
    )
    // 每一层往右一列
    assert.equal(g.nodes[1].x - g.nodes[0].x, m.nodeWidth + m.colGap)
    // 画布尺寸 = 四列 + 留白
    assert.equal(g.width, m.margin * 2 + 4 * m.nodeWidth + 3 * m.colGap)
    assert.equal(g.height, m.margin * 2 + m.nodeHeight)
  })

  it('五万个节点的长链也不会爆栈、也快（全在同一行）', () => {
    const before = Date.now()
    const turns: TreeTurn[] = []
    for (let i = 0; i < 50000; i++) {
      turns.push(turn(`n${i}`, i === 0 ? null : `n${i - 1}`, { kind: i % 2 ? 'answer' : 'user' }))
    }
    const g = buildGraph(turns)
    assert.equal(g.nodes.length, 50000)
    assert.equal(g.edges.length, 49999)
    assert.ok(
      g.nodes.every((n) => n.row === 0),
      '长链应该压成一行'
    )
    assert.equal(g.nodes[49999].depth, 49999)
    assert.ok(Date.now() - before < 5000, '布局应该远小于 5s')
  })

  it('很深的链也不会爆栈（深度不等于递归深度）', () => {
    const turns: TreeTurn[] = []
    for (let i = 0; i < 20000; i++) turns.push(turn(`d${i}`, i === 0 ? null : `d${i - 1}`))
    const g = buildGraph(turns)
    assert.equal(g.byId.get('d19999')?.depth, 19999)
  })
})

describe('buildGraph：分叉与多根', () => {
  /** r ├ a(叶子) └ b ├ b1 └ b2 */
  const fork = [turn('r', null), turn('a', 'r'), turn('b', 'r'), turn('b1', 'b'), turn('b2', 'b')]

  it('同层结点严格递增、卡片互不重叠', () => {
    const g = buildGraph(fork)
    const by = (id: string): GraphNode => g.byId.get(id)!
    // 后序：叶子 a(0)、b1(1)、b2(2) 分属独立区间，b(1.5)、r(0.75) 居中
    assert.equal(by('a').row, 0)
    assert.equal(by('b1').row, 1)
    assert.equal(by('b2').row, 2)
    assert.equal(by('b').row, 1.5)
    assert.equal(by('r').row, 0.75)
    // r 没有同层邻居，所以就是两个子节点的中点
    assert.equal(by('r').row, (by('a').row + by('b').row) / 2)
    for (const rows of rowsByDepth(g.nodes)) {
      for (let i = 1; i < rows.length; i++) assert.ok(rows[i] > rows[i - 1])
    }
    // 任何两个节点卡片都不重叠
    const m = g.metrics
    for (const a of g.nodes) {
      for (const b of g.nodes) {
        if (a === b) continue
        const overlapX = a.x < b.x + m.nodeWidth && b.x < a.x + m.nodeWidth
        if (!overlapX) continue
        const overlapY = a.y < b.y + m.nodeHeight && b.y < a.y + m.nodeHeight
        assert.ok(!overlapY, `${a.id} 与 ${b.id} 卡片重叠`)
      }
    }
  })

  it('边把父子连起来，活跃路径上的边被标出来', () => {
    const turns = fork.map((x) => ({ ...x, active: ['r', 'b', 'b2'].includes(x.id) }))
    const g = buildGraph(turns)
    const path = activePath(g, 'b2')
    assert.deepEqual([...path].sort(), ['b', 'b2', 'r'])
    const edges = buildEdges(g, path)
    const edge = (to: string): boolean => edges.find((e) => e.to.id === to)!.active
    assert.equal(edge('b'), true)
    assert.equal(edge('b2'), true)
    assert.equal(edge('a'), false)
    assert.equal(edge('b1'), false)
    // buildEdges 不改变原图的边表
    assert.ok(g.edges.every((e) => e.active === false))
  })

  it('activePath 对未知 / 空 current 给空集合，遇到环也不会死循环', () => {
    const g = buildGraph(fork)
    assert.equal(activePath(g, null).size, 0)
    assert.equal(activePath(g, 'nope').size, 0)
    const cyclic = buildGraph([turn('x', 'y'), turn('y', 'x')])
    assert.equal(activePath(cyclic, 'y').size, 2)
  })

  it('多个根各自成一支，深度都是 0 且不重叠', () => {
    const g = buildGraph([
      turn('r1', null),
      turn('r1a', 'r1'),
      turn('r1b', 'r1'),
      turn('r2', null),
      turn('r2a', 'r2')
    ])
    assert.equal(g.roots.length, 2)
    assert.deepEqual(g.roots.map((n) => n.id).sort(), ['r1', 'r2'])
    const rows = g.roots.map((n) => n.row)
    assert.ok(rows[0] !== rows[1], '两个根不能挤在同一行')
    assert.ok(g.roots.every((n) => n.depth === 0))
    for (const r of g.roots) assert.ok(g.edges.some((e) => e.from.id === r.id))
    assert.equal(g.byId.get('r1a')?.depth, 1)
    assert.equal(g.byId.get('r2a')?.depth, 1)
  })

  it('宽分叉（一个节点下几十个兄弟）时所有兄弟都有位置', () => {
    const turns = [turn('root', null)]
    for (let i = 0; i < 40; i++) turns.push(turn(`k${i}`, 'root'))
    const g = buildGraph(turns)
    const m = g.metrics
    const rows = g.byId
      .get('root')!
      .children.map((c) => c.row)
      .sort((a, b) => a - b)
    assert.equal(rows.length, 40)
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i] > rows[i - 1])
    assert.equal(g.height, m.margin * 2 + 40 * m.nodeHeight + 39 * m.rowGap)
  })

  it('窄屏度量给出更窄的卡片与更小的间距', () => {
    const wide = buildGraph([turn('a', null), turn('b', 'a')], metricsFor(false))
    const narrow = buildGraph([turn('a', null), turn('b', 'a')], metricsFor(true))
    assert.equal(wide.metrics.nodeWidth, 236)
    assert.ok(narrow.metrics.nodeWidth < wide.metrics.nodeWidth)
    assert.ok(narrow.metrics.colGap < wide.metrics.colGap)
    assert.ok(narrow.width < wide.width)
    assert.equal(
      narrow.nodes[1].x - narrow.nodes[0].x,
      narrow.metrics.nodeWidth + narrow.metrics.colGap
    )
  })

  it('compact / wide 两档度量都是组件 CSS 能用的正数', () => {
    for (const m of [WIDE_METRICS, COMPACT_METRICS]) {
      assert.ok(m.nodeWidth > 0 && m.nodeHeight > 0 && m.colGap > 0 && m.margin > 0)
    }
  })
})

describe('buildGraph：异常数据不卡死', () => {
  it('父节点不在列表里 → 当根，节点仍然可见', () => {
    const g = buildGraph([turn('lost', 'ghost'), turn('ok', 'lost')])
    assert.equal(g.roots.length, 1)
    assert.equal(g.byId.get('lost')?.parent, null)
    assert.equal(g.byId.get('lost')?.depth, 0)
    assert.equal(g.byId.get('ok')?.depth, 1)
    assert.equal(g.nodes.length, 2)
  })

  it('自环 / 互环不会死循环，节点都在', () => {
    const g = buildGraph([turn('self', 'self'), turn('a', 'b'), turn('b', 'a')])
    assert.equal(g.nodes.length, 3)
    assert.equal(g.byId.get('self')?.parent, null)
  })

  it('空输入给空图', () => {
    const g = buildGraph([])
    assert.equal(g.nodes.length, 0)
    assert.equal(g.edges.length, 0)
    assert.equal(g.width, WIDE_METRICS.margin * 2 + WIDE_METRICS.nodeWidth)
    assert.equal(g.height, WIDE_METRICS.margin * 2 + WIDE_METRICS.nodeHeight)
  })
})

describe('辅助函数', () => {
  it('subtreeSizes 一次迭代算完全部子树，深链 / 环不死循环', () => {
    const g = buildGraph([
      turn('r', null),
      turn('a', 'r'),
      turn('a1', 'a'),
      turn('a2', 'a1'),
      turn('b', 'r')
    ])
    const sizes = subtreeSizes(g)
    assert.equal(sizes.get('r'), 5)
    assert.equal(sizes.get('a'), 3)
    assert.equal(sizes.get('a1'), 2)
    assert.equal(sizes.get('b'), 1)
    // 两万个节点的长链：单节点 + 逐层递减，不爆栈
    const chain: TreeTurn[] = []
    for (let i = 0; i < 20000; i++) chain.push(turn(`c${i}`, i === 0 ? null : `c${i - 1}`))
    const big = subtreeSizes(buildGraph(chain))
    assert.equal(big.get('c0'), 20000)
    assert.equal(big.get('c19999'), 1)
    // 环不会死循环
    const cyc = subtreeSizes(buildGraph([turn('x', 'y'), turn('y', 'x')]))
    assert.ok(cyc.size >= 0)
  })

  it('nodeEdgePath 从卡片右中点到左中点，水平贝塞尔', () => {
    const g = buildGraph([turn('p', null), turn('c', 'p')])
    const from = g.byId.get('p')!
    const to = g.byId.get('c')!
    const m = g.metrics
    const d = nodeEdgePath(from, to, m)
    assert.equal(d.startsWith('M '), true)
    assert.match(d, /^M -?\d+ -?[\d.]+ C -?\d+ -?[\d.]+, -?\d+ -?[\d.]+, -?\d+ -?[\d.]+$/)
    assert.ok(d.startsWith(`M ${from.x + m.nodeWidth} ${from.y + m.nodeHeight / 2} C`))
    assert.ok(d.trimEnd().endsWith(` ${to.x} ${to.y + m.nodeHeight / 2}`))
  })
})

describe('视口变换', () => {
  it('clampScale 夹在上下限内，非法值回落下限', () => {
    assert.equal(clampScale(1), 1)
    assert.equal(clampScale(0.0001), SCALE_MIN)
    assert.equal(clampScale(1000), SCALE_MAX)
    assert.equal(clampScale(Number.NaN), SCALE_MIN)
    assert.equal(clampScale(-3), SCALE_MIN)
  })

  it('zoomAt 让锚点在世界坐标上不动', () => {
    const vp = { scale: 1, x: 0, y: 0 }
    const out = zoomAt(vp, 2, 100, 50)
    assert.equal(out.scale, 2)
    assert.equal((100 - out.x) / out.scale, (100 - vp.x) / vp.scale)
    assert.equal((50 - out.y) / out.scale, (50 - vp.y) / vp.scale)
  })

  it('zoomAt 到边界就停住，不会无限放大', () => {
    let vp = { scale: 1, x: 0, y: 0 }
    for (let i = 0; i < 50; i++) vp = zoomAt(vp, 1.5, 10, 10)
    assert.equal(vp.scale, SCALE_MAX)
    for (let i = 0; i < 200; i++) vp = zoomAt(vp, 0.5, 10, 10)
    assert.equal(vp.scale, SCALE_MIN)
  })

  it('fitTransform 把图适配进视口并居中，越界尺寸返回 null', () => {
    const pad = WIDE_METRICS.margin
    const vp = fitTransform(1000, 500, 800, 600, pad)
    assert.ok(vp)
    assert.equal(vp!.scale, clampScale(Math.min((800 - pad * 2) / 1000, (600 - pad * 2) / 500)))
    assert.equal(vp!.x, (800 - 1000 * vp!.scale) / 2)
    assert.equal(vp!.y, (600 - 500 * vp!.scale) / 2)
    assert.equal(fitTransform(0, 100, 800, 600, pad), null)
    assert.equal(fitTransform(100, 0, 800, 600, pad), null)
    assert.equal(fitTransform(100, 100, 10, 10, pad), null)
    // 很大的图就缩到最小，不再继续缩小
    assert.equal(fitTransform(100000, 100000, 800, 600, pad)!.scale, SCALE_MIN)
    // 很小的图也不放大超过上限
    assert.equal(fitTransform(10, 10, 800, 600, pad)!.scale, SCALE_MAX)
  })

  it('exceedsDrag 超过阈值才算拖动（防误触点节点）', () => {
    assert.equal(exceedsDrag(0, 0), false)
    assert.equal(exceedsDrag(DRAG_THRESHOLD, 0), false)
    assert.equal(exceedsDrag(0, DRAG_THRESHOLD + 1), true)
    assert.equal(exceedsDrag(-DRAG_THRESHOLD - 1, 0), true)
    assert.equal(exceedsDrag(3, 3), false)
  })
})

it('breaks mutual cycles into a visible forest without overlapping nodes', () => {
  const g = buildGraph([turn('x', 'y'), turn('y', 'x'), turn('z', 'y')])
  assert.equal(g.roots.length, 1)
  assert.equal(g.edges.length, 2)
  assert.equal(subtreeSizes(g).get(g.roots[0].id), 3)
  assert.equal(new Set(g.nodes.map((n) => `${n.x},${n.y}`)).size, 3)
})

describe('packChains：折叠线性链', () => {
  /** root → a1..a5 → fork → (b1 → b2 → b3 → b4 → leafB) / (c1 → leafC) */
  function forked(): TreeTurn[] {
    const list = [turn('root', null)]
    let prev = 'root'
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5', 'fork']) {
      list.push(turn(id, prev))
      prev = id
    }
    list.push(turn('b1', 'fork'), turn('b2', 'b1'), turn('b3', 'b2'), turn('b4', 'b3'))
    list.push(turn('leafB', 'b4'), turn('c1', 'fork'), turn('leafC', 'c1'))
    return list
  }
  const ids = (list: { id: string }[]): string[] => list.map((t) => t.id)

  it('分叉点之间的链折成一个节点，锚点（根 / 分叉 / 分支第一轮 / 叶子）保留', () => {
    const out = packChains(forked())
    assert.deepEqual(ids(out), [
      'root',
      `${PACK_PREFIX}a1`,
      'fork',
      'b1',
      `${PACK_PREFIX}b2`,
      'leafB',
      'c1',
      'leafC'
    ])
    const pa = out.find((t) => t.id === `${PACK_PREFIX}a1`)!
    assert.deepEqual(ids(pa.pack ?? []), ['a1', 'a2', 'a3', 'a4', 'a5'])
    assert.equal(pa.parent, 'root')
    assert.equal(pa.endId, 'a5')
    assert.equal(out.find((t) => t.id === 'fork')?.parent, `${PACK_PREFIX}a1`)
    assert.equal(out.find((t) => t.id === 'leafB')?.parent, `${PACK_PREFIX}b2`)
    // 折完的图照样能布局，活跃路径能穿过折叠节点
    const g = buildGraph(out)
    assert.equal(g.nodes.length, out.length)
    assert.deepEqual(
      [...activePath(g, 'leafB')],
      ['leafB', `${PACK_PREFIX}b2`, 'b1', 'fork', `${PACK_PREFIX}a1`, 'root']
    )
  })

  it('不够 min 轮不折；keep 的节点把链切开；展开过的保持展开', () => {
    // b 链只有 b2 b3 b4 三轮可折；keep b3 → 两边都不足 3 轮
    assert.ok(!ids(packChains(forked(), new Set(['b3']))).includes(`${PACK_PREFIX}b2`))
    const opened = packChains(forked(), new Set(), new Set([`${PACK_PREFIX}a1`]))
    assert.ok(ids(opened).includes('a3'))
    assert.ok(ids(opened).includes(`${PACK_PREFIX}b2`))
    // 统计：工具次数累加，活跃取任一
    const tools = forked().map((t) => (t.id.startsWith('a') ? { ...t, tools: 2 } : t))
    tools[3] = { ...tools[3], active: true }
    const p = packChains(tools).find((t) => t.id === `${PACK_PREFIX}a1`)!
    assert.equal(p.tools, 10)
    assert.equal(p.active, true)
  })

  it('没有可折的链时原样返回；异常数据（环 / 悬空父节点）不卡死', () => {
    const plain = [turn('r', null), turn('x', 'r'), turn('y', 'r')]
    assert.deepEqual(ids(packChains(plain)), ['r', 'x', 'y'])
    const cyc = [turn('p', 'q'), turn('q', 'p'), turn('z', 'missing')]
    assert.deepEqual(ids(packChains(cyc)), ['p', 'q', 'z'])
    // 十万轮的长链：一个折叠节点 + 首尾
    const long: TreeTurn[] = [turn('n0', null)]
    for (let i = 1; i < 100_000; i++) long.push(turn(`n${i}`, `n${i - 1}`))
    const packed = packChains(long)
    assert.equal(packed.length, 3)
    assert.equal(packed[1].pack?.length, 99_998)
  })
})

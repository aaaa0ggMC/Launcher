/**
 * 对话树的图形布局（纯函数，不依赖 Vue / DOM，可在 node:test 里离线自检）。
 *
 * 约定：
 * - 横向铺开的是「深度」（第几轮），纵向排的是同层兄弟；
 * - 一条不分叉的长链只占一行（内部节点取子节点的中点，叶子依次占一行），
 *   所以几十轮的连续对话也是一个扁条，宽屏看不完就缩放；
 * - 各子树使用互不相交的叶子行区间，同层节点不会重叠；
 * - 全程显式栈迭代（无递归），几十万个节点的长链 / 深链都不会爆栈；
 * - 数据异常（父节点不在列表里、甚至成环）不会卡死：悬空父节点当根，环直接断开。
 */
import type { TreeTurn } from '../../types'

/** 一整套度量（宽屏 / 窄屏两档），节点尺寸、间距都走它 */
export interface GraphMetrics {
  nodeWidth: number
  nodeHeight: number
  colGap: number
  rowGap: number
  margin: number
}

/** 桌面：卡片宽一点，预览能看两行 */
export const WIDE_METRICS: GraphMetrics = {
  nodeWidth: 236,
  nodeHeight: 92,
  colGap: 72,
  rowGap: 20,
  margin: 24
}

/** 手机（全屏）：卡片收窄，同样的内容能多显示几列 */
export const COMPACT_METRICS: GraphMetrics = {
  nodeWidth: 168,
  nodeHeight: 84,
  colGap: 44,
  rowGap: 16,
  margin: 16
}

export function metricsFor(narrow: boolean): GraphMetrics {
  return narrow ? COMPACT_METRICS : WIDE_METRICS
}

/** 缩放上下限 */
export const SCALE_MIN = 0.2
export const SCALE_MAX = 2.5
/** 移动超过这个距离算「拖动」，不再当成点击节点 */
export const DRAG_THRESHOLD = 5

export interface GraphNode {
  id: string
  turn: TreeTurn
  /** 父节点 id（根为 null） */
  parent: string | null
  children: GraphNode[]
  /** 第几层（根为 0） */
  depth: number
  /** 第几行；同一条不分叉的链共享同一行，允许 .5（取子节点中点） */
  row: number
  /** 画布坐标（左上角） */
  x: number
  y: number
}

export interface GraphEdge {
  from: GraphNode
  to: GraphNode
  /** 在当前分支上（要连成一条高亮的主线） */
  active: boolean
}

export interface ConversationGraph {
  nodes: GraphNode[]
  byId: Map<string, GraphNode>
  roots: GraphNode[]
  edges: GraphEdge[]
  /** 画布尺寸（含留白） */
  width: number
  height: number
  metrics: GraphMetrics
}

/** 视口变换：以左上角为原点的平移 + 缩放 */
export interface Viewport {
  scale: number
  x: number
  y: number
}

/** 建节点 / 挂父子；不做布局 */
function buildNodes(turns: readonly TreeTurn[]): { nodes: GraphNode[]; roots: GraphNode[] } {
  const byId = new Map<string, GraphNode>()
  const nodes: GraphNode[] = []
  for (const turn of turns) {
    if (byId.has(turn.id)) continue
    const node: GraphNode = {
      id: turn.id,
      turn,
      parent: turn.parent ?? null,
      children: [],
      depth: 0,
      row: 0,
      x: 0,
      y: 0
    }
    byId.set(node.id, node)
    nodes.push(node)
  }
  // 数据异常：父节点不在列表里、或指着自己 → 当根，节点仍然可见
  for (const node of nodes) {
    if (node.parent !== null && (node.parent === node.id || !byId.has(node.parent))) {
      node.parent = null
    }
  }
  // Break each parent cycle once, before attaching children. Every node belongs to a forest.
  const done = new Set<string>()
  for (const start of nodes) {
    const chain = new Set<string>()
    let node: GraphNode | undefined = start
    while (node && !done.has(node.id)) {
      if (chain.has(node.id)) {
        node.parent = null
        break
      }
      chain.add(node.id)
      node = node.parent ? byId.get(node.parent) : undefined
    }
    for (const id of chain) done.add(id)
  }
  const roots: GraphNode[] = []
  for (const node of nodes) {
    if (node.parent === null) roots.push(node)
    else byId.get(node.parent)?.children.push(node)
  }
  return { nodes, roots }
}

/** 迭代算深度（显式栈，深链不爆栈）；已经来过的节点直接跳过 */
function assignDepth(roots: readonly GraphNode[], byId: Map<string, GraphNode>): void {
  for (const root of roots) {
    const stack: GraphNode[] = [root]
    const seen = new Set<string>()
    while (stack.length) {
      const node = stack.pop()
      if (!node || seen.has(node.id)) continue
      seen.add(node.id)
      node.depth = node.parent ? (byId.get(node.parent)?.depth ?? 0) + 1 : 0
      for (const child of node.children) {
        if (!seen.has(child.id)) stack.push(child)
      }
    }
  }
}

/** Disjoint leaf bands preserve subtree order even when branches have different depths. */
function assignRows(roots: readonly GraphNode[]): void {
  let leaf = 0
  const stack = roots
    .slice()
    .reverse()
    .map((node) => ({ node, visited: false }))
  while (stack.length) {
    const frame = stack.pop()!
    const { node } = frame
    if (!node.children.length) {
      node.row = leaf++
    } else if (frame.visited) {
      node.row = (node.children[0].row + node.children[node.children.length - 1].row) / 2
    } else {
      stack.push({ node, visited: true })
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({ node: node.children[i], visited: false })
      }
    }
  }
}

/** 把轮次列表变成可渲染的图（节点 + 边 + 画布尺寸） */
export function buildGraph(turns: readonly TreeTurn[], metrics?: GraphMetrics): ConversationGraph {
  const m = metrics ?? WIDE_METRICS
  const colStep = m.nodeWidth + m.colGap
  const rowStep = m.nodeHeight + m.rowGap
  const { nodes, roots } = buildNodes(turns)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  assignDepth(roots, byId)
  assignRows(roots)

  let maxDepth = 0
  let maxRow = 0
  for (const node of nodes) {
    if (node.depth > maxDepth) maxDepth = node.depth
    if (node.row > maxRow) maxRow = node.row
    node.x = m.margin + node.depth * colStep
    node.y = m.margin + node.row * rowStep
  }
  const edges: GraphEdge[] = []
  for (const node of nodes) {
    if (node.parent === null) continue
    const from = byId.get(node.parent)
    if (!from) continue
    edges.push({ from, to: node, active: false })
  }
  return {
    nodes,
    byId,
    roots,
    edges,
    width: m.margin * 2 + (maxDepth + 1) * m.nodeWidth + maxDepth * m.colGap,
    height: m.margin * 2 + (maxRow + 1) * m.nodeHeight + maxRow * m.rowGap,
    metrics: m
  }
}

/** 当前节点回溯到根的路径（要连成高亮主线的那条） */
export function activePath(graph: ConversationGraph, current: string | null): Set<string> {
  const path = new Set<string>()
  let node = current ? graph.byId.get(current) : undefined
  while (node && !path.has(node.id)) {
    path.add(node.id)
    node = node.parent ? graph.byId.get(node.parent) : undefined
  }
  return path
}

/** 把所有边标上是否在活跃路径上 */
export function buildEdges(graph: ConversationGraph, path: Set<string>): GraphEdge[] {
  return graph.edges.map((e) => ({ ...e, active: path.has(e.to.id) }))
}

/**
 * 每个节点的子树大小（一次迭代后序，O(n)，不在渲染里逐节点递归）。
 * 异常父链已在 buildGraph 中断开，每个可见节点均参与统计。
 */
export function subtreeSizes(graph: ConversationGraph): Map<string, number> {
  const sizes = new Map<string, number>()
  const childCursor = new Map<string, number>()
  const visited = new Set<string>()
  const stack: GraphNode[] = [...graph.roots].reverse()
  while (stack.length) {
    const node = stack[stack.length - 1]
    const idx = childCursor.get(node.id) ?? 0
    if (idx < node.children.length) {
      childCursor.set(node.id, idx + 1)
      const child = node.children[idx]
      if (!visited.has(child.id)) {
        visited.add(child.id)
        stack.push(child)
      }
      continue
    }
    stack.pop()
    let n = 1
    for (const kid of node.children) n += sizes.get(kid.id) ?? 0
    sizes.set(node.id, n)
  }
  return sizes
}

/** 节点之间的水平贝塞尔（右中点 → 左中点，从卡片下面穿过也不会被卡片盖住） */
export function nodeEdgePath(
  from: GraphNode,
  to: GraphNode,
  metrics: GraphMetrics = WIDE_METRICS
): string {
  const x1 = from.x + metrics.nodeWidth
  const y1 = from.y + metrics.nodeHeight / 2
  const x2 = to.x
  const y2 = to.y + metrics.nodeHeight / 2
  const dx = Math.max(24, (x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return SCALE_MIN
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale))
}

/** 是「拖动」还是「点击」（超过阈值就吞掉随后的 click，防误触） */
export function exceedsDrag(dx: number, dy: number, threshold = DRAG_THRESHOLD): boolean {
  return Math.abs(dx) > threshold || Math.abs(dy) > threshold
}

/** 以画布内的 (px, py) 为锚点缩放：锚点在屏幕上的位置不变 */
export function zoomAt(vp: Viewport, factor: number, px: number, py: number): Viewport {
  const scale = clampScale(vp.scale * factor)
  const k = scale / (vp.scale || 1)
  return { scale, x: px - (px - vp.x) * k, y: py - (py - vp.y) * k }
}

/** 把整张图适配进 (viewWidth, viewHeight) 并居中；尺寸非法返回 null */
export function fitTransform(
  width: number,
  height: number,
  viewWidth: number,
  viewHeight: number,
  pad = WIDE_METRICS.margin
): Viewport | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width <= 0 || height <= 0 || viewWidth <= pad * 2 || viewHeight <= pad * 2) return null
  const scale = clampScale(Math.min((viewWidth - pad * 2) / width, (viewHeight - pad * 2) / height))
  return {
    scale,
    x: (viewWidth - width * scale) / 2,
    y: (viewHeight - height * scale) / 2
  }
}

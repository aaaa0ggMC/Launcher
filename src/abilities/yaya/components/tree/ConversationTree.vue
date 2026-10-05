<script setup lang="ts">
/**
 * 对话树（会话菜单 → 对话树）：把 SessionTree 画成一张真正的「节点 + 边」图。
 *
 * - 每个轮次（SessionTree.turn）都是一个独立节点，父子之间画贝塞尔边，分叉一眼看得见；
 * - 当前所在的那条路径整条高亮，当前节点再加重描边；
 * - 点节点仍然先确认（防误触）：查看这条分支 / 从这里开新分支；
 * - 画布交互：按钮缩放、适应大小、滚轮以指针位置为锚点缩放、指针拖拽平移、
 *   双指捏合缩放；一旦判定成「拖动」就吞掉随后的 click，不会误触节点；
 * - 键盘：Tab 进节点，↑ ↓ 走兄弟、← 回父节点、→ 进第一个子节点、回车确认；
 * - 布局在 graph-layout.ts（纯函数），这里只管渲染与手势。
 */
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '../../../../main/ui/i18n'
import type { SessionTree, TreeTurn } from '../../types'
import {
  activePath,
  buildEdges,
  buildGraph,
  clampScale,
  exceedsDrag,
  fitTransform,
  metricsFor,
  nodeEdgePath,
  subtreeSizes,
  zoomAt,
  SCALE_MAX,
  SCALE_MIN,
  type GraphEdge,
  type GraphNode,
  type Viewport
} from './graph-layout'

const props = defineProps<{ sessionId: string; sessionTitle: string }>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{
  /** 切到这条分支（最新进展） */
  (e: 'view', turn: TreeTurn): void
  /** 从这里开新分支（回答：接在它后面；提问：回到它之前并带回原文） */
  (e: 'branch', turn: TreeTurn, parentEnd: string | null): void
  /** 跳到当前分支里的这一轮（只给主线上的节点：不切分支，只滚动定位） */
  (e: 'jump', turn: TreeTurn): void
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

// ---- 数据 ----
const tree = ref<SessionTree | null>(null)
const loading = ref(false)
const errorMsg = ref('')
const picked = ref<TreeTurn | null>(null)
const narrow = ref(false)
/** 触屏（没有滚轮）：提示只说双指缩放 */
const coarse = ref(false)
const stageEl = ref<HTMLElement | null>(null)
const worldEl = ref<HTMLElement | null>(null)
const stageSize = ref({ w: 0, h: 0 })
const viewport = ref<Viewport>({ scale: 1, x: 0, y: 0 })

const graph = computed(() => buildGraph(tree.value?.turns ?? [], metricsFor(narrow.value)))
/** 当前路径（要高亮连成主线的那串） */
const path = computed(() => activePath(graph.value, tree.value?.current ?? null))
const edges = computed<GraphEdge[]>(() => buildEdges(graph.value, path.value))
const sizes = computed(() => subtreeSizes(graph.value))
const forkCount = computed(() => graph.value.nodes.filter((n) => n.children.length > 1).length)

/**
 * 手势进行中才给 will-change：常驻 will-change 会让浏览器按第一次的缩放把整层栅格化成位图，
 * 之后再缩放文字只是位图拉伸（放大发糊、缩小发虚）；手势结束去掉它，文字按当前缩放重新清晰绘制。
 */
const gesturing = ref(false)
let gestureTimer = 0
function markGesture(): void {
  gesturing.value = true
  window.clearTimeout(gestureTimer)
  gestureTimer = window.setTimeout(() => (gesturing.value = false), 180)
}

const worldStyle = computed(() => ({
  width: `${graph.value.width}px`,
  height: `${graph.value.height}px`,
  transform: `translate(${viewport.value.x}px, ${viewport.value.y}px) scale(${viewport.value.scale})`,
  willChange: gesturing.value ? 'transform' : 'auto'
}))

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

let loadSequence = 0
async function load(): Promise<void> {
  const sequence = ++loadSequence
  const id = props.sessionId
  if (!open.value || !id) return
  loading.value = true
  errorMsg.value = ''
  try {
    const result = (await window.cockpit.command('yaya.session-tree', { id })) as SessionTree
    if (sequence !== loadSequence || !open.value || id !== props.sessionId) return
    tree.value = result
    await nextTick()
    measure()
    viewport.value = { scale: 1, x: 0, y: 0 }
    centerCurrent()
  } catch (e) {
    if (sequence !== loadSequence || !open.value) return
    tree.value = null
    errorMsg.value = errText(e)
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

watch(open, (o) => {
  picked.value = null
  resetPointers()
  if (o) void load()
  else {
    loadSequence++
    loading.value = false
  }
})
watch(
  () => props.sessionId,
  () => {
    loadSequence++
    tree.value = null
    picked.value = null
    resetPointers()
    if (open.value) void load()
  }
)

// ---- 视口：缩放 / 平移 / 捏合 ----
function measure(): void {
  const el = stageEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  stageSize.value = { w: r.width, h: r.height }
}

function applyFit(): void {
  const g = graph.value
  const s = stageSize.value
  const vp = fitTransform(g.width, g.height, s.w, s.h, g.metrics.margin)
  if (vp) viewport.value = vp
}

/** 保持当前缩放，把当前节点挪到画布正中（打开时的视角） */
function centerCurrent(): void {
  const id = tree.value?.current
  const node = id ? graph.value.byId.get(id) : undefined
  const s = stageSize.value
  const m = graph.value.metrics
  if (!node || !s.w || !s.h) return
  viewport.value = {
    scale: viewport.value.scale,
    x: s.w / 2 - (node.x + m.nodeWidth / 2) * viewport.value.scale,
    y: s.h / 2 - (node.y + m.nodeHeight / 2) * viewport.value.scale
  }
}

/** 按钮缩放：以画布中心为锚点 */
function zoomBy(factor: number): void {
  const s = stageSize.value
  if (!s.w || !s.h) return
  viewport.value = zoomAt(viewport.value, factor, s.w / 2, s.h / 2)
}

/** wheel：以指针位置为锚点（手动挂 passive:false 才不会变成整页缩放） */
function onWheel(e: WheelEvent): void {
  e.preventDefault()
  const rect = stageEl.value?.getBoundingClientRect()
  if (!rect) return
  const px = e.clientX - rect.left
  const py = e.clientY - rect.top
  // 触控板 / 鼠标滚轮的行内滚动换算成像素
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY
  markGesture()
  viewport.value = zoomAt(viewport.value, Math.exp(-dy * 0.0015), px, py)
}

/** client 坐标下的活动指针；两个 = 捏合 */
const pointers = new Map<number, { x: number; y: number }>()
let panning = false
/** 这次手势已经被判定成「拖动」→ 后续 click 全部吞掉 */
let dragged = false
let panStart = { x: 0, y: 0 }
interface Pinch {
  dist: number
  scale: number
  cx: number
  cy: number
  x: number
  y: number
}
let pinch: Pinch | null = null

function pinchState(): Pinch | null {
  const pts = [...pointers.values()]
  if (pts.length !== 2) return null
  const rect = stageEl.value?.getBoundingClientRect()
  if (!rect) return null
  return {
    dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
    scale: viewport.value.scale,
    cx: (pts[0].x + pts[1].x) / 2 - rect.left,
    cy: (pts[0].y + pts[1].y) / 2 - rect.top,
    x: viewport.value.x,
    y: viewport.value.y
  }
}

function applyPinch(): void {
  const p = pinch
  if (!p) return
  const pts = [...pointers.values()]
  if (pts.length !== 2) return
  const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
  if (p.dist <= 0 || dist <= 0) return
  const scale = clampScale(p.scale * (dist / p.dist))
  const k = scale / p.scale
  const rect = stageEl.value?.getBoundingClientRect()
  if (!rect) return
  const cx = (pts[0].x + pts[1].x) / 2 - rect.left
  const cy = (pts[0].y + pts[1].y) / 2 - rect.top
  viewport.value = { scale, x: cx - (p.cx - p.x) * k, y: cy - (p.cy - p.y) * k }
}

function onPointerDown(e: PointerEvent): void {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pointers.size >= 2) {
    pinch = pinchState()
    for (const id of pointers.keys()) capturePointer(id)
    panning = false
    dragged = true
    return
  }
  panning = true
  dragged = false
  panStart = { x: e.clientX, y: e.clientY }
  // 从空白处按下就抓住指针；从节点上按下时先不抓（否则会吃掉按钮的 click）
  if (!(e.target as HTMLElement | null)?.closest?.('.graph-node')) {
    capturePointer(e.pointerId)
  }
}

function onPointerMove(e: PointerEvent): void {
  const prev = pointers.get(e.pointerId)
  if (!prev) return
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pointers.size >= 2) {
    if (pinch) applyPinch()
    markGesture()
    dragged = true
    return
  }
  if (!panning) return
  // 累计位移超过阈值才算拖动；这时再把指针抓到舞台上，拖到画布外也不丢
  if (!dragged && exceedsDrag(e.clientX - panStart.x, e.clientY - panStart.y)) {
    dragged = true
    capturePointer(e.pointerId)
  }
  if (!dragged) return
  markGesture()
  viewport.value = {
    ...viewport.value,
    x: viewport.value.x + (e.clientX - prev.x),
    y: viewport.value.y + (e.clientY - prev.y)
  }
}

function capturePointer(id: number): void {
  try {
    stageEl.value?.setPointerCapture(id)
  } catch {
    /* pointer already ended */
  }
}
function resetPointers(): void {
  const ids = [...pointers.keys()]
  pointers.clear()
  panning = false
  pinch = null
  for (const id of ids) {
    if (stageEl.value?.hasPointerCapture(id)) stageEl.value.releasePointerCapture(id)
  }
}
function onPointerUp(e: PointerEvent): void {
  if (!pointers.delete(e.pointerId)) return
  pinch = pointers.size === 2 ? pinchState() : null
  panning = pointers.size === 1
  if (panning) panStart = [...pointers.values()][0]
  const stage = stageEl.value
  if (stage?.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId)
}

// ---- 节点：点击 / 键盘 ----
function onNodeClick(turn: TreeTurn, event: MouseEvent): void {
  if (dragged && event.detail !== 0) {
    dragged = false
    return
  }
  picked.value = turn
}

function siblingsOf(node: GraphNode): GraphNode[] {
  if (!node.parent) return graph.value.roots
  return graph.value.byId.get(node.parent)?.children ?? [node]
}

function focusNode(id: string): void {
  const safe = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id
  worldEl.value?.querySelector<HTMLElement>(`[data-node-id="${safe}"]`)?.focus()
}

function onNodeKey(e: KeyboardEvent, node: GraphNode): void {
  let next: GraphNode | undefined
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const sibs = siblingsOf(node)
    const i = sibs.indexOf(node)
    next = sibs[e.key === 'ArrowUp' ? i - 1 : i + 1]
  } else if (e.key === 'ArrowLeft') {
    next = node.parent ? graph.value.byId.get(node.parent) : undefined
  } else if (e.key === 'ArrowRight') {
    next = node.children[0]
  }
  if (!next) return
  e.preventDefault()
  focusNode(next.id)
}

function nodeStyle(node: GraphNode): Record<string, string> {
  const m = graph.value.metrics
  return {
    left: `${node.x}px`,
    top: `${node.y}px`,
    width: `${m.nodeWidth}px`,
    height: `${m.nodeHeight}px`
  }
}

function edgePath(e: GraphEdge): string {
  return nodeEdgePath(e.from, e.to, graph.value.metrics)
}

function timeText(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/** 无障碍名 / tooltip：预览、类型、时间、工具与分支摘要 */
function nodeLabel(node: GraphNode): string {
  const preview = node.turn.preview || t('yaya.tree.no_text', '（只调用了工具）')
  const kind =
    node.turn.kind === 'user'
      ? t('yaya.tree.pick_user', '这条提问')
      : t('yaya.tree.pick_answer', '这轮回答')
  const parts = [preview, kind, timeText(node.turn.createdAt)]
  if (node.turn.tools)
    parts.push(te('yaya.tree.tools', { n: String(node.turn.tools) }, '{n} 次工具调用'))
  if (node.children.length > 1) {
    parts.push(te('yaya.tree.forks', { n: String(node.children.length) }, '{n} 个分支'))
  } else if (node.children.length === 1) {
    parts.push(te('yaya.tree.nodes', { n: String(sizes.value.get(node.id) ?? 1) }, '{n} 个节点'))
  }
  return parts.join(' · ')
}

function parentEndOf(turn: TreeTurn): string | null {
  if (!turn.parent) return null
  return graph.value.byId.get(turn.parent)?.turn.endId ?? null
}

function confirmView(): void {
  const turn = picked.value
  if (!turn) return
  picked.value = null
  open.value = false
  emit('view', turn)
}

/** 选中的节点在当前分支（主线）上：可以直接跳过去 */
const pickedOnPath = computed(() => !!picked.value && path.value.has(picked.value.id))

function confirmJump(): void {
  const turn = picked.value
  if (!turn) return
  picked.value = null
  open.value = false
  emit('jump', turn)
}

function confirmBranch(): void {
  const turn = picked.value
  if (!turn) return
  picked.value = null
  open.value = false
  emit('branch', turn, parentEndOf(turn))
}

// ---- 窄屏（手机）全屏；与全站断点一致 ----
let narrowMql: MediaQueryList | null = null
let ro: ResizeObserver | null = null

function onNarrowChange(e: MediaQueryListEvent): void {
  narrow.value = e.matches
}

onMounted(() => {
  narrowMql = window.matchMedia('(max-width: 720px)')
  narrow.value = narrowMql.matches
  coarse.value = window.matchMedia('(pointer: coarse)').matches
  narrowMql.addEventListener('change', onNarrowChange)
})

onBeforeUnmount(() => {
  narrowMql?.removeEventListener('change', onNarrowChange)
  narrowMql = null
  ro?.disconnect()
  ro = null
  window.clearTimeout(gestureTimer)
  loadSequence++
  resetPointers()
})

watch(
  stageEl,
  (el) => {
    ro?.disconnect()
    if (!el) return
    measure()
    centerCurrent()
    ro = new ResizeObserver(measure)
    ro.observe(el)
  },
  { flush: 'post' }
)

// 窄 / 宽切换后卡片尺寸变了，重新适配一次
watch(narrow, () => {
  void nextTick(() => {
    measure()
    applyFit()
    centerCurrent()
  })
})
</script>

<template>
  <v-dialog v-model="open" :fullscreen="narrow" :max-width="narrow ? undefined : 1024" scrollable>
    <v-card class="tree-card" :class="{ 'is-fullscreen': narrow }" :rounded="narrow ? 0 : 'xl'">
      <div class="tree-head">
        <v-icon icon="mdi-file-tree-outline" />
        <div class="min-w-0 flex-grow-1">
          <div class="text-subtitle-1 font-weight-medium">
            {{ t('yaya.tree.title', '对话树') }}
          </div>
          <div class="text-caption text-medium-emphasis text-truncate">
            {{ sessionTitle }}
            <template v-if="tree">
              ·
              {{
                te(
                  'yaya.tree.summary',
                  { n: String(tree.turns.length), f: String(forkCount) },
                  '{n} 个节点，{f} 处分叉'
                )
              }}
            </template>
          </div>
        </div>
        <v-btn
          icon="mdi-close"
          variant="text"
          size="small"
          :title="t('yaya.close', '关闭')"
          :aria-label="t('yaya.close', '关闭')"
          @click="open = false"
        />
      </div>

      <div class="graph-toolbar">
        <span class="text-caption text-medium-emphasis graph-tip">
          {{
            coarse
              ? t('yaya.tree.pan_hint_touch', '拖动平移 · 双指缩放')
              : t('yaya.tree.pan_hint', '拖动平移 · 滚轮 / 双指缩放')
          }}
        </span>
        <v-spacer />
        <div class="d-flex align-center ga-1 flex-shrink-0">
          <v-btn
            icon="mdi-magnify-minus-outline"
            variant="text"
            size="small"
            :disabled="viewport.scale <= SCALE_MIN"
            :title="t('yaya.tree.zoom_out', '缩小')"
            :aria-label="t('yaya.tree.zoom_out', '缩小')"
            @click="zoomBy(1 / 1.25)"
          />
          <v-btn
            icon="mdi-magnify-plus-outline"
            variant="text"
            size="small"
            :disabled="viewport.scale >= SCALE_MAX"
            :title="t('yaya.tree.zoom_in', '放大')"
            :aria-label="t('yaya.tree.zoom_in', '放大')"
            @click="zoomBy(1.25)"
          />
          <v-btn
            icon="mdi-fit-to-page-outline"
            variant="text"
            size="small"
            :title="t('yaya.tree.fit', '适应大小')"
            :aria-label="t('yaya.tree.fit', '适应大小')"
            @click="applyFit"
          />
          <span class="zoom-chip text-caption">
            {{
              te(
                'yaya.tree.zoom_level',
                { n: String(Math.round(viewport.scale * 100)) },
                '缩放 {n}%'
              )
            }}
          </span>
        </div>
      </div>

      <div
        ref="stageEl"
        class="graph-stage"
        role="group"
        :aria-label="t('yaya.tree.title', '对话树')"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @lostpointercapture="onPointerUp"
        @wheel.prevent="onWheel"
      >
        <div v-if="loading && !tree" class="d-flex justify-center pa-8">
          <v-progress-circular indeterminate size="26" width="3" color="primary" />
        </div>
        <div v-else-if="errorMsg" class="graph-state">
          <v-icon icon="mdi-alert-circle-outline" size="26" color="error" />
          <div class="graph-state-text">
            {{ te('yaya.tree.load_failed', { error: errorMsg }, '加载失败：{error}') }}
          </div>
          <v-btn variant="tonal" prepend-icon="mdi-refresh" @click="load()">
            {{ t('yaya.tree.retry', '重试') }}
          </v-btn>
        </div>
        <div v-else-if="!graph.nodes.length" class="graph-state">
          <div class="graph-state-text text-medium-emphasis">
            {{ t('yaya.tree.empty_session', '这个对话还没有消息') }}
          </div>
        </div>
        <div v-show="graph.nodes.length" ref="worldEl" class="graph-world" :style="worldStyle">
          <svg
            class="graph-edges"
            :width="graph.width"
            :height="graph.height"
            aria-hidden="true"
            focusable="false"
          >
            <path
              v-for="e in edges"
              :key="e.to.id"
              class="graph-edge"
              :class="{ 'is-active': e.active }"
              :d="edgePath(e)"
            />
          </svg>
          <button
            v-for="node in graph.nodes"
            :key="node.id"
            type="button"
            class="graph-node"
            :class="{
              'is-user': node.turn.kind === 'user',
              'is-active': path.has(node.id),
              'is-current': node.id === tree?.current
            }"
            :data-node-id="node.id"
            :aria-current="node.id === tree?.current ? 'true' : undefined"
            :aria-label="nodeLabel(node)"
            :title="nodeLabel(node)"
            :style="nodeStyle(node)"
            @click="onNodeClick(node.turn, $event)"
            @keydown="onNodeKey($event, node)"
          >
            <v-icon
              :icon="node.turn.kind === 'user' ? 'mdi-account-outline' : 'mdi-robot-happy-outline'"
              size="18"
              class="node-icon"
              aria-hidden="true"
            />
            <span class="node-body">
              <span class="node-text">
                {{
                  node.turn.preview ||
                  (node.turn.kind === 'answer'
                    ? t('yaya.tree.no_text', '（只调用了工具）')
                    : t('yaya.tree.empty', '（空消息）'))
                }}
              </span>
              <!-- 一行放下：时间 + 图标计数（完整说明在 title / aria-label 里），放不下就省略号 -->
              <span class="node-meta">
                <span v-if="node.id === tree?.current" class="node-here">
                  {{ t('yaya.tree.current', '当前') }}
                </span>
                <span class="meta-time">{{ timeText(node.turn.createdAt) }}</span>
                <span v-if="node.turn.tools" class="meta-item">
                  <v-icon icon="mdi-wrench-outline" size="12" aria-hidden="true" />{{
                    node.turn.tools
                  }}
                </span>
                <span v-if="node.children.length > 1" class="meta-item node-fork">
                  <v-icon icon="mdi-source-branch" size="12" aria-hidden="true" />{{
                    node.children.length
                  }}
                </span>
              </span>
            </span>
          </button>
        </div>
      </div>
    </v-card>

    <!-- 确认：防误触 -->
    <v-dialog
      :model-value="picked !== null"
      max-width="440"
      @update:model-value="(v: boolean) => !v && (picked = null)"
    >
      <v-card v-if="picked" class="pa-2" rounded="xl">
        <v-card-title class="text-h6">
          {{
            picked.kind === 'user'
              ? t('yaya.tree.pick_user', '这条提问')
              : t('yaya.tree.pick_answer', '这轮回答')
          }}
        </v-card-title>
        <v-card-text class="d-flex flex-column ga-3">
          <div class="picked-preview">
            {{ picked.preview || t('yaya.tree.no_text', '（只调用了工具）') }}
          </div>
          <div class="text-body-2 text-medium-emphasis">
            {{
              picked.kind === 'user'
                ? t(
                    'yaya.tree.branch_user_hint',
                    '「从这里开新分支」会回到这条提问之前，并把原问题放进输入框，改完再发就是一条新分支。'
                  )
                : t(
                    'yaya.tree.branch_answer_hint',
                    '「从这里开新分支」之后，你发的下一条消息会接在这轮回答后面。'
                  )
            }}
          </div>
        </v-card-text>
        <v-card-actions class="flex-wrap justify-end ga-2 px-4 pb-4">
          <v-btn variant="text" @click="picked = null">{{ t('yaya.cancel', '取消') }}</v-btn>
          <!-- 主线上的节点「查看这条分支」就是现在这条，换成直接跳到这一轮 -->
          <v-btn v-if="pickedOnPath" variant="tonal" prepend-icon="mdi-target" @click="confirmJump">
            {{ t('yaya.tree.jump_here', '跳转到此节点') }}
          </v-btn>
          <v-btn v-else variant="tonal" prepend-icon="mdi-eye-outline" @click="confirmView">
            {{ t('yaya.tree.view', '查看这条分支') }}
          </v-btn>
          <v-btn
            color="primary"
            variant="flat"
            prepend-icon="mdi-source-branch-plus"
            @click="confirmBranch"
          >
            {{ t('yaya.tree.branch_here', '从这里开新分支') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-dialog>
</template>

<style scoped>
.tree-card {
  display: flex;
  flex-direction: column;
  max-height: calc(var(--app-vh, 100vh) * 0.88);
}
.tree-card.is-fullscreen {
  max-height: 100%;
  height: 100%;
}
.tree-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 12px 8px 20px;
}
.graph-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 8px 20px 12px;
}
/* 提示可以换行，不截断；窄到放不下时整行让给它，按钮换到下一行右侧 */
.graph-tip {
  min-width: 0;
  flex: 1 1 160px;
  line-height: 1.5;
}
.zoom-chip {
  padding-block: 4px;
  min-height: 24px;
  display: inline-flex;
  align-items: center;
  padding-inline: 8px;
  border-radius: 8px;
  background: rgba(var(--v-theme-on-surface), 0.06);
  white-space: nowrap;
}
/* 画布：自己滚（平移），不让整页跟着滚 */
.graph-stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  margin: 0 12px 12px;
  border-radius: 12px;
  background: rgba(var(--v-theme-on-surface), 0.03);
  touch-action: none;
  cursor: grab;
}
.graph-stage:active {
  cursor: grabbing;
}
/* 缩放 / 平移都作用在这一层上 */
.graph-world {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  will-change: transform;
}
.graph-edges {
  position: absolute;
  left: 0;
  top: 0;
  overflow: visible;
  pointer-events: none;
}
.graph-edge {
  fill: none;
  stroke: rgba(var(--v-theme-on-surface), 0.22);
  stroke-width: 2;
}
.graph-edge.is-active {
  stroke: rgb(var(--v-theme-primary));
  stroke-width: 3;
}

/* 节点卡片 */
.graph-node {
  position: absolute;
  overflow: hidden;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 2px solid rgba(var(--v-theme-on-surface), 0.16);
  border-radius: 12px;
  background: rgb(var(--v-theme-surface));
  color: inherit;
  text-align: left;
  cursor: pointer;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
}
.graph-node:hover {
  border-color: rgba(var(--v-theme-primary), 0.6);
}
.graph-node:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
/* 在当前路径上 */
.graph-node.is-active {
  border-color: rgba(var(--v-theme-primary), 0.5);
}
/* 当前所在节点 */
.graph-node.is-current {
  border-color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.12);
  box-shadow: 0 0 0 3px rgba(var(--v-theme-primary), 0.18);
}
.node-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: rgba(var(--v-theme-on-surface), 0.6);
}
.is-active .node-icon {
  color: rgb(var(--v-theme-primary));
}
.node-body {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 4px;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
}
/* 卡片高度固定：正文最多两行，第三行留给信息行（之前三行正文 + 换行的信息行会溢出卡片） */
.node-text {
  font-size: 0.875rem;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.is-user .node-text {
  font-weight: 600;
}
.node-meta {
  font-size: 0.75rem;
  line-height: 1.4;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  color: rgba(var(--v-theme-on-surface), 0.65);
}
.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.meta-time {
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.node-here {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 6px;
  background: rgba(var(--v-theme-primary), 0.16);
  color: rgb(var(--v-theme-primary));
  font-weight: 700;
}
.node-fork {
  color: rgb(var(--v-theme-warning));
}

/* 加载 / 错误 / 空状态 */
.graph-state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
}
.graph-state-text {
  font-size: 0.875rem;
  line-height: 1.5;
  max-width: 420px;
  word-break: break-word;
}

.picked-preview {
  font-size: 0.9rem;
  line-height: 1.5;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(var(--v-theme-on-surface), 0.05);
  max-height: 160px;
  overflow-y: auto;
  word-break: break-word;
}
</style>

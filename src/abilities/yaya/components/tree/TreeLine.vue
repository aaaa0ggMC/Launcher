<script setup lang="ts">
/**
 * 对话树的一条「线」：从 start 开始沿主线往下（同一缩进），每个分叉点把其余子分支
 * 收成可展开的分组（缩进一级，递归渲染另一条线）。只在分叉处缩进，长对话不会越缩越窄。
 */
import { computed, inject, ref } from 'vue'
import { useI18n } from '../../../../main/ui/i18n'
import type { TreeTurn } from '../../types'

defineOptions({ name: 'TreeLine' })

const props = defineProps<{
  start: string
  byId: Map<string, TreeTurn>
  childrenOf: Map<string, TreeTurn[]>
  current: string | null
  expanded: Set<string>
}>()
const emit = defineEmits<{
  (e: 'pick', turn: TreeTurn): void
  (e: 'toggle', id: string): void
  /** 点了合并的直线段：父组件弹窗列出这一段 */
  (e: 'segment', turns: TreeTurn[]): void
}>()

const lang = inject('cockpit:lang', ref('zh'))
const { t, te } = useI18n(lang)

/** 主线子节点：在当前分支上的优先，否则最新的 */
function mainChild(id: string): TreeTurn | undefined {
  const kids = props.childrenOf.get(id) ?? []
  return kids.find((k) => k.active) ?? kids[kids.length - 1]
}

/** 子树节点数（分支分组的摘要） */
function subtreeSize(id: string): number {
  let n = 1
  for (const k of props.childrenOf.get(id) ?? []) n += subtreeSize(k.id)
  return n
}

interface NodeRow {
  type: 'node'
  key: string
  turn: TreeTurn
  branches: TreeTurn[]
}
interface SegmentRow {
  type: 'segment'
  key: string
  turns: TreeTurn[]
  active: boolean
}
/**
 * 沿主线收集节点，再把两个「关键节点」之间的直线段（没有分叉、不是当前节点）合并成一行：
 * 分叉 - A - B - C - 分叉 → 分叉 - [A … C · 3] - 分叉，主干与分叉一眼看清。
 */
const rows = computed<(NodeRow | SegmentRow)[]>(() => {
  const line: NodeRow[] = []
  let turn = props.byId.get(props.start)
  const seen = new Set<string>()
  while (turn && !seen.has(turn.id)) {
    seen.add(turn.id)
    const main = mainChild(turn.id)
    const branches = (props.childrenOf.get(turn.id) ?? []).filter((k) => k !== main)
    line.push({ type: 'node', key: turn.id, turn, branches })
    turn = main
  }
  const out: (NodeRow | SegmentRow)[] = []
  let run: TreeTurn[] = []
  const flush = (): void => {
    if (run.length >= 2) {
      out.push({
        type: 'segment',
        key: `seg:${run[0].id}`,
        turns: run,
        active: run.some((x) => x.active)
      })
    } else for (const x of run) out.push({ type: 'node', key: x.id, turn: x, branches: [] })
    run = []
  }
  for (const row of line) {
    const plain = !row.branches.length && row.turn.id !== props.current
    if (plain) {
      run.push(row.turn)
      continue
    }
    flush()
    out.push(row)
  }
  flush()
  return out
})

function short(turn: TreeTurn): string {
  return turn.preview || (turn.kind === 'answer' ? t('yaya.tree.no_text', '（只调用了工具）') : '…')
}

function timeText(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}
</script>

<template>
  <div class="tree-line">
    <template v-for="row in rows" :key="row.key">
      <button
        v-if="row.type === 'segment'"
        type="button"
        class="tree-node tree-seg"
        :class="{ 'is-active': row.active }"
        @click="emit('segment', row.turns)"
      >
        <span class="node-dot seg-dot" aria-hidden="true">
          <v-icon icon="mdi-dots-vertical" size="16" />
        </span>
        <span class="node-body">
          <span class="seg-text">
            <span class="seg-end">{{ short(row.turns[0]) }}</span>
            <span class="seg-sep text-medium-emphasis">…</span>
            <span class="seg-end">{{ short(row.turns[row.turns.length - 1]) }}</span>
          </span>
          <span class="node-meta text-medium-emphasis">
            {{
              te(
                'yaya.tree.merged',
                { n: String(row.turns.length) },
                '合并了 {n} 个节点 · 点开查看'
              )
            }}
          </span>
        </span>
      </button>
      <button
        v-else
        type="button"
        class="tree-node"
        :class="{
          'is-user': row.turn.kind === 'user',
          'is-active': row.turn.active,
          'is-current': row.turn.id === current
        }"
        :data-turn-id="row.turn.id"
        :aria-current="row.turn.id === current ? 'true' : undefined"
        @click="emit('pick', row.turn)"
      >
        <span class="node-dot" aria-hidden="true">
          <v-icon
            :icon="row.turn.kind === 'user' ? 'mdi-account-outline' : 'mdi-robot-happy-outline'"
            size="16"
          />
        </span>
        <span class="node-body">
          <span class="node-text">
            {{
              row.turn.preview ||
              (row.turn.kind === 'answer'
                ? t('yaya.tree.no_text', '（只调用了工具）')
                : t('yaya.tree.empty', '（空消息）'))
            }}
          </span>
          <span class="node-meta text-medium-emphasis">
            <span v-if="row.turn.id === current" class="node-here">
              {{ t('yaya.tree.current', '当前') }}
            </span>
            <span>{{ timeText(row.turn.createdAt) }}</span>
            <span v-if="row.turn.tools">
              · {{ te('yaya.tree.tools', { n: String(row.turn.tools) }, '{n} 次工具调用') }}
            </span>
            <span v-if="row.branches.length" class="node-fork">
              · {{ te('yaya.tree.forks', { n: String(row.branches.length + 1) }, '{n} 个分支') }}
            </span>
          </span>
        </span>
      </button>

      <div v-for="b in row.type === 'node' ? row.branches : []" :key="b.id" class="tree-branch">
        <button
          type="button"
          class="branch-head"
          :aria-expanded="expanded.has(b.id)"
          @click="emit('toggle', b.id)"
        >
          <v-icon :icon="expanded.has(b.id) ? 'mdi-chevron-down' : 'mdi-source-branch'" size="16" />
          <span class="branch-text">
            {{ b.preview || t('yaya.tree.branch', '另一分支') }}
          </span>
          <span class="branch-count text-medium-emphasis">
            {{ te('yaya.tree.nodes', { n: String(subtreeSize(b.id)) }, '{n} 个节点') }}
          </span>
        </button>
        <TreeLine
          v-if="expanded.has(b.id)"
          class="branch-body"
          :start="b.id"
          :by-id="byId"
          :children-of="childrenOf"
          :current="current"
          :expanded="expanded"
          @pick="(x: TreeTurn) => emit('pick', x)"
          @toggle="(id: string) => emit('toggle', id)"
          @segment="(xs: TreeTurn[]) => emit('segment', xs)"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.tree-line {
  display: flex;
  flex-direction: column;
  gap: 2px;
  position: relative;
}
.tree-node {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  min-height: 48px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
  position: relative;
}
/* 竖线：把同一条线上的节点串起来 */
.tree-node::before {
  content: '';
  position: absolute;
  left: 23px;
  top: 0;
  bottom: 0;
  width: 2px;
  background: rgba(var(--v-theme-on-surface), 0.1);
  z-index: 0;
}
.tree-node:hover {
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.tree-node.is-active::before {
  background: rgba(var(--v-theme-primary), 0.45);
}
.tree-node.is-current {
  border-color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.1);
}
.node-dot {
  position: relative;
  z-index: 1;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: rgb(var(--v-theme-surface));
  border: 2px solid rgba(var(--v-theme-on-surface), 0.2);
}
.is-active .node-dot {
  border-color: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-primary));
}
.node-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding-top: 3px;
}
.node-text {
  font-size: 0.875rem;
  line-height: 1.45;
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
  font-size: 0.72rem;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.node-here {
  color: rgb(var(--v-theme-primary));
  font-weight: 700;
}
.node-fork {
  color: rgb(var(--v-theme-warning));
}
.tree-seg .seg-dot {
  border-style: dashed;
}
.seg-text {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  font-size: 0.85rem;
}
.seg-end {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.seg-sep {
  flex-shrink: 0;
}
.tree-branch {
  margin-left: 22px;
  padding-left: 12px;
  border-left: 2px dashed rgba(var(--v-theme-on-surface), 0.15);
}
.branch-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 40px;
  padding: 6px 10px;
  border: none;
  border-radius: 10px;
  background: rgba(var(--v-theme-on-surface), 0.04);
  color: inherit;
  text-align: left;
  font-size: 0.8rem;
  cursor: pointer;
}
.branch-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.branch-count {
  flex-shrink: 0;
  font-size: 0.72rem;
}
.branch-body {
  margin-top: 4px;
}
</style>

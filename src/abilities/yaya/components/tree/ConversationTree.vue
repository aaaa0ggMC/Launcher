<script setup lang="ts">
/**
 * 对话树（右上角菜单 → 对话树）：代替消息上的 `< 2/3 >` 分支切换器。
 * - 打开时当前节点居中；当前所在路径高亮；其余分支收成分组（只在分叉处缩进）；
 * - 分叉点之间的直线段合并成一行，点开弹窗列出这一段；
 * - 点任意节点先确认（防误触）：查看这条分支 / 从这里开新分支。
 */
import { computed, inject, nextTick, ref, watch } from 'vue'
import { useI18n } from '../../../../main/ui/i18n'
import type { SessionTree, TreeTurn } from '../../types'
import TreeLine from './TreeLine.vue'

const props = defineProps<{ sessionId: string; sessionTitle: string }>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{
  /** 切到这条分支（最新进展） */
  (e: 'view', turn: TreeTurn): void
  /** 从这里开新分支（回答：接在它后面；提问：回到它之前并带回原文） */
  (e: 'branch', turn: TreeTurn, parentEnd: string | null): void
}>()

const lang = inject('cockpit:lang', ref('zh'))
const { t, te } = useI18n(lang)

const tree = ref<SessionTree | null>(null)
const loading = ref(false)
const expanded = ref(new Set<string>())
const segment = ref<TreeTurn[] | null>(null)
const picked = ref<TreeTurn | null>(null)
const bodyEl = ref<HTMLElement | null>(null)
const narrow = ref(false)

const byId = computed(() => new Map((tree.value?.turns ?? []).map((x) => [x.id, x])))
const childrenOf = computed(() => {
  const m = new Map<string, TreeTurn[]>()
  for (const x of tree.value?.turns ?? []) {
    const key = x.parent ?? ''
    const list = m.get(key)
    if (list) list.push(x)
    else m.set(key, [x])
  }
  return m
})
/** 根：在当前分支上的优先，否则最新的；其余根作为分支分组 */
const rootMain = computed(() => {
  const roots = childrenOf.value.get('') ?? []
  return roots.find((r) => r.active) ?? roots[roots.length - 1]
})
const otherRoots = computed(() =>
  (childrenOf.value.get('') ?? []).filter((r) => r !== rootMain.value)
)
const forkCount = computed(
  () => [...childrenOf.value.entries()].filter(([, kids]) => kids.length > 1).length
)

async function load(): Promise<void> {
  if (!props.sessionId) return
  loading.value = true
  try {
    tree.value = (await window.cockpit.command('yaya.session-tree', {
      id: props.sessionId
    })) as SessionTree
  } finally {
    loading.value = false
  }
  // 当前节点居中
  await nextTick()
  const el = bodyEl.value?.querySelector<HTMLElement>('[aria-current="true"]')
  el?.scrollIntoView({ block: 'center' })
}

watch(open, (o) => {
  if (!o) return
  narrow.value = window.matchMedia('(max-width: 720px)').matches
  expanded.value = new Set()
  segment.value = null
  picked.value = null
  void load()
})

function toggle(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function pick(turn: TreeTurn): void {
  picked.value = turn
}

function parentEndOf(turn: TreeTurn): string | null {
  return turn.parent ? (byId.value.get(turn.parent)?.endId ?? null) : null
}

function confirmView(): void {
  const turn = picked.value
  if (!turn) return
  picked.value = null
  segment.value = null
  open.value = false
  emit('view', turn)
}
function confirmBranch(): void {
  const turn = picked.value
  if (!turn) return
  picked.value = null
  segment.value = null
  open.value = false
  emit('branch', turn, parentEndOf(turn))
}
</script>

<template>
  <v-dialog v-model="open" :fullscreen="narrow" :max-width="narrow ? undefined : 720" scrollable>
    <v-card class="tree-card" :rounded="narrow ? 0 : 'xl'">
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
      <p class="tree-hint text-caption text-medium-emphasis">
        {{
          t(
            'yaya.tree.hint',
            '点节点可以查看那条分支，或从那里开一个新分支（原来的对话都会保留）。'
          )
        }}
      </p>
      <div ref="bodyEl" class="tree-body">
        <div v-if="loading && !tree" class="d-flex justify-center pa-8">
          <v-progress-circular indeterminate size="26" width="3" color="primary" />
        </div>
        <div v-else-if="!tree?.turns.length" class="text-medium-emphasis pa-6 text-center">
          {{ t('yaya.tree.empty_session', '这个对话还没有消息') }}
        </div>
        <template v-else>
          <TreeLine
            v-if="rootMain"
            :start="rootMain.id"
            :by-id="byId"
            :children-of="childrenOf"
            :current="tree.current"
            :expanded="expanded"
            @pick="pick"
            @toggle="toggle"
            @segment="(xs: TreeTurn[]) => (segment = xs)"
          />
          <div v-for="r in otherRoots" :key="r.id" class="root-branch">
            <button
              type="button"
              class="root-head"
              :aria-expanded="expanded.has(r.id)"
              @click="toggle(r.id)"
            >
              <v-icon
                :icon="expanded.has(r.id) ? 'mdi-chevron-down' : 'mdi-source-branch'"
                size="16"
              />
              <span class="text-truncate">{{
                r.preview || t('yaya.tree.branch', '另一分支')
              }}</span>
            </button>
            <TreeLine
              v-if="expanded.has(r.id)"
              :start="r.id"
              :by-id="byId"
              :children-of="childrenOf"
              :current="tree.current"
              :expanded="expanded"
              @pick="pick"
              @toggle="toggle"
              @segment="(xs: TreeTurn[]) => (segment = xs)"
            />
          </div>
        </template>
      </div>
    </v-card>

    <!-- 合并的直线段 -->
    <v-dialog
      :model-value="segment !== null"
      :fullscreen="narrow"
      :max-width="narrow ? undefined : 560"
      scrollable
      @update:model-value="(v: boolean) => !v && (segment = null)"
    >
      <v-card class="tree-card" :rounded="narrow ? 0 : 'xl'">
        <div class="tree-head">
          <v-icon icon="mdi-dots-vertical" />
          <div class="text-subtitle-1 font-weight-medium flex-grow-1">
            {{
              te(
                'yaya.tree.segment_title',
                { n: String(segment?.length ?? 0) },
                '这一段的 {n} 个节点'
              )
            }}
          </div>
          <v-btn
            icon="mdi-close"
            variant="text"
            size="small"
            :title="t('yaya.close', '关闭')"
            :aria-label="t('yaya.close', '关闭')"
            @click="segment = null"
          />
        </div>
        <div class="tree-body">
          <button
            v-for="x in segment ?? []"
            :key="x.id"
            type="button"
            class="seg-item"
            :class="{ 'is-active': x.active }"
            @click="pick(x)"
          >
            <v-icon
              :icon="x.kind === 'user' ? 'mdi-account-outline' : 'mdi-robot-happy-outline'"
              size="18"
              class="flex-shrink-0 mt-1"
            />
            <span class="seg-item-text">
              {{ x.preview || t('yaya.tree.no_text', '（只调用了工具）') }}
            </span>
          </button>
        </div>
      </v-card>
    </v-dialog>

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
          <v-btn variant="tonal" prepend-icon="mdi-eye-outline" @click="confirmView">
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
.tree-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 12px 8px 20px;
}
.tree-hint {
  padding: 0 20px 8px;
  margin: 0;
}
.tree-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 12px 20px;
}
.root-branch {
  margin-top: 8px;
}
.root-head {
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
  font-size: 0.8rem;
  text-align: left;
  cursor: pointer;
}
.seg-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  min-height: 48px;
  padding: 10px 12px;
  border: none;
  border-radius: 12px;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.seg-item:hover {
  background: rgba(var(--v-theme-on-surface), 0.05);
}
.seg-item.is-active {
  color: rgb(var(--v-theme-primary));
}
.seg-item-text {
  font-size: 0.875rem;
  line-height: 1.5;
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

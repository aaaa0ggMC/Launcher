<script setup lang="ts">
/**
 * mention 插件的输入框扩展：`@` 点名 + 工具栏 @ 按钮 + 已点标签。
 * 同时也是 composer SDK（`components/plugin-input.ts`）的参考实现。
 *
 * 分工：
 * - **宿主**拥有草稿 / 焦点 / 发送 / 会话；本组件只拥有「点名相关的一切」：
 *   候选弹窗、已点标签、异步请求与定时器。
 * - 挂载时向宿主注册 hooks（triggers / onTrigger / onKeyDown / collect / hasContent / reset），
 *   卸载时反注册——插件在设置里被禁用 = 组件被卸载 = 界面与状态一起消失。
 * - 触碰草稿只有一条路：确认点名时用 `replaceRange` 删掉光标前的 `@query`，
 *   且必须先校验触发时保存的区间还对着当前草稿 / 光标（对不上就宁可不删，不吃用户文字）。
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'
import { useI18n } from '../../../../main/ui/i18n'
import type { PluginInputContext } from '../../components/plugin-input'
import type { MentionCandidate } from '../../services/plugins/mention'
import MentionPicker from './MentionPicker.vue'
import {
  MAX_QUERY_LENGTH,
  TRIGGER_PREFIX,
  cycleIndex,
  usableCandidates,
  validTriggerRange,
  type TriggerRange
} from './select'

const props = defineProps<{ context: PluginInputContext }>()
const context = toRef(props, 'context')

const lang = inject('cockpit:lang', ref('zh'))
const { t } = useI18n(lang)

/** 输入 `@`（行首或空白之后，查询最长 32 字符）才触发，见 matchInputTrigger */
const TRIGGERS = [{ prefix: TRIGGER_PREFIX, maxQueryLength: MAX_QUERY_LENGTH }]
/** 输入防抖：连续敲键只发最后一次查询 */
const DEBOUNCE_MS = 120

const selected = ref<MentionCandidate[]>([])
const open = ref(false)
/** 手动模式 = 从工具栏 @ 按钮打开的（有搜索框，不用光标位置） */
const manual = ref(false)
const query = ref('')
const search = ref('')
const items = ref<MentionCandidate[]>([])
const loading = ref(false)
const active = ref(0)

/** 触发时保存的 `@query` 精确区间；替换前重新校验 */
const range = ref<TriggerRange | null>(null)

/** 工具栏目标：宿主挂载完成后才会出现，出现了才能 Teleport 进去 */
const toolbar = computed(() => context.value.toolbarTarget.value)

let dispose: (() => void) | null = null
/**
 * 异步代：查询变化 / 关闭 / 重置 / 卸载 / 切换会话都会 +1，
 * 在途请求回来时发现代变了就直接丢弃（立即作废，不等下一次请求）。
 */
let gen = 0
let timer: ReturnType<typeof setTimeout> | null = null

/** 作废所有在途请求与待执行的防抖定时器 */
function invalidate(): void {
  gen += 1
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

function load(q: string): void {
  invalidate()
  const mine = gen
  items.value = []
  loading.value = true
  timer = setTimeout(() => {
    timer = null
    if (mine !== gen) return
    loading.value = true
    void (async () => {
      try {
        const list = (await window.cockpit.command('yaya.mention-candidates', {
          query: q
        })) as MentionCandidate[] | undefined
        if (mine !== gen) return
        items.value = usableCandidates(Array.isArray(list) ? list : [], selected.value)
        active.value = 0
      } catch {
        if (mine === gen) items.value = []
      } finally {
        if (mine === gen) loading.value = false
      }
    })()
  }, DEBOUNCE_MS)
}

function close(): void {
  invalidate()
  open.value = false
  manual.value = false
  query.value = ''
  search.value = ''
  range.value = null
  active.value = 0
  loading.value = false
}

/** 发送后 / 切换会话后：已点名的东西全部作废（跨会话不能串） */
function resetAll(): void {
  invalidate()
  close()
  selected.value = []
}

/** 删掉光标前输入的 `@query`：区间校验不过就不动草稿 */
function removeTriggerText(): void {
  const r = range.value
  const ctx = context.value
  if (!r) return
  if (!validTriggerRange(ctx.draft.value, r, ctx.selection())) return
  range.value = null
  ctx.replaceRange(r.start, r.end, '')
}

function choose(item: MentionCandidate): void {
  if (!selected.value.some((m) => m.ref === item.ref)) selected.value.push(item)
  const wasManual = manual.value
  // 先删文字再关闭（close 会清掉保存的区间）
  if (!wasManual) removeTriggerText()
  close()
  context.value.focus()
}

function remove(ref: string): void {
  selected.value = selected.value.filter((m) => m.ref !== ref)
}

/** 工具栏 @ 按钮：打开手动模式（带搜索框，不依赖光标位置） */
function openManual(): void {
  if (open.value && manual.value) return
  manual.value = true
  query.value = ''
  search.value = ''
  range.value = null
  items.value = []
  active.value = 0
  open.value = true
  load('')
}

function closePopup(): void {
  close()
  context.value.focus()
}

/** 手动模式搜索框：键入即重新查候选（后端按名字 / 描述 / 工具名过滤） */
function onSearch(text: string): void {
  search.value = text
  load(text)
}

/**
 * 键盘（文本触发时来自输入框，手动模式时来自弹窗搜索框）：
 * 返回 true = 吞掉事件。**输入法组合期一律不吞**——Enter / 方向键 / Tab 都要留给候选字上屏。
 */
function handleKey(e: KeyboardEvent): boolean {
  if (!open.value) return false
  if (e.isComposing || e.keyCode === 229) return false
  if (e.key === 'Escape') {
    e.preventDefault()
    closePopup()
    return true
  }
  const n = items.value.length
  if (!n) {
    if (['Enter', 'Tab', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault()
      return true
    }
    return false
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    active.value = cycleIndex(active.value, 1, n)
    return true
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    active.value = cycleIndex(active.value, -1, n)
    return true
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault()
    choose(items.value[active.value])
    return true
  }
  return false
}

onMounted(() => {
  dispose = context.value.register({
    triggers: TRIGGERS,
    onTrigger: (match) => {
      if (!match) {
        // 光标前不再是 `@query`：文本触发模式收起（手动模式不受影响）
        if (open.value && !manual.value) close()
        return
      }
      if (
        open.value &&
        !manual.value &&
        range.value?.start === match.start &&
        range.value.end === match.end &&
        query.value === match.query
      )
        return
      manual.value = false
      query.value = match.query
      search.value = ''
      // 每次触发都刷新保存的区间：end 跟着光标走，确认时才删得准
      range.value = { start: match.start, end: match.end, text: match.prefix + match.query }
      if (!open.value) open.value = true
      load(match.query)
    },
    onKeyDown: handleKey,
    collect: () => ({ mentions: selected.value.map((m) => m.ref) }),
    hasContent: () => selected.value.length > 0,
    reset: resetAll,
    // 编辑已发送的消息：把它当时的点名放回标签行（旧会话的 tool:* 记录照样带回，后端仍兼容）
    restore: (state) => {
      resetAll()
      for (const m of state.mentions ?? []) {
        if (!m.ref || selected.value.some((x) => x.ref === m.ref)) continue
        selected.value.push({
          ref: m.ref,
          label: m.label || m.ref,
          kind: m.kind as MentionCandidate['kind'],
          description: '',
          enabled: true,
          tools: 0
        })
      }
    }
  })
})

// 切换会话：已点名的与在途请求都作废（宿主也会调 reset，这里双保险）
watch(
  () => context.value.sessionId.value,
  () => resetAll()
)

onBeforeUnmount(() => {
  invalidate()
  dispose?.()
  dispose = null
})
</script>

<template>
  <!-- 多个根节点：标签行在原位，工具栏按钮 Teleport 进宿主的目标容器 -->
  <div v-if="selected.length" class="mention-row">
    <span v-for="m in selected" :key="m.ref" class="mention-chip" :title="m.description">
      <v-icon
        :icon="m.kind === 'tool' ? 'mdi-wrench-outline' : m.icon || 'mdi-puzzle-outline'"
        size="16"
      />
      <span class="text-truncate">@{{ m.label }}</span>
      <button
        type="button"
        class="mention-chip-x"
        :title="t('yaya.mention.remove', '取消点名')"
        :aria-label="`${t('yaya.mention.remove', '取消点名')}: ${m.label}`"
        @click="remove(m.ref)"
      >
        <v-icon icon="mdi-close" size="14" />
      </button>
    </span>
  </div>

  <MentionPicker
    v-if="open"
    :items="items"
    :active="active"
    :loading="loading"
    :query="query"
    :manual="manual"
    :search="search"
    @select="choose"
    @hover="(i: number) => (active = i)"
    @close="closePopup"
    @search="onSearch"
    @keydown="handleKey"
  />

  <Teleport v-if="toolbar" :to="toolbar">
    <v-btn
      icon="mdi-at"
      variant="text"
      density="comfortable"
      class="mention-tool-btn"
      :title="t('yaya.mention.button', '点名插件 / 工具（本对话启用）')"
      :aria-label="t('yaya.mention.button', '点名插件 / 工具（本对话启用）')"
      @pointerdown.prevent
      @click="openManual"
    />
  </Teleport>
</template>

<style scoped>
.mention-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-bottom: 6px;
}
.mention-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  min-height: 32px;
  padding: 4px 4px 4px 10px;
  border-radius: 999px;
  font-size: 0.82rem;
  font-weight: 600;
  color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.12);
}
.mention-chip .text-truncate {
  min-width: 0;
}
.mention-chip-x {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  background: none;
  color: inherit;
  cursor: pointer;
}
.mention-chip-x:hover {
  background: rgba(var(--v-theme-primary), 0.16);
}
.mention-tool-btn {
  flex-shrink: 0;
}
</style>

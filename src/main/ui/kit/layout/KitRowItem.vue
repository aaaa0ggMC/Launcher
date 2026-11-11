<script setup lang="ts">
/**
 * KitSmartRow 的行元素：包住一个控件，声明 priority / minWidth。
 *
 * 排版指令（order / display / flex-basis）由父行通过 planRow 算出后经 context 注入，
 * 这里只负责**应用**——DOM 不搬家（CSS order + Teleport 移动节点，组件实例不重建，
 * keep-alive / 焦点 / v-model 都不受影响）。
 *
 * 被隐藏时（priority 低 + 空间不足）元素 teleport 到父行的「更多」浮层里，
 * 功能不丢失；父行 overflow="none" 时退化为 display:none。
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  DEFAULT_SLOT,
  rowGroupKey,
  smartRowKey,
  type SmartRowContext,
  type SmartRowSlot
} from './smart-row-context'
import type { ItemKind, ItemPriority } from './engine'

const props = defineProps<{
  /** primary（默认，永不隐藏）/ secondary / tertiary（最先隐藏） */
  priority?: ItemPriority
  /** 下限宽度：低于这个宽度该元素就不可用。缺省 = 自动（内容推导 + 实测缓存） */
  minWidth?: number
  /** 控件类型（内容推导用）；给了 text 没给 kind 时按 label 处理 */
  kind?: ItemKind
  /** 文字内容（ch 估算用；也可给行元素加 aria-label 之外的说明） */
  text?: string
  /** 是否带前置图标（估算 +20px） */
  icon?: boolean
  /** 允许拉伸填满剩余空间。缺省：没声明 minWidth 的元素默认可生长 */
  grow?: boolean
  /** 文字省略号（名字类元素专用，超出下限时 ellipsis 而不是换行） */
  truncate?: boolean
  /** 稳定 id（缺省自动生成） */
  id?: string
}>()

const ctx = inject<SmartRowContext | null>(smartRowKey, null)
const groupId = inject<string | null>(rowGroupKey, null)
const el = ref<HTMLElement | null>(null)

// 自动 id：同一行内唯一即可（useId 带 :r 前缀，作 DOM id 不安全，只当 key 用）
const autoId = `kit-row-${Math.random().toString(36).slice(2, 9)}`
const id = (): string => props.id ?? autoId

const descriptor = computed(() => ({
  id: id(),
  priority: props.priority ?? 'primary',
  minWidth: props.minWidth,
  kind: props.kind,
  text: props.text,
  icon: props.icon,
  grow: props.grow ?? props.minWidth === undefined,
  group: groupId ?? undefined
}))

watch(descriptor, (d) => ctx?.register(d, el.value))
onMounted(() => ctx?.register(descriptor.value, el.value))
onBeforeUnmount(() => ctx?.unregister(id()))

const slot = computed<SmartRowSlot>(() => ctx?.slots[id()] ?? DEFAULT_SLOT)

/** 隐藏且父行开了溢出浮层 → teleport 到浮层；否则留在原地（display:none 兜底） */
const teleportTo = computed<HTMLElement | null>(() => {
  if (slot.value.visible !== false) return null
  return ctx?.overflowTarget.value ?? null
})

const itemStyle = computed<Record<string, string>>(() => {
  const s = slot.value
  const style: Record<string, string> = {
    order: String(s.order),
    'flex-grow': s.grow ? '1' : '0'
  }
  if (typeof s.basis === 'number') style['flex-basis'] = `${s.basis}px`
  // 隐藏 = 根节点退出排版（display:none，不占 flex 空间）；内容要么 teleport 进「更多」浮层，
  // 要么（overflow="none"）跟着根节点一起藏掉。根节点始终挂着——组件实例不重建，状态不丢。
  if (s.visible === false) style.display = 'none'
  return style
})
</script>

<template>
  <div
    ref="el"
    class="kit-row-item"
    :class="{ 'kit-row-item--truncate': truncate }"
    :style="itemStyle"
  >
    <Teleport :to="teleportTo" :disabled="teleportTo === null">
      <div class="kit-row-item__inner">
        <slot />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* flex-basis 由行注入（= 引擎解析出的下限）；min-width:0 + flex-shrink:1
   保证即使规划过期也只会收缩、绝不横向溢出 */
.kit-row-item {
  display: flex;
  min-width: 0;
  flex-shrink: 1;
  overflow: hidden;
}

.kit-row-item__inner {
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 1 1 auto;
}

.kit-row-item--truncate .kit-row-item__inner {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 被收进「更多」浮层里的是内层容器（根节点始终 display:none 挂在行里——保实例不保空间）：
   恢复成普通块级布局，行的 flex 指令与省略号都不再适用 */
:global(.kit-overflow) .kit-row-item__inner {
  display: block;
  flex: none;
  white-space: normal;
}

:global(.kit-overflow) .kit-row-item--truncate .kit-row-item__inner {
  overflow: visible;
  text-overflow: clip;
}
</style>

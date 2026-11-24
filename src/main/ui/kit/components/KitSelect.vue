<script setup lang="ts">
/**
 * KitSelect —— 下拉选择。
 *
 * 两档盒模型（SPEC「密度阶」/ 禁令）：
 *   input 档：v-select 原装外观（outlined + label，Vuetify 的网格是对的）；
 *   inline 档：**kit 自建触发器 + v-menu + v-list**——只用 Vuetify 的菜单与选择逻辑
 *     （公开组件），视觉层（外盒、文字、箭头、中线）全部由 kit 画。扒掉 outline 却留着
 *     它为 outline 服务的网格与内边距，只会在别人的盒模型里打补丁。
 */
import { computed, ref, useAttrs } from 'vue'
import { mapSelectOptions, type SelectOption } from '../composables/select-options'
import { useKitSurface } from '../composables/useKitSurface'
import { resolveDensity, useKitDensity } from '../layout/density'
import type { KitAlign } from '../layout/align'
import KitTruncated from './KitTruncated.vue'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  /** 密度档：input = 输入档（44px outlined，独立表单/对话框用）；inline = 行内档（35px 自建） */
  size?: 'input' | 'inline'
  modelValue?: unknown
  /** 控件内部对齐（SPEC「行内对齐」）：缺省 center */
  align?: KitAlign
  items?: readonly unknown[]
}>()

const emit = defineEmits<{ 'update:modelValue': [unknown] }>()
const attrs = useAttrs()
useKitSurface()
/** 生效密度：显式 size > 容器上下文（KitSettingRow=inline）> input */
const density = computed(() => resolveDensity(props.size, useKitDensity()))

/** inline 档：菜单开合 */
const open = ref(false)

/** item-title / item-value：与 v-select 同名 attrs 指路对象数组的取值键（缺省 title / value）。
 *  只认 {title,value} 会把 {id,name,description} 这类形状映射成全空（静态审计 A-1）：
 *  设置页「背景」下拉就是 item-title="name" + item-value="id"。 */
const itemTitleKey = computed(() => String(attrs['item-title'] ?? 'title'))
const itemValueKey = computed(() => String(attrs['item-value'] ?? 'value'))

/** items 兼容 Vuetify 写法：字符串数组、{ title, value } 对象、item-title/item-value 指路的对象 */
const options = computed<SelectOption[]>(() =>
  mapSelectOptions(props.items, itemTitleKey.value, itemValueKey.value)
)

const current = computed(() => options.value.find((o) => o.value === props.modelValue))

function pick(v: unknown): void {
  emit('update:modelValue', v)
  open.value = false
}

const rootStyle = computed(() => ({
  '--kit-field-align': props.align ?? 'center'
}))
</script>

<template>
  <!-- input 档：v-select 原装外观 -->
  <div v-if="density !== 'inline'" class="kit-control" :style="rootStyle">
    <v-select
      :model-value="modelValue"
      :items="items"
      density="compact"
      variant="outlined"
      hide-details
      v-bind="attrs"
      @update:model-value="emit('update:modelValue', $event)"
    >
      <template v-for="(_, n) in $slots as Record<string, unknown>" :key="n" #[n]="slotProps">
        <slot :name="n" v-bind="slotProps ?? {}" />
      </template>
    </v-select>
  </div>

  <!-- inline 档：kit 自绘触发器 + v-menu（公开组件） -->
  <div v-else class="kit-control kit-control--inline" :style="rootStyle">
    <v-menu v-model="open" :close-on-content-click="true" activator="parent">
      <template #activator="{ props: menuProps }">
        <button
          v-bind="menuProps"
          type="button"
          class="kit-inline-select"
          :aria-label="(attrs['aria-label'] as string) ?? undefined"
        >
          <!-- 选项标题可能很长：截断必须可揭示（SPEC 信息降级链档 1）——
               包 KitTruncated 拿 title + 点按浮层；真截断时点按不再冒泡去开菜单
               （菜单会盖住浮层），点箭头或未截断的区域仍正常开菜单 -->
          <KitTruncated class="kit-inline-select__text" :text="current ? current.title : ''">{{
            current ? current.title : ''
          }}</KitTruncated>
          <span class="kit-inline-select__arrow" aria-hidden="true">▾</span>
        </button>
      </template>
      <v-list
        density="compact"
        class="kit-inline-menu"
        :aria-label="(attrs['aria-label'] as string) ?? undefined"
      >
        <v-list-item
          v-for="o in options"
          :key="String(o.value)"
          density="compact"
          :active="o.value === modelValue"
          @click="pick(o.value)"
        >
          <v-list-item-title>{{ o.title }}</v-list-item-title>
        </v-list-item>
      </v-list>
    </v-menu>
  </div>
</template>

<script setup lang="ts">
/**
 * 一个设置分类的渲染：标题 + 描述 + 设置项网格。设置页（settings 能力）与
 * 无设置页时的设置浮窗（SettingsDialog）共用，保证两处行为一致。
 *
 * `highlight`：要定位的设置项 id —— 滚动到可见并短暂高亮。
 * 通过 `itemRef` 把每个设置项组件实例交给父级（用于 toMarkdown 深入导出）。
 */
import { inject, nextTick, ref, watch } from 'vue'
import type { ComponentPublicInstance, Ref } from 'vue'
import type { SettingsCategory, SettingsItem } from '../ability-registry'
import AbilityIcon from './AbilityIcon.vue'
import { translate } from '../i18n'

const props = defineProps<{
  category: SettingsCategory
  /** 只渲染这些设置项（搜索结果）；缺省全部 */
  items?: SettingsItem[]
  highlight?: string | null
  /** 紧凑标题（搜索结果分组用） */
  compactHeader?: boolean
  /** 不显示标题行（外层已有同名标题，如单分类的设置浮窗） */
  hideHeader?: boolean
}>()

const emit = defineEmits<{
  itemRef: [id: string, inst: ComponentPublicInstance | null]
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const flash = ref<string | null>(null)

function isMdi(icon: string): boolean {
  return icon.startsWith('mdi')
}

watch(
  () => props.highlight,
  async (id) => {
    if (!id) return
    await nextTick()
    const el = document.getElementById(`settings-item-${id}`)
    if (!el) return
    el.scrollIntoView({ block: 'start', behavior: 'smooth' })
    flash.value = id
    setTimeout(() => {
      if (flash.value === id) flash.value = null
    }, 1600)
  },
  { immediate: true }
)
</script>

<template>
  <div>
    <div
      v-if="!hideHeader"
      class="d-flex align-center flex-wrap ga-2"
      :class="compactHeader ? 'pb-2' : 'pb-4'"
    >
      <v-icon v-if="isMdi(category.icon)" :size="compactHeader ? 16 : 22">{{
        category.icon
      }}</v-icon>
      <AbilityIcon v-else :icon="category.icon" :size="compactHeader ? 16 : 22" />
      <span :class="compactHeader ? 'text-body-2 font-weight-medium' : 'text-h6'">
        {{ translate(uiLang, 'label.' + category.label, category.label) }}
      </span>
      <span v-if="compactHeader" class="text-body-2 on-surface-variant">
        · {{ category.abilityName }}
      </span>
    </div>
    <div v-if="!compactHeader && category.description" class="text-body-2 on-surface-variant pb-4">
      {{ translate(uiLang, 'desc.' + category.id, category.description) }}
    </div>
    <v-row dense>
      <v-col
        v-for="item in items ?? category.items"
        :id="`settings-item-${item.id}`"
        :key="item.id"
        cols="12"
        :md="item.fullWidth ? 12 : 6"
        class="settings-item"
        :class="{ 'settings-item--flash': flash === item.id }"
      >
        <component
          :is="item.component"
          :ref="(el: unknown) => emit('itemRef', item.id, el as ComponentPublicInstance | null)"
        />
      </v-col>
    </v-row>
  </div>
</template>

<style scoped>
.settings-item {
  border-radius: 12px;
  transition: box-shadow 0.4s ease;
}
.settings-item--flash {
  box-shadow: 0 0 0 2px rgb(var(--v-theme-primary));
}
</style>

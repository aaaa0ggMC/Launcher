<script setup lang="ts">
/**
 * 一个设置分类的渲染：标题 + 描述 + 设置项网格。设置页（settings 能力）与
 * 无设置页时的设置浮窗（SettingsDialog）共用，保证两处行为一致。
 *
 * `highlight`：要定位的设置项 id —— 滚动到可见并短暂高亮。
 * 通过 `itemRef` 把每个设置项组件实例交给父级（用于 toMarkdown 深入导出）。
 */
import { computed, inject, nextTick, ref, watch } from 'vue'
import type { ComponentPublicInstance, Ref } from 'vue'
import type { SettingsCategory, SettingsItem } from '../ability-registry'
import AbilityIcon from './AbilityIcon.vue'
import { translate, translateTemplate } from '../i18n'

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

/*
 * 标题可点：跳回该设置所属的能力页，和能力页里的「设置」入口形成闭环。
 * 只在那个能力有侧栏页面、且当前不在它页面上时可点（设置浮窗是从该能力自己打开的）。
 */
const abilitiesCtx = inject<{
  list: Ref<{ id: string }[]>
  current: Ref<{ id: string } | null | undefined>
  open: (id: string) => void
} | null>('cockpit:abilities', null)
const linkTarget = computed<string | null>(() => {
  const id = props.category.abilityId
  if (!abilitiesCtx || id === 'settings') return null
  if (abilitiesCtx.current.value?.id === id) return null
  return abilitiesCtx.list.value.some((a) => a.id === id) ? id : null
})
function goAbility(): void {
  if (linkTarget.value) abilitiesCtx?.open(linkTarget.value)
}
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
    <component
      :is="linkTarget ? 'button' : 'div'"
      v-if="!hideHeader"
      :type="linkTarget ? 'button' : undefined"
      class="category-header d-flex align-center flex-wrap ga-2"
      :class="[compactHeader ? 'pb-2' : 'pb-4', { 'category-header--link': linkTarget }]"
      :title="
        linkTarget
          ? translateTemplate(
              uiLang,
              'settings.openAbility',
              { name: category.abilityName },
              '打开 {name}'
            )
          : undefined
      "
      @click="goAbility"
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
      <v-icon v-if="linkTarget" class="category-header-go" :size="compactHeader ? 14 : 18">
        mdi-arrow-top-right
      </v-icon>
    </component>
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
.category-header {
  border: 0;
  background: none;
  padding-left: 0;
  padding-right: 0;
  color: inherit;
  font: inherit;
  text-align: left;
}
.category-header--link {
  cursor: pointer;
}
.category-header-go {
  opacity: 0.45;
  transition: opacity 0.15s ease;
}
.category-header--link:hover .category-header-go,
.category-header--link:focus-visible .category-header-go {
  opacity: 1;
}
.category-header--link:hover > span:first-of-type {
  color: rgb(var(--v-theme-primary));
}
.category-header--link:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
  border-radius: 6px;
}
.settings-item {
  border-radius: 12px;
  transition: box-shadow 0.4s ease;
}
.settings-item--flash {
  box-shadow: 0 0 0 2px rgb(var(--v-theme-primary));
}
</style>

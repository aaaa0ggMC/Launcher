<script setup lang="ts">
/**
 * 设置浮窗：settings 能力不存在（被移除 / 禁用）时，`useSettings().open(...)` 用它显示
 * 某个能力注入的设置。与设置页共用 SettingsCategoryView，行为一致。
 */
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import type { SettingsCategory } from '../ability-registry'
import SettingsCategoryView from './SettingsCategoryView.vue'
import { translate } from '../i18n'

const props = defineProps<{
  categories: SettingsCategory[]
  highlight?: string | null
}>()
const open = defineModel<boolean>({ default: false })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
/** 单分类：标题用分类名（内容区不再重复标题）；多分类：用能力名 */
const title = computed(() => {
  const first = props.categories[0]
  if (!first) return ''
  return props.categories.length === 1
    ? translate(uiLang.value, 'label.' + first.label, first.label)
    : first.abilityName
})
</script>

<template>
  <v-dialog v-model="open" max-width="960" scrollable>
    <v-card rounded="lg">
      <v-card-title class="d-flex align-center ga-2 px-6 pt-5 pb-3">
        <v-icon>mdi-tune-variant</v-icon>
        <span>{{ title }}</span>
        <v-spacer />
        <v-btn icon="mdi-close" size="small" variant="text" @click="open = false" />
      </v-card-title>
      <v-divider />
      <v-card-text class="px-6 py-5">
        <SettingsCategoryView
          v-for="(cat, i) in categories"
          :key="cat.id"
          :category="cat"
          :highlight="highlight"
          :hide-header="categories.length === 1"
          :class="{ 'pt-6': i > 0 }"
        />
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
/**
 * 画廊 · KitSection —— 分区卡片：标题 + 操作插槽 + 默认插槽，统一 py-3。
 * 并排演示「普通 / 操作区 / 内部滚动」三种用法。
 */
import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import { KitCaption, KitPage, KitProse, KitSection } from '@ui/kit'
import { translate } from '@ui/i18n'
import KitDemoCard from './KitDemoCard.vue'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const name = ref('Cockpit')
const saved = ref(false)
function save(): void {
  saved.value = true
  window.setTimeout(() => (saved.value = false), 1600)
}

const lines = Array.from({ length: 18 }, (_, i) => i + 1)
</script>

<template>
  <KitDemoCard
    :title="t('kit.gallery.section.title', 'KitSection · 分区卡片')"
    import-path="@ui/kit"
    :import-names="['KitSection']"
    :use="
      t(
        'kit.gallery.section.use',
        '页面里的功能分区：标题 + 一句说明 + 右侧操作。py-3 与操作区换行是内建的，不用每页自己写。'
      )
    "
    :avoid="
      t(
        'kit.gallery.section.avoid',
        '不要拿它当列表容器——列表行用 KitSmartRow / 后续的 KitListRow。'
      )
    "
  >
    <div class="kit-demo-grid">
      <KitSection
        :title="t('kit.gallery.section.plain', '普通分区')"
        icon="mdi-card-outline"
        :hint="t('kit.gallery.section.plainHint', '标题 + 说明 + 内容')"
      >
        <KitProse>{{
          t('kit.gallery.section.plainBody', '默认插槽放正文，纵向间距 8px。')
        }}</KitProse>
      </KitSection>

      <KitSection
        :title="t('kit.gallery.section.actions', '带操作的分区')"
        icon="mdi-gesture-tap-button"
      >
        <v-text-field
          v-model="name"
          density="compact"
          variant="outlined"
          hide-details
          :label="t('kit.gallery.section.fieldLabel', '名称')"
        />
        <template #actions>
          <v-btn variant="text" prepend-icon="mdi-content-save-outline" @click="save">
            {{ t('kit.gallery.section.save', '保存') }}
          </v-btn>
          <v-btn v-if="saved" variant="text" prepend-icon="mdi-check" color="success" disabled>
            {{ t('kit.gallery.section.saved', '已保存') }}
          </v-btn>
        </template>
      </KitSection>

      <div class="kit-demo-mode__app">
        <KitPage mode="app">
          <KitSection
            scroll
            :title="t('kit.gallery.section.scroll', '内部滚动区')"
            icon="mdi-arrow-vertical-lock"
          >
            <KitCaption v-for="n in lines" :key="n" class="kit-demo-line">
              {{ n }}. {{ t('kit.gallery.page.row', '设置项') }}
            </KitCaption>
          </KitSection>
        </KitPage>
      </div>
    </div>
  </KitDemoCard>
</template>

<style scoped>
.kit-demo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
  align-items: start;
}

.kit-demo-mode__app {
  position: relative;
  height: 200px;
  border-radius: 8px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.1);
  overflow: hidden;
}

.kit-demo-line {
  padding: 2px 0;
  font-size: 0.8125rem;
  opacity: 0.75;
}
</style>

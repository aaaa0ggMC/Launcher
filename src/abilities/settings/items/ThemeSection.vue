<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-theme' })

import { ref, inject, onMounted } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import { schemeList, DEFAULT_SCHEME_ID } from '@ui/color_schemes'

const theme = ref<string>(DEFAULT_SCHEME_ID)
const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  const configured = cfg?.theme as string | undefined
  theme.value = schemeList.some((s) => s.id === configured)
    ? (configured ?? DEFAULT_SCHEME_ID)
    : DEFAULT_SCHEME_ID
})

async function setTheme(t: string | null): Promise<void> {
  const id = t ?? DEFAULT_SCHEME_ID
  theme.value = id
  await window.cockpit.setConfig({ theme: id })
}

/** Deep export: current theme name. */
defineExpose({
  toMarkdown: (): string => {
    const s = schemeList.find((x) => x.id === theme.value)
    const name = s ? translate(uiLang.value, s.name, s.id) : theme.value
    return `${translate(uiLang.value, 'theme.title')}: ${name}`
  }
})

/** Swatch chips for the preview strip: bg + primary + a couple accents. */
function previewColors(s: (typeof schemeList)[number]): { bg: string; dots: string[] } {
  const c = s.colors
  if (s.system || !c.background) return { bg: 'transparent', dots: ['#4cc4d6'] }
  return {
    bg: c.background,
    dots: [c.primary, c['accent-1'], c['accent-2'], c['accent-3']]
  }
}
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{ translate(uiLang, 'theme.title') }}</v-card-title>
    <v-card-text>
      <!-- 按容器宽度自动排列（不看窗口断点）：卡片所在栏变窄时减少列数，而不是挤压格子 -->
      <div class="theme-grid">
        <div v-for="s in schemeList" :key="s.id">
          <v-card
            variant="tonal"
            class="theme-card"
            :class="{ 'theme-card--active': theme === s.id }"
            :ripple="false"
            @click="setTheme(s.id)"
          >
            <div
              class="theme-preview"
              :style="{
                background: previewColors(s).bg,
                border: s.system
                  ? '1px dashed rgba(var(--v-theme-on-surface-variant), 0.45)'
                  : 'none'
              }"
            >
              <template v-if="!s.system">
                <span
                  v-for="(dot, i) in previewColors(s).dots"
                  :key="i"
                  class="theme-dot"
                  :style="{ background: dot }"
                />
              </template>
              <v-icon v-else size="20" class="theme-system-icon">mdi-auto-fix</v-icon>
            </div>
            <div class="theme-card__label">{{ translate(uiLang, s.name, s.id) }}</div>
            <div v-if="theme === s.id" class="theme-card__check">
              <v-icon size="16">mdi-check</v-icon>
            </div>
          </v-card>
        </div>
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.theme-card {
  position: relative;
  cursor: pointer;
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.32);
  transition:
    border-color 0.15s ease,
    transform 0.15s ease,
    box-shadow 0.15s ease;
}
.theme-card:hover {
  transform: translateY(-2px);
}
.theme-card--active {
  border-color: rgb(var(--v-theme-primary));
  box-shadow: 0 0 0 1px rgb(var(--v-theme-primary));
}

.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  gap: 8px;
}

/* 预览按宽度等比缩放（固定宽高比），色点随之缩放并始终保持正圆 */
.theme-preview {
  aspect-ratio: 16 / 9;
  /* 格子变宽时预览不再无限变高（与改版前的 52px 一致） */
  max-height: 52px;
  width: calc(100% - 12px);
  border-radius: 6px;
  margin: 6px;
  padding: 0 8%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6%;
  overflow: hidden;
}
.theme-dot {
  flex: 0 1 16px;
  min-width: 0;
  aspect-ratio: 1;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.35);
}
.theme-system-icon {
  color: rgba(var(--v-theme-on-surface-variant), 0.85);
}

.theme-card__label {
  /* 底部留白用 margin 而不是 padding：overflow 在 padding 盒处裁剪，
     padding-bottom 会让被 line-clamp 截掉的第三行露出半截（「深色 (Material… 3)」） */
  padding: 2px 8px 0;
  margin-bottom: 8px;
  font-size: 0.8rem;
  line-height: 1.3;
  /* 最多两行：「极光（紫罗兰）」这类名字窄格子里换行而不是截成「极光（…」 */
  min-height: calc(2 * 1.3em + 2px);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  word-break: break-word;
  color: rgb(var(--v-theme-on-surface));
  text-align: center;
}
.theme-card__check {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>

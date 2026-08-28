<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-gallery' })

import { ref, onMounted, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

interface GalleryRoot {
  path: string
  watch?: boolean
}

const roots = ref<GalleryRoot[]>([])
const searching = ref('')

onMounted(async () => {
  const cfg = (await window.cockpit.command('yarj.config')) as {
    galleryRoots: GalleryRoot[]
  }
  roots.value = cfg.galleryRoots ?? []
})

async function addRoot(): Promise<void> {
  const p = searching.value.trim()
  if (!p) return
  const cfg = (await window.cockpit.command('yarj.add-root', { path: p })) as {
    galleryRoots: GalleryRoot[]
  }
  roots.value = cfg.galleryRoots ?? []
  searching.value = ''
}

async function removeRoot(p: string): Promise<void> {
  const cfg = (await window.cockpit.command('yarj.remove-root', { path: p })) as {
    galleryRoots: GalleryRoot[]
  }
  roots.value = cfg.galleryRoots ?? []
}

async function moveRoot(p: string, dir: -1 | 1): Promise<void> {
  const cfg = (await window.cockpit.command('yarj.move-root', { path: p, dir })) as {
    galleryRoots: GalleryRoot[]
  }
  roots.value = cfg.galleryRoots ?? []
}

async function pickDirectory(): Promise<void> {
  const path = await window.cockpit.pickFile({
    title: t('yarj.gallery.selectDir', '选择目录'),
    directory: true
  })
  if (!path) return
  searching.value = path
}

defineExpose({
  toMarkdown: (): string => {
    const title = t('yarj.gallery.title', '图库目录')
    if (!roots.value.length) return `${title}: ${t('yarj.gallery.unconfigured', '未配置')}`
    return `${title}:\n  ${roots.value.map((r) => `- ${r.path}`).join('\n  ')}`
  }
})
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{ t('yarj.gallery.title', '图库目录') }}</v-card-title>
    <v-card-text>
      <div class="text-caption on-surface-variant mb-3">
        {{ t('yarj.gallery.desc', '扫描器从这些目录收集照片并解析 EXIF（含 GPS）。') }}
      </div>
      <div v-if="roots.length > 0" class="d-flex flex-column ga-2 rules-list">
        <div v-for="(r, i) in roots" :key="r.path" class="d-flex align-center ga-2 flex-wrap">
          <v-text-field
            :model-value="r.path"
            :label="t('yarj.gallery.row', '目录 {n}').replace('{n}', String(i + 1))"
            readonly
            density="compact"
            variant="outlined"
            hide-details
            class="flex-grow-1 rule-input"
          />
          <div class="d-flex ga-1">
            <v-btn
              icon
              size="small"
              variant="flat"
              :disabled="i === 0"
              :title="t('yarj.gallery.moveUp', '上移')"
              @click="moveRoot(r.path, -1)"
            >
              <v-icon size="small">mdi-arrow-up</v-icon>
            </v-btn>
            <v-btn
              icon
              size="small"
              variant="flat"
              :disabled="i === roots.length - 1"
              :title="t('yarj.gallery.moveDown', '下移')"
              @click="moveRoot(r.path, 1)"
            >
              <v-icon size="small">mdi-arrow-down</v-icon>
            </v-btn>
            <v-btn
              icon
              size="small"
              variant="flat"
              color="error"
              :title="t('yarj.gallery.remove', '移除该目录')"
              @click="removeRoot(r.path)"
            >
              <v-icon size="small">mdi-close</v-icon>
            </v-btn>
          </div>
        </div>
      </div>
      <div v-else class="text-caption on-surface-variant d-flex align-center ga-2 rules-empty">
        <span>{{ t('yarj.gallery.unconfigured', '未配置') }}</span>
      </div>
      <div class="d-flex align-center ga-2 mt-2 flex-wrap">
        <v-text-field
          v-model="searching"
          :placeholder="t('yarj.gallery.selectDir', '/home/user/Pictures')"
          variant="outlined"
          density="compact"
          hide-details
          class="flex-grow-1 rule-input"
        >
          <template #append-inner>
            <v-btn
              icon
              variant="text"
              size="small"
              :title="t('yarj.gallery.selectDir', '选择目录')"
              @click="pickDirectory"
            >
              <v-icon>mdi-folder-open</v-icon>
            </v-btn>
          </template>
        </v-text-field>
        <v-btn color="primary" variant="tonal" height="40" class="px-5" @click="addRoot">
          {{ t('yarj.gallery.add', '添加') }}
        </v-btn>
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.rules-list {
  overflow-y: auto;
  padding: 10px 6px 8px 2px;
}
.rules-empty {
  min-height: 44px;
}
.rule-input {
  min-width: 160px;
}
</style>

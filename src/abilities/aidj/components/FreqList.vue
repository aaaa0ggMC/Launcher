<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { translate } from '../../../main/ui/i18n'
import { inject } from 'vue'
import type { Ref } from 'vue'
import FreqRow from './FreqRow.vue'

interface FreqRowData {
  name: string
  times: number
  path: string
}

defineOptions({ name: 'AidjFreqList' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const rows = ref<FreqRowData[]>([])
const sortDesc = ref(true)
const loading = ref(true)
const wrapRef = ref<HTMLElement | null>(null)
const scrollHeight = ref(320)
const snackOpen = ref(false)
const snackText = ref('')
const snackColor = ref('success')

const sorted = computed(() => {
  const list = [...rows.value]
  list.sort((a, b) => (sortDesc.value ? b.times - a.times : a.times - b.times))
  return list
})

async function handlePlay(path: string): Promise<void> {
  try {
    const r = (await window.cockpit.command('aidj.send', { path: [path] })) as {
      ok?: boolean
      error?: string
    }
    if (r?.ok) {
      snackText.value = t('aidj.freq.played', '已发送到播放器')
      snackColor.value = 'success'
    } else {
      snackText.value = r?.error || t('aidj.freq.play_failed', '播放失败')
      snackColor.value = 'error'
    }
  } catch (e) {
    snackText.value = `播放失败: ${e instanceof Error ? e.message : String(e)}`
    snackColor.value = 'error'
  }
  snackOpen.value = true
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const r = (await window.cockpit.command('aidj.freq')) as {
      ok?: boolean
      rows?: FreqRowData[]
    }
    rows.value = r?.ok && Array.isArray(r.rows) ? r.rows : []
  } catch {
    rows.value = []
  } finally {
    loading.value = false
  }
}

let ro: ResizeObserver | null = null
onMounted(() => {
  void load()
  if (wrapRef.value) {
    const setH = (): void => {
      scrollHeight.value = Math.max(160, wrapRef.value?.clientHeight ?? 320)
    }
    setH()
    ro = new ResizeObserver(setH)
    ro.observe(wrapRef.value)
  }
})
onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})
</script>

<template>
  <div class="freq-root d-flex flex-column">
    <div class="d-flex align-center ga-2 px-1 pt-1 pb-1">
      <v-btn
        icon
        size="x-small"
        variant="text"
        :title="t('aidj.freq.sort', '切换排序')"
        @click="sortDesc = !sortDesc"
      >
        <v-icon size="16">{{ sortDesc ? 'mdi-sort-descending' : 'mdi-sort-ascending' }}</v-icon>
      </v-btn>
      <span class="text-caption text-medium-emphasis">
        {{ t('aidj.sessions.count', '会话') }} {{ sorted.length }}
      </span>
      <v-spacer />
    </div>

    <div ref="wrapRef" class="freq-scroll-wrap">
      <v-virtual-scroll
        v-if="!loading && sorted.length"
        :items="sorted"
        :height="scrollHeight"
        :item-height="52"
        class="freq-scroll"
      >
        <template #default="{ item, index }">
          <FreqRow :data="item" :index="index" @play="handlePlay" />
        </template>
      </v-virtual-scroll>
      <v-empty-state
        v-else-if="!loading && sorted.length === 0"
        icon="mdi-poll"
        :title="t('aidj.freq.empty', '暂无频率数据')"
        class="mt-4"
      />
    </div>

    <v-snackbar v-model="snackOpen" :color="snackColor" location="top" timeout="2200">
      {{ snackText }}
    </v-snackbar>
  </div>
</template>

<style scoped>
.freq-root {
  min-height: 0;
}
.freq-scroll-wrap {
  height: min(60vh, 400px);
  overflow: hidden;
}
.freq-scroll {
  scrollbar-width: thin;
  scrollbar-color: rgba(var(--v-theme-primary), 0.45) transparent;
}
.freq-scroll::-webkit-scrollbar {
  width: 6px;
}
.freq-scroll::-webkit-scrollbar-thumb {
  background: rgba(var(--v-theme-on-surface-variant), 0.45);
  border-radius: 3px;
}
</style>

<script setup lang="ts">
/**
 * 图片预览对话框：附件缩略图 / 消息里的图片点开后全屏（窄屏）或大号（宽屏）查看，
 * 多张时左右切换（按钮 / 键盘 ←→ / 触屏左右滑动）。
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '../../../main/ui/i18n'

const props = defineProps<{
  images: { src: string; name?: string }[]
  index: number
  modelValue: boolean
}>()

const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

function clamp(i: number): number {
  return Math.min(Math.max(i, 0), Math.max(props.images.length - 1, 0))
}

/** 父组件只能用 index 指定起始图；切换由组件自己持有（关闭后重新从 index 开始） */
const idx = ref(clamp(props.index))
watch(
  () => props.index,
  (v) => {
    idx.value = clamp(v)
  }
)
watch(
  () => props.images.length,
  () => {
    idx.value = clamp(idx.value)
  }
)

const current = computed(() => clamp(idx.value))
const img = computed(() => props.images[current.value] ?? null)

function step(delta: number): void {
  if (props.images.length < 2) return
  const next = current.value + delta
  if (next < 0 || next >= props.images.length) return
  idx.value = next
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') open.value = false
  else if (e.key === 'ArrowLeft') step(-1)
  else if (e.key === 'ArrowRight') step(1)
}
watch(
  open,
  (v) => {
    if (v) window.addEventListener('keydown', onKey)
    else window.removeEventListener('keydown', onKey)
  },
  { immediate: true }
)
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

/** 触屏左右滑动切换 */
const touchX = ref<number | null>(null)
function onTouchStart(e: TouchEvent): void {
  touchX.value = e.touches[0]?.clientX ?? null
}
function onTouchEnd(e: TouchEvent): void {
  const start = touchX.value
  touchX.value = null
  const end = e.changedTouches[0]?.clientX
  if (start === null || start === undefined || end === undefined) return
  const dx = end - start
  if (Math.abs(dx) > 48) step(dx < 0 ? 1 : -1)
}

/** 窄屏（手机）对话框全屏；与全站断点一致，用 matchMedia 而非 useDisplay */
const narrow = ref(false)
let narrowMql: MediaQueryList | null = null
function onNarrowChange(e: MediaQueryListEvent): void {
  narrow.value = e.matches
}
onMounted(() => {
  narrowMql = window.matchMedia('(max-width: 720px)')
  narrow.value = narrowMql.matches
  narrowMql.addEventListener('change', onNarrowChange)
})
onBeforeUnmount(() => {
  narrowMql?.removeEventListener('change', onNarrowChange)
  narrowMql = null
})
</script>

<template>
  <v-dialog
    v-model="open"
    :fullscreen="narrow"
    max-width="960"
    scrollable
    content-class="img-preview-overlay"
    scrim="rgba(0, 0, 0, 0.88)"
  >
    <v-card class="img-preview" flat>
      <div class="img-preview-bar">
        <span class="text-body-2">
          {{
            te(
              'yaya.image_preview.count',
              { i: String(current + 1), n: String(images.length) },
              '{i} / {n}'
            )
          }}
        </span>
        <span v-if="img?.name" class="img-preview-name text-medium-emphasis text-truncate">{{
          img.name
        }}</span>
        <v-spacer />
        <v-btn
          v-if="images.length > 1"
          variant="text"
          density="comfortable"
          :disabled="current <= 0"
          :title="t('yaya.image_preview.prev', '上一张')"
          :aria-label="t('yaya.image_preview.prev', '上一张')"
          @click="step(-1)"
        >
          <v-icon icon="mdi-chevron-left" size="22" />
        </v-btn>
        <v-btn
          v-if="images.length > 1"
          variant="text"
          density="comfortable"
          :disabled="current >= images.length - 1"
          :title="t('yaya.image_preview.next', '下一张')"
          :aria-label="t('yaya.image_preview.next', '下一张')"
          @click="step(1)"
        >
          <v-icon icon="mdi-chevron-right" size="22" />
        </v-btn>
        <v-btn
          variant="text"
          density="comfortable"
          :title="t('yaya.close', '关闭')"
          :aria-label="t('yaya.close', '关闭')"
          @click="open = false"
        >
          <v-icon icon="mdi-close" size="22" />
        </v-btn>
      </div>

      <div class="img-preview-body" @touchstart.passive="onTouchStart" @touchend="onTouchEnd">
        <img v-if="img" :src="img.src" :alt="img.name ?? ''" class="img-preview-img" />
      </div>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.img-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: rgba(12, 12, 14, 0.96);
  color: rgb(var(--v-theme-on-surface));
}
.img-preview-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 8px 8px 8px 14px;
}
.img-preview-name {
  min-width: 0;
  font-size: 0.8rem;
}
.img-preview-body {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  place-items: center;
  padding: 0 8px 10px;
  touch-action: pan-y;
}
.img-preview-img {
  max-width: 100%;
  max-height: 100%;
  border-radius: 8px;
  object-fit: contain;
}
</style>

<!-- v-dialog 内容 teleport 到 <body>，高度必须在 scoped 之外写；
     尺寸用 --app-vh（手机上 100vh 比可见区域高，对话框顶部会被顶出屏幕） -->
<style>
.v-dialog > .img-preview-overlay {
  height: calc(var(--app-vh) - 32px);
  max-height: calc(var(--app-vh) - 32px);
}
</style>

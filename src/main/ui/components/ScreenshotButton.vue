<script lang="ts">
// 模块级：App 一导入就登记，设置 → 快捷键 里随时可见（即使截图模式没开）
import { registerShortcut } from '../shortcuts'
registerShortcut({
  id: 'screenshot.capture',
  label: 'shortcut.screenshot.capture',
  fallback: '截图模式：保存截图 / 拼接保存',
  group: 'shell'
})
registerShortcut({
  id: 'screenshot.append',
  label: 'shortcut.screenshot.append',
  fallback: '截图模式：加入拼接队列',
  group: 'shell'
})
registerShortcut({
  id: 'screenshot.clear',
  label: 'shortcut.screenshot.clear',
  fallback: '截图模式：清空拼接队列',
  group: 'shell'
})
</script>

<script setup lang="ts">
import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import AbilityIcon from './AbilityIcon.vue'
import { translate, translateTemplate } from '../i18n'
import { useShortcut } from '../shortcuts'

/**
 * 截图模式按钮（设置 → 外观 → 截图模式开启后才渲染）。
 * 左键：队列为空 → 截当前窗口并保存；队列非空 → 把队列里的图拼成一张保存。
 * 右键：截图加入队列（角标显示张数）。中键：清空队列。
 * 走专用 IPC（主进程拒绝 agent 视图），按钮本身 v-agent-forbidden，AI 看不到也点不了。
 */
const MAX_QUEUE = 12

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fb?: string): string => translate(lang.value, key, fb)

const queue = ref<string[]>([])
const busy = ref(false)
const toast = ref({ open: false, text: '', error: false })

function say(text: string, error = false): void {
  toast.value = { open: true, text, error }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image decode failed'))
    img.src = src
  })
}

/** 横向拼接：统一高度（取最高者），等比缩放，间隔 12px，整体宽度夹在画布上限内 */
async function merge(shots: string[]): Promise<string> {
  const imgs = await Promise.all(shots.map(loadImage))
  const gap = 12
  const h = Math.max(...imgs.map((i) => i.naturalHeight))
  const widths = imgs.map((i) => Math.round((i.naturalWidth * h) / i.naturalHeight))
  const rawW = widths.reduce((a, b) => a + b, 0) + gap * (imgs.length - 1)
  const k = Math.min(1, 16000 / rawW)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(rawW * k))
  canvas.height = Math.max(1, Math.round(h * k))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  ctx.fillStyle = '#1b1b1b'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  let x = 0
  imgs.forEach((img, i) => {
    ctx.drawImage(img, x * k, 0, widths[i] * k, h * k)
    x += widths[i] + gap
  })
  return canvas.toDataURL('image/png')
}

async function capture(): Promise<string | null> {
  // 先收起上一条提示、去掉按钮焦点，等一帧让它们真正从画面里消失，别被截进图里
  const hadToast = toast.value.open
  toast.value.open = false
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  await new Promise((r) => setTimeout(r, hadToast ? 300 : 50))
  return window.cockpit.screenshotCapture()
}

async function onLeft(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    let data: string | null
    if (queue.value.length) {
      data = await merge(queue.value)
    } else {
      data = await capture()
    }
    const saved = data ? await window.cockpit.screenshotSave(data) : null
    if (!saved) return say(t('screenshot.failed', '截图失败'), true)
    const merged = queue.value.length
    queue.value = []
    say(
      merged
        ? translateTemplate(lang.value, 'screenshot.savedMerged', {
            n: String(merged),
            path: saved.file
          })
        : translateTemplate(lang.value, 'screenshot.saved', { path: saved.file })
    )
    if (saved.copied) toast.value.text += t('screenshot.copied', '（已复制到剪贴板）')
  } catch (e) {
    say(`${t('screenshot.failed', '截图失败')}: ${e instanceof Error ? e.message : e}`, true)
  } finally {
    busy.value = false
  }
}

async function onRight(): Promise<void> {
  if (busy.value) return
  if (queue.value.length >= MAX_QUEUE) {
    say(translateTemplate(lang.value, 'screenshot.full', { n: String(MAX_QUEUE) }), true)
    return
  }
  busy.value = true
  try {
    const data = await capture()
    if (!data) return say(t('screenshot.failed', '截图失败'), true)
    queue.value = [...queue.value, data]
    say(translateTemplate(lang.value, 'screenshot.appended', { n: String(queue.value.length) }))
  } finally {
    busy.value = false
  }
}

function clearQueue(): void {
  if (!queue.value.length) return
  queue.value = []
  say(t('screenshot.cleared', '已清空待拼接队列'))
}
function onAux(e: MouseEvent): void {
  if (e.button === 1) clearQueue()
}

useShortcut('screenshot.capture', () => void onLeft())
useShortcut('screenshot.append', () => void onRight())
useShortcut('screenshot.clear', clearQueue)
</script>

<template>
  <v-badge
    :model-value="queue.length > 0"
    :content="queue.length"
    color="primary"
    offset-x="4"
    offset-y="4"
  >
    <v-btn
      v-agent-forbidden
      variant="text"
      icon
      :loading="busy"
      :aria-label="t('screenshot.label', '截图模式')"
      class="screenshot-btn"
      @click="onLeft"
      @contextmenu.prevent="onRight"
      @auxclick.prevent="onAux"
    >
      <AbilityIcon icon="default/camera" :size="21" />
    </v-btn>
  </v-badge>
  <v-snackbar v-model="toast.open" :color="toast.error ? 'error' : undefined" :timeout="3500">
    <span style="word-break: break-all">{{ toast.text }}</span>
  </v-snackbar>
</template>

<style scoped>
.screenshot-btn {
  -webkit-app-region: no-drag;
}
</style>

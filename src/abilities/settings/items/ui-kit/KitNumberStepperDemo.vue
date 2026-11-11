<script setup lang="ts">
/**
 * 画廊 · KitNumberStepper —— 紧凑数字步进器，重点演示「文本框只当草稿」的语义：
 * 打字中途不夹取（打 "60" 不会被 "6"→min 吃掉），失焦 / 回车 / ± 才落值。
 */
import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import { KitNumberStepper, KitProse } from '@ui/kit'
import { translate } from '@ui/i18n'
import KitDemoCard from './KitDemoCard.vue'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const follow = ref(6)
const threads = ref(4)
const note = ref('')
let noteTimer = 0

function flash(text: string): void {
  note.value = text
  window.clearTimeout(noteTimer)
  noteTimer = window.setTimeout(() => (note.value = ''), 2000)
}

function onFollow(v: number): void {
  follow.value = v
  flash(t('kit.gallery.stepper.committed', '已落值：{v}').replace('{v}', String(v)))
}
</script>

<template>
  <KitDemoCard
    :title="t('kit.gallery.stepper.title', 'KitNumberStepper · 数字步进器')"
    import-path="@ui/kit"
    :import-names="['KitNumberStepper']"
    :use="
      t(
        'kit.gallery.stepper.use',
        '设置页里的整数参数（0-20 的关注数、线程数、缓存大小）。± 是图标按钮可 size=small，触控热区补到 40px。'
      )
    "
    :avoid="
      t(
        'kit.gallery.stepper.avoid',
        '不要用 v-slider 做设置页的数值输入——bili 的门禁脚本会判可见宽度 >320px 违规。'
      )
    "
  >
    <div class="kit-demo-row">
      <KitNumberStepper
        :model-value="follow"
        :min="0"
        :max="20"
        :label="t('kit.gallery.followCount', '每天关注数')"
        @update:model-value="onFollow"
      />
      <KitNumberStepper
        v-model="threads"
        :min="1"
        :max="16"
        :step="1"
        :label="t('kit.gallery.threads', '并发线程数')"
      />
      <KitNumberStepper
        :model-value="512"
        :min="64"
        :max="4096"
        :step="64"
        unit="MB"
        :label="t('kit.gallery.cacheSize', '缓存大小')"
      />
    </div>
    <KitProse muted class="kit-demo-hint">
      <v-icon icon="mdi-keyboard-outline" size="14" />
      <span>
        {{
          note ||
          t(
            'kit.gallery.stepper.draftNote',
            '试着在框里打「12」再删掉一位：中途不会被夹到 min，失焦/回车才落值。'
          )
        }}
      </span>
    </KitProse>
  </KitDemoCard>
</template>

<style scoped>
.kit-demo-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 20px;
}

.kit-demo-hint {
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>

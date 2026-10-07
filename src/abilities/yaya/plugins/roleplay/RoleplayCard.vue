<script setup lang="ts">
/**
 * roleplay 插件的数据卡片：
 * - roleplay-setup：开局设定（主角、人称、题材、文风、精细程度、进展速度、游玩模式、人物）；
 * - roleplay-export：`prompt` 命令导出的存档原文 + 复制按钮（复制的就是框里显示的文字）。
 */
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import { pluginConfigValues } from '../../components/plugin-ui-registry'
import type { RpExportCardData, RpSetupCardData } from './index'

const props = defineProps<{ type: string; title?: string; data?: unknown; markdown?: string }>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)

const setup = computed(() => (props.data ?? {}) as Partial<RpSetupCardData>)
const exported = computed(() => ((props.data ?? {}) as Partial<RpExportCardData>).text ?? '')

/** 设定里的 [[main]] 按显示名替换（卡片不走正文的 inlineTokens） */
function mainText(s: string | undefined): string {
  const name = String(pluginConfigValues('roleplay').main_name ?? '').trim()
  return (s ?? '').replace(/\[\[main\]\]/gi, name || t('yaya.rp.main', '主角'))
}

const rows = computed(() => {
  const s = setup.value.setup
  if (!s) return []
  return [
    {
      icon: 'mdi-account-star-outline',
      label: t('yaya.rp.cfg.protagonist', '主角设定'),
      text: mainText(s.protagonist) || '—'
    },
    {
      icon: 'mdi-eye-outline',
      label: t('yaya.rp.cfg.pov', '故事人称'),
      text: t(`yaya.rp.pov.${s.pov}`, s.pov)
    },
    { icon: 'mdi-shape-outline', label: t('yaya.rp.cfg.genre', '故事题材'), text: s.genre || '—' },
    { icon: 'mdi-feather', label: t('yaya.rp.cfg.style', '文风'), text: s.style },
    {
      icon: 'mdi-tune-variant',
      label: t('yaya.rp.cfg.detail', '精细程度'),
      text: `${s.detail}/16`
    },
    {
      icon: 'mdi-speedometer-slow',
      label: t('yaya.rp.cfg.pace', '故事进展速度'),
      text: t(`yaya.rp.pace.${s.pace}`, s.pace)
    },
    {
      icon: 'mdi-gamepad-variant-outline',
      label: t('yaya.rp.cfg.mode', '游玩模式'),
      text: t(`yaya.rp.mode.${s.mode}`, s.mode)
    }
  ]
})

const copied = ref(false)
async function copy(): Promise<void> {
  await window.cockpit.copyText(exported.value)
  copied.value = true
  setTimeout(() => (copied.value = false), 1600)
}
</script>

<template>
  <div
    class="rp-card"
    role="group"
    :aria-label="
      title ||
      (type === 'roleplay-export'
        ? t('yaya.rp.export.title', '故事存档')
        : t('yaya.rp.card.setup', '开局设定'))
    "
  >
    <div class="rp-head">
      <v-icon
        :icon="type === 'roleplay-export' ? 'mdi-content-save-outline' : 'mdi-drama-masks'"
        size="18"
        class="rp-head-icon"
      />
      <span class="rp-title text-truncate">{{
        title ||
        (type === 'roleplay-export'
          ? t('yaya.rp.export.title', '故事存档')
          : t('yaya.rp.card.setup', '开局设定'))
      }}</span>
      <span v-if="type === 'roleplay-setup'" class="rp-sub">{{
        t('yaya.rp.card.setup', '开局设定')
      }}</span>
      <v-spacer />
      <v-btn
        v-if="type === 'roleplay-export' && exported"
        variant="tonal"
        color="primary"
        :prepend-icon="copied ? 'mdi-check' : 'mdi-content-copy'"
        @click="copy"
      >
        {{ copied ? t('yaya.rp.export.copied', '已复制') : t('yaya.copy', '复制') }}
      </v-btn>
    </div>

    <template v-if="type === 'roleplay-setup'">
      <div class="rp-grid">
        <div v-for="r in rows" :key="r.label" class="rp-row">
          <v-icon :icon="r.icon" size="16" />
          <span class="rp-label">{{ r.label }}</span>
          <span class="rp-text">{{ r.text }}</span>
        </div>
      </div>
      <div v-if="setup.characters?.length" class="rp-cast">
        <span
          v-for="c in setup.characters"
          :key="c.name"
          class="rp-person"
          :title="mainText(c.note)"
        >
          {{ c.name }}
        </span>
      </div>
      <div class="rp-hint">
        {{
          t('yaya.rp.card.hint', '回复意见可重写开场；c 开始，r 扩写，prompt 导出，help 查看命令')
        }}
      </div>
    </template>

    <template v-else>
      <pre v-if="exported" class="rp-export">{{ exported }}</pre>
      <div v-else class="rp-hint">
        {{ t('yaya.rp.export.empty', '还没有开始故事，没有可导出的内容。') }}
      </div>
    </template>
  </div>
</template>

<style scoped>
.rp-card {
  border-radius: 14px;
  padding: 12px 14px;
  border: 1px solid rgba(var(--v-theme-primary), 0.25);
  background:
    linear-gradient(135deg, rgba(var(--v-theme-primary), 0.08), transparent 60%),
    rgba(var(--v-theme-on-surface), 0.02);
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.rp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
  min-height: 36px;
}
.rp-head-icon {
  color: rgb(var(--v-theme-primary));
}
.rp-title {
  font-weight: 600;
  font-size: 0.9375rem;
  min-width: 0;
}
.rp-sub {
  font-size: 0.8125rem;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.rp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 6px 16px;
}
.rp-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  font-size: 0.8125rem;
  line-height: 1.5;
  padding: 3px 0;
}
.rp-row > .v-icon {
  opacity: 0.7;
  flex-shrink: 0;
  margin-top: 2px;
}
.rp-label {
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  flex-shrink: 0;
}
.rp-text {
  min-width: 0;
  overflow-wrap: anywhere;
}
.rp-cast {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.rp-person {
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 0.8125rem;
  background: rgba(var(--v-theme-primary), 0.12);
}
.rp-hint {
  font-size: 0.8125rem;
  line-height: 1.5;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.rp-export {
  margin: 0;
  padding: 10px 12px;
  max-height: 320px;
  overflow: auto;
  border-radius: 10px;
  background: rgba(var(--v-theme-on-surface), 0.04);
  font-family: inherit;
  font-size: 0.8125rem;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>

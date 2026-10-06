<script setup lang="ts">
/**
 * 用量统计 → 费用：每个模型的调用次数、token、按价格算出的费用；没有价格的模型可以直接点「设置价格」。
 * 数据由后端 `hooks.usage` 算好（section.data = CostData）。
 */
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import type { UsageViewProps } from '../../components/plugin-ui'
import {
  formatMoney,
  formatPrice,
  formatTokens,
  type CostData,
  type CostRow,
  type ModelMetaEntry
} from './format'
import MetaEditDialog from './MetaEditDialog.vue'
import { useProviders } from './use-providers'

defineOptions({ name: 'yaya-usage-cost' })
const props = defineProps<UsageViewProps>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)
const providers = useProviders()

const data = computed(() => props.section.data as CostData | undefined)
const dialog = ref(false)
const editing = ref<Partial<ModelMetaEntry> | null>(null)

function setPrice(r: CostRow): void {
  // 只有上下文长度、没有价格的条目也带上已有字段；不带 updatedAt = 按新条目保存（合并写入）
  const meta: Partial<ModelMetaEntry> = { ...r.meta }
  delete meta.updatedAt
  delete meta.updatedBy
  editing.value = { currency: 'USD', ...meta, providerId: '*', model: r.model }
  dialog.value = true
}

function unit(r: CostRow): string {
  if (!r.meta || r.cost === null) return ''
  return `${formatPrice(r.meta.input ?? 0, r.currency)} / ${formatPrice(r.meta.output ?? 0, r.currency)}`
}
</script>

<template>
  <div v-if="data && data.rows.length" class="cost-list">
    <div v-for="r in data.rows" :key="`${r.providerId}/${r.model}`" class="cost-row">
      <div class="min-w-0 flex-grow-1">
        <div class="text-body-2 font-weight-medium text-truncate">
          {{ r.model || t('yaya.usage.unknown_model', '未知模型') }}
          <span v-if="r.providerName" class="text-medium-emphasis font-weight-regular">
            · {{ r.providerName }}
          </span>
        </div>
        <div class="text-caption text-medium-emphasis">
          {{ te('yaya.usage.calls', { n: String(r.calls) }, '{n} 次模型调用') }} ·
          {{ t('yaya.usage.prompt', '输入') }} {{ formatTokens(r.prompt) }} ({{
            t('yaya.usage.cached', '缓存命中')
          }}
          {{ formatTokens(r.cached) }}) · {{ t('yaya.usage.completion', '输出') }}
          {{ formatTokens(r.completion) }}
          <template v-if="unit(r)"> · {{ unit(r) }}</template>
        </div>
      </div>
      <span v-if="r.cost !== null" class="cost-value">{{ formatMoney(r.cost, r.currency) }}</span>
      <v-btn
        v-else-if="r.model"
        variant="tonal"
        prepend-icon="mdi-tag-plus-outline"
        @click="setPrice(r)"
      >
        {{ t('yaya.plugin.models.set_price', '设置价格') }}
      </v-btn>
    </div>
    <div v-if="data.missing" class="text-caption text-medium-emphasis">
      {{
        t(
          'yaya.plugin.models.missing_hint',
          '没有价格的模型不计入费用。也可以让助手「把用到的模型价格补齐」，它会查官方价格后写入（需要你确认）。'
        )
      }}
    </div>
    <MetaEditDialog
      v-model="dialog"
      :entry="editing"
      :providers="providers"
      @saved="() => undefined"
    />
  </div>
</template>

<style scoped>
.cost-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cost-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.cost-value {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
</style>

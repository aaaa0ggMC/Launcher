<script setup lang="ts">
/**
 * 设置 → 插件 → 模型元数据：已记录的模型价格 / 上下文长度，可添加、修改、删除（删除只有用户能做）。
 */
import { inject, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import { currencyOf, formatPrice, formatTokens, type ModelMetaEntry } from './format'
import MetaEditDialog from './MetaEditDialog.vue'
import { providerName, useProviders } from './use-providers'

defineOptions({ name: 'yaya-model-meta-panel' })
defineProps<{ pluginId: string; info?: unknown }>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)
const providers = useProviders()

const entries = ref<ModelMetaEntry[]>([])
const error = ref('')
const editing = ref<Partial<ModelMetaEntry> | null>(null)
const dialog = ref(false)

async function load(): Promise<void> {
  try {
    const r = (await window.cockpit.command('yaya.model-meta-list')) as {
      entries: ModelMetaEntry[]
    }
    entries.value = r.entries
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function edit(e: Partial<ModelMetaEntry> | null): void {
  editing.value = e
  dialog.value = true
}

async function remove(e: ModelMetaEntry): Promise<void> {
  try {
    await window.cockpit.command('yaya.model-meta-delete', {
      provider: e.providerId,
      model: e.model
    })
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  await load()
}

function priceLine(e: ModelMetaEntry): string {
  const cur = currencyOf(e)
  const parts: string[] = []
  if (e.input !== undefined || e.output !== undefined)
    parts.push(`${formatPrice(e.input ?? 0, cur)} / ${formatPrice(e.output ?? 0, cur)}`)
  if (e.cachedInput !== undefined)
    parts.push(
      `${t('yaya.plugin.models.price_cached', '缓存命中')} ${formatPrice(e.cachedInput, cur)}`
    )
  if (e.contextWindow) parts.push(`${formatTokens(e.contextWindow)} ctx`)
  return parts.join(' · ') || t('yaya.plugin.models.no_values', '没有填价格')
}

let off: (() => void) | undefined
onMounted(() => {
  void load()
  off = window.cockpit.on('cockpit:yaya-usage-changed', () => void load())
})
onBeforeUnmount(() => off?.())
</script>

<template>
  <div class="d-flex flex-column ga-3">
    <div class="d-flex align-center ga-2">
      <span class="text-body-2 font-weight-medium">
        {{ t('yaya.plugin.models.panel_title', '已记录的模型') }}
      </span>
      <v-spacer />
      <v-btn variant="tonal" prepend-icon="mdi-plus" @click="edit(null)">
        {{ t('yaya.plugin.models.add', '添加') }}
      </v-btn>
    </div>
    <div v-if="error" class="text-caption text-error">{{ error }}</div>
    <div v-if="!entries.length" class="text-caption text-medium-emphasis py-2">
      {{
        t(
          'yaya.plugin.models.empty',
          '还没有记录。可以让助手「把我用的模型价格补齐」，或者点「添加」手动填写。'
        )
      }}
    </div>
    <div v-for="e in entries" :key="`${e.providerId}/${e.model}`" class="meta-row">
      <div class="min-w-0 flex-grow-1">
        <div class="text-body-2 font-weight-medium text-truncate">
          {{ e.model }}
          <span v-if="providerName(providers, e.providerId)" class="text-medium-emphasis">
            · {{ providerName(providers, e.providerId) }}
          </span>
        </div>
        <div class="text-caption text-medium-emphasis text-truncate" :title="e.source">
          {{ priceLine(e) }}
          <template v-if="e.updatedBy === 'ai'">
            · {{ t('yaya.plugin.models.by_ai', '助手填写') }}
          </template>
        </div>
      </div>
      <v-btn
        icon="mdi-pencil-outline"
        variant="text"
        size="small"
        :title="t('yaya.plugin.models.edit', '编辑')"
        :aria-label="t('yaya.plugin.models.edit', '编辑')"
        @click="edit(e)"
      />
      <v-btn
        icon="mdi-delete-outline"
        variant="text"
        size="small"
        :title="t('yaya.plugin.models.delete', '删除')"
        :aria-label="t('yaya.plugin.models.delete', '删除')"
        @click="remove(e)"
      />
    </div>
    <MetaEditDialog v-model="dialog" :entry="editing" :providers="providers" @saved="load" />
  </div>
</template>

<style scoped>
.meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 4px 8px 12px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 12px;
}
</style>

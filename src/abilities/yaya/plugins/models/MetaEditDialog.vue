<script setup lang="ts">
/**
 * 编辑一个模型的元数据（价格 / 上下文长度）。设置面板与用量统计「设置价格」共用。
 * 保存走 `yaya.model-meta-set`（用户专属，AI 只能经 models_set 工具并要确认）。
 */
import { computed, inject, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import type { ModelMetaEntry } from './format'

defineOptions({ name: 'yaya-model-meta-edit' })

const props = defineProps<{
  /** 编辑已有条目，或带着 providerId / model 预填的新条目 */
  entry: Partial<ModelMetaEntry> | null
  providers: { id: string; name: string }[]
}>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ (e: 'saved'): void }>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)

interface Form {
  providerId: string
  model: string
  input: string
  cachedInput: string
  output: string
  currency: string
  contextWindow: string
  maxOutput: string
  source: string
  note: string
}
const form = ref<Form>(blank())
const saving = ref(false)
const error = ref('')

function blank(): Form {
  return {
    providerId: '*',
    model: '',
    input: '',
    cachedInput: '',
    output: '',
    currency: 'USD',
    contextWindow: '',
    maxOutput: '',
    source: '',
    note: ''
  }
}
const s = (v: number | string | undefined): string => (v === undefined ? '' : String(v))

watch(open, (o) => {
  if (!o) return
  const e = props.entry ?? {}
  error.value = ''
  form.value = {
    providerId: e.providerId || '*',
    model: e.model ?? '',
    input: s(e.input),
    cachedInput: s(e.cachedInput),
    output: s(e.output),
    currency: e.currency || 'USD',
    contextWindow: s(e.contextWindow),
    maxOutput: s(e.maxOutput),
    source: e.source ?? '',
    note: e.note ?? ''
  }
})

const providerItems = computed(() => [
  { value: '*', title: t('yaya.plugin.models.any_provider', '任何服务商') },
  ...props.providers.map((p) => ({ value: p.id, title: p.name }))
])
const isEdit = computed(() => !!props.entry?.updatedAt)

const numberRule = (v: string): true | string =>
  !v.trim() || (Number.isFinite(Number(v)) && Number(v) >= 0)
    ? true
    : t('yaya.plugin.models.bad_number', '请输入非负数')

/** 空 = 清除这个字段（null），否则数字 */
function n(v: string): number | null {
  return v.trim() ? Number(v) : null
}

async function save(): Promise<void> {
  const f = form.value
  if (!f.model.trim()) {
    error.value = t('yaya.plugin.models.need_model', '请填写模型标识')
    return
  }
  for (const v of [f.input, f.cachedInput, f.output, f.contextWindow, f.maxOutput])
    if (numberRule(v) !== true) {
      error.value = t('yaya.plugin.models.bad_number', '请输入非负数')
      return
    }
  saving.value = true
  error.value = ''
  try {
    // 改了服务商 / 模型名 = 换了 key：先删旧的
    const old = props.entry
    if (isEdit.value && old && (old.providerId !== f.providerId || old.model !== f.model.trim()))
      await window.cockpit.command('yaya.model-meta-delete', {
        provider: old.providerId,
        model: old.model
      })
    await window.cockpit.command('yaya.model-meta-set', {
      provider: f.providerId,
      model: f.model.trim(),
      meta: JSON.stringify({
        input: n(f.input),
        cachedInput: n(f.cachedInput),
        output: n(f.output),
        currency: f.currency.trim() || 'USD',
        contextWindow: n(f.contextWindow),
        maxOutput: n(f.maxOutput),
        source: f.source.trim() || null,
        note: f.note.trim() || null
      })
    })
    open.value = false
    emit('saved')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="560" scrollable>
    <v-card class="yaya-pop" rounded="xl">
      <v-card-title class="px-6 pt-5 pb-2">
        {{
          isEdit
            ? t('yaya.plugin.models.edit_title', '编辑模型元数据')
            : t('yaya.plugin.models.add_title', '添加模型元数据')
        }}
      </v-card-title>
      <v-card-text class="px-6 d-flex flex-column ga-4">
        <div class="meta-grid">
          <v-select
            v-model="form.providerId"
            :items="providerItems"
            :label="t('yaya.plugin.models.f_provider', '服务商')"
            variant="outlined"
            hide-details
          />
          <v-text-field
            v-model="form.model"
            :label="t('yaya.plugin.models.f_model', '模型标识')"
            variant="outlined"
            hide-details
          />
        </div>
        <div class="text-caption text-medium-emphasis">
          {{
            t(
              'yaya.plugin.models.price_hint',
              '价格按每百万 token 计；缓存命中价格不填则按输入价格算'
            )
          }}
        </div>
        <div class="meta-grid three">
          <v-text-field
            v-model="form.input"
            inputmode="decimal"
            :rules="[numberRule]"
            :label="t('yaya.plugin.models.f_input', '输入价格')"
            variant="outlined"
          />
          <v-text-field
            v-model="form.cachedInput"
            inputmode="decimal"
            :rules="[numberRule]"
            :label="t('yaya.plugin.models.f_cached', '缓存命中价格')"
            variant="outlined"
          />
          <v-text-field
            v-model="form.output"
            inputmode="decimal"
            :rules="[numberRule]"
            :label="t('yaya.plugin.models.f_output', '输出价格')"
            variant="outlined"
          />
        </div>
        <div class="meta-grid three">
          <v-combobox
            v-model="form.currency"
            :items="['USD', 'CNY', 'EUR']"
            :label="t('yaya.plugin.models.f_currency', '币种')"
            variant="outlined"
            hide-details
          />
          <v-text-field
            v-model="form.contextWindow"
            inputmode="numeric"
            :rules="[numberRule]"
            :label="t('yaya.plugin.models.f_context', '上下文长度')"
            variant="outlined"
          />
          <v-text-field
            v-model="form.maxOutput"
            inputmode="numeric"
            :rules="[numberRule]"
            :label="t('yaya.plugin.models.f_max_output', '最大输出')"
            variant="outlined"
          />
        </div>
        <v-text-field
          v-model="form.source"
          :label="t('yaya.plugin.models.f_source', '来源（网址或说明）')"
          variant="outlined"
          hide-details
        />
        <v-text-field
          v-model="form.note"
          :label="t('yaya.plugin.models.f_note', '备注')"
          variant="outlined"
          hide-details
        />
        <div v-if="error" class="text-caption text-error">{{ error }}</div>
      </v-card-text>
      <v-card-actions class="px-6 pb-5">
        <v-spacer />
        <v-btn variant="text" @click="open = false">{{
          t('yaya.plugin.models.cancel', '取消')
        }}</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" @click="save">
          {{ t('yaya.plugin.models.save', '保存') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.meta-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.meta-grid.three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
@media (max-width: 720px) {
  .meta-grid,
  .meta-grid.three {
    grid-template-columns: 1fr;
  }
}
</style>

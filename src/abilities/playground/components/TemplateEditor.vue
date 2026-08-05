<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import type { RequestTemplate, RespTransform } from '../types'
import { extractAllVars } from '../parser/variableParser'
import type { ParsedVar } from '../types'
import { translate, translateTemplate } from '@ui/i18n'
import { fence, inline } from '../markdown'
import TransformEditor from './TransformEditor.vue'

const props = defineProps<{
  template: RequestTemplate
  globalVarNames: Set<string>
  templates: RequestTemplate[]
}>()

const emit = defineEmits<{
  change: [t: RequestTemplate]
  delete: []
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const

const collapsed = ref(false)
const copySrc = ref('')

const otherTemplates = computed(() => props.templates.filter((t) => t.id !== props.template.id))
const srcTemplate = computed(() => props.templates.find((t) => t.id === copySrc.value))

const varInfo = computed(() => {
  const all = extractAllVars([
    props.template.urlTemplate,
    props.template.headersTemplate,
    props.template.bodyTemplate
  ])
  const global: ParsedVar[] = []
  const form: ParsedVar[] = []
  for (const v of all) {
    if (props.globalVarNames.has(v.name)) global.push(v)
    else form.push(v)
  }
  return { all, global, form }
})

function update(patch: Partial<RequestTemplate>): void {
  emit('change', { ...props.template, ...patch })
}

function constraintLabel(c: NonNullable<ParsedVar['constraint']>): string {
  switch (c.kind) {
    case 'range':
      return ` ${c.min}-${c.max}`
    case 'min':
      return ` >=${c.val}`
    case 'max':
      return ` <=${c.val}`
    case 'options':
      return ` (${c.values.join(', ')})`
  }
}
function defaultLabel(d?: string): string {
  return d !== undefined ? ` =${d}` : ''
}

function onTransformsChange(next: RespTransform[]): void {
  update({ respTransforms: next })
}

const transformRef = ref<{ toMarkdown?: () => string } | null>(null)

/** Export the active template config as markdown (name/method/url/headers/body
 *  + variable badges + the transform chain from TransformEditor). */
function toMarkdown(): string {
  const name = props.template.name || t('pg.untitled')
  const lines: string[] = [translateTemplate(uiLang.value, 'pg.mdTemplate', { name })]
  lines.push(`- ${t('pg.method')}: ${props.template.method}`)
  if (props.template.urlTemplate)
    lines.push(`- ${t('pg.url')}:`, '', fence(props.template.urlTemplate))
  if (props.template.headersTemplate)
    lines.push(`- ${t('pg.headers')}:`, '', fence(props.template.headersTemplate))
  if (props.template.bodyTemplate)
    lines.push(`- ${t('pg.body')}:`, '', fence(props.template.bodyTemplate, 'json'))
  if (varInfo.value.all.length) {
    lines.push(
      '',
      `- ${t('pg.varsGlobal')}:`,
      ...varInfo.value.global.map((v) => `  - \`${inline(v.name)}\``)
    )
    lines.push(
      '',
      `- ${t('pg.varsForm')}:`,
      ...varInfo.value.form.map((v) => `  - \`${inline(v.name)}\``)
    )
  }
  const tf = transformRef.value?.toMarkdown?.()
  if (tf) lines.push('', tf)
  return lines.join('\n')
}

defineExpose({ toMarkdown })
</script>

<template>
  <div class="pg-editor">
    <div class="d-flex align-center ga-2 mb-3 flex-wrap">
      <v-text-field
        :model-value="template.name"
        variant="solo-filled"
        flat
        density="compact"
        hide-details
        :placeholder="t('pg.templateNamePlaceholder')"
        class="pg-name"
        @update:model-value="update({ name: $event as string })"
      />
      <v-select
        :model-value="template.method"
        :items="METHODS"
        density="compact"
        variant="solo-filled"
        flat
        hide-details
        class="pg-method"
        @update:model-value="update({ method: $event as RequestTemplate['method'] })"
      />
      <v-spacer />
      <v-btn
        variant="tonal"
        color="error"
        prepend-icon="mdi-delete-outline"
        @click="emit('delete')"
      >
        {{ t('pg.delete') }}
      </v-btn>
    </div>

    <!-- Copy from another template -->
    <div v-if="otherTemplates.length" class="d-flex align-center ga-2 mb-3 flex-wrap">
      <span class="text-caption on-surface-variant">{{ t('pg.copyFrom') }}:</span>
      <v-select
        v-model="copySrc"
        :items="
          otherTemplates.map((x) => ({
            title: `${x.name || t('pg.untitled')} (${x.method})`,
            value: x.id
          }))
        "
        density="compact"
        variant="solo-filled"
        flat
        hide-details
        class="pg-copysrc"
        :placeholder="t('pg.chooseSource')"
      />
      <template v-if="srcTemplate">
        <v-btn
          variant="tonal"
          @click="
            update({
              urlTemplate: srcTemplate.urlTemplate,
              headersTemplate: srcTemplate.headersTemplate,
              bodyTemplate: srcTemplate.bodyTemplate,
              respTransforms: [...srcTemplate.respTransforms]
            })
          "
          >{{ t('pg.copyAll') }}</v-btn
        >
        <v-btn variant="tonal" @click="update({ headersTemplate: srcTemplate.headersTemplate })">{{
          t('pg.copyHeaders')
        }}</v-btn>
        <v-btn variant="tonal" @click="update({ bodyTemplate: srcTemplate.bodyTemplate })">{{
          t('pg.copyBody')
        }}</v-btn>
        <v-btn
          variant="tonal"
          @click="update({ respTransforms: [...srcTemplate.respTransforms] })"
          >{{ t('pg.copyTransforms') }}</v-btn
        >
      </template>
    </div>

    <v-text-field
      :model-value="template.urlTemplate"
      variant="outlined"
      hide-details
      class="mb-3 font-mono"
      :label="t('pg.url')"
      :placeholder="t('pg.urlPlaceholder')"
      @update:model-value="update({ urlTemplate: $event as string })"
    />

    <v-textarea
      :model-value="template.headersTemplate"
      variant="outlined"
      hide-details
      class="mb-3 font-mono"
      :label="t('pg.headersPerLine')"
      rows="3"
      :placeholder="t('pg.headersPlaceholder')"
      @update:model-value="update({ headersTemplate: $event as string })"
    />

    <v-textarea
      :model-value="template.bodyTemplate"
      variant="outlined"
      hide-details
      class="mb-3 font-mono"
      :label="t('pg.body')"
      rows="5"
      :placeholder="t('pg.bodyPlaceholder')"
      @update:model-value="update({ bodyTemplate: $event as string })"
    />

    <!-- Response transforms -->
    <TransformEditor
      ref="transformRef"
      :transforms="template.respTransforms"
      :global-var-names="globalVarNames"
      @change="onTransformsChange"
    />

    <!-- Variable badges -->
    <div v-if="varInfo.all.length && !collapsed" class="pg-vars mt-3">
      <template v-if="varInfo.global.length">
        <div class="text-caption on-surface-variant mb-1">{{ t('pg.varsGlobal') }}:</div>
        <div class="d-flex flex-wrap gap-1 mb-2">
          <v-chip
            v-for="v in varInfo.global"
            :key="v.name"
            variant="flat"
            color="primary-container"
          >
            {{ v.name }}
            <em class="pg-var-detail"
              >{{ v.type }}{{ v.constraint ? constraintLabel(v.constraint) : ''
              }}{{ defaultLabel(v.defaultValue) }}</em
            >
          </v-chip>
        </div>
      </template>
      <template v-if="varInfo.form.length">
        <div class="text-caption on-surface-variant mb-1">{{ t('pg.varsForm') }}:</div>
        <div class="d-flex flex-wrap gap-1">
          <v-chip v-for="v in varInfo.form" :key="v.name" variant="flat">
            {{ v.name }}
            <em class="pg-var-detail"
              >{{ v.type }}{{ v.constraint ? constraintLabel(v.constraint) : ''
              }}{{ defaultLabel(v.defaultValue) }}</em
            >
          </v-chip>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.pg-name {
  max-width: 280px;
}
.pg-method {
  max-width: 120px;
}
.pg-copysrc {
  max-width: 220px;
}
.pg-vars .v-chip {
  padding-block: 4px;
  min-height: 24px;
}
.pg-var-detail {
  font-style: normal;
  opacity: 0.7;
  margin-left: 4px;
  font-size: 0.65rem;
}
.font-mono :deep(input),
.font-mono :deep(textarea) {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 0.8rem;
}
</style>

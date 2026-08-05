<script setup lang="ts">
import { computed, ref } from 'vue'
import type { RequestTemplate, RespTransform } from '../types'
import { extractAllVars } from '../parser/variableParser'
import type { ParsedVar } from '../types'
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
        placeholder="模板名称…"
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
        删除
      </v-btn>
    </div>

    <!-- Copy from another template -->
    <div v-if="otherTemplates.length" class="d-flex align-center ga-2 mb-3 flex-wrap">
      <span class="text-caption on-surface-variant">复制自:</span>
      <v-select
        v-model="copySrc"
        :items="
          otherTemplates.map((t) => ({ title: `${t.name || '未命名'} (${t.method})`, value: t.id }))
        "
        density="compact"
        variant="solo-filled"
        flat
        hide-details
        class="pg-copysrc"
        placeholder="选择源模板"
      />
      <template v-if="srcTemplate">
        <v-btn
          size="small"
          variant="tonal"
          @click="
            update({
              urlTemplate: srcTemplate.urlTemplate,
              headersTemplate: srcTemplate.headersTemplate,
              bodyTemplate: srcTemplate.bodyTemplate,
              respTransforms: [...srcTemplate.respTransforms]
            })
          "
          >全部</v-btn
        >
        <v-btn
          size="small"
          variant="tonal"
          @click="update({ headersTemplate: srcTemplate.headersTemplate })"
          >请求头</v-btn
        >
        <v-btn
          size="small"
          variant="tonal"
          @click="update({ bodyTemplate: srcTemplate.bodyTemplate })"
          >请求体</v-btn
        >
        <v-btn
          size="small"
          variant="tonal"
          @click="update({ respTransforms: [...srcTemplate.respTransforms] })"
          >变换</v-btn
        >
      </template>
    </div>

    <v-text-field
      :model-value="template.urlTemplate"
      variant="outlined"
      hide-details
      class="mb-3 font-mono"
      label="URL 模板"
      placeholder="https://api.example.com/v1/{model:string}"
      @update:model-value="update({ urlTemplate: $event as string })"
    />

    <v-textarea
      :model-value="template.headersTemplate"
      variant="outlined"
      hide-details
      class="mb-3 font-mono"
      label="请求头 (每行 Key: value)"
      rows="3"
      placeholder="Authorization: Bearer {api_key:string}&#10;Content-Type: application/json"
      @update:model-value="update({ headersTemplate: $event as string })"
    />

    <v-textarea
      :model-value="template.bodyTemplate"
      variant="outlined"
      hide-details
      class="mb-3 font-mono"
      label="请求体"
      rows="5"
      placeholder='{"model": "{model_name:string}", "prompt": "{prompt:string}"}'
      @update:model-value="update({ bodyTemplate: $event as string })"
    />

    <!-- Response transforms -->
    <TransformEditor
      :transforms="template.respTransforms"
      :global-var-names="globalVarNames"
      @change="onTransformsChange"
    />

    <!-- Variable badges -->
    <div v-if="varInfo.all.length && !collapsed" class="pg-vars mt-3">
      <template v-if="varInfo.global.length">
        <div class="text-caption on-surface-variant mb-1">全局（自动填充）:</div>
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
        <div class="text-caption on-surface-variant mb-1">表单字段:</div>
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

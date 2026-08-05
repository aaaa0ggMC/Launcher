<script setup lang="ts">
import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import type { RespTransform } from '../types'
import { translate } from '@ui/i18n'
import { inline } from '../markdown'

const props = defineProps<{
  transforms: RespTransform[]
  globalVarNames: Set<string>
}>()

const emit = defineEmits<{
  change: [transforms: RespTransform[]]
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

/** Render one transform as a compact markdown bullet (recurses into nested). */
function transformMd(rt: RespTransform, indent: string): string[] {
  const out: string[] = []
  const head = `${indent}- [\`${rt.type}\`] ${rt.label || '#'}`
  const detail: string[] = []
  if (rt.type === 'text' && rt.format) detail.push(`format=\`${inline(rt.format)}\``)
  if (rt.type === 'script') {
    if (rt.script) detail.push(`script=\`${inline(rt.script.slice(0, 120))}\``)
    if (rt.localVars?.length)
      detail.push(
        `local=${rt.localVars.map((v) => `${v.key}=${v.value ?? ''}`.slice(0, 40)).join(';')}`
      )
  }
  if (['img', 'audio', 'audio-url', 'video-url'].includes(rt.type) && rt.entry)
    detail.push(`entry=\`${inline(rt.entry)}\``)
  if (rt.type === 'task') {
    if (rt.entry) detail.push(`id=\`${inline(rt.entry)}\``)
    if (rt.taskAddr) detail.push(`poll=\`${inline(rt.taskAddr)}\``)
    if (rt.taskPollMs) detail.push(`pollMs=${rt.taskPollMs}`)
  }
  out.push(detail.length ? `${head} — ${detail.join(' · ')}` : head)
  for (const sub of rt.taskTransforms ?? []) out.push(...transformMd(sub, indent + '  '))
  return out
}

/** Export the transform chain as markdown (used by TemplateEditor's toMarkdown). */
function toMarkdown(): string {
  const lines: string[] = [translate(uiLang.value, 'pg.mdTransforms')]
  if (props.transforms.length === 0) {
    lines.push(`- ${t('pg.noTransforms')}`)
    return lines.join('\n')
  }
  for (const rt of props.transforms) lines.push(...transformMd(rt, ''))
  return lines.join('\n')
}

defineExpose({ toMarkdown })

const collapsedIds = ref<Record<string, boolean>>({})

/** Script transform: local edit → explicit commit (Update). Drafts are keyed
 *  by transform id; typing only updates the draft, Update writes it back and
 *  bumps scriptVersion (which is what actually re-runs the transform). */
const scriptDrafts = ref<Record<string, string>>({})
function scriptDraft(t: RespTransform): string {
  return scriptDrafts.value[t.id] ?? t.script ?? ''
}
function setScriptDraft(id: string, v: string): void {
  scriptDrafts.value = { ...scriptDrafts.value, [id]: v }
}
function isScriptDirty(t: RespTransform): boolean {
  return (scriptDrafts.value[t.id] ?? t.script ?? '') !== (t.script ?? '')
}
function commitScript(i: number, t: RespTransform): void {
  const draft = scriptDrafts.value[t.id] ?? t.script ?? ''
  // commit: write draft into the transform + bump version to re-run
  const next = props.transforms.map((x, j) =>
    j === i ? { ...x, script: draft, scriptVersion: (x.scriptVersion ?? 0) + 1 } : x
  )
  scriptDrafts.value = { ...scriptDrafts.value, [t.id]: draft }
  emit('change', next)
}

const TYPES = [
  { title: 'Text', value: 'text' },
  { title: 'Image', value: 'img' },
  { title: 'Audio', value: 'audio' },
  { title: 'Audio URL', value: 'audio-url' },
  { title: 'Video URL', value: 'video-url' },
  { title: 'Task', value: 'task' },
  { title: 'Script', value: 'script' }
] as const

function makeTransform(): RespTransform {
  return {
    id: crypto.randomUUID(),
    type: 'text',
    label: '',
    format: '',
    entry: '',
    encoding: 'base64',
    audioMime: '',
    script: '',
    scriptVersion: 0,
    localVars: [],
    taskAddr: '',
    taskMethod: 'GET',
    taskHeaders: '',
    taskQuery: '',
    taskStatusPath: '',
    taskStatusVal: '',
    taskFailVal: '',
    taskPollMs: 2000,
    taskFailReasonPath: '',
    taskTransforms: []
  }
}

function patch(i: number, field: keyof RespTransform, value: unknown): void {
  const next = props.transforms.map((t, j) => (j === i ? { ...t, [field]: value } : t))
  emit('change', next)
}

function patchNested(i: number, si: number, field: keyof RespTransform, value: unknown): void {
  const next = props.transforms.map((t, j) => {
    if (j !== i) return t
    const sub = (t.taskTransforms ?? []).map((s, k) => (k === si ? { ...s, [field]: value } : s))
    return { ...t, taskTransforms: sub }
  })
  emit('change', next)
}

function move(i: number, dir: -1 | 1): void {
  const next = [...props.transforms]
  const j = i + dir
  if (j < 0 || j >= next.length) return
  ;[next[i], next[j]] = [next[j], next[i]]
  emit('change', next)
}

function remove(i: number): void {
  emit(
    'change',
    props.transforms.filter((_, j) => j !== i)
  )
}

function addTransform(): void {
  emit('change', [...props.transforms, makeTransform()])
}

function addNested(i: number): void {
  const next = props.transforms.map((t, j) =>
    j === i ? { ...t, taskTransforms: [...(t.taskTransforms ?? []), makeTransform()] } : t
  )
  emit('change', next)
}

function moveNested(i: number, si: number, dir: -1 | 1): void {
  const next = props.transforms.map((t, j) => {
    if (j !== i) return t
    const sub = [...(t.taskTransforms ?? [])]
    const k = si + dir
    if (k < 0 || k >= sub.length) return t
    ;[sub[si], sub[k]] = [sub[k], sub[si]]
    return { ...t, taskTransforms: sub }
  })
  emit('change', next)
}

function removeNested(i: number, si: number): void {
  const next = props.transforms.map((t, j) =>
    j === i ? { ...t, taskTransforms: (t.taskTransforms ?? []).filter((_, k) => k !== si) } : t
  )
  emit('change', next)
}

function toggle(id: string): void {
  collapsedIds.value = { ...collapsedIds.value, [id]: !collapsedIds.value[id] }
}

function patchNested2(i: number, j: number, field: 'key' | 'value', value: string): void {
  const next = props.transforms.map((t, k) => {
    if (k !== i) return t
    const vars = (t.localVars ?? []).map((lv, m) => (m === j ? { ...lv, [field]: value } : lv))
    return { ...t, localVars: vars }
  })
  emit('change', next)
}

function addLocalVar(i: number): void {
  const next = props.transforms.map((t, j) =>
    j === i ? { ...t, localVars: [...(t.localVars ?? []), { key: '', value: '' }] } : t
  )
  emit('change', next)
}

function removeLocalVar(i: number, j: number): void {
  const next = props.transforms.map((t, k) =>
    k === i ? { ...t, localVars: (t.localVars ?? []).filter((_, m) => m !== j) } : t
  )
  emit('change', next)
}
</script>

<template>
  <div class="pg-transforms">
    <div class="d-flex align-center justify-space-between mb-2">
      <span class="text-subtitle-2 font-weight-medium">{{ t('pg.respTransforms') }}</span>
      <v-btn variant="tonal" prepend-icon="mdi-plus" @click="addTransform">
        {{ t('pg.addTransform') }}
      </v-btn>
    </div>

    <div v-if="transforms.length === 0" class="text-caption on-surface-variant mb-2">
      {{ t('pg.noTransforms') }}
    </div>

    <div v-for="(rt, i) in transforms" :key="rt.id" class="pg-transform-item mb-2">
      <div class="d-flex align-center ga-2 pa-2 pg-transform-header" @click="toggle(rt.id)">
        <v-icon class="pg-collapse-arrow">{{
          collapsedIds[rt.id] ? 'mdi-chevron-right' : 'mdi-chevron-down'
        }}</v-icon>
        <span class="text-body-2">{{ rt.label || `#${i + 1}` }}</span>
        <v-chip variant="tonal" class="pg-type-chip">{{ rt.type }}</v-chip>
        <v-spacer />
        <div class="d-flex align-center ga-1" @click.stop>
          <v-btn size="small" variant="flat" icon :disabled="i === 0" @click="move(i, -1)">
            <v-icon>mdi-chevron-up</v-icon>
          </v-btn>
          <v-btn
            size="small"
            variant="flat"
            icon
            :disabled="i === transforms.length - 1"
            @click="move(i, 1)"
          >
            <v-icon>mdi-chevron-down</v-icon>
          </v-btn>
          <v-btn size="small" variant="flat" color="error" icon @click="remove(i)">
            <v-icon>mdi-close</v-icon>
          </v-btn>
        </div>
      </div>

      <div v-if="!collapsedIds[rt.id]" class="pa-3 pg-transform-body">
        <v-row dense>
          <v-col cols="6">
            <v-text-field
              :model-value="rt.label"
              density="compact"
              variant="outlined"
              hide-details
              :label="t('pg.name')"
              placeholder="e.g. Extract reply text"
              @update:model-value="patch(i, 'label', $event as string)"
            />
          </v-col>
          <v-col cols="6">
            <v-select
              :model-value="rt.type"
              :items="TYPES"
              density="compact"
              variant="outlined"
              hide-details
              :label="t('pg.type')"
              @update:model-value="patch(i, 'type', $event as RespTransform['type'])"
            />
          </v-col>
        </v-row>

        <!-- text -->
        <v-textarea
          v-if="rt.type === 'text'"
          :model-value="rt.format"
          variant="outlined"
          hide-details
          class="mt-2 font-mono"
          :label="t('pg.formatLabel')"
          rows="2"
          :hint="t('pg.formatHintShort')"
          persistent-hint
          placeholder="{.choices[0].message.content}"
          @update:model-value="patch(i, 'format', $event as string)"
        />

        <!-- script -->
        <template v-if="rt.type === 'script'">
          <v-textarea
            :model-value="scriptDraft(rt)"
            variant="outlined"
            hide-details
            class="mt-2 font-mono"
            :label="t('pg.scriptLabel')"
            rows="8"
            :hint="t('pg.scriptHintShort')"
            persistent-hint
            placeholder="context.transform.add_text('Reply', object.choices[0].message.content)"
            @update:model-value="setScriptDraft(rt.id, $event as string)"
          />
          <div class="d-flex align-center justify-space-between mt-2">
            <span class="text-caption on-surface-variant">{{ t('pg.localVarsLabel') }}</span>
            <v-btn variant="tonal" prepend-icon="mdi-check" @click="commitScript(i, rt)">
              {{ t('pg.update') }}{{ isScriptDirty(rt) ? ' *' : '' }}
            </v-btn>
          </div>
          <div v-for="(lv, j) in rt.localVars ?? []" :key="j" class="d-flex align-center ga-2 mt-1">
            <v-text-field
              :model-value="lv.key"
              density="compact"
              variant="outlined"
              hide-details
              class="font-mono"
              placeholder="name"
              @update:model-value="patchNested2(i, j, 'key', $event as string)"
            />
            <v-text-field
              :model-value="lv.value"
              density="compact"
              variant="outlined"
              hide-details
              class="font-mono"
              placeholder="value"
              @update:model-value="patchNested2(i, j, 'value', $event as string)"
            />
            <v-btn size="small" variant="flat" color="error" icon @click="removeLocalVar(i, j)">
              <v-icon>mdi-close</v-icon>
            </v-btn>
          </div>
          <v-btn variant="text" prepend-icon="mdi-plus" class="mt-1" @click="addLocalVar(i)">
            {{ t('pg.addLocalVar') }}
          </v-btn>
        </template>

        <!-- img / audio / audio-url / video-url share entry path -->
        <template v-if="['img', 'audio', 'audio-url', 'video-url'].includes(rt.type)">
          <v-text-field
            :model-value="rt.entry"
            variant="outlined"
            density="compact"
            hide-details
            class="mt-2 font-mono"
            :label="rt.type === 'img' || rt.type === 'audio' ? t('pg.entry') : t('pg.entryUrl')"
            placeholder=".images[0]"
            @update:model-value="patch(i, 'entry', $event as string)"
          />
          <v-row v-if="rt.type === 'audio'" dense class="mt-2">
            <v-col cols="6">
              <v-select
                :model-value="rt.encoding || 'base64'"
                :items="[
                  { title: 'Base64', value: 'base64' },
                  { title: 'Hex8', value: 'hex8' }
                ]"
                density="compact"
                variant="outlined"
                hide-details
                :label="t('pg.encoding')"
                @update:model-value="patch(i, 'encoding', $event as RespTransform['encoding'])"
              />
            </v-col>
          </v-row>
          <v-text-field
            v-if="['audio', 'audio-url', 'video-url'].includes(rt.type)"
            :model-value="rt.audioMime || ''"
            variant="outlined"
            density="compact"
            hide-details
            class="mt-2"
            :label="t('pg.mimeAuto')"
            placeholder="auto"
            spellcheck="false"
            @update:model-value="patch(i, 'audioMime', $event as string)"
          />
        </template>

        <!-- task -->
        <template v-if="rt.type === 'task'">
          <v-row dense class="mt-2">
            <v-col cols="6">
              <v-text-field
                :model-value="rt.entry"
                variant="outlined"
                density="compact"
                hide-details
                :label="t('pg.taskIdPath')"
                placeholder=".task_id"
                class="font-mono"
                @update:model-value="patch(i, 'entry', $event as string)"
              />
            </v-col>
            <v-col cols="6">
              <v-text-field
                :model-value="rt.taskAddr"
                variant="outlined"
                density="compact"
                hide-details
                :label="t('pg.pollUrl')"
                placeholder="https://api.example.com/v1/task"
                class="font-mono"
                @update:model-value="patch(i, 'taskAddr', $event as string)"
              />
            </v-col>
          </v-row>
          <v-textarea
            :model-value="rt.taskHeaders"
            variant="outlined"
            hide-details
            class="mt-2 font-mono"
            :label="t('pg.taskHeaders')"
            rows="2"
            @update:model-value="patch(i, 'taskHeaders', $event as string)"
          />
          <v-text-field
            :model-value="rt.taskQuery"
            variant="outlined"
            density="compact"
            hide-details
            class="mt-2 font-mono"
            :label="t('pg.queryAuto')"
            placeholder="&other={.path}"
            @update:model-value="patch(i, 'taskQuery', $event as string)"
          />
          <v-row dense class="mt-2">
            <v-col cols="6">
              <v-text-field
                :model-value="rt.taskStatusPath"
                variant="outlined"
                density="compact"
                hide-details
                :label="t('pg.statusPath')"
                placeholder=".task.status"
                class="font-mono"
                @update:model-value="patch(i, 'taskStatusPath', $event as string)"
              />
            </v-col>
            <v-col cols="6">
              <v-text-field
                :model-value="rt.taskStatusVal"
                variant="outlined"
                density="compact"
                hide-details
                :label="t('pg.successVal')"
                placeholder="SUCCESS"
                class="font-mono"
                @update:model-value="patch(i, 'taskStatusVal', $event as string)"
              />
            </v-col>
          </v-row>
          <v-row dense class="mt-2">
            <v-col cols="6">
              <v-text-field
                :model-value="rt.taskFailReasonPath"
                variant="outlined"
                density="compact"
                hide-details
                :label="t('pg.failReasonPath')"
                placeholder=".task.reason"
                class="font-mono"
                @update:model-value="patch(i, 'taskFailReasonPath', $event as string)"
              />
            </v-col>
            <v-col cols="6">
              <v-text-field
                :model-value="rt.taskFailVal"
                variant="outlined"
                density="compact"
                hide-details
                :label="t('pg.failVal')"
                placeholder="FAILED"
                class="font-mono"
                @update:model-value="patch(i, 'taskFailVal', $event as string)"
              />
            </v-col>
          </v-row>
          <v-text-field
            :model-value="rt.taskPollMs || 2000"
            type="number"
            variant="outlined"
            density="compact"
            hide-details
            class="mt-2"
            :label="t('pg.pollInterval')"
            style="max-width: 160px"
            @update:model-value="patch(i, 'taskPollMs', Number($event))"
          />

          <!-- nested transforms -->
          <div class="mt-3">
            <div class="d-flex align-center justify-space-between mb-1">
              <span class="text-caption on-surface-variant">{{ t('pg.nestedTransforms') }}</span>
              <v-btn variant="tonal" prepend-icon="mdi-plus" @click="addNested(i)">{{
                t('pg.addTransform')
              }}</v-btn>
            </div>
            <div
              v-if="(rt.taskTransforms ?? []).length === 0"
              class="text-caption on-surface-variant mb-1"
            >
              {{ t('pg.noTransforms') }}
            </div>
            <div
              v-for="(sub, si) in rt.taskTransforms ?? []"
              :key="sub.id"
              class="pg-transform-item mb-1"
            >
              <div
                class="d-flex align-center ga-2 pa-2 pg-transform-header"
                @click="toggle(sub.id)"
              >
                <v-icon>{{
                  collapsedIds[sub.id] ? 'mdi-chevron-right' : 'mdi-chevron-down'
                }}</v-icon>
                <span class="text-body-2">{{ sub.label || `#${si + 1}` }}</span>
                <v-chip variant="tonal">{{ sub.type }}</v-chip>
                <v-spacer />
                <div class="d-flex align-center ga-1" @click.stop>
                  <v-btn
                    size="small"
                    variant="flat"
                    icon
                    :disabled="si === 0"
                    @click="moveNested(i, si, -1)"
                    ><v-icon>mdi-chevron-up</v-icon></v-btn
                  >
                  <v-btn
                    size="small"
                    variant="flat"
                    icon
                    :disabled="si === (rt.taskTransforms ?? []).length - 1"
                    @click="moveNested(i, si, 1)"
                    ><v-icon>mdi-chevron-down</v-icon></v-btn
                  >
                  <v-btn size="small" variant="flat" color="error" icon @click="removeNested(i, si)"
                    ><v-icon>mdi-close</v-icon></v-btn
                  >
                </div>
              </div>
              <div v-if="!collapsedIds[sub.id]" class="pa-3 pg-transform-body">
                <v-row dense>
                  <v-col cols="6">
                    <v-text-field
                      :model-value="sub.label"
                      density="compact"
                      variant="outlined"
                      hide-details
                      :label="t('pg.name')"
                      @update:model-value="patchNested(i, si, 'label', $event as string)"
                    />
                  </v-col>
                  <v-col cols="6">
                    <v-select
                      :model-value="sub.type"
                      :items="TYPES.filter((x) => x.value !== 'task' && x.value !== 'script')"
                      density="compact"
                      variant="outlined"
                      hide-details
                      :label="t('pg.type')"
                      @update:model-value="
                        patchNested(i, si, 'type', $event as RespTransform['type'])
                      "
                    />
                  </v-col>
                </v-row>
                <v-textarea
                  v-if="sub.type === 'text'"
                  :model-value="sub.format"
                  variant="outlined"
                  hide-details
                  class="mt-2 font-mono"
                  :label="t('pg.format')"
                  rows="2"
                  placeholder="{.choices[0].message.content}"
                  @update:model-value="patchNested(i, si, 'format', $event as string)"
                />
                <v-text-field
                  v-if="['img', 'audio', 'audio-url', 'video-url'].includes(sub.type)"
                  :model-value="sub.entry"
                  variant="outlined"
                  density="compact"
                  hide-details
                  class="mt-2 font-mono"
                  :label="
                    sub.type === 'img' || sub.type === 'audio' ? t('pg.entry') : t('pg.entryUrl')
                  "
                  @update:model-value="patchNested(i, si, 'entry', $event as string)"
                />
                <v-row v-if="sub.type === 'audio'" dense class="mt-2">
                  <v-col cols="6">
                    <v-select
                      :model-value="sub.encoding || 'base64'"
                      :items="[
                        { title: 'Base64', value: 'base64' },
                        { title: 'Hex8', value: 'hex8' }
                      ]"
                      density="compact"
                      variant="outlined"
                      hide-details
                      :label="t('pg.encoding')"
                      @update:model-value="
                        patchNested(i, si, 'encoding', $event as RespTransform['encoding'])
                      "
                    />
                  </v-col>
                </v-row>
                <v-text-field
                  v-if="['audio', 'audio-url', 'video-url'].includes(sub.type)"
                  :model-value="sub.audioMime || ''"
                  variant="outlined"
                  density="compact"
                  hide-details
                  class="mt-2"
                  :label="t('pg.mime')"
                  placeholder="auto"
                  spellcheck="false"
                  @update:model-value="patchNested(i, si, 'audioMime', $event as string)"
                />
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pg-transform-item {
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.16);
  border-radius: 8px;
}
.pg-transform-header {
  cursor: pointer;
  user-select: none;
}
.pg-transform-header:hover {
  background: rgba(var(--v-theme-surface-bright), 0.08);
}
.pg-collapse-arrow {
  transition: transform 0.15s ease;
}
.pg-type-chip {
  padding-block: 2px;
  min-height: 18px;
  font-size: 0.65rem;
}
.font-mono :deep(input),
.font-mono :deep(textarea) {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 0.8rem;
}
/* type chips need breathing room — x-small crammed the label against the edge */
.pg-type-chip,
.pg-transform-header .v-chip {
  padding-block: 4px;
  min-height: 24px;
}
</style>

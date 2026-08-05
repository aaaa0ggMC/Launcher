<script setup lang="ts">
import { ref } from 'vue'
import type { RespTransform } from '../types'

const props = defineProps<{
  transforms: RespTransform[]
  globalVarNames: Set<string>
}>()

const emit = defineEmits<{
  change: [transforms: RespTransform[]]
}>()

const collapsedIds = ref<Record<string, boolean>>({})

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
      <span class="text-subtitle-2 font-weight-medium">响应变换</span>
      <v-btn size="small" variant="tonal" prepend-icon="mdi-plus" @click="addTransform">
        添加变换
      </v-btn>
    </div>

    <div v-if="transforms.length === 0" class="text-caption on-surface-variant mb-2">暂无变换</div>

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
              label="名称"
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
              label="类型"
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
          label="格式 — JSON 路径"
          rows="2"
          :hint="'— {.path}；数组枚举 0. … 1. …；[X] 同步多路径；不同数组根笛卡尔积'"
          persistent-hint
          placeholder="{.choices[0].message.content}"
          @update:model-value="patch(i, 'format', $event as string)"
        />

        <!-- script -->
        <template v-if="rt.type === 'script'">
          <v-textarea
            :model-value="rt.script"
            variant="outlined"
            hide-details
            class="mt-2 font-mono"
            label="脚本 (JS)"
            rows="8"
            :hint="'object=解析后的 JSON，global_vars=全局变量。用 context.transform.add_text/add_img/add_audio/add_video。点击「更新」运行。'"
            persistent-hint
            placeholder="context.transform.add_text('Reply', object.choices[0].message.content)"
            @update:model-value="patch(i, 'script', $event as string)"
          />
          <div class="d-flex align-center justify-space-between mt-2">
            <span class="text-caption on-surface-variant">局部变量 (context.local.NAME)</span>
            <v-btn
              size="small"
              variant="tonal"
              prepend-icon="mdi-check"
              @click="patch(i, 'scriptVersion', (rt.scriptVersion ?? 0) + 1)"
            >
              更新{{ (rt.script ?? '') !== '' ? ' *' : '' }}
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
          <v-btn
            size="small"
            variant="text"
            prepend-icon="mdi-plus"
            class="mt-1"
            @click="addLocalVar(i)"
          >
            添加局部变量
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
            :label="rt.type === 'img' || rt.type === 'audio' ? '入口路径' : '入口 URL'"
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
                label="编码"
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
            label="MIME 类型 (留空自动检测)"
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
                label="任务 ID 路径"
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
                label="轮询 URL"
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
            label="请求头 (每行 Key: value)"
            rows="2"
            @update:model-value="patch(i, 'taskHeaders', $event as string)"
          />
          <v-text-field
            :model-value="rt.taskQuery"
            variant="outlined"
            density="compact"
            hide-details
            class="mt-2 font-mono"
            label="查询参数 (task_id 自动填充)"
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
                label="状态路径"
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
                label="成功值"
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
                label="失败原因路径"
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
                label="失败值"
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
            label="轮询间隔 (ms)"
            style="max-width: 160px"
            @update:model-value="patch(i, 'taskPollMs', Number($event))"
          />

          <!-- nested transforms -->
          <div class="mt-3">
            <div class="d-flex align-center justify-space-between mb-1">
              <span class="text-caption on-surface-variant">响应变换</span>
              <v-btn size="small" variant="tonal" prepend-icon="mdi-plus" @click="addNested(i)"
                >添加</v-btn
              >
            </div>
            <div
              v-if="(rt.taskTransforms ?? []).length === 0"
              class="text-caption on-surface-variant mb-1"
            >
              暂无响应变换
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
                      label="名称"
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
                      label="类型"
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
                  label="格式"
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
                  :label="sub.type === 'img' || sub.type === 'audio' ? '入口路径' : '入口 URL'"
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
                      label="编码"
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
                  label="MIME 类型"
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

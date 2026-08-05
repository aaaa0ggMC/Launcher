<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { RespTransform } from '../types'
import {
  resolveJsonPath,
  interpolate,
  applyTransforms,
  type TransformResult
} from '../parser/variableParser'

interface TaskState {
  transformId: string
  label: string
  status: 'polling' | 'done' | 'failed'
  statusText: string
  failReason: string
  results: TransformResult[]
}

const props = defineProps<{
  transforms: RespTransform[]
  initialResponse: string
  variables: Record<string, string>
}>()

const emit = defineEmits<{ complete: [results: TransformResult[]] }>()

const tasks = ref<TaskState[]>([])
let timer: ReturnType<typeof setTimeout> | null = null

async function poll(
  tfList: RespTransform[],
  states: TaskState[],
  initialJson: unknown,
  vars: Record<string, string>
): Promise<void> {
  const updated = [...states]
  let allDone = true

  for (let i = 0; i < updated.length; i++) {
    if (updated[i].status !== 'polling') continue
    const tf = tfList.find((t) => t.id === updated[i].transformId)
    if (!tf || !tf.taskAddr) continue

    try {
      const taskAddr = interpolate(tf.taskAddr, vars)
      const taskQuery = interpolate(tf.taskQuery, vars)
      const taskHeaders = interpolate(tf.taskHeaders, vars)

      const taskId = resolveJsonPath(initialJson, tf.entry.trim())
      let queryStr: string
      if (taskQuery) {
        queryStr = taskQuery
          .replace(/\{\.([^}]+)\}/g, (_, path: string) =>
            String(resolveJsonPath(initialJson, path.trim()) ?? '')
          )
          .replace(/\{task_id\}/g, String(taskId ?? ''))
        if (taskId != null) {
          queryStr = queryStr.replace(/&?task_id=[^&]*/, '').replace(/^&/, '')
          queryStr += (queryStr ? '&' : '') + `task_id=${taskId}`
        }
      } else {
        queryStr = `task_id=${taskId ?? ''}`
      }

      const sep = taskAddr.includes('?') ? '&' : '?'
      const url = taskAddr + sep + queryStr

      const headers: Record<string, string> = {}
      if (taskHeaders) {
        for (const line of taskHeaders.split('\n')) {
          const idx = line.indexOf(':')
          if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
        }
      }
      const resp = await fetch(url, {
        method: tf.taskMethod || 'GET',
        headers: Object.keys(headers).length > 0 ? headers : undefined
      })
      const text = await resp.text()
      if (resp.status === 400) {
        updated[i] = {
          ...updated[i],
          status: 'failed',
          statusText: text,
          failReason: text
        }
        continue
      }
      let respJson: unknown
      try {
        respJson = JSON.parse(text)
      } catch {
        respJson = {}
      }

      const statusVal = String(resolveJsonPath(respJson, tf.taskStatusPath) ?? '')
      const failReason = String(resolveJsonPath(respJson, tf.taskFailReasonPath) ?? '')

      if (tf.taskFailVal && statusVal === tf.taskFailVal) {
        updated[i] = {
          ...updated[i],
          status: 'failed',
          statusText: failReason || statusVal,
          failReason: failReason || statusVal
        }
      } else if (statusVal === tf.taskStatusVal) {
        const results = await applyTransforms(text, tf.taskTransforms)
        const rawResult: TransformResult = { kind: 'text', label: 'Raw Response', value: text }
        updated[i] = {
          ...updated[i],
          status: 'done',
          statusText: 'Success',
          results: [rawResult, ...results]
        }
      } else {
        updated[i] = { ...updated[i], statusText: statusVal || 'Processing...' }
        allDone = false
      }
    } catch (err) {
      updated[i] = {
        ...updated[i],
        status: 'failed',
        statusText: err instanceof Error ? err.message : String(err),
        failReason: err instanceof Error ? err.message : String(err)
      }
    }
  }

  tasks.value = updated

  if (!allDone) {
    timer = setTimeout(
      () => void poll(tfList, updated, initialJson, vars),
      tfList[0]?.taskPollMs || 2000
    )
  } else {
    const allResults: TransformResult[] = []
    for (const t of updated) {
      const children =
        t.status === 'failed'
          ? [{ kind: 'text' as const, label: 'Error', value: t.failReason }]
          : t.results
      allResults.push({ kind: 'text', label: t.label, value: '', children })
    }
    emit('complete', allResults)
  }
}

watch(
  () => [props.transforms, props.initialResponse] as const,
  ([tfList, initialResponse]) => {
    let json: unknown
    try {
      json = JSON.parse(initialResponse)
    } catch {
      return
    }
    const initial: TaskState[] = tfList
      .filter((t) => t.type === 'task' && t.taskAddr)
      .map((t) => ({
        transformId: t.id,
        label: t.label || 'Task',
        status: 'polling' as const,
        statusText: 'Starting...',
        failReason: '',
        results: []
      }))
    if (initial.length === 0) return
    tasks.value = initial
    void poll(tfList, initial, json, props.variables)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <div v-if="tasks.length" class="pg-taskpoller mt-3">
    <div class="text-subtitle-2 font-weight-medium mb-2">任务进度</div>
    <div v-for="t in tasks" :key="t.transformId" class="d-flex align-center ga-2 mb-1">
      <span class="text-body-2">{{ t.label }}</span>
      <span
        class="text-caption"
        :class="
          t.status === 'failed'
            ? 'pg-task-fail'
            : t.status === 'done'
              ? 'pg-task-ok'
              : 'pg-task-poll'
        "
      >
        {{ t.status === 'polling' ? '⏳ ' : '' }}{{ t.statusText }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.pg-task-fail {
  color: rgb(var(--v-theme-error));
}
.pg-task-ok {
  color: rgb(var(--v-theme-success));
}
.pg-task-poll {
  color: rgb(var(--v-theme-on-surface-variant));
}
</style>

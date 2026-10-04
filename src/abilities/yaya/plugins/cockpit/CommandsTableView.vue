<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import type { ToolViewProps } from '../../components/plugin-ui'

defineOptions({ name: 'cockpit-yaya-tool-commands-table' })

const props = defineProps<ToolViewProps>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

interface CommandRow {
  name: string
  ability: string
  description: string
  usage: string
  available: boolean
  reason: string
  /** 关联命令 / UI 入口 / 需要的隐私授权（展示成一行附注） */
  notes: string[]
}

const PAGE = 100
const query = ref('')
const visible = ref(PAGE)

function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

const rows = computed<CommandRow[]>(() => {
  const res = props.call.result as { commands?: unknown } | unknown[] | undefined
  const list = Array.isArray(res)
    ? res
    : Array.isArray((res as { commands?: unknown } | undefined)?.commands)
      ? ((res as { commands: unknown[] }).commands as unknown[])
      : []
  return list.map((item) => {
    const r = (item ?? {}) as Record<string, unknown>
    const privacy = (r.privacy ?? {}) as { requires?: unknown }
    const notes = [
      strArray(r.related).length
        ? te(
            'yaya.plugin.cockpit.cmd_related',
            { list: strArray(r.related).join(', ') },
            '关联：{list}'
          )
        : '',
      strArray(r.ui).length
        ? te('yaya.plugin.cockpit.cmd_ui', { list: strArray(r.ui).join(', ') }, '界面入口：{list}')
        : '',
      strArray(privacy.requires).length
        ? te(
            'yaya.plugin.cockpit.cmd_requires',
            { list: strArray(privacy.requires).join(', ') },
            '需授权：{list}'
          )
        : ''
    ].filter(Boolean)
    return {
      name: str(r.name),
      ability: str(r.ability),
      description: str(r.description),
      usage: str(r.usage),
      available: r.available !== false,
      reason: str(r.unavailable_reason),
      notes
    }
  })
})

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return rows.value
  return rows.value.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q) ||
      r.ability.toLowerCase().includes(q)
  )
})

const shown = computed(() => filtered.value.slice(0, visible.value))
const hidden = computed(() => filtered.value.length - shown.value.length)

// 容器 < 560px（聊天栏 / 手机）时一行一张小卡，不出横向滚动条。
// 量容器而不是窗口断点：这个视图可能嵌在窄分栏或被缩放的界面里。
const root = ref<HTMLElement | null>(null)
const stacked = ref(false)
let resizeObs: ResizeObserver | null = null

onMounted(() => {
  if (!root.value) return
  resizeObs = new ResizeObserver(() => {
    stacked.value = (root.value?.clientWidth ?? 0) < 560
  })
  resizeObs.observe(root.value)
  stacked.value = root.value.clientWidth < 560
})
onBeforeUnmount(() => {
  resizeObs?.disconnect()
  resizeObs = null
})
</script>

<template>
  <div ref="root" class="cmds">
    <div class="cmds-head">
      <v-text-field
        v-model="query"
        :label="t('yaya.plugin.cockpit.cmds_search', '搜索命令')"
        :placeholder="t('yaya.plugin.cockpit.cmds_search_placeholder', '按名称、能力或描述搜索')"
        prepend-inner-icon="mdi-magnify"
        variant="outlined"
        clearable
        hide-details
        @update:model-value="query = $event ?? ''"
      />
      <span class="cmds-count text-caption text-medium-emphasis">
        {{ te('yaya.plugin.cockpit.cmds_count', { n: String(filtered.length) }, '{n} 条命令') }}
      </span>
    </div>

    <div v-if="!filtered.length" class="cmds-empty text-body-2 text-medium-emphasis">
      <v-icon icon="mdi-magnify-close" size="18" />
      {{ t('yaya.plugin.cockpit.cmds_empty', '没有匹配的命令') }}
    </div>

    <div v-else class="cmds-list" :class="{ 'is-stacked': stacked }">
      <div
        v-for="row in shown"
        :key="row.name"
        class="cmds-row"
        :title="row.usage || row.description"
      >
        <div class="cmds-main">
          <span class="cmds-name">{{ row.name }}</span>
          <v-chip
            variant="tonal"
            :color="row.available ? 'success' : 'warning'"
            class="chip-pad flex-shrink-0"
            :title="row.available ? undefined : row.reason"
          >
            {{
              row.available
                ? t('yaya.plugin.cockpit.cmd_available', '可用')
                : t('yaya.plugin.cockpit.cmd_unavailable', '暂不可用')
            }}
          </v-chip>
        </div>
        <div class="cmds-desc">{{ row.description }}</div>
        <div v-if="row.usage" class="cmds-usage">{{ row.usage }}</div>
        <div v-if="row.notes.length" class="cmds-notes">
          <span v-for="n in row.notes" :key="n" class="cmds-note">{{ n }}</span>
        </div>
        <div v-if="!row.available && row.reason" class="cmds-reason">
          <v-icon icon="mdi-alert-circle-outline" size="14" color="warning" />
          {{ row.reason }}
        </div>
      </div>

      <div v-if="hidden > 0" class="cmds-more">
        <v-btn variant="text" @click="visible += PAGE">
          {{ te('yaya.plugin.cockpit.cmds_more', { n: String(hidden) }, '再显示 {n} 条') }}
        </v-btn>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cmds {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* chip：默认密度 + 显式内边距，label 不贴边框 */
.chip-pad {
  padding-block: 4px;
  min-height: 24px;
}
.cmds-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.cmds-count {
  margin-inline-start: auto;
}
.cmds-empty {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-block: 8px;
}
.cmds-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cmds-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 4px 10px;
  padding: 8px 10px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 10px;
  background: rgba(var(--v-theme-surface-variant), 0.16);
}
.cmds-main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  min-width: 0;
  max-width: 100%;
}
.cmds-name {
  font-family: ui-monospace, monospace;
  font-size: 0.82rem;
  font-weight: 600;
  min-width: 0;
  overflow-wrap: anywhere;
}
.cmds-desc {
  flex: 1 1 220px;
  min-width: 0;
  font-size: 0.8rem;
  line-height: 1.5;
  color: rgba(var(--v-theme-on-surface), 0.82);
  overflow-wrap: anywhere;
}
.cmds-usage,
.cmds-notes,
.cmds-reason {
  flex: 1 1 100%;
  min-width: 0;
  font-size: 0.72rem;
  line-height: 1.5;
  color: rgba(var(--v-theme-on-surface), 0.55);
  overflow-wrap: anywhere;
}
.cmds-notes {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
}
.cmds-reason {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  color: rgb(var(--v-theme-warning));
}
.cmds-more {
  display: flex;
  justify-content: center;
}
/* 窄容器：名称块与描述各占一行，退化成「一行一张小卡」 */
.cmds-list.is-stacked .cmds-main,
.cmds-list.is-stacked .cmds-desc {
  flex: 1 1 100%;
}
.cmds-list.is-stacked .cmds-row {
  padding: 8px;
}
/* 窄屏（手机） */
@media (max-width: 720px) {
  .cmds-count {
    margin-inline-start: 0;
  }
}
</style>

<script setup lang="ts">
/**
 * 独占窄条（外壳）：当前页面有**被 AI 持有**的独占租约时，显示在 App bar 下方、
 * 页面内容上方的一条窄条，用户可一键「接管」（用户永远优先）。
 *
 * - 用户主窗口：只显示当前页面所属能力被 AI 占用的租约；
 * - AI 自己的视图：只显示该会话自己持有的租约（用户跟同时也能接管）；
 * - 多个租约只显示第一个 + 「等 N 项」，不堆叠。
 */
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import { translate, translateTemplate } from '../i18n'
import { useExclusive, formatHeld, type HeldUnits, type LeaseView } from '../composables/exclusive'

const props = defineProps<{
  /** 当前页面所属能力 id */
  currentId: string | null
  /** 多 Ability 文件夹 id（scope 前缀按它匹配） */
  folder?: string | null
  /** AI 自己的视图所属会话（非空 = 这是某个 agent 会话的渲染进程） */
  agentSession?: string | null
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (k: string, f?: string): string => translate(uiLang.value, k, f)
const tt = (k: string, v: Record<string, string>, f?: string): string =>
  translateTemplate(uiLang.value, k, v, f)

const { forAbility, takeOver } = useExclusive()

/** 该窄条要展示的租约（AI 持有的那部分）。 */
const held = computed<LeaseView[]>(() => {
  const scope = forAbility(props.currentId, props.folder)
  const ai = scope.filter((l) => l.owner.kind === 'agent')
  if (!props.agentSession) return ai
  return ai.filter((l) => {
    const o = l.owner
    return o.kind === 'agent' && o.session === props.agentSession
  })
})
const first = computed<LeaseView | null>(() => held.value[0] ?? null)
const extra = computed(() => Math.max(0, held.value.length - 1))

const busy = ref(false)
const hint = ref('')

/** {资源} = 范围名翻译键（找不到回落 scope）+ 具体 key。 */
function resource(l: LeaseView): string {
  return `${t(l.label, l.scope)} · ${l.key}`
}

/** 时长单位走翻译键（中文带前导空格，英文紧跟数字）。 */
const units = computed<HeldUnits>(() => ({
  sec: t('agent.excl.unit_sec', ' 秒'),
  min: t('agent.excl.unit_min', ' 分'),
  hour: t('agent.excl.unit_hour', ' 小时')
}))

const message = computed(() => {
  const l = first.value
  if (!l) return ''
  const res = resource(l)
  const duration = formatHeld(heldMsOf(l), units.value)
  const more =
    extra.value > 0
      ? ` · ${tt('agent.excl.more', { n: String(extra.value) }, `等 ${extra.value} 项`)}`
      : ''
  if (props.agentSession) {
    return tt('agent.excl.ai_held', { res, more }, `AI 正在占用：${res}${more}`)
  }
  const client = l.owner.kind === 'agent' ? l.owner.client || l.owner.session : ''
  return tt(
    'agent.excl.user_held',
    { res, client, held: duration, more },
    `该页面的 ${res} 正被 AI「${client}」占用（已 ${duration}）${more}`
  )
})

/** 已持有时长：广播带 heldMs 就用它，否则按 acquiredAt 现算。 */
function heldMsOf(l: LeaseView): number {
  return typeof l.heldMs === 'number' ? l.heldMs : Date.now() - l.acquiredAt
}

async function onTakeOver(): Promise<void> {
  const l = first.value
  if (!l || busy.value) return
  busy.value = true
  hint.value = ''
  try {
    await takeOver(l.scope, l.key)
    hint.value = tt('agent.excl.taken', { res: resource(l) }, `已接管 ${resource(l)}`)
  } catch (e) {
    hint.value = tt(
      'agent.excl.take_failed',
      { msg: e instanceof Error ? e.message : String(e) },
      `接管失败：${e instanceof Error ? e.message : String(e)}`
    )
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <v-alert
    v-if="first"
    v-agent-forbidden
    class="excl-banner"
    type="warning"
    variant="tonal"
    density="compact"
    border="start"
    :class="{ 'excl-banner--hint': !!hint }"
  >
    <div class="excl-banner__row">
      <span class="excl-banner__text">{{ message }}</span>
      <v-btn
        class="text-none"
        variant="tonal"
        color="warning"
        :loading="busy"
        :disabled="busy"
        :title="t('agent.excl.take_over', '接管')"
        :aria-label="t('agent.excl.take_over', '接管')"
        @click="onTakeOver"
      >
        {{ t('agent.excl.take_over', '接管') }}
      </v-btn>
    </div>
    <div v-if="hint" class="excl-banner__hint text-body-2 text-medium-emphasis">{{ hint }}</div>
  </v-alert>
</template>

<style scoped>
/* 窄条：上下内边距 ≥ 8px，与页面内容之间留 ≥ 8px（不要挤） */
.excl-banner {
  padding-block: 10px;
  padding-inline: 12px;
  margin-bottom: 12px;
  border-radius: 8px;
}
.excl-banner--hint {
  padding-bottom: 8px;
}
.excl-banner__row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.excl-banner__text {
  min-width: 0;
  flex: 1 1 auto;
  line-height: 1.5;
}
.excl-banner__hint {
  margin-top: 8px;
}
</style>

<script setup lang="ts">
/**
 * 设置 →「AI 与远程」→「AI 脚本」：command_script 总开关与限额（WP-B2）。
 * 只 emit patch，写盘由父组件 AgentSettingsSection 的 patchAgent 统一做（config.set 是浅合并）。
 * 整个卡片是 AI 禁区：AI 不能给自己放开脚本限额。
 */
defineOptions({ name: 'cockpit-settings-agent-script' })

import { inject, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'

interface ScriptCfg {
  enabled?: boolean
  maxCalls?: number
  cpuMs?: number
  wallSec?: number
  memoryMB?: number
}

/** 与主进程 src/main/process/agent/script-utils.ts 的 SCRIPT_CONFIG_RANGES / DEFAULTS 保持一致 */
const RANGES = {
  maxCalls: { min: 1, max: 2000 },
  cpuMs: { min: 100, max: 60000 },
  wallSec: { min: 5, max: 1800 },
  memoryMB: { min: 16, max: 512 }
} as const
type NumKey = keyof typeof RANGES
const DEFAULTS: Record<NumKey, number> = {
  maxCalls: 300,
  cpuMs: 5000,
  wallSec: 120,
  memoryMB: 64
}

const props = defineProps<{ cfg: { script?: ScriptCfg } }>()
const emit = defineEmits<{ patch: [patch: { script: ScriptCfg }] }>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (k: string, f?: string): string => translate(uiLang.value, k, f)

const enabled = (): boolean => props.cfg.script?.enabled !== false

const nums = ref<Record<NumKey, string>>({
  maxCalls: String(DEFAULTS.maxCalls),
  cpuMs: String(DEFAULTS.cpuMs),
  wallSec: String(DEFAULTS.wallSec),
  memoryMB: String(DEFAULTS.memoryMB)
})

function clamp(n: number, key: NumKey): number {
  const { min, max } = RANGES[key]
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 配置里的现值（缺省 / 非法都按默认值显示） */
function current(key: NumKey): number {
  const raw = props.cfg.script?.[key]
  return clamp(typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULTS[key], key)
}

function syncNums(): void {
  for (const key of Object.keys(RANGES) as NumKey[]) nums.value[key] = String(current(key))
}

// 父组件写完盘后 cfg 会变，跟随刷新（避免输入框还留着旧的非法值）
watch(
  () => props.cfg.script,
  () => syncNums(),
  { immediate: true }
)

function setEnabled(v: boolean | null): void {
  emit('patch', { script: { ...(props.cfg.script ?? {}), enabled: !!v } })
}

/** 失焦 / 回车：夹紧到合法范围，有变化才 emit（父组件合并现有 script 配置） */
function saveNum(key: NumKey): void {
  const raw = Number(nums.value[key])
  const n = clamp(Number.isFinite(raw) ? raw : DEFAULTS[key], key)
  nums.value[key] = String(n)
  if (n !== current(key)) emit('patch', { script: { ...(props.cfg.script ?? {}), [key]: n } })
}
</script>

<template>
  <v-card v-agent-forbidden rounded="lg" variant="tonal">
    <v-card-title class="pt-4">{{ t('agent.script_title', 'AI 脚本') }}</v-card-title>
    <v-card-subtitle class="agent-script-wrap">
      {{
        t(
          'agent.script_desc',
          '允许 AI 提交一段脚本，在主进程的隔离沙箱里一次执行多步操作（例如「操作 → 截图 → 判断」的循环）。脚本只能调用命令，隐私与独占规则照常生效。'
        )
      }}
    </v-card-subtitle>
    <v-card-text class="d-flex flex-column ga-6 pt-4 pb-6">
      <div class="d-flex flex-column ga-2">
        <v-switch
          :model-value="enabled()"
          :label="t('agent.script_enable', '允许 AI 使用 command_script')"
          color="primary"
          hide-details
          @update:model-value="(v) => setEnabled(v)"
        />
        <div class="text-body-2 text-medium-emphasis">
          {{
            t(
              'agent.script_off_hint',
              '关闭后，AI 调用 command_script 会直接失败（脚本不会运行）。'
            )
          }}
        </div>
      </div>
      <div class="agent-script-grid">
        <v-text-field
          v-model="nums.maxCalls"
          :label="t('agent.script_max_calls', '单次最多命令数')"
          :hint="t('agent.script_max_calls_hint', '一段脚本里能调用多少条命令（1–2000）')"
          persistent-hint
          type="number"
          variant="outlined"
          class="agent-script-field"
          :disabled="!enabled()"
          @blur="saveNum('maxCalls')"
          @keydown.enter="saveNum('maxCalls')"
        />
        <v-text-field
          v-model="nums.cpuMs"
          :label="t('agent.script_cpu_ms', '纯计算时间')"
          :hint="
            t(
              'agent.script_cpu_ms_hint',
              '沙箱内连续计算的毫秒数上限（100–60000），等待命令返回不计'
            )
          "
          persistent-hint
          suffix="ms"
          type="number"
          variant="outlined"
          class="agent-script-field"
          :disabled="!enabled()"
          @blur="saveNum('cpuMs')"
          @keydown.enter="saveNum('cpuMs')"
        />
        <v-text-field
          v-model="nums.wallSec"
          :label="t('agent.script_wall_sec', '总时限')"
          :hint="
            t(
              'agent.script_wall_sec_hint',
              '整段脚本的秒数上限（5–1800）；隐私授权窗口的等待也占用它，需要等待请调大'
            )
          "
          persistent-hint
          suffix="s"
          type="number"
          variant="outlined"
          class="agent-script-field"
          :disabled="!enabled()"
          @blur="saveNum('wallSec')"
          @keydown.enter="saveNum('wallSec')"
        />
        <v-text-field
          v-model="nums.memoryMB"
          :label="t('agent.script_memory_mb', '内存')"
          :hint="t('agent.script_memory_mb_hint', '沙箱可用的内存上限（16–512 MB）')"
          persistent-hint
          suffix="MB"
          type="number"
          variant="outlined"
          class="agent-script-field"
          :disabled="!enabled()"
          @blur="saveNum('memoryMB')"
          @keydown.enter="saveNum('memoryMB')"
        />
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.agent-script-grid {
  display: grid;
  gap: 24px 20px;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}
.agent-script-field {
  min-width: 0;
}
.agent-script-wrap {
  white-space: normal;
}
</style>

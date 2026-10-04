<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-agent' })

/**
 * 设置 →「AI 与远程」：Remote / MCP 开关与端口、访问令牌、已连接会话、隐私策略。
 * 整个区块是 AI 禁区（v-agent-forbidden）：AI 不能读 token、不能开关服务、不能给自己授权。
 */
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import { translate, translateTemplate } from '@ui/i18n'
import AgentExclusiveSettings from './AgentExclusiveSettings.vue'
import AgentScriptSettings from './AgentScriptSettings.vue'
import { AGENT_UI_LIMITS, resolveAgentUi, type AgentUiConfig } from '@ui/composables/agentUi'

interface TransportStatus {
  enabled: boolean
  source: 'config' | 'flag' | null
  running: boolean
  port: number
  url: string | null
  error: string | null
}
type Transport = 'mcp' | 'remote'
interface Session {
  id: string
  transport: Transport
  client: string
  startedAt: number
  lastSeen: number
  calls: number
}
interface AgentCfg {
  remote?: { enabled?: boolean; port?: number }
  mcp?: { enabled?: boolean; port?: number }
  privacy?: Record<string, unknown>
  ui?: Partial<AgentUiConfig>
  exclusive?: { idleMin?: number }
  script?: {
    enabled?: boolean
    maxCalls?: number
    cpuMs?: number
    wallSec?: number
    memoryMB?: number
  }
}

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (k: string, f?: string): string => translate(uiLang.value, k, f)
const tt = (k: string, v: Record<string, string>, f?: string): string =>
  translateTemplate(uiLang.value, k, v, f)

const agentCfg = ref<AgentCfg>({})
const status = ref<Record<Transport, TransportStatus> | null>(null)
const sessions = ref<Session[]>([])
const runGrants = ref<string[]>([])
const token = ref('')
const showToken = ref(false)
const ports = ref<Record<Transport, string>>({ mcp: '', remote: '' })
const toast = ref({ show: false, text: '' })
const confirmRegen = ref(false)

const ui = computed(() => resolveAgentUi(agentCfg.value.ui))
type UiNumKey = keyof typeof AGENT_UI_LIMITS
const uiNums = ref<Record<UiNumKey, string>>({
  busyTimeoutSec: '',
  statusTtlSec: '',
  hideIdleAfterMin: '',
  kickIdleAfterMin: ''
})
function syncUiNums(): void {
  for (const k of Object.keys(AGENT_UI_LIMITS) as UiNumKey[]) uiNums.value[k] = String(ui.value[k])
}

async function setUi<K extends keyof AgentUiConfig>(key: K, v: AgentUiConfig[K]): Promise<void> {
  await patchAgent({ ui: { ...ui.value, [key]: v } })
}

/** 数值项：超范围 / 非数字 → 夹紧到合法范围并提示，再写盘。 */
async function saveUiNum(key: UiNumKey): Promise<void> {
  const { min, max } = AGENT_UI_LIMITS[key]
  const raw = Number(uiNums.value[key])
  const n = Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.round(raw))) : ui.value[key]
  if (String(n) !== uiNums.value[key].trim()) {
    toast.value = {
      show: true,
      text: tt('agent.ui_range', { min: String(min), max: String(max) }, `取值范围 ${min}–${max}`)
    }
  }
  uiNums.value[key] = String(n)
  if (n !== ui.value[key]) await setUi(key, n)
}

const personal = computed(() => (agentCfg.value.privacy?.personal === 'ask' ? 'ask' : 'allow'))
const control = computed(() => (agentCfg.value.privacy?.control === 'ask' ? 'ask' : 'allow'))

const DFLT_PORTS: Record<Transport, number> = { mcp: 47802, remote: 47801 }

async function refresh(): Promise<void> {
  const cfg = (await window.cockpit.getConfig()) as { agent?: AgentCfg } | null
  agentCfg.value = cfg?.agent ?? {}
  syncUiNums()
  status.value = (await window.cockpit.command('agent.status')) as Record<
    Transport,
    TransportStatus
  >
  for (const tr of ['mcp', 'remote'] as Transport[]) {
    const p = agentCfg.value[tr]?.port || status.value?.[tr]?.port || DFLT_PORTS[tr]
    ports.value[tr] = String(p)
  }
  await refreshSessions()
  token.value = ((await window.cockpit.command('agent.token')) as { token: string }).token
}

async function refreshSessions(): Promise<void> {
  const r = (await window.cockpit.command('agent.sessions')) as {
    sessions: Session[]
    runGrants: string[]
  }
  sessions.value = r.sessions
  runGrants.value = r.runGrants
}

/** config.set 是顶层浅合并：整块写回 agent，避免覆盖其他字段。 */
async function patchAgent(patch: AgentCfg): Promise<void> {
  const next = JSON.parse(JSON.stringify({ ...agentCfg.value, ...patch })) as AgentCfg
  agentCfg.value = next
  await window.cockpit.setConfig({ agent: next })
}

async function setEnabled(tr: Transport, v: boolean | null): Promise<void> {
  await patchAgent({ [tr]: { ...agentCfg.value[tr], enabled: !!v } })
}

async function savePort(tr: Transport): Promise<void> {
  const n = Number(ports.value[tr])
  if (!Number.isInteger(n) || n <= 1024 || n >= 65536) {
    const fallback = agentCfg.value[tr]?.port || status.value?.[tr]?.port || DFLT_PORTS[tr]
    ports.value[tr] = String(fallback)
    toast.value = { show: true, text: t('agent.port_invalid', '端口需在 1025–65535 之间') }
    return
  }
  if (n === status.value?.[tr]?.port && n === agentCfg.value[tr]?.port) return
  await patchAgent({ [tr]: { ...agentCfg.value[tr], port: n } })
}

async function setPolicy(key: 'personal' | 'control', v: string): Promise<void> {
  await patchAgent({ privacy: { ...agentCfg.value.privacy, [key]: v } })
}

async function copy(text: string, msg: string): Promise<void> {
  await window.cockpit.copyText(text)
  toast.value = { show: true, text: msg }
}

async function copyMcpCommand(): Promise<void> {
  const r = (await window.cockpit.command('agent.mcp-config')) as { claudeCode: string }
  await copy(r.claudeCode, t('agent.copied_cmd', '已复制 Claude Code 接入命令'))
}

async function copyRemoteExample(): Promise<void> {
  const port = status.value?.remote.port ?? 47801
  const cmd = `curl -s http://127.0.0.1:${port}/rpc -H "Authorization: Bearer ${token.value}" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"overview","params":{}}'`
  await copy(cmd, t('agent.copied_curl', '已复制 curl 示例'))
}

async function regenerate(): Promise<void> {
  confirmRegen.value = false
  const r = (await window.cockpit.command('agent.token.regenerate')) as { token: string }
  token.value = r.token
  toast.value = { show: true, text: t('agent.token_regenerated', '已重新生成，旧令牌已失效') }
}

async function disconnect(id: string): Promise<void> {
  await window.cockpit.command('agent.disconnect', { id })
  await refreshSessions()
}

async function revokeGrants(): Promise<void> {
  await window.cockpit.command('agent.revoke-grants')
  await refreshSessions()
}

function statusText(s: TransportStatus): string {
  if (s.error) return s.error
  if (s.running) {
    return s.source === 'flag'
      ? t('agent.running_flag', '运行中（启动参数开启，仅本次）')
      : t('agent.running', '运行中')
  }
  return t('agent.stopped', '已关闭')
}
function statusColor(s: TransportStatus): string {
  return s.error ? 'error' : s.running ? 'success' : undefined!
}
function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString()
}

const maskedToken = computed(() => (showToken.value ? token.value : '•'.repeat(24)))

let offStatus: (() => void) | undefined
let offSessions: (() => void) | undefined
onMounted(async () => {
  offStatus = window.cockpit.on('cockpit:agent-status', (s) => {
    status.value = s as Record<Transport, TransportStatus>
    for (const tr of ['mcp', 'remote'] as Transport[]) {
      if (!ports.value[tr] || ports.value[tr] === '0') {
        const p = agentCfg.value[tr]?.port || status.value?.[tr]?.port || DFLT_PORTS[tr]
        ports.value[tr] = String(p)
      }
    }
  })
  offSessions = window.cockpit.on('cockpit:agent-sessions', () => void refreshSessions())
  await refresh()
})
onBeforeUnmount(() => {
  offStatus?.()
  offSessions?.()
})

defineExpose({
  toMarkdown: (): string =>
    status.value
      ? `MCP: ${statusText(status.value.mcp)}\nRemote: ${statusText(status.value.remote)}`
      : ''
})
</script>

<template>
  <div v-agent-forbidden class="d-flex flex-column ga-4">
    <v-alert type="info" variant="tonal">
      {{
        t(
          'agent.intro',
          '开启后，本机的 AI（MCP 客户端）或脚本可以读取界面、点击操作和执行命令。隐私数据默认对它们打码，需要你在弹出的授权窗口里同意。服务只监听 127.0.0.1，并需要访问令牌。'
        )
      }}
    </v-alert>

    <!-- MCP / Remote -->
    <v-card v-for="tr in ['mcp', 'remote'] as Transport[]" :key="tr" rounded="lg" variant="tonal">
      <v-card-title class="d-flex align-center flex-wrap ga-2 pt-4">
        <span>{{ tr === 'mcp' ? 'MCP' : 'Remote (JSON-RPC)' }}</span>
        <v-chip v-if="status" class="agent-chip" :color="statusColor(status[tr])" variant="tonal">
          {{ statusText(status[tr]) }}
        </v-chip>
      </v-card-title>
      <v-card-subtitle class="agent-wrap">
        {{
          tr === 'mcp'
            ? t('agent.mcp_desc', '供 Claude Code 等 MCP 客户端接入（Streamable HTTP）')
            : t('agent.remote_desc', '供自己写的脚本调用：POST /rpc，方法名与 MCP 工具相同')
        }}
      </v-card-subtitle>
      <v-card-text class="d-flex flex-column ga-3">
        <div class="d-flex align-center flex-wrap ga-4">
          <v-switch
            :model-value="!!agentCfg[tr]?.enabled"
            :label="t('agent.enable', '在设置中开启（每次启动都生效）')"
            color="primary"
            hide-details
            @update:model-value="(v) => setEnabled(tr, v)"
          />
          <v-text-field
            v-model="ports[tr]"
            :label="t('agent.port', '端口')"
            class="agent-port"
            variant="outlined"
            hide-details
            @blur="savePort(tr)"
            @keydown.enter="savePort(tr)"
          />
        </div>
        <div v-if="status?.[tr].url" class="text-body-2">
          <code>{{ status[tr].url }}</code>
        </div>
        <div class="text-body-2 text-medium-emphasis">
          {{
            tt(
              'agent.flag_hint',
              { flag: tr === 'mcp' ? '--with-mcp' : '--with-remote' },
              `也可以只对本次运行开启：pnpm dev -- ${tr === 'mcp' ? '--with-mcp' : '--with-remote'}`
            )
          }}
        </div>
      </v-card-text>
      <v-card-actions class="px-4 pb-4 pt-0 ga-2 flex-wrap">
        <v-btn
          v-if="tr === 'mcp'"
          class="text-none"
          variant="tonal"
          prepend-icon="mdi-content-copy"
          @click="copyMcpCommand"
        >
          {{ t('agent.copy_mcp', '复制 Claude Code 接入命令') }}
        </v-btn>
        <v-btn
          v-else
          class="text-none"
          variant="tonal"
          prepend-icon="mdi-content-copy"
          @click="copyRemoteExample"
        >
          {{ t('agent.copy_curl', '复制 curl 示例') }}
        </v-btn>
      </v-card-actions>
    </v-card>

    <!-- Token -->
    <v-card rounded="lg" variant="tonal">
      <v-card-title class="pt-4">{{ t('agent.token_title', '访问令牌') }}</v-card-title>
      <v-card-subtitle class="agent-wrap">
        {{
          t(
            'agent.token_desc',
            '保存在 ~/.config/LinuxCockpit/agent/token（仅本人可读）。泄露后请立即重新生成。'
          )
        }}
      </v-card-subtitle>
      <v-card-text>
        <code class="agent-token">{{ maskedToken }}</code>
      </v-card-text>
      <v-card-actions class="px-4 pb-4 pt-0 ga-2 flex-wrap">
        <v-btn
          class="text-none"
          variant="text"
          :prepend-icon="showToken ? 'mdi-eye-off-outline' : 'mdi-eye-outline'"
          @click="showToken = !showToken"
        >
          {{ showToken ? t('agent.hide', '隐藏') : t('agent.show', '显示') }}
        </v-btn>
        <v-btn
          class="text-none"
          variant="text"
          prepend-icon="mdi-content-copy"
          @click="copy(token, t('agent.copied_token', '已复制令牌'))"
        >
          {{ t('agent.copy', '复制') }}
        </v-btn>
        <v-spacer />
        <v-btn
          class="text-none"
          variant="tonal"
          color="warning"
          prepend-icon="mdi-refresh"
          @click="confirmRegen = true"
        >
          {{ t('agent.regenerate', '重新生成') }}
        </v-btn>
      </v-card-actions>
    </v-card>

    <!-- AI 指示（标题栏图标条 / 描边） -->
    <v-card rounded="lg" variant="tonal">
      <v-card-title class="pt-4">{{ t('agent.ui_title', 'AI 指示') }}</v-card-title>
      <v-card-subtitle class="agent-wrap">
        {{
          t(
            'agent.ui_desc',
            'AI 操作时界面如何提示：标题栏图标条、全窗口描边、悬停信息。这些设置 AI 自己改不了。'
          )
        }}
      </v-card-subtitle>
      <v-card-text class="d-flex flex-column ga-6 pt-4 pb-6">
        <div class="agent-grid agent-grid--switches">
          <v-switch
            :model-value="ui.isolateView"
            :label="t('agent.ui_isolate', 'AI 在独立视图里操作（不动我的窗口）')"
            color="primary"
            hide-details
            @update:model-value="(v) => setUi('isolateView', !!v)"
          />
          <v-switch
            :model-value="ui.showBar"
            :label="t('agent.ui_show_bar', '标题栏显示 AI 图标条')"
            color="primary"
            hide-details
            @update:model-value="(v) => setUi('showBar', !!v)"
          />
          <v-switch
            :model-value="ui.outline"
            :label="t('agent.ui_outline', 'AI 操作时描边整个窗口')"
            color="primary"
            hide-details
            @update:model-value="(v) => setUi('outline', !!v)"
          />
          <v-switch
            :model-value="ui.presence"
            :label="t('agent.ui_presence', 'YAYA 运行时显示悬浮窗（可暂停 / 停止）')"
            color="primary"
            hide-details
            @update:model-value="(v) => setUi('presence', !!v)"
          />
          <v-switch
            :model-value="ui.tooltipDetail"
            :label="t('agent.ui_tooltip', '悬停显示页面 / 状态 / 最近操作')"
            color="primary"
            hide-details
            @update:model-value="(v) => setUi('tooltipDetail', !!v)"
          />
          <v-switch
            :model-value="ui.allowAvatar"
            :label="t('agent.ui_avatar', '接受 AI 自带的头像')"
            color="primary"
            hide-details
            @update:model-value="(v) => setUi('allowAvatar', !!v)"
          />
        </div>
        <div class="agent-grid agent-grid--fields">
          <v-text-field
            v-model="uiNums.busyTimeoutSec"
            :label="t('agent.ui_busy', 'Agent 过期时间')"
            :hint="t('agent.ui_busy_hint', '距上次调用多久内算正在操作，描边也按它渐隐')"
            persistent-hint
            suffix="s"
            type="number"
            variant="outlined"
            class="agent-field"
            @blur="saveUiNum('busyTimeoutSec')"
            @keydown.enter="saveUiNum('busyTimeoutSec')"
          />
          <v-text-field
            v-model="uiNums.statusTtlSec"
            :label="t('agent.ui_status_ttl', '状态文字有效期')"
            :hint="t('agent.ui_status_ttl_hint', 'AI 用 set_status 写的「在忙什么」多久后消失')"
            persistent-hint
            suffix="s"
            type="number"
            variant="outlined"
            class="agent-field"
            @blur="saveUiNum('statusTtlSec')"
            @keydown.enter="saveUiNum('statusTtlSec')"
          />
          <v-text-field
            v-model="uiNums.hideIdleAfterMin"
            :label="t('agent.ui_hide_idle', '空闲后隐藏图标')"
            :hint="t('agent.ui_hide_idle_hint', '空闲超过多久从图标条消失；0 = 不隐藏')"
            persistent-hint
            suffix="min"
            type="number"
            variant="outlined"
            class="agent-field"
            @blur="saveUiNum('hideIdleAfterMin')"
            @keydown.enter="saveUiNum('hideIdleAfterMin')"
          />
          <v-text-field
            v-model="uiNums.kickIdleAfterMin"
            :label="t('agent.ui_kick_idle', '无响应后断开会话')"
            :hint="
              t(
                'agent.ui_kick_idle_hint',
                '超过多久没有任何调用就直接踢掉（清理已死的会话）；0 = 一直保留'
              )
            "
            persistent-hint
            suffix="min"
            type="number"
            variant="outlined"
            class="agent-field"
            @blur="saveUiNum('kickIdleAfterMin')"
            @keydown.enter="saveUiNum('kickIdleAfterMin')"
          />
        </div>
        <v-select
          :model-value="ui.followMode"
          :label="t('agent.ui_follow_mode', '点头像跟随 AI 时')"
          :items="[
            {
              title: t('agent.ui_follow_inplace', '在主窗口里跟随（返回按钮回到我的界面）'),
              value: 'inplace'
            },
            { title: t('agent.ui_follow_window', '打开单独的窗口'), value: 'window' }
          ]"
          variant="outlined"
          hide-details
          class="agent-select"
          @update:model-value="(v) => setUi('followMode', v)"
        />
        <v-select
          :model-value="ui.screenshotMode"
          :label="t('agent.ui_screenshot_mode', 'AI 截图方式')"
          :hint="
            t(
              'agent.ui_screenshot_hint',
              '自动：先用不闪的方式，窗口被遮挡导致失败时再换稳妥的方式（那一下透明窗口可能闪一下）'
            )
          "
          persistent-hint
          :items="[
            { title: t('agent.ui_screenshot_auto', '自动（推荐）'), value: 'auto' },
            {
              title: t('agent.ui_screenshot_capture', '拷贝画面（不闪，窗口被遮挡时可能失败）'),
              value: 'capture'
            },
            {
              title: t('agent.ui_screenshot_cdp', '重新渲染（稳，透明窗口可能闪一下）'),
              value: 'cdp'
            }
          ]"
          variant="outlined"
          class="agent-select"
          @update:model-value="(v) => setUi('screenshotMode', v)"
        />
        <v-select
          :model-value="ui.defaultIcon"
          :label="t('agent.ui_default_icon', '没有头像时')"
          :items="[
            { title: t('agent.ui_icon_animal', '随机动物图标'), value: 'icon' },
            { title: t('agent.ui_icon_initial', '名字首字母'), value: 'initial' }
          ]"
          variant="outlined"
          hide-details
          class="agent-select"
          @update:model-value="(v) => setUi('defaultIcon', v)"
        />
      </v-card-text>
    </v-card>

    <!-- 独占（A2）/ AI 脚本（B2）：子组件只管自己的表单，写盘统一走 patchAgent -->
    <AgentExclusiveSettings :cfg="agentCfg" @patch="patchAgent" />
    <AgentScriptSettings :cfg="agentCfg" @patch="patchAgent" />

    <!-- Sessions -->
    <v-card rounded="lg" variant="tonal">
      <v-card-title class="pt-4">{{
        t('agent.sessions_title', '已连接的 AI / 脚本')
      }}</v-card-title>
      <v-card-text class="d-flex flex-column ga-2">
        <div v-if="!sessions.length" class="text-body-2 text-medium-emphasis">
          {{ t('agent.no_sessions', '暂无连接') }}
        </div>
        <div v-for="s in sessions" :key="s.id" class="agent-session">
          <div class="min-w-0">
            <div class="text-body-1">
              {{ s.client }} <span class="text-medium-emphasis">· {{ s.transport }}</span>
            </div>
            <div class="text-body-2 text-medium-emphasis">
              {{
                tt(
                  'agent.session_meta',
                  { since: timeOf(s.startedAt), last: timeOf(s.lastSeen), calls: String(s.calls) },
                  `${timeOf(s.startedAt)} 起 · 最近 ${timeOf(s.lastSeen)} · ${s.calls} 次调用`
                )
              }}
            </div>
          </div>
          <v-btn
            class="text-none"
            variant="tonal"
            prepend-icon="mdi-link-off"
            @click="disconnect(s.id)"
          >
            {{ t('agent.disconnect', '断开') }}
          </v-btn>
        </div>
        <div v-if="runGrants.length" class="d-flex align-center flex-wrap ga-2 pt-2">
          <span class="text-body-2">{{ t('agent.run_grants', '关闭 Cockpit 前都允许：') }}</span>
          <v-chip v-for="g in runGrants" :key="g" class="agent-chip" variant="tonal">{{
            g
          }}</v-chip>
          <v-btn class="text-none" variant="text" color="warning" @click="revokeGrants">
            {{ t('agent.revoke_all', '全部撤销') }}
          </v-btn>
        </div>
      </v-card-text>
    </v-card>

    <!-- Privacy policy -->
    <v-card rounded="lg" variant="tonal">
      <v-card-title class="pt-4">{{ t('agent.policy_title', '隐私策略') }}</v-card-title>
      <v-card-text class="d-flex flex-column ga-4">
        <v-select
          :model-value="personal"
          :items="[
            { title: t('agent.allow', '允许'), value: 'allow' },
            { title: t('agent.ask', '每次询问'), value: 'ask' }
          ]"
          :label="
            t('agent.policy_personal', '个人数据（B 站 uid、听歌记录、日志等，不能关联到真人）')
          "
          variant="outlined"
          hide-details
          @update:model-value="(v) => setPolicy('personal', v)"
        />
        <v-select
          :model-value="control"
          :items="[
            { title: t('agent.allow', '允许'), value: 'allow' },
            { title: t('agent.ask', '每次询问'), value: 'ask' }
          ]"
          :label="
            t('agent.policy_control', '修改系统状态（启停服务 / 容器、切换壁纸、开机自启等）')
          "
          variant="outlined"
          hide-details
          @update:model-value="(v) => setPolicy('control', v)"
        />
        <div class="text-body-2 text-medium-emphasis">
          {{
            t(
              'agent.policy_note',
              '敏感数据（学号、余额、位置等）始终需要你在授权窗口里同意；密码、API Key 等凭据永远不会给 AI。'
            )
          }}
        </div>
      </v-card-text>
    </v-card>

    <v-dialog v-model="confirmRegen" max-width="440">
      <v-card rounded="lg">
        <v-card-title class="pt-5 px-6">{{
          t('agent.regen_title', '重新生成访问令牌？')
        }}</v-card-title>
        <v-card-text class="px-6">
          {{
            t(
              'agent.regen_body',
              '旧令牌立即失效，已连接的 AI / 脚本会被断开，需要用新令牌重新接入。'
            )
          }}
        </v-card-text>
        <v-card-actions class="px-6 pb-5 ga-2">
          <v-spacer />
          <v-btn class="text-none" variant="text" @click="confirmRegen = false">{{
            t('agent.cancel', '取消')
          }}</v-btn>
          <v-btn class="text-none" variant="flat" color="warning" @click="regenerate">
            {{ t('agent.regenerate', '重新生成') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="toast.show" :timeout="2400">{{ toast.text }}</v-snackbar>
  </div>
</template>

<style scoped>
.agent-chip {
  padding-block: 4px;
  min-height: 24px;
}
.agent-grid {
  display: grid;
  gap: 8px 32px;
}
.agent-grid--switches {
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
}
/* 输入框下面有常驻提示，行距要比开关大，否则提示贴着下一行的标签 */
.agent-grid--fields {
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 24px 20px;
}
.agent-field {
  min-width: 0;
}
.agent-select {
  max-width: 360px;
}
.agent-port {
  max-width: 160px;
}
.agent-wrap {
  white-space: normal;
}
.agent-token {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  word-break: break-all;
}
.agent-session {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
}

/* Narrow screens (≤720px): capped columns / rows have no room to shrink inside
   a phone-width settings page — let them fill the width and wrap. */
@media (max-width: 720px) {
  .agent-select {
    flex: 1 1 auto;
    min-width: 0;
    max-width: 100%;
  }

  .agent-port {
    max-width: 100%;
  }

  .agent-session {
    flex-wrap: wrap;
  }
}
</style>

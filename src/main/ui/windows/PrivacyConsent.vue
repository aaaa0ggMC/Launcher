<script setup lang="ts">
/**
 * 隐私授权窗口（framework child window, view = PrivacyConsent）。
 *
 * 安全约束（docs/agent-access-design.md §5.4）：
 *  - 窗口 id / view 由主进程保留，渲染端无法创建或替换；决定只经 `privacy:decide`，
 *    主进程校验 sender 必须是本窗口。
 *  - 展示与防误触逻辑在 `PrivacyConsentPanel.vue`（与无头网页的授权悬浮窗共用）。
 */
defineOptions({ name: 'cockpit-privacy-consent' })

import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useTheme } from 'vuetify'
import { resolveSchemeId } from '@ui/color_schemes'
import { applyUiScale, applyFont } from '@ui/appearance'
import PrivacyConsentPanel, {
  type ConsentDecision,
  type RequestView
} from '../components/PrivacyConsentPanel.vue'

const uiLang = ref('zh')
const theme = useTheme()
const requests = ref<RequestView[]>([])

async function decide(req: RequestView, decision: ConsentDecision): Promise<void> {
  await window.cockpit.privacyDecide(req.id, decision)
  requests.value = requests.value.filter((r) => r.id !== req.id)
}
async function denyAll(): Promise<void> {
  await window.cockpit.privacyDenyAll()
  requests.value = []
}

interface AppearanceConfig {
  language?: string
  theme?: string
  uiScale?: unknown
  font?: unknown
}

/** 独立渲染进程：语言 / 主题 / UI 缩放 / 字体都要自己从配置应用，并跟随设置变化。 */
function applyConfig(cfg: AppearanceConfig | null): void {
  if (cfg?.language) uiLang.value = cfg.language
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  theme.global.name.value = resolveSchemeId(cfg?.theme, dark)
  applyUiScale(cfg?.uiScale)
  applyFont(cfg?.font)
}

let off: (() => void) | undefined
let offConfig: (() => void) | undefined
onMounted(async () => {
  try {
    applyConfig((await window.cockpit.getConfig()) as AppearanceConfig | null)
  } catch {
    /* defaults are fine */
  }
  offConfig = window.cockpit.on('cockpit:config-changed', (cfg) =>
    applyConfig(cfg as AppearanceConfig | null)
  )
  off = window.cockpit.on('privacy:pending', (list) => {
    requests.value = (list as RequestView[]) ?? []
  })
  requests.value = ((await window.cockpit.privacyPending()) as RequestView[]) ?? []
})
onBeforeUnmount(() => {
  off?.()
  offConfig?.()
})
</script>

<template>
  <v-app class="consent-app">
    <div class="consent-shell">
      <PrivacyConsentPanel
        :requests="requests"
        :lang="uiLang"
        :decide="decide"
        :deny-all="denyAll"
      />
    </div>
  </v-app>
</template>

<style scoped>
.consent-app {
  background: rgb(var(--v-theme-surface));
}
.consent-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  padding: 24px;
}
</style>

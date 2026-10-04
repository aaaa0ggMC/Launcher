<script setup lang="ts">
import { inject, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import PrivacyConsentPanel, {
  type ConsentDecision,
  type RequestView
} from './PrivacyConsentPanel.vue'

/**
 * 无头网页的隐私授权（外壳悬浮窗 `shell.privacy-consent`，模态，Outsider SDK）。
 * Electron 用独立窗口；网页里只能和页面同处一个 DOM，所以：
 *  - 整个悬浮层是 AI 禁区（页面桥拒绝操作、快照 / 截图看不到内容）；
 *  - 「允许」只认真实手势（`isTrusted`）——页面桥注入的是合成事件，点不动它；
 *  - 提交带宿主随请求下发的一次性 nonce（只经 SSE 推给页面），由 web-shim 附上。
 * 拒绝是安全方向，不校验手势。
 */
const lang = inject<Ref<string>>('cockpit:lang', ref('zh'))
const requests = ref<RequestView[]>([])

async function decide(req: RequestView, decision: ConsentDecision, ev: Event): Promise<void> {
  if (decision !== 'deny' && !ev.isTrusted) return
  await window.cockpit.privacyDecide(req.id, decision)
  requests.value = requests.value.filter((r) => r.id !== req.id)
}
async function denyAll(): Promise<void> {
  await window.cockpit.privacyDenyAll()
  requests.value = []
}

let off: (() => void) | undefined
onMounted(async () => {
  off = window.cockpit.on('privacy:pending', (list) => {
    requests.value = (list as RequestView[]) ?? []
  })
  requests.value = ((await window.cockpit.privacyPending()) as RequestView[]) ?? []
})
onBeforeUnmount(() => off?.())
</script>

<template>
  <v-card class="consent-popup" rounded="xl" elevation="12">
    <PrivacyConsentPanel :requests="requests" :lang="lang" :decide="decide" :deny-all="denyAll" />
  </v-card>
</template>

<style scoped>
.consent-popup {
  display: flex;
  flex-direction: column;
  width: 560px;
  max-width: 100%;
  padding: 24px;
}
@media (max-width: 720px) {
  .consent-popup {
    padding: 20px 16px;
  }
}
</style>

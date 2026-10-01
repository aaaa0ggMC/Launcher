import type { Directive, InjectionKey, Ref } from 'vue'

/**
 * 渲染端隐私 SDK —— 与主进程 `src/main/process/privacy.ts` 配套（docs/agent-access-design.md §3.6）。
 *
 * 只做「打标签」，**不改变用户看到的内容**：
 *   <div v-privacy="'campusinfo.identity'">…</div>   子树属于该 scope
 *   <section v-agent-forbidden>…</section>          AI 不能读、不能点、不可申请
 *   <PrivacyText scope="campusinfo.identity" :value="sid" />   打码文本（点击切换）
 *
 * inspector（P1）读取这些 data 属性：快照里替换成占位符、截图时遮盖、点击前要求许可。
 */

export const PRIVACY_ATTR = 'data-privacy'
export const AGENT_ATTR = 'data-agent'

function applyScope(el: HTMLElement, scope: unknown): void {
  if (typeof scope === 'string' && scope) el.setAttribute(PRIVACY_ATTR, scope)
  else el.removeAttribute(PRIVACY_ATTR)
}

/** `v-privacy="'<ability>.<scope>'"` —— 值为空 / false 时移除标签（便于条件保护）。 */
export const vPrivacy: Directive<HTMLElement, string | null | undefined | false> = {
  mounted: (el, binding) => applyScope(el, binding.value),
  updated: (el, binding) => applyScope(el, binding.value)
}

export const PRIVACY_ACTION_ATTR = 'data-privacy-action'

/**
 * `v-privacy-action="'a.scope,b.scope'"` —— 会**揭示**隐私的操作（如「全部显示」）。
 * 按钮文字本身不敏感，不脱敏；但 AI 点击前必须持有这些 scope 的许可（inspector 里 guard）。
 * 明文出现在用户屏幕上本身就是一种暴露（屏幕共享、旁人），不能由 AI 自行决定。
 */
export const vPrivacyAction: Directive<HTMLElement, string | null | undefined | false> = {
  mounted: (el, binding) => applyAttr(el, PRIVACY_ACTION_ATTR, binding.value),
  updated: (el, binding) => applyAttr(el, PRIVACY_ACTION_ATTR, binding.value)
}

function applyAttr(el: HTMLElement, attr: string, v: unknown): void {
  if (typeof v === 'string' && v) el.setAttribute(attr, v)
  else el.removeAttribute(attr)
}

/** `v-agent-forbidden` —— 禁区：授权相关设置、token 显示等。 */
export const vAgentForbidden: Directive<HTMLElement, boolean | undefined> = {
  mounted: (el, binding) => {
    if (binding.value !== false) el.setAttribute(AGENT_ATTR, 'forbidden')
  },
  updated: (el, binding) => {
    if (binding.value !== false) el.setAttribute(AGENT_ATTR, 'forbidden')
    else el.removeAttribute(AGENT_ATTR)
  }
}

/**
 * 页面级「全部显示」开关（用户自己的视图偏好，不影响 AI 看到的内容）。
 * 由页面 provide，PrivacyText inject；和每个实例自己点开的状态取并集。
 */
export const PRIVACY_REVEAL_ALL: InjectionKey<Ref<boolean>> = Symbol('cockpit:privacy-revealAll')

/** 打码长度固定 6..8 个 `•`，不泄露原文长度。 */
export function maskText(raw: string): string {
  return '•'.repeat(Math.min(8, Math.max(6, raw.length)))
}

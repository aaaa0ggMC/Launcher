<script setup lang="ts">
import { computed, ref, inject, onMounted, onBeforeUnmount, type Ref } from 'vue'
import { translate, translateTemplate } from '../../../main/ui/i18n'
import { getAbilityModules, setAbilityEnabled } from '../../../main/ui/ability-registry'
import { outsiderPolicy, type OutsiderPolicy } from '../../../main/ui/outsider'

defineOptions({ name: 'cockpit-settings-abilities' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
const tt = (key: string, vars: Record<string, string>, fallback?: string): string =>
  translateTemplate(uiLang.value, key, vars, fallback)

const modules = getAbilityModules()
const ids = Object.keys(modules).sort()
const disabled = ref<string[]>([])
const snackText = ref('')
const snackColor = ref('success')
const snackOpen = ref(false)

let unsub: (() => void) | null = null

// ---- 悬浮窗权限（Outsider SDK，config.json `outsider`；agent 改不了） ----
/** 声明了悬浮窗的能力 → 悬浮窗显示名 */
const outsiderLabels = computed(() => {
  const map: Record<string, string[]> = {}
  for (const id of ids) {
    const list = modules[id]?.outsiders ?? []
    if (list.length) map[id] = list.map((o) => t(`label.${o.label}`, o.label))
  }
  return map
})
const hasAnyOutsider = computed(() => Object.keys(outsiderLabels.value).length > 0)
const expanded = ref<string | null>(null)
function toggleExpand(id: string): void {
  expanded.value = expanded.value === id ? null : id
}
function outsiderAllowed(id: string): boolean {
  return outsiderPolicy.value.enabled && !outsiderPolicy.value.blocked.includes(id)
}
async function savePolicy(next: OutsiderPolicy): Promise<void> {
  await window.cockpit.setConfig({ outsider: { enabled: next.enabled, blocked: next.blocked } })
}
function setOutsidersEnabled(enabled: boolean): void {
  void savePolicy({ ...outsiderPolicy.value, enabled })
}
function setOutsiderAllowed(id: string, allowed: boolean): void {
  const rest = outsiderPolicy.value.blocked.filter((x) => x !== id)
  void savePolicy({ ...outsiderPolicy.value, blocked: allowed ? rest : [...rest, id] })
}

async function refresh(): Promise<void> {
  try {
    const r = (await window.cockpit.command('ability.list')) as {
      ok?: boolean
      disabled?: string[]
    } | null
    if (r?.ok && Array.isArray(r.disabled)) disabled.value = r.disabled.map(String)
  } catch {
    /* noop */
  }
}

async function toggle(id: string, enabled: boolean): Promise<void> {
  const ok = await setAbilityEnabled(id, enabled)
  if (ok) {
    if (enabled) {
      disabled.value = disabled.value.filter((x) => x !== id)
    } else {
      disabled.value = [...disabled.value, id]
    }
    snackText.value = enabled
      ? tt('settings.ability.enabled', { name: name(id) }, `${name(id)} 已启用`)
      : tt(
          'settings.ability.disabled',
          { name: name(id) },
          `${name(id)} 已禁用（侧边栏与命令即时隐藏）`
        )
    snackColor.value = 'success'
  } else {
    snackText.value = tt(
      'settings.ability.disabledProtected',
      { name: name(id) },
      `${name(id)} 无法禁用（受保护）`
    )
    snackColor.value = 'warning'
  }
  snackOpen.value = true
}

function name(id: string): string {
  return t(`ability.${id}.name`, modules[id]?.name ?? id)
}

onMounted(async () => {
  await refresh()
  if (window.cockpit?.on) {
    unsub = window.cockpit.on('cockpit:abilities-changed', (event: unknown) => {
      const ev = event as Record<string, unknown>
      if (Array.isArray(ev.disabled)) {
        disabled.value = (ev.disabled as unknown[]).map(String)
      }
    })
  }
})

onBeforeUnmount(() => {
  unsub?.()
  unsub = null
})

/** Deep export: currently disabled abilities. */
defineExpose({
  toMarkdown: (): string => {
    const list = disabled.value
    if (!list.length)
      return `${t('settings.ability.title', '能力开关')}: ${t('settings.none', '无')}`
    return `${t('settings.ability.title', '能力开关')}:\n  ${list.map((id) => `- ${name(id)}`).join('\n  ')}`
  }
})
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title>
      <v-icon start>mdi-puzzle-outline</v-icon>
      {{ t('settings.ability.title', '能力开关') }}
    </v-card-title>
    <v-card-text class="text-caption text-medium-emphasis">
      {{
        t(
          'settings.ability.description',
          '运行时启用/禁用能力（仅当前会话，不持久化）。禁用后该能力的侧边栏入口与命令即时隐藏。'
        )
      }}
    </v-card-text>
    <v-divider />
    <div v-agent-forbidden class="outsider-master px-4 py-3">
      <v-icon icon="mdi-picture-in-picture-top-right-outline" class="mt-1" />
      <div class="flex-grow-1 min-w-0">
        <div class="text-body-2">{{ t('settings.outsider.title', '允许能力弹出悬浮窗') }}</div>
        <div class="text-caption text-medium-emphasis">
          {{
            t(
              'settings.outsider.description',
              '关闭后所有能力都不能弹出悬浮窗；也可以展开下面某个能力单独禁止。YAYA 的「AI 在场」悬浮窗与授权弹窗不受影响。'
            )
          }}
        </div>
      </div>
      <v-switch
        :model-value="outsiderPolicy.enabled"
        color="primary"
        hide-details
        density="compact"
        :aria-label="t('settings.outsider.title', '允许能力弹出悬浮窗')"
        @update:model-value="setOutsidersEnabled(!!$event)"
      />
    </div>
    <v-divider />
    <v-card-text class="d-flex flex-column ga-1 py-2">
      <template v-for="id in ids" :key="id">
        <div
          class="d-flex align-center ga-3 px-2 py-1"
          :class="{ 'is-disabled': disabled.includes(id) }"
        >
          <v-icon
            size="18"
            :icon="disabled.includes(id) ? 'mdi-puzzle-off-outline' : 'mdi-puzzle'"
          />
          <span class="text-body-2 flex-grow-1 min-w-0 text-truncate">{{ name(id) }}</span>
          <v-btn
            v-if="outsiderLabels[id]"
            size="small"
            variant="text"
            :icon="
              outsiderAllowed(id)
                ? 'mdi-picture-in-picture-top-right-outline'
                : 'mdi-picture-in-picture-top-right'
            "
            :color="outsiderAllowed(id) ? undefined : 'warning'"
            :title="t('settings.outsider.perms', '悬浮窗权限')"
            :aria-label="t('settings.outsider.perms', '悬浮窗权限')"
            :aria-expanded="expanded === id"
            @click="toggleExpand(id)"
          />
          <span class="text-caption text-medium-emphasis text-truncate ability-id">{{ id }}</span>
          <v-switch
            :model-value="!disabled.includes(id)"
            color="primary"
            hide-details
            density="compact"
            @update:model-value="toggle(id, $event as boolean)"
          />
        </div>
        <v-expand-transition>
          <div v-if="expanded === id && outsiderLabels[id]" v-agent-forbidden class="ability-perms">
            <div class="d-flex align-center ga-3">
              <div class="flex-grow-1 min-w-0">
                <div class="text-body-2">
                  {{ t('settings.outsider.allow', '允许弹出悬浮窗') }}
                </div>
                <div class="text-caption text-medium-emphasis">
                  {{
                    outsiderPolicy.enabled
                      ? t('settings.outsider.declared', '声明的悬浮窗：') +
                        outsiderLabels[id].join('、')
                      : t('settings.outsider.master_off', '已在上方关闭全部能力悬浮窗')
                  }}
                </div>
              </div>
              <v-switch
                :model-value="!outsiderPolicy.blocked.includes(id)"
                :disabled="!outsiderPolicy.enabled"
                color="primary"
                hide-details
                density="compact"
                :aria-label="t('settings.outsider.allow', '允许弹出悬浮窗')"
                @update:model-value="setOutsiderAllowed(id, !!$event)"
              />
            </div>
          </div>
        </v-expand-transition>
      </template>
      <div v-if="!hasAnyOutsider" class="text-caption text-medium-emphasis px-2 pt-2">
        {{ t('settings.outsider.none', '目前没有能力声明悬浮窗。') }}
      </div>
    </v-card-text>
    <v-snackbar v-model="snackOpen" :color="snackColor" location="top" timeout="2200">
      {{ snackText }}
    </v-snackbar>
  </v-card>
</template>

<style scoped>
.is-disabled {
  opacity: 0.55;
}
.ability-id {
  max-width: 200px;
}
.outsider-master {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.ability-perms {
  margin: 0 8px 6px 38px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(var(--v-theme-on-surface), 0.05);
}
@media (max-width: 720px) {
  .ability-id {
    display: none;
  }
  .ability-perms {
    margin-left: 8px;
  }
}
</style>

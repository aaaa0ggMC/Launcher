<script setup lang="ts">
import { ref, inject, onMounted, onBeforeUnmount, type Ref } from 'vue'
import { translate, translateTemplate } from '../../../main/ui/i18n'
import { getAbilityModules, setAbilityEnabled } from '../../../main/ui/ability-registry'

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
    <v-card-text class="d-flex flex-column ga-1 py-2">
      <div
        v-for="id in ids"
        :key="id"
        class="d-flex align-center ga-3 px-2 py-1"
        :class="{ 'is-disabled': disabled.includes(id) }"
      >
        <v-icon size="18" :icon="disabled.includes(id) ? 'mdi-puzzle-off-outline' : 'mdi-puzzle'" />
        <span class="text-body-2 flex-grow-1">{{ name(id) }}</span>
        <span class="text-caption text-medium-emphasis text-truncate ability-id">{{ id }}</span>
        <v-switch
          :model-value="!disabled.includes(id)"
          color="primary"
          hide-details
          density="compact"
          @update:model-value="toggle(id, $event as boolean)"
        />
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
</style>

<script setup lang="ts">
/**
 * 从 GitHub 链接导入 Skill：宿主（yaya.skills-import-github）负责下载，这里只收链接；
 * 链接下有多个 Skill 时宿主返回候选路径，选一个再带 `path` 调一次。
 */
import { useI18n } from '@ui/i18n'
import { inject, ref, watch } from 'vue'
import type { Ref } from 'vue'

defineOptions({ name: 'cockpit-yaya-skills-github-dialog' })

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'imported', name: string): void
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

const url = ref<string | null>('')
const overwrite = ref(false)
const busy = ref(false)
const error = ref('')
/** 多个 Skill 时的候选（仓库内路径）与选中项；链接一改就作废 */
const candidates = ref<string[]>([])
const pick = ref<string | null>(null)

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    error.value = ''
    candidates.value = []
    pick.value = null
  }
)
watch(url, () => {
  candidates.value = []
  pick.value = null
})

async function submit(): Promise<void> {
  const link = (url.value ?? '').trim()
  if (!link || busy.value) return
  if (candidates.value.length && !pick.value) return
  busy.value = true
  error.value = ''
  try {
    const args: Record<string, unknown> = { url: link, overwrite: overwrite.value }
    if (pick.value) args.path = pick.value
    const res = (await window.cockpit.command('yaya.skills-import-github', args)) as {
      ok: boolean
      name?: string
      id?: string
      candidates?: string[]
    }
    if (res.candidates?.length) {
      candidates.value = res.candidates
      pick.value = null
      return
    }
    if (!res.ok) return
    emit('imported', res.name ?? res.id ?? '')
    emit('update:modelValue', false)
    url.value = ''
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    width="560"
    scrollable
    @update:model-value="emit('update:modelValue', $event === true)"
  >
    <v-card class="pa-4 yaya-pop">
      <v-card-title class="px-0 pt-0 text-h6 d-flex align-center ga-2">
        <v-icon icon="mdi-github" color="primary" />
        <span>{{ t('yaya.settings.plugins.skills_gh_title', '从 GitHub 导入 Skill') }}</span>
      </v-card-title>
      <v-card-subtitle class="px-0 text-caption text-medium-emphasis gh-hint">
        {{
          t(
            'yaya.settings.plugins.skills_gh_hint',
            '支持仓库链接、tree / blob 子目录链接，或 raw 的 SKILL.md 链接。'
          )
        }}
      </v-card-subtitle>

      <v-card-text class="px-0 pb-0 pt-4">
        <v-text-field
          v-model="url"
          :label="t('yaya.settings.plugins.skills_gh_url', 'GitHub 链接')"
          placeholder="https://github.com/owner/repo/tree/main/skills/xxx"
          variant="outlined"
          prepend-inner-icon="mdi-link-variant"
          autofocus
          clearable
          hide-details="auto"
          :disabled="busy"
          @keydown.enter.prevent="submit"
        />
        <v-checkbox
          v-model="overwrite"
          :label="t('yaya.settings.plugins.skills_gh_overwrite', '覆盖同名 Skill')"
          color="primary"
          hide-details
          density="comfortable"
          class="mt-2"
        />

        <template v-if="candidates.length">
          <div class="text-body-2 mt-2 mb-1">
            {{
              te(
                'yaya.settings.plugins.skills_gh_pick',
                { n: String(candidates.length) },
                '这个链接下有 {n} 个 Skill，选一个导入：'
              )
            }}
          </div>
          <v-radio-group v-model="pick" hide-details class="cand-list">
            <v-radio v-for="c in candidates" :key="c" :value="c" color="primary">
              <template #label>
                <span class="cand-path">{{ c || '/' }}</span>
              </template>
            </v-radio>
          </v-radio-group>
        </template>

        <v-alert v-if="error" color="error" variant="tonal" density="compact" class="mt-3 gh-error">
          {{ error }}
        </v-alert>
      </v-card-text>

      <v-card-actions class="px-0 pb-0 pt-4 ga-2 justify-end">
        <v-btn variant="text" :disabled="busy" @click="emit('update:modelValue', false)">
          {{ t('yaya.settings.cancel', '取消') }}
        </v-btn>
        <v-btn
          color="primary"
          variant="elevated"
          prepend-icon="mdi-download"
          :loading="busy"
          :disabled="!url?.trim() || (candidates.length > 0 && !pick)"
          @click="submit"
        >
          {{ t('yaya.settings.plugins.skills_gh_submit', '导入') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.gh-hint {
  white-space: normal;
}
.cand-list {
  max-height: min(40vh, 320px);
  overflow-y: auto;
}
.cand-path {
  font-family: ui-monospace, monospace;
  font-size: 0.875rem;
  overflow-wrap: anywhere;
}
.gh-error {
  overflow-wrap: anywhere;
}
</style>

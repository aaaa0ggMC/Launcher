<script setup lang="ts">
import { useI18n } from '@ui/i18n'
import { computed, inject, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import type { PluginInfo } from '../../services/plugins/types'
import type { YayaConfig } from '../../types'
import { pluginFallbackIcon, setPluginEnabled } from './plugin-state'
import SkillsDirDialog from './SkillsDirDialog.vue'

defineOptions({ name: 'cockpit-yaya-settings-skills' })

const props = defineProps<{
  config: YayaConfig
  plugins: PluginInfo[]
  loading: boolean
}>()

const emit = defineEmits<{
  /** 导入 / 删除 / 重新扫描后让外壳重新拉取插件列表 */
  (e: 'changed'): void
  /** 点进行情详情 */
  (e: 'selectPlugin', pluginId: string): void
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

/** 系统文件管理器能打开宿主目录（Electron）；网页 / 安卓里目录在宿主机上，改用应用内浏览 */
const canOpenFolder = computed(() => window.cockpit.hasCap('folder.open'))
const dirDialog = ref(false)

const skillsPath = ref('')
const busy = ref<'import' | 'rescan' | null>(null)
const removingId = ref<string | null>(null)
const confirmRemoveId = ref<string | null>(null)
const notice = ref<{ text: string; error: boolean } | null>(null)

/** 提供 skill_load / skill_read_file 的枢纽插件 */
const hub = computed<PluginInfo | null>(() => props.plugins.find((p) => p.id === 'skills') ?? null)

/** 真正的 Skill 插件（枢纽本身不在列表里） */
const skills = computed<PluginInfo[]>(() =>
  props.plugins.filter((p) => p.kind === 'skill' && p.id !== 'skills')
)

async function loadDir(): Promise<void> {
  try {
    const res = (await window.cockpit.command('yaya.skills-dir')) as { path?: string }
    skillsPath.value = res?.path ?? ''
  } catch (err) {
    console.warn('Failed to load Yaya skills dir', err)
  }
}

onMounted(() => {
  void loadDir()
})

async function openDir(): Promise<void> {
  if (!skillsPath.value) await loadDir()
  if (!skillsPath.value) return
  if (!canOpenFolder.value) {
    dirDialog.value = true
    return
  }
  try {
    const err = await window.cockpit.openPath(skillsPath.value)
    if (!err) return
    notice.value = {
      text: te('yaya.settings.plugins.skills_open_failed', { msg: err }, '无法打开目录：{msg}'),
      error: true
    }
  } catch (err) {
    notice.value = {
      text: te(
        'yaya.settings.plugins.skills_open_failed',
        { msg: String(err) },
        '无法打开目录：{msg}'
      ),
      error: true
    }
  }
  // 打不开（没装文件管理器等）：退回应用内浏览，至少能看到路径
  dirDialog.value = true
}

async function importSkill(): Promise<void> {
  busy.value = 'import'
  notice.value = null
  try {
    const path = await window.cockpit.pickFile({
      title: t('yaya.settings.plugins.skills_pick_title', '选择 Skill 目录'),
      directory: true
    })
    if (!path) return
    const res = (await window.cockpit.command('yaya.skills-import', { path })) as {
      ok: boolean
      id?: string
      name?: string
      error?: string
    }
    if (!res.ok) {
      notice.value = {
        text: te(
          'yaya.settings.plugins.skills_import_failed',
          { msg: res.error ?? 'unknown' },
          '导入失败：{msg}'
        ),
        error: true
      }
      return
    }
    notice.value = {
      text: te(
        'yaya.settings.plugins.skills_imported',
        { name: res.name ?? res.id ?? '' },
        '已导入 Skill：{name}'
      ),
      error: false
    }
    emit('changed')
  } catch (err) {
    notice.value = {
      text: te(
        'yaya.settings.plugins.skills_import_failed',
        { msg: String(err) },
        '导入失败：{msg}'
      ),
      error: true
    }
  } finally {
    busy.value = null
  }
}

async function rescan(): Promise<void> {
  busy.value = 'rescan'
  notice.value = null
  try {
    const res = (await window.cockpit.command('yaya.skills-rescan')) as
      number | { count?: number; ok?: boolean } | null
    const count = typeof res === 'number' ? res : (res?.count ?? skills.value.length)
    notice.value = {
      text: te(
        'yaya.settings.plugins.skills_rescanned',
        { n: String(count) },
        '已重新扫描，共 {n} 个 Skill'
      ),
      error: false
    }
    emit('changed')
  } catch (err) {
    notice.value = {
      text: te(
        'yaya.settings.plugins.skills_rescan_failed',
        { msg: String(err) },
        '重新扫描失败：{msg}'
      ),
      error: true
    }
  } finally {
    busy.value = null
  }
}

async function removeSkill(plugin: PluginInfo): Promise<void> {
  removingId.value = plugin.id
  confirmRemoveId.value = null
  try {
    await window.cockpit.command('yaya.skills-remove', { id: plugin.id })
    notice.value = {
      text: te(
        'yaya.settings.plugins.skills_removed',
        { name: plugin.label },
        '已移除 Skill：{name}'
      ),
      error: false
    }
    emit('changed')
  } catch (err) {
    notice.value = {
      text: te(
        'yaya.settings.plugins.skills_remove_failed',
        { msg: String(err) },
        '移除失败：{msg}'
      ),
      error: true
    }
  } finally {
    removingId.value = null
  }
}

function toggleHub(on: boolean): void {
  if (hub.value) setPluginEnabled(props.config, hub.value, on)
}

function toggleSkill(plugin: PluginInfo, on: boolean): void {
  setPluginEnabled(props.config, plugin, on)
}
</script>

<template>
  <div class="skills-panel d-flex flex-column ga-4">
    <!-- Skill 枢纽：提供 skill_load / skill_read_file -->
    <div v-if="hub" class="hub-row d-flex align-center ga-3 pa-3 rounded-lg border">
      <v-icon
        :icon="hub.icon || pluginFallbackIcon(hub)"
        color="primary"
        size="24"
        class="flex-shrink-0"
      />
      <div class="row-main">
        <div class="text-body-2 font-weight-medium">{{ hub.label }}</div>
        <div class="text-caption text-medium-emphasis hub-desc">{{ hub.description }}</div>
      </div>
      <v-switch
        :model-value="hub.enabled"
        color="primary"
        hide-details
        density="compact"
        class="flex-shrink-0"
        @update:model-value="toggleHub($event === true)"
      />
    </div>

    <!-- 目录操作 -->
    <div class="d-flex flex-wrap align-center ga-2">
      <v-btn variant="tonal" prepend-icon="mdi-folder-open-outline" @click="openDir">
        {{
          canOpenFolder
            ? t('yaya.settings.plugins.skills_open_dir', '打开目录')
            : t('yaya.settings.plugins.skills_browse_dir', '浏览目录')
        }}
      </v-btn>
      <v-btn
        variant="tonal"
        prepend-icon="mdi-import"
        :loading="busy === 'import'"
        @click="importSkill"
      >
        {{ t('yaya.settings.plugins.skills_import', '导入') }}
      </v-btn>
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="busy === 'rescan'" @click="rescan">
        {{ t('yaya.settings.plugins.skills_rescan', '重新扫描') }}
      </v-btn>
    </div>

    <v-alert
      v-if="notice"
      :color="notice.error ? 'error' : 'success'"
      variant="tonal"
      density="compact"
      closable
      @click:close="notice = null"
    >
      {{ notice.text }}
    </v-alert>

    <!--
      初次加载（一份 Skill 数据都没有）才整块替换；后台刷新时保留列表，
      只在顶部叠一条进度线，几何与滚动位置都不动。
    -->
    <div
      v-if="loading && skills.length === 0"
      class="d-flex flex-column align-center justify-center ga-2 py-6 text-medium-emphasis"
    >
      <v-progress-circular indeterminate color="primary" size="24" width="2" />
      <span class="text-body-2">
        {{ t('yaya.settings.plugins.loading', '正在加载插件列表…') }}
      </span>
    </div>
    <div
      v-else-if="skills.length === 0"
      class="d-flex flex-column align-center justify-center ga-2 py-6 text-medium-emphasis"
    >
      <v-icon icon="mdi-file-document-outline" size="32" />
      <span class="text-body-2">
        {{ t('yaya.settings.plugins.skills_empty', '尚未导入任何 Skill') }}
      </span>
      <span class="text-caption skills-empty-hint">
        {{
          t(
            'yaya.settings.plugins.skills_empty_hint',
            '每个 Skill 是一个目录，里面有 SKILL.md；frontmatter 需要 name 与 description 两个字段。'
          )
        }}
      </span>
    </div>
    <div v-else class="skill-rows d-flex flex-column ga-2">
      <div v-if="loading" class="refresh-line" aria-hidden="true">
        <v-progress-linear indeterminate color="primary" height="2" />
      </div>
      <div
        v-for="skill in skills"
        :key="skill.id"
        class="skill-row d-flex align-center ga-3 pa-3 rounded-lg border"
        role="button"
        :aria-label="skill.label"
        tabindex="0"
        @click="emit('selectPlugin', skill.id)"
        @keydown.enter.prevent="emit('selectPlugin', skill.id)"
        @keydown.space.prevent="emit('selectPlugin', skill.id)"
      >
        <v-icon
          :icon="skill.icon || pluginFallbackIcon(skill)"
          color="primary"
          size="24"
          class="flex-shrink-0"
        />
        <div class="row-main">
          <div class="d-flex align-center flex-wrap ga-2">
            <span class="font-weight-bold text-subtitle-2 skill-name">{{ skill.label }}</span>
            <v-chip variant="tonal" class="chip-pad flex-shrink-0">
              {{
                te(
                  'yaya.settings.plugins.tools_count',
                  { n: String(skill.tools.length) },
                  '{n} 个工具'
                )
              }}
            </v-chip>
          </div>
          <div class="text-caption text-medium-emphasis skill-desc">{{ skill.description }}</div>
        </div>
        <v-icon icon="mdi-chevron-right" class="row-chevron flex-shrink-0" />
        <!-- 开关单独一层：点击 / 按键都不触发行进详情 -->
        <div class="row-switch flex-shrink-0" @click.stop @keydown.stop>
          <v-switch
            :model-value="skill.enabled"
            color="primary"
            hide-details
            density="compact"
            @update:model-value="toggleSkill(skill, $event === true)"
          />
        </div>
        <!-- 删除：行内二次确认 -->
        <div
          class="row-actions flex-shrink-0 d-flex align-center ga-1"
          :class="{ 'is-confirm': confirmRemoveId === skill.id }"
          @click.stop
          @keydown.stop
        >
          <template v-if="confirmRemoveId === skill.id">
            <v-btn variant="text" color="error" @click="removeSkill(skill)">
              {{ t('yaya.settings.plugins.skills_delete_confirm', '确认移除？') }}
            </v-btn>
            <v-btn variant="text" @click="confirmRemoveId = null">
              {{ t('yaya.settings.cancel', '取消') }}
            </v-btn>
          </template>
          <v-btn
            v-else
            icon="mdi-delete-outline"
            size="small"
            :loading="removingId === skill.id"
            :title="t('yaya.settings.plugins.skills_delete', '移除该 Skill')"
            :aria-label="t('yaya.settings.plugins.skills_delete', '移除该 Skill')"
            @click="confirmRemoveId = skill.id"
          />
        </div>
      </div>
    </div>

    <SkillsDirDialog v-model="dirDialog" :root="skillsPath" />
  </div>
</template>

<style scoped>
.skills-panel {
  width: 100%;
  min-width: 0;
}

/* 列表容器：相对定位，供刷新进度线定位用（绝对定位，不占布局） */
.skill-rows {
  position: relative;
  min-width: 0;
}

.refresh-line {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  border-radius: 2px;
  overflow: hidden;
  z-index: 1;
}

.hub-row {
  background: rgba(var(--v-theme-surface-variant), 0.12);
  border-color: rgba(var(--v-theme-surface-bright), 0.2) !important;
}

.skill-row {
  background: rgba(var(--v-theme-surface-variant), 0.12);
  border-color: rgba(var(--v-theme-surface-bright), 0.2) !important;
  cursor: pointer;
}

/* chip：默认密度 + 显式内边距，label 不贴边框 */
.chip-pad {
  padding-block: 4px;
  min-height: 24px;
}

/* 描述两行省略 */
.hub-desc,
.skill-desc {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.skills-empty-hint {
  max-width: 480px;
}

/* 文字区按 0 起算宽度：长名称 / 描述不会把图标、开关挤到下一行 */
.row-main {
  flex: 1 1 0;
  min-width: 0;
}

.skill-name {
  overflow-wrap: anywhere;
}

/* 移除确认：独占一行放在下面（行本身允许换行，只有它会换） */
.skill-row {
  flex-wrap: wrap;
}

.row-actions.is-confirm {
  flex-basis: 100%;
  justify-content: flex-end;
}

/* 窄屏：整行可点，省掉箭头；内边距收一点 */
@media (max-width: 560px) {
  .skill-row,
  .hub-row {
    gap: 10px !important;
    padding: 10px 8px 10px 12px !important;
  }

  .row-chevron {
    display: none;
  }
}

/* 触屏设备：开关的触摸热区不小于 48px */
@media (pointer: coarse) {
  .skill-rows :deep(.v-switch) {
    --v-selection-control-size: 48px;
  }
}
</style>

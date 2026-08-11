<script setup lang="ts">
import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import type { ChildWindowInfo } from '@shared/types'
import { translate } from '@ui/i18n'

const props = defineProps<{ window: ChildWindowInfo }>()

const uiLang = inject<Ref<string>>('cockpit:lang', ref('zh'))
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

function control(action: string, patch?: Record<string, unknown>): void {
  void window.cockpit.controlWindow(props.window.id, action, patch)
}
</script>

<template>
  <div class="win-view">
    <!-- Header: identity + state, then icon-only control group (DESIGN §4.2:
         tools grouped ga-1, comfortable py/pb so nothing hugs the divider). -->
    <div class="win-header">
      <div class="win-meta">
        <div class="d-flex align-center ga-2">
          <span class="text-subtitle-2 font-weight-medium">{{ window.id }}</span>
          <v-chip variant="tonal" color="info" size="small" class="win-chip">
            {{ t('bt.kind.window') }}
          </v-chip>
          <v-chip
            v-if="window.locked"
            variant="tonal"
            color="warning"
            size="small"
            prepend-icon="mdi-lock-outline"
            class="win-chip"
          >
            {{ t('bt.win.locked') }}
          </v-chip>
        </div>
        <div class="text-caption on-surface-variant mt-1">
          {{ t('bt.win.view') }} · {{ window.view }}
        </div>
        <div class="text-caption on-surface-variant mt-1">
          {{ window.width }}×{{ window.height }}
          <span v-if="window.alwaysOnTop" class="ml-2">· {{ t('bt.win.pinned') }}</span>
          <span v-if="window.minimized" class="ml-2">· {{ t('bt.win.minimized') }}</span>
          <span v-if="window.maximized" class="ml-2">· {{ t('bt.win.maximized') }}</span>
        </div>
      </div>

      <v-spacer />

      <div class="win-controls">
        <v-tooltip :text="t('bt.win.pin')" location="bottom">
          <template #activator="{ props: tp }">
            <v-btn
              v-bind="tp"
              size="small"
              variant="tonal"
              :color="window.alwaysOnTop ? 'primary' : undefined"
              :icon="window.alwaysOnTop ? 'mdi-pin' : 'mdi-pin-off-outline'"
              @click="control('pin')"
            />
          </template>
        </v-tooltip>
        <v-tooltip :text="t('bt.win.frameless')" location="bottom">
          <template #activator="{ props: tp }">
            <v-btn
              v-bind="tp"
              size="small"
              variant="tonal"
              :color="window.frameless ? 'primary' : undefined"
              icon="mdi-border-outside"
              @click="control('style', { frameless: !window.frameless })"
            />
          </template>
        </v-tooltip>
        <v-tooltip :text="t('bt.win.rounded')" location="bottom">
          <template #activator="{ props: tp }">
            <v-btn
              v-bind="tp"
              size="small"
              variant="tonal"
              :color="window.rounded ? 'primary' : undefined"
              icon="mdi-radius-outline"
              @click="control('style', { rounded: !window.rounded })"
            />
          </template>
        </v-tooltip>
        <v-tooltip :text="window.locked ? t('bt.win.unlock') : t('bt.win.lock')" location="bottom">
          <template #activator="{ props: tp }">
            <v-btn
              v-bind="tp"
              size="small"
              variant="tonal"
              :color="window.locked ? 'warning' : undefined"
              :icon="window.locked ? 'mdi-lock' : 'mdi-lock-open-variant-outline'"
              @click="control('lock')"
            />
          </template>
        </v-tooltip>
      </div>

      <v-divider vertical class="win-divider" />

      <div class="win-controls">
        <v-tooltip :text="t('bt.win.minimize')" location="bottom">
          <template #activator="{ props: tp }">
            <v-btn
              v-bind="tp"
              size="small"
              variant="tonal"
              icon="mdi-window-minimize"
              @click="control('minimize')"
            />
          </template>
        </v-tooltip>
        <v-tooltip
          :text="window.maximized ? t('bt.win.restore') : t('bt.win.maximize')"
          location="bottom"
        >
          <template #activator="{ props: tp }">
            <v-btn
              v-bind="tp"
              size="small"
              variant="tonal"
              :icon="window.maximized ? 'mdi-window-restore' : 'mdi-window-maximize'"
              @click="control('toggle-maximize')"
            />
          </template>
        </v-tooltip>
        <v-tooltip :text="t('bt.win.close')" location="bottom">
          <template #activator="{ props: tp }">
            <v-btn
              v-bind="tp"
              size="small"
              variant="tonal"
              color="error"
              icon="mdi-close"
              @click="control('close')"
            />
          </template>
        </v-tooltip>
      </div>
    </div>

    <v-divider />

    <div class="win-info">
      <v-alert
        :type="window.locked ? 'warning' : 'info'"
        variant="tonal"
        density="compact"
        class="win-alert"
      >
        {{ window.locked ? t('bt.win.lockedHint') : t('bt.win.hint') }}
      </v-alert>
    </div>
  </div>
</template>

<style scoped>
.win-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}
/* DESIGN §3: header padding py-3/pb-3 minimum, no element hugs the divider. */
.win-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  flex-wrap: wrap;
}
.win-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
/* DESIGN §4.3: chips get explicit padding so labels don't hug the border. */
.win-chip {
  padding-block: 4px;
  min-height: 24px;
}
.win-controls {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.win-divider {
  align-self: stretch;
  margin: 2px 2px;
}
.win-info {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
}
.win-alert {
  padding: 8px 12px;
}
</style>

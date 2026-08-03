<script setup lang="ts">
/**
 * Shared loading UI for every ability: an indeterminate top bar while loading,
 * an optional skeleton block, and an error alert. Usage:
 *   <LoadingBar :loading="loading" :error="error" skeleton />
 */
defineProps<{
  loading?: boolean
  error?: string
  /** show v-skeleton-loader while loading (for first-load placeholders) */
  skeleton?: boolean
  skeletonType?: string
}>()
</script>

<template>
  <div>
    <v-progress-linear
      v-if="loading"
      indeterminate
      color="primary"
      class="mb-2"
    />
    <v-skeleton-loader
      v-if="skeleton && loading"
      :type="skeletonType ?? 'list-item-two-line,article'"
      class="mb-2"
    />
    <v-alert
      v-if="error"
      type="error"
      variant="tonal"
      density="compact"
      class="mb-3"
    >
      {{ error }}
    </v-alert>
  </div>
</template>

<script setup lang="ts">
import AbilityIcon from '../../../main/ui/components/AbilityIcon.vue'
withDefaults(defineProps<{ icon: string; size?: number }>(), { size: 24 })
</script>
<template>
  <v-icon v-if="icon.startsWith('mdi-')" color="primary" :size="size">{{ icon }}</v-icon>
  <AbilityIcon v-else :icon="icon" :size="size" class="text-primary" />
</template>

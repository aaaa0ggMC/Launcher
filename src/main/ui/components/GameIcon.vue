<script setup lang="ts">
import { ref, watch } from 'vue'

/**
 * Renders an SVG icon by name. Sources, in priority order:
 *   1. curated sidebar set  (assets/icons, eager, tiny)
 *   2. game-icon-pack       (assets/game-icon-pack/svg, eager, no-padding/padding)
 * Icons use `fill="currentColor"` — color inherits from surrounding text color.
 *
 * Both sources are eager so the SVG string is already in the bundle: the first
 * paint shows the real icon, never a fallback flash.
 *
 * Usage: <GameIcon name="boss" :padding="true" :size="20" />
 */
interface GameIconProps {
  name: string
  padding?: boolean
  size?: number
  /** emoji shown when the icon name doesn't resolve (e.g. 😎) */
  fallback?: string
}

const props = withDefaults(defineProps<GameIconProps>(), { padding: false, size: 20 })

const curated = import.meta.glob('../assets/icons/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default'
}) as Record<string, string>

const pack = import.meta.glob('../assets/game-icon-pack/svg/**/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default'
}) as Record<string, string>

const raw = ref('')
const missing = ref(false)

/** Resolve the SVG synchronously — both sources are in the bundle already. */
function resolve(): void {
  const name = props.name
  // 1. curated set (no padding variant)
  const curatedKey = Object.keys(curated).find((k) => k.endsWith(`/${name}.svg`))
  if (curatedKey) {
    raw.value = curated[curatedKey]
    missing.value = false
    return
  }
  // 2. game-icon-pack
  const folder = props.padding ? 'padding' : 'no-padding'
  const packKey = Object.keys(pack).find(
    (k) => k.includes(`/${folder}/`) && k.endsWith(`/${name}.svg`)
  )
  raw.value = packKey ? pack[packKey] : ''
  missing.value = !packKey
}

resolve()
watch(() => [props.name, props.padding], resolve)
</script>

<template>
  <span v-if="raw" class="game-icon" :style="{ width: `${size}px`, height: `${size}px` }">
    <!-- eslint-disable-next-line vue/no-v-html -- build-time/lazy SVG assets, not user input -->
    <span v-html="raw" />
  </span>
  <span v-else-if="fallback" class="game-icon fallback" :style="{ fontSize: `${size - 2}px` }">
    {{ fallback }}
  </span>
  <span
    v-else-if="missing"
    class="game-icon"
    :style="{ width: `${size}px`, height: `${size}px` }"
  />
</template>

<style scoped>
.game-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  line-height: 0;
}

.game-icon > span {
  width: 100%;
  height: 100%;
  display: block;
}

.game-icon > span :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}

.fallback {
  line-height: 1;
}
</style>

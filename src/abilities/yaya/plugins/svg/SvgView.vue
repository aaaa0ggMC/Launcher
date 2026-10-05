<script setup lang="ts">
/**
 * ```svg 代码块 → 图（显示类插件 svg 的 fence 视图）。
 *
 * 模型输出是不可信内容：先过 sanitize（去 script / foreignObject / on* / 外链引用），
 * 再把结果做成 data URL 用 <img> 显示（图片上下文里脚本不执行、不加载外部资源）。
 * 超过 200KB 只显示源码并提示；流式中只显示源码。
 */
import { computed, inject, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import type { FenceViewProps } from '../../components/plugin-ui'
import DiagramFrame from '../../components/plugin-kit/DiagramFrame.vue'
import { svgToDataUrl } from '../../components/plugin-kit/image-utils'
import { browserSvgDom, sanitizeSvg } from './sanitize'

const props = defineProps<FenceViewProps>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)

/** 超过这个大小只显示源码：净化 / 序列化 / data URL 都不便宜，超大图也拖慢消息流 */
const MAX_BYTES = 200 * 1024

const tooLarge = computed(() => props.source.length > MAX_BYTES)

const svgText = ref<string | null>(null)
const error = ref<string | null>(null)

function run(): void {
  svgText.value = null
  error.value = null
  // 流式中只显示源码，不净化（代码块可能还没写完）
  if (props.streaming) return
  if (tooLarge.value) return
  const clean = sanitizeSvg(props.source, browserSvgDom())
  if (clean === null) {
    error.value = t('yaya.diagram.svg_invalid', '不是合法的 SVG，无法渲染')
    return
  }
  svgText.value = clean
}

watch(() => [props.source, props.streaming] as const, run, { immediate: true })

const imageSrc = computed(() => (svgText.value ? svgToDataUrl(svgText.value) : null))
const hint = computed(() => {
  if (props.streaming) return t('yaya.diagram.streaming', '生成中，代码块闭合成图')
  if (tooLarge.value) return t('yaya.diagram.svg_too_large', 'SVG 超过 200KB，仅显示源码')
  return ''
})
</script>

<template>
  <DiagramFrame
    :source="source"
    :image-src="imageSrc"
    :svg-text="svgText"
    :error="error"
    :hint="hint"
    export-name="svg"
  />
</template>

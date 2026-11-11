<script setup lang="ts">
/**
 * KitRowGroup —— 把若干行元素捆成一个规划单元。
 *
 * Group 内部元素**争取同一行**（引擎把整组当成一个单元竞争空间，
 * 组宽 = 成员 minWidth 之和 + 成员间 gap）；Group 之间才竞争空间。
 * 这样 `[名字][slider][数值]` 作为一个设置项整体进出，不会被拆散。
 *
 * 纯标记组件：不产出 DOM 元素（避免多一层 flex 容器把组内元素和行的排版隔开），
 * 只通过 provide 给后代 KitRowItem 注入分组 id。非连续出现的同组成员会在
 * 首次出现的位置被拉到一起（见 engine.ts 的 buildUnits）。
 */
import { provide, useId } from 'vue'
import { rowGroupKey } from './smart-row-context'

defineOptions({ inheritAttrs: false })

defineProps<{
  /** 稳定分组 id（缺省自动生成；同一行内要捆一起的就用同一个 KitRowGroup 包起来） */
  id?: string
}>()

provide(rowGroupKey, useId())
</script>

<template>
  <slot />
</template>

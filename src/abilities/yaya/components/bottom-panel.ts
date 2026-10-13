import { ref } from 'vue'

/**
 * 「底部面板区」：输入条正下方的挂载点（QQ 式底部面板的家，如表情面板）。
 * ChatInputBox 用模板 ref 填充；任何组件（含非输入扩展，如回应条）读它做 Teleport 目标——
 * 面板落在输入条下方、遮不住输入条，输入条上方的内容自动让位（不盖遮罩、不是悬浮弹层）。
 */
export const bottomPanelEl = ref<HTMLElement | null>(null)

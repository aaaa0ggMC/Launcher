import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/**
 * KitGrid 列宽契约（第 2 类「溢出/被裁」的源头之一）：
 * `minmax(Npx, 1fr)` 的下限不可收缩——容器比 N 窄时整张网格横向溢出、被卡片硬裁
 * （探针实测 49 条溢出命中全是这类网格）。下限必须写成 `min(Npx, 100%)`：
 * 容器够宽时保持 Npx 语义，不够宽时回落到容器宽，网格绝不横向溢出。
 */

const src = readFileSync(fileURLToPath(new URL('./KitGrid.vue', import.meta.url)), 'utf8')

test('KitGrid 默认列宽与 minCol 的下限都可收缩（min(Npx, 100%)）', () => {
  assert.match(src, /minmax\(min\(\$\{props\.minCol\}px, 100%\), 1fr\)/, 'minCol 分支')
  assert.match(src, /minmax\(min\(240px, 100%\), 1fr\)/, '默认分支')
})

test('不许退回裸 minmax(Npx, 1fr)（下限不可收缩 → 窄容器硬裁）', () => {
  assert.doesNotMatch(src, /minmax\(\d+px, 1fr\)/, '任何裸 px 下限都会在窄容器溢出')
})

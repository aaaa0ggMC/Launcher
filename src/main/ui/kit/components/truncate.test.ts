import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

import { test } from 'node:test'

/**
 * 「信息降级链」契约（SPEC §9.5）——逐个会截断的积木一条，防止以后新增积木漏掉揭示。
 * 用户的原始抱怨：「内容被截断并且我没有任何方法能查看全部内容，无论是单击还是悬浮都不能看到」
 * （他在手机上用，hover 本来就不存在）。所以截断态必须暴露揭示入口：
 * title（桌面腿）或点按浮层触发器（触摸腿）。
 */

const HERE = new URL('.', import.meta.url)
const read = (f: string): string => readFileSync(new URL(f, HERE), 'utf8')

/** 一个积木「接了截断揭示」的判据：用了 KitTruncated / useTruncatable */
function usesPrimitive(src: string): boolean {
  return /KitTruncated|useTruncatable/.test(src)
}

test('KitChip：截断态有揭示入口', () => {
  const src = read('KitChip.vue')
  assert.ok(usesPrimitive(src), 'KitChip 必须接 KitTruncated / useTruncatable')
  assert.match(src, /<KitTruncated[^>]*:text="text"/, '全文要传给原语（title + 浮层用）')
  // 不许再自己写一套 ellipsis 而绕过原语
  assert.doesNotMatch(src, /\.kit-chip__text\s*\{[^}]*text-overflow: ellipsis/, 'ellipsis 归原语管')
})

test('KitRowItem：truncate 时接截断揭示', () => {
  const src = read('../layout/KitRowItem.vue')
  assert.ok(usesPrimitive(src), 'truncate 项必须接 KitTruncated')
  assert.match(src, /<KitTruncated v-if="truncate"/, '只有 truncate 时才包（不截断不拦点击）')
  assert.match(src, /:text="text"/, '用引擎已有的 text 当全文')
})

test('KitRowItem：truncate 不许吞 slot——内置渲染只是 slot 的缺省（A-2）', () => {
  // 出过的事故：truncate 分支 <KitTruncated v-if>…<slot v-else /> 把 slot 整个吞掉
  // → KitSettingRow 的 desc 永不渲染（P0 信息不全）、行标签丢 .kit-setting-row__label
  // 的 0.9375rem 字号（「标签 16px / 控件 14px」旧毛病复发）。slot 必须优先。
  const src = read('../layout/KitRowItem.vue')
  assert.match(src, /<slot>\s*<KitTruncated v-if="truncate"/, 'KitTruncated 只能是 slot 的缺省内容')
  assert.doesNotMatch(src, /<slot v-else\s*\/>/, '不允许 v-else 吞 slot')
})

test('KitSettingRow：desc 渲染链完整（A-2 的 P0 不回归）', () => {
  const src = read('KitSettingRow.vue')
  // desc 的 KitTruncated 在 KitRowItem 的 slot 里，必须真渲染出来
  assert.match(src, /<KitTruncated v-if="desc"/, 'desc 要有揭示原语')
  assert.match(
    src,
    /<KitRowItem[^>]*truncate[^>]*>[\s\S]*?<KitTruncated v-if="desc"/,
    'desc 所在的 slot 必须挂在 truncate 行下且不被吞'
  )
})

test('KitSettingRow：label / desc / value 三处都接', () => {
  const src = read('KitSettingRow.vue')
  const uses = [...src.matchAll(/<KitTruncated/g)]
  assert.ok(uses.length >= 3, `label / desc / value 三处都要接，当前 ${uses.length} 处`)
  // value 原来只有 title，现在也要能点按
  assert.match(src, /<KitTruncated class="kit-setting-row__value"/)
})

test('KitCircleStat：label 会随直径收缩截断，必须接', () => {
  const src = read('KitCircleStat.vue')
  assert.ok(usesPrimitive(src), 'KitCircleStat 的 label 必须接 KitTruncated')
})

test('原语本身：只在真截断时挂 title（避免满屏 title）', () => {
  const src = read('../composables/useTruncatable.ts')
  // 判定走纯函数 isTruncatedProbe（自身在裁 + 被祖先裁，两条取或）
  assert.match(src, /isTruncatedProbe\(probe\)/, '判定收敛到纯函数（可单测）')
  assert.match(src, /truncated\.value \? text\.value : undefined/, '没截断就不挂 title')
  assert.match(src, /new ResizeObserver/, '容器尺寸变化要重判')
  assert.match(src, /recheckAllTruncatables/, '浮层打开时统一重判')
})

test('原语：触摸腿是点按浮层（不是只靠 hover）', () => {
  const src = read('KitTruncated.vue')
  assert.match(src, /@click="onReveal\(\$event\)"/, '点按揭示')
  assert.match(src, /@keydown\.enter/, '键盘也要能揭示（可达性）')
  assert.match(src, /<Teleport to="body">/, '浮层 teleport 到 body')
  assert.match(src, /useAnchor/, '定位复用 useAnchor（页面缩放下口径一致），不新造第三套')
  assert.match(src, /kit-truncate-tip/, '浮层样式类名')
})

test('原语：真截断时点按接管点击（stopPropagation），没截断不拦宿主控件', () => {
  // 不拦的后果（实测）：点「看全文」顺带把 KitSelect 的菜单弹起来盖住浮层；
  // 拦的代价：截断时宿主控件（chip click / 下拉展开）收不到这次点击——按 SPEC
  // 「点按出全文」语义，截断文本上揭示手势优先。没截断时必须完全透明。
  const src = read('KitTruncated.vue')
  assert.match(src, /if \(!truncated\.value\) return/, '没截断直接放行')
  assert.match(src, /e\.stopPropagation\(\)/, '截断时接管点击，不冒泡给宿主')
})

test('KitSelect：inline 触发器文字接截断揭示（1-1，静态审计点名的活体缺口）', () => {
  const src = read('KitSelect.vue')
  assert.ok(usesPrimitive(src), 'KitSelect 必须接 KitTruncated / useTruncatable')
  assert.match(
    src,
    /<KitTruncated class="kit-inline-select__text" :text=/,
    '触发器文字包原语且传全文（title + 点按浮层用）'
  )
})

test('自检：截断标记与其它标记颜色区分开', () => {
  const css = read('../kit.css')
  assert.match(css, /\.kit-debug-on \.kit-debug-truncated \{/)
  for (const other of [
    'kit-debug-overflow',
    'kit-debug-align--bad',
    'kit-debug-align--override',
    'kit-debug-size--bad'
  ]) {
    assert.ok(css.includes(other), `自检标记 ${other} 应仍在`)
  }
})

test('「更多」浮层内不截断（档 2 的全文保证别回退）', () => {
  // 规则在 KitRowItem 的 scoped 样式里（:global(.kit-overflow) .kit-row-item__inner）
  const src = read('../layout/KitRowItem.vue')
  assert.match(src, /kit-overflow[\s\S]*?overflow: visible/, '浮层内不裁（overflow 可见）')
  assert.match(src, /kit-overflow[\s\S]*?white-space: normal/, '浮层内正常折行（nowrap 解除）')
})

test('检测把祖先链算进去：不只是自己盒子在裁', () => {
  const src = read('../composables/useTruncatable.ts')
  assert.match(src, /isTruncatedProbe/, '用纯函数判定（可单测）')
  assert.match(src, /clipRightOf/, '沿祖先链找第一个会裁的盒子')
  assert.match(src, /self \|\| byAncestor|self \|\| ancestor|return self \|\|/, '两条路取或')
})

test('浮层里的项打开时要重判（不能停在隐藏期的死状态）', () => {
  const comp = read('../composables/useTruncatable.ts')
  assert.match(comp, /recheckAllTruncatables/, '提供统一重判入口')
  const row = read('../layout/KitSmartRow.vue')
  assert.match(row, /recheckAllTruncatables\(\)/, '打开「更多」浮层后通知其中的 KitTruncated 重判')
})

test('KitTruncated：模板根节点只有 span 一个（多根 = Fragment = class 被丢）', () => {
  const src = read('KitTruncated.vue')
  assert.match(src, /<template>\s*<span\b/, '根级第一个节点必须是 span——注释/兄弟节点都会变 Fragment')
})

test('守卫：模板根级不许有注释——根级注释把根变 Fragment，调用方 class/attrs 被静默丢弃', () => {
  // 血亏记录：KitTruncated 根级一句「Teleport 放 span 内部」的注释就把模板根编译成
  // [注释, span] Fragment，消费方传的 class（.kit-setting-row__label / .kit-chip__text …）
  // 全部丢掉——kit.css 的字号规则匹配不上，「标签 16px / 控件 14px」旧毛病复发的真因。
  // 注释写进 script 文档或元素内部。
  const roots = [
    new URL('..', import.meta.url), // src/main/ui/kit
    new URL('../../../../abilities/settings/items/ui-kit/', import.meta.url) // 画廊
  ]
  const offenders: string[] = []
  const walk = (dir: URL): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const u = new URL(ent.name + (ent.isDirectory() ? '/' : ''), dir)
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
        walk(u)
      } else if (ent.name.endsWith('.vue')) {
        const raw = readFileSync(u, 'utf8')
        const m = raw.match(/<template>([\s\S]*?)<\/template>/)
        if (m && m[1].trimStart().startsWith('<!--')) offenders.push(u.pathname)
      }
    }
  }
  for (const r of roots) walk(r)
  assert.deepEqual(offenders, [], `根级注释会造出 Fragment（class 被丢），违规：${offenders.join(', ')}`)
})

test('守卫：text-overflow: ellipsis 只允许写在 KitTruncated 原语里', () => {
  // 「ellipsis 归原语管」是 SPEC §9.5 的实现纪律：积木自己写就是绕过揭示原语——
  // KitSelect 的 .kit-inline-select__text 正是这么漏成「截断不可揭示」的（1-1）。
  // 扫 kit 全部样式源 + 画廊 demo：任何非原语文件声明 ellipsis 都是缺口。
  const roots = [
    new URL('..', import.meta.url), // src/main/ui/kit
    new URL('../../../../abilities/settings/items/ui-kit/', import.meta.url) // 画廊
  ]
  const offenders: string[] = []
  const walk = (dir: URL): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const u = new URL(ent.name + (ent.isDirectory() ? '/' : ''), dir)
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
        walk(u)
      } else if (/\.(vue|css)$/.test(ent.name)) {
        const raw = readFileSync(u, 'utf8')
        // 去掉注释再查（「…归原语」的说明注释不算声明）
        const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
        if (/text-overflow:\s*ellipsis/.test(code) && !u.pathname.endsWith('KitTruncated.vue')) {
          offenders.push(u.pathname)
        }
      }
    }
  }
  for (const r of roots) walk(r)
  assert.deepEqual(offenders, [], `ellipsis 只许 KitTruncated.vue 写，违规：${offenders.join(', ')}`)
})

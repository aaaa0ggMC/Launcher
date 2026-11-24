# UI 信息展示缺陷 · 静态审计（五类口径）

> 只读审计产物。范围：`src/main/ui/kit/**`（积木）+ `src/abilities/settings/items/**`（设置页 kit 化分区与 UI 库 gallery demo）+ `src/abilities/mirror/View.vue`（样板页）。
> 口径：SPEC `src/main/ui/kit/SPEC.md`（§4.5 行内对齐、§9.5 信息降级链、行内三律）。
> 每条结论带 `文件:行号` + 代码证据；静态推断不了的标 **「待动态确认」** 并给验证方法（交叉核对清单见 §3，供 dsh-threads/6 的 CDP 探针逐条核对）。
> 生成时间：2026-11-24；基线 commit `032b61c`（含 7b339ca「信息降级链」、2438d47「祖先链截断检测」）。

---

## 1. 总览

### 1.1 五类命中数

| 类 | 名称 | 静态确定 | 待动态确认 | 其中 P0 |
| --- | --- | --: | --: | --- |
| 附 | **信息丢失/不全（五类口径外，正中用户原话「展示不全」）** | **2** | 0 | **2** |
| 1 | 截断后不可揭示 | 6 | 2 | 1 |
| 2 | 溢出/被裁剪 | 1 | 3 | 0 |
| 3 | 对齐错乱 | 4 | 0 | 0 |
| 4 | 同类元素尺寸不一致 | 4 | 1 | 0 |
| 5 | 文字碰撞/怪异折行/高低错落 | 6 | 1 | 0 |
| — | 合计 | 23 | 7 | 3 |

### 1.2 最严重 Top 5

| # | 位置 | 一句话 | 严重度 |
| - | ---- | ------ | ------ |
| 1 | `src/main/ui/kit/components/KitSelect.vue:42-50` × `src/abilities/settings/items/WindowSection.vue:172-178` | inline 档下拉只认 `{title,value}` 键，设置页「背景」下拉传的是 `{id,name,…}`+`item-title="name"` → **值区空白、选项全空白、选中值为 undefined** | **P0** |
| 2 | `src/main/ui/kit/layout/KitRowItem.vue:102-105` × `src/main/ui/kit/components/KitSettingRow.vue:91-98` | `truncate` 分支渲染 `text` 并**吞掉整个 slot** → KitSettingRow 的 `desc` 永不显示、行标签丢失 0.9375rem 字号（回到「标签 16px / 控件 14px」的旧毛病） | **P0**（desc）/ P1（字号） |
| 3 | `src/main/ui/kit/kit.css:364-368` + `src/main/ui/kit/components/KitSelect.vue:92` | `.kit-inline-select__text` ellipsis+nowrap 无任何揭示（已知活体，无 title / 点按） | P0（下拉值是设置正文） |
| 4 | `src/abilities/settings/items/BootServicesSection.vue:116,202-206` | `.boot-title` ellipsis+nowrap、无 title / KitTruncated → 开机服务名被截后全文不可读 | P1 |
| 5 | `src/abilities/settings/items/ui-kit/KitPageDemo.vue:63,78`、`KitFoundationDemo.vue:82` | 三处把 `t(...)` 写成裸文本（缺 `{{ }}`）→ 画廊正文**显示成源代码字符串** | P1 |

---

## 2. 逐类清单

严重度口径：**P0 挡可读性**（信息真的看不到/读不全）/ **P1 美观**（明显错乱）/ **P2 整洁**。
「层」= 缺陷发生层：**自己裁**（元素自身 ellipsis/hidden）/ **被祖先裁**（overflow 祖先硬切）/ **结构**（模板或数据流问题，与裁剪无关）。

### 附. 信息丢失/不全（超出五类口径，但正是「展示不全」的根子）

#### A-1（P0）KitSelect inline 档不认 `item-title`/`item-value`：设置页「背景」下拉整只空白

- 位置：`src/main/ui/kit/components/KitSelect.vue:42-50`（options 映射）× `src/abilities/settings/items/WindowSection.vue:22-29`（items 形状）× `WindowSection.vue:172-178`（用法）。
- 证据（映射只读 `title`/`value` 两个键）：

  ```ts
  // KitSelect.vue:44-46
  const o = raw as { title?: unknown; value?: unknown }
  return { title: String(o.title ?? ''), value: o.value ?? o.title }
  ```

  ```html
  <!-- WindowSection.vue:172-178：items 是 {id,name,description}，靠 item-title/item-value 指路 -->
  <KitSelect v-model="background" :items="bgItems" item-title="name" item-value="id" …>
  ```
- 缺陷链（静态确定）：`o.title` 为 undefined → 所有选项 `title=''`、`value=undefined`；`current`（KitSelect.vue:52）永远匹配不到 → 触发器文字恒空（KitSelect.vue:92）；`pick(o.value)` 发出 `undefined` → `setBackground(undefined)` 落回 `'transparent'`（WindowSection.vue:100-103）。且 `v-for :key="String(o.value)"`（KitSelect.vue:103）全部是 `'undefined'` 重复 key。
- 层：结构（数据流），不是裁剪。
- 为何以前没被发现：gallery 的两个用法恰好都合规——字符串数组（`KitSettingRowDemo.vue:18`）与 `{title,value}` 对象（`KitSmartRowDemo.vue:53-57`）；input 档走 v-select 原生 `item-title` 也正常。**只有「对象 items + item-title 指路 + inline 档」三者同时成立才炸**，而设置页正是这个组合（KitSettingRow provideDensity('inline')，`src/main/ui/kit/layout/density.ts:17-19`）。
- 建议修法：`options` 映射读取 `attrs['item-title']`/`attrs['item-value']`（缺省回落 `title`/`value`），或 KitSelect 显式声明 `itemTitle`/`itemValue` props；契约测试补一条「item-title 指路的对象数组」。
- 动态核对：设置 → 窗口 →「背景」下拉：点开看选项是否为空白、当前值是否为空、选完是否落回 transparent。

#### A-2（P0/P1）KitRowItem `truncate` 分支吞 slot：KitSettingRow 的 `desc` 永不显示、label 丢字号

- 位置：`src/main/ui/kit/layout/KitRowItem.vue:100-107` × `src/main/ui/kit/components/KitSettingRow.vue:89-98`。
- 证据：

  ```html
  <!-- KitRowItem.vue:102-105：truncate 为真时只渲染 text，<slot v-else /> 整个不渲染 -->
  <KitTruncated v-if="truncate" class="kit-row-item__label" :text="text">{{ text }}</KitTruncated>
  <slot v-else />
  ```

  ```html
  <!-- KitSettingRow.vue:91-98：truncate 恒为真（裸属性=boolean true），但 slot 里才是 name+desc 的样式块 -->
  <KitRowItem kind="label" :text="label" :priority="priority" truncate grow>
    <div class="kit-setting-row__name">
      <KitTruncated class="kit-setting-row__label" :text="label">{{ label }}</KitTruncated>
      <KitTruncated v-if="desc" class="kit-setting-row__desc" :text="desc">{{ desc }}</KitTruncated>
    </div>
  </KitRowItem>
  ```
- 静态后果：
  1. **`desc` prop 永不渲染**（P0，信息不全）——当前设置页没人传 `desc` 所以潜伏，但 API 是公开的（SPEC §12 参考实现就列了 label/desc）；
  2. **行标签丢失 `.kit-setting-row__label` 的 0.9375rem 字号**（P1）——kit.css:97-103 注释明说修的就是「行标签 16px（继承 .v-application 1rem）而行内控件 14px」，而这个修复挂在被吞掉的 slot 里；实际渲染的是无样式类 `kit-row-item__label`（全仓无此 CSS 规则，`grep` 仅命中 KitRowItem.vue:102 一处）；
  3. slot 里任何调用方自定义内容（如 gallery 的 `.kit-demo-label`、翻译后的文本）都会被 `text` prop 顶掉——见 C-5-3 的英文界面不翻译证据。
- 层：结构（v-if/v-else 排他渲染）。
- 背景：7b339ca（「信息降级链」）把 `<slot />` 改成 `<KitTruncated v-if="truncate">…<slot v-else />`，同一提交还把 KitSettingRow 的 slot 内容改成 KitTruncated 包裹——两处改动互相矛盾，源码模式测试（`truncate.test.ts:36-42` 只数 `<KitTruncated` 出现次数）拦不住。
- 建议修法：slot 优先（`<slot><KitTruncated v-if="truncate">…</KitTruncated></slot>`，或 `v-if="$slots.default)"` 分支）；`truncate` 只接管「没给 slot 的纯文本项」。改完补一条挂载级测试或动态核对。
- 动态核对：设置页任意设置行，量 label 的 `getComputedStyle(el).fontSize`（预期 0.9375rem=15px 布局/16.5px 视觉，实际疑似 16px 布局）；给任一 KitSettingRow 传 `desc` 看是否显示。

### 类 1 · 截断后不可揭示（ellipsis+nowrap，真截断时无 title / 点按揭示）

> 已接原语（合格，不列）：KitRowItem(truncate)、KitSettingRow label/desc/value、KitChip、KitCircleStat label —— 但注意 A-2 使 KitSettingRow 的 label/desc 两处「已接」实际落空。

| # | 位置 | 缺陷 | 层 | 修法 | 严重度 |
| - | ---- | ---- | - | ---- | ------ |
| 1-1 | `src/main/ui/kit/kit.css:364-368` + `KitSelect.vue:92` | `.kit-inline-select__text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}` 渲染 `current.title`，无 KitTruncated / title / 点按——下拉值被截后全文不可读（用户原话「单击还是悬浮都不能看到」的活体，任务书已点名） | 自己裁 | 包 KitTruncated（`:text="current?.title"`）；菜单打开本身也是揭示，可在按钮上补 `:title` | **P0** |
| 1-2 | `src/abilities/settings/items/BootServicesSection.vue:116` + `:202-206` | `.boot-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`，`{{ labelOf(s) }}` 无 title；窄屏有 `white-space:normal` 兜底（:230-232），**宽屏真截断时无任何揭示** | 自己裁 | 包 KitTruncated 或加 `:title="labelOf(s)"` | P1 |
| 1-3 | `src/abilities/settings/items/AbilityToggleSection.vue:171` | `<span class="text-body-2 … text-truncate">{{ name(id) }}</span>` 无 title（能力名被截后不可读） | 自己裁 | 加 `:title="name(id)"`（同文件 310 行 SidebarSection 就是这么做的） | P2 |
| 1-4 | `src/abilities/settings/items/AbilityToggleSection.vue:187` + `:239-241` | `.ability-id{max-width:200px}` + `text-truncate` 无 title（id 长时被截） | 自己裁 | 加 `:title="id"` | P2 |
| 1-5 | `src/abilities/settings/items/SidebarSection.vue:313` | 分类文字 `text-truncate` 无 title；同卡片的名字（:310）有 `:title`——同类元素揭示口径不一致 | 自己裁 | 加 `:title="item.category"` | P2 |
| 1-6 | `src/abilities/settings/items/AndroidClientSection.vue:120` | `<code class="text-truncate">{{ info.url }}</code>` 宿主 URL 被截无 title（URL 正是需要完整复制的信息） | 自己裁 | 加 `:title="info.url"`，或换 KitTruncated | P2 |
| 1-7（待动态确认） | `KitSelect.vue:108` `v-list-item-title` | Vuetify 的 `.v-list-item-title` 自带 ellipsis（Vuetify 内部样式），长选项在菜单里被截后也无揭示 | 自己裁 | 菜单项加 `:title="o.title"` 或自绘 title；验证：菜单里放 60 字选项，量 `scrollWidth>clientWidth` 且 `title` 为空 | P2 |
| 1-8（待动态确认） | `BootServicesSection.vue:122-140`、`mirror/View.vue:176-186` 的 `v-chip` | 若 Vuetify `.v-chip__content` 自带 ellipsis（需查运行时样式），长 chip 文案（如「退出前弹窗确认」在挤窄时）被截无揭示 | 自己裁 | 验证 `getComputedStyle(chipContent).textOverflow`；命中则给 chip 加 title | P2 |

### 类 2 · 溢出/被裁剪（祖先 hard clip、flex 归零、滚动条被截）

| # | 位置 | 缺陷 | 层 | 修法 | 严重度 |
| - | ---- | ---- | - | ---- | ------ |
| 2-1 | `src/abilities/settings/items/ui-kit/KitWidthStage.vue:24`（注释「内容更高时内部滚」）× `:188-195` | `.kit-stage__box{…overflow:hidden}` —— 注释承诺内滚，实际 `overflow:hidden` 双向硬裁：demo 内容高于盒高时被切、无滚动条（gallery 的宽度模拟器） | 被祖先裁 | `overflow: hidden auto` 或兑现注释给 `overflow-y:auto` | P2 |
| 2-2（待动态确认） | `src/main/ui/kit/layout/KitPage.vue:97-100`（`.kit-page--app{overflow:hidden}`） | app 模式页面级零滚动，**没挂 `scroll` 的 KitSection 高出可视区即被硬裁且无滚动条**。gallery 的 KitPageDemo 顶/底栏区很矮所以看不出来；真实页面用 `mode="app"` + 高内容时触发 | 被祖先裁 | 用法约束（文档写明「app 模式内容区必须 scroll」）或给非 scroll 区兜底 `overflow:auto`；验证：app 模式页塞高内容看是否被切 | P1（真页面）/P2（现状只有 demo） |
| 2-3（待动态确认） | `src/main/ui/kit/components/KitCircleStat.vue:72-74,120-125` | `.kit-circle__value{white-space:nowrap}` 且未接 KitTruncated，圆 `overflow:visible`（:92）——直径由 `estimateTextWidth` 估算（:45-50），CJK/emoji/长单位估算偏低时**数值溢出 80% 内盒、压上圆环/标签**，无裁剪也无揭示 | 溢出（可见式） | 数值也接 KitTruncated（或 fit 降字号）；验证：传 `'1234.56 ms'`、混合中英文标签量 value 是否越出内盒 | P2 |
| 2-4（待动态确认） | `src/abilities/mirror/View.vue:169-173` | 卡片头 `d-flex align-center ga-2` 里 `{{ m.name }}` 无 `min-width:0`/truncate：长镜像名（用户可自定义）把右侧延迟 chip 挤出卡片（v-card 若 overflow:hidden 即被裁，无揭示） | 被祖先裁/结构 | name span 加 `min-w-0 text-truncate` + `:title`；验证：造 30 字镜像名看 chip 是否被挤出/裁掉 | P2 |

### 类 3 · 对齐错乱（同行中线/左缘/右缘不齐、不走 kit 对齐令牌）

| # | 位置 | 缺陷 | 层 | 修法 | 严重度 |
| - | ---- | ---- | - | ---- | ------ |
| 3-1 | `src/main/ui/kit/layout/KitSmartRow.vue:420-425` × `src/main/ui/kit/kit.css:477-479` | scoped 的 `.kit-smart-row__line{align-items:center}`（特异性 0,2,0）**盖掉** kit.css 的 `align-items:var(--kit-row-align,center)`（0,1,0）→ 行级 `align` prop 对行容器本身永远无效；`.kit-smart-row__line--start`（:427-429）定义了但模板从不加这个类（死代码）。KitRowItem 子项因 kit.css:481-483 的 `align-self` 变量链仍可覆盖，**裸子元素（非 KitRowItem）吃不到 align** | 结构 | 删 scoped 那条 `align-items`（让位给变量链）或 scoped 改写成 `align-items:var(--kit-row-align,center)`；删死类 | P2 |
| 3-2 | `src/abilities/settings/items/AbilityToggleSection.vue:138-139` + `:242-245` | 悬浮窗总开关行 `align-items:flex-start` + 图标 `mt-1` 手工补 4px 冒充对齐（`<v-icon … class="mt-1" />`）；同卡片其余行都是 `align-center` → 同屏两种行对齐模式，图标与首行文字中线靠魔数对上、换字号即错位 | 结构 | 用 kit 对齐变量或首行文字行高内嵌图标；删 `mt-1` 魔数 | P2 |
| 3-3 | `src/abilities/settings/items/ShortcutsSection.vue:308-311` | `.sc-warn{text-align:right}`：同一列里 label/按键全部左对齐、报错文字右对齐（左右缘混排）；且该行手写 flex（.sc-row）没走 kit 对齐令牌 | 结构 | 报错改左对齐贴 label 左缘，或按 SPEC「数值右对齐」口径明确它是行尾元素 | P2 |
| 3-4 | `src/abilities/settings/items/ui-kit/KitFoundationDemo.vue:138` | `.kit-demo-circles{align-items:flex-end}`：一行里 4 个不同直径的 KitCircleStat 底对齐、**中线全不齐**（44~132px 直径差最大 44px）；若圆形 stat 行是 SPEC「共享中线」的适用对象则违规，若是「列队统计」的刻意排法需在 SPEC 豁免 | 结构（设计取舍） | 明确口径：要么 `align-items:center`，要么 SPEC §4.5 加豁免条款 | P2 |

### 类 4 · 同类元素尺寸不一致（差异来自内容而非密度阶）

| # | 位置 | 缺陷 | 层 | 修法 | 严重度 |
| - | ---- | ---- | - | ---- | ------ |
| 4-1 | `KitSettingRow.vue:91-98`（成因见 A-2） | 行标签实际渲染成无样式文本（≈16px）而同行数值 0.9375rem（kit.css:89-95）、控件 0.875rem（kit.css:271）——**同一设置行三种字号**，正是 kit.css:97-99 注释里「下拉里的 dark 字样比同行文字小」的旧病复发 | 结构 | 修 A-2 即愈 | P1 |
| 4-2 | `src/abilities/settings/items/ui-kit/KitNumberStepperDemo.vue:50-73` + `:90-94` | 同一行 3 个 KitNumberStepper 宽度不一（第三个带 `unit="MB"` 多出单位宽）——SPEC 行内三律之三「差异只能来自密度阶，不能来自内容长短」按字面命中（宽度维度） | 结构 | demo 里统一 `width` prop，或 SPEC 明确步进器宽度豁免（内容驱动） | P2 |
| 4-3 | `src/abilities/settings/items/ShortcutsSection.vue:252-258`（`.sc-key{min-width:160px}` :305-307） | 一列同型按键按钮宽度参差：min-width 160px 但长组合键（如 Ctrl+Alt+Shift+F12）撑宽；录制态文案「按下新组合键…」替换时**整按钮变宽、行内元素横向跳动**（兼类 5） | 结构 | `max-width:100%` + 固定 `width`/`inline-size`，或文案用定宽容器 | P2 |
| 4-4 | `src/abilities/mirror/View.vue:226-228` | 启用卡多一圈 `border:1px`（`mirror-card--enabled`）而禁用卡无边框：同网格里同类卡片盒模型差 2px、内容偏移 1px | 结构 | 透明边框打底（`border:1px solid transparent`）再改色 | P2 |
| 4-5（待动态确认） | `BootServicesSection.vue:122-146` + `.boot-chip`（:220-223） | `boot-side` 是 `flex-wrap`，chip 无 nowrap 兜底时被挤窄会折行、`min-height:24px` 失效 → 同行「运行中」与「退出前弹窗确认」一高一低 | 自己折 | 验证：把行压到 320px 量各 chip `getBoundingClientRect().height`；命中则 chip 加 nowrap 或换 KitChip | P2 |

### 类 5 · 文字碰撞/怪异折行/控件高低错落

| # | 位置 | 缺陷 | 层 | 修法 | 严重度 |
| - | ---- | ---- | - | ---- | ------ |
| 5-1 | `src/abilities/settings/items/ui-kit/KitPageDemo.vue:63`、`:78` | `<KitProse>t('kit.gallery.page.fixedHeadDesc', '不滚动的头部')</KitProse>` —— 缺 `{{ }}`，画廊正文**直接显示 t(...) 源码字符串**（信息错乱） | 结构 | 改 `{{ t(...) }}` | P1 |
| 5-2 | `src/abilities/settings/items/ui-kit/KitFoundationDemo.vue:80-82` | `<KitProse >t('kit.gallery.foundation.cell', '格子 {n}').replace('{n}', String(n))</KitProse>` 同上，网格 demo 每格显示源码 | 结构 | 改 `{{ t(...).replace(...) }}` | P1 |
| 5-3 | `src/abilities/settings/items/ui-kit/KitSmartRowDemo.vue:96`、`:146` | `text="主音量"` / `text="很长的设置项名称"` 硬编码中文 + slot 里是翻译——A-2 的 slot 吞噬使 **英文界面这两处显示中文硬编码**（信息错乱，兼证 A-2） | 结构 | 修 A-2 后自动愈；`text` 也应传翻译结果 | P1 |
| 5-4 | `src/abilities/settings/items/ui-kit/KitSettingRowDemo.vue:165-176`（用点 :94/:106/:116/:129） | `.kit-demo-tagged__tag{position:absolute;right:0;bottom:-1px}` 浮标**压在行尾控件/数值右下角上**（文字与控件碰撞，虽 pointer-events:none 但视觉重叠） | 结构 | 移到行外（列头小注）或行高预留 | P2 |
| 5-5 | `src/abilities/settings/items/WebHostSection.vue:234-236` | `code{word-break:break-all}`：状态行里的 URL 任意位置断词（`http://127.0.` 换行 `0.1:47810`），怪异折行 | 结构 | `overflow-wrap:anywhere` + 断在 `://` 后，或整段 KitTruncated + title | P2 |
| 5-6 | `src/abilities/settings/items/SidebarSection.vue:430-437` | `.ability-leave-active{position:absolute}` + `.ability-grid` 是 grid：拖动重排离场动画期间卡片短暂叠压（文字碰撞的瞬态） | 结构 | 接受（常见列表动画）或 FLIP 定位 | P2 |
| 5-7 | `src/abilities/settings/items/ShortcutsSection.vue:252-261`（`.sc-row{flex-wrap:wrap}` :294-300） | 行挤窄后 label 一行、按键+开关+按钮落到第二三行，控件与 label 视觉断层；`.sc-warn`（flex-basis:100%）再垫一行右对齐红字，高低错落 | 结构 | 迁移 KitSmartRow 统一退化口径 | P2 |
| 5-8（待动态确认） | `BootServicesSection.vue:213-217`（`.boot-side{flex-wrap:wrap; margin-inline-start:auto}`） | 窄容器下 chips 与开关分两行、开关孤悬右下（高低错落） | 结构 | 验证 320px 下的断行观感；可让 chips 组整体换行 | P2 |

---

## 3. 静态 vs 动态交叉核对点（给 CDP 探针线程）

按「静态推断需要真实 DOM 消歧」列出，验证方法可直接转成探针断言：

1. **A-2 slot 吞噬的可见后果**（最关键）：
   - 设置页任一设置行 label 的 `getComputedStyle(el).fontSize`——若 ≈16px(布局) 即证实（应为 0.9375rem）；
   - gallery「KitSmartRow」demo 在 **en-US 语言**下第一行 label 是否显示「主音量」（证实 slot 被 text 顶掉）；或给任意 KitSettingRow 传 `desc` 看是否渲染。
2. **A-1 空白下拉**：设置 → 窗口 →「背景」下拉：触发器文字、每个 `v-list-item-title` 的 `textContent` 是否为空；选中一项后 `window.cockpit.getConfig().window.background` 是否变成 `transparent`。
3. **1-1** `.kit-inline-select__text`：构造长背景名/长选项，确认 `scrollWidth>clientWidth` 时元素无 `title`、点击无浮层（该元素根本没接 useTruncatable）。
4. **1-2/1-8**：把某个 boot service 的 label 配置成 40 字，宽屏窗口下量 `.boot-title` 截断与 title；顺带查 `.v-chip__content` 的 `textOverflow` 计算值。
5. **1-7**：下拉菜单放 60 字选项，量 `v-list-item-title` 的截断与 title。
6. **2-2**：构造 `KitPage mode="app"` + 无 scroll 的高内容区，确认内容被 `overflow:hidden` 切掉且无滚动条。
7. **2-3**：KitCircleStat 传 `value="1234.56 ms"` / `label` 长混合文本，量 `.kit-circle__value` 的 `getBoundingClientRect()` 是否越出圆（`width/height = diameter`）。
8. **2-4**：镜像配置里造 30 字 name，看卡片头 chip 是否被挤出/裁掉。
9. **3-1**：`<KitSmartRow align="start">` 放一个裸 `<span>` 子元素，实测其 `align-self`/`getBoundingClientRect().top` 是否仍是 center（预期：是，证实变量链被 scoped 规则短路）。
10. **4-5**：BootServices 行压到 320px，量同排 chip 高度是否不一。
11. **4-3**：录制快捷键时观察 `.sc-key` 宽度跳动是否推动同行元素。
12. **通用**：gallery「布局自检」开关（KitDebugOutline）扫一遍设置页与 mirror 页——溢出红 / 对齐黄 / 尺寸紫 / 截断蓝标记与本清单互查（注意自检只标「真截断」，A-1/A-2 这类空渲染不产生标记）。

---

## 4. 建议修复顺序

按严重度 + 依赖关系：

1. **A-1 KitSelect 的 item-title/item-value 映射**（P0）：独立、改动小（options 计算 + 契约测试）；先修它，设置页「背景」立刻可读可选。
2. **A-2 KitRowItem truncate 吞 slot**（P0/P1）：改 KitRowItem 的 v-if/v-else 为 slot 优先；它同时决定 4-1（字号）与 5-3（未翻译）两处，**修完这两处自动愈合**，desc 能力也复活。回归核对：truncate 揭示三条腿（title / 点按 / 更多浮层）别被改坏（`truncate.test.ts` 8 例 + 动态核对点 1）。
3. **1-1 `.kit-inline-select__text` 接 KitTruncated**（P0，已知活体）：kit.css 删本地 ellipsis 或保留由原语接管；补 title。
4. **1-2 `.boot-title` 揭示**（P1）：包 KitTruncated / 加 title。
5. **5-1/5-2 画廊三处裸 `t(...)`**（P1）：一行一处的机械修复。
6. **1-3～1-6 补 title**（P2 批量）：4 处各一行。
7. **3-1 对齐变量链短路 + 死类**（P2）：kit 积木级，顺手清；改动前跑 `align.test.ts`。
8. **2-1 / 2-2 / 2-3 / 2-4 + 1-7 / 1-8 / 4-5**：先按 §3 核对点动态确认命中面，再按清单修。
9. **3-2～3-4 / 4-2～4-4 / 5-4～5-8**（P2 整洁）：攒一批做，多为 demo 与页面细节。

> 纪律备注：本报告只新增本文件，未改任何源码；分析基线为 commit `032b61c`。另一线程（ui-probe）若正在改 `src/main/ui/kit/**`，修复前请以最新源码复核 A-2/3-1 两条积木级结论。

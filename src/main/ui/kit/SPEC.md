# Launcher UI Kit 规范（SPEC）

> **本文是 `@ui/kit` 覆盖范围内唯一权威的设计规范。**
> `DESIGN.md` 只保留通用原则与历史坑位记录；两者冲突时**以本文为准**（冲突处见 §12）。
> 规范不是抄来的：下面每个数字都是本项目实测得到的（Electron + xvfb 量真组件），
> 不是从任何外部文档引申的。后来者改 kit 之前先读本文。

## 1. 网格单位与间距阶

| 令牌                 | 值   | 说明                                             |
| -------------------- | ---- | ------------------------------------------------ |
| `GRID.unit`          | 4px  | 基础单位。一切尺寸都是它的整数倍，肉眼可对齐     |
| `GRID.gutter`        | 8px  | 栏距 / 区块间距（= 2 单位）                      |
| `GRID.radius`        | 12px | 卡片圆角（= 3 单位）；控件内圆角 8px（= 2 单位） |
| `GRID.pad`           | 12px | 卡片内边距（= 3 单位）                           |
| `GRID.touch`         | 40px | 触控热区下界（= 10 单位）                        |
| `GRID.controlHeight` | 36px | 文字按钮高度（= 9 单位）                         |
| `GRID.iconHeight`    | 32px | 图标按钮高度（= 8 单位）                         |
| `GRID.inputHeight`   | 44px | 输入类控件高度（= 11 单位）                      |

**间距阶**（从紧到松）：`grid(1)=4`（同组元素内）→ `grid(2)=8`（栏距 / 区块间距起步）
→ `grid(3)=12`（卡片内边距 / 分区之间）→ `grid(4)=16`（页面级分组）。
「一个网格单位」= 4px；需要呼吸时用一档间距（8px），不要把两者混为一谈。

## 2. 密度阶（实测数字）

| 档位                               | 控件高（实测）                                         | 字号      | 用在哪                      |
| ---------------------------------- | ------------------------------------------------------ | --------- | --------------------------- |
| `input`（独立表单 / 对话框）       | **44px**（text/select/slider/switch/stepper 全部一致） | 0.875rem  | KitFormDialog、独立大表单   |
| `inline`（**KitSettingRow 默认**） | **35px**（四类控件全部一致）                           | 0.875rem  | 设置行：一行文字 + 一个控件 |
| `tight`（窄屏 ≤720px）             | inline 28px / input 36px                               | 0.8125rem | 手机上的密集区              |

实测备注（Electron + uiScale 1.1 下量到）：

- Vuetify compact 的输入框自然高度就是 44px。**不要用 `min-height` 去压它**
  （实测压到 36 得到 39.4 的四不像；给 outlined field 再加一圈 border 会变成 46）——
  五类控件统一落在 44px 的办法是不碰内部高度，只把 switch / slider 拉到同一档。
- `inline` 档 = 文字行高（24px）+ 11px = 35px。窄屏（≤720px）下 inline 仍是 35px——
  Vuetify 的 field 自带约 8px 纵向 padding，硬压到 28 会把下划线顶掉，不值得。设置行不该出现 44px 的方块：实测输入档 44-48px
  而同行文字行高只有 24px，视觉上下坠一个大方块。inline 用 underlined 细线
  （无 outlined 大盒、无背景块），四类控件（下拉 / 步进器 / 滑块 / 开关）高度一致 = 35px。
- **滑块必须吃满控件槽**：`v-slider` 默认没有 width/flex，在 flex 容器里按内容宽收缩，
  轨道溢出盒子被 `.kit-row-item` 的 `overflow:hidden` 裁掉——用户看到的「右边一个点」。
  实测修前轨道 114px / 控件盒 104px（溢出 10px 被裁）；误加 `width:100%` 反而塌成 0
  （父盒本身是内容宽的，百分比解析为 0）。正确做法：`.kit-control--fill { flex: 1 1 auto }`
  让**根盒**先吃满槽，滑块再 `flex: 1 1 auto`。修后轨道 = 控件槽全宽。
- **覆盖 Vuetify 内部结构前先读它的 sass/jsx**：`.v-field__append-inner` 自带
  `padding-inline-start: var(--v-field-padding-after)` 和 `align-items: flex-start`，
  `.v-field.v-field--variant-underlined .v-field__append-inner` 的特异性是 (0,3,0)——
  比 `.kit-control--num .v-field__append-inner` 的 (0,2,0) 高，两级选择器压不住它；
  而 `.v-field__input` 这个类 Vuetify 是加在 `<input>` **本身**上（不包一层 div），
  写成 `.v-field__input input` 的后代选择器永远不匹配。这三件事都踩过，全部记录在
  kit.css 对应规则的注释里。
- **Vue 会把缺席的 Boolean prop 铸成 `false`**：「默认开」的开关（如 `fill`）必须用
  `withDefaults(defineProps<…>(), { fill: true })` 声明默认值，否则默认是关的（踩过）。

## 3. 字号阶与行高

| 用途               | 字号                       | 行高 |
| ------------------ | -------------------------- | ---- |
| 标题（KitTitle）   | 1rem / 次级 0.9375rem      | 1.4  |
| 正文（KitProse）   | 0.875rem                   | 1.6  |
| 说明（KitCaption） | 0.75rem                    | 1.5  |
| 提示行（KitHint）  | 0.8125rem                  | 1.55 |
| 输入文字           | 0.875rem（窄屏 0.8125rem） | —    |
| 数值               | 0.9375rem + `tabular-nums` | —    |

窄屏（≤720px）标题降一档、正文降到 caption 档、代码与 import 行降一档——**降档是响应式的，
不是「塞不下就缩小」的借口**（见 §10 启发式）。

## 4. 表面与玻璃令牌

`useKitSurface()` 把设置 → 外观的 `window.fuseAlpha` / `window.fuseBlur`
（订阅 `cockpit:config-changed`，改动即时跟随）写成四个变量，**所有 kit 表面只用这组**：

| 变量                | 值                                                 |
| ------------------- | -------------------------------------------------- |
| `--kit-glass-alpha` | `fuseAlpha`（默认 1 = 不透，保持旧观感）           |
| `--kit-glass-blur`  | `fuseBlur`（`window.blur=off` 或窄屏 auto 时为 0） |
| `--kit-surface`     | `var(--v-theme-surface)`（主题切换自动跟随）       |
| `--kit-border`      | `rgba(var(--v-theme-on-surface), 0.12)`            |

阴影阶：浮层 `0 8px 24px rgba(0,0,0,.28)`；卡片不加阴影（用边框分层）。
**不要各写各的 `backdrop-filter`**；首帧同步写默认值，避免「没有背景色」的一帧。

## 5. 断点令牌

`BREAKPOINTS = { sm: 600, md: 960, narrow: 720 }`——kit 唯一一套。
仓里原有 480/520/560/600/640/720 六种并存，后续迁移都引用这三个常量，不要再手写魔数。
`narrow`（720）是与外壳（侧栏、容器 px-3）一致的兼容值；容器语义用 `useContainerWidth()`
（带 8px 滞回），不要拿视口断点假装容器断点。

## 4.5 行内对齐（默认 center + 可覆盖）

**硬规则：一行之内，所有元素共享同一条中线**——文字、输入、下拉、滑块、开关、chip、
图标按钮、右侧数值，几何中心落在同一条水平线上，**偏差 ≤ 1px**。
「一行」按**视觉行**（flex line）算：换行的行里每条 line 有各自中线，拿整个容器当参照
会把正常换行的元素误判成没对齐（实测 232px 档因此误报 22px）。

**机制（一条规则治一类的，不要三条治三个）**：Vuetify 的 `.v-field` 是
`display:grid`，`grid-template-areas: "prepend-inner field clear append-inner"`
（VField.sass:12-19），各 variant 再把 affix 改成 `flex-start`
（underlined/plain 在 :195-201）——单位、前后置图标、clearable 全部贴顶。
正解是在 **field 根节点**定对齐：

```css
.kit-control .v-field {
  align-items: var(--kit-field-align, center);
}
```

这一条同时治好单位、前置/后置图标、clearable 和以后加的任何 affix。
行/元素用 CSS 变量链传递：`--kit-row-align`（行）→ `--kit-item-align`（元素）→
`--kit-field-align`（控件内部），缺省全部回落 `center`。

**覆盖（默认 + 可覆盖）**：`KitSmartRow` / `KitRowItem` / `KitSettingRow` / 控件层
（KitTextField / KitSelect / KitSlider / KitSwitch / KitNumberStepper）都有同一个 prop：

```ts
align?: 'center' | 'start' | 'end' | 'baseline' | 'stretch'   // 缺省 'center'
```

`KitSettingRow` 会把 align 透传到控件插槽（`<slot :size :align>`），否则调用方传了也没用。
覆盖必须是少数、有理由、看得见的：只有多行文字、顶部对齐的图标+两行说明这类场景才传，
且**布局自检会把偏离行默认对齐模式的元素标成另一种颜色并注明 align 值**（默认的只描边）。

**自检**：`KitDebugOutline mode="align|both"`（默认关）逐视觉行量每个子元素的几何中心
vs 行中线，偏差 >1px 标黄、覆盖默认对齐的标紫，偏差值写在 `data-kit-align-dev` 里。
实测（Electron + uiScale 1.1）：gallery 三档（480/320/232）+ 真实设置页窗口分区
共 17 条视觉行 43 个元素，**偏差全部 0px**。

## 6. 控件尺寸表（实测，排查裁剪的入口）

| 控件                      | 自然宽度                                         | kit 默认 kind          | 要显式 minWidth 吗      |
| ------------------------- | ------------------------------------------------ | ---------------------- | ----------------------- |
| `v-switch`（compact）     | 28px（wrapper；轨道 36px 会溢出 wrapper 4px/侧） | `control` 88           | 不用（别低于 40）       |
| `v-switch`（默认密度）    | 40px                                             | 同上                   | 不用                    |
| `v-slider`                | 百分比宽（弹性）                                 | `slider` 120 / 手机 88 | 不用（低于 ~88 不好用） |
| `v-select`                | 百分比宽；min-content ≈ 70px                     | `control` 88           | 要（内容长时给 120+）   |
| `v-text-field`            | 百分比宽；min-content ≈ 60px                     | `number` 64            | 要（内容长时给 80+）    |
| `v-btn` `size=small icon` | 50px（CSS `min-width`）                          | `icon` 40              | 要（给 56+）            |
| `v-btn` 文字 + 图标       | min-width 64 + 文字                              | `control` 88           | 要（按文字长度）        |
| `v-chip`                  | 文字 + 16px 内边距                               | `label` 估算 + 8       | 要（自绘 chip 一定量）  |
| 自绘 chip / 徽标          | **必须实测**                                     | —                      | 要                      |

声明下限是个谎言时元素会被 `overflow:hidden` 裁一截（实测：自绘 chip 声明 46、自然 49
→ 右缘切 3px）。引擎两道防线：规划前 `applyNaturalFloor` 把刚性元素下限抬到实测自然宽度；
应用后再做「溢出复核」把仍被裁的标成刚性重规划。

## 7. 80% 内容率

```
占比 = max(内容宽/容器宽, 内容高/容器高)
≤ 80%  → roomy     （理想）
≤ 100% → tight     （还够用，但没呼吸）
> 100% → overflow  （必须降档）
```

`fit.ts`（纯函数）+ `useFitBox`（RO 测量）自动化：超 80% 把字号/内边距乘 `fitScale`
（0.5 下限——再夸张也只压一半，其余按 fit 状态藏次要信息）。
圆形 stat 是样板：**直径 = 文本宽高 × 1.25**（即文字占 80%），夹在 min/max 之间。

## 8. 触控热区与纯图标按钮

- 触控热区 ≥ 40px（`GRID.touch`）；`v-btn size="small"` 只有 ~32px，用内边距补足。
- **纯图标按钮必须 `aria-label` + `title`**（AI inspector 只认这两个拿 ref）。
- 文字按钮默认密度；`size="small"` 只留给图标按钮。

## 9. 空状态 / 三态 / 动效 / 无障碍

- **空状态**：一律 `KitEmpty`（`v-empty-state` 薄封装，观感由 global.css 统一），
  语义 icon 表在里面；不要手写大图标。
- **三态**：loading / error / empty 走 `useAsyncState` + `KitAsync`（接 `useLoading` 的状态
  与 `LoadingBar` 的视觉，不写第三套原语）。loading 用 2px 顶条，不用居中转圈。
- **动效**：跟随 `animations.modernMotion`，关闭时全关（`<html>` 加 `motion-off`）。
- **无障碍**：纯图标按钮 aria-label + title；揭示隐私的按钮加 `v-privacy-action`；
  焦点序按 DOM 序（kit 用 CSS `order` 调视觉序，不搬家 DOM，焦点不受影响）；
  文字对比度取 `--v-theme-on-surface(-variant)`，不写死 hex。

## 10. 启发式：空间冲突时怎么决策

优先序（从温和到激烈）：

1. **缩小**：内容压到声明下限为止（省略号 / 滑块变短）。**不缩小字号来逃避布局问题。**
2. **隐藏**：tertiary → secondary（primary 永不隐藏）。隐藏不静默消失——收进行尾「⋯」
   浮层，功能可达。
3. **换行**：还装不下才换行。

什么时候允许破例：用户明确要「一屏看完」的工具条（可隐藏 secondary）；
真·全幅画布（canvas 模式，内部区域各自滚）。破例要在组件注释里写理由。

## 11. 页面外壳

`KitPage mode="document|app|canvas"`：

- `document`：正常文档流，整页滚（长表单）。
- `app`：`position:absolute; inset:0` 铺满宿主可视区，页面级零滚动，内部区域各自滚
  （`KitSection scroll` → `flex-grow-1`）。
- `canvas`：同样 `absolute; inset:0`，内部区域按内容高度排、最多占外壳一半、超出自行内滚；
  内容真的超过视口时外壳才滚（两个滚动条都在）。

**为什么是 `absolute; inset:0` 而不是 `calc(100vh - 96px)`**：那个 96 是「appbar 高 +
容器 padding」的魔数，appbar 实测 55px（不是 48/64），魔数壳就短一截。绝对定位不依赖任何
魔数，键盘弹出时也跟着可视区收。高度计算一律 `var(--app-vh)`，不写裸 `100vh`。

## 12. 参考实现（迁移照抄这个结构）

`src/abilities/mirror/View.vue` 是第一个整体迁到 kit 的内容页，后续 ability 迁移照它抄：

```vue
<KitPage mode="document|app|canvas">
  <KitSection :title="…" icon="mdi-…">
    <template #actions><v-btn …>操作</v-btn></template>
    <KitSettingRow v-model="x" label="…" :min :max unit="…" />   <!-- 数值型 -->
    <KitSettingRow label="…"><KitSwitch v-model="y" aria-label="…" /></KitSettingRow>  <!-- 自定义控件 -->
    <KitEmpty v-if="!list.length" kind="list" :title :text />    <!-- 空态 -->
    <KitGrid :min-col="260"><v-card v-for=…>…</v-card></KitGrid>  <!-- 卡片网格 -->
  </KitSection>
</KitPage>
```

要点：分区外壳 `KitSection`、设置行 `KitSettingRow`、控件一律控件层、空态 `KitEmpty`、
多列 `KitGrid`；`toMarkdown` 深导出、翻译键、`v-privacy` / `v-agent-forbidden`、
`aria-label` 全部保留；**导航结构 / keep-alive / 返回链不动**。

## 13. 与 DESIGN.md 的冲突（kit 赢）

| #   | DESIGN.md 原表述                              | kit 规范                                                     | 理由（实测）                                                               |
| --- | --------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 1   | §4.6「必须 `calc(100vh - 96px)`」             | `absolute; inset:0` 铺满宿主可视区                           | appbar 实测 55px，魔数口径必短一截；`bili/View.vue` 的注释早就记了这件事   |
| 2   | §3「区块间距 ≥8px 底线」（据此否掉 4px 单位） | 间距阶自己定：4px 单位 → 8px 栏距 → 12px 卡片 → 16px 页面    | 「一个网格单位」= 4px 是用户原话；8px 是**栏距**不是底线，两者是阶不是竞争 |
| 3   | §1.3「chip 默认密度 + 显式 padding-block」    | chip 内边距由 global.css 全局统一，kit 的 `KitChip` 是薄封装 | 32 处页面在重复写同一条规则，是冗余不是缺原语                              |

DESIGN.md 开头已加指向：凡 kit 覆盖的范围以本文为准。

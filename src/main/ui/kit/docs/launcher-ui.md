# Launcher UI Kit（`@ui/kit`）

> 内置 UI 库，框架代码（`src/main/ui/kit/`），**不是 ability**。导入路径 `@ui/kit`。
> 每个积木都写清「什么时候用 / 不要用什么」；规范依据是 `DESIGN.md`（§3 尺寸底线 /
> §4 常见误区 / §6 检查清单 / §7 空状态）与 `AGENTS.md` 的「UI 写法要求」。
>
> **第一批（本次交付）**：排版引擎 + 布局地基（KitPage / KitSection / KitSmartRow /
> KitRowItem / KitRowGroup）+ 设置行特化（KitSettingRow / KitNumberStepper）+
> 测量原语（useAdaptive / useContainerWidth / useNarrow）。
> 其余积木（KitToolbar / KitEmpty / KitChip / KitTree / KitFormDialog / useAsyncState）
> 与设置页 gallery 在后续批次，本文档随批次扩充。

---

## 0. 三条总原则

1. **规范内建成默认值，不让页面作者记住。**chip 内边距、空状态观感、文字按钮密度、
   窄屏边距 12px——这些都已经在 `global.css` 里全局统一（见 DESIGN §7 / §4.7），
   kit 组件直接用，页面**不要**再写一遍。
2. **组件不许 import electron。**宿主能力（窗口 / 文件 / 剪贴板）用
   `window.cockpit.hasCap(...)` 降级，保证无头网页（`src/headless/`）与安卓 WebView 可用。
3. **隐私与无障碍必须透传。**`v-privacy` / `v-agent-forbidden` 加在调用方自己的元素上
   照样生效（kit 不隔断指令继承）；纯图标按钮一律 `aria-label` + `title`
   （AI inspector 只认这两个拿 ref）。

---

## 1. 排版引擎（`layout/engine.ts`，纯函数、无 DOM、可单测）

### 1.1 元素的大小怎么确定

核心原则：**规划用「下限」，运行用「实测」，CSS 兜底。**

| 层次                     | 是什么                                                   | 谁负责                                  |
| ------------------------ | -------------------------------------------------------- | --------------------------------------- |
| **下限（minWidth）**     | 「低于这个宽度该元素就不可用」。**不是**「它将会是多宽」 | `resolveItemWidth` 解析后喂给 `planRow` |
| **实测（naturalWidth）** | 首帧 ResizeObserver 量到的自然宽度                       | `KitSmartRow` 回填，grow-only 缓存      |
| **实际宽度**             | flex-basis / flex-shrink / flex-grow 在运行时的结果      | CSS（浏览器）                           |

规划函数只回答一个问题：**按下限装，这一行装得下吗。**这让 `planRow` 保持纯函数、
可单测、无 DOM，也让「JS 完全不工作页面也可用」成立（ KitSmartRow 先按自然尺寸渲染，
实测后再重规划）。

### 1.2 下限从哪来：声明 > 实测缓存 > 内容推导

1. **显式声明**：`<KitRowItem :min-width="120">`，作者说了算（只用于特殊控件）。
2. **实测缓存**：首帧量到自然宽度后
   `minWidth = clamp(naturalWidth × 0.6, 类型下限, naturalWidth)`
   ——元素最多可被压到自然宽度的 60%，但不低于该控件类型的可用底线。
3. **内容推导**（没声明也没实测时自动算，纯函数 `deriveMinWidth`）：

   | 类型                     | 推导                                                                 | 类型下限 |
   | ------------------------ | -------------------------------------------------------------------- | -------- |
   | `label`（文字）          | 字数 × 字宽 + 图标 20 + 间距 8 + 内边距 8；CJK 全角 1em、拉丁 0.55em | 32       |
   | `slider`                 | 桌面 120 / 手机 88                                                   | 88       |
   | `number`（数值框）       | 64                                                                   | 56       |
   | `icon`（图标按钮）       | 40                                                                   | 40       |
   | `control`（开关 / 选择） | 88                                                                   | 64       |
   | `custom`                 | 0（纯弹性）                                                          | 0        |

   → **作者默认不需要手填任何数字。**

### 1.3 API

```ts
// 规划（纯函数）
planRow(items: RowItem[], availableWidth: number, opts: { gap: number })
  → { lines: RowItem[][]; hidden: string[] }

// 下限解析 / 推导 / 签名 / 滞回（都是纯函数，都有单测）
resolveItemWidth(item: RowItemInput, { narrow }) → number
resolveRowItems(inputs, availableWidth, { narrow }) → RowItem[]   // 顺带夹到可用宽度内
deriveMinWidth(item, { narrow }) → number
estimateTextWidth(text, fontSize?) → number
groupMinWidth(items, gap) → number          // Group 的规划宽度
planSignature(items) → string               // 结构签名
shouldReplan(prev, next, threshold = 8) → boolean
rowSlots(result) → { id, order, visible }[] // 摊平成排版指令
```

### 1.4 算法：贪心装行 + 事务性腾位 + 换行

```
for 每个规划单元（单元素，或 KitRowGroup 捆成的一组）:
    当前行放得下？                     → 放进去
    放不下 → findRoom() 事务性腾位:
        候选 = 待放单元尾部 + 当前行尾部里所有非 primary 元素
        全局按优先级从低到高（tertiary → secondary）逐个隐藏，每隐藏一个就重新试
        同级时「待放单元自己的尾部」优先——新元素的次要部分先让位，
        已经渲染出来的内容不闪动（这就是「把该行尾部低优先级元素移入 hidden 腾地方」）
        腾成了 → 提交隐藏，元素进当前行
        腾不成 → 分文不取，直接换行（不丢内容）
    换到空行还装不下:
        是 Group  → 拆成单个元素各自竞争（保留内容，不整组消失）
        单元素   → 独占一行（引擎不因宽度隐藏内容；调用方已夹取，CSS 收缩兜底）
```

- **`primary` 永不隐藏**（宁可换行）；`tertiary` 最先被隐藏。
- **事务性**：腾位失败不提交任何隐藏——不会出现「为了腾地方把行尾元素藏了，结果还是换了行」的双重损失。
- **元素自身超出可用宽度**（`minWidth > availableWidth`）：`primary` 独占一行（调用方负责夹取宽度，
  `resolveRowItems` 已做，CSS `flex-shrink` 再兜底）；`secondary` / `tertiary` 本来就装不下，
  藏掉好过溢出（隐藏先于换行）。
- **不变量**（随机输入 300 轮单测覆盖）：任何输入下不丢元素（每个 id 要么在 `lines` 要么在 `hidden`）；
  除「primary 自身超宽」外每一行宽度都不超过 `availableWidth`。

### 1.5 策略顺序图（空间不够时，从温和到激烈）

```
        空间不足
           │
           ▼
  ┌──────────────────┐
  │ 1. 缩小（CSS）    │  grow 元素 flex-shrink 到各自 minWidth；文字 ellipsis；
  │                  │  行进入 tight 态，调用方可据此降一档密度
  └──────────────────┘
           │ 还装不下
           ▼
  ┌──────────────────┐
  │ 2. 隐藏（引擎）   │  tertiary → secondary 依次隐藏（primary 永不隐藏）
  │                  │  隐藏不静默消失：收进行尾「更多」浮层，功能可达
  └──────────────────┘
           │ 还装不下
           ▼
  ┌──────────────────┐
  │ 3. 换行（引擎）   │  [名字] 单独一行，[slider][数值] 下一行
  └──────────────────┘
```

不缩小字号来逃避布局问题（DESIGN §1.2）：「缩小」= 内容压缩到声明下限为止，
下限就是「不变形的最小宽度」。

### 1.6 什么时候需要手填 minWidth

| 场景                                         | 要不要填                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| 名字 / 标题 / 说明文字                       | 不填（`kind="label"` + `text`，自动按 ch 估算；要省略号加 `truncate`） |
| 滑块 / 数值框 / 图标按钮 / 开关              | 不填（类型默认值 + 手机档更窄）                                        |
| 固定尺寸的自定义控件（自定义按钮组、缩略图） | 填                                                                     |
| 一行里有多个弹性文字（只能有一个吃剩余空间） | 给非主角的那个填下限                                                   |
| 元素内容会动态变化（长度不稳定）             | 填（实测缓存不会跟着内容缩短）                                         |

---

## 2. 布局地基

### 2.1 `<KitPage mode="document|app|canvas">`

| 模式       | 行为                                                                                                                           | 什么时候用                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `document` | 正常文档流，整页垂直滚动，沿用宿主 `v-container` 边距（窄屏 px-3）                                                             | 设置类长表单、apps 列表                              |
| `app`      | `position:absolute; inset:0` 铺满宿主可视区，**页面级零滚动**，内部区域各自滚（`flex-grow-1`）                                 | 聊天 / 日志 / 控制台：固定顶栏 + 可滚内容 + 固定底栏 |
| `canvas`   | 同样 `absolute; inset:0`，内部区域按内容高度排、最多占外壳一半、超出自行内滚；内容真的超过视口时外壳才滚（**两个滚动条都在**） | ft / dashboard / 地图类全幅页面                      |

**为什么是 `absolute; inset:0` 而不是 `calc(100vh - 96px)`**：那个 96 是
「appbar 高 + 容器 padding」的魔数，appbar 实测高度会变（`bili/View.vue` 的注释记录
实测 55px，不是 DESIGN §4.6 口径的 48/64px），魔数壳就短一截。绝对定位不依赖任何魔数，
键盘弹出时也跟着可视区收。高度计算一律走 `viewport.ts` 的 `--app-vh`，**不写裸 `100vh`**。

- app / canvas 是**通栏**外壳（不等宿主容器边距）：内部区域自己给内边距。
- 挂载期间把宿主 `.page-host` 的 `min-height` 临时置 0（否则外壳下面多一条空滚动条），
  离开时还原（`settings/View.vue` 同款机制）。
- props：`mode` / `maxWidth`（可读行宽，bili SubPage 用 960）/ `gutter`（自己负责左右边距，
  窄屏 12px——DESIGN §3 的 px-3，不是 px-2；宿主 `v-container` 已给准时不用传）。

> **给 DESIGN.md §4.6 的修订建议（本轮只记录，未改 DESIGN.md）**：
> §4.6 现在写「必须 `calc(100vh - 96px)`」，建议改为「**必须铺满宿主可视区且外壳不出滚动条，
> `absolute inset:0` 是首选写法**」——魔数口径与 appbar 实测高度不符（见上）。

### 2.2 `<KitSection>`（分区卡片）

标题 + 操作插槽 + 默认插槽，统一 `padding-block: 12px`（py-3，DESIGN §3）。
操作区 `flex-wrap` 兜底（DESIGN §4.2）。`scroll` 插槽 prop 把本区变成内部滚动区，
行为随 KitPage 的模式切换（app = `flex-grow-1` 吃满；canvas = 内容高度 + 内滚；
document = 正常流）。

### 2.3 `<KitSmartRow>`（行级智能排版）

```vue
<KitSmartRow label="主音量" hint="0-100" :gap="8">
  <KitRowItem kind="label" text="主音量" truncate grow>主音量</KitRowItem>
  <KitRowItem><v-slider … /></KitRowItem>
  <KitRowItem kind="number" priority="secondary">{{ volume }}%</KitRowItem>
</KitSmartRow>
```

工作循环（对应「规划用下限、运行用实测、CSS 兜底」）：

1. 先按自然尺寸渲染（CSS flex + `min-width:0` + `flex-wrap`）——JS 完全不工作页面也可用；
2. ResizeObserver 观察**容器与每个子元素**，rAF 里批量读宽度（先读后写，避免 layout thrash）；
3. 用实测宽度 + 声明下限调 `planRow`，得到 `{ lines, hidden }`；
4. 应用：`hidden` 的元素 teleport 进行尾「更多」浮层（`overflow="none" 时退化为 display:none）；
`lines`决定元素落到第几行——用 CSS`order` 应用，**不搬家 DOM**（keep-alive / 焦点 / v-model 不受影响）；
5. **滞回**：宽度变化 <8px 或结构没变就不重规划（`useContainerWidth` 与 `shouldReplan` 双层）。

**绝不横向溢出**：规划保证 `Σ(下限) + gap ≤ 可用宽度`；CSS 的 `flex-shrink:1 + min-width:0`
再兜一层（规划过期的那几像素只会收缩，不会出滚动条）。

props：`label` / `hint` / `gap`（引擎与 CSS 用同一个值）/ `overflow`（`'menu' | 'none'`）/
`align`（`'center' | 'start'`）。

### 2.4 `<KitRowItem>` / `<KitRowGroup>`

`KitRowItem`：包住一个控件，声明 `priority`（默认 `primary`，永不隐藏）/
`minWidth`（下限，缺省自动）/ `kind` / `text` / `icon` / `grow`（缺省：没声明 minWidth 的
元素默认可生长，吃掉剩余空间）/ `truncate`（文字省略号）。排版指令由父行注入，只负责应用。

`KitRowGroup`：把若干元素捆成一个规划单元——**Group 内部争取同一行**
（组宽 = 成员 minWidth 之和 + 成员间 gap），Group 之间才竞争空间。
这样 `[名字][slider][数值]` 作为一个设置项整体进出，不会被拆散。
纯标记组件，不产出 DOM 元素。

### 2.5 三个必须演示的用例

| 用例                                | 宽度                 | 结果                                  |
| ----------------------------------- | -------------------- | ------------------------------------- |
| `[名字][slider][数值]` 一行搞定     | 1280 / 720           | `[名字][slider][数值]` 同一行         |
| 窄屏智能退化两行                    | 390 且 name 实测 200 | `[名字]` 换行 `[slider][数值]`        |
| 数值框标 secondary 时移动端自动隐藏 | 184（手机档）        | `[名字][slider]` + 数值进「更多」浮层 |

以上三档在 `engine.test.ts` 里都有**纯函数断言**（`planAt(1280/720/390, …)`），不需要真机。

---

## 3. 设置行特化

### 3.1 `<KitSettingRow>`

设置行 `[名字] [控件] [数值]`，`KitSmartRow` 的设置页特化。仓里这个模式有 140 处
`justify-space-between`、同一份模板在同一个文件里抄 4 遍（`settings/items/WindowSection.vue`），
这里是唯一一份。直接挂进现有设置页网格（`components/SettingsCategoryView.vue` 的
`v-row/v-col md=6`），**不需要改 `settings/View.vue`**。

两条内置硬禁令（都来自 bili 已踩过的坑）：

1. **设置页禁止通栏 `v-slider`**（可见宽度 >320px 即违规）——默认渲染 `KitNumberStepper`，
   slider 要显式 `slider` opt-in，且只在宽屏出现；
2. **移动端默认给步进器不给滑块**——窄屏下即使 opt-in 也回落成步进器。

props：`label` / `value` / `desc` / `hint` / `controlWidth` / `secondary`（整行可被隐藏）/
`modelValue` + `min` + `max` + `step` + `unit`（数值型行）/ `slider` / `hideValue`；
slot `default` = 自定义控件。

### 3.2 `<KitNumberStepper>`

`− [ 42 % ] +`。**文本框只当草稿**：打字中途不夹取（否则打 "60" 会被 "6"→min 的钳制吃掉），
失焦 / 回车 / ± 才夹取落值——下发的补单因此永远合法（语义照
`bili/components/settings/DutySection.vue` 的 `makeStepper`，仓里第五份重复实现收敛到这一份）。
± 是图标按钮（DESIGN §1.3 允许 `size="small"`），触控热区补到 40px。

---

## 4. 测量与断点原语

```ts
const { narrow, sm, md, viewportWidth, display } = useAdaptive() // 断点 + Vuetify display
const { target, width } = useContainerWidth() // 容器宽度（带 8px 滞回）
const narrow = useNarrow(720) // 窄屏判定（bp 可传 Ref）
appVh() // 读 --app-vh（不写裸 100vh）
```

- **断点令牌只有一套**：`BREAKPOINTS = { sm: 600, md: 960, narrow: 720 }`。
  仓里现存 480/520/560/600/640/720 六种并存，后续能力迁移都引用这三个常量，不要再手写魔数。
  `narrow`（720）是与全站（App.vue 侧栏、`v-container` 的 px-3）一致的兼容值。
- `useContainerWidth` 消灭仓里十几份逐字重复的 ResizeObserver（bili 抄 3 遍、yaya 6 处、
  yarj 的 `useYarjCompact` 被 8 个组件各调一次）；带滞回：变化 <8px 不更新，
  防止缩放窗口 / 键盘弹出时反复横跳。
- `useNarrow(bp)` 消灭 7 处手写 `matchMedia('(max-width: 720px)')`。
- `useAdaptive` 包 `viewport.ts`（保证 `--app-vh` 已安装，幂等）+ Vuetify `useDisplay`。

---

## 5. 禁止事项（写给页面作者）

- 不要给文字按钮 / chip 加 `size="small"`（DESIGN §1.3 / §4.1；`global.css` 已全局兜底）。
- 不要再写一遍 chip 的 `padding-block:4px; min-height:24px`（`global.css:611-615` 已统一）。
- 不要手写大图标空状态，用 `<v-empty-state>`（DESIGN §7）。
- 不要写裸 `100vh` / `calc(100vh - Npx)`，用 `KitPage` 或 `var(--app-vh)`。
- 不要让 kit 组件 import electron；宿主能力一律 `window.cockpit.hasCap(...)` 降级。
- 纯图标按钮必须 `aria-label` + `title`。

---

## 6. 待补积木（后续批次）

`KitToolbar`（从 `yaya/components/plugin-kit/DiagramFrame.vue` 上移，含「容器 <520px 收进 ⋮」）/
`KitEmpty`（`v-empty-state` 薄封装 + actions 插槽 + 语义 icon 表）/
`KitChip`（薄封装）/ `KitJsonTree`（四份合一：toolbox / playground / yarj）/
`KitFormDialog`（桌面居中 + 窄屏 bottom-sheet）/ `useAsyncState` + `KitAsync`
（把 `LoadingBar.vue` 的视觉与 `useLoading.ts` 的状态接上，**不写第三套状态原语**）/
设置页「UI 库」gallery 分类。

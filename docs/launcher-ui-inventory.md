# Launcher UI 组件化清单（launcher-ui inventory）

> **性质**：只读调查 + 一份新文档。**未改任何 `.vue` / `.ts`，未 commit，未动 `.gitignore`**。
> 目标读者：要在 `src/main/ui/kit/`（别名 `@ui/kit`）里搭内置 UI 库的人。
> 规范依据：`DESIGN.md`（§3 尺寸底线 / §4 常见误区 / §6 检查清单 / §7 空状态）。
> 证据分级：**【实证】**= 逐行读过；**【grep】**= 全文检索命中、位置精确但未逐行读上下文；**「待确认」**= 需实机/实拍。

---

## 0. 对任务前提的三处校正（先说，避免照着错前提开工）

1. **`src/abilities/settings/items/` 实为 15 个 `.vue`，不是 16 个**（另有 `shortcut-icon.ts`，非组件）。
2. **`display` / `help` / `privacy` / `inspector` / `background` 五个 ability 没有 `View.vue`**（纯后端：目录里只有
   `commands.ts` / `index.ts` / `meta.ts` / `package.json` / `translations`），**无 UI 可清点**。
   所以可清点的页面 = 18 个 `View.vue` + aidj 的 `PlayerView.vue` / `LyricsView.vue`。
3. **「balance/View.vue 31 处、scripting/View.vue 26 处文字按钮 `size="small"`」不成立**。
   逐块判定（有 `icon=` 即图标按钮）后：两文件的 `size=` 全部落在 `<v-btn icon=…>`、`<v-icon size>`、
   `<v-chip size>` 上，**文字按钮 0 处，按 DESIGN §1.3 合规**。
   `scripting/View.vue` 自己还写了注释（`:1004`「New Script (Icon-only allowed size="small")`、`:1486`「Console Icon Tools (size="small" allowed for icons)」）。
   全库真实的文字按钮违规只有 **6 处**，见 §5.1。

> ⚠️ 另有子报告引用了 `docs/ui-density-rework-report.md` 作为出处——**该文件不存在**（`ls` 确认）。
    凡以它为据的结论（如「x-small chip 是已记录的规范空洞」）本文改以自行检索的证据重新表述，不引用不存在文档。

---

## 1. kit 的起点：框架里已经有什么

搭 kit 前先知道哪些不用重造（均在 `src/main/ui/`）：

| 已有 | 位置 | 与 kit 的关系 |
| --- | --- | --- |
| **`LoadingBar.vue`** | `components/LoadingBar.vue:1-28` | **`KitAsyncState` 的现成视觉骨架**：`loading` / `error` / `skeleton` / `skeletonType` 四 prop，内含 `v-progress-linear` + `v-skeleton-loader` + `v-alert`。**已有 6 个能力在用**（apps / autostart / balance / dashboard / discoverer / systemd） |
| `useLoading()` | `composables/useLoading.ts:11-33` | **`useAsyncState` 的状态机底座**：`loading` / `error` / `run()` / `clearError()`。**全仓仅 1 个消费者**（`src/abilities/bili/components/chat/useChatSession.ts:50`，还只是注释提及） |
| `SettingsCategoryView.vue` | `components/SettingsCategoryView.vue:110-125` | 设置项已按 `v-row/v-col md=6` 网格渲染，`item.fullWidth` 占 12 列 → **`KitSettingRow` 可直接挂进这个网格，不动 `settings/View.vue`** |
| `SettingsDialog.vue` / `ExportTargetDialog.vue` | `components/` | 对话框外壳先例 |
| `global.css` 的 `.v-chip` 规则 | `styles/global.css:611-615` | **已全局统一 chip 内边距**（`padding-block:4px; min-height:24px; height:auto`）→ 各页再写一遍是冗余（§5.2） |
| `global.css` 的 `.v-empty-state*` 规则 | `styles/global.css:626-680` | §7 观感已统一，`KitEmpty` 应是薄封装（补 actions 插槽 + 语义 icon 表） |
| `global.css` 的文字按钮兜底 | `styles/global.css:279-286` | compact 下文字按钮恢复 36px，所以**页面里不该再出现文字按钮 `size="small"`** |
| `v-privacy` / `v-agent-forbidden` / `long-press` | `privacy.ts`、`directives/long-press.ts` | kit 组件必须透传（否则 AI 快照/隐私脱敏在 kit 页面失效） |
| `--app-vh` 视口变量 | `viewport.ts:51` | 所有高度计算用它，**不要写裸 `100vh`** |
| `useNavStack` / `useScrollMemory` | `back-nav.ts`、`composables/scroll-memory.ts` | `KitPage` 的 app 模式要能挂；scroll-memory 已被 yaya 3 处复用 |
| `holdHost()`（settings 用） | `settings/View.vue:263-266,284,302` | 把宿主 min-height 临时置 0 的机制，`KitPage` app 模式可能需要 |

> **最关键的一条**：`LoadingBar`（视觉，6 个消费者）与 `useLoading`（状态，1 个消费者）**互不相通**——
> `LoadingBar` 不消费 `useLoading`。`useAsyncState` + `<KitAsync>` 就是把这两者接上的那根线，
> 而不是新写第三套原语。

---

## 2. 主表：模式 → 出现处 → 建议积木 → 移动端退化 → 优先级

「出现处」只列最典型几处，全部清单见 §4/§5。

| # | 模式 | 典型出现处（`文件:行号`） | 建议积木 | 移动端退化建议 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 1 | **页壳高度/滚动**（**4 种**手写惯用法） | A `inset:0`：`aidj/View.vue:938-946`、`bili/View.vue:349-357`、`yarj/View.vue:3118-3121`、`yaya/View.vue:2040-2047`；B `height:calc(--app-vh-96px)`：`cli/View.vue:267-270`、`ft/View.vue:656-665`；C `min-height:calc(--app-vh-96px)`：`balance/View.vue:1747,1751`、`balance/components/ProfileManagerView.vue:686`；D `inset:16px`：`settings/View.vue:514-520`、`scripting/View.vue:1764-1774` | **`KitPage`**（`mode: document\|app\|canvas`） | app/canvas 内部滚、外壳不滚；document 正常流 | **P0** |
| 2 | **设置行** `[名字][控件][数值]` | `settings/items/WindowSection.vue:162-165,219-224,237-242,255-258`（同一模板抄 4 遍）、`settings/items/ZoomSection.vue:32-37`、`settings/items/WebHostSection.vue:154-168`、`settings/items/AndroidClientSection.vue:141-173`、`yaya/components/settings/ProviderDetail.vue:135-151`、`bili/components/settings/DmSection.vue:185-260`、`ft/panels/ControlsPanel.vue`、`yarj/components/MapPreferencesSection.vue`；全文 140 处 `justify-space-between` | **`KitSettingRow`**（+ `KitSmartRow` 特化） | 名字与数值换行；控件通栏；**默认给步进器不给滑块** | **P0** |
| 3 | **紧凑数字步进器** | `bili/components/settings/DutySection.vue:337-437`（`makeStepper`）、`DmSection.vue:66-91`、`CompactSection.vue:83-114`、`AsrSection.vue:88-113`（**4 份逐字实现**）、`yarj/components/MapFilesSection.vue:150-170`（`.zoom-stepper`） | **`KitNumberStepper`** | 保持紧凑；± 按钮触控热区 ≥40px | **P0** |
| 4 | **JSON / 树 折叠渲染** | `toolbox/components/JsonTree.vue:21`、`playground/components/FoldingJson.vue:78`、`yarj/components/JsonTreeView.vue:122` + `JsonTreeNode.vue:32` | **`KitJsonTree`** | 缩进 16→12px、字号降档、工具栏换行 | **P0** |
| 5 | **分区卡片** | `components/SettingsCategoryView.vue:110-125`、`bili/components/SubPage.vue:33-65`、yaya settings 12 处（`McpServersPanel.vue:394-398` 等）、bili 17 处（`DmTab.vue:308-363` 等）、playground 5 处（`TransformEditor.vue:218` 等） | **`KitSectionCard`** | `pa-4`→12px、标题不换行 | **P0** |
| 6 | **加载/错误/空 三态** | `components/LoadingBar.vue:1-28`（已有骨架，6 消费者）、`bili` 12 处、yaya settings 4 处（`PluginList.vue:82-107` 等）、`bili/components/settings/*` 6 处 `v-progress-linear v-if="loading"` | **`useAsyncState` + `KitAsync`** | loading 用 2px 顶条（`v-progress-linear`）而非居中转圈 | **P0** |
| 7 | **空状态** | 合规 `v-empty-state` 约 35 处；**手写 25+ 处**：yaya 14 处（全目录 0 处 `v-empty-state`！）、yarj 6 处、scripting 1 处（`scripting/View.vue:1604-1628`，最严重）、playground 6 处、bili 4 处 | **`KitEmpty`** | 图标 56px、标题 0.95rem、说明两行截断 | **P1** |
| 8 | **chip**（状态/统计） | 全文 264 个 `v-chip`；**32 处逐字重复 `padding-block:4px;min-height:24px`**（bili 22 处 9 种类名 + yaya 10 处 `.chip-pad`）；186 个带 `size=small`、约 60 个 `size=x-small` | **`KitChip`** | 统计类 `priority="secondary"` ≤480px 隐藏 | **P1** |
| 9 | **对话框 / 底部弹层外壳** | `:fullscreen="narrow"` 15+ 处；外壳模板 3 套（yaya A/B/C）、bili 9 个 v-dialog **0 个 bottom-sheet**、balance 4 处逐字同构、playground 1 处 | **`KitFormDialog`** | 窄屏 `fullscreen`；**需补 `sheet` 变体**（bili 全缺） | **P0** |
| 10 | **侧边抽屉 / 底部弹层** | `yarj/components/PhotoSideDrawer.vue`、`RouteSideDrawer.vue`、`RoutePlaybackPhotosDrawer.vue` | **`KitDrawer`** | 桌面右 drawer、窄屏 bottom-sheet（85vh） | **P1** |
| 11 | **工具栏**（图标组 + 文字组 + 溢出菜单） | `yaya/components/plugin-kit/DiagramFrame.vue:150-272`（已有「<520px 收进 ⋮ 菜单」）、`aidj/components/WorkflowCard.vue:133-157`、`yaya/components/WorkflowCard.vue:279-307`、bili 卡头 16 处、yaya settings 11 处、settings 6 处 | **`KitToolbar`** | 图标组保留、文字组收「⋯」 | **P1** |
| 12 | **过程卡片 / 时间线** | `aidj/components/WorkflowCard.vue:132-219`、`yaya/components/WorkflowCard.vue:277-449` | **`KitWorkflowCard`** | 头部摘要独占一行（aidj `:259-264` 已做） | **P1** |
| 13 | **窄屏判定 composable** | `matchMedia('(max-width: 720px)')` 手写 **7 遍**：`yaya/components/tree/ConversationTree.vue:471-476`、`plugin-kit/ZoomDialog.vue:122-126`、`ModelSelectDialog.vue:39-43`、`UsageDialog.vue:73-77`、`SelectTextDialog.vue:26-31`、`ImagePreviewDialog.vue:95-97`、`EmojiPanel.vue:42-49` | **`useNarrow(bp)`** | — | **P0**（极低成本） |
| 14 | **行内二次确认** | `yaya/components/settings/ProviderDetail.vue:212-229,302-323`、`McpServersPanel.vue:323-338`、`SkillsPanel.vue:371-388` | **`KitConfirmInline`** | 确认态 `flex-basis:100%` 换行 | **P2** |
| 15 | **媒体查看器（缩放/平移）** | `yaya/components/plugin-kit/ZoomDialog.vue:59-94`、`yaya/components/tree/ConversationTree.vue:200-314`（几乎相同） | **`KitMediaViewer`** | 双指缩放 + 拖动平移 | **P2** |
| 16 | **代码块 `<pre>`** | bili 5 处、yaya 4 处、aidj WorkflowCard `:204,209` | **`KitCodeBlock`** | 字号 0.8rem、padding 8px 10px | **P1** |
| 17 | **复制按钮 + N 秒反馈** | `yarj/components/JsonTreeView.vue:85-95`(2s)、`yaya/plugins/cockpit/SnapshotView.vue:66-75`(1.5s)、`roleplay/RoleplayCard.vue:62-66`(1.6s)、`widget/WidgetView.vue:96-103`(2.4s)、`playground/components/ResponseViewer.vue:113` | **`KitCopyButton`** | — | **P2** |
| 18 | **分块/渐进渲染列表** | `playground/components/BtResponseView.vue:61-91` ≡ `playground/components/FinalResponse.vue:38-68`（CHUNK=40 + sentinel + rootMargin 200px，近乎逐字雷同）；变体 `yaya/plugins/cockpit/CommandsTableView.vue:25-27` | **`KitChunkedList`** | — | **P2** |
| 19 | **列表行原语** | yaya 6 处、bili 6 处、settings 5 套（`BalanceSettingsSection.vue:316-363`、`systemd/View.vue:113-173`、`BootServicesSection.vue:110-163`、`logs/View.vue:445-531`、`ShortcutsSection.vue:250-287`） | **`KitListRow`** | actions 收「⋯」、副行两行截断 | **P1** |
| 20 | **会话列表 / 长列表** | `yaya/components/ChatSessionList.vue`（533 行）、`bili/components/chat/SessionList.vue`（140 行）、`aidj/View.vue` 内嵌、`logs/View.vue` + `aidj/components/FreqList.vue` + `MetadataSlotsView.vue`（`v-virtual-scroll`） | **`KitList`**（可选虚拟滚动） | 单列、行高 56px | **P1** |
| 21 | **可排序行**（只读路径框 + 上移/下移/删除） | `apps/SearchRootsSection.vue:70-112`、`aidj/components/AidjSettingsSection.vue:970-1012,1053-1101,2218-2266`、`aidj/components/SongGrid.vue:284-307`、`yarj/components/GalleryFoldersSection.vue:76-118`、`yarj/components/MapFilesSection.vue:102-186` | **`KitReorderRow`** | 行主体 `flex:1 1 100%`，操作组换第二行右对齐 | **P1** |
| 22 | **玻璃浮层外壳**（blur + 边框 + 圆角 + 阴影） | `aidj/View.vue:984-995,1132-1143`、`aidj/components/{PlayerMenu:504-514, ChatSlashPopup:129-146, ContextMenu:128-139}.vue`、`yarj/components/{PhotoSideDrawer:368-370, RouteSideDrawer:348-350, PhotoLightboxModal:586-588}.vue`（共 10+ 处） | **`KitGlassPopover`** | `top-center` → `top-right` 圆形把手 + 弹层右上展开（`aidj/View.vue:1096-1116` 已有先例） | **P1** |
| 23 | **输入框 + 追加图标按钮** | `apps/View.vue:926-937,953-963,1103-1113,1270-1280,870-880`、`apps/SearchRootsSection.vue:126-136`、`aidj/components/AidjSettingsSection.vue:1026-1036,1114-1124,2609-2619` | **`KitPathField`** | 追加按钮 40px 热区 | **P2** |
| 24 | **输入框 + 扩展面板** | `yaya/components/ChatInputBox.vue`（1424 行）、`bili/components/chat/ChatInputBox.vue`（348 行）、`yaya/plugins/{mention/MentionInput,speech/SpeechInput,storyteller/StoryInput,react/EmojiInput}.vue` | **`KitInputBar`** | 「+」面板 bottom-sheet（AGENTS 已规定） | **P2** |
| 25 | **导航：nav stack / 整页切换** | `bili/View.vue:64`、`aidj/View.vue:39`、`settings/View.vue:53`、`bili/components/SubPage.vue:33-65` | **`KitSubPage`** | 全屏、返回键 ≥44px | **P1** |
| 26 | **居中浮层页菜单 / 右键菜单** | 页菜单：`aidj/View.vue:641-861` ↔ `aidj/components/PlayerMenu.vue:135-469`（**`.menu-item` CSS 逐条重复** `:1009-1024` ↔ `:515-526`）；右键：`aidj/View.vue:866-903` ↔ `aidj/components/ContextMenu.vue:97-124`（**CSS 逐条重复** `:1144-1168` ↔ `:140-164`）；另有 `yarj/components/YarjPageMenu.vue:877-880` | **`KitPageMenu` / `KitContextMenu`** | 菜单项 44px 命中、点式菜单避屏缘（`ContextMenu.vue:77-85,158-164` 已有先例） | **P1** |
| 27 | **tab / 分段导航（4 种互不兼容实现）** | yaya：`v-tabs`（`PluginsSection.vue:328-338`）、`v-slide-group`+chip（`ModelSelectDialog.vue:262-291`）、`v-chip-group`（`UsageDialog.vue:352-365`）、`v-btn-toggle`（`UsageDialog.vue:207-217`）；bili：`MemoryTab.vue:173-218`、`DutyTab.vue:180-197`；playground：`ResponseViewer.vue:99-106`；yarj：`RouteDetailModal.vue:366-374` | **`KitTabs`** | 窄屏横滑 + mask 渐隐（`scripting/View.vue:2108-2116` 手法） | **P2** |
| 28 | **容器查询断点（手写，不统一）** | 480/520/560/600/640/720 六种并存：`yaya/View.vue:2046`、`yaya/components/WorkflowCard.vue:733`、`aidj/components/WorkflowCard.vue:230,369`、`bili/components/chat/ToolCallCard.vue:157,249`、`bili/components/chat/MessageRow.vue:152`、`bili/components/chat/Markdown.vue:216`、`yaya/components/ToolCallRow.vue:287,441` | kit 统一**断点令牌** | — | **P2** |
| 29 | **容器宽度测量代替窗口断点** | bili `WIDE_MIN=900` + ResizeObserver 抄 3 遍（`View.vue:87-104`、`DmTab.vue:30-33,272-278`、`MemoryTab.vue:51-54,150-156`）；yaya 6 处（`McpServersPanel.vue:55-74`、`PluginToolsList.vue:144-162`、`PluginConfigForm.vue:183-195`、`DiagramFrame.vue:128-144`、`YayaSettingsSection.vue:431-451`、`View.vue:1458-1463`）；yarj `composables/useYarjCompact.ts:5-30`（`YARJ_COMPACT_WIDTH=600`，**8 个组件各调一次**） | **`useContainerWidth()`** | — | **P1** |
| 30 | **脚本级重复（无 UI，但同源）** | `asRecord/asNumber/asBool/asString` 归一化抄 **8 遍**（bili）；700ms 防抖保存抄 4 遍（bili）；`JSON.parse(JSON.stringify(x))` 守卫抄 6 遍（yaya）；轮询（闲 25s/跑 5s）抄 3 遍（bili）；snackbar 自管抄 6 遍（yarj） | kit 的 `src/`（非组件）提供 util | — | **P2** |

---

## 3. 建议积木的 props 草案

> 只列**已被多处实证**需要的 prop；标「待确认」的需实拍/实测。

### 3.1 `KitPage`（P0）

```ts
props: {
  mode: 'document' | 'app' | 'canvas'
  scroll?: 'page' | 'inner' | 'none'   // 缺省随 mode
  maxWidth?: number | 'none'           // 可读行宽（bili SubPage 用 960）
  pad?: boolean | number               // 是否继承外壳 pa-4
}
slots: { default }
```
要能分别表达 §4.1 的四种惯用法。**注意**：`bili/View.vue:340-357` 的注释给出了一个重要的反向证据——
「appbar 实测 55px，不是 DESIGN.md §4.6 口径的 48/64px，用 `calc` 魔数壳就短一截」，
所以 `position:absolute; inset:0` **优于** `calc(100vh-96px)`。建议：
- `KitPage` 的 app/canvas 模式统一用 `absolute; inset:0`（不依赖任何魔数，键盘弹出跟着可视区收）；
- 同时建议修订 `DESIGN.md` §4.6，把「必须 `calc(100vh - 96px)`」改成「必须铺满宿主可视区且外壳不出滚动条，`absolute inset:0` 是首选写法」。

### 3.2 `KitSettingRow`（P0）

```ts
props: {
  label: string
  value?: string | number       // 右侧数值（等宽字体）
  hint?: string                 // 行下小字（≤12 字，bili AGENTS.md §4.5 R3）
  desc?: string                 // 副标题说明
  controlWidth?: number         // 控件固定宽
  secondary?: boolean           // priority="secondary"：窄屏可整行隐藏
}
slots: { default: 控件 }
```
**内置硬禁令**：设置页禁止通栏 `v-slider`（可见宽度 >320px 即违规，`bili/AGENTS.md` §5 的使用者原话
「设置页水平方向出现滑块（横屏才该有）」）。默认渲染 `KitNumberStepper`，slider 要显式 opt-in。

### 3.3 `KitNumberStepper`（P0）

```ts
props: { modelValue: number; min: number; max: number; step: number; label: string; unit?: string }
emits: ['update:modelValue']
```
行为照 `bili/components/settings/DutySection.vue:325-353` 的 `makeStepper`：
**文本框只当草稿**，打字中途不夹取（否则打 "60" 会被 "6"→min 的钳制吃掉），失焦/回车/± 才夹取落值。
这套语义必须搬进 kit，别让人写第五遍。

### 3.4 `KitJsonTree`（P0）

```ts
props: {
  value: unknown
  label?: string                 // 根名，默认 'root'（toolbox 用 '$'，yarj 用 'photo'）
  defaultExpandDepth?: number    // 0–2，默认 2
  maxDepth?: number              // 默认 12（补 FoldingJson 的缺口）
  maxEntries?: number            // 默认 200
  longStringFold?: boolean       // 默认 true
  foldLength?: number            // 默认 80
  showCopy?: boolean             // 默认 false
  editable?: boolean             // 默认 false（yarj 的 raw JSON 编辑 + 语法校验）
  colors?: 'theme'               // 默认；yarj 的硬编码 hex 必须迁移
}
emits: ['update:data', 'save']
expose: ['expandAll', 'collapseAll']
slots: { toolbar }
```
四份实现的差异见 §4.2。

### 3.5 `KitSectionCard`（P0）

```ts
props: { title?: string; icon?: string; description?: string; tone?: 'tonal'|'outlined'|'flat'; fullHeight?: boolean }
slots: { default; actions?: 右上角动作 }
```
对齐 `components/SettingsCategoryView.vue:110-125` 的既有网格，**不要另起一套**。

### 3.6 `useAsyncState` + `KitAsync`（P0）

```ts
// 直接包 src/main/ui/composables/useLoading.ts:11-33
export function useAsyncState<T>(fn: () => Promise<T>)
  → { data, loading, error, reload, clearError }
```
```vue
<KitAsync :state="st">
  <template #loading><v-progress-linear indeterminate height="2" /></template>
  <template #error="{ error }"><v-alert type="error" variant="tonal">{{ error }}</v-alert></template>
  <template #empty><KitEmpty icon="…" title="…" /></template>
  <template #default="{ data }"><!-- 正常态 --></template>
</KitAsync>
```
视觉部分直接复用 `components/LoadingBar.vue:16-27`（progress-linear + skeleton + alert 三件已写好）。

### 3.7 `KitEmpty`（P1）

```ts
props: { icon: string; title: string; text?: string; size?: 'page'|'inline'; actionLabel?: string }
emits: ['action']
slots: { actions }
```
语义 icon 表（DESIGN §7）：歌曲 `mdi-music-note-off`、会话 `mdi-chat-minus-outline`、照片 `mdi-camera-off-outline`、
工具 `mdi-tools`、航线 `mdi-map-marker-distance`、run `mdi-history`、模板 `mdi-file-document-outline`、
快捷键 `mdi-keyboard-off-outline`。`text` ≤20 字（bili AGENTS.md §4.5 R4）。

### 3.8 `KitChip`（P1）

```ts
props: {
  priority?: 'primary' | 'secondary'   // secondary 在 ≤480px 自动隐藏
  tone?: 'neutral'|'success'|'warning'|'error'|'info'
  mono?: boolean                        // 数值用等宽
}
```
**不暴露 `size` prop**（这是 186 个 `size=small` + 60 个 `x-small` 的根源）。内部写死
`padding-block:4px; min-height:24px`。若确有「列表行内超小 chip」需求，用 `dense` 布尔而不是 `x-small`。

### 3.9 `KitFormDialog`（P0）

```ts
props: {
  modelValue: boolean; title: string; desc?: string
  maxWidth?: number | '420'|'480'|'560'|'580'
  variant?: 'dialog' | 'sheet'   // sheet = 窄屏底部弹层
  saving?: boolean; persistent?: boolean; scrollable?: boolean
}
emits: ['update:modelValue', 'save', 'cancel']
slots: { default; actions }
```
窄屏 `:fullscreen="narrow"` 已 15+ 处手写；`variant:'sheet'` 是 **bili 的空白**（9 个对话框 0 个 bottom-sheet，
390px 上形态「待确认」）。`maxWidth` 建议 `min(560px, calc(100vw - 32px))`。

### 3.10 `KitSmartRow`（P0，与 3.2 同源）

```vue
<KitSmartRow>
  <span>名字</span>
  <KitNumberStepper … />              <!-- 默认 priority="primary" -->
  <span class="num">42%</span>
  <KitChip priority="secondary">次要统计</KitChip>   <!-- 塞不下自动隐藏 -->
</KitSmartRow>
```
规则：先隐藏 `secondary` → 再不足则换行（`flex-wrap` / grid 重排）→ 仍不足收进「⋯」。
参照手写实现：`aidj/components/WorkflowCard.vue:369-392`（`@container 480px` 退化成 grid）、
`yaya/components/WorkflowCard.vue:714-731`（`display:none` + flex 重排）。

### 3.11 `useNarrow` / `useContainerWidth`（P0/P1）

```ts
useNarrow(bp = 720): Ref<boolean>          // 消灭 7 处手写 matchMedia
useContainerWidth(): Ref<number>           // 消灭 9 处手写 ResizeObserver
```

### 3.12 其余积木的 props 草案（摘要）

| 积木 | props / slots 草案 | 移动端退化 |
| --- | --- | --- |
| **`KitDrawer`** | 见 §4.12（mount/side/width/inset/compactMode/scrim/closeOnEsc/swipeToClose/radius/zIndex；slots header/default/footer） | `compactMode:'sheet'` 底部弹层 + 拖拽把手；`'full'` 保留现状 |
| **`KitReorderRow`** | `index`、`count`、`canRemove?`、`canReorder?`、`move?(dir)`、`remove?()`、`label?`、`touchOnly?`；slot default（行主体） | 行主体 `flex:1 1 100%`，操作组换第二行右对齐（参考 `MetadataSlotsView.vue:874-881`）；排序钮 40px 热区（`SongGrid.vue:394-405` 已有先例） |
| **`KitStatusChip`** | `label?`、`value`、`tone?`、`color?`、`on?`（高亮）、`clickable?`、`icon?`、`monoValue?=true` | `label` 隐藏只留 `value`；宽度不足按 `ChatStatusBar.vue:42-69,216-255` 的实测折叠模式收进「+N」底部弹层 |
| **`KitGlassPopover`** | `width?='340px'`、`maxWidth?='90vw'`、`placement?: 'top-center'\|'top-right'\|'bottom'\|'point'`、`glass?=true`、`radius?=12`、`padding?=8`、`maxHeight?` | `top-center` → `top-right` 圆形把手 + 弹层右上展开（`aidj/View.vue:1096-1116` 已有完整先例） |
| **`KitPageMenu`** | `modelValue`、`steps`、`items:{icon,label,value?,step?,trailing?}[]`、`onBack`、`width?` | 菜单项 44px 命中 |
| **`KitContextMenu`** | `modelValue`、`x`、`y`、`actions:{icon,label,danger?,disabled?,run}[]` | 自动避开屏幕边缘（`ContextMenu.vue:77-85` 已有先例） |
| **`KitTriState`** | `model:'a'\|'b'\|'c'\|null`、`states:Array<{value,icon,color,title}>` | 图标 18→20px，title 保留全量说明 |
| **`KitPathField`** | `modelValue`、`label?`、`pickTitle?`、`pickFilters?`；emit `pick` | 追加按钮 40px 热区 |
| **`KitToolButton`** | `icon`、`caption?`、`active?`、`disabled?` | 窄屏竖排图标圆 + caption（替代 `PlayerView.vue:975-1014` 的 `!important` 拆 chip） |
| **`KitCopyButton`** | `text`、`icon?`、`copiedIcon?='mdi-check'`、`feedbackMs?=2000` | — |
| **`KitChunkedList`** | `items`、`chunk?=40`、`rootMargin?='200px'`；slot `renderItem` | — |
| **`KitConfirmInline`** | `active`、`onConfirm`、`onCancel`、`danger?`、`label?` | 确认态 `flex-basis:100%` 换行 |
| **`KitMediaViewer`** | `modelValue`、`src`、`alt?`、`images?`、`index?` | 滚轮/双指缩放 + 拖动平移 |
| **`KitStatCard`** | `label`、`value`、`unit?`、`icon?`、`color?` | `text-h5`→`1.25rem`（复用 `balance/View.vue:1771-1782`） |
| **`KitCodeBlock`** | `text`、`maxHeight?`、`lang?: 'json'\|'text'` | 字号 0.8rem、padding 8px 10px |
| **`KitSubPage`** | `title`、`subtitle?`、`back?: fn`；slot `actions` + default | 全屏、返回键 ≥44px |
| **`KitPage`** | `mode: 'document'\|'app'\|'canvas'`、`maxWidth?`、`pad?`、`compact?: Ref<boolean>`（yarj 需要注入 `useYarjCompact`） | 见 §3.1 |

---

## 4. a. 重复实现详单

### 4.1 页壳高度：**四种**互不相同的惯用法，都为了同一件事

外壳本身是对的：`src/main/ui/App.vue:1817-1820` = `min-height: calc(var(--app-vh) - 64px - 32px)`
（= appbar 64px + 容器 `pa-4` 32px，符合 DESIGN §4.6；`--app-vh` 回落 `100vh`、支持时取 `100dvh`，见 `global.css:3-10`）。
但各能力又各自解了一遍：

| 惯用法 | 实例 |
| --- | --- |
| **A. `position:absolute; inset:0`** | `aidj/View.vue:938-946`（`.aidj-shell` + `.aidj-main`）、`bili/View.vue:349-357`、`yarj/View.vue:3118-3121`、`yaya/View.vue:2040-2047` |
| **B. `height: calc(var(--app-vh) - 96px)`** | `cli/View.vue:267-270`（注释解释 96px 来历）、`ft/View.vue:656-665`（注释明写「Pin to the viewport like cli/View.vue」） |
| **C. `min-height: calc(var(--app-vh) - 96px)`** | `balance/View.vue:1747`（`.balance-shell`）、`:1751`（`.balance-container`，同文件两遍）、`balance/components/ProfileManagerView.vue:686` |
| **D. `position:absolute; inset:16px`** | `settings/View.vue:514-520`（注释「inset 16px 对应宿主 v-container 的 pa-4」）、`scripting/View.vue:1764-1774`（`top/right/bottom/left:16px`） |

**B/C/D 都硬编码了「容器 = `pa-4` = 16px」**——外壳若改成 `pa-3`，这几处全部错位。
A 是唯一不依赖魔数的写法（`bili/View.vue:340-348` 的注释就是在讲这个，并指出 appbar 实测 55px）。
→ `KitPage` 的 app/canvas 模式应统一到 A。

### 4.2 JSON / 树折叠：**四份**实现

| 维度 | `toolbox/JsonTree.vue` | `yarj/JsonTreeView+Node` | `playground/FoldingJson.vue` |
| --- | --- | --- | --- |
| 入口 | `:21`（props `:4-7` `value/label/depth`） | `:122`（props `:7-19`）+ `JsonTreeNode.vue:32` | `:78`（props `:20-27` `data/depth`） |
| 展开状态 | 本地 ref `expanded = depth<1`（`:8`） | `expandedPaths: Set<string>`（`:32`）+ `initExpanded`（`:34-48`）+ `expandAll/collapseAll`（`:67-83`） | 本地 ref `open = depth<2`（`:68`）+ 长字符串独立 `strOpen`（`:69`） |
| 缩进 | `margin-left:16 + padding-left:12 + 实线`（`:69-73`） | `pl-4 ml-2 + 虚线`（`:60,:105-107`） | `padding-left:16 + margin-left:6 + 实线`（`:135-139`） |
| 着色 | **无** | key=primary；value **硬编码 hex**（`:79-99`） | key=primary；value 全走 `--v-theme-*`（`:143-163`） |
| 复制 | 无 | 有（`:85-95`，2s 反馈） | 无 |
| 编辑 | 无 | **有**（raw JSON + 语法校验 `:97-118,:166-182`） | 无 |
| 长串折叠 | 无 | 无 | **有**（阈值 80，`:30,:63-65,:98-105`，带 i18n） |
| 上限保护 | entries 200 + depth 12（`:11,:37,:45-49`） | 无 | **无**（深 JSON 无限递归） |
| 内部滚动 | 无 | `max-height:420`（`:204-209`） | 父容器 `.pg-jsontree max-height:320`（`ResponseViewer.vue:141-151`） |

**结论**：`KitJsonTree` = `FoldingJson` 的语法着色与长串折叠 + `JsonTreeView` 的工具条/复制/编辑 + `JsonTree` 的截断保护。
`colors:'theme'` 是必须的——yarj 的 hex 是浅色主题下的隐患（§5.3）。

### 4.3 WorkflowCard：**两份**，同壳不同瓤

- `aidj/components/WorkflowCard.vue`（393 行）：AIDJ「一批 agent 任务」卡片。壳 `:223-232`（含 `container-type:inline-size`）、
  头 `:133-157`、时间线 `:168-215`、`@container workflow (max-width:480px)` `:369-392`。
  消费者：`aidj/components/BtChatView.vue:431`、`aidj/components/ChatMessage.vue:118`。
- `yaya/components/WorkflowCard.vue`（769 行）：YAYA「一段思考/工具/子Agent 过程块」。壳 `:453-458`、头 `:279-307`、
  时间线 `:351-446`、`@container yaya (max-width:600px)` `:733-768`。
  消费者：`yaya/components/AssistantTurn.vue:353,472`。

**重复的是「壳」**：两者都有 `状态图标 + 标题 + badge + spacer + tokens + 耗时 + chevron` 头部、
`.wf-dot` 时间线、以及「运行中实时计时 + 结束冻结」逻辑（`aidj:42-64` ↔ `yaya:109-136`，**都符合 DESIGN §4.4**）。
差异：yaya 有富预览行（`:213-244,:310-348`）与自定义高度交换动画（`:45-80`，感知 `motion-off`）；
aidj 详情用 `<pre>` pretty JSON（`:204,:209`）。
→ 抽 `KitWorkflowCard`（壳 + 时间线 + 计时冻结），预览与详情用插槽。

### 4.4 设置行：`justify-space-between` 出现 **140 次**

Top：`balance/View.vue`（17）、`dashboard/View.vue`（12）、`yarj/components/MapPreferencesSection.vue`（8）、
`balance/components/ProfileManagerView.vue`（8）、`yarj/components/RouteDetailModal.vue`（7）、
`yarj/components/RouteGeotagModal.vue`（6）、`yarj/components/GpsCorrectionModal.vue`（6）、
`scripting/View.vue`（5）、`aidj/components/AidjSettingsSection.vue`（5）、`settings/items/WindowSection.vue`（4）。

四套模板：
- **A「名字+数值右对齐+滑块」**：`settings/items/WindowSection.vue:162-165`、`:219-224`、`:237-242`、`:255-258`
  （**同一份在同一个文件里抄 4 遍**）+ `settings/items/ZoomSection.vue:32-37`。逐字相同，只有 `mt-3` 有无、
  `<template v-if>` 包裹层级、提交时机（`@end` vs `@update:model-value`）三处差异。
- **B「名字+控件横排」**：`settings/items/WebHostSection.vue:154-168`（class `.port-field`）、
  `settings/items/AndroidClientSection.vue:141-173`（class `.pin-field`）、
  `balance/components/BalanceSettingsSection.vue:230-269`（**行内** `style="max-width:200px"` ×3）、
  `scripting/View.vue:1637-1649`（数值是带底色 pill）。gap `ga-2/ga-3/ga-4`、宽度约束 class vs 行内、数值样式三套。
- **C「小标题+说明+单选组」**：`settings/items/SidebarSection.vue:231-246,250-265`、`AnimationSection.vue:123-137,142-152`、
  `WindowSection.vue:272-286`、`FontSection.vue:67-76`、`LanguageSection.vue:38-50`。
- **D「开关+说明」行**：`LaunchSection.vue:44-51`、`ScreenshotSection.vue:42-52`、`AnimationSection.vue:101-111`、
  `WindowSection.vue:141-149`、`WebHostSection.vue:127-135`、`AndroidClientSection.vue:123-132`、
  `BalanceSettingsSection.vue:221-228`、`scripting/View.vue:1656-1664`；
  yaya 的 switch-row 另有 9 处（`settings/ProviderDetail.vue:135-151`、`PolicySection.vue:65-82`、
  `PluginDetail.vue:149-160`、`PluginsSection.vue:269-299`、`McpServersPanel.vue:268-293`、
  `SkillsPanel.vue:216-235`、`PluginList.vue:164-172`、`PluginToolsList.vue:313-320`、`ProfileSection.vue:129-150`）；
  bili 的「图标+名字+控件+数值」`.ctl` 行另有约 20 行。

### 4.5 紧凑数字步进器：**五处**独立实现

- `bili/components/settings/DutySection.vue:337-437`（`makeStepper` 泛化版）
- `bili/components/settings/DmSection.vue:66-91`、`CompactSection.vue:83-114`、`AsrSection.vue:88-113`
  —— **三份逐字复制** `makeStepper/clampInt/Stepper`
- `yarj/components/MapFilesSection.vue:150-170`（`.zoom-stepper` + `.zoom-value`，更简单的行内版）

配套 CSS 三件套（`.ctl-icon` + `.ctl-head` + `.stepper-field`）另抄 5 遍：
`DmSection.vue:302-323`、`CompactSection.vue:389-410`、`AsrSection.vue:577-598`、`DutySection.vue:1240-1271`、`ProvidersSection.vue:746-753`。
背景：`bili/AGENTS.md` §5 的「设置页禁通栏 slider」是使用者铁律，bili 已把「为什么」写成门禁脚本
（`tools/settings-shot.mjs` 每个视口 × 每个分类量 `v-slider` 可见宽度 >320px 即违规），
并把 `v-slider` **全部退役**（仅剩注释提及：`DutySection.vue:309`、`DmSection.vue:38`、`AsrSection.vue:60`）。

### 4.6 三态

- **已有骨架未打通**：`components/LoadingBar.vue:1-28`（视觉，6 个能力在用）与 `composables/useLoading.ts:11-33`（状态，0 个能力在用）。
- 手写三态：bili 约 12 处（各自一套 `loading ref + v-progress-linear(height 2) + errorText div + v-empty-state`）、
  yaya settings 4 处同构（`PluginList.vue:82-107`、`McpServersPanel.vue:217-246`、`SkillsPanel.vue:291-320`、`PluginToolsList.vue:252-269`，
  其中 `.refresh-line` 的 CSS 与 `v-if="loading"` **逐字重复 3 次**）、settings 系 8 处 `v-if/v-else-if` 链。
- `v-progress-linear v-if="loading" indeterminate color="primary" height="2"` 单独出现 10+ 次。

### 4.7 分区卡片

- settings 14/15 统一：`<v-card rounded="lg" variant="tonal" class="card-fill">` + `v-card-title text-subtitle-2` + `v-card-text`
  （`ThemeSection.vue:47-49`、`ZoomSection.vue:29-31`、`AboutSection.vue:18-20`）；`card-fill` 是全局工具类（`global.css:150-162`）。
  **例外**：`settings/items/ShortcutsSection.vue:199` 根节点是裸 `<div class="d-flex flex-column ga-4">`，与同目录 14 个不同构。
- yaya settings 12 处近乎逐字相同的 CSS（`surface-variant` 底 + `surface-bright` 边框 + `rounded-lg`）：
  `McpServersPanel.vue:394-398`、`SkillsPanel.vue:420-429`、`PluginList.vue:201-205`、`ProvidersSection.vue:296-300`、
  `ModelSection.vue:152-156`、`PluginDetail.vue:327-330`、`AssistantsSection.vue:565-575`、`PluginToolsList.vue:339-342`、
  `YayaSettingsSection.vue:751-781`、`ModelSelectDialog.vue:550-553`。
- bili 17 处（`DmTab.vue:308-363`、`CapabilitiesCard.vue:77-313`、`ToolLogCard.vue:67-162` …）。
- playground 5 处（`regex/RegexRulesView.vue:129`、`infosource/InfoSourcesView.vue:136`、`TransformEditor.vue:218`、
  `storyteller/StoryStateCard.vue:46`、`roleplay/RoleplayCard.vue:70`）。

### 4.8 对话框外壳：**三套模板 + 零 bottom-sheet**

- yaya 外壳 A（`v-card.pa-4.yaya-pop` + `px-0 pt-0 text-h6` 标题 + `px-0 pb-0 ga-2 justify-end`）6 处；
  外壳 B（自绘 head + 分割线 + `v-card-text` + 底部 actions）5 处；外壳 C（全屏媒体查看）2 处。
- bili 9 个 `v-dialog`，**0 个 `v-bottom-sheet`**，统一骨架 `v-dialog>v-card>v-card-title.text-subtitle-1+v-card-text+v-card-actions(px-4 pb-4 pt-0/pt-2 ga-2)+v-spacer+取消(text)/确认(flat)`。
- balance 4 处逐字同构（`balance/View.vue:1378-1392`、`:1692-1705`、`ProfileManagerView.vue:615-628`、`BalanceSettingsSection.vue:368-376`），
  **且 `BalanceSettingsSection.vue:87-186` 与 `balance/View.vue:145-513` 是同一「增删改平台」功能的两份完整实现**。
- 「窄屏全屏」判定 `matchMedia('(max-width: 720px)')` 手写 7 遍（见主表 #13）。

### 4.9 全屏子页外壳（唯一做对的一份）

`bili/components/SubPage.vue:33-65`：返回 + 标题 + 副标题 + 动作插槽 + 内部滚动 + `max-width:960` 居中 + 窄屏 `padding:12px`（`:91-96`），
四个域子页共用（`bili/View.vue:331-334`）。→ `KitSubPage` 直接泛化它（它已在注释里引用 DESIGN §4.6）。

### 4.10 图类插件外框（既有 mini-kit 先例）

`yaya/components/plugin-kit/DiagramFrame.vue:1-45`：工具栏（图/源码切换、复制、导出、放大）+ 图区/源码区 + 错误回退，
**「容器 < 520px 时工具栏收进 ⋮ 菜单」**（`:5-6`）。被 `yaya/plugins/mermaid/MermaidView.vue:17` 与 `svg/SvgView.vue:13` 共用。
→ 「工具栏窄屏溢出降级」的**唯一已实现范例**，`KitToolbar` 照它做并上移（现在锁在 yaya 里，别的能力用不了）。
同目录 `ZoomDialog.vue` + `image-utils.ts`，以及 `components/pop.css` / `tokens.css` 也要一起评估上移。

### 4.11 其他重复

- **输入框族 6 份**：`yaya/components/ChatInputBox.vue`（1424）、`bili/components/chat/ChatInputBox.vue`（348）、
  `yaya/plugins/mention/MentionInput.vue`（343）、`speech/SpeechInput.vue`（621）、`storyteller/StoryInput.vue`（278）、`react/EmojiInput.vue`（59）。
  不建议整体抽，但「+」面板 bottom-sheet 化可抽（`yaya/components/ChatInputBox.vue:849-859` 已有 `v-bottom-sheet v-if="sheetMode"`）。
- **会话列表 3 份**、**居中浮层页菜单 2 份**（`aidj/View.vue:948-951` ↔ `yarj/components/YarjPageMenu.vue:877-880`）。
- **行内二次确认 4 处**、**复制反馈 5 处**、**分块渲染 2+1 处**、**`<pre>` 样式 9 处**。
- **脚本级**：`asRecord/asNumber/asBool/asString` 8 遍、700ms 防抖保存 4 遍、`JSON.parse(JSON.stringify(x))` 6 遍、轮询 3 遍。

### 4.12 yarj 的三份抽屉：外壳逐行重复（`KitDrawer` 的完整依据）

`PhotoSideDrawer.vue` / `RouteSideDrawer.vue` / `RoutePlaybackPhotosDrawer.vue` 的外壳几乎逐行相同：

| 维度 | PhotoSideDrawer | RouteSideDrawer | RoutePlaybackPhotosDrawer |
| --- | --- | --- | --- |
| 过渡包裹 | `:158-167` | `:111-120` | `:89-97` |
| 桌面定位 | `:358-376` `top/right/bottom:16px; width:420px; z-index:25; radius:18px` | `:338-356` **完全相同** | `:220-236` `top:72;right:20;bottom:120;width:360;radius:20`（第三套常量） |
| 窄屏 `.is-compact` | `:378-387` 占满全高右侧浮层 | `:358-367` 同左 | `:238-246` 同左 |
| 进出动效 | `:417-428` `drawer-slide` + `translateX(440px)` | `:402-413` 同左 | `:280-289` `translateX(400px)` |
| 滑动手势 | `:36-39` `useSwipeDismiss` + 绑定 `:164-166` | `:25-28` + `:117-119` | `:30-33` + `:94-96` |
| 三段 flex 列 | header `:169` / body `:249` / footer `:315` | header `:122` / 搜索 `:134` / body `:175` | header `:99` / body `:138` |
| Esc 关闭 | **无** | **无** | **无** |
| scrim | **无**（非模态，地图常驻可见） | 无 | 无 |

对照物：真 bottom-sheet = `PhotoLightboxInfoPanel.vue:686-697`（`.is-compact → left/right/bottom:0; height:62%; radius 18px 18px 0 0`），
动效 `PhotoLightboxModal.vue:745-749`（`translateY(100%)`）；但它桌面态是 **flex 子项**（`:671-683`，`width:420px;border-left`），
与另三份的 absolute 浮层挂载方式不同。
框架侧已有共享基座：`src/main/ui/composables/drawer-swipe.ts`（`DrawerSwipe` 类）+ `src/abilities/yarj/composables/useSwipeDismiss.ts`，
`bili/View.vue:36,117-128` 与 `yaya/View.vue:14` 也直接用 `DrawerSwipe`。

**`KitDrawer` props 草案**：
```ts
props: {
  modelValue: boolean
  mount?: 'floating' | 'inline'      // floating=absolute 贴边（地图页）| inline=flex 子项（并排面板）
  side?: 'right' | 'bottom'          // 桌面方向
  width?: number | string            // 默认 420
  inset?: { top?, right?, bottom?, left? }   // 默认 16
  compactMode?: 'full' | 'sheet'     // 窄屏：占满全高（现状）| 底部弹层（PhotoLightboxInfoPanel 形态）
  sheetHeight?: string               // 默认 '62%'
  scrim?: boolean                    // 默认 false（画布页不遮地图）；true 时点遮罩关闭
  closeOnEsc?: boolean               // 默认 true —— 补齐三份抽屉缺失的 Esc
  swipeToClose?: boolean             // 默认 true，内部走 useSwipeDismiss
  radius?: number                    // 默认 18
  zIndex?: number                    // 默认 25
}
slots: { header, default, footer }   // 内部自动 flex-shrink / flex:1 overflow / flex-shrink
expose: { bodyEl }
```

### 4.13 aidj 的「同模式四份 CSS」与「菜单 CSS 逐条重复」

- **`.status-chip` 家族 3+1 处**：`ChatStatusBar.vue:564-585`、`BtChatView.vue:676-696`、`ContinuousView.vue:553-574`
  各写一份，`ChatView.vue:1517` 挂 class 但**文件内无规则**（§5.8.2）。
- **玻璃浮层外壳 5 处近乎同一套 CSS**（`backdrop-filter:blur(18px) saturate(1.2)` + `border:1px solid rgba(--v-theme-surface-bright,.28)`
  + radius 8–12 + 阴影 + padding 4–8）：`View.vue:984-995`（`.page-menu-pop`）、`:1132-1143`（`.aidj-session-ctx`）、
  `PlayerMenu.vue:504-514`、`ChatSlashPopup.vue:129-146`、`ContextMenu.vue:128-139`。
  进场动画三件套另重复 4 套：`View.vue:1118-1128,1169-1187`、`PlayerMenu.vue:554-564`、`ChatSlashPopup.vue:189-199`、`ContextMenu.vue:165-183`。
- **菜单项 CSS 逐条重复**：`View.vue:661-714`（11 项，CSS `.menu-item` `:1009-1024`）↔
  `PlayerMenu.vue:143-211`（7 项，CSS `.menu-item` `:515-526`）；
  **右键菜单 CSS 逐条重复**：`View.vue:866-903`（CSS `.aidj-session-ctx-item` `:1144-1168`）↔
  `ContextMenu.vue:97-124`（CSS `.aidj-ctx-item` `:140-164`）。
- **路径输入框 + 追加图标按钮 9 处**：`apps/View.vue:926-937,953-963,1103-1113,1270-1280,870-880`、
  `apps/SearchRootsSection.vue:126-136`、`AidjSettingsSection.vue:1026-1036,1114-1124,2609-2619`；
  「输入框 + 主按钮」添加行另 3 处：`SearchRootsSection.vue:117-141`、`AidjSettingsSection.vue:1017-1041,1105-1135`。
- **`v-expansion-panels` 3 处**：`AidjSettingsSection.vue:1981-2021,1022-1050,1365-1393`。

---

## 5. c. 违反 DESIGN.md 的实例（含修法）

### 5.1 文字按钮 `size="small"`：真实违规 **6 处**（任务前提里的 31/26 处不成立，见 §0）

| `文件:行号` | 现状 | 修法 |
| --- | --- | --- |
| `src/abilities/yaya/components/ContextMarker.vue:55` | `variant="text" size="small"` + 文案「查看摘要」，无 icon | 删 `size="small"`（`global.css:279-286` 已把 compact 文字按钮恢复 36px） |
| `src/abilities/yaya/components/ContextMarker.vue:58` | 同上，「恢复完整上下文」 | 同上 |
| `src/abilities/yaya/components/settings/PluginsSection.vue:303` | `size="small" variant="tonal" prepend-icon="mdi-open-in-new"`「前往根配置」 | 删 `size="small"`（有 prepend-icon 仍是文字按钮） |
| `src/abilities/yaya/components/settings/PluginsSection.vue:310` | `size="small" variant="tonal" prepend-icon="mdi-sync"`「手动同步」 | 同上 |
| `src/abilities/bili/components/settings/ProvidersSection.vue:653-657` | `variant="text" size="small"`「全选」，无 icon | 删 `size="small"` |
| `src/abilities/yarj/components/RouteDetailModal.vue:734-738` | `<v-btn variant="text" size="small">查看全部`，无 icon | 删 `size="small"` |

**相邻问题：`size="x-small"` 超出规范**。DESIGN §1.3 只点名「图标按钮允许 `size="small"`」，全库却有约 60 处
`size="x-small"`（集中在 `yarj/components/YarjPageMenu.vue` 10 处、`bili/components/settings/DutySection.vue` 10 处、
`AsrSection.vue` 5 处、`DmSection.vue` 3 处、`CompactSection.vue` 3 处，以及 `yaya/View.vue:1914`、
`yaya/components/ChatInputBox.vue:760`、`yaya/plugins/interactgame/GameBoard.vue:122` 等）。
其中图标按钮的 x-small（如 `yaya/View.vue:1911-1918` 的通知关闭钮）比规范允许的还小一档。
**修法**：DESIGN.md 补一句「图标按钮允许 `size="small"`；`x-small` 仅限列表行内 chip 与图标按钮，且必须满足 §3 的
padding/min-height」——否则这是一条**写了但没执行边界的规范**。bili 的 x-small chip 全部带了 `.mini-chip`（合规底线），
`apps/View.vue:794,805` 自己也在用 x-small。

### 5.2 chip：全局已统一，页面还在重复写 32 遍；且 186 个用 `size=small`

**冗余**（`global.css:611-615` 已对**所有** `.v-chip` 生效，这些是死代码）：
- **bili 22 处**，类名还分叉成 9 种（`mini-chip` / `state-chip` / `ledger-chip` / `allow-chip` / `word-chip` /
  `filter-chip` / `day-chip` / `provider-chip` / `level-chip`）：`chat/RunLedgerCard.vue:138`、`dm/AllowListEditor.vue:200`、
  `DmTab.vue:504`、`dm/WatchStatusCard.vue:322`、`duty/DutyRhythmCard.vue:161`、`duty/DutyStatusCard.vue:626`、
  `DutyTab.vue:325`、`memory/{ArchiveHitCard:67, MemorySearch:251, MemoryStatsCard:250, MemoryTimeline:123, NodeCard:62, NodeDetail:180, NodeList:194}.vue`、
  `settings/DutySection.vue:1246`、`settings/ProvidersSection.vue:733,738`、`tools/{CapabilitiesCard:319, LedgerRunsCard:187, ToolLogCard:168}.vue`、`ToolsTab.vue:204`
- **yaya 10 处 `.chip-pad`**：`settings/{PluginToolsList:345, ProviderDetail:333, McpServersPanel:401, SkillsPanel:432, PluginList:208, ProvidersSection:312, ModelSection:165, PluginDetail:312, AssistantsSection:591}.vue`、`plugins/cockpit/{CommandsTableView:185, CommandRunView:156}.vue`
  —— **其中 `AssistantsSection.vue:591-594` 写成 `min-height: 28px`，与其余 9 处的 24px 不一致**（这正是手抄的代价）
- **settings 系 6 处 class + 6 处行内**：`items/BootServicesSection.vue:226-229`、`discoverer/View.vue:377-381`、
  `scripting/View.vue:1922-1925`、`balance/View.vue:1816-1819`、`BalanceSettingsSection.vue:574-577`、`ProfileManagerView.vue:717-720`；
  行内 `style="padding-block: 4px; min-height: 24px"` 在 `balance/View.vue:1081,1093,1104,1233,1242,1254`
- **yarj 7 处**：`components/{MapFilesSection:218, PhotoLightboxModal:603, PhotoLightboxInfoPanel:720, PhotoCardItem:750, YarjPageMenu:1040, RouteDetailModal:966, MapPreferencesSection:741}.vue`
- **playground 4 处**：`components/{GlobalVars:120-123, TemplateEditor:270-273, TransformEditor:651-656}.vue`

**修法**：全部删掉，让 `global.css:611-615` 或 `KitChip` 做唯一入口。

**密度**：全文 264 个 `v-chip` 里 **186 个带 `size=small`/`x-small`**（Top：`aidj/components/ChatStatusBar.vue` 15、
`yarj/components/YarjPageMenu.vue` 10、`balance/View.vue` 8、`dashboard/View.vue` 7）。
DESIGN §1.3/§4.1 要求 chip 默认密度。**修法**：去掉 `size`，用 `priority`/`dense` 表达「次要」。
⚠️ 「待确认」：`global.css` 的 `min-height:24px; height:auto` 已兜底，实际视觉差多少需实拍。

**低于底线的自绘 chip**（连 4px 都没有）：
- `playground/components/TemplateList.vue:77-85` — `.pg-method-chip` **写了两遍**，最终生效 `min-height:22px`（<24）+ `font-size:0.65rem`
- `playground/components/TransformEditor.vue:641-656` — 2px/18px 被后续规则补救为 4px/24px，但 `font-size:0.65rem` 保留
- `yaya/plugins/infosource/InfoSourcesView.vue:145,264-269` — `.type-chip { padding: 2px 8px }`，无 `min-height`
- `yaya/plugins/ask/AskCard.vue:349-360` — `.ask-chip { padding: 2px 10px; min-height:24px }`（padding-block 2px < 4px）
- `yaya/plugins/roleplay/RoleplayCard.vue:206-211` — `.rp-person { padding: 3px 10px }`，无 `min-height`
- `yaya/plugins/storyteller/StoryStateCard.vue:149-156,206-215` — `.sc-badge` 1px、`.sc-person` 2px
- `yaya/plugins/storyteller/StoryInput.vue:244-250` — `.sb-role { padding: 0 8px }`
- `aidj/components/WorkflowCard.vue:310-321` — `.wf-badge { min-height:22px; padding:2px 8px }`；
  `yaya/components/WorkflowCard.vue:486-495` — `.wf-badge { min-height:20px; padding:2px 8px }`（**20px < 24px**）
- **完全没补 padding 的**：`mirror/View.vue:172-182`、`autostart/View.vue:80-86`、`cli/View.vue:238-246`、
  `dashboard/View.vue:452-459,588-594,704-714,733-739`、`balance/View.vue:1459-1479`、
  `balance/components/BalanceSettingsSection.vue:428-451`、`yaya/components/UsageDialog.vue:353-371`
  （这些用的是**自绘 class 或裸 `v-chip`**，不吃 `global.css` 的 `.v-chip` 规则——这是 §4.3 症状的真实来源）

### 5.3 硬编码 hex 颜色（违反「配色走 `--v-theme-*`」）

- `yarj/components/JsonTreeNode.vue:84,89,93,97` — `.val-string/.val-number/.val-boolean/.val-null` 用
  `#4caf50 / #ff9800 / #2196f3 / #9e9e9e`。浅色主题对比度存疑（DESIGN §6 最后一条）。
  对照组：`playground/components/FoldingJson.vue:143-163` 全用 `rgb(var(--v-theme-*))`——**应以后者为基准**。
- `yarj/components/RouteDetailModal.vue:569,575,581,587,593` — 同样一组 hex。
- `yarj/components/{PhotoCardItem:681, YarjPickBanner:453,466, RouteDetailModal:904}.vue` — `#ffffff/#fff`。
- **不算违反**：`yarj/View.vue:1078-1387` 的 hex 是 MapLibre style 表达式字面量；`yarj/View.vue:1892` 是 data-URL SVG。
  **「待确认」：地图配色是否该跟随主题**（AGENTS 说 ft 等画布类跟随主题，但 yarj 地图是固定亮色系 + `#0f172a` 暗色，`:1362,1387`）。

### 5.4 手写空状态（违反 §4.8 / §7）——**25+ 处，yaya 全目录 0 处 `v-empty-state`**

| ability | 位置 | 形态 |
| --- | --- | --- |
| **yaya（14 处，最集中）** | `components/PluginList.vue:91-103`、`settings/McpServersPanel.vue:227-235`、`settings/SkillsPanel.vue:300-316`、`settings/PluginToolsList.vue:252-269`、`settings/PluginDetail.vue:298-300`、`settings/ProviderDetail.vue:273-278`、`settings/ProvidersSection.vue:141-145`、`settings/AssistantsSection.vue:377-379`、`settings/YayaSettingsSection.vue:728-730`、`View.vue:1810-1838`（自绘 64px 圆底 + 4 个建议按钮）、`components/ChatSessionList.vue:400-422`（`.session-empty` **在 scoped style 里没有任何对应规则**）、`ModelSelectDialog.vue:325-336,408-413`、`UsageDialog.vue:394-396`、`tree/ConversationTree.vue:640-644` | icon 28–36px + 文字，或纯文字 |
| **yarj（6 处）** | `View.vue:2870`、`components/PhotoSideDrawer.vue:274,277`（**纯一行文字，连图标都没有**）、`RouteSideDrawer.vue:178-183`、`RoutePlaybackPhotosDrawer.vue:190-198`（含动作按钮）、`RouteDetailModal.vue:792`、`YarjPageMenu.vue:528` | 48px 图标 + 文字 + hint |
| **playground（6 处）** | `components/{TemplateList:71, GlobalVars:67-69, TransformEditor:214-216,495-500, ResponseViewer(工具栏), FinalResponse}.vue`、`plugins/{regex/RegexRulesView:125-127, infosource/InfoSourcesView:132-134, models/MetaPanel:86-93, cockpit/CommandsTableView:131-134, mention/MentionPicker:116-118, deputy/DeputyResultView:102-104, cockpit/ImageResultView:123-126, cockpit/SnapshotView:112-114, roleplay/RoleplayCard:134-136}.vue` | 多为 icon+文字 |
| **scripting（1 处，最严重）** | `scripting/View.vue:1604-1628` | `v-icon size="36"` + 标题 + 说明 + 按钮**整套自绘** |
| **bili（4 处）** | `components/DmTab.vue:430-435`、`dm/AllowListEditor.vue:189-191`、`memory/NodeDetail.vue:152-154`、`duty/DutyRhythmCard.vue:153-155` | 轻量 caption |
| **settings（3 处）** | `items/ShortcutsSection.vue:229-231`、`items/AbilityToggleSection.vue:225-227`、`View.vue:410-415`（同文件 `:486-491` 已正确用 `v-empty-state`，**同页两种手法**） | 一行文字 |

**修法**：整页空态换 `<KitEmpty icon title text>`（薄封装 `v-empty-state`，观感仍由 `global.css:626-680` 统一）；
对话流/卡内嵌的轻量空态用 `KitEmpty` 的 `size:'inline'` 紧凑变体，圆底/标题/说明尺寸向 §7 看齐
（`yaya/View.vue:2300-2309` 的 `.empty-avatar` 是 64px 圆底 + 36px 图标，§7 规定 72px + 34px，`:155`）。
§4.8 允许「空状态里要放交互」时自绘（如 `yaya/View.vue:1810-1838`、`scripting/View.vue:1604-1628`、
`yarj/components/RoutePlaybackPhotosDrawer.vue:190-198`），但**尺寸必须向 §7 看齐**——这条现在没人执行。

### 5.5 一行塞太多控件（§4.2）

| `文件:行号` | 现状 | 修法 |
| --- | --- | --- |
| `aidj/components/WorkflowCard.vue:133-157` | 头部一行 7 个元素；720px 只让摘要换行（`:259-264`），**tokens（`:147-152`）与 elapsed（`:153`）无窄屏隐藏**；`@container 480px`（`:369-392`）不覆盖 head | tokens/elapsed 标 `priority="secondary"` |
| `yaya/components/settings/PluginToolsList.vue:191-249` | filter chip-group + `v-spacer` + 3 个批量文字按钮同一行，chip 组自身无 gap 兜底 | 批量操作收 ⋮；chip 组显式 `ga-2` |
| `yaya/components/ToolCallRow.vue:210-249` | 审批区一排 5 个文字按钮 | 已分两组 + `flex-wrap`（`:420-430`）；允许组 3 个仍一行 → 只留「允许执行」，其余收 ⋮ |
| `balance/components/BalanceSettingsSection.vue:230-269` | 1 个 `v-switch` + 3 个 `v-text-field type="number"` 全横排（`ga-4` + 3×`max-width:200px` ≈ 640px），无分组 | 数字三项收成一组 `ga-2`，与 switch 间用 `v-spacer` |
| `balance/View.vue:946-1001` | 卡头一行最多 6 枚 chip，容器 `d-flex align-center ga-1 flex-shrink-0`（`:946`）**没有 `flex-wrap`** | 补 `flex-wrap`（对照合规先例 `settings/items/BootServicesSection.vue:219-225`） |
| `bili/components/DmTab.vue:371-405` | 头像+昵称+状态 chip+spacer+「加白名单」按钮+「显示命令轮次」checkbox 六项一行 | 身份+chip 一组（左），按钮+checkbox 一组（右，`ga-2`），中间 `v-spacer` |
| `bili/components/DutyTab.vue:219-269` | 时间+阶段 chip+模式 chip+失败 chip+收 N 条+token+spacer+展开钮八项一行 | chips 归一组 `ga-1`、meta 归一组 `ga-2`、展开钮独立 |
| `dashboard/View.vue:703-715` | 卡内 3 枚 chip 一行，容器 `d-flex ga-2 mb-2` 无 wrap | 补 `flex-wrap` |
| `systemd/View.vue:126-131` | `v-list-item-title` 里 mono 单元名 + 状态 chip 同一 flex 行 | chip 加 `flex-shrink-0`，名 `text-truncate` |
| `playground/components/DynamicForm.vue:74-86` | 标题 + 历史按钮 + 清空按钮三个控件一行 | 历史按钮组只留「历史 N」 |
| `playground/components/TemplateEditor.vue:141-183` | copyFrom 选择器 + 4 个复制按钮一行 | <600px 收成 `v-menu` |

### 5.6 间距低于底线（§3）

- `scripting/View.vue:979` — `pb-3 pt-1` 的 `ide-top-bar`，上沿仅 4px，而它自带 `border-bottom`（`:1787`）
  → **按钮紧贴分隔线，正踩 §3「工具栏行距 py-3/pb-3 起步，避免按钮紧贴分隔线」**。修法：`pt-3`。
- `bili/components/memory/MemoryStatsCard.vue:143` — `v-card-actions class="px-0 pt-2 pb-0 ga-2"`，pt-2(8px)/pb-0 低于 py-3 起步。修法：`pt-3 pb-0`。
- `yaya/components/ModelSelectDialog.vue:261` — `px-5 pt-3 pb-2`，pb-2(8px) < 12px。修法：`pb-3`。
- `yaya/components/tree/ConversationTree.vue:824` — `.graph-toolbar { padding: 8px 20px 12px }`，顶部 8px < 12px。修法：顶部 12px。
- `yaya/components/UserMessage.vue:315`（`.user-actions{gap:2px}`）、`AssistantTurn.vue:778`（`.turn-actions{gap:2px}`）— 低于 `ga-1`(4px)。修法：`gap:4px`。
- `playground/components/ResponseViewer.vue:79` — `pa-2`(8px) 低于工具栏 py-3 起步。
- `settings/items/AbilityToggleSection.vue:164` — `px-2 py-1`(4px)；`ShortcutsSection.vue:294-300` — `.sc-row{padding-block:6px}`；
  `SidebarSection.vue:296` — `.ability-card px-3 py-2`。
- `systemd/View.vue:88-109` — 搜索/筛选行 `mb-2`，与列表间距仅 8px。
- （`ga-1` 大量出现在图标工具组/chip 组，§4.2 明确允许，**不算违规**。）

### 5.7 其他

- **`balance/components/BalanceSettingsSection.vue:344-346`** — `v-list-item-subtitle` 显示 API Key 掩码/明文，
  **无 `text-truncate`/`max-width`**，长 key 会撑破列表行（360px 下必出）。修法：加 `text-truncate` + `max-width`。
  这条同时是隐私展示问题，值得优先。
- **`settings/items/ShortcutsSection.vue:199`** — 根节点不用 `v-card … card-fill`，与同目录 14 个 Section 结构不一致。
- **`bili/components/duty/DutyRhythmCard.vue:123` 与 `:153-155`** — `v-progress-linear v-else-if="!cfg"` 与「节奏读取中…」
  在 `!cfg` 且无错时**同时渲染** = 双加载指示。修法：二选一。
- **`bili/components/ChatPage.vue:254-259`** — `v-empty-state` 缺 `:text`（§7 范式 icon+title+text）。
- **`ModelSelectDialog.vue:502`** — `max-height: 82vh` 用裸 `vh`；同族 5 处都用 `calc(var(--app-vh) …)`。
  该卡 `:fullscreen` 时被 `max-height:100%` 覆盖（`:556-560`），桌面无影响 → **风险低，建议统一 `--app-vh`**。
- **`bili` 四域 Tab 嵌套滚动**：四个 Tab 挂在 `SubPage.vue` 里，却又各自开固定 `max-height` 内滚区
  （`DmTab.vue:494-497` 320px、`NodeList.vue:197-200` 560px、`ToolLogCard.vue:171-174` 560px、`LedgerRunsCard.vue:190-193` 480px）
  → 外壳滚 + 列表滚**双层滚动条**。**「待确认」是否有意为之**；`KitPage` app 模式宜让内列表 `flex-grow` 吃满而非写死 max-height。
- **`settings/View.vue:514` + `scripting/View.vue:1764`** 硬编码 `inset:16px`（见 §4.1）。
- **浅色主题对比度**（§6 最后一条）：只读无法验证，全部标 **「待确认」**；已发现的高风险点是 §5.2 的自绘 chip 与 §5.3 的 hex。

### 5.8 「改了 CSS 但组件语义没删」——DESIGN §4.5 的三个现场（最有教学价值）

这三条不是「间距数字不对」，而是**规范里最容易被忽略的那类**：模板属性/CSS 与真实意图脱节。

1. **`yarj/components/MapPreferencesSection.vue:739-743` 是一条死规则**。
   它写 `.filter-chip, .filter-type-chip { padding-block:4px; min-height:24px }`，想修 chip 内边距；
   但 `PhotoFilterRulesManager` 是**子组件**（挂在 `MapPreferencesSection.vue:646`），`.filter-chip` 在子组件
   内部（`PhotoFilterRulesManager.vue:144`）——Vue scoped CSS 只给子组件根节点打父 scope id，
   **父组件这条规则根本匹配不到**。于是 chip 依然吃 `PhotoFilterRulesManager.vue:273-276` 的
   `.filter-chip { height:22px; font-size:0.72rem }`（把全局 `height:auto` 覆盖成 22px、字号压到 11.5px）。
   **修法**：删掉 `MapPreferencesSection.vue:739-743` 整段（死代码，别留着骗自己）；
   `PhotoFilterRulesManager.vue:273-276` 改成继承全局，或统一在 `global.css` 加一个 `.v-chip--compact` 变体。
2. **`aidj/components/ChatView.vue:1517,1527,1536` 挂了不存在的 class**：`class="status-chip"`，
   但该文件内没有任何 `.status-chip` 规则（对照 `ChatStatusBar.vue:564-585`、`BtChatView.vue:676-696`、
   `ContinuousView.vue:553-574` 三处都各有自己的一份 `.status-chip` CSS）→ 高亮态 `.status-chip.is-on` 全部失效。
   **修法**：删死 class，或统一收进 `KitStatusChip`。这也解释了为什么同一个视觉模式在 aidj 有四份 CSS。
3. **`aidj/PlayerView.vue:975-1014` 用 `!important` 把 `v-chip` 拆成「图标圆 + 文字」**：
   模板写 `<v-chip>`，窄屏 CSS 用 `padding:0 !important; background:none; border:none` 覆盖掉 chip 外壳，
   改成竖排图标圆钮。正是 §4.5 说的「改了样式但组件语义没删」。
   **修法**：抽成 `KitToolButton`（图标圆 + caption），不要复用 `v-chip` 再覆盖。
   相邻的 `PlayerView.vue:844` `.volbal-chip { padding-block: 2px }` 也低于 4px 底线。

### 5.9 aidj / yarj 的间距与拥挤（补充）

**aidj 间距低于 §3（`py-3`/`pb-3` 起步）**：`View.vue:1027`（`.sessions-head{padding:2px 4px 6px}`）、
`components/PlayerMenu.vue:535`（`.menu-head{padding:2px 4px 6px}`）、`components/FreqList.vue:103`（工具条 `px-1 pt-1 pb-1`）、
`View.vue:744`（`px-1 pt-1`）、`:756`（`px-1 pt-2 pb-1`）、`:770`（`px-1 pb-1`）、`:829`（`.models-scroll px-2 pt-2 pb-2`）、
`PlayerView.vue:696`（底栏 `px-4 py-2`）、`components/BiliDownloadView.vue:310`（`pb-1`）、
`components/MetadataSlotsView.vue:506`（详情头 `pb-2`）、`components/SanitizeView.vue:705`（映射行 `py-1`）、
`components/ListeningStatsView.vue:539`（`.stats-window-total px-4 py-2`）、`apps/SearchRootsSection.vue:149`
（`.rules-list{padding:10px 6px 8px 2px}`，左右 6/2px）。
**修法**：统一由 `KitToolbar` 默认 `py-3` / `KitSectionCard` 默认 `pa-4` 提供，页面不再自己写。
> 注：`aidj/components/ChatView.vue:1654` 输入条 `px-4 pb-3` 按 §3 字面（`px-4 py-4`）不满足，
> 但实际纵向 ≈ 22px（上邻 status bar 10px + 12px）——**「待确认」**是否算达标；
> 合规样板是同文件族的 `BtChatView.vue:535` `px-4 py-4`。

**aidj 一行塞太多（§4.2，均无 `flex-wrap`）**：
`components/MetadataSlotsView.vue:349-387`（桌面 6 控件一行，`:826-827` 的注释自证「之前一行塞五样东西，标题被挤成逐词竖排」）、
`:506-529`（详情头 6 控件）、`:458-497`（卡内 2 文字钮 + 2 图标钮同行）、
`components/BiliDownloadView.vue:181-204`（`.bili-head` 无 wrap，长标题被压）、
`View.vue:718-742,815-828,835-848`（弹层头 4 控件，340px 弹层内易挤）、
`PlayerView.vue:696-796`（底栏左 2 chip + 右 3 工具，`:946-951` 窄屏还显式 `flex-wrap:nowrap`）、
`components/ChatView.vue:1508-1580`（顶栏 6+ 控件，桌面无 wrap 无分组，窄屏 `:1989-1992` 才 wrap）。
**修法**：`KitToolbar` 的 `iconTools`/`textTools` 分组 + 默认 `wrap`。

**yarj 一行塞太多**：`components/PhotoLightboxModal.vue:354-427` 顶栏右侧 **8 个图标按钮**
（放大/缩小/复位/逆时针/顺时针/信息/文件夹/关闭）挤在 `d-flex align-center flex-shrink-0`，**无 `flex-wrap`、无分组**。
**修法**：分「视图工具组（缩放/旋转/复位，`ga-1`）」+「文件与信息组（信息/文件夹，`ga-2`）」+「关闭（`ml-2` 独立）」并补 `flex-wrap`。
另 `components/RoutePlaybackBar.vue:86,141-253` 第一行同时放头像 + 标题 + 3 个实时 chip + 5 个动作按钮
（已有 wrap 与窄屏专项兜底 `~464-476`，桌面中等宽度仍偏挤，**待实测**）。

**yarj 间距**：`components/JsonTreeNode.vue:34,40` `py-0-5`（2px）、`:60` `my-0-5`；`components/PhotoSideDrawer.vue:315`
底栏 `py-2`（8px，低于 py-3 起步；同文件 `:169` 顶栏 `py-3` 是合规的）；
`components/PhotoFilterRulesManager.vue:227` `ga-1-5`（自定义 6px，魔法数字，建议并入 kit gap token）；
`components/RoutePlaybackBar.vue` CSS `.slider-wrap { margin-top:-4px; margin-bottom:-6px }`（负 margin 挤压）。

---

## 6. d. 每个 ability 页面适合哪种 KitPage 滚动模式

判定依据：页面是否有自己的内部滚动区 / 是否画布类 / 外壳要不要出滚动条。
**三档分布：canvas 3（cli/ft/scripting）、app 9（aidj×3/bili×5/settings/logs/playground/yaya）、document 7+**。

| ability / 页面 | 建议 mode | 依据（`文件:行号`） |
| --- | --- | --- |
| `aidj/View.vue` | **app** | `.aidj-shell{position:absolute;inset:0;overflow:hidden}` `:938-942`；`useNavStack` `:39`；主体 `ChatView` 同样 absolute + `.chat-area{flex-grow:1;overflow-y:auto;min-height:0}`（`components/ChatView.vue:1819-1829`）；整页浮层 `ListeningStatsView`（`:616-622`）与 `SanitizeView`（`:1006-1012`）各自内部滚 |
| `aidj/PlayerView.vue` | **app**（偏 canvas） | `.player-shell{position:absolute;inset:0;overflow:hidden;display:flex;flex-direction:column}` `:801-808`；三段固定：`PlayerMenu`（`:582-603`）、`.player-body flex-grow-1 min-h-0 pb-6`（`:616`）、`.volume-footer flex-shrink:0`（`:839-841`）+ `.spectrum-wrap flex-shrink:0`（`:888-893`）。整页无滚动，仅内部子菜单滚 |
| `aidj/LyricsView.vue` | **app**（偏 canvas） | 根 `.aidj-lyrics-page{position:absolute;inset:0;flex-column;min-height:0;overflow:hidden}` `:1160-1171`；头部/进度条固定（`:927-1055`），`.lyrics-body{flex-grow:1;min-height:0;overflow:hidden}` `:1358-1367`，歌词滚动区 `.lyric-scroll{position:absolute;inset:0;overflow-y:auto}` `:1375-1385` |
| `apps/View.vue` | **document** | 0 处内滚；`v-empty-state` `:849`；DESIGN §2 排版标杆本是文档流（根是普通 `<div>` `:679`，由外壳 `.page-host` 兜底、内容超高时外壳滚，正是 §4.6 认可的正常行为） |
| `autostart/View.vue` | **document** | `v-row dense` 卡片网格 `:70-102`，无定高；`v-empty-state` `:104` |
| `balance/View.vue` | **document** | `v-row/v-col` 卡片网格 `:915-1374`；`min-height:calc(--app-vh-96px)` `:1747,1751` 只为「少内容也铺满」，超高自然溢出到外壳（§4.6 认可的正常行为） |
| `balance/components/ProfileManagerView.vue` | **document** | `v-for` 卡片列表 `:439-612` + `pb-6` `:336` |
| `bili/View.vue` | **app** | `.bili-shell{position:absolute;inset:0}` `:349-357`；聊天主页 + 四个全屏子页 `:331-334` |
| `bili` 四个子页 | **app** | `bili/components/SubPage.vue:69-90`（`flex:1 1 auto;min-height:0` + 内部 `overflow-y:auto`） |
| `cli/View.vue` | **canvas** | `.cli-page{height:calc(var(--app-vh)-96px);overflow:hidden}` `:267-270`；输出区内部滚 `:282-286`；注释 `:265-266` 原文说明理由 |
| `dashboard/View.vue` | **document** | gridstack 容器高度随卡片增长 `:397-746`（`float:true` 注释 `:138-140`）；无外壳定高 |
| `discoverer/View.vue` | **document** | `v-row dense` 卡片网格 `:294-353`；1s 轮询 `:122` |
| `ft/View.vue` | **canvas** | `.ft-root{height:calc(var(--app-vh)-96px);min-height:320px;overflow:hidden}` `:656-665`；画布绝对定位 `:667-681`；注释 `:657-659` 原文说明理由 |
| `logs/View.vue` | **app** | 外壳 flex 列 `flex:1 1 0;min-height:240px` `:357-363`；滚动区 `flex:1 1 0;overflow:hidden` `:408-413` + ResizeObserver 量高 `:157-164` |
| `mirror/View.vue` | **document** | `v-row dense` 卡片网格 `:156-215`，无内部滚动区、无定高 |
| `playground/View.vue` | **document** | 无内部滚动容器，编辑区/表单/结果顺序堆叠 `:594-630`；右侧 `.pg-panel` 是 `position:fixed` 玻璃悬浮面板 `:701-722`，≥721px 用 `padding-right:336px` 让位 `:773-777`，≤720px 转底部 overlay `:784-814`；根仅 `min-height:100%` `:688-691` |
| `scripting/View.vue` | **canvas** | `.scripting-ide-root{position:absolute;inset:16px;overflow:hidden}` `:1764-1774`；编辑器/控制台/配置面板各自滚 `:1874,:1930,:1988`；分隔条可拖 `:1883-1891` |
| `settings/View.vue` | **app** | 双栏各自滚动：`.settings-nav-list{overflow-y:auto}` `:524-527`、`.settings-content{overflow-y:auto}` `:545-549`；根 `position:absolute;inset:16px;overflow:hidden` `:515-520`；并用 `holdHost()` 把宿主 min-height 临时置 0 `:263-266,284,302` |
| `systemd/View.vue` | **document** | `v-list-item v-for` 长列表 `:113-173`，无内部滚动区、无定高 |
| `toolbox/View.vue` | **document** | `.toolbox-page` 定宽居中 `:239-244`；目录网格 `:195-227` 与工具详情 `:109-139` 顺序堆叠；仅结果区自带 `max-height:540` 内滚（`ToolRunner.vue:486-497`） |
| `yarj/View.vue` | **canvas** | `.yarj-shell{position:absolute;inset:0;overflow:hidden}` `:3118-3121`；地图画布 + 停靠 UI |
| `yaya/View.vue` | **app** | `.yaya-shell{position:absolute;inset:0;display:flex;overflow:hidden}` `:2040-2047`；`container:yaya/inline-size` `:2046`；唯一滚动容器 `.scroll{flex:1 1 auto;min-height:0;overflow-y:auto}` `:2247-2252`；固定 composer `:2361-2365` |
| yaya 各插件的 toolView / cardView | **canvas（卡片单元）** | 不是整页、不参与 KitPage；每张卡自含边界与内部滚动：`cockpit/CommandRunView.vue:218-230`(320px)、`cockpit/SnapshotView.vue:129-141`(420px)、`playground/components/ResponseViewer.vue:141-151`(320px)、`yarj/components/JsonTreeView.vue:204-209`(420px)、`widget/WidgetView.vue:187-199`(360px)、`roleplay/RoleplayCard.vue:217-229`(320px)、`yaya/components/WorkflowCard.vue:668-678`(320px) |
| bili 六个 settings Section | **document** | 纯流式 `d-flex flex-column ga-4`，无 height/overflow：`AccountSection.vue:234`、`CompactSection.vue:234`、`DmSection.vue:170`、`AsrSection.vue:310`、`DutySection.vue:674`、`ProvidersSection.vue:388` |
| yaya 18 个 settings 分区 | **document** | `YayaSettingsSection.vue:735-737` `.yaya-settings{width:100%}`，无 overflow/min-height/absolute；分区根同样只 `width:100%`（12 处）；滚动位置靠 `useScrollMemory` + 外壳滚动容器 |

> **术语定义（先读，否则迁移时会选错 mode）**：
> - `document` = 普通文档流，滚动归宿主外壳（`App.vue:1734` 的 `.page-host`）。
> - `app` = 页面铺满视口，**固定 chrome（顶栏/底栏）+ 唯一一个内部滚动区**（聊天、设置双栏、播放器）。
> - `canvas` = 页面铺满视口，**页面级零滚动**，滚动全部下沉到浮层/停靠面板；通常是画布、地图、IDE、终端。
>
> 三份子报告把「自管滚动容器」的页面叫 canvas（含 `yaya/View.vue`、三个 aidj 页面）。
> 本文按上面的定义把它们归到 `app`（它们都有固定 chrome + 一个主滚动区），
> `canvas` 只留给真正页面级不滚的（cli / ft / scripting / yarj 地图 + 对话流内卡片单元）。
> **建议 kit 文档把这三条定义写死**，否则同一页会被不同人归到不同 mode。

---

## 7. e. 「次要元素」窄屏隐藏机会

现状：手写窄屏隐藏**只有个位数处**（`yaya/components/WorkflowCard.vue` 的 `.wf-hide-narrow` 5 处引用 `:304,365,409` + 定义 `:723-731,745-747`；
`yaya/plugins/deputy/DeputyResultView.vue` 的 `.dp-hide-narrow` `:77,186-190`；
`settings/items/AbilityToggleSection.vue:253-256` 隐藏能力 id；`scripting/View.vue:2108-2116` 隐藏按钮标签 + mask 渐隐；
`bili/components/chat/SessionList.vue:135-139` 隐藏会话计数）。
说明 `KitSmartRow` 的 `priority="secondary"` **大部分是新增能力，不是重构**。

**统一退化规则建议**（写进 kit，别让每页自己写 media query）：
1. 先隐藏 `priority="secondary"`（≥1 个仍可见）；
2. 再不足 → 换行（`flex-wrap` / grid 重排，参照 `aidj/components/WorkflowCard.vue:369-392`）；
3. 仍不足 → 收进「⋯」溢出菜单（参照 `yaya/components/plugin-kit/DiagramFrame.vue:5-6`）。

**可标的次要元素**（合并三份子报告 + 自查）：

| 位置 | 元素 |
| --- | --- |
| `aidj/components/WorkflowCard.vue:147-153` | 头部 tokens 计数 + `formatMs(elapsed)`（yaya 版已隐藏 tokens，`:304`） |
| `aidj/components/WorkflowCard.vue:194-196` | 每步 `.wf-ms` 耗时 |
| `aidj/components/FreqRow.vue:70` | `x{{times}}` 播放次数 |
| `balance/View.vue:988-1000` | 延迟 chip `{{latencyMs}}ms` |
| `balance/View.vue:1310` | 卡底 `formatTime(b.updatedAt)` |
| `balance/components/ProfileManagerView.vue:454-456` | `ID: {{prof.id}}` chip |
| `balance/components/ProfileManagerView.vue:467-469` | `prof.partition` 等宽长串（同时要 `text-truncate`，见 §5.7） |
| `balance/components/ProfileManagerView.vue:503-518` | 「关联卡片」chip 行 → 折叠成「N 张」 |
| `systemd/View.vue:128-130` | `u.active`/`u.sub` chip（prepend 图标颜色已表意 `:116-124`） |
| `dashboard/View.vue:452-459` | pacman/flatpak 计数 chip |
| `dashboard/View.vue:599-608` | GPU 的 fanSpeed/power/powerLimit 行 → 只留 vram |
| `mirror/View.vue:186-189` | 下载速度独立行 |
| `discoverer/View.vue:271-280` | IPv6 行（多折行） |
| `bili/components/chat/MessageRow.vue:132` | msg-meta（耗时/token caption） |
| `bili/components/tools/LedgerRunsCard.vue:126-131` | 行尾三连 caption（步数/工具、ms、token） |
| `bili/components/chat/RunLedgerCard.vue:90-96` | 步骤行 tokens+ms 双 caption |
| `bili/components/dm/WatchStatusCard.vue:281-307` | 6 段统计行 |
| `bili/components/duty/DutyStatusCard.vue:537-554` | 分阶段 token 预算行 |
| `bili/components/memory/MemoryStatsCard.vue:198-223` | 9 段汇总行 |
| `bili/components/memory/NodeList.vue:164-169` | 副标题 node-id + 权重 |
| `bili/components/tools/CapabilitiesCard.vue:248-261` | 记忆目录整段路径 |
| `bili/components/settings/ProvidersSection.vue:419-425` | baseUrl caption |
| `bili/components/chat/SessionList.vue:101-109` | 「N 条消息 · 时间」副标题 |
| `bili/components/DutyTab.vue:240-248` | 流水行 token caption |
| `yaya/components/ModelSelectDialog.vue:347` | `.info-chip` 显示 provider.type（与图标语义重复） |
| `yaya/components/ModelSelectDialog.vue:395-401` | `.active-tag-chip`「当前使用」（`v-list-item :active` 已有勾选） |
| `yaya/components/UsageDialog.vue:413-417,442-444,348-350` | log-meta 时间+耗时、「只保留最近 1000 条」提示、「共 N 次调用」 |
| `yaya/components/settings/ProviderDetail.vue:265-272` | `model_search_hint` 长说明 |
| `yaya/components/settings/ProvidersSection.vue:190-199` | `.provider-row-sub` 里的 `· {{baseUrl}}` |
| `yaya/components/AssistantTurn.vue:587-593` | `.usage`（模型名 + tokens）→ 只留 tokens |
| `yaya/components/tree/ConversationTree.vue:725-740` | `.node-meta` 的 meta-time / node-fork |
| `playground/components/ResponseViewer.vue:89` | `{{duration}}ms` |
| `playground/components/ResponseViewer.vue:113-114` | copy/download 两个 flat 文字按钮 → 合并为图标 |
| `playground/components/GlobalVars.vue:58` | 计数 chip |
| `yaya/plugins/cockpit/CommandsTableView.vue:159-162` | notes 行的 usage |
| `yaya/plugins/cockpit/CommandRunView.vue:110-115` | 标量行的 key → 只留 value |
| `yaya/plugins/search/SearchResultView.vue:134-136` | 引擎标签 |
| `yaya/plugins/models/UsageCost.vue:57-65` | 第二行 caption |
| `yaya/plugins/roleplay/RoleplayCard.vue:92-94` | `.rp-sub` 与标题重复 |
| `yaya/plugins/storyteller/StoryStateCard.vue:52-60` | 「第 N 章 · 第 M 轮」→ 缩为「N-M」 |
| `yaya/plugins/interactgame/GameBoard.vue:156-159` | X=AI/O=你 图例 |
| `yaya/plugins/mention/MentionPicker.vue:136-139` | 「未启用」提示 |
| **aidj** `View.vue:756-761` | 会话计数的「会话」文字标签（数值 chip 保留） |
| **aidj** `LyricsView.vue:942-950` | 歌词来源 chip（YRC/LRC） |
| **aidj** `LyricsView.vue:955-962` | 播放器名副标题（dbus 模式也降级为「仅图标」，内置模式已在 `:1577-1579` 隐藏） |
| **aidj** `LyricsView.vue:1053` / `PlayerView.vue:646-659` | 进度时间 `0:00 / 3:24` → 只留当前时间 |
| **aidj** `PlayerView.vue:636-642` | 状态 chip（Playing/Paused，播放/暂停图标已表意） |
| **aidj** `components/MetadataSlotsView.vue:426-443` | 「写入目标 / B站默认」tag chip（左边框色已表达） |
| **aidj** `components/BiliDownloadView.vue:392-403` | UP 作者 + `•` + BVID 行 → 只留 UP |
| **aidj** `components/AidjSettingsSection.vue:1597-1617` | B站 Lv./大会员/已登录三连 chip → 只留「已登录」 |
| **aidj** `components/ContinuousView.vue:306-308` | `played / total` chip |
| **aidj** `apps/View.vue:742-750` | 搜索根 chip 的完整绝对路径 → 只显示末两级 + `title` |
| **aidj** `apps/View.vue:802-810` | 应用标签 chip → 最多 2 个，其余「+N」 |
| **yarj** `components/RouteSideDrawer.vue:146-159` | 5 个活动筛选 chip（600px 下必挤两行，`flex-wrap ga-1`）→ 只留「全部/骑行/跑步」 |
| **yarj** `components/RouteDetailModal.vue:302-308` | 设备 chip（metrics 网格已有） |
| **yarj** `components/YarjPageMenu.vue:60-63` | 当前图源 chip → 截断为前 8 字符 + `title` |
| **yarj** `components/RouteDetailModal.vue:371-373` | tab 标题的 `(N)` 计数 |
| **yarj** `View.vue:2857-2874` + CSS `3188-3202` | 无照片提示 pill（`bottom:24px`）会与窄屏播放栏/探索栏（`bottom:8px` 全宽）**重叠**——「待实测」，建议 compact 下改 `bottom:96px` 或隐藏 |

**aidj 已有的好样板（可固化进 kit）**：`ChatStatusBar.vue:42-69,216-255`（按实测宽度折叠 + 「+N」底部弹层）、
`BtChatView.vue:749-774`（container query 2 列 + 隐去发送钮前置图标）、`ChatView.vue:1981-2022`（顶栏两行 + 隐藏「正在播放」文字与 API 文字）、
`WorkflowCard.vue:369-392`（container query 改 grid）。
**yarj 已有的好样板**：`PhotoLightboxModal.vue:337-346,357,365,381,413`（`v-if="!compact"` 收起文字按钮/GPS chip/放大缩小/逆时针/文件夹，
注释 `:355`「窄屏：放大缩小靠双指/双击…」）、`YarjControls.vue:29-34`（`v-show="!(compact && (explorationActive||routePlaybackActive))"` ——
**全库唯一一处「整块避让」逻辑**，`KitPage` 可提升为 `compact` inset 变量统一处理）。

---

## 8. 每个 ability 小结

### aidj（`View.vue` 1188 行 + `PlayerView.vue` + `LyricsView.vue` + 24 个 components）
- **滚动模式**：三个页面全部 **app**（`PlayerView`/`LyricsView` 偏 canvas，见 §6）。
- **值得抽**：`KitPage(app)`、`KitWorkflowCard`（`components/WorkflowCard.vue`）、`KitSettingRow`（**10 处**：
  `AidjSettingsSection.vue:1990-2018`、`SanitizeView.vue:811-841`、`ChatStatusBar.vue:404-446`、
  `AgentModelsPanel.vue:207-233` …）、`KitSectionCard`（**10 处**：v-card 家族 4 + 手写 `.xxx-card` 6）、
  `KitToolbar`（**17 处**）、`KitEmpty`（9 处已合规 + 8 处待替换）、
  `KitStatusChip`（`.status-chip` 家族 **3+1 处**，其中 `ChatView.vue:1517` 是死 class）、
  `KitFormDialog`（**14 处** + `ChatStatusBar.vue:390-449` 唯一一处 bottom-sheet）、
  `KitReorderRow`（**5 处**）、`KitGlassPopover`（**5 处**）、`KitPageMenu`/`KitContextMenu`（2+2，**CSS 逐条重复**）、
  `KitAsyncState`（9 处加载 + 5 处错误 + 8 处空）。
- **坑**：① `AidjSettingsSection.vue:980-1010,1068-` 两组三连图标按钮 `ga-1`，热区偏小；
  ② `WorkflowCard.vue:310-321` `.wf-badge{min-height:22px}` 低于 24px；③ `PlayerView.vue:975-1014` 用 `!important`
  把 chip 拆成图标圆（§5.8.3）；④ `ChatView.vue:1517,1527,1536` 死 class（§5.8.2）；
  ⑤ 十余处工具栏/行 `py-1`/`py-2`（§5.9）；⑥ `components/FreqList.vue:121` 的 `v-if="!loading && sorted.length"`
  **加载期间什么都不显示**（三态缺加载态）——**「待确认」是否有意留白**。
- **正面样板**：`FreqList.vue:151`、`MetadataSlotsView.vue:824`、`ChatStatusBar.vue:527` 都用 `--app-vh` 且带注释；
  `PlayerMenu.vue:191,204` 的 chip 无 `size` + `.menu-chip{min-height:24px;padding-block:4px}`（`:565-568`）；
  `SanitizeView.vue:660-669` closable chip 默认密度；`BtChatView.vue:364-397` `px-4 py-3` + `flex-wrap` 是合规工具条。

### apps（`View.vue` 1499 行，DESIGN §2 的排版标杆）
- **滚动模式**：**document**。
- **值得抽**：它自己就是标杆，**反向输入**——`KitSectionCard` / `KitToolbar` 的
  `v-card-actions class="px-4 pb-4 pt-0 ga-2"` + `flex-wrap` 范式应从它提炼（DESIGN §2:34-38；
  合规样板 `apps/View.vue:815`、`mirror/View.vue:198`）。另有 `KitReorderRow`（`SearchRootsSection.vue:70-112`）、
  `KitPathField`（**9 处**「输入框 + 追加图标按钮」）、`KitEmpty`（`View.vue:849` 合规 + `:1362-1364`、`SearchRootsSection.vue:114-116` 手写）、
  `TransformerModal.vue:157-238` 是**分组范式最完整的工具栏**（5 个图标钮 + tooltip）。
- **坑**：`SearchRootsSection.vue` 7 处 `size=small`、`TransformerModal.vue` 13 处、`UiNode.vue:44`——需抽查是否都是图标按钮；
  `View.vue:794,805` 与 `TransformerModal.vue:160,163,175` 用 `x-small` chip；
  `SearchRootsSection.vue:149` `.rules-list{padding:10px 6px 8px 2px}` 左右 6/2px。

### bili（`View.vue` 422 行 + ~50 个 components，最大的 ability）
- **滚动模式**：**app**（主页 + 四个全屏子页）。
- **值得抽**：`KitSubPage`（`components/SubPage.vue` 已做对，直接泛化）、
  `KitNumberStepper`（**4 份逐字实现 + 5 份配套 CSS**，它是最积极的产出者）、
  `KitSettingRow`（`.ctl` 行约 20 行）、`KitSectionCard`（17 处）、`KitToolbar`（卡头 16 处）、
  `KitChip`（22 处 CSS / 9 种类名）、`KitFormDialog`（9 个，**0 个 bottom-sheet**）、
  `KitAsyncState`（约 12 处）、`KitCodeBlock`（`<pre>` 5 处）、`useNarrow`/`useContainerWidth`。
- **坑**：① 四域 Tab 在 SubPage 内又开固定 max-height 内滚区 → **双层滚动条**（§5.7）；
  ② `settings/ProvidersSection.vue:653-657` 是全库少数真实的文字按钮 `size=small` 违规；
  ③ `memory/MemoryStatsCard.vue:143` 工具栏 `pt-2 pb-0`；
  ④ `duty/DutyRhythmCard.vue:123` + `:153-155` 双加载指示；
  ⑤ `chat/ChatPage.vue:254-259` 空态缺 `:text`；
  ⑥ `v-slider` 已全部退役（`bili/AGENTS.md` §5 硬禁项执行得最彻底）——**kit 的 `KitSettingRow` 必须内置这条禁令**。

### yaya（`View.vue` 2558 行 + ~48 个 components + 28 个插件 vue）
- **滚动模式**：`View.vue` **app**；18 个 settings 分区 **document**；插件卡片 **canvas 单元**。
- **值得抽**：`KitWorkflowCard`（窄屏退化做得最细）、`KitFormDialog`（`:fullscreen="narrow"` 15+ 处的主要来源）、
  `useNarrow`（7 处手写 matchMedia）、`KitSectionCard`（settings 12 处）、`KitSettingRow`（switch-row 9 处）、
  `KitListRow`（6 处）、`KitToolbar`（11 处）、`KitEmpty`（**14 处手写、0 处 `v-empty-state`**）、
  `KitChip`（10 处 `.chip-pad`）、`KitConfirmInline`（4 处）、`KitMediaViewer`（2 处）、`KitChunkedList`（2 处）、
  `KitInputBar`（1424 行的 `ChatInputBox.vue`）。
- **坑**：① `components/plugin-kit/`（`DiagramFrame.vue` + `ZoomDialog.vue` + `image-utils.ts`）
  **已经是一个锁在 yaya 里的 mini-kit**，且有「工具栏 <520px 收进 ⋮ 菜单」的退化实现——上移的**最佳起点**；
  ② `components/pop.css` / `tokens.css` 是能力内共享样式，上移时要一起评估；
  ③ `AssistantsSection.vue:591-594` 的 `.chip-pad` 写成 `min-height:28px`，与其余 9 处不一致；
  ④ `ModelSelectDialog.vue:502` 用裸 `82vh`；⑤ `UserMessage.vue:315` / `AssistantTurn.vue:778` `gap:2px`。

### yarj（`View.vue` 3411 行 + 24 个 components，最大的 canvas 页）
- **滚动模式**：**canvas**。外壳 `.yarj-shell{position:absolute;inset:0;overflow:hidden}`（`View.vue:3118-3124`），
  异步加载外壳 `.yarj-container-root` 同样 absolute（`YarjContainer.vue:37,44-50`）——**不参与** `App.vue:1734` 的
  `.page-host` flex 流，所以 `v-main scrollable`（`App.vue:1729`）不会为 yarj 出现空转滚动条，**现状已符合 §4.6**。
  `KitPage` 需要**保留**这个行为而不是改成 flex 拉伸。理由：地图手势不能被滚动容器吞；浮层各自管滚动
  （`PhotoSideDrawer.vue:249,401-405`、`RouteSideDrawer.vue:175,369-373`、`RoutePlaybackPhotosDrawer.vue:138,248-252`、
  `PhotoLightboxInfoPanel.vue:703-707`、`JsonTreeView.vue:204-209`、`RouteDetailModal.vue:377`）。
  若改成页面级滚动，`View.vue:2822` 的地图 `flex-grow:1` 会被顶开，`View.vue:3188-3202` 的 `bottom:24px` 提示 pill 与 `inset:0` 浮层会随页面漂移。
- **值得抽**：`KitJsonTree`（`JsonTreeView.vue` + `JsonTreeNode.vue`，功能最全的一份；自身 2 个消费点
  `PhotoCardItem.vue:526-530`、`PhotoLightboxInfoPanel.vue:635-639`）、
  `KitDrawer`（**3 份浮层 + 1 份 inline**，外壳逐行重复，props 草案见 §4.12）、
  `KitSectionCard`（**12 处**）、`KitSettingRow`（**10+ 处**）、`KitFormDialog`（5 处 `:fullscreen="compact"`）、
  `KitNumberStepper`（`MapFilesSection.vue:150-170` 的 `.zoom-stepper`）、`KitEmpty`（**13+ 处手写、全目录 0 处 `v-empty-state`**）、
  `KitChip`（**137 个 `<v-chip>`**，27 处无 class）、`KitReorderRow`（5 处）、`KitTriState`（2 处）、
  `KitGlassPopover`（10+ 处）、`KitPageMenu`、`KitAsyncState`（7 处）。
- **坑**：① `MapPreferencesSection.vue:739-743` 是**死规则** + `PhotoFilterRulesManager.vue:273-276` 把 chip 打到 22px（§5.8.1）；
  ② `JsonTreeNode.vue:84,89,93,97` 硬编码 hex（§5.3）；③ `JsonTreeNode.vue:41` 分支头用 `div @click`，
  **无 `role="button"`/`aria-expanded`**（对照 `toolbox/components/JsonTree.vue:22-28` 用了 `<button :aria-expanded>`）
  → inspector/AI 拿不到语义；④ `RouteDetailModal.vue:737` 是 yarj 唯一明确的文字按钮 `size=small` 违规；
  ⑤ 三份抽屉**无 Esc 关闭**（与 `PhotoLightboxModal.vue:83,287` 不一致）——可用性回退缺失；
  ⑥ 6 处 snackbar 各写一份 `snackOpen/snackText`；⑦ `useYarjCompact()` 被 8 个组件各调一次。
- **「待确认」**：三份抽屉无 scrim 是设计取舍（地图需常驻可见）还是遗漏——影响 `KitDrawer` 的 `scrim` 默认值；
  `PhotoLightboxInfoPanel` 桌面态是 flex 子项、另三份是 absolute 浮层 → `KitDrawer` 需同时支持 `mount:'inline'|'floating'`；
  地图配色是否跟随主题。

### settings（`View.vue` 550 行 + 15 个 items）
- **滚动模式**：**app**（左右两栏各自滚 + `holdHost()`）。
- **值得抽**：`KitSettingRow`（`WindowSection.vue` 同一模板抄 4 遍 + `ZoomSection.vue` 是范本）、
  `KitSectionCard`（`components/SettingsCategoryView.vue:110-125` 已实现网格，**kit 应与它对齐而非另起**）、
  `KitChip`、`KitEmpty`、`KitFormDialog`。
- **坑**：① `BootServicesSection.vue:78` 有「暂无开机服务」纯文本分支，`:166-176` 的 `v-empty-state` 用法正确
  ——同一文件两种空态；② `View.vue:410-415` 与 `:486-491` 同页两种手法；③ `ShortcutsSection.vue:199` 根节点不用 `card-fill`；
  ④ `items/AbilityToggleSection.vue:164` `py-1`、`ShortcutsSection.vue:294-300` `padding-block:6px`。

### 其余

- **cli（316 行）/ ft（815）/ scripting（2146）**：**canvas**。三者都手写了外壳定高
  （`cli/View.vue:267-270`、`ft/View.vue:656-665`、`scripting/View.vue:1764-1774`），
  且 `ft/View.vue:657-659` 的注释明确说「Pin to the viewport like cli/View.vue」——**抄来抄去的证据**。
  scripting 另有 `View.vue:1604-1628` 全库最严重的手写空状态、`:979` 的 `pt-1` 贴分隔线。
- **logs（532）/ playground（815）**：**app / document**。logs 的 ResizeObserver 量高（`:157-164`）与
  `.logs-scroll` 绝对定位（`:416-424` 与 `settings/View.vue:545` 同手法；`:511-531` 窄屏两行是正面样板。
  playground 的 `BtResponseView.vue:61-91` ≡ `FinalResponse.vue:38-68`（分块渲染逐字雷同）是最典型的「抄第二份」。
- **balance（1831）**：**document**，但 `View.vue:1747,1751` + `ProfileManagerView.vue:686` 三处重复解外壳高度；
  `BalanceSettingsSection.vue:87-186` 与 `View.vue:145-513` 是同一功能的两份完整实现；
  `View.vue:946` chip 组无 `flex-wrap`；`BalanceSettingsSection.vue:344-346` API Key 无 truncate。
- **mirror（223）/ autostart（121）/ systemd（182）/ toolbox（370）/ discoverer（388）/ dashboard（825）**：**document**。
  前四个都已有 `v-empty-state`，是 `KitEmpty` 的正面样本；dashboard 的 `NARROW_MAX=640` 拆单列（`:35,:188-199,:778-790`）是正面样板。
- **agent（3 个 components）**：`AgentSettingsSection.vue` 7 张卡（`:241,310,354,524,569`）+
  `AgentExclusiveSettings.vue:57-86` + `AgentScriptSettings.vue:87-179` 是 `KitSettingsCard` 的直接来源；
  同文件 `:530`「暂无连接」手写空态、`:639-642` `.chip-pad`。

---

## 9. 建议的抽取顺序

**第 0 步（不动业务代码，先立规矩）**
1. kit 里放**断点令牌 + 容器查询约定**（建议 420 / 520 / 600 / 720 四档），
   把现在散在 12+ 个文件里的 480/520/560/600/640/720 六种断点收敛。
2. 把 `global.css:611-615` 的 chip 规则、`:279-286` 的按钮规则在 kit 文档里写清楚，
   **禁止页面再写 `padding-block`**（现存 32 处）。
3. `useNarrow(bp)` + `useContainerWidth()`——消灭 7 处 matchMedia + 9 处 ResizeObserver，**成本最低、立刻可用**。

**第 1 批（P0，投入产出比最高，全部有 ≥3 处实证）**
4. `KitPage` —— 直接消灭 §4.1 的四种惯用法（11 个文件），并统一 §4.6 的外壳滚动条问题。
   app/canvas 用 `absolute; inset:0`，同时建议修订 DESIGN §4.6。
5. `useAsyncState` + `KitAsync` —— 把 `LoadingBar.vue:1-28`（视觉）与 `useLoading.ts:11-33`（状态）接上。
6. `KitFormDialog` —— `:fullscreen="narrow"` 15+ 处 + 9 个 bili 对话框 0 个 sheet，纯机械替换，风险最低。
7. `KitSettingRow` + `KitNumberStepper` —— 140 处 `justify-space-between` + 5 处步进器；
   **内置「设置页禁通栏 slider」**。
8. `KitJsonTree` —— 四份合一（§4.2），toolbox / playground / yarj 三处直接受益。
9. `KitSectionCard` —— 对齐 `components/SettingsCategoryView.vue:110-125`，不另起一套。

**第 2 批（P1）**
10. `KitEmpty`（先修 §5.4 的 25+ 处手写空态，yaya 14 处 + yarj 13+ 处是最大头）。
11. `KitChip` + `KitStatusChip`（顺手删 §5.2 的 32 处冗余 CSS，统一去掉 186 个 `size=small`；
    `KitStatusChip` 收编 aidj 的 `.status-chip` 四份）。
12. `KitWorkflowCard`（两份 WorkflowCard 的壳）。
13. `KitSubPage`（泛化 `bili/components/SubPage.vue`）。
14. `KitToolbar`（从 `yaya/components/plugin-kit/DiagramFrame.vue` 上移）+ `KitGlassPopover`（aidj 5 处 / yarj 10+ 处）。
15. `KitDrawer`（yarj 三份抽屉 + `PhotoLightboxInfoPanel` inline 变体）+ `KitReorderRow`（aidj 5 / yarj 5）。
16. `KitCodeBlock`（9 处 `<pre>`）+ `KitListRow` / `KitList`。
17. `KitPageMenu` / `KitContextMenu`（aidj 两对 CSS 逐条重复）+ `KitPathField`（9 处）。
18. `KitSmartRow`（`priority="secondary"`，§7 的机会清单）+ `KitTriState`。

**第 3 批（P2）**
19. `KitCopyButton` / `KitConfirmInline` / `KitChunkedList` / `KitMediaViewer` / `KitStatCard` / `KitToolButton`。
20. `KitTabs`（先观察 yaya 四种互不兼容实现能否真合并）。
21. `KitInputBar`（六份输入框差异大，只抽「+」面板 bottom-sheet 化）。
22. kit 的 `src/`（非组件）提供 util：`asRecord/asNumber/…`、防抖保存、深拷贝守卫、轮询 Hook、snackbar 单例。

**每批验收**：迁移一个能力 → `pnpm typecheck && pnpm lint` → 按 DESIGN §6 清单过一遍 →
窄屏（390×844 / 360×800）实拍。**bili 还要跑它自己的 `text-density-lint.mjs` 与 `settings-shot.mjs`**（`bili/AGENTS.md` §5）。

---

## 10. 坑与「待确认」

1. **`useLoading` 存在但零使用、`LoadingBar` 有 6 个消费者但两者不相通**。`useAsyncState` 不要另写一套，
   包 `useLoading.ts:11-33` 并在视觉上复用 `LoadingBar.vue:16-27`；否则框架里会有三个 loading 原语。
2. **`global.css` 已统一 chip 内边距**（`:611-615`），所以「所有 chip 都没内边距」这个说法不准确——
   准确的是：**32 处页面在重复写这条规则**（冗余），而 **真正没内边距的是自绘 class 与裸 `v-chip` 的那些**
   （`mirror/View.vue:172-182`、`dashboard/View.vue:452-459` 等，§5.2 末尾清单）。这两件事要分开修。
3. **文字按钮 `size="small"` 全库仅 6 处**（§5.1），任务前提里说的 31/26 处不成立。别让人去「修不存在的问题」。
   真正系统性问题的是 **186 个 chip `size=small`** 与 **约 60 处 `x-small`**（后者是规范没划边界）。
4. **kit 组件必须透传 `v-privacy` / `v-agent-forbidden` / `aria-label` / `title`**：AI inspector 靠
   `aria-label`/`title` 拿 ref（AGENTS「UI 写法要求」），隐私脱敏靠指令继承。抽成 kit 时最容易丢的就是这两样。
   另外 `balance/components/BalanceSettingsSection.vue:344-346` 的 API Key 行连 `text-truncate` 都没有——kit 的列表行原语应内置。
5. **高度计算一律 `var(--app-vh)`，不要裸 `100vh`**。已遵守的：`cli/View.vue:267`、`ft/View.vue:656`、
   `balance/View.vue:1747`、`aidj/components/FreqList.vue:150`（带注释）、`App.vue:1818`。
   仍写 `100vh`/裸 `vh` 的：`aidj/windows/LyricsWindow.vue:633,778`、`aidj/components/ChatStatusBar.vue:527`、
   `yaya/components/ModelSelectDialog.vue:502`（`82vh`）。**「待确认」手机上是否真有实际问题**（多数是 `calc(100vh - N)` 形式）。
6. **`absolute inset:0` 与 `calc(100vh-96px)` 不是等价实现**：`bili/View.vue:340-348` 的注释指出 appbar 实测 55px
   而非 48/64px，魔数口径会短一截。建议 DESIGN §4.6 改认 `absolute; inset:0` 为首选，
   `KitPage` 统一用它；`settings/View.vue:514` 与 `scripting/View.vue:1764` 的 `inset:16px` 则硬编码了外壳 `pa-4`，也要一并收编。
7. **bili 的设置页 slider 门禁与 kit 的冲突风险**：`KitSettingRow` 若默认渲染 `v-slider`，
   bili 迁移时会立刻踩它自己的 `settings-shot.mjs` 门禁。**建议 `KitSettingRow` 默认给步进器，slider 显式 opt-in。**
8. **「canvas」的定义要先写死**：本文把画布/IDE（cli/ft/scripting/yarj 地图）与对话流内卡片单元叫 canvas，
   把固定顶栏+可滚内容+固定底栏叫 app。有子报告把 `yaya/View.vue` 叫 canvas（因为它自管滚动容器）。
   定义不统一会导致迁移时选错 mode。
9. **`docs/ui-density-rework-report.md` 被引用但不存在**——凡以它为据的结论本文已重新取证（§0）。
10. **未逐行读完的部分**（相关结论标「待确认」）：`toolbox/components/ToolRunner.vue:65,277` 的 LeisurePanel 滚动模式、
    浅色主题对比度、720px 实拍、`aidj/components/PlayerMenu.vue:180` 的 `v-switch size="x-small"` 是否按 chip/按钮同标准治理
    （DESIGN 未明文覆盖 switch）、`aidj/components/FreqList.vue:121` 加载期无反馈是否有意留白、
    yarj 三份抽屉无 scrim 是设计取舍还是遗漏、`aidj/components/ChatView.vue:1654` 输入条纵向 ≈22px 是否算满足 §3。
11. **无障碍是 kit 最容易丢的东西**：`yarj/components/JsonTreeNode.vue:41` 的分支头用 `div @click`，
    没有 `role="button"`/`aria-expanded`（对照 `toolbox/components/JsonTree.vue:22-28` 用了 `<button :aria-expanded>`）；
    AI inspector 只认 `aria-label`/`title`。**`KitJsonTree` / `KitDrawer` / `KitSmartRow` 都必须内置。**
12. **yarj 的 `compact` 断点用容器宽度（`useYarjCompact.ts:5-30`，`YARJ_COMPACT_WIDTH=600`）而非视口断点**，
    且被 8 个组件各调一次。`KitPage` 应直接注入这个 `compact` ref，别让每个浮层再 inject 一遍。
    这也说明 kit 需要**同时**支持视口断点（`useNarrow`）与容器断点（`useContainerWidth`）两套。

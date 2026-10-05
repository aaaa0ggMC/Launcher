# 当前工作计划与进度（2026-10-06）

## 本轮目标

1. 修复 AIDJ 聊天输入 `/` 后的命令候选弹窗：移动端触摸滚动不能误选命令。
2. 完成 Android / headless 目录选择修复：支持系统目录选择，并修复手输 `//storage/emulated/0/...` 后确认却回退到 Termux 家目录的问题。
3. 与正在处理响度、歌词页和移动端状态栏的 OpenCode 工作包隔离，避免覆盖或混入其改动。

## 已完成

### AIDJ `/` 命令弹窗

- 已提交：`36c708f fix(aidj): allow scrolling slash command popup`。
- 修改文件：`src/abilities/aidj/components/ChatSlashPopup.vue`。
- 交互现在区分轻触与拖动：只有同一候选行内完成、移动距离未超过阈值的抬起才应用命令；滚动、`pointercancel`、多指、非鼠标左键、移出候选行均不应用。
- 触摸/笔事件不再调用 `preventDefault`，WebView 可按 `touch-action: pan-y` 接管纵向滚动。
- 移动端候选行最小触摸高度为 44px；桌面鼠标悬停与单击行为保留。
- 下游 OpenCode 会话 `ses_ef337ec8affeJVEiaXjKgcWe5E` 因单文件任务运行过久被中止；副总监已独立 review、修正并完成提交。

### Android / headless 目录选择

实现已在工作区，尚未提交：

- `host.fs.list` 会展开 `~`，并归一化重复斜杠、尾斜杠和相对路径；`//storage/emulated/0/...` 不再被错误回退。
- `HostFilePicker.vue` 的“选择此文件夹”以输入框当前内容为准；未按回车直接确认时，会先读取目标目录，失败则留在弹窗内显示错误。
- Android App 新增 `pickDirectory`，使用 `ACTION_OPEN_DOCUMENT_TREE`；可确定映射的 `primary` 卷返回 `/storage/emulated/0/...` 真实路径，无法可靠映射的 SD 卡、Downloads 或网盘明确报错。
- 目录模式下 Android App 显示“从设备选择文件夹”；普通浏览器显示无法取得宿主目录路径的说明。
- Android 版本已准备为 `versionName 0.4.0`、`versionCode 4`，根包版本准备为 `0.4.0`；说明写在 `docs/android-v4.md`。
- 副总监 review 时把系统选择器 busy 状态改成响应式状态，选择期间按钮会正确禁用。

## 已完成验证

- `pnpm typecheck`：通过，223 个 Vue 模板，0 errors。
- `pnpm lint`：0 errors；当时另一个工作包在 `builtin-tools.ts` 留有 1 条 Prettier warning。
- Android / headless 相关文件定向 ESLint：通过。
- `src/headless/commands.test.ts`：2/2 通过，覆盖双斜杠、尾斜杠、`~`、空路径与不存在目录。
- `android/gradlew assembleDebug`：成功。
- 两组待提交内容均已通过 `git diff --check`；AIDJ `/` 弹窗提交前隐私扫描无命中。

## 仍需完成

1. 等正在运行的 OpenCode 工作包结束，确认它没有改动 Android / headless 目录选择文件。
2. 复核 Android 目录选择相关 diff，按明确路径暂存，运行 deputy 隐私扫描并单独提交；不要暂存响度、歌词或状态栏文件。
3. 真机验证 Android 0.4：
   - 输入 `//storage/emulated/0/<目录>` 后直接点“选择此文件夹”，返回规范化后的目标目录。
   - 系统目录选择器选择内置存储子目录后，页面能浏览并确认该目录。
   - 取消系统选择器时弹窗保持打开且不报错。
   - 选择无法映射的提供者时显示回退提示，不伪造路径。
4. 真机验证 AIDJ `/` 弹窗：轻触应用命令，纵向拖动只滚动，不发生误选。

## 并行工作边界

用户已有 OpenCode 会话 `ses_ef390fc82ffe4iwUY8AAybBQtH` 正在处理以下范围，本计划不修改这些文件或逻辑：

- 长时间 loudness / peak 分析与 metadata 回填。
- LUFS 第一首及移动端音量定位。
- 歌词页手动滚动后约 10 秒恢复自动滚动。
- 移动端歌词页、播放器布局、headless 下隐藏桌面歌词入口。
- 小屏状态栏自动收缩、溢出项合并和顶部控件避让。

其当前工作区文件包括 `src/abilities/aidj/player-backend.ts`、`services/loudness.ts`、`services/ncm.ts`、`types.ts`、`jobs.ts`、`jobs/loudness-backfill.ts`、`loop/agent/builtin-tools.ts` 等；提交本计划内的 Android 修复时必须排除这些文件。

---

# AIDJ 五项修复进度（OpenCode 会话 `ses_ef390fc82ffe4iwUY8AAybBQtH`）

> 本会话即上文「并行工作边界」里那个工作包。**只改本文列出的文件**，不碰 Android /
> headless 目录选择相关改动；提交时按明确路径逐个 `git add`。宽屏/桌面外观与行为一律不变。

## 本轮目标（用户提出）

1. 长时间 loudness / peak 分析写入 metadata 作为长期参考（向后兼容），AI 也能拿到歌曲响度。
2. 歌词自动滚动：用户手动滚动后暂停，停下约 10s 或拖回中心附近即恢复跟随。
3. LUFS 模式第一首应从 50% 开始（实测从 80% 开始，且随后多首完全不动）。
4. 移动端歌词页头部（歌名挤到图标下面、右侧大片留白）+ headless 下隐去「桌面歌词」入口。
5. 小屏状态 chips 溢出要自动缩减（多余项收进 `+N`），顶部把手遮挡正在播放的曲目、API chip 换行到左边。

## 已完成

### A. 内置播放器 volbal（根因已用真机日志 + 真实曲库实证）

- **根因**：`WebPlayerBackend.syncPrefs()` 在引擎每次心跳/重连时重建 `LoudnessCache`，
  锚点被清空但 `volbalActive` 仍为 `true` → 之后每首 `targetVolume()` 返回 `null`，
  音量完全不动（真机日志：14:47:32 设过 anchor 后 25 分钟内再无任何 volume 命令）。
  次要问题：首曲要等 ffprobe（手机约 5s）才落基准音量，期间播放引擎自带默认 0.8。
- **测量本身没问题**：用真实曲库 2579 首复算（`/tmp/opencode/loudness-probe.mjs`），
  integrated LUFS 分布于 −17.3 ~ −7.4，解析正则与 ffmpeg 命令均正确，gain 真实存在。
- **改动**：
  - `services/loudness.ts`：新增可单测的 `VolBal` 状态机（基准先落地 → 锚定 → 按
    `base * 10^((anchor-song)/20)` 调整；仅 method 变化才重建 cache；rebase 立即重算；
    测不出时 warn 而不是静默）；`analyzeLoudness` 提为模块级导出（B 组复用）；
    `setAnchor` 支持注入 measure（测试用）。
  - `player-backend.ts`：改接 `VolBal`；引擎上线首帧即推正确音量（volbal 开→基准，
    关→持久化 `default_volume`）；`setVolbal(true)` / `rebase` 立即作用于当前曲目；
    adjust 日志 debug→info。
  - 删除 `LoudnessCache` 内重复的 `runFfmpeg`（走模块级函数）。
- **验证**：新增 `services/volbal.test.ts` 9 例全过（基准先落地、真实曲库 spread、
  配置重读不丢锚点、method 变更重锚、rebase 重算、测不出告警、关闭不碰音量、
  curve=1 线性、注入 measure）。

### B. loudness → metadata（长期参考 + AI 可见）

- `types.ts`：`SongMeta` 新增可选 `loudness_lufs` / `loudness_peak_db`（旧数据缺字段完全合法）。
- `services/ncm.ts`：元数据同步时逐首 `analyzeLoudness(path)`，把 integrated LUFS +
  true peak 随提取结果写入当前槽位；`extractMetadataAi` 新增 `measured` 入参，
  prompt 里给「MEASURED loudness: X LUFS / Y dBFS」并按 soft(<−16)/medium(−16..−11)/loud(>−11)
  提示取值（建议不强制）；ffprobe 缺失/失败时提示为空，行为与以前一致。
- `loop/agent/builtin-tools.ts`：`brief()`（search_titles / get_songs / session_memory 共用）
  在元数据带实测值时附 `loudness_lufs` / `loudness_peak_db`。
- `jobs/loudness-backfill.ts`（新）+ `jobs.ts` 注册 `aidj.loudness-backfill`：给老歌补录，
  只补缺字段（`--force` 可重测）、并发 2、可取消、带进度；结果一次性并入当前写入槽位，
  同曲目后写覆盖，并失效槽位/曲库缓存。

## 已完成（2026-10-06，云端会话补完，分支 `claude/project-thread-4690q4`）

- **B6** 帮助文档：`help/zh-cn/曲库/元数据与统计.md` 与 `help/en-us/Library/MetadataAndStats.md`
  新增「实测响度」小节（两个字段的含义、提取模型以实测为准、`background.job --name
aidj.loudness-backfill` 补录老歌）。
- **C** 歌词自动滚动恢复：`lyrics-follow.ts` 的 `shouldResumeFollow()` 纯函数 + 6 例单测（含 ±32px
  边界、按住不恢复）；`LyricsView.vue` 只认 wheel / touchmove / 鼠标拖滚动条 / 滚动键为手势，
  暂停期间 `recenter()` 只算 padding 不滚动；停下 150ms 后当前行在中心附近立即恢复，否则 10s 无操作
  恢复并居中；暂停中当前行换到中心附近也会恢复。
- **D** 歌词页：≤720px 信息块 `flex: 1 1 0 !important; min-width: 0`，长歌名在封面右侧换行；
  无 `window.child`（网页 / 无头）时隐藏「桌面歌词」按钮并不再请求 `aidj.lyrics-state`，
  `View.vue` 页面菜单入口同样门控；`(pointer: coarse)` 下控制按钮 40px。
- **E** AI DJ 页：`ChatStatusBar.vue` 紧凑模式用不可见测量层量每个标签宽度，
  `components/status-fit.ts` 的 `fitStatusCount()`（5 例单测）决定显示前几个，其余收进 `+N`，
  不再横向溢出；`View.vue` ≤720px 把手改成流内一行（ChatView 改回流内），弹层仍浮在内容上；
  `.chat-topbar-extra` 第二行靠右。
- **F** `pnpm typecheck` / `pnpm lint` / `pnpm test`（559 通过、0 失败）通过；网页模式 400px 截图
  确认：把手不再盖住曲目名、状态条 3 项 + `+6` 无溢出、菜单无「桌面歌词」、歌词页长标题在封面右侧、
  滚轮滚动后停住、约 10s 后回到当前行。

## 仍需真机验证

- 触屏上歌词页手动拖动后停住 / 拖回中心立即恢复（桌面只用滚轮验证过）。
- Android App 里 AI DJ 页状态条与把手、歌词页头部的实际观感。

## 已验证

- `pnpm typecheck`：通过（223 个 Vue 模板 0 error）。
- `pnpm lint`：aidj 全目录 0 error / 0 warning。
- `npx tsx --test services/volbal.test.ts services/loudness.test.ts`：15/15 通过。
- 真实曲库复算：解析与 gain 正确（见 A 组）。

## 与其他工作包的边界

- 本会话文件：`player-backend.ts`、`services/loudness.ts`、`services/ncm.ts`、`types.ts`、
  `jobs.ts`、`jobs/loudness-backfill.ts`、`loop/agent/builtin-tools.ts`，
  以及后续 `LyricsView.vue`、`components/ChatView.vue`、`components/ChatStatusBar.vue`、`View.vue`、
  aidj 翻译与 help。
- 不碰：`HostFilePicker.vue`、`src/headless/*`、`android/*`、`package.json` 版本号、
  框架 translations。

# AIDJ PK 对比报告 2 (PK_Result2)

> 对比对象：
> - **AIDJ 独立版**：`~/Projs/AIDJ`（Python TUI 命令行应用）
> - **Launcher 内嵌版**：`~/Projs/Launcher/src/abilities/aidj`（Electron + Vue 3 桌面应用的一个 Ability，含 `aidj` / `aidj-lyrics` / `aidj-player` 三个页面）
>
> 生成时间：2026-08-13　·　依据：直接阅读双方当前源码（独立版 `commands.py` / `core/*`；内嵌版 `service.ts` / `commands.ts` / `jobs.ts` / `player-backend.ts` / `web-player/engine.ts` / `ncm_api/*` / `View.vue` 等）
>
> 与 PK_Result 的关系：
> - **独立版**：2026-07-22 后无任何提交（仓库最后 commit `fcf477a`），PK_Result 里第一章描述仍然准确，本节基本照搬并复核。
> - **Launcher 内嵌版**：PK_Result 之后又有一批大更新（`git log a360964..HEAD` 约 30 个文件、+4000 行），集中在**播放后端抽象 + 内置播放器**、**内置网易云访问（免外部服务）**、**跨平台支持**。第二章整体重写。
>
> 2026-08-13 16:36 补充：内嵌版又合入 9 个 patch（`git log 71d9f6a..HEAD`）——web 播放器**播放历史 + 追加队列 + trim-after-cursor**、桌面歌词卡拉OK **rAF 平滑 + 配色修复**、歌词/卡拉OK **匹配安全**、**悬浮标题**。本报告已并入。
>
> 2026-08-14 补充（M4 音效管线落地）：内嵌版合入 `8d43351`（内置播放器 M4：crossfade / AB loop / 倍速 / EQ / 频谱 / 局域网遥控）+ `ae86fec`（10-band 用户可编辑 EQ 曲线库，存 `eq.jsonl`）。上一版标注为「设计稿 / 未实现」的音效管线已**全部实现**，本报告已更新。

---

## 一、AIDJ 独立版 —— 支持的功能与特性（2026-07-22 快照，无变化）

类 bash 的命令行听歌体验（`uv run main.py`），核心是「自然语言 → AI 从本地曲库选歌 → 串成一个有故事感的歌单」。全部通过 `/命令` 形式在终端操作。

### 1.1 AI 生成（Generation）
- `p`/`prompt`/`gen`：自然语言生成歌单（Intro + `[---SONG_LIST---]` + 精确曲库 key）
- `pr`：AI 精选随机（随机 N 首候选 → AI 排序去冲突 → 至少保留一半）
- `r`：代码里实际是「随机选 N 首」（`cmd_random`），与 `help/generate.md` 文档写的「Regenerate 重生成」存在出入（旧报告已指出，依旧未改）
- `pc`（Pure Controller）：连续 AI DJ 模式——100 首滚动记忆、上下文剪枝（保留最近 10 条）、动态 Prompt（PHASE 1 初始 → PHASE 2+ 自主联想，3 轮后放松排除约束）、双批次缓冲、Rich Live 面板、`--anchor` 响度锚点
- `auto`：AI 生成后自动执行预设播放命令

### 1.2 播放器控制（MPRIS / D-Bus，`dbus-send` 子进程）
- `next/prev/play/pause/toggle/stop`、`send`（推送队列）、`mpv`/`vlc`（直接拉起）、`ls`（列播放器）、`init`（持久化目标）

### 1.3 歌单编辑与 IO
- `add/rm/mv/swap/shuffle/reverse/dedup/clear/top/view`、`save`/`load`、`search`（rapidfuzz 模糊搜索）

### 1.4 曲库 / 元数据 / 分析
- `analyse`（LANG_MAP/EMOTION_SYNONYMS/GENRE_MAP 归一化 + ASCII 条形图）、`freqtop`、`discover`、`show`、`sync`（增量元数据同步，启动自动补齐）、`concurrency`、`injects`、`record_freq`

### 1.5 动态音量平衡
- `volbal`/`adjmethod`（linear RMS / lufs ITU-R BS.1770）/`volcurve`（MPRIS 音量曲线指数，`LoudnessCache` 带后台预分析）

### 1.6 歌词
- `dlyrics`：终端内同步滚动 LRC（Rich Live 渲染，`immersive` 全屏独占模式）；本地 `.lrc` 缓存 → NeteaseCloudMusicApi 拉取并缓存

### 1.7 等待小游戏（特色）
- AI 思考期间自动 `run_waiting_game`；`games` 自由玩 **snake、pong、slots、dino、flappybird、matrix、space、auto_2048**

### 1.8 系统 / 调试 / UI
- `status` 分组仪表盘、`token` 用量、`model` 交互式切换、`refresh/reset`、`help`/`dhelp` 帮助浏览器（13 个 markdown 文档页）、Rich TUI、历史记录、prompt_toolkit 补全、`cfgedit.py` Textual 配置编辑器

### 1.9 附带工具（`tools/`）
- `download_music`（pyncm 网易云下载）、`lyrics_sync`/`lyrics_sync_lyrica`、`simp_zhconv`、`leak_check`

### 1.10 平台与架构
- Python 3.10 + uv；单进程阻塞式命令分发；数据全在 `./data/`；Linux 完整 / MacOS 大概率 / Windows 需改

---

## 二、Launcher 内嵌版 —— 支持的功能与特性（2026-08-13 现状）

Electron 桌面应用里的一个 Ability（主进程 TypeScript + 渲染端 Vue/Vuetify），**注册了三个页面**：`aidj`（AI DJ 主页面）、`aidj-lyrics`（歌词页）、`aidj-player`（内置播放器页，仅 web 播放模式下显示）。核心机制与独立版同源（同一套 `[---SONG_LIST---]` 协议），但全部 GUI 化并跑在**后台任务框架**上。

### 2.0 播放后端抽象（本版最大的架构变化）

新增 `player-backend.ts`（对应设计稿 `docs/abilities/aidj/player-backend-plan.md`）：

- 统一 `PlayerBackend` 契约：`mode` / `getStatus` / `getPlaybackDetail` / `control(next|prev|play|pause|toggle|stop)` / `seek` / `sendFiles` / `getVolume` / `setVolume`。
- 两种后端：
  - **`dbus`** —— 外部 MPRIS 播放器（`DBusBackend` 薄封装共享 `DBusManager`，行为与旧代码逐字节一致）
  - **`web`** —— 内置播放器（`WebPlayerBackend` + 渲染端 `web-player/engine.ts`，见 2.3）
- **播放后端热切换**：`aidj.player-mode` 运行期切换 dbus/web——先停止所有 playback 后台任务（`PLAYBACK_TAG`，持续轮播/连续播放/chat 全部停掉，数据类任务不动），再断开旧后端、激活新后端、持久化 `preferences.player_mode`、广播 `cockpit:aidj-mode`。
- **模式门控（MAddition）**：dbus 专属命令（`list-players`/`continuous-*`/`chat-player` 等）与 dbus 专属作业（`aidj.persistent`/`aidj.continuous` 启动）在 web 模式**不注册/不可启动**；共享命令（`next/toggle/send/volume/seek/lyrics`）走统一 backend 分发，UI 永远看不到「仅支持 MPRIS」之类的守卫。
- **`aidj-player` 页面按模式显隐**：`reconcilePlayerAbilityVisibility` 在 web 模式显示侧栏条目，dbus 模式隐藏。

### 2.1 AI 对话 / 生成（主进程命令 + 渲染端聊天 UI）

- `aidj.generate`（流式输出、网络自动重试、可中止）、`aidj.curate`（`/pr`）、`aidj.random`（`/random N`）、`aidj.explore`（`/explore N`）、`aidj.ftop`（`/ftop`）、`aidj.filter`（布尔表达式 + `[字段:值]` 元数据筛选 + 简繁变体）、`aidj.search`
- `aidj.freq`：播放频率列表（含曲库路径，按次数降序）——此前该数据只被 `ftop` 间接使用，现在独立成命令

### 2.2 会话系统（Launcher 独有）

- 多会话持久化（`~/.config/LinuxCockpit/aidj/sessions/`）、`sessions.list/open/delete/pin/rename/gen-title`、`session-fork`（`--keep` 截断 / `--become` 载入）、`revert` / `chat-revert`（按点击位置截断、重建上下文与已播记忆）、`session-new`、后台标题作业 `aidj.title`
- 上下文管理：`context_mode: discard | compact`、`max_history_length`、`persona` / `extra_rules`；library/system prompt（index 0）永不参与压缩

### 2.3 播放器控制

**dbus 模式（Linux）**：`aidj.next/prev/toggle/stop/volume/seek/status`、`send`（推送并记 record_freq）、`list-players`（2s TTL）/`select-player`、`get-cover`（封面，见 2.7）、`activate`（轻量共享 DBus 绑定）。`seek` 为**绝对定位**——MPRIS 只暴露相对 `Seek`，在 `DBusManager.seekTo` 里按当前播放位置换算偏移。

**web 模式（内置播放器，跨平台）**：`PlayerView.vue` + `web-player/engine.ts`：
- 隐藏 `<audio>` 元素 + 自带队列（`queue/next/prev` 自动播放、`ended` 自动推进）
- **播放历史**（新）：已播栈去重、上限 50，`prev` 能跨「队列整体替换」回退到上一首——engine 的队列只整换不 splice，历史单独存活
- **追加 vs 替换**（新）：web 模式下「播放全部」/`aidj.send --append` 把批次**追加到队列尾部**（当前曲不打断，`enqueue` 命令，未加载时才开播）；dbus MPRIS 仍为整体替换
- **trim-after-cursor**（新）：`trim` 命令只清光标后未播的歌曲，保留当前曲 + 播放历史（`/discard_follows` 在 web 模式不再 no-op，改为 trim；chat 推送的全量换歌仍是独立替换）
- 进度条 seek 滑块（拖动本地值、松手才提交）、音量弹窗、播放/暂停/上下首
- `navigator.mediaSession` → 系统媒体键（SMTC / Now Playing / MPRIS 映射），跨平台媒体键统一方案
- 响度平衡在 web 端有独立实现：`player-volbal` / `player-rebase`（把当前音量设为新基准），`WebPlayerBackend` 监听引擎上报的曲目变化自动调 `audio.volume`（曲线固定 1.0 = 真线性，因 HTML5 volume 本身线性）
- **M4 音效管线（已实现，`8d43351` + `ae86fec`）**：`<audio>` 经 `MediaElementAudioSourceNode` 接入 Web Audio 图（EQ 滤波器链 → 主增益 → 频谱 analyser → 输出），因此：
  - **EQ（10 段图形式曲线库）**：ISO 频点 31–16k Hz，存 `aidj/eq.jsonl`（每行一个 profile，内置 5 + 用户自定义，内置可编辑不可删）；播放器页曲线列表小图 + 拖拽式曲线编辑器（实时发声预览）+ 整体偏移；增益范围 ±12–60dB 可在设置调（`preferences.eq_gain_range`，默认 ±20）
  - **倍速**：任意正数；≤16x 原生变速出声，**>16x 静音快进**（逐帧 seek 扫曲，末尾自动切下一首）
  - **AB 循环**：底部 A/B 打点，区间循环；**睡眠定时**：到点自动暂停
  - **crossfade（淡入淡出）**：自动切歌时淡出/淡入（情绪一致短淡、突变长淡），时长可配（`preferences.crossfade`）；手动切歌即时不等待
  - **频谱**：实时频段柱（analyser），可开关
  - **局域网 Web 遥控（新）**：`aidj.web-remote-start/stop/status`，内置 HTTP 服务（`GET /` 遥控页 + `/state` + `POST /control`），手机浏览器实时看歌/封面/进度并控制；端口 `preferences.web_remote_port`（默认 17320，0 禁用），跑成后台任务 `aidj.web-remote`
  - 完整命令：`aidj.player-*`（state/rate/abloop/sleep/crossfade/eq/volbal/rebase/clear-queue）+ `aidj.eq-*`（list/save/delete/active/range/reset）+ `aidj.web-remote-*`
- 状态回传：引擎经 `aidj.web-player-report` 上报 → `WebPlayerBackend.report()` 统一状态模型；播放器页/歌词浮窗对后端无感知

### 2.4 歌词（双端：桌面浮窗 + 歌词页 + 内置播放器）

- **桌面歌词浮窗**（`LyricsWindow.vue`）：透明 · 无边框 · 圆角 · alwaysOnTop · skipTaskbar；1Hz 轮询 + rAF 插值；**卡拉OK 逐字高亮**（YRC 内联时间戳 LRC，`preferences.lyrics.karaoke` 可开关）；封面模糊沉浸背景；锁定/鼠标穿透；多播放器独立单例窗口；全套排版配置
  - 卡拉OK 填充做**平滑**（新）：以每次轮询为锚、按 wall-clock 推进、只前进 + 回跳 snap，不再按 600ms 轮询步进跳变（Windows 上曾卡顿）
  - 卡拉OK 配色（新）：已填字用完整文字色、未播用候选色 55% 变暗，去掉 mask 的 text-shadow 与叠加 alpha——白字主题不再被洗灰，所有当前行动画恢复
- **歌词匹配安全**（新）：`resolveLyricForTrackPath` 对 `Artist - Title` 文件名锚定最后一个 `' - '` 段（标题）做模糊匹配，不再误伤歌手名；**卡拉OK 解析关闭模糊回退**（`fuzzy: false`）——不精确的标题匹配可能串到另一首歌的 YRC，宁缺毋错
- **歌词页**（`aidj-lyrics`，`LyricsView.vue`）：卡拉OK 逐字填充 / 滚动跟随两档、前后行数、候选行变暗、播放控制条、播放器绑定切换、沉浸模式
- `aidj.lyrics` 现在是**后端无关**的：dbus 走 MPRIS 状态 + 库歌词，web 走 `getWebLyricPlayback()` 从引擎上报状态构造同一 `LyricPlaybackState`——浮窗/页面在两种模式下都能用
- **GBK 编码回退**：本地 `.lrc`/`.yrc` 先严格 UTF-8 解码，失败自动按 GBK 解码（`readTextAuto`），中文 locale 的常见乱码文件不再读错

### 2.5 网易云歌词来源：内置访问（新）

- 新增 `ncm_api/`（vendored, MIT）——**进程内直连网易云**：`search`（搜索接口）+ `lyric`（eapi `/lyric/v1`，同时拿 LRC + YRC 卡拉OK）
- `preferences.ncm_mode` 三档：
  - `auto`（默认）：外部 NCM 服务优先，**不可达时自动兜底到内置**
  - `external`：仅用 `ncm_base_url` 外部服务
  - `builtin`：仅用内置
- 意义：元数据同步 / 歌词拉取不再强依赖外部 NeteaseCloudMusicApi 服务（PK_Result 时代还是硬依赖），一条命令都不需要开

### 2.6 持续模式 / 连续播放（后台任务 `jobs.ts`）

- `aidj.persistent`（持久轮播，dbus 专属）、`aidj.continuous`（连续播放队列，断线重连 / 推送失败重试 / 播放器单实例绑定，dbus 专属）
- `aidj.chat`（持续 AI DJ 会话，`REFILL=8` 动态补给、用户消息注入 USER DIRECTED、`/discard_follows`、enqueue/replace 两种入队）——**web 模式下也支持**：`chat` 任务把歌单推到内置播放器引擎队列（`isWebTarget` 分支），引擎自己就是连续播放器；播放器页的 volbal/rebase 语义与 continuous 任务对齐
- 任务在连接重试期即注册（DBus 离线不再每批生成新任务）、标签化 `PLAYBACK_TAG` 供模式切换统一停止
- 全部跑在后台任务框架上（跨页面存活、可停止/重试、`BtChatView` / `ContinuousView` 自定义 view）

### 2.7 元数据 / 封面 / 配置

- `aidj.metadata-sync`（后台作业，逐曲进度 + 分类统计，防重入）、`aidj.sync`、`aidj.reload` / `aidj.invalidate-library`
- 歌词存储 `music_lyrics.jsonl`（LRC + YRC 双份）
- **封面获取优化**：先查同目录 `cover.jpg/png/jpeg/folder.jpg/folder.png/front.*`（零依赖、无 ffmpeg 子进程），未命中才走 ffmpeg/ffprobe 嵌入封面提取
- **配置自动创建**：`readOrCreateJson` 在配置/会话索引缺失时自动建默认（深 mkdir），新装不再刷 ENOENT；`writeJsonAtomicSerialized` 串行化保存（修 Windows 同 tick 并发 rename EPERM）
- `aidj.network-test` / `get-models` / `get-config` / `save-config` / `update-config`（点路径热改）、`withNetworkRetry`（`network_retry_minutes`）
- `aidj.status` 的曲库数在首扫未完成时返回 `null`，UI 显示 "…" 而非误导性的 0（`isLibraryLoading`）

### 2.8 跨平台（新）

- `meta.ts` 的 `platforms` 从 `['linux']` 改为 `[]` —— **全平台可用**（`aidj` / `aidj-lyrics` / `aidj-player`）
- 非 Linux 平台无会话 DBus → `getPlayerMode()` 强制 `web`（忽略迁移配置里的残留 `player_mode`），dbus 专属命令经 enabled gate 全部不暴露，`dbus-next` 根本不会加载
- Linux 默认仍走 dbus（外部 MPRIS 播放器），可在设置页切到内置播放器

### 2.9 渲染端 UI（Vuetify）

- `ChatView.vue`：消息气泡 / 流式思考气泡、`/` 命令补全、`/random /pr /explore /ftop /analyse /filter /persist /pc /persist-stop /pc-stop` 斜杠命令、播放器状态栏徽标（tokens/context/memory/tracks/volbal/record_freq 可定制显隐顺序）、会话操作入口
- `SongGrid.vue` / `FreqList.vue` / `FreqRow.vue` / `ContextMenu.vue` / `ModelSelect.vue` / `BtChatView.vue` / `ContinuousView.vue`、**新增 `PlayerView.vue`（内置播放器页）**
- **悬浮标题**（新）：所有被截断的歌名都带 `:title`，长名悬停显示全名（SongGrid 歌单行、PlayerView 队列+当前曲、ContinuousView 当前/下一首、BtChatView 歌单行；FreqRow 与 ChatView now-playing 此前已有）——避免「歌手前缀截断后看着都一样」
- 设置页 `AidjSettingsSection.vue` + 歌词页 `LyricsPageSettingsSection.vue`：新增 **播放模式（外部 MPRIS / 内置播放器）**、**歌词来源（auto/external/builtin）**、**桌面歌词卡拉OK开关** 等
- i18n 双语（zh / en-US），剩余硬编码字符串已全部翻译化（08-13 的 i18n 收尾 commit）

---

## 三、PK 对比

### 3.1 同源内核（两者都有）
- AI 生成歌单同一套协议：Intro + `[---SONG_LIST---]` + 精确曲库 key、禁幻觉 / 禁翻译曲名
- 元数据 AI 增量生成（language / emotion / genre / loudness / review，JSONL）
- MPRIS 播放器控制、动态音量平衡（LUFS/RMS + curve + anchor）、record_freq
- 等价能力：随机选曲、AI 精选随机、发现冷门、频率 Top、分布分析、模糊搜索、歌单存/载、AI 连续轮播、`--anchor` 响度锚点

### 3.2 Launcher 内嵌版优势
| 维度 | 说明 |
|---|---|
| GUI 全流程 | 图形聊天界面、后台任务面板、设置页、会话管理 UI，替代 TUI |
| **会话系统** | 多会话持久化、fork 分支、revert 回退、置顶/重命名/AI 自动标题、按天分组——独立版仍为单会话内存 |
| **上下文管理** | discard / compact（AI 摘要）双模式 + 可配历史长度——独立版 pc 仅粗暴剪到 10 条 |
| **网络可靠** | `withNetworkRetry`、`network_retry_minutes` / `reconnect_minutes` 断线重连、推送失败每 10s 重推——独立版失败即报错 |
| **歌词能力** | 桌面浮窗 + 歌词页 + 内置播放器三端、卡拉OK 逐字（YRC）、封面沉浸、锁定/鼠标穿透、多播放器多窗口——独立版只有终端内滚动 LRC |
| **内置播放器（新）** | web 后端跨平台直出声音、自带队列/播放历史（prev 跨替换回退）/追加与 trim/seek/音量/媒体键、与 volbal 联动——独立版必须依赖外部 MPRIS 播放器 |
| **M4 音效管线（新）** | **crossfade / 10 段图形式 EQ 曲线库（`eq.jsonl`，拖拽编辑）/ 倍速（≤16x 出声、>16x 静音快进）/ AB 循环 / 睡眠定时 / 实时频谱 / 局域网 Web 遥控**——独立版全无 |
| **内置网易云（新）** | 进程内直连网易拿 LRC+YRC，`ncm_mode` 三档自动兜底——**不再强依赖外部 NeteaseCloudMusicApi 服务**（独立版仍然依赖） |
| **跨平台（新）** | `platforms: []`，非 Linux 走内置播放器、dbus 命令自动门控不暴露——独立版 Windows 仍需改代码 |
| **播放后端热切换（新）** | `aidj.player-mode` 运行期切 dbus/web，自动停 playback 任务、持久化、UI 即时反映 |
| **/filter** | 布尔表达式过滤曲库，可搜歌词、简繁变体、大小写忽略——独立版无 |
| **DBus 实现** | dbus-next 原生 + 绝对 seek（`Seek` 偏移换算）vs 独立版 `dbus-send` 子进程 |
| **持续会话交互** | 用户消息注入（USER DIRECTED）、`/discard_follows`、web 模式下持续会话直接推内置播放器——独立版 pc 无法中途改方向 |
| **性能工程** | token 索引、validKeys 缓存、80MB 变体缓存预算、会话载入进度流、播放器列表 2s TTL、历史写锁、封面同目录优先 |
| 工程化 | winston 日志、i18n 双语、能力依赖注入、平台过滤、配置热更新、配置自动创建、`/models` 模型拉取 |

### 3.3 独立版优势（不变）
| 维度 | 说明 |
|---|---|
| **轻量** | 纯 Python TUI，`uv run main.py`；Launcher 需完整 Electron 环境 |
| **等待小游戏** | AI 思考期间 8 款小游戏——Launcher 仍只有加载动画 |
| **终端美学** | Rich 彩图表单、Markdown 面板、Live 面板、沉浸式全屏歌词 |
| **命令哲学** | bash 化短别名密集（`q/?/n/b/s/sw/rev/unique/pl`…），playlist 管道式操作顺手 |
| **dhelp 帮助浏览器** | markdown 文档 + `cmd:` 交叉引用 + AI 协作规范 |
| **配套工具** | 网易云下载（pyncm）、双源歌词批量同步（NCM/Lyrica）、简繁转换、leak_check |
| **音量曲线可调** | `volcurve` 1.0–3.0 用户可配；Launcher web 端内置播放器固定线性（外部 MPRIS 才用曲线） |

### 3.4 相互缺失
- **Launcher 没有**：小游戏、终端全屏沉浸歌词、dhelp 帮助浏览器、pyncm 下载工具、细粒度终端开关命令
- **独立版没有**：GUI、会话持久化/分支/回退、自动重试与断线重连、卡拉OK/桌面浮窗歌词、内置播放器（含 crossfade / EQ 曲线库 / 倍速 / AB 循环 / 睡眠定时 / 频谱 / 局域网遥控）、内置网易云兜底、/filter 表达式、简繁变体、多播放器管理面板、后台任务框架、封面提取、模型 API 拉取、配置热更新

### 3.5 技术栈对比表
| 维度 | AIDJ 独立版 | Launcher 内嵌版 |
|---|---|---|
| 语言 | Python 3.10 | TypeScript（Electron 主进程 + Vue 3） |
| 交互形态 | TUI（rich / questionary / prompt_toolkit） | GUI（Vuetify / Material 3） |
| 进程模型 | 单进程阻塞 + threading 等待注入 | 主进程命令 + 后台任务框架（命名作业） |
| 播放 | MPRIS（`dbus-send` 子进程） | **双后端**：dbus-next 原生 + 内置 HTML5 `<audio>`（web，含 Web Audio 音效管线） |
| 播放器依赖 | 必须外部 MPRIS 播放器 | dbus 模式同左；**web 模式零依赖直出声音** |
| 网易云访问 | NeteaseCloudMusicApi 外部服务 | 外部服务 + **内置直连兜底**（`ncm_api`，三档模式） |
| 响度分析 | soundfile + numpy + pyloudnorm | 同算法 TypeScript 重写（LoudnessCache，双后端复用） |
| 模糊搜索 | rapidfuzz（C 扩展） | 自实现 token_sort_ratio + Levenshtein + 索引 |
| 歌词存储 | 本地 `.lrc` 文件 | JSONL（LRC + YRC 双份）+ 浮窗/页面/内置播放器三渲染端 |
| 会话 | 单会话内存（刷新即失） | 多会话 JSONL 持久化 + fork/revert/pin |
| 依赖规模 | ~10 个 Python 包 | 整个 Electron + Vue + 前后端工具链 |
| 平台 | Linux 完整 / macOS 大概率 / Windows 需改 | **全平台**（非 Linux 自动切内置播放器） |

---

## 四、结论

两者仍是**同一个核心思想的两种产品形态**，但差距结构发生了明显变化：

- 上一版报告里 Launcher 版的核心短板是「仅 Linux、依赖外部 NCM 服务、必须外部 MPRIS 播放器」——本次更新全部补齐：**内置播放器**（web 后端，跨平台直出声音）、**内置网易云**（`ncm_api` 免外部服务）、**跨平台**（`platforms: []`，dbus 命令门控）。Launcher 版在「能听歌」这件事上已经不再依赖任何外部组件。
- **M4 音效管线已落地**：上一版标注「停留在设计稿」的 crossfade / EQ / 频谱 / 倍速，加上 AB 循环、睡眠定时、10 段图形式 EQ 曲线库（`eq.jsonl`，用户可编辑）与局域网 Web 遥控，全部实现。内置播放器从「能播」进化到「能调」。
- **AIDJ 独立版**自 07-22 起没有新提交，仍保持「轻量 + 终端氛围 + 可玩性」的定位；小游戏、dhelp、沉浸终端、下载/歌词工具依然是它的独有优势。
- 遗留差距：独立版的**会话持久化**仍空白；Launcher 的等待小游戏、终端沉浸歌词、pyncm 下载等仍未做（非核心）。

一句话：**要 GUI + 可靠 + 长期会话 + 跨平台免依赖 + 音效可调（EQ/倍速/淡入淡出）选 Launcher 版；要轻量 + 终端氛围 + 小游戏可玩性选独立版。** 两边都在向对方缺的那块移动，但步伐不同。

# AIDJ PK 对比报告

> 对比对象：
> - **AIDJ 独立版**：`~/Projs/AIDJ`（Python TUI 命令行应用）
> - **Launcher 内嵌版**：`~/Projs/Launcher/src/abilities/aidj`（Electron + Vue 3 桌面应用的一个 Ability，含 `aidj` 与 `aidj-lyrics` 两个页面）
>
> 生成时间：2026-08-12　·　依据：直接阅读双方源码（`commands.py` / `core/*` / `service.ts` / `commands.ts` / `jobs.ts` / `View.vue` 等）

---

## 一、AIDJ 独立版 —— 支持的功能与特性

类 bash 的命令行听歌体验（`uv run main.py`），核心是「自然语言 → AI 从本地曲库选歌 → 串成一个有故事感的歌单」。全部通过 `/命令` 形式在终端操作。

### 1.1 AI 生成（Generation）
| 命令 | 别名 | 功能 |
|---|---|---|
| `p` | `prompt` / `gen` | 自然语言生成歌单。AI 输出 Intro（DJ 解说，Markdown 渲染）+ `[---SONG_LIST---]` 分隔符 + 精确曲库 key 列表 |
| `pr` | — | AI 精选随机：随机抽 N 首候选 → 让 AI 排序、去冲突、保留至少一半 → 成连贯歌单 |
| `r` | — | **注意**：代码里实际是「随机选 N 首」（`cmd_random`），而 `help/generate.md` 文档里写的是「Regenerate 重生成上一次」——文档与代码存在出入 |
| `pc` | — | 连续 AI DJ 模式（Pure Controller）：100 首滚动记忆（deque maxlen=100）、上下文剪枝（保留最近 10 条）、动态 Prompt（PHASE 1 初始需求 → PHASE 2+ 自主联想续接，3 轮后放松排除约束）、双批次缓冲（buffer 保持 ≤2 批）、Rich Live 实时状态面板、`--anchor` 手动指定响度锚点 |
| `auto` | — | 持久自动触发：AI 生成歌单后自动执行预设播放命令（如 `auto mpv` / `auto send`） |

### 1.2 播放器控制（MPRIS / D-Bus）
| 命令 | 别名 | 功能 |
|---|---|---|
| `next` / `prev` / `play` / `pause` / `toggle` / `stop` | `n` / `b` | 传输控制（经 `dbus-send` 子进程调用 MPRIS 接口） |
| `send` | — | 把歌单推送进当前 MPRIS 播放器队列 |
| `mpv` / `vlc` | — | 直接拉起 mpv / vlc 播放歌单 |
| `ls` | `players` | 列出活跃 MPRIS 播放器 |
| `init` | — | 指定目标播放器（持久化 `dbus_target`） |

### 1.3 歌单编辑与 IO（Playlist）
- 队列本地操作：`add`(insert)、`rm`(del)、`mv`(move)、`swap`(sw)、`shuffle`(mix)、`reverse`(rev)、`dedup`(unique)、`clear`(cls)、`top`、`view`(list/pl/queue)
- 保存 / 加载：`save`（写 `data/playlists/*.txt`）、`load`（支持交互式菜单选择 + 模糊匹配解析歌单内容）
- `search`（`find`/`s`）：rapidfuzz 模糊搜索曲库，结果直接可推送给播放器

### 1.4 曲库 / 元数据 / 分析
| 命令 | 别名 | 功能 |
|---|---|---|
| `analyse` | `stats` | 元数据分布统计（language / emotion / genre），`core/analyse.py` 内置大量中英归一化映射表（`LANG_MAP` / `EMOTION_SYNONYMS` / `GENRE_MAP`）+ ASCII 条形图输出 |
| `freqtop` | `ftop` | 最常听的 N 首歌 |
| `discover` | `disc`/`fresh` | 发现未听过 → 池耗尽后回落到最少播放 |
| `show` | — | 查看单曲完整元数据 |
| `sync` | — | 增量同步缺失元数据（`sync run` 强制执行），启动时自动补齐新歌；JSONL 追加存储 |
| `concurrency` | `conc` | 元数据同步并发数（1–16） |
| `injects` | `inj` | 控制注入到 AI prompt 的元数据字段（genre/emotion/language/loudness/review）开关 |
| `record_freq` | — | 播放频率记录开关（写 `data/frequency.csv`，按次降序） |

### 1.5 动态音量平衡
- `volbal`（`balance`）：响度归一化总开关
- `adjmethod`（`loudnorm`）：策略 `linear`（RMS，纯数学、快）/ `lufs`（ITU-R BS.1770 感知响度，K 加权）
- `volcurve`（`curve`）：MPRIS 音量曲线补偿指数（1.0 线性直通 / 3.0 mpv/VLC 默认立方补偿），`LoudnessCache` 带后台预分析、线程安全缓存、绝对基准无漂移

### 1.6 歌词
- `dlyrics`（`lrc`）：从当前 MPRIS 播放器同步滚动显示 LRC（Rich Live 渲染），支持 `immersive` 全屏独占终端沉浸模式；歌词优先本地 `.lrc` 缓存 → 未命中则调 NeteaseCloudMusicApi 拉取并缓存到 `data/lyrics/`

### 1.7 等待小游戏（特色）
- AI 思考期间自动进入 `run_waiting_game`（`p` 模式 + `stop_event` + 实时 AI 字数计数共享）
- `games` 命令自由畅玩：**snake、pong、slots、dino、flappybird、matrix、space、auto_2048**（`games/` 目录 8 个小游戏）

### 1.8 系统 / 调试 / UI
- `status`（`check`/`conf`）：分组状态仪表盘（PLAYBACK / VOLUME BALANCE / AI / LIBRARY INJECTS / DEBUG）
- `token`（`tokens`）：会话 token 消耗（prompt + completion 分开，自动格式化 k/M）
- `model`：questionary 交互式热切换模型；`verbose` 调试日志；`refresh`（保留历史清已播）/ `reset`（全清）
- `help`（`?`）简洁命令表、`dhelp`（`??`）详细帮助浏览器（markdown 文档 + `cmd:` 交叉引用链接，`help/` 目录 13 个文档页）
- Rich TUI：启动 banner、Markdown DJ Intro、彩色歌单表格、Live 面板
- 历史记录 `.dj_history` + `data/history.jsonl`；prompt_toolkit 智能补全（只补命令、不补参数）
- `cfgedit.py`：Textual 实现的 TUI 配置编辑器（Secrets / AI Settings / Models / Preferences 分节）

### 1.9 附带工具脚本（`tools/`）
- `download_music`：pyncm 通过网易云 API 下载音乐
- `lyrics_sync` / `lyrics_sync_lyrica`：批量歌词下载（NCM / Lyrica 双源）
- `simp_zhconv`：简体 LRC 批量转繁体
- `leak_check`：扫描 metadata 里未被归一化映射覆盖的中文词，辅助维护映射表

### 1.10 平台与架构
- Python 3.10 + uv，OpenAI SDK、`dbus-send` 子进程、soundfile+pyloudnorm、rapidfuzz、rich、questionary、prompt_toolkit
- 单进程阻塞式命令分发（`@registry.register` 装饰器注册表），数据全在 `./data/`（config.json / music_metadata.jsonl / frequency.csv / lyrics / playlists）
- 平台：Linux 完整；MacOS 大概率可用；Windows 需改代码

---

## 二、Launcher 内嵌版 —— 支持的功能与特性

Electron 桌面应用里的一个 Ability（主进程 TypeScript + 渲染端 Vue/Vuetify），**注册了两个页面**：`aidj`（AI DJ 主页面）与 `aidj-lyrics`（歌词页）。核心机制同源（同一套 `[---SONG_LIST---]` 协议），但全部 GUI 化并跑在**后台任务框架**上。

### 2.1 AI 对话 / 生成（主进程命令 + 渲染端聊天 UI）
- `aidj.generate`：AI 生成歌单（流式输出、网络自动重试、可中止 `aidj.abort`）
- `aidj.curate`（`/pr`）：从随机候选中 AI 精选成连贯歌单，计入会话上下文
- `aidj.random`（`/random N`）：随机选 N 首并推入会话
- `aidj.explore`（`/explore N`）：未听过 → 池耗尽后取最少播放
- `aidj.ftop`（`/ftop <N> | -<N> | <A> <B>`）：频率 Top / 倒数 / 区间
- `aidj.filter`（`/filter`）：**布尔表达式曲库过滤**（`--count` / `--compare=title|lyrics|all` / `--ignorecase`），支持 `and/or/not` + 括号；简体 ⇄ 繁体变体模糊匹配（`chineseVariants.ts`，80MB 变体缓存预算），可搜歌词全文
- `aidj.search`：自实现 `token_sort_ratio` + Levenshtein + token 索引加速的模糊搜索
- `aidj.analyse`：language / emotion / genre / loudness 分布分析

### 2.2 会话系统（Launcher 独有、最重量级的增强）
- 多会话持久化：`~/.config/LinuxCockpit/aidj/sessions/`（索引 `main.json` + 每会话 `history.jsonl`，带每会话 promise 链历史锁串行化）
- `aidj.sessions.list / open / delete / pin / rename / gen-title`：列表、载入、删除、置顶、重命名、AI 生成标题
- `aidj.session-fork`：分支当前会话为新会话（`--keep n` 截断 / `--become true` 载入为活跃会话）
- `aidj.revert` / `aidj.chat-revert`：回退到指定消息（删其后所有，重建上下文与已播记忆）
- `aidj.session-new`：新建会话
- 标题后台作业 `aidj.title`：`auto_title` 首轮后自动起后台任务生成标题
- 渲染端：会话按「今天 / 昨天 / 日期」分组、搜索过滤、置顶排序、右键菜单、重命名对话框

### 2.3 上下文管理（比独立版高级）
- `context_mode`: **`discard`**（丢最老，插入空 `updated` 标记）/ **`compact`**（调 AI 摘要压缩旧对话为 `[Context Summary]` 标记）
- `max_history_length` 可配置；library/system prompt（index 0）永不参与压缩、永远保留
- `persona` 自定义 DJ 人格（替换内置）、`extra_rules` 追加行为规则

### 2.4 播放器控制（dbus-next 原生实现）
- `aidj.next / prev / toggle / stop / volume`、`aidj.status`（播放状态 / 曲目 / 音量 / 播放器）
- `aidj.send`（推送歌单，自动记 record_freq）、`aidj.list-players`（2s TTL 缓存）/ `aidj.select-player` / `aidj.get-cover`（ffprobe/ffmpeg 提取封面 base64）
- `aidj.activate`：**轻量激活共享 DBus 绑定**（不启动 AI 会话，歌词页可独立使用）
- 自动模式 / 多播放器切换 / 播放详情（position / length / album / artist）

### 2.5 持续模式 / 连续播放（后台任务 `jobs.ts`，Launcher 独有）
- `aidj.start-persistent` / `aidj.stop-persistent`：持久模式（`PersistentSession`，`aidj.persistent` 命名作业）
- `aidj.continuous`（命名作业，`view: continuous`）：连续播放队列——断线按 `reconnect_minutes` 重连（0=退出 / >0=窗口 / <0=永不放弃）、连接失败每 10s 重试、推送失败每 10s 重推直到成功、播放器单实例绑定（`playerBindings`）
- `aidj.chat`（命名作业，`view: chat`）：持续 AI DJ 会话——`REFILL=8` 动态补给、用户消息注入（`USER DIRECTED` 最高优先级，可打断自主轮播）、`/discard_follows` 丢弃后续待播并强制重取、新批次 enqueue / replace 两种入队模式
- 连续任务运行时控制：`continuous-list / switch / reorder / enqueue / volbal / recordfreq / clear-memory / volume / rebase`（`continuous-rebase` 手动把当前音量设为响度平衡新基准）
- 聊天控制：`chat-player`（切换推送目标播放器）、`chat-resend`（重推歌单）、`chat-clear-memory`、`chat-revert`
- 全部跑在**后台任务框架**上（跨页面存活、可停止/重试、全局面板统一管理、`view` 自定义渲染 `BtChatView` / `ContinuousView`）

### 2.6 歌词（双端：桌面浮窗 + 歌词页）
- **桌面歌词浮窗**（`aidj.lyrics-open/close/toggle/state`，子窗口 `LyricsWindow.vue`）：透明 · 无边框 · 圆角 · alwaysOnTop · skipTaskbar；1Hz 轮询 `aidj.lyrics` + rAF 位置插值平滑；**卡拉OK 逐字高亮**（YRC 内联时间戳 LRC）；自动宽度扩展；锁定（Wayland 下缩窗到卡片边界模拟鼠标穿透）；多播放器独立单例窗口；封面模糊沉浸背景；全套排版配置（字体/字号/字重/颜色/阴影/字距/行高/锚点/边距/`position_offset_ms`）
- **歌词页**（`aidj-lyrics` Ability，`LyricsView.vue`）：卡拉OK 逐字填充 / 滚动跟随两档（`scroll_follow`）、静态窗口前后行数、`lines_before/after`、候选行变暗、播放控制条、播放器绑定切换、YRC/LRC 源标识、沉浸模式（封面模糊铺底）、配色只跟随主题（`--v-theme-*`）
- `aidj.lyrics-player / select-player / page-config / page-save`：歌词源播放器绑定与歌词页配置持久化

### 2.7 元数据同步（后台作业）
- `aidj.metadata-sync`（命名作业，`view: log`）：扫描曲库 + 补齐缺失元数据，带逐曲进度（`MetadataSyncProgress`：ok/noLyric/networkError/failed 分类统计），防重入（已有运行中任务则跳转面板）
- `aidj.sync`：同步命令（前台）／ `aidj.reload` / `aidj.invalidate-library`：库缓存管理
- 歌词存储升级为 `music_lyrics.jsonl`（**LRC + YRC 卡拉OK 双份**）

### 2.8 系统 / 配置 / 网络
- `aidj.network-test`：API 连通性测试（`/models` 探测）
- `aidj.get-models`：从 API 实时拉取可用模型列表（设置页模型下拉）
- `aidj.get-config / save-config / update-config`（点路径运行时热改，如 `preferences.model`）
- `aidj.stream-status`：流式字符数 / 重试次数 / 等待时长 / 最后错误轮询
- 内置 `withNetworkRetry`：传输层错误自动重试（`network_retry_minutes` 0=快速失败 / >0=N 分钟内 / <0=永远）
- 设置页 `AidjSettingsSection.vue` + 歌词页设置 `LyricsPageSettingsSection.vue` 注入全局设置
- 能力依赖声明：`dependencies: ['background-tasks']`、`platforms: ['linux']`

### 2.9 渲染端 UI（Vuetify）
- `ChatView.vue`：消息气泡（用户/助手/系统/流式思考气泡）、`/` 命令补全弹窗（↑↓ 选择）、`/random /pr /explore /ftop /analyse /filter /persist /pc /persist-stop /pc-stop` 斜杠命令、播放器状态栏（tokens/context/memory/tracks/volbal/record_freq 徽标可定制显隐顺序）、会话操作入口
- `SongGrid.vue`（歌单网格）、`FreqList/FreqRow.vue`（频率列表，可发送到播放器）、`ContextMenu.vue`、`ModelSelect.vue`、`BtChatView.vue`（持续会话面板）、`ContinuousView.vue`（连续播放面板：播放器切换、队列重排/追加、音量滑块、volbal/record_freq 循环切换、清空记忆、rebase）
- i18n 双语（`translations/zh.json` / `en-US.json`）

---

## 三、PK 对比

### 3.1 同源内核（两者都有）
- AI 生成歌单的同一套协议：Intro + `[---SONG_LIST---]` + 精确曲库 key、禁止幻觉 / 禁止翻译曲名
- 元数据 AI 增量生成：language / emotion / genre / loudness / review，JSONL 存储
- MPRIS D-Bus 播放器控制、动态音量平衡（LUFS/RMS + curve + anchor）、record_freq 播放频率
- 等价能力：随机选曲、AI 精选随机、发现冷门、频率 Top、分布分析、模糊搜索、歌单存/载、AI 连续轮播、`--anchor` 响度锚点

### 3.2 Launcher 内嵌版优势
| 维度 | 说明 |
|---|---|
| GUI 全流程 | 图形聊天界面、后台任务面板、设置页、会话管理 UI，替代 TUI |
| **会话系统** | 多会话持久化、fork 分支、revert 回退、置顶/重命名/AI 自动标题、按天分组——独立版完全空白（只有单会话内存） |
| **上下文管理** | discard / compact（AI 摘要）双模式 + 可配历史长度——独立版仅在 pc 里粗暴剪到 10 条 |
| **网络可靠** | `withNetworkRetry` 自动重试、`network_retry_minutes` / `reconnect_minutes` 断线重连——独立版失败即报错退出 |
| **歌词能力** | 桌面浮窗 + 歌词页双端、卡拉OK 逐字（YRC）、封面沉浸、锁定/鼠标穿透、多播放器多窗口——独立版只有终端内滚动 LRC，无逐字卡拉OK |
| **后台任务框架** | 持续会话/连续播放/元数据同步/标题生成都是命名作业，跨页面存活、面板统一停止/重试——独立版是阻塞单线程（生成期间只能靠小游戏打发） |
| **/filter** | 布尔表达式过滤曲库，可搜歌词、简繁变体、大小写忽略——独立版无 |
| **DBus 实现** | dbus-next 原生库（播放详情/音量/多播放器切换/自动模式）vs 独立版 `dbus-send` 子进程 |
| **持续会话交互** | 用户消息注入（USER DIRECTED 最高优先级）、`/discard_follows`、chat 会话可对话引导——独立版 pc 无法中途改方向 |
| **性能工程** | token 索引加速 bestMatch、validKeys 缓存、80MB 变体缓存预算、会话载入进度流、播放器列表 2s TTL 缓存、历史写锁 |
| 工程化 | 日志系统（winston）、i18n 双语、能力依赖注入、平台过滤、配置热更新、`/models` 模型实时拉取、封面提取 |

### 3.3 独立版优势
| 维度 | 说明 |
|---|---|
| **轻量** | 纯 Python TUI，`uv run main.py` 一条命令；Launcher 需要完整 Electron 桌面环境 |
| **等待小游戏** | AI 思考期间玩 snake / pong / 2048 / flappybird 等 8 款——Launcher 只有加载动画 |
| **终端美学** | Rich 彩图表单、Markdown 面板、Live 实时状态、沉浸式全屏独占歌词（终端氛围感） |
| **命令哲学** | 更 bash 化、短别名密集（`q/?/n/b/s/sw/rev/unique/pl`…），playlist 编辑管道式操作顺手 |
| **dhelp 帮助浏览器** | markdown 文档 + `cmd:` 交叉引用 + AI 协作规范（`IF_YOU_ARE_AI_READ_THIS.md` 强制新命令同步文档） |
| **配套工具** | 网易云下载（pyncm）、双源歌词批量同步（NCM/Lyrica）、简繁转换、leak_check 归一化映射维护——Launcher 需外接 |
| 跨平台 | Linux 完整、MacOS 大概率、Windows 小改；Launcher 仅 linux |

### 3.4 相互缺失
- **Launcher 没有**：小游戏、终端全屏沉浸歌词、dhelp 帮助浏览器、pyncm 下载工具、细粒度终端开关命令
- **独立版没有**：GUI、会话持久化/分支/回退、自动重试与断线重连、卡拉OK/桌面浮窗歌词、/filter 表达式、简繁变体、多播放器管理面板、后台任务框架、封面提取、模型 API 拉取、配置热更新

### 3.5 技术栈对比表
| 维度 | AIDJ 独立版 | Launcher 内嵌版 |
|---|---|---|
| 语言 | Python 3.10 | TypeScript（Electron 主进程 + Vue 3） |
| 交互形态 | TUI（rich / questionary / prompt_toolkit） | GUI（Vuetify / Material 3） |
| 进程模型 | 单进程阻塞 + threading 等待注入 | 主进程命令 + 后台任务框架（命名作业） |
| DBus | `dbus-send` 子进程 | dbus-next 原生 |
| 响度分析 | soundfile + numpy + pyloudnorm | 同算法 TypeScript 重写（LoudnessCache） |
| 模糊搜索 | rapidfuzz（C 扩展） | 自实现 token_sort_ratio + Levenshtein + 索引 |
| 歌词存储 | 本地 `.lrc` 文件 | JSONL（LRC + YRC 双份）+ 浮窗/页面双渲染端 |
| 会话 | 单会话内存（刷新即失） | 多会话 JSONL 持久化 + fork/revert/pin |
| 依赖规模 | ~10 个 Python 包 | 整个 Electron + Vue + 前后端工具链 |
| 平台 | Linux 完整 / macOS 大概率 / Windows 需改 | 仅 Linux |

---

## 四、结论

两者本质上是**同一个核心思想的两种产品形态**：

- **AIDJ 独立版** = 轻量、终端化、可玩性高的「命令行电台」：小游戏、沉浸终端、富 TUI、bash 式命令、自带下载/歌词工具。适合喜欢在终端里泡着的用户，或作为纯听歌工具独立运行。
- **Launcher 内嵌版** = 工程化、桌面化、可靠性的「升级形态」：会话持久化、断线重连、自动重试、卡拉OK 双端歌词、后台任务框架、/filter 表达式、持续会话可对话引导。它是独立版在桌面应用里的强化与整合，**但牺牲了终端可玩性**（无小游戏、无沉浸终端、无帮助浏览器）。

一句话：**想要 GUI + 可靠 + 长期会话管理选 Launcher 版；想要轻量 + 终端氛围 + 可玩性选独立版。** 若未来 Launcher 版补上等待小游戏、独立版补上会话持久化，两者会进一步趋同。

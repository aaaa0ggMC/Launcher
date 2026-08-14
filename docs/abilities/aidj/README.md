# AI DJ（aidj）用户手册

**AI DJ** 是一个接入 OpenAI 兼容 API 的「AI 音乐电台」：它能理解你的点歌/氛围需求，从你的本地曲库中生成连贯歌单，通过 MPRIS 控制播放器自动播放，并顺带完成曲库元数据同步、响度平衡与桌面歌词展示。

本能力在侧栏注册了三个页面：

- **AI DJ**（`aidj`）—— 对话生成歌单 + 播放控制 + 会话/频率管理的主页面；
- **歌词**（`aidj-lyrics`）—— 跟随播放的整页歌词展示（卡拉 OK 逐字高亮 / 滚动跟随）；
- **播放器**（`aidj-player`）—— **内置播放器**页面（web 模式下显示，dbus 模式自动隐藏，见 §1.1 播放后端）。

外加一个独立于应用窗口的**桌面歌词浮窗**（绑定在 `src/abilities/aidj/windows/` 的 LyricsWindow）。本文档面向最终用户，覆盖以上全部四个部分。

---

## 1. 前置依赖

AIDJ 依赖下面几个外部组件。**缺失时只是对应功能不可用，不会影响整个应用。**

| 依赖 | 用途 | 缺失时的影响 |
| --- | --- | --- |
| **OpenAI 兼容 API 端点 + API 密钥** | 歌单生成（`aidj.generate`）、持续对话、元数据 AI 提取、会话标题生成 | 对话、`/pr`、持续模式全部不可用；`/random`、`/explore`、`/ftop`、`/filter` 等纯本地命令仍可用 |
| **NeteaseCloudMusicApi 服务**（`ncm_base_url`） | 按歌名搜索歌曲 → 拉取 LRC 歌词与 YRC 卡拉 OK 数据，供元数据提取与歌词展示 | 元数据同步会以「网络错误」失败（看不到歌词就没有可提取的元数据）；已有本地 `.lrc` / `.yrc` 文件时歌词展示不受影响 |
| **MPRIS 兼容播放器**（vlc / mpv 等）+ 会话 DBus | **dbus 模式**下的播放控制（上/下一首、播放/暂停、音量）、发送歌单、持续/连续播放、歌词页与桌面歌词的数据来源 | dbus 模式下播放控制/持久轮播/歌词页/桌面歌词不可用；**web 模式（内置播放器）不依赖此**，歌单仍能正常生成与播放 |
| **ffprobe + ffmpeg** | 响度分析（动态音量平衡）、内嵌封面提取 | 响度平衡不生效（播放音量保持原样）、歌词页封面显示不出来 |

另外：

- 支持的音乐格式：`.mp3` / `.flac` / `.wav` / `.m4a` / `.ogg` / `.opus`（递归扫描）。
- 歌词文件：`.lrc`（标准 LRC）与 `.yrc`（网易云逐字卡拉 OK，本地文件或经 NCM API 拉取）。
- 本能力依赖 `background-tasks` 能力（持续模式 / 连续播放 / 元数据同步 / 局域网遥控都跑在后台任务上），如果该能力被移除，本页面不会显示。

### 1.1 播放后端：dbus 与内置播放器（web）

AIDJ 的播放层有两种后端，可在设置里切换（`preferences.player_mode`，或命令 `aidj.player-mode`）：

| 模式 | 实现 | 适用 |
| --- | --- | --- |
| `dbus`（外部播放器） | 通过 MPRIS / 会话 DBus 控制 vlc / mpv 等 | 已有趁手的外部播放器；Linux 默认 |
| `web`（内置播放器） | 渲染进程 HTML5 `<audio>` + Web Audio 图（EQ / 淡入淡出 / 频谱 / 响度） | 无外部播放器；跨平台（Windows / macOS 只能用它）；功能最全 |

- **非 Linux 平台只能用 web 模式**（没有会话 DBus）。
- 内置播放器需要渲染端能读本地文件：已通过 `cockpit-audio://` 自定义协议 + CORS 白名单打通（`Access-Control-Allow-Origin`）。
- 切换模式：停止播放类后台任务 → 释放旧后端 → 激活新后端，无需重启。
- **侧栏「播放器」页面只在 web 模式下显示**（dbus 模式自动隐藏，避免误导）；dbus 模式下播放入口是 AI DJ 主页面顶部的播放器条。
- 内置播放器页面（§4.5）提供倍速、AB 循环、睡眠定时、EQ 曲线库、频谱、局域网遥控等完整能力。

---

## 2. 配置

配置入口有两个：

- **设置页 → AI DJ → AI DJ 配置**（图形界面，推荐，改动自动保存）；
- 直接编辑 `~/.config/LinuxCockpit/aidj/config.json`（手工编辑优先，UI 会读取它）。

最核心的四项（设置页「API 配置」「音乐库与播放器」）：

| 配置项 | 含义 | 示例 |
| --- | --- | --- |
| `ai_settings.base_url` | OpenAI 兼容端点地址 | `http://localhost:1145/v1` |
| `secrets.api_key` | API 密钥 | `sk-...` |
| `music_folders` | 曲库目录（可多个，递归扫描；同名冲突靠前目录优先） | `["/home/you/Music"]` |
| `ncm_base_url` | NeteaseCloudMusicApi 地址 | `http://localhost:3000` |

改完曲库目录后，建议先做一次「更新元数据」（见 §3.6），让 AI 为每首歌提取语言/情绪/流派等标签，歌单生成和 `/filter` 的元数据筛选才有料可依。

> 完整配置项清单见 §7。

### 首次使用流程

1. 在设置里填好 API 地址、密钥、NCM 地址，添加音乐目录；
2. 打开 **AI DJ** 页面，顶部「API」指示灯应为绿色；
3. 在页面菜单点「更新 MetaData」，后台面板会逐个扫描曲库并补全元数据与歌词（可以边跑边用）；
4. 在输入框描述需求（如「来点轻松的中文歌」），回车发送，稍候即可看到 AI 推荐的歌单卡片。

---

## 3. 主页面（AI DJ）

### 3.1 对话生成歌单

在底部输入框描述你的需求（支持自然语言，如「下雨天的爵士乐」「健身用的快歌」），发送后 AI 会先给一段电台风格的播音词（Intro），再以「推荐歌单」卡片列出从你曲库匹配的歌曲。歌单卡片上可以：

- **全部播放** / **播放单曲** —— 立即发送到播放器；
- **加入连续播放** —— 挂到该播放器上的「连续播放」后台任务，一首接一首自动切；
- **拖拽重排** 歌单顺序；
- **右键消息** —— 回退到此（丢弃其后所有消息与上下文）、从此处分支（复制为 `(Copy)` 会话并切换过去）。

顶部栏显示当前播放的歌曲、播放状态、AI API 连通性，以及一个播放器选择框（「当前激活」= 自动跟随正在播放的 MPRIS 播放器，也可以手动固定到某个播放器）。

### 3.2 状态栏指示器

输入栏上方一排小徽标（显示哪些可在设置里调整顺序，数字 0 = 隐藏）：

| 徽标 | 含义 | 交互 |
| --- | --- | --- |
| `Tokens` | 本会话累计消耗的 prompt+completion tokens | — |
| `Context` / `Completion` | 最近一次请求的输入/输出 tokens | — |
| `Tracks` | 曲库歌曲总数 | — |
| `Memory` | 「已播记忆」里的歌曲数（AI 会回避这些歌） | 点击清空记忆（弹确认） |
| `Volbal` | 响度平衡开关与当前方法 | 点击循环切换 `off → lufs → linear → off` |
| `RecordFreq` | 播放频率记录开关（记入 `frequency.csv`） | 点击开关 |
| `Backgrounds` | 运行中的后台任务数 | — |

### 3.3 斜杠命令

输入以 `/` 开头的行会弹出命令提示（Tab 补全、上下键选择）。这些命令**不走 AI**，纯本地执行：

| 命令 | 用法 | 效果 |
| --- | --- | --- |
| `/random N` | `/random 10` | 随机挑 N 首未听过的歌推入会话上下文 |
| `/pr N` | `/pr 12` | AI 从 N 首随机候选中精选成一串连贯歌单（走 AI） |
| `/explore N` | `/explore 8` | 优先挑「从未播放」的歌，全部听过后退化为「播放最少」 |
| `/ftop` | `/ftop 20` / `/ftop -20` / `/ftop 5 15` | 推送播放频率 Top N / 倒数 N / 第 A–B 名 |
| `/analyse 字段` | `/analyse emotion` | 以 system 消息输出某字段的分布统计（language / emotion / genre / loudness） |
| `/filter 表达式` | 见下 | 按布尔表达式精确过滤曲库 |
| `/persist 消息` | `/persist 来点氛围音乐` | 把当前会话分支为 `(Copy)` 并转后台持续轮播（见 §3.7） |
| `/persist-stop` | `/persist-stop` | 停止运行中的持续会话 |

**`/filter` 表达式语法**（title/歌词/元数据混合）：

```
/filter [--count=N] [--compare=title|lyrics|all] [--ignorecase=true|false] <表达式>
```

- `--count` 缺省 100，负数 = 返回全部；`--compare` 缺省 `title`；
- `--ignorecase` 缺省开：英文忽略大小写，中文简繁模糊匹配（「周杰伦」能命中「周杰倫」）；
- 表达式支持 `and` / `or` / `not` / 括号，文本段用引号包起来；
- `[字段:值]` 按同步出的元数据筛选，字段可为 `language` / `emotion` / `genre` / `loudness` / `review`。

示例：

```
/filter ("The Weeknd" and "Justin Bieber") or ("Taylor")
/filter [language:粤语] and ("周杰伦")
/filter not [genre:古典]
/filter --compare=all [emotion:孤独]
```

### 3.4 会话管理

AI DJ 的每次对话都会落盘为一个会话（存于 `~/.config/LinuxCockpit/aidj/sessions/`）。点顶部中央的下拉把手 → **会话记录**：

- 按「今天 / 昨天 / 日期」分组，可搜索标题/首条提示/预览；
- 点击载入历史会话继续对话（解析歌单时显示进度条）；
- 右键会话：**置顶** / **自动生成标题**（走 AI）/ **设置标题** / **删除**；
- 新建会话 = 页面菜单「新建会话」或下次直接发送（发送新需求会自动开新会话，并在设置开启「自动 AI 生成标题」时自动命名）。

### 3.5 歌曲频率

页面菜单 → **歌曲频率**：按播放次数降序列出所有歌（数据来自 `aidj/frequency.csv`，播放时会递增），可切换排序、点击把歌曲发送到播放器。

### 3.6 更新元数据（后台任务）

页面菜单 → **更新 MetaData** 会启动一个后台任务（名「AIDJ 元数据同步」）：

1. 重新扫描磁盘，把新歌并入曲库；
2. 对每个没有元数据的歌：`NCM 搜索歌词` → `AI 提取 language / emotion / genre / loudness / review` → 追加写入 `aidj/music_metadata.jsonl`；
3. 同时把拉到的 LRC / YRC 存进 `aidj/music_lyrics.jsonl`（桌面歌词与歌词页的数据源）。

已在进行时按钮会直接跳到后台面板。完成后顶部弹出「元数据同步完成：N 」。任务失败/部分失败会在面板控制台里给出原因。

### 3.7 持续模式与连续播放（后台面板）

**持续模式**：在聊天里输入 `/persist 提示词`，当前对话会分支为一个 `(Copy)` 会话，并在**后台任务面板**（侧栏后台任务按钮）里以「持续会话」形式继续跑：

- AI 持续生成歌单批次（每批 ≥8 首，自动预取缓冲），推送到目标播放器一首接一首自动播放；
- 你可以在后台面板的聊天视图里继续发消息给 DJ，它会立刻响应并调整方向；消息后追加 `/discard_follows` 可丢弃排队未播的歌曲、让下一批直接替换队列；
- 每个播放器同时只允许一个连续播放任务（面板可显示实时队列、当前曲、音量、响度平衡状态等）。

**连续播放**：歌单卡片的「加入连续播放」/「全部播放」在有任务冲突时，会启动一个纯播放、无 AI 的 `aidj.continuous` 任务，负责按顺序切歌。

这两个都跑在后台任务框架上：跨页面存活，退出应用时主进程会提示/清理。

---

## 4. 歌词页（侧栏「歌词」，`aidj-lyrics`）

在侧栏点**歌词**进入。它完全跟随当前 MPRIS 播放器（页面打开时会自动激活 AIDJ 的共享播放器绑定），即使没开过 AI DJ 也能用。**页面颜色永远跟随应用主题，不提供颜色配置**；可配置的只有呈现方式与排版。

- **卡拉 OK 逐字高亮**：当歌曲有内联时间戳的歌词（网易 YRC，或本地 `.yrc`）时，当前行会按字逐字填充高亮；普通 LRC 则整行渐变填充。头部会标注来源 `YRC` / `LRC`。
- **歌词滚动跟随**：显示全部歌词并把当前行自动滚到居中；关闭后变成「当前行 ± 固定行数」的静态窗口。
- **头部**：封面、歌名/歌手/专辑、播放状态、播放器选择、上一首 / 播放暂停 / 下一首 / 停止，以及进度条与时间。
- **沉浸模式**：开启且有封面时，用模糊暗化的封面铺满页面作为背景（替代你配置的应用背景）。
- 顶部「桌面歌词」按钮可同时打开桌面浮窗。

配置入口：**设置页 → AIDJ Lyrics → 歌词页配置**（排版/显示模式，见 §7.2）。

---

## 4.5 内置播放器页面（侧栏「播放器」，`aidj-player`）

**内置播放器**是 AIDJ 在 `web` 模式下使用的 HTML5 播放层（见 §1.1），侧栏「播放器」页面只在该模式下显示。它把歌曲经 Web Audio 图路由（`MediaElementAudioSourceNode → EQ 滤波器链 → 主增益 → 频谱 → 输出`），因此 EQ / 淡入淡出 / 频谱 / 响度这些 DBus 模式做不到的能力都是原生的。

### 4.5.1 页面布局

```
顶部中央下拉把手 ─ 页面菜单：播放队列 / 倍速 / 睡眠定时 / EQ / 局域网遥控 / 播放后端
主体：封面、歌名、播放状态、进度条 + 上一首 / 播放暂停 / 下一首 / 停止
底部：响度平衡 chip（off → LUFS → RMS）· 淡入淡出 chip · A/B 循环按钮 · 音量
频谱条（开启时）：实时频段柱，跟随当前主题色
```

- **倍速**：预设 0.5–2.0x 按钮 + 自定义输入框。**任意正数**：≤16x 走原生变速出声；**>16x 为静音快进**（逐帧 seek 快速扫过整首，到末尾自动切下一首继续快进）。
- **AB 循环**：底部 `A` / `B` 两个按钮，在当前进度打点，再次点击清除；两点都设好后在该区间循环（练歌 / 学歌用）。
- **睡眠定时**：页面菜单 → 睡眠定时，选 15–120 分钟；到点自动暂停，可随时取消。
- **EQ**：见 §4.5.2。
- **频谱**：页面菜单开关；开启后在底部显示实时频段柱。
- **局域网遥控**：见 §4.5.3。
- 底部响度平衡 / 淡入淡出 chip 与 AI DJ 主页面共享配置（`preferences`）。

### 4.5.2 EQ：10 段图形式均衡器（eq.jsonl）

EQ 不再是写死的几个预设，而是**用户可管理的 EQ 曲线库**：

- **10 段** ISO 图形式频点：`31 / 63 / 125 / 250 / 500 / 1k / 2k / 4k / 8k / 16k Hz`，每段增益 ±**范围 dB**（默认 ±20，可在设置里调 12–60）。
- **列表式子菜单**：每项显示该曲线的**小图预览** + 名字；点整行应用，右侧 ✎ 编辑、🗑 删除（内置预设不可删，可编辑）。
- **曲线编辑器**（✎ / 顶部 `+` 打开）：直接在平滑曲线上**拖拽控制点**调整各段增益，拖动时**实时发声预览**；底部「整体偏移」滑块一次平移全部频段（直接调整，无「应用」按钮）；取消恢复编辑前的曲线，保存才落盘并应用。
- **存储**：`~/.config/LinuxCockpit/aidj/eq.jsonl`（每行一个 profile，`{id, name, gains, builtin?}`）；`config.json` 只记当前激活的 id（`preferences.eq_preset`）。内置 5 个（平直 / 流行 / 摇滚 / 古典 / 人声）首次启动自动生成，**设置页「重置预设」可一键还原内置曲线（用户自定义保留）**。
- **最大范围**：设置页「EQ 最大范围 (±dB)」可调（12–60），编辑器 Y 轴、滑块与保存 clamp 全部跟随。

### 4.5.3 局域网遥控（Web Remote）

内置播放器自带一个局域网 HTTP 服务，让手机 / 平板 / 同网段设备的浏览器实时看歌曲、封面、进度并控制播放——跨平台的 KDE Connect 替代（Windows / macOS 同样可用）。

- **启动 / 停止**：播放器页菜单 → 局域网遥控，或命令 `aidj.web-remote-start` / `aidj.web-remote-stop`；也跑成一个后台任务（`aidj.web-remote`），后台面板可停止。
- **地址**：启动后页面显示 `http://<本机IP>:<端口>`，局域网内浏览器打开即可。
- **端口**：设置页「局域网遥控端口」可改（默认 `17320`，0 = 禁用）。
- 端点：`GET /`（遥控页面）、`GET /state`（播放快照）、`POST /control`（`play/pause/toggle/next/prev/stop/seek/volume/rate`）。

### 4.5.4 倍速 / 淡入淡出等偏好

这些偏好存在 `~/.config/LinuxCockpit/aidj/config.json` 的 `preferences.*`（见 §7.1），设置页 →「播放器」分类可改：淡入淡出开关 + 时长、EQ 曲线与最大范围、默认倍速 / 默认音量、频谱默认显示、局域网遥控端口。改动即持久化，并实时推给运行中的播放器。

---

## 5. 桌面歌词浮窗（LyricsWindow）

一个**透明、无边框、圆角、置顶**的独立小窗口，悬浮在桌面上显示当前播放歌曲的歌词（当前行 + 前后行），适合边做别的事边看词。

- **打开/关闭**：AI DJ 页面菜单「桌面歌词」、歌词页头部「桌面歌词」按钮，或命令 `aidj.lyrics-toggle`。
- **每个 MPRIS 播放器一个独立实例**：切到另一个播放器会打开它自己的歌词窗口，互不干扰。
- **拖动**：按住窗口空白处拖动（无边框窗口没有系统标题栏）。
- **锁定**：右键窗口 → **锁定**，窗口将不再响应鼠标（不会误点穿透/挡住操作），并自动缩到贴合歌词卡片；解锁走后台任务面板的子窗口列表。
- **外观与位置**：在 `aidj/config.json` 的 `preferences.lyrics` 里配置（也可在设置页「桌面歌词显示」编辑）——字体、字号、行数、颜色（RRGGBBAA）、锚点位置、边距、阴影、圆角、时间偏移等。
- **自动行为**：绑定播放器断开时窗口自动关闭；`lock_on_open` 可让窗口一打开就锁定；`ignore_empty_lines` 控制间奏空行时段是否保持上一句点亮。

### 5.1 Wayland 下的已知局限

Electron 在 Wayland 上缺少窗口能力（定位/置顶/输入路由归合成器所有），因此：

- **定位/居中**：可用（主进程用目标宽高算绝对中心，再经 KWin D-Bus 搬窗）；
- **置顶**：**Wayland 下无效**，需要你在 KDE 里对该窗口手动「总是置顶」（窗口标题固定为 `[AIDJ-Lyrics] <播放器>`，可在 KWin 规则里按 `[AIDJ-Lyrics]` 匹配）；
- **锁定（鼠标穿透）**：Wayland 下无法真穿透，锁定时仅「窗口内部不响应」+ 自动缩窗减少遮挡；真穿透只在 **X11 会话 / Windows / macOS** 可用。

---

## 6. CLI 命令参考

所有命令都可在 CLI REPL（`<command> <args>`）里调用，与 UI 按钮共享同一实现。`<id>` 指后台任务 id（任务启动时返回），`<sessionId>` 指会话 id。

### 6.1 歌单生成与操作

| 命令 | 用法 | 说明 |
| --- | --- | --- |
| `aidj.generate` | `aidj.generate --prompt <text>` | AI 生成歌单（等价聊天发送） |
| `aidj.curate` | `aidj.curate --count <n>` | 从随机候选中 AI 精选成连贯歌单（计入上下文） |
| `aidj.random` | `aidj.random --count <n>` | 随机选 N 首未听过的歌，推入会话上下文 |
| `aidj.explore` | `aidj.explore --count <n>` | 发现未听过/最少播放的歌 |
| `aidj.filter` | `aidj.filter --query <表达式> [--compare=title\|lyrics\|all]` | 布尔表达式过滤曲库（语法见 §3.3） |
| `aidj.ftop` | `aidj.ftop [--count N] [--bottom true] [--from A] [--to B] [--text <t>]` | 播放频率 Top N / 倒数 N / 第 A–B 名 |
| `aidj.search` | `aidj.search --q <关键词>` | 模糊搜索曲库（按 token 相似度，阈值 80） |
| `aidj.save` | `aidj.save --name <名称> --songs <文本>` | 把歌单保存到 `aidj/playlists/<名称>.txt` |
| `aidj.load` | `aidj.load --name <名称>` | 读取已保存歌单 |

### 6.2 播放控制（MPRIS）

| 命令 | 用法 | 说明 |
| --- | --- | --- |
| `aidj.next` / `aidj.prev` / `aidj.toggle` / `aidj.stop` | — | 下一首 / 上一首 / 播放暂停 / 停止 |
| `aidj.send` | `aidj.send --path <文件>...` | 发送歌曲到播放器（单曲即播，多曲入队连播）；开启 `record_freq` 时会递增播放频率 |
| `aidj.volume` | `aidj.volume [--set <0-1>]` | 获取或设置播放器音量 |
| `aidj.status` | `aidj.status` | 播放器状态 + 曲库/记忆/响度平衡等概要 |
| `aidj.list-players` | `aidj.list-players [--force true]` | 列出可用 MPRIS 播放器与当前绑定 |
| `aidj.select-player` | `aidj.select-player --name <player>` | 切换播放器（`__auto__` = 自动跟随） |
| `aidj.freq` | `aidj.freq` | 播放频率列表（按次数降序） |
| `aidj.get-cover` | `aidj.get-cover --path <文件>` | 提取歌曲内嵌封面（base64 data URL） |

### 6.2b 播放后端与内置播放器（web 模式）

`aidj.player-*` / `aidj.eq-*` / `aidj.web-remote-*` 系列只在 `web` 模式下可用（dbus 模式下命令不注册）。

| 命令 | 用法 | 说明 |
| --- | --- | --- |
| `aidj.player-mode` | `aidj.player-mode [--set <dbus\|web>]` | 查询 / 切换播放后端模式 |
| `aidj.player-state` | `aidj.player-state` | 内置播放器完整状态快照（含队列 / 倍速 / AB 循环 / 睡眠 / 淡入淡出 / EQ） |
| `aidj.player-clear-queue` | `aidj.player-clear-queue` | 清空内置播放器队列（当前曲 + 播放历史保留，prev 仍可回退） |
| `aidj.player-volbal` | `aidj.player-volbal [--enabled <bool>] [--method <lufs\|linear>]` | 内置播放器响度平衡（查询 / 设置，即时生效并持久化） |
| `aidj.player-rebase` | `aidj.player-rebase --base <0-1>` | 把当前音量设为响度平衡的新基准 |
| `aidj.player-rate` | `aidj.player-rate [--set <rate>]` | 倍速：任意正数，>16 为静音快进（见 §4.5.1）；持久化 |
| `aidj.player-abloop` | `aidj.player-abloop [--a <sec>] [--b <sec>] [--off true]` | 设置 / 清除 AB 循环点（秒） |
| `aidj.player-sleep` | `aidj.player-sleep --minutes <n>` | 睡眠定时（分钟，0 = 取消） |
| `aidj.player-crossfade` | `aidj.player-crossfade [--enabled <bool>] [--seconds <n>]` | 曲间淡入淡出开关 + 时长（自动切歌时生效，手动切歌即时） |
| `aidj.player-eq` | `aidj.player-eq [--gains "[..10 个 dB..]"]` | 查询当前 EQ 曲线 / 实时预览（不落盘） |
| `aidj.eq-list` | `aidj.eq-list` | 列出 EQ 曲线库（内置 + 自定义）+ 激活项 + 最大范围 |
| `aidj.eq-save` | `aidj.eq-save --name <名> --gains "[..]" [--id <id>]` | 新增 / 更新 EQ 曲线（upsert） |
| `aidj.eq-delete` | `aidj.eq-delete --id <id>` | 删除用户 EQ 曲线（内置不可删；删激活项自动回退 flat） |
| `aidj.eq-active` | `aidj.eq-active --id <id>` | 应用某个 EQ 曲线（持久化激活 id） |
| `aidj.eq-range` | `aidj.eq-range [--set <12-60>]` | 查询 / 设置 EQ 最大增益范围（±dB） |
| `aidj.eq-reset` | `aidj.eq-reset` | 重置内置 EQ 曲线为出厂值（用户自定义保留） |
| `aidj.web-remote-status` | `aidj.web-remote-status` | 局域网遥控服务器运行状态 + 端口 |
| `aidj.web-remote-start` | `aidj.web-remote-start` | 启动局域网遥控（后台任务 `aidj.web-remote`） |
| `aidj.web-remote-stop` | `aidj.web-remote-stop` | 停止局域网遥控 |

### 6.3 元数据与曲库

| 命令 | 用法 | 说明 |
| --- | --- | --- |
| `aidj.sync` | `aidj.sync` | 同步新歌元数据（同步等待，单次） |
| `aidj.metadata-sync` | `aidj.metadata-sync` | 同上，但跑成**后台任务**（推荐，UI「更新 MetaData」即此） |
| `aidj.analyse` | `aidj.analyse --field <language\|emotion\|genre\|loudness>` | 输出某元数据字段的分布统计 |
| `aidj.reload` | `aidj.reload` | 重载曲库/元数据，重建会话与 DBus |
| `aidj.invalidate-library` | `aidj.invalidate-library` | 仅使曲库缓存失效（下次加载重扫） |
| `aidj.get-models` | `aidj.get-models` | 从 API `/v1/models` 拉取可用模型列表 |
| `aidj.network-test` | `aidj.network-test` | 测试 AI API 连通性 |

### 6.4 会话管理

| 命令 | 用法 | 说明 |
| --- | --- | --- |
| `aidj.sessions.list` | `aidj.sessions.list` | 列出所有会话（含置顶/预览/条数） |
| `aidj.sessions.open` | `aidj.sessions.open --id <sessionId>` | 载入会话为当前活跃会话 |
| `aidj.session-fork` | `aidj.session-fork [--keep <n>] [--become true]` | 分支会话；`--become` 载入为新会话 |
| `aidj.sessions.delete` | `aidj.sessions.delete --id <sessionId>` | 删除会话 |
| `aidj.sessions.pin` | `aidj.sessions.pin --id <sessionId>` | 置顶/取消置顶 |
| `aidj.sessions.rename` | `aidj.sessions.rename --id <id> --title <标题>` | 重命名（空标题不改变） |
| `aidj.sessions.gen-title` | `aidj.sessions.gen-title --id <sessionId>` | AI 异步生成标题（后台任务） |
| `aidj.revert` | `aidj.revert --keep <count>` | 回退主界面会话到保留前 count 条 |
| `aidj.refresh` | `aidj.refresh` | 清空已播记忆与历史 |
| `aidj.session-new` | `aidj.session-new` | 新建会话（清空上下文） |
| `aidj.abort` | `aidj.abort` | 中止当前 AI 请求 |
| `aidj.stream-status` | `aidj.stream-status` | 流式生成字符数/重试状态 |

### 6.5 持久模式 / 持续会话 / 连续播放

| 命令 | 用法 | 说明 |
| --- | --- | --- |
| `aidj.start-persistent` | `aidj.start-persistent --prompt <text> [--anchor <n>]` | 启动持久模式（旧入口） |
| `aidj.stop-persistent` | `aidj.stop-persistent` | 停止持久模式 |
| `aidj.chat` | `aidj.chat --task <id> --text <消息>` | 向持续会话发消息；消息可附 `/discard_follows`（丢弃待播队列） |
| `aidj.chat-player` | `aidj.chat-player --task <id> --player <name>` | 切换持续会话推送目标播放器 |
| `aidj.chat-resend` | `aidj.chat-resend --task <id> --songs <json>` | 把歌单重新发送到持续会话的播放器 |
| `aidj.chat-clear-memory` | `aidj.chat-clear-memory --task <id>` | 清空持续会话已播记忆 |
| `aidj.chat-revert` | `aidj.chat-revert --task <id> --keep <count>` | 回退持续会话到保留前 count 条 |
| `aidj.continuous-list` | `aidj.continuous-list` | 列出所有连续播放任务与队列 |
| `aidj.continuous-switch` | `aidj.continuous-switch --task <id> --player <name>` | 切换任务绑定的播放器 |
| `aidj.continuous-enqueue` | `aidj.continuous-enqueue --task <id> --songs <json>` | 向运行中的任务追加歌曲 |
| `aidj.continuous-reorder` | `aidj.continuous-reorder --task <id> --songs <json>` | 重排待播队列 |
| `aidj.continuous-volbal` | `aidj.continuous-volbal --task <id> --enabled <true\|false> [--method <lufs\|linear>]` | 切换响度平衡（即时生效并持久化） |
| `aidj.continuous-recordfreq` | `aidj.continuous-recordfreq --task <id> --enabled <true\|false>` | 切换播放频率记录 |
| `aidj.continuous-clear-memory` | `aidj.continuous-clear-memory --task <id>` | 重置已播记忆（从头重播） |
| `aidj.continuous-volume` | `aidj.continuous-volume --task <id> [--set <0-1>]` | 获取/设置任务音量 |
| `aidj.continuous-rebase` | `aidj.continuous-rebase --task <id> --base <0-1>` | 把当前音量设为响度平衡的新基准（自定义 anchor） |

### 6.6 歌词

| 命令 | 用法 | 说明 |
| --- | --- | --- |
| `aidj.lyrics` | `aidj.lyrics` | 当前播放状态 + 解析出的歌词（歌词窗口/页面轮询此接口） |
| `aidj.lyrics-state` | `aidj.lyrics-state` | 当前播放器的桌面歌词窗口是否打开 |
| `aidj.lyrics-open` / `aidj.lyrics-close` / `aidj.lyrics-toggle` | — | 打开 / 关闭 / 切换桌面歌词浮窗 |
| `aidj.activate` | `aidj.activate` | 激活共享 DBus 播放器绑定（不启动 AI 会话） |
| `aidj.lyrics-player` | `aidj.lyrics-player` | 歌词页当前绑定的播放器与可用列表 |
| `aidj.lyrics-select-player` | `aidj.lyrics-select-player --name <player>` | 绑定歌词页到指定播放器（或 `__auto__`） |
| `aidj.lyrics-page-config` / `aidj.lyrics-page-save` | `--config <json>` | 获取 / 保存歌词页显示配置 |

### 6.7 配置

| 命令 | 用法 | 说明 |
| --- | --- | --- |
| `aidj.get-config` | `aidj.get-config` | 读取当前配置 |
| `aidj.save-config` | `aidj.save-config` | 持久化到 `aidj/config.json` |
| `aidj.update-config` | `aidj.update-config --path <key.path> --value <json>` | 运行时改配置（支持 `preferences.model` 这类点号路径） |
| `aidj.model` | `aidj.model --set <model>` | 切换对话模型（仅运行时，不持久化） |

---

## 7. 配置项参考

### 7.1 `~/.config/LinuxCockpit/aidj/config.json`

| 配置路径 | 类型 / 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `music_folders` | `string[]` | — | 曲库目录，递归扫描 |
| `lyrics_folders` | `string[]` | — | 本地 `.lrc` / `.yrc` 歌词目录（NCM 结果可被其覆盖；同名取最长文件） |
| `ncm_base_url` | `string` | `http://localhost:3000` | NeteaseCloudMusicApi 地址 |
| `secrets.api_key` | `string` | — | OpenAI 兼容端点密钥 |
| `ai_settings.base_url` | `string` | — | OpenAI 兼容端点地址 |
| `ai_settings.metadata_model` | `string` | — | 元数据提取专用模型 |
| `preferences.model` | `string` | — | 对话（歌单生成）模型 |
| `preferences.auto_play` | `boolean` | `true` | 生成后自动播放 |
| `preferences.dbus_target` | `string` | `vlc` | 首选 MPRIS 播放器名 |
| `preferences.player_mode` | `'dbus' \| 'web'` | `dbus`（Linux） | 播放后端：外部 MPRIS 播放器 / 内置播放器（见 §1.1） |
| `preferences.crossfade` | `{enabled, seconds}` | `{false, 2.5}` | 内置播放器曲间淡入淡出（自动切歌时生效） |
| `preferences.eq_preset` | `string` | `flat` | 当前激活的 EQ 曲线 id（曲线库在 `eq.jsonl`，见 §4.5.2） |
| `preferences.eq_gain_range` | `number` | `20` | EQ 最大增益范围 ±dB（12–60） |
| `preferences.playback_rate` | `number` | `1.0` | 内置播放器默认倍速（任意正数，>16 静音快进） |
| `preferences.default_volume` | `number` | `0.8` | 内置播放器初始软件音量（0–1） |
| `preferences.spectrum_enabled` | `boolean` | `false` | 内置播放器频谱条默认显示 |
| `preferences.web_remote_port` | `number` | `17320` | 局域网遥控端口（0 = 禁用） |
| `preferences.record_freq` | `boolean` | `true` | 记录播放频率 |
| `preferences.dynamic_balance_volume` | `boolean` | `true` | 动态响度平衡开关 |
| `preferences.sound_adjust_method` | `'lufs' \| 'linear'` | `lufs` | 响度测量方法（LUFS / RMS） |
| `preferences.volume_curve` | `number` | `3.0` | 音量映射曲线指数（1–5） |
| `preferences.metadata_concurrency` | `number` | `8` | 元数据同步并发数 |
| `preferences.context_mode` | `'discard' \| 'compact'` | `discard` | 历史超限处理：丢弃最旧 / AI 压缩成摘要 |
| `preferences.max_history_length` | `number` | `10` | 历史消息上限（库提示词始终保留） |
| `preferences.auto_title` | `boolean` | `false` | 首次 AI 输出后自动生成会话标题 |
| `preferences.reconnect_minutes` | `number` | `0` | 播放器断开重连窗口（分钟）：0 = 立即结束，>0 = N 分钟内重连，<0 = 永不放弃 |
| `preferences.network_retry_minutes` | `number` | `0` | AI 请求网络重试窗口（分钟）：0 = 快速失败，>0 = N 分钟内重试，<0 = 一直重试 |
| `preferences.library_injects` | `{genre, emotion, language, loudness, review}: boolean` | 全开 | 哪些元数据字段注入给 AI 的曲库清单 |
| `preferences.status_bar` | `{tokens, context, tracks, memory, volbal, record_freq, backgrounds}: number` | 顺序 1–7 | 状态栏徽标顺序，0 = 隐藏 |
| `preferences.persona` | `string` | 内置 | 自定义 DJ 人设（替换 Role 定义；空 = 默认） |
| `preferences.extra_rules` | `string` | — | 追加的行为规则（逐行），追加到每次提示词 |
| `preferences.lyrics` | `LyricsDisplayConfig` 子集 | 见默认 | 桌面歌词浮窗显示配置（见下） |

**桌面歌词显示配置 `preferences.lyrics`**（`LyricsDisplayConfig`，等价 `vp wshowlyrics` 参数，颜色一律 `RRGGBBAA` 十六进制，alpha 在最后）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `font_family` | `Iansui Regular` | 字体 |
| `font_size` | `36` | 当前行字号 (px) |
| `header_size` | `13` | 歌名字号 |
| `candidate_size` | `22` | 非当前行字号 |
| `bg_color` | `00000044` | 卡片背景（`00000000` = 全透明） |
| `fg_color` | `EEEEFFEE` | 当前行文字色 |
| `header_color` | `EEEEFF66` | 歌名文字色 |
| `candidate_color` | `EEEEFF99` | 候选行文字色 |
| `current_weight` / `candidate_weight` / `header_weight` | `700 / 500 / 600` | 各行字重 |
| `shadow` | `0.5` | 当前行文字阴影强度 (0–1) |
| `letter_spacing` | `0` | 字间距 (px) |
| `line_height` | `1.3` | 行高倍数 |
| `anchor` | `top` | 窗口锚点：`top` / `center` / `bottom` |
| `margin` | `50` | 距锚点边缘的边距 (px) |
| `width` | `560` | 初始窗口宽 (px)，`auto_width` 时自动扩张 |
| `auto_width` | `true` | 自动扩张宽度以容纳长句（上限屏幕 90%） |
| `lock_on_open` | `false` | 打开即锁定（不可拖动/右键） |
| `lines_before` / `lines_after` | `0 / 1` | 当前行上/下方显示行数 |
| `show_title` | `true` | 显示歌名 + 歌手标题行 |
| `ignore_empty_lines` | `true` | 空时间戳行（间奏）保持上一句点亮；`false` 则整窗透明 |
| `position_offset_ms` | `0` | 歌词时间偏移（正 = 提前显示） |
| `card_radius` / `card_padding_y` / `card_padding_x` | `12 / 12 / 26` | 卡片圆角与内边距 |
| `line_gap` | `6` | 歌词行间距 (px) |

### 7.2 `~/.config/LinuxCockpit/aidj-lyrics/config.json`（歌词页显示配置）

页面颜色**始终跟随主题**，这里只含排版与呈现模式：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `font_family` | `Iansui Regular` | 字体 |
| `font_size` | `34` | 当前行字号 (px) |
| `candidate_size` | `20` | 候选行字号 |
| `current_weight` / `candidate_weight` | `700 / 500` | 行字重 |
| `line_height` | `1.3` | 行高倍数 |
| `letter_spacing` | `0` | 字间距 (px) |
| `line_gap` | `10` | 行间距 (px) |
| `position_offset_ms` | `0` | 歌词时间偏移 (ms) |
| `karaoke` | `true` | 卡拉 OK 逐字高亮（需要内联时间戳歌词） |
| `scroll_follow` | `true` | 滚动跟随并把当前行居中；关闭 = 静态窗口 |
| `lines_before` / `lines_after` | `2 / 3` | 静态窗口模式下当前行上下行数 |
| `dim_candidates` | `true` | 淡化非当前行 |
| `show_header` | `true` | 显示头部（歌曲信息/控制/进度条） |
| `immerse_mode` | `false` | 沉浸模式：有封面时模糊暗化封面铺满背景 |

---

## 8. 常见问题 / 已知局限

**Q: 顶部「API」显示红色/离线？**
A: 检查 `ai_settings.base_url` 与 `secrets.api_key` 是否正确、端点是否可达（可跑 `aidj.network-test`）。只有对话、`/pr`、持续模式、元数据提取依赖它。

**Q: 元数据同步全部报「NCM API 连接失败」？**
A: 确认 `ncm_base_url` 指向的 NeteaseCloudMusicApi 服务已启动。该服务不可达时同步会跳过所有歌曲（看不到歌词 → 无元数据），但本地已有 `.lrc` / `.yrc` 的歌曲仍可正常显示歌词。

**Q: 发送歌单没声音 / 播放控制无反应？**
A: AIDJ 通过 MPRIS 控制播放器，需播放器支持并开启 MPRIS（vlc、mpv 均支持），且应用与播放器在同一会话 DBus 上。检查顶栏播放器下拉是否选对了播放器。

**Q: 歌词页 / 桌面歌词没有歌词？**
A: 歌词来自元数据同步时拉取的 LRC/YRC，或本地 `lyrics_folders` 里的 `.lrc` / `.yrc` 文件。请先做一次「更新 MetaData」或把歌词文件放进配置的歌词目录。歌名匹配按「文件名 → 去歌手前缀 → 去噪最短子串」逐级兜底。

**Q: 响度平衡没生效？**
A: 需要系统装有 `ffprobe` / `ffmpeg`，且开启了「动态响度平衡」（状态栏 Volbal 徽标可切换）。测量不到的歌曲会被跳过（不猜值、不炸音量），不会回退到错误音量。也可用 `aidj.continuous-rebase` 把当前音量设为平衡基准。

**Q: 持续会话发了消息没反应？**
A: 消息会立刻唤醒 DJ 重新生成（无需等队列放空）。若想让它立刻换方向并丢弃旧队列，在消息后追加 `/discard_follows`。检查后台面板该任务的「发送目标播放器」是否正确（`aidj.chat-player`）。

**Q: Wayland 下桌面歌词窗口不能置顶/穿透？**
A: 见 §5.1。置顶需在 KDE 手动（可配 KWin 规则按标题 `[AIDJ-Lyrics]` 匹配），锁定只能「内部不响应 + 缩窗」。完整能力（真穿透/置顶）仅在 X11 会话 / Windows / macOS。

**Q: 曲库很大，`/filter --compare=lyrics` 很慢？**
A: 歌词全文扫描确实较慢，界面会先显示「系统正在查询…」。中英变体匹配有缓存（整库放得下约 80MB 预算时一次构建后续秒出；放不下则禁用缓存以保证正确性）。`/random` / `/explore` 等不会触发全库扫描。

**Q: 播放频率在哪看？怎么改？**
A: 存在 `aidj/frequency.csv`，AI DJ 页面菜单「歌曲频率」查看，`/ftop` 推送 Top/倒数/区间。「记录播放频率」关闭后不再递增，但已有数据保留。

**Q: 换台播放器会不会乱？**
A: 每个 MPRIS 播放器独立绑定：歌词窗口按播放器各开一个；连续播放任务一个播放器只能有一个（冲突会提示）；持续会话可在运行中改目标播放器。

**Q: 内置播放器没声音？**
A: 检查播放后端是否为 `web`（`aidj.player-mode`），且「播放器」页面是否出现在侧栏（dbus 模式它不显示）。内置播放器把本地文件经 `cockpit-audio://` 协议喂给 `<audio>` 再路由进 Web Audio 图——该协议必须带 CORS 头且元素 `crossOrigin='anonymous'`（已内置，勿改）。极少数情况下 AudioContext 被挂起：恢复播放（暂停再播放）会自动唤醒。

**Q: 倍速填了很大的数（如 100）没声？**
A: 预期行为。≤16x 是真变速出声；**>16x 是静音快进**（浏览器倍速上限 16），会快速扫过整首到末尾自动切下一首。想快速跳过歌曲正文时正好用它。

**Q: EQ 曲线编辑器拖了没反应 / 取消后曲线没还原？**
A: 拖动时是**实时预览**（不落盘）；**保存**才写入 `eq.jsonl` 并应用。点「取消」会恢复到打开编辑器前的曲线。内置预设（平直/流行/摇滚/古典/人声）可编辑不可删除。

**Q: 局域网遥控打不开？**
A: 播放器页菜单 → 局域网遥控启动（需 `web` 模式），页面显示 `http://<本机IP>:<端口>`；确保手机与电脑在同一局域网，且防火墙放行该端口（默认 17320）。端口可在设置里改（0 = 禁用）。

**其他已知取舍（用户可见）**

- 状态栏「Tokens」等数值是会话级累计，重新载入历史会话时会归零重计。
- `aidj.playlist` 命令是占位（返回「队列管理通过 UI 操作」），真正的队列操作在歌单卡片与连续播放任务里。
- 会话标题长度上限 60 字，AI 生成标题上限 20 字；AI 生成的标题也可随时手动改。
- 一次性向播放器发送多曲时走 MPRIS TrackList 入队；个别不支持 TrackList 的播放器退化为逐条 `OpenUri`（可能无法自动连续切歌，建议用「连续播放」任务代替）。
- 内置播放器按曲目自动推进队列；手动「上一首」超过 3 秒时先回到当前曲开头（与常见播放器一致）。

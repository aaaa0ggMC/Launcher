# aidj 播放后端抽象与内置播放器（aidj-player）设计稿

> 状态：**已实现（M1–M4 全部落地，2026-08-14）**。本文保留设计动机、架构决策与已知坑，供后续维护与扩展对照；实现细节以代码为准（`player-backend.ts` / `web-player/engine.ts` / `web-remote.ts`）。
> 原则：`保持命令接口不变即可改写适配`（AGENTS.md「平台适配」）。

## 1. 动机

当前 aidj 通过 MPRIS / 会话 DBus 控制外部播放器（vlc / mpv 等），带来三个结构性限制：

1. **不跨平台**：MPRIS 是 Linux 的 freedesktop 规范，Windows / macOS 没有会话 DBus → aidj 被 `platforms: ['linux']` 绑死，无法在 Windows 上使用。
2. **不丝滑**：position / 状态靠 **600ms 轮询**（`LyricsView` 的 `poll`），无法实时跟随卡拉OK 逐字高亮与滚动。
3. **功能受限**：拿不到波形 / 频谱 / 音量 / 精确 seek，控制粒度受外部播放器 MPRIS 实现参差影响。

**内置播放器（aidj-player）** 用渲染进程 HTML5 `<audio>` 播放本地曲目，一举解决三件事：

- **跨平台**：Windows / macOS 上纯网页播放，系统零依赖（ffmpeg 仅用于响度分析 / 个别格式转码）。
- **丝滑**：`currentTime` + `timeupdate` 事件推送，精确到毫秒、无轮询。
- **扩展**：Web Audio `AnalyserNode` 白拿实时频谱，可后续做可视化 / EQ / 淡入淡出。

## 2. 目标

- aidj 在所有平台可用：非 Linux 平台默认（且只能）用内置播放器；Linux 上 DBus 作为 toggle 可选。
- 现有 70 个 `aidj.*` 命令的 CLI 语义保持不变，只是后端实现可替换。
- 切换后端无需重启应用。

## 3. 架构

### 3.1 PlayerBackend 抽象

```
PlayerBackend
├── DBusBackend       (MPRIS → 外部播放器)   ─┐ Linux 上由设置 toggle 二选一
└── WebPlayerBackend  (内置 HTML5 audio)     ─┘
其他平台：只有 WebPlayerBackend，无 toggle
```

后端必须填充**与后端无关的统一状态模型**，UI 只消费它：

```
PlayerState { track, artist, album, positionMs, lengthMs, status, volume, path }
```

DBus 与 WebPlayer 两个后端都填同一个模型。UI 不做 `isDbus` 渗透式判断。

### 3.2 平台策略

- `platforms: ['linux']` 从 aidj 的 `meta.ts` 移除 → 全平台可用。
- `aidj.player-mode` 命令与对应设置项声明 `platforms: ['linux']`，非 Linux 平台自动过滤（复用现有按平台过滤的能力加载器）。
- Linux 默认值待定：建议默认 `web`（内置），DBus 作为需要外部播放器时的显式选择。

### 3.3 命令层

- `aidj.player-mode` → 查询 / 切换当前后端模式。
- `aidj.send` 双语义：DBus 模式 = 推送到 MPRIS 队列；Web 模式 = 直接播放。
- 其余 `aidj.next / prev / toggle / stop / volume / seek / state` 等走统一 `PlayerBackend` 接口，命令层零改动。

## 4. UI 分叉（收敛到播放器条组件）

DBus 模式渗透进 UI 的现状点：

1. 播放器选择下拉（`ChatView.vue` 顶栏 `v-select` + `select-player` 命令）——Web 模式无此概念。
2. 连接 / 离线状态 chip——DBus 可达性状态，Web 模式无意义。
3. 桌面歌词窗口（绑定「当前 DBus 播放器」）——Web 模式需重指向内置播放器。
4. `aidj.send` 按钮行为——双语义。
5. `aidj.activate`——DBus 专属命令，Web 模式不存在。

**处理**：统一状态模型 + 顶栏「播放器条」组件。`v-if="mode==='dbus'"` 渲染「选择播放器下拉 + 连接状态」，`v-else` 渲染「进度条 + 音量滑条 +（可选）频谱」。歌曲卡片 / 播放按钮 / 聊天 / 歌单生成全部共用，零分叉。切换由设置 toggle 触发，无需重启（页面 keep-alive，ref 存活）。

## 5. 后端热切换流程

`aidj.player-mode` 执行顺序：

```
1. 停掉所有「播放控制类」aidj BT（persistent 轮播 / continuous 连续播放）
2. 释放旧后端（DBusManager.disconnect() / WebPlayer 停流）
3. 激活新后端
4. 广播 cockpit:aidj-mode → UI 更新 mode ref → v-if 切换
```

### BT 分类（切换时只清播放控制类）

| 任务 | 类型 | 切换时 |
| --- | --- | --- |
| `aidj.persistent`（持久轮播） | 播放控制 | 杀 |
| continuous 连续播放 | 播放控制 | 杀 |
| metadata sync / 下载 | 数据类 | 保留 |

> 不推荐「BT 内每次现取后端、热替换」：任务内队列 / 当前歌状态仍要重置，等价于重启，还引入状态不一致风险。杀 + 用户重开最可靠。
> 需要新增：给播放控制类任务打标记，便于切换时精确清理。

## 6. 已知坑与对策

1. **格式盲区**：Chromium 原生不认 `ape / wv / tak`（中文曲库常见）。对策：ffmpeg 转码（后台任务 + 缓存，「边播边转」策略）。
2. **媒体键 → mediaSession 统一方案（修正「三重分叉」）**：WebPlayerBackend 设置 `navigator.mediaSession`（`metadata` + `seekto/play/pause` 回调）后，**Chromium 原生桥接三平台系统媒体层**——Windows → SMTC（音量面板媒体卡片 / 媒体键 / 锁屏）、macOS → Now Playing、Linux → MPRIS。无需各自实现。**验证点**：Electron 的 Chromium 桥接并非 100% 完美（Linux 桥接依赖 GTK / 通知服务在跑，封面与 seek 支持看版本）；若 Linux 桥接质量差，才回退到「自建只读 MPRIS server（`org.mpris.MediaPlayer2.Cockpit`，只读转发 position / 状态）」兜底。
3. **音量模型**：HTML5 `volume` 是软件音量，叠在系统音量之上，无 PipeWire 混音器统一控制。响度平衡（LoudnessCache）「改播放器音量」的语义需重定义。
4. **切换瞬间续播**：DBus → Web 切换时当前歌停止，需用户手动续播；或 WebPlayerBackend 激活时把当前 track 加载进内置播放器继续。前者简单，后者才是真无缝。
5. **事件源切换**：DBus 轮询 vs Web `timeupdate`，切换瞬间解绑旧源、绑定新源，避免双源同时推状态导致 position 跳变。

## 6.5 内置播放器功能清单（候选，按优先级）

> **技术基础**：所有音频处理都依赖把 `<audio>` 接入 `AudioContext`（`MediaElementAudioSourceNode` → 处理链 → `destination`）。`<audio>` 本身不支持 EQ，但接入 Web Audio 图后，EQ / crossfade / 频谱 / 响度归一全部成立——这是 WebPlayerBackend 的核心管线，M2 就应搭好。

**音频处理（最契合 AI 歌单定位）**

1. **交叉淡化（crossfade）**：淡入淡出的完整形态——上一首尾部与下一首头部重叠过渡（`GainNode` 双路交叉 + 预加载下一首）。AI 串歌单故事感最强体现。
2. **情绪感知过渡**：复用 `emotion` 元数据，上一首 loud → 下一首 soft 用长 fade、同情绪短 fade，歌单衔接更有设计感。
3. **EQ**：5~10 段 `BiquadFilter` 级联（预设：流行 / 摇滚 / 古典 / 人声 / 平直）。
4. **响度归一**：播放前按 LoudnessCache（ffprobe 预分析）调 `GainNode`，DBus 模式做不到的实时级。

**可视化**

5. **实时频谱**：`AnalyserNode` 直接白拿，可联动 ft 能力（歌词页嵌一条频谱）。
6. **波形预览条**：`decodeAudioData` 拿 buffer 画波形，进度条升级为「可拖波形」。

**播放体验**

7. **精确 seek + 倍速**（0.5~2x）：`currentTime` + `playbackRate`，DBus 模式无法做到。
8. **AB 循环**：练歌 / 学歌片段循环。
9. **睡眠定时**：AI 歌单自动停。
10. **无缝接歌（gapless）**：下一首缓冲预加载。

**本地增强**

11. **封面本地读取**：MPRIS 的 `mpris:artUrl` 没有「接口」——封面是播放器自己解析标签填进字段的字符串，MPRIS 只是原样转发（KDE Connect 桌面端再读该图片转 base64 推给手机）。所以内置播放器要自己做封面获取：ID3 / FLAC 标签解析 + 同目录 `cover.jpg` / `folder.jpg` 查找。本地文件在手边，成本低。

**跨平台遥控（KDE Connect 的跨平台替代）**

12. **自建局域网 Web 遥控端点**：Linux 的「手机看歌曲 + 封面 + 控制」（KDE Connect 依赖 MPRIS → `mpris:artUrl` → base64 推送）在 Windows / macOS 上因无 MPRIS 而失效。aidj-player 自己暴露一个局域网 Web 端点（手机浏览器 / 未来 PWA），实时看歌曲 / 封面 / 进度条 / 频谱并控制——**三平台统一**，不依赖任何系统媒体层，也顺带补齐「灵动岛看封面」类体验。

**推荐落地顺序**：crossfade + 情绪感知过渡（灵魂）→ 频谱（联动 ft）→ EQ / 响度归一 → 封面本地读取 → 其余按需。

## 7. 里程碑

1. **M1**：`PlayerBackend` 接口 + `aidj.player-mode` 命令 + 后端热切换流程（含 BT 标记清理）。Linux 默认仍 DBus，Web 后端可切。✅
2. **M2**：`WebPlayerBackend`（HTML5 audio 封装 + AudioContext 管线 + 状态填充）+ `navigator.mediaSession` 媒体键桥接 + 顶栏播放器条组件 v-if 分叉 + `aidj.send` 双语义。✅
3. **M3**：桌面歌词窗口绑定重指向内置播放器；封面本地读取（同目录优先）；`meta.ts` 移除 `platforms: ['linux']`，aidj 全平台可用。✅
4. **M4**：crossfade（情绪感知，自动切歌）+ EQ（**10 段图形式曲线库 `eq.jsonl`**，用户可编辑、可调范围）+ 倍速（≤16x 出声 / **>16x 静音快进**）+ AB 循环 + 睡眠定时 + 实时频谱 + 自建局域网 Web 遥控端点（`web-remote.ts`）。✅
5. **M5**（远期）：若 Linux 的 mediaSession→MPRIS 桥接质量差，回退自建只读 MPRIS server。

> 落地偏差（与初稿对照）：
> - crossfade 采用**单元素淡出→切→淡入**（非双元素重叠交叉），且**只对自动切歌（ended）生效**，手动 next/prev 即时切换不等待淡入淡出。
> - EQ 从「5~10 段预设」演进为**10 段 ISO 频点（31–16k）+ 用户可编辑曲线库**（`aidj/eq.jsonl`，每行一个 profile），编辑器为拖拽式平滑曲线 + 整体偏移；增益范围 `preferences.eq_gain_range`（默认 ±20，12–60 可调）。
> - 倍速突破 Chromium 原生上限 16x：>16x 用「逐帧 seek 静音快进」，到曲尾自动切下一首。
> - 局域网遥控跑成后台任务（`aidj.web-remote`），端口 `preferences.web_remote_port`（默认 17320，0 禁用）。
> - 封面本地读取：同目录 `cover.jpg/folder.jpg` 等优先，未命中才走 ffmpeg/ffprobe 嵌入提取。

## 8. 明确不做（本期范围外）

- 不做独立解码器 / native 播放库——HTML5 audio +（远期 ffmpeg 转码）即可，避免 Electron 内置解码的维护成本。
- 不做 UI 全量重构——只动顶栏播放器条组件。
- 不删除 DBusBackend——保留作 Linux fallback。
- 不做 Windows / macOS 外部播放器控制——该侧碎片化（vlc HTTP / AppleScript，功能比 MPRIS 更粗），不进跨平台主线；外部控制仅 Linux 保留 MPRIS，Windows vlc HTTP 列为远期可选 `ExternalPlayerBackend`。

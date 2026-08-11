# Linux System Cockpit

个人系统控制中心，当前面向 **Arch Linux + KDE Plasma 6 (Wayland)** 开发。

基于 Electron + Vue 3 + Vuetify 3 (Material 3) 的桌面应用，核心架构为 CLI-first：每个操作都是注册命令，UI 按钮与 CLI REPL 共享同一套 handler。

**核心是跨平台的**：Electron 主进程 + Vue 渲染端 + 命令注册表 + 日志管线 + 应用注册表 + 设置/国际化 等基础层不依赖任何发行版或桌面环境，在 Windows / macOS / 其他 Linux 桌面理论上都能跑。Linux/发行版相关的部分被隔离在各自的 ability service 与 `scripts/` 里，保持命令接口不变即可改写适配（见下「平台适配」）。

## 功能

- 应用注册表：按目录扫描应用，一键启动 / 附加操作（actions），风险分级按钮
- 镜像源管理：自定义 `[MIRROR]` 格式，行级 toggle，测速，pkexec + 原子写入
- systemd 用户服务管理
- Docker 容器管理
- NVIDIA GPU 信息与电源管理切换
- 自启动项管理
- 自定义仪表盘（gridstack 布局持久化，可锁定布局以便选中复制）
- 侧栏能力动态加载（`~/.config/LinuxCockpit/abilities.yaml` 驱动）+ 侧栏搜索（应用按名称/别名/标签快速启动，右键上下文菜单可执行注入动作）
- 主题 / 配色方案：9 套内置配色 + 跟随系统（JSON 注册表，可扩展），开启「现代动效」时主题切换带波纹揭示动画，页面切换过渡可选（淡入/滑动/上滑/缩放/翻转）
- 傅里叶变换可视化（Canvas2D，无 GPU 依赖）：预设 / 矢量表编辑 / JSON 导入导出 / 2D·3D 相机，画布配色跟随当前主题
- 接口调试（playground）：模板驱动 API 请求 + 变量插值（字符串/数字区间/选择/多行/默认值）+ 响应变换（文本/图片/音频/视频/脚本/异步任务），配置本地持久化
- AI DJ（aidj）：OpenAI 兼容端点生成歌单、本地曲库元数据同步（NeteaseCloudMusicApi + LLM）、MPRIS 播放器控制、响度平衡与持久轮播模式
- 日志系统：winston 轮转日志（自动写入 + 归档）+ 日志查看器（逐行虚拟滚动、级别过滤、实时尾随、导出当前会话）
- 后台任务框架：任意能力可注册长跑作业（进程 / 抽象作业），全局面板实时查看控制台、资源占用（CPU/内存/显存）、stdin 输入与 Ctrl+C 信号控制，退出时提示仍在运行的任务
- 国际化 / 多语言支持（中文 + English，应用条目可配 `zh` / `en_US`）

## 环境要求

**跨平台基线**（框架 + UI + 应用注册表 + 日志等核心层，任何桌面平台通用）：

- Node.js >= 22
- pnpm >= 11
- Electron 可运行的桌面环境

**Linux / 发行版特定能力**所需的系统工具（按需，能力缺失时仅对应页面报空/不可用，不影响整体）：

- `pkexec` (polkit) —— 所有提权操作（镜像源 toggle、NVIDIA 电源管理、root 启动）
- `pacman` —— 镜像源 / 包计数
- `systemctl` —— systemd 用户服务
- `docker` —— 容器管理
- `nvidia-smi` —— GPU 信息
- `flatpak` —— 包计数
- `plasma-apply-wallpaperimage` / `kscreen-doctor` —— 壁纸 / 显示输出（KDE Plasma）
- `konsole` —— 终端启动（可在 `~/.config/LinuxCockpit/config.json` 的 `runtime.terminal` 改）
- `ffprobe` (ffmpeg) —— AI DJ 响度分析（动态音量平衡）
- MPRIS 兼容播放器（`vlc` / `mpv` 等）+ 会话 DBus —— AI DJ 播放控制
- OpenAI 兼容 API 端点 + [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) 服务 —— AI DJ 元数据同步 / 歌单生成

## 开发

```bash
git submodule update --init --recursive
pnpm install
pnpm dev
```

## 构建

```bash
pnpm build
```

## 代码质量

```bash
pnpm typecheck
pnpm lint
pnpm format
```

## 运行载体

核心是**框架**，不是任何单一能力。让一段长跑逻辑跑起来，有几种并列的执行载体，由能力按需选用，互不替代：

| 载体                    | 用途           | 特点                                             |
| ----------------------- | -------------- | ------------------------------------------------ |
| 终端 (`terminal: true`) | 交互式程序     | 交给系统终端（konsole），脱离 Cockpit            |
| systemd ability         | 用户服务       | 开机自启、崩溃自动拉起、系统级持久               |
| 后台任务框架            | 会话内长跑作业 | 跨页面存活、实时控制台/进度/取消、进程级资源统计 |

其中**后台任务框架**是纯框架层设施（`src/main/process/background-tasks.ts`，与 logger 同级），任意能力都能通过 `registerJobHandler` + `background.job` 让前端触发"后端执行"的作业（如下载），不绑定 apps。

写一个作业 = 注册一个普通 async 协程（`while`/`for` + `await` 即循环 + yield，`setProgress`/`pushLine` 更新状态），无模板类：

```ts
import { registerJobHandler } from '../../main/process/background-tasks'

registerJobHandler('download-batch', async (control, args) => {
  const ac = new AbortController()
  control.setCancel(() => ac.abort()) // 面板「停止」→ abort
  for (const f of (args as { files: string[] }).files) {
    if (ac.signal.aborted) {
      control.finish('cancelled')
      return
    }
    control.pushLine(`下载 ${f}`)
    control.setProgress(/* 0–100 */)
    await someAsyncWork(f, { signal: ac.signal }) // yield
  }
  control.finish('exited')
})
```

前端 `await window.cockpit.btJob('download-batch', { files: [...] })` 立即返回，任务在后台跑，全局面板实时看进度/日志、可随时停止。完整样板见 `AGENTS.md`「写一个 Task」。

## 平台适配

架构把「能力 = 页面 + 命令 + 领域类型 + 翻译」内聚在 `src/abilities/<id>/`，命令是唯一对外接口。因此跨平台/跨发行版适配 = **在保持命令接口不变的前提下，改写对应能力的 service / scripts**：

**开箱即跨平台（可移植）**

- 框架层：Electron 窗口、IPC、命令注册表、CLI REPL、日志管线（winston）、后台任务框架
- `apps` 应用注册表：Node fs + `spawn`，纯跨平台（exec 的 `systemd`/`desktop` 类型除外）
- `playground` 接口调试：模板 + fetch 纯前端；`ft` 傅里叶可视化、`logs` 日志、`settings` 设置、`cli` 命令行、`background` 背景框架
- 国际化 / 配置

**Linux / 发行版特定（需按平台改写 service）**

| 能力                   | 当前实现                                                                           | 适配其它平台                                                              |
| ---------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `mirror`               | 解析 `/etc/pacman.d/mirrorlist`，`pkexec` + 脚本原子写                             | 换 apt/dnf/其他源的解析与写入逻辑，命令接口不变                           |
| `systemd`              | `systemctl --user`                                                                 | 换成 launchd / OpenRC / 服务管理器                                        |
| `dashboard`            | `/sys/class/thermal`、`/proc/meminfo`、`df`、`pacman`/`flatpak` 计数、`nvidia-smi` | 换成对应平台的采集实现（`system.ts` / `gpu.ts`）                          |
| `autostart`            | `~/.config/autostart` (XDG)                                                        | macOS LaunchAgents / Windows 启动项目录                                   |
| `display`              | `plasma-apply-wallpaperimage` / `kscreen-doctor`                                   | 对应 DE / OS 的壁纸与输出工具                                             |
| `background/wallpaper` | 解析 KDE plasma 配置                                                               | 对应 DE 的壁纸读取                                                        |
| `aidj`                 | MPRIS DBus 播放控制 + OpenAI 歌单/元数据 + `ffprobe` 响度平衡                      | 播放器控制换对应平台（macOS AppleScript / Windows COM），其余逻辑平台无关 |
| `scripts/`             | `pkexec` + shell helper                                                            | 提权机制换成对应平台（如 macOS `osascript`/Authorization Services）       |

`src/main/process/paths.ts` 集中了所有系统路径，适配时优先改这里；`scripts/` 按平台替换即可。改一个能力 = 只动那个文件夹，不影响其它能力与框架。

### 已知局限：桌面歌词窗口（AIDJ）

Electron 在 **Wayland 下的窗口能力缺失**（合成器拥有定位/置顶/输入路由），当前只能部分缓解：

| 能力                    | 原生 Wayland（KDE）                                                                                             | X11 / Windows / macOS                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 窗口定位（anchor/margin）| 经 KWin D-Bus scripting 搬窗（`frameGeometry.x/y`，caption 匹配）                                                | 原生 `setPosition` ✓                         |
| 水平居中                | 主进程主屏工作区计算 + KWin 搬窗 ✓                                                                               | ✓                                            |
| 置顶                    | 合成器忽略，需 KDE 手动置顶                                                                                      | `setAlwaysOnTop` ✓                           |
| 锁定（鼠标穿透）        | 不可穿透：`setIgnoreMouseEvents` 在 Wayland 是 no-op；锁定时仅「窗口内部不响应」+ 自动缩窗到贴合内容以减少遮挡      | 真穿透 ✓（X11 需真实 X11 会话）              |
| 子窗口标题              | `[AIDJ-Lyrics] <player>`（固定、KWin Rules 可直接按 `[AIDJ-Lyrics]` 匹配）                    | ✓ |

补充：

- `ELECTRON_OZONE_PLATFORM_HINT` 在 **Electron 38 起被移除**；用 `--ozone-platform=x11` 强制 XWayland 会让 GPU 进程段错误（`exit_code=139`），禁用硬件加速后又因透明窗口走 `x11_software_bitmap_presenter` 而无法呈现——**XWayland 路线不可用**。
- **X11 专属**：歌词窗会通过 `xprop` 把 EWMH 窗口类型设为 `_NET_WM_WINDOW_TYPE_NOTIFICATION`（KWin 的 OSD/Notification 类），KWin 可据此应用 OSD 窗口规则；Wayland 下 xdg-shell 无窗口类型，每个 Electron 窗口都是 Normal。
- 因此歌词窗口仅推荐在 **X11 会话 / Windows / macOS** 使用完整能力（穿透、置顶、定位）；Wayland 下可接受"内部不响应 + 缩窗"的锁定语义。
- 其它平台（`setIgnoreMouseEvents`/`setAlwaysOnTop`/`setPosition`）均正常。

## 系统级配置

提权操作需要把 polkit 规则安装到系统（免重复输密码）：

```bash
sudo cp scripts/49-cockpit-pkexec.rules /usr/share/polkit-1/rules.d/
sudo chmod 644 /usr/share/polkit-1/rules.d/49-cockpit-pkexec.rules
```

## 许可证

- 项目本体：**MIT**（见 `LICENSE`）。
- 图标包 [game-icon-pack](https://github.com/Nieobie/game-icon-pack)：**CC0 1.0 Universal**（公有领域，随子模块自带许可）。

详细架构见 `STRUCTURE.md`，开发与操作手册见 `AGENTS.md`，界面排版规范见 `DESIGN.md`。

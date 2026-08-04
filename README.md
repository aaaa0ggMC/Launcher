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
- 侧栏能力动态加载（`config/abilities.yaml` 驱动）+ 可配置页面切换动画（淡入/滑动/上滑/缩放/翻转）
- 傅里叶变换可视化（three.js）：预设 / 矢量表编辑 / JSON 导入导出 / 2D·3D 相机
- 日志系统：winston 轮转日志（自动写入 + 归档）+ 日志查看器（逐行虚拟滚动、级别过滤、实时尾随、导出当前会话）
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
- `konsole` —— 终端启动（可在 `config.json` 的 `runtime.terminal` 改）

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

## 平台适配

架构把「能力 = 页面 + 命令 + 领域类型 + 翻译」内聚在 `src/abilities/<id>/`，命令是唯一对外接口。因此跨平台/跨发行版适配 = **在保持命令接口不变的前提下，改写对应能力的 service / scripts**：

**开箱即跨平台（可移植）**

- 框架层：Electron 窗口、IPC、命令注册表、CLI REPL、日志管线（winston）
- `apps` 应用注册表：Node fs + `spawn`，纯跨平台（exec 的 `systemd`/`desktop` 类型除外）
- `ft` 傅里叶可视化、`logs` 日志、`settings` 设置、`cli` 命令行、`background` 背景框架
- 国际化 / 配置

**Linux / 发行版特定（需按平台改写 service）**

| 能力 | 当前实现 | 适配其它平台 |
|---|---|---|
| `mirror` | 解析 `/etc/pacman.d/mirrorlist`，`pkexec` + 脚本原子写 | 换 apt/dnf/其他源的解析与写入逻辑，命令接口不变 |
| `systemd` | `systemctl --user` | 换成 launchd / OpenRC / 服务管理器 |
| `dashboard` | `/sys/class/thermal`、`/proc/meminfo`、`df`、`pacman`/`flatpak` 计数、`nvidia-smi` | 换成对应平台的采集实现（`system.ts` / `gpu.ts`） |
| `autostart` | `~/.config/autostart` (XDG) | macOS LaunchAgents / Windows 启动项目录 |
| `display` | `plasma-apply-wallpaperimage` / `kscreen-doctor` | 对应 DE / OS 的壁纸与输出工具 |
| `background/wallpaper` | 解析 KDE plasma 配置 | 对应 DE 的壁纸读取 |
| `scripts/` | `pkexec` + shell helper | 提权机制换成对应平台（如 macOS `osascript`/Authorization Services） |

`src/main/process/paths.ts` 集中了所有系统路径，适配时优先改这里；`scripts/` 按平台替换即可。改一个能力 = 只动那个文件夹，不影响其它能力与框架。

## 系统级配置

提权操作需要把 polkit 规则安装到系统（免重复输密码）：

```bash
sudo cp scripts/49-cockpit-pkexec.rules /usr/share/polkit-1/rules.d/
sudo chmod 644 /usr/share/polkit-1/rules.d/49-cockpit-pkexec.rules
```

## 许可证

- 项目本体：**MIT**（见 `LICENSE`）。
- 图标包 [game-icon-pack](https://github.com/Nieobie/game-icon-pack)：**CC0 1.0 Universal**（公有领域，随子模块自带许可）。

详细架构见 `STRUCTURE.md`，开发与操作手册见 `AGENTS.md`。

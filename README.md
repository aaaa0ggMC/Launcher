# Linux System Cockpit

Arch Linux + KDE Plasma 6 (Wayland) 上的个人系统控制中心。

基于 Electron + Vue 3 + Vuetify 3 (Material 3) 的桌面应用，核心架构为 CLI-first：每个操作都是注册命令，UI 按钮与 CLI REPL 共享同一套 handler。

## 功能

- 应用注册表：按目录扫描应用，一键启动 / 附加操作（actions），风险分级按钮
- 镜像源管理：自定义 `[MIRROR]` 格式，行级 toggle，测速，pkexec + 原子写入
- systemd 用户服务管理
- Docker 容器管理
- NVIDIA GPU 信息与电源管理切换
- 自启动项管理
- 自定义仪表盘（gridstack 布局持久化，可锁定布局以便选中复制）
- 侧栏能力动态加载（`config/abilities.yaml` 驱动）+ 可配置页面切换动画（淡入/滑动/上滑/缩放/翻转）
- 国际化 / 多语言支持（中文 + English，应用条目可配 `zh` / `en_US`）

## 环境要求

- Node.js >= 22
- pnpm >= 11
- Arch Linux + KDE Plasma 6 (Wayland)
- 提权操作依赖 `pkexec` (polkit)

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

## 系统级配置

提权操作需要把 polkit 规则安装到系统：

```bash
sudo cp scripts/49-cockpit-pkexec.rules /usr/share/polkit-1/rules.d/
sudo chmod 644 /usr/share/polkit-1/rules.d/49-cockpit-pkexec.rules
```

详细说明见 `AGENTS.md`。

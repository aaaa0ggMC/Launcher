# AGENTS.md

Linux System Cockpit — Arch Linux + KDE Plasma 6 (Wayland) 上的个人系统控制中心。
Electron + Vue 3 + Vuetify 3 (Material 3)。以下为搭建、开发、迁移的完整流程。

## 1. 环境要求

- Node.js ≥ 22 (开发机为 v26.5.0)
- pnpm ≥ 11 (`corepack enable && corepack prepare pnpm@latest --activate`)
- Arch Linux + KDE Plasma 6 (Wayland)。其他桌面理论上可用但未测试。
- 系统工具（可选，按需）：
  - `pkexec` (polkit) — 提权操作必须
  - `nvidia-smi` — GPU 信息
  - `docker` — 容器管理
  - `flatpak` — 包计数
  - `pacman` — 包计数
  - `konsole` — 终端启动 (可在 config.json 改)

## 2. 安装依赖

```bash
pnpm install
```

### 2.1 git submodule — 图标库

侧栏/应用图标使用 [game-icon-pack](https://github.com/Nieobie/game-icon-pack) (CC0)。
它以 git submodule 挂在 `src/renderer/assets/game-icon-pack`，克隆后必须初始化，否则图标无法解析：

```bash
git submodule update --init --recursive
```

更新到上游最新：

```bash
git submodule update --remote src/renderer/assets/game-icon-pack
```

渲染端 `GameIcon.vue` 用 `import.meta.glob('../assets/game-icon-pack/svg/**/*.svg')` 读取，SVG 结构与上游一致 (`svg/no-padding` + `svg/padding`)。

## 3. 系统级配置 (迁移时必须手动执行)

### 3.1 polkit 规则 — pkexec 免重复输密码

`scripts/49-cockpit-pkexec.rules` 需复制到系统 polkit 目录，否则每次提权操作都会弹密码框：

```bash
sudo cp scripts/49-cockpit-pkexec.rules /usr/share/polkit-1/rules.d/
sudo chmod 644 /usr/share/polkit-1/rules.d/49-cockpit-pkexec.rules
```

效果：wheel 组用户调用 Cockpit 的 helper 脚本时，认证一次后 5 分钟内免重复输密码。

### 3.2 helper 脚本 (开发模式)

开发模式下 `scripts/` 目录的脚本通过 pkexec 直接调用，路径由 `paths.ts` 的 `SCRIPTS_DIR` 指向项目内。无需额外安装。打包后的路径会不同，届时需调整 `SCRIPTS_DIR` 或将脚本安装到系统路径。

当前脚本列表：

- `write-mirrorlist.sh` — 原子替换 `/etc/pacman.d/mirrorlist` (mv, 非 cp)
- `nvidia-pm-toggle.sh` — 切换 NVIDIA 电源管理参数
- `run-as-root.sh` — 以 root 执行任意命令

### 3.3 mirrorlist 格式

Cockpit 使用自定义的 `[MIRROR]` 格式管理 `/etc/pacman.d/mirrorlist`：

```
# [MIRROR] USTC
Server = https://mirrors.ustc.edu.cn/archlinux/$repo/os/$arch

# [MIRROR] TUNA
# Server = https://mirrors.tuna.tsinghua.edu.cn/archlinux/$repo/os/$arch
```

- `Server =` 开头 = 启用
- `# Server =` 开头 = 禁用
- pacman 天然支持多源同时启用
- 首次使用时如果文件是旧格式 (裸 `Server =` 行)，第一次 toggle 会自动迁移
- toggle 操作只改注释行，不动其他内容

## 4. 配置文件

### config/config.json — 全局外壳配置

```jsonc
{
  "theme": "dark", // dark | pureblack | system
  "language": "zh",
  "uiScale": 1.1, // 界面缩放 (0.8–1.8, webFrame.setZoomFactor)
  "window": { "width": 1280, "height": 800 },
  "runtime": {
    "terminal": ["konsole", "--hold", "-e"], // terminal:true 的条目用这个
    "confirmBeforeLaunch": true
  }
}
```

### config/abilities.yaml — 侧栏清单 + 每能力配置

控制侧栏顺序、启用状态、各能力的 config 块 (镜像源列表、搜索目录等)。

### ~/Apps/apps.json — 应用注册表

每个搜索根目录下一份。手工编辑优先，扫描器只补充不覆盖。

## 5. 开发

```bash
pnpm dev          # 启动 electron-vite dev server
```

## 6. 构建

```bash
pnpm build        # typecheck + electron-vite build
```

## 7. 代码质量

```bash
pnpm typecheck    # tsc (node) + vue-tsc (renderer)
pnpm lint         # eslint --cache .
pnpm format       # prettier --write .
```

**提交前必须跑 `pnpm typecheck && pnpm lint`，0 errors 才算通过。**
prettier 配置：单引号、无分号、printWidth 100、无尾逗号。

## 8. 项目结构

```
src/
  main/               # Electron 主进程
    index.ts          # BrowserWindow + 单例 + IPC
    commands.ts        # 命令注册表 (CLI-first 核心)
    mirror.ts          # 镜像源: 解析 [MIRROR] 格式 / 行级 toggle / 测速
    launcher.ts        # exec spec → spawn argv (禁止 shell 拼接)
    scanner.ts         # 应用扫描 (只补充不覆盖)
    system.ts          # 系统信息采集 (CPU/内存/swap/包数/GPU)
    gpu.ts             # nvidia-smi 查询
    ...
  preload/
    index.ts           # contextBridge → window.cockpit.*
    index.d.ts         # 类型声明
  renderer/
    App.vue            # 侧栏 + app-bar + keep-alive 宿主
    main.ts            # Vuetify 初始化
    abilities/         # 每个能力一个文件夹
      <id>/
        index.ts       # Ability 元数据 (id/name/icon/category/component)
        View.vue       # 页面组件
    components/         # 共享组件 (GameIcon, AbilityIcon, LoadingBar)
    assets/icons/      # game-icon-pack SVG 图标
    translations/      # 翻译文件: zh.json / en-US.json / index.json
    i18n.ts            # translate/translateTemplate/localize/useI18n
    styles/
      theme.ts         # Vuetify 主题 token (dark / pureblack)
      global.css       # 全局样式 (排版/卡片/滚动条/按钮)
    composables/
      format.ts        # fmtBytes / fmtUptime / riskColor
  shared/
    types.ts           # 跨进程共享类型
config/
  config.json
  abilities.yaml
scripts/               # pkexec helper 脚本 + polkit 规则
```

## 9. 架构要点

### CLI-first

每个操作都是一个注册命令 (`<ability>.<command>`)。UI 按钮和 CLI REPL 共享同一个 handler，不存在只能从 UI 触发的操作。

- UI: `window.cockpit.command('mirror.toggle', { name, enable })`
- CLI: `mirror.toggle --name USTC --enable true`

### Ability 动态加载

- 渲染端: Vite `import.meta.glob` → 首次显示时 async `import()` (code-split)
- 侧栏由 `abilities.yaml` 驱动，增删能力文件夹 + 改 yaml 即可

### 图标

侧栏图标使用 game-icon-pack SVG 系列，存放在 `src/renderer/assets/icons/`。
通过 `GameIcon.vue` 组件渲染 (`fill="currentColor"` 跟随主题色)。
ability 的 icon 字段用 `gi:<name>` 前缀指定 SVG，其余格式按 emoji 处理。

### 镜像源 toggle 安全性

- `toggleMirror` 只修改目标 Server 行的 `# ` 注释前缀，其余行原样保留
- 写入用临时文件 + `mv` 原子替换 (write-mirrorlist.sh)
- pkexec 拒绝 / 任何错误 → 原文件不受影响
- 所有 toggle 通过 Promise 链串行化，防止快速点击导致 IO 竞态

### UI 缩放

通过 Electron `webFrame.setZoomFactor()` 实现真正的等比缩放 (不是只改 rem)。
设置页滑块拖动时只更新数值，松手 (`@end`) 才应用缩放 + 持久化。

### 新增一个 Ability

每个 ability 由三个可选的注入点组成，按需添加：

1. **渲染端页面** `src/renderer/abilities/<id>/index.ts`（`Ability` 对象）+ `View.vue`
2. **主进程命令** `src/main/commands/<id>.ts`（导出 `CommandSpec[]`），并在 `src/main/commands/index.ts` 加一行 import + 展开
3. **设置注入** `index.ts` 里的 `settings` 数组（分类/条目）

然后在 `config/abilities.yaml` 的 `abilities` 列表注册（`id`/`order`/`enabled`）。

**依赖原则**：
- settings 是自身能力，其注入项不能调用其他能力已移除的命令（跨能力设置项应由对应能力自己注入）
- 渲染端页面不应 `import` 其他 ability 模块
- 删除能力 = 删文件夹 + 改 yaml + 删命令文件 + 移除 `commands/index.ts` 里的 import

## 10. 国际化 (i18n)

翻译文件位于 `src/renderer/translations/`，目前支持 `zh`（中文）和 `en-US`（美国英语）。

### 10.1 UI 字符串

- `src/renderer/i18n.ts` 提供 `translate(lang, key, fallback?)` 和 `translateTemplate(lang, key, vars, fallback?)`
- 每个 ability View 通过 `inject('cockpit:lang')` 获取当前语言 Ref
- 回退链：当前语言 → zh → fallback 入参 → key 本身
- 主进程通过 `src/main/i18n.ts` 的 `t()`/`te()` 读取同一份翻译文件
- 添加新键时必须在 `zh.json` 和 `en-US.json` 同时添加

### 10.2 Ability 设置注入

每个 ability 的 `index.ts` 可通过 `settings` 数组注入设置页分类。分类的 `label`/`description` 通过 `translate('label.{text}', text)` 走翻译文件。

### 10.3 apps.json 多语言

`name`、`description`、`alias` 支持对象格式：

```json
"name": {
  "zh": "哔哩观看器",
  "en_US": "Bili Viewer"
}
```

回退链：当前语言 → `en_US` → 第一个可用值 → 原始字符串。
`normalizeEntry`（`registry.ts`）在读取时自动解析，编辑器（`apps/View.vue`）支持通过可折叠「多语言」区域填写翻译。

### 10.4 AI 开发注意事项

> **任何涉及用户可见文本的新增/修改，都必须考虑多语言。**
> 所有 ability View 的 `<template>` 中的中文文本必须通过 `translate(uiLang, 'key')` 输出。
> 所有 `scripts` 中的用户可见字符串（dialog title、error message、help text 等）必须通过 `translate()`/`t()` 输出。
> 新键必须同步添加到 `src/renderer/translations/zh.json` 和 `src/renderer/translations/en-US.json`。
> 主进程中的字符串使用 `src/main/i18n.ts` 的 `t(key, fallback?)` / `te(key, vars)`。
> apps.json 的 `name`/`description`/`alias` 默认生成时至少包含 `zh` 和 `en_US` 两个语言。

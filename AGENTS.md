# AGENTS.md

Linux System Cockpit — 个人系统控制中心，当前面向 Arch Linux + KDE Plasma 6 (Wayland) 开发。
Electron + Vue 3 + Vuetify 3 (Material 3)。以下为搭建、开发、迁移的完整流程。

> **UI 改动必须先读 `DESIGN.md`**（界面排版规范：尺寸底线、常见误区、检查清单）——本项目反复踩的坑是"界面设计得太紧"（元素贴边、文字挤顶部、间距不足）。文字按钮一律默认密度，`size="small"` 只留给图标按钮。

> 核心（框架、命令注册表、UI、日志、后台任务、应用注册表、ft、logs 等）跨平台，不依赖具体发行版/桌面；
> Linux/发行版相关逻辑都隔离在对应 ability 的 service 与 `scripts/`，保持命令接口不变即可改写适配（见 README「平台适配」）。

## 1. 环境要求

**跨平台基线**：

- Node.js ≥ 22 (开发机为 v26.5.0)
- pnpm ≥ 11 (`corepack enable && corepack prepare pnpm@latest --activate`)
- Electron 可运行的桌面环境（主要验证于 Arch Linux + KDE Plasma 6 / Wayland；Windows 已实机验证框架/UI/内置播放器/听歌时长统计等跨平台部分）

**Linux / 发行版特定能力的系统工具**（可选，按需；缺失时仅对应能力不可用）：

- `pkexec` (polkit) — 提权操作必须
- `nvidia-smi` — GPU 信息
- `docker` — 容器管理
- `flatpak` — 包计数
- `pacman` — 镜像源 / 包计数
- `systemctl` — systemd 服务
- `plasma-apply-wallpaperimage` / `kscreen-doctor` — 壁纸 / 显示输出 (KDE)
- `konsole` — 终端启动 (可在 `~/.config/LinuxCockpit/config.json` 改)
- `ffprobe` (ffmpeg) — AIDJ 响度分析（动态音量平衡）/ YARJ 视频元数据与 GPS 解析
- MPRIS 兼容播放器（`vlc` / `mpv` 等）+ 会话 DBus — AIDJ 播放控制
- OpenAI 兼容 API 端点 + [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) 服务 — AIDJ 元数据同步 / 歌单生成

## 2. 安装依赖

```bash
pnpm install
```

### 2.1 git submodule — 图标库

应用图标（`default/<name>`）与侧栏图标的兜底都依赖 [game-icon-pack](https://github.com/Nieobie/game-icon-pack) (CC0)。
它以 git submodule 挂在 `src/main/ui/assets/game-icon-pack`，克隆后必须初始化，否则图标无法解析：

```bash
git submodule update --init --recursive
```

更新到上游最新：

```bash
git submodule update --remote src/main/ui/assets/game-icon-pack
```

渲染端 `GameIcon.vue` 用 `import.meta.glob('../assets/game-icon-pack/svg/**/*.svg')` 读取，SVG 结构与上游一致 (`svg/no-padding` + `svg/padding`)。

### 2.2 每个 Ability 自带 package.json — 依赖声明即插件清单

项目是 pnpm workspace：`pnpm-workspace.yaml` 的 `packages: ['src/abilities/*']`，**每个 ability 文件夹就是一个小包**，用 `package.json` 声明自己的第三方依赖。根目录 `pnpm install` 一键安装全部（共享 `.pnpm` store 去重）。

**根目录 `package.json` 只允许框架依赖 + esbuild**（框架 = `src/main` / `src/main/ui` / `preload` / `shared` 用到的：electron 系、vue、vuetify、@mdi/font、winston、pidusage、dbus-next、esbuild 与全部构建工具）。凡是"某个 ability 专属"的 npm 依赖一律放该 ability 的 `package.json`：

```jsonc
// src/abilities/aidj/package.json
{
  "name": "@cockpit/aidj",
  "private": true,
  "dependencies": {
    "dbus-next": "^0.10.2",
    "openai": "^7.4.0",
    "opencc-js": "^1.4.1"
  }
}
```

当前能力依赖归属：

- `aidj` → `dbus-next` / `openai` / `opencc-js`
- `apps` → `chokidar`
- `dashboard` → `gridstack`
- `rungame` → `three`（+ devDeps `@types/three`）
- `yaya` → `openai` / `katex`（数学公式，渲染端按需加载）
- 其余 ability 只用框架提供的东西（vue/vuetify 等），`package.json` 留空

**规则与机制**：

- 能力专属依赖被主进程打包时**内联进 `out/main/index.js`**（`externalizeDepsPlugin` 只读根 package.json，移出根的依赖自动被 rollup 打进产物）→ 运行时无需 node_modules，天然适配 zip 分发。框架运行时依赖（esbuild/dbus-next/winston/pidusage 等）保持 external，从 node_modules require。
- `dbus-next` 是特例：`windows.ts`（框架，KWin 定位）也动态 require 它，所以**根目录保留** + aidj 再声明一份（同版本去重，便于 aidj 单独分发）。
- **zip 分发**：一个 ability 打包时带上自己的 `package.json`（含 `node_modules/` 不入库、不入 zip，重新 install 自动补齐）。解压丢进 `src/abilities/<id>/` → `pnpm install` 即自动识别为 workspace 成员并安装其依赖。gitignored 的整包能力（fnaf/ut/mt/rungame）就是这么分发的。
- 新增第三方依赖：把包名写进对应 ability 的 `package.json`，不要加进根 `package.json`。
- 能力自己的 `node_modules/` 由 pnpm 生成（符号链接），已在 .gitignore 的 `node_modules` 规则覆盖下。

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

### ~/.config/LinuxCockpit/config.json — 全局外壳配置

```jsonc
{
  "theme": "dark", // 配色方案: dark | light | pureblack | moonlight | forest | aurora | rosy | sepia | slate | system
  "language": "zh",
  "uiScale": 1.1, // 界面缩放 (0.8–1.8, webFrame.setZoomFactor)
  "animations": {
    "modernMotion": true, // 现代动效总开关（关 → 所有动效关闭，主题即时切换）
    "enabled": true, // 页面切换动画开关
    "pageTransition": "fade", // fade | slide | slide-up | zoom | flip
    "themeTransition": "corner" // 主题切换扩散起点: corner(左上角) | cursor(鼠标处)
  },
  "window": {
    "width": 1280,
    "height": 800,
    "frameless": true, // 无边框窗口
    "rounded": true, // 圆角（frameless 时生效）
    "background": "transparent", // transparent | image | wallpaper
    "backgroundImage": "", // background=image 时的图片路径
    "backgroundOpacity": 1, // 背景图片不透明度
    "fuseAlpha": 0.85, // Fuse 蒙层不透明度 (0–1)
    "fuseBlur": 28 // 背景模糊 (px),
    "blur": "on" // 模糊效果：on（默认）| off | auto（窄屏关闭）。off 时 <html> 加 .no-blur，global.css 统一关掉 backdrop-filter 并让顶栏/侧栏底色更实，背景图模糊当作 0
  },
  "runtime": {
    "terminal": ["konsole", "--hold", "-e"], // terminal:true 的条目用这个
    "confirmBeforeLaunch": true
  },
  "sidebar": {
    "default": "cli" // 初始页面（缺失/无效时回落第一个能力）
  }
}
```

`theme` 的取值来自 `src/main/ui/color_schemes/*.json`（见 §9「主题」）；未知 id 自动回落 `dark`，不会弄坏 UI。

### config.json 的 `sidebar` — 初始页面与排序

侧栏**不再**由 yaml 文件驱动能力清单/顺序——Ability 自注入（见 §9「Ability 动态加载」）：扫描 `src/abilities/*/index.ts`，按 `category` 字母序分组、组内按名称字母序排序，`platforms` 过滤平台。`config.json` 里的 `sidebar.default` 只指定初始页面（缺失/无效时回落第一个能力）。各能力的专属配置独立存放在 `~/.config/LinuxCockpit/<ability-id>/config.json`（如 AIDJ 的 `aidj/config.json` 存曲库路径、API 密钥、模型与播放偏好）。

`sidebar.sort` 控制侧栏排列规则（`App.vue` 消费，设置页可改）：

```jsonc
"sidebar": {
  "default": "cli",        // 初始页面
  "sort": "alpha",         // alpha 字母序（默认）| frequency 使用频次 | recent 最近使用
  "mode": "auto"           // 侧栏形态：auto（≤720px 窄屏弹出式、宽屏常驻）| always 常驻 | overlay 始终弹出式
}
```

使用频次/最近使用来自 `~/.config/LinuxCockpit/apps.csv`（`src/main/process/usage-stats.ts` 读写，CSV：`id,count,last_used`）。**每次点开侧栏条目**记一次（`stats.record`，id = ability id），**每次启动应用**也记一次（apps launcher 的 `launchSpec`，id = `app:<root>:<id>`）。改动用 `cockpit:usage-changed` 广播即时反映到侧栏排序；设置页「清空使用记录」调 `stats.clear` 归零。

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
pnpm typecheck    # tsc (node) + vue-tsc (renderer) + 模板编译检查（scripts/check-vue-templates.mjs）
pnpm lint         # eslint --cache .
pnpm format       # prettier --write .
```

**提交前必须跑 `pnpm typecheck && pnpm lint`，0 errors 才算通过。**
prettier 配置：单引号、无分号、printWidth 100、无尾逗号。
**模板里不要写多语句事件处理器**（`@click="a = 1; b()"`）：无分号的 prettier 会把它拆成两行并去掉分号，Vue 编译器解析失败，而 vue-tsc / eslint 都不报——改成调用一个函数。`pnpm typecheck` 里的模板编译检查会拦住这类问题。

**UI 改动必须参照 `DESIGN.md`**（界面排版规范，尤其「§3 尺寸底线」「§4 常见误区」「§6 检查清单」）——避免把界面设计得太紧（元素贴边、文字挤顶部、间距不足）。

## 8. 项目结构

```
src/
  main/               # 主程序 (Electron 主进程 + UI 框架)
    index.ts          # Electron 入口: BrowserWindow + 单例 + IPC 接线
    process/          # 主进程 (后端)
      ipc.ts          # window.* / dialog.* 等 chrome IPC
      cli.ts          # CLI REPL
      commands/        # 命令注册表 (CLI-first 核心): types.ts + registry.ts
      abilities-loader.ts  # 加载器: globs src/abilities/*/commands.ts → registerAll
      ability-loader.ts    # 外部用户能力 (esbuild 即时编译)
      background-tasks.ts  # 后台任务框架 (进程/作业任务, 资源统计, stdin/信号)
      windows.ts           # 子窗口管理器 (SubWindow): 生命周期/几何/样式重建/KWin 定位
      paths.ts / util.ts / i18n.ts / icon-protocol.ts
    ui/               # 渲染 UI 框架
      App.vue         # 侧栏 + 搜索/快速启动 + app-bar + keep-alive 宿主 (provide cockpit:* 上下文)
      main.ts         # Vuetify 初始化 + renderer 日志转发
      color_schemes/  # 主题配色注册表: *.json + index.ts (buildThemeDefinitions/resolveSchemeId)
      animations.ts   # 页面切换过渡注册表 (PAGE_TRANSITIONS)
      components/     # GameIcon / AbilityIcon / BackgroundLayer / FuseLayer / TransformerModal / BackgroundTasksDialog / UiNode / LoadingBar
      components/BackgroundTaskViews/  # BtLogView (控制台) / BtResponseView (结构化响应)
      entry-actions.ts # 应用快速启动右键动作注入 (registerEntryActionProvider)
      icon.ts          # 统一图标语法解析 (parseIcon / fileIconUrl)
      transformer.ts   # 应用输出 transformer 运行时
      styles/          # global.css (主题配色由 color_schemes/ 提供)
      composables/     # search.ts (统一打分搜索) / download.ts / format.ts / useLoading.ts
      translations/   # 框架层翻译: zh.json / en-US.json / index.json
      i18n.ts         # translate/translateTemplate/localize/useI18n (合并各模块翻译)
  abilities/          # 所有能力 (自包含)
    index.ts          # 加载器: globs abilities/*/index.ts, 暴露列表 + settings 聚合
    types.ts          # Ability / AbilitySetting 契约
    <id>/             # 每个能力一个文件夹
      package.json    # 能力自己的依赖声明 (workspace 成员, 见 §2.2)
      index.ts        # 统筹加载: Ability 元数据
      View.vue        # 页面组件 (可省略 → 纯后端能力)
      commands.ts     # 主进程命令 CommandSpec[] (由 abilities-loader 自动注册)
      types.ts        # 该能力领域类型
      translations/   # 该能力自己的翻译: zh.json / en-US.json
      service.ts      # 主进程后端实现 (可选)
      jobs.ts         # registerJobHandler 命名作业 (任意能力可加)
      components/ / parser/ ...  # 能力内聚的其他模块
  background/         # 所有背景 (每种类型一个文件夹)
    index.ts          # 加载器: globs background/*/index.ts
    types.ts          # BackgroundDef
    <type>/           # index.ts (BackgroundDef) + View.vue
  preload/
    index.ts          # contextBridge → window.cockpit.*
    index.d.ts        # 类型声明
  shared/
    types.ts          # 仅框架契约 (LaunchResult / ProcOutputEvent / Bt*)
  main/ui/
    bt-views.ts       # 后台任务 View 注册表 (log 内置 / 能力可注册自定义)
    components/BackgroundTaskViews/  # BtLogView (控制台) / BtResponseView (结构化响应)
    windows/          # 子窗口视图注册表 (globs windows/*.vue → ?view=<key>, 如 LyricsWindow)
    composables/      # download.ts (本地下载经主进程命令) / format.ts / useLoading.ts
~/.config/LinuxCockpit/
  config.json           # 全局外壳配置（theme / uiScale / animations / window / runtime / sidebar.default）
  <ability-id>/
    config.json         # 各能力独立配置（镜像源列表、搜索目录等）
scripts/               # pkexec helper 脚本 + polkit 规则
```

## 9. 架构要点

### CLI-first

每个操作都是一个注册命令 (`<ability>.<command>`)。UI 按钮和 CLI REPL 共享同一个 handler，不存在只能从 UI 触发的操作。

- UI: `window.cockpit.command('mirror.toggle', { name, enable })`
- CLI: `mirror.toggle --name USTC --enable true`

### Ability 动态加载（自注入）

- 渲染端: `src/abilities/index.ts` 的 Vite `import.meta.glob` → `loadAbilityModules()` 拍平成 `Record<id, Ability>`；首次显示时 async `import()` 页面组件 (code-split)
- **自注入排序**：侧栏直接由能力元数据驱动，**不再读 yaml 顺序**——按 `category` 字母序分组、组内按 `name` 字母序排序（`App.vue` 用翻译后文本排序，`resolveSidebarAbilities` 也有 raw 兜底排序）
- **平台过滤**：`Ability` 可声明 `platforms?: string[]`（`process.platform` 值；**Termux / nodejs-mobile 里的值是 `'android'`**，无需另造 `android-termux`），未给/空 = 全平台可用；给了且不包含当前平台 → 侧栏过滤掉，并在日志中报告。`resolveSidebarAbilities(platform)` 返回 `{ loaded, ignoredPlatform, ignoredDependency, backendOnly }`，通过 `logs.post`（scope `abilities`）输出「加载了哪些 / 平台不符忽略了哪些 / 依赖缺失忽略了哪些 / 纯后端不进侧栏哪些」
- **能力依赖（能力辞典）**：`meta.ts` 可声明 `provides?: string[]`（本能力向系统提供的能力，如 `background` 提供 `['background-tasks']`）与 `dependencies?: string[]`（要求的能力，AIDJ/playground/apps 都 `dependencies: ['background-tasks']`）。依赖的是**能力名**而非 ability id——提供者改名/替换不影响依赖方。前后端加载器（`resolveSidebarAbilities` + `registerAbilityCommands`）按路径式可满足判定解析：要求的能力必须由某个平台合格且自身也可满足的能力提供。**环直接忽略**——这只是 cmd 依赖（命令注册顺序无关）不是初始化依赖，A↔B 互赖也照样注册。能力缺失/提供者被平台过滤/被移除 → 该能力命令不注册、侧栏不显示，并在日志中警告「missing capabilities」，删除提供者（如 `background`）会自动禁用所有建立在它上面的能力。主进程按**依赖序**注册（提供者先于依赖方，环成员兜底排最后）
- **一文件夹多 Ability**：`index.ts` 可 default-export `Ability | Ability[]`——一个能力注册多个侧栏条目（如 AIDJ 注册 `aidj` 主页面 + `aidj-lyrics` 歌词页），`id` 必须唯一
- 主进程: `src/main/process/abilities-loader.ts` 的 `import.meta.glob` 收集 `src/abilities/*/commands.ts` → `registerAll`，启动时按文件夹记录加载/失败清单
- 增删能力 = 增删 `src/abilities/<id>` 文件夹即可，无需改任何 yaml/注册表
- **构建期开关 `src/abilities/toggle.json`**（个人文件，已 gitignore）：`{ "campusinfo": false, "fnaf": false }`，缺省 = 启用；`"*": false` 把默认改成关闭，再用 `"id": true` 点名（白名单）。`electron.vite.config.ts` 的 `cockpit-ability-toggle` 插件给每个 `import.meta.glob('…/abilities/*/…')` 追加 `!…/abilities/<id>/**`，被关的能力**不进主进程/渲染端任何 bundle**，等于文件夹不存在——别人写到一半的能力（语法错误、缺依赖）不再拖垮你的构建。改完重启 dev / 重新构建；`settings` 不允许关；启动日志有 `abilities excluded at build time`。与运行时开关 `ability.set-enabled`（瞬态、不落盘）互补：这个是构建期、落盘。
- **依赖声明 = `package.json`**：每个 ability 文件夹是 pnpm workspace 成员，专属 npm 依赖写进自己的 `package.json`（见 §2.2），根目录 `pnpm install` 一键安装全部，主进程构建时自动内联进 `out/main`

### 图标

图标统一走 `AbilityIcon.vue` → `parseIcon`（`src/main/ui/icon.ts`）解析，来源优先级：

- `gi:<name>` — 侧栏 curated SVG（`src/main/ui/assets/icons/<name>.svg`，随仓库内建）
- `default/<name>[/padding]` — game-icon-pack SVG（`assets/game-icon-pack/svg/`），通过 `GameIcon.vue` 渲染 (`fill="currentColor"` 跟随主题色)
- `emoji/<emoji>` / 裸 emoji / `auto` — emoji 兜底
- `file/<path>` / 绝对路径 — 本地图片（经 `cockpit-icon://` 协议）

ability 的 `icon` 字段用 `gi:<name>` 前缀指定 curated SVG，找不到时回落 game-icon-pack，再不行才用 emoji。

> **新增/改动能力图标：一律用单色 SVG（`gi:<name>` 或 `default/<name>/padding`），不要用 emoji。** 侧栏其余图标都是跟随主题色的单色 SVG，彩色 emoji 会在侧栏里格外突兀（曾因此被打回）。先 `find src/main/ui/assets/game-icon-pack/svg/padding -iname '*关键词*'` 确认文件存在，再写进 `icon`；写完看一眼侧栏效果，别只信 typecheck。

### 快捷键（注入式，`src/main/ui/shortcuts.ts`）

与 `settings` 同构：能力在 `index.ts` 里声明 `shortcuts: [{ key, label }]`（完整 id = `<能力id>.<key>`，label 走 `label.<原文>` 翻译），`App.vue` 汇总进注册表；页面里用 `useShortcut('<id>.<key>', handler)`（`@ui/shortcuts`，页面可见才生效）。外壳自己的用 `registerShortcut({ ..., group: 'shell' })`（如截图模式）。设置 → 快捷键（`ShortcutsSection.vue`）按能力分组管理：改键 / 清除 / 冲突标红 / 整组禁用 / 搜索（名称、能力、id、按键）。**所有快捷键默认都不绑定**（防止互相冲突，没有 defaultKey 这回事），用户自己启用。绑定存 `config.json` 的 `shortcuts`（`{ id: 'Ctrl+Shift+S' }`），整组禁用存 `shortcutGroupsOff`（组 id 数组）。默认仅窗口有焦点时生效；每项可单独开「全局」（`config.json` 的 `shortcutGlobal` id 数组，需至少两个修饰键，主进程 `global-shortcuts.ts` 用 `globalShortcut` 注册，Wayland 下启用 `GlobalShortcutsPortal` 走 xdg portal，注册结果显示在设置页；声明里的 `command` 让没有页面处理函数时也能触发），组合键必须带修饰键（F1–F12 除外），AI 视图里不响应。

### 帮助系统（`help/`）

每个能力可选自带 `help/` 目录；外壳侧栏底部「后台任务 / 复制页面」之后的固定「?」按钮打开**当前能力**的帮助浮窗：

- **语言目录**：正文都放在语言目录下，如 `help/zh-cn/main.md`、`help/en-us/Platforms/Overview.md`。目录名大小写不敏感，按语言族归一化到 `zh-cn` / `en-us`（框架语言码是 `zh` / `en-US`）。回退链：请求语言 → **根目录**（不在语言目录下的语言中立基准）→ `zh-cn` → 任意已有语言，保证有内容就显示得出来。语言目录**整树替换**，文件夹名也可本地化（`平台类型/` ↔ `Platforms/`），不做逐文件合并——否则两种语言目录名不同会产生重复的树。
- **结构即目录**：`help/<lang>/main.md` 是根页面，语言目录下任意 `*.md` 都是帮助页；子目录在浮窗左侧变成分组（`help/en-us/Video/guide.md` → `Video` 分组），支持任意层级。页面标题取文件第一个 `# 标题`，没有则回退文件名。
- **相互跳转**：正文里相对 `*.md` 链接在浮窗内跳转，`#锚点` 滚动，外部链接交给系统浏览器。
- **后端命令**（能力 `src/abilities/help/`）：`help.tree --ability <文件夹id> [--lang <语言>]` 返回导航树 + 根页面，`help.read --ability <id> --path <相对路径> [--lang <语言>]` 返回 Markdown 原文。`App.vue` 传当前界面语言，浮窗内换语言会自动重取树与正文。Markdown 以 `?raw` 在构建期内联进 `out/main`，打包后无需磁盘文件。
- **命名空间是能力文件夹 id**（多 Ability 文件夹如 aidj 共享同一份 help）；前端用 `SidebarAbilityMeta.folder` 传入，不要用 ability id。
- 没有 `help/` 的能力点按钮只弹「暂无使用帮助」提示，不影响其他功能。
- **渲染**：markdown-it（`html:false` → 原始 HTML 一律转义）+ markdown-it-anchor + 按需加载的 highlight.js；配色全部取 `--v-theme-*`，跟随 10 套主题。
- 浮窗导航项必须 `:title` + `:aria-label` 暴露无障碍名，否则 inspector / AI 拿不到 ref（图标按钮同理，见上文「UI 写法要求」）。

### 主题 / 配色方案

- 每个配色方案是一个独立 JSON（`src/main/ui/color_schemes/*.json`），`color_schemes/index.ts` glob 注册并构建 Vuetify `ThemeDefinition`（`buildThemeDefinitions`）。
- 内置 10 个：`dark` / `light` / `pureblack` / `moonlight` / `forest` / `aurora` / `rosy` / `sepia` / `slate` + `system`（跟随系统亮暗）。
- `config.json` 的 `theme` 存方案 id；未知 id 一律回落 `DEFAULT_SCHEME_ID`（`dark`），不会弄坏 UI。
- 主题切换：开启「现代动效」时用 View Transitions API 做波纹揭示，扩散起点由 `animations.themeTransition` 决定（`corner`=左上角、`cursor`=鼠标处，见 `App.vue` 的 `applyTheme` 与 `global.css` 的 `--vt-origin-*`），关闭则即时切换。`<html>` 加 `motion-off` 类可全局关闭所有 CSS 过渡。
- ft 等画布类渲染端的配色跟随当前主题（读取 `--v-theme-*` CSS 变量），不是硬编码 hex。

### 隐私 SDK（AI / 远程访问的数据边界）

设计见 `docs/agent-access-design.md`。用法和 `encrypt.ts` 一样：**能力在产生数据的地方自己 wrap**。

- **调用来源**：`withOrigin` 经 AsyncLocalStorage 贯穿调用链。IPC = `ui`、CLI = `cli`；agent（`remote` / `mcp` / `script-agent` / `agent-ui`）由各自入口打标。渲染端只能把自己降权成 `agent-ui`，不能提权。**非 agent 来源下所有 API 原样透传**。
- **声明 scope**：`src/abilities/<id>/privacy.ts` 里 `definePrivacyScopes('<id>', { … })`（loader 自动 glob）。级别：`personal`（不能关联到真人，默认对 AI 可见）/ `sensitive`（能关联到真人、或涉及金钱 / 位置，默认脱敏、可申请）/ `secret`（凭据，永不可读）。翻译键放本能力 translations。
- **主进程**：`shield(scope, v)` / `shieldFields(obj, resolver)` 脱敏，`secret(v)` 凭据占位，`await guard(scope)` 动作前要求许可（弹授权窗口并等待）。
- **命令声明** `CommandSpec.privacy`：`reads`（结果含哪些 scope）/ `requires`（agent 调用前需要的许可，如 `SCOPE_EXEC` / `SCOPE_CONTROL`）/ `agent: 'deny'`（凭据登录、修改账号等只能用户本人做）。未声明的命令 agent 也能调，但结果会再过一遍凭据 key 兜底脱敏。
  - `system.exec`：**调用方决定执行什么**（任意命令行 / 代码 / 任意路径写文件）；`system.control`：行为固定但改变系统状态。能力内部用固定参数调外部程序不算 exec。
- **渲染端**：`v-privacy="'<scope>'"` 给子树打标签（AI 快照 / 截图按标签脱敏，**与用户是否点开明文无关**）；`v-agent-forbidden` 标禁区（凭据输入框、授权相关设置）；打码文本用 `@ui/components/PrivacyText.vue`。
- **授权窗口**（`privacy-consent.ts` + `windows/PrivacyConsent.vue`）：窗口 id / view 保留，渲染端无法创建或替换；决定只走 `privacy:decide` IPC 并校验 sender。**绝不能把「批准」做成命令**。开发模式可用 `privacy.debug-request --scopes <id> --reason ...` 手动弹出测试。
- 新增 / 改动涉及个人数据的能力：先按上面的标准定级，再在命令和界面两侧同时接入。

### AI 与远程（Remote / MCP / UI inspector）

- **默认关闭**。设置 →「AI 与远程」开启（`config.json` 的 `agent.mcp` / `agent.remote`），或只对本次运行：`pnpm dev -- --with-mcp --with-remote`（注意 `--`；也可用环境变量 `COCKPIT_WITH=mcp,remote`）。已运行时再执行带参数的命令会经 second-instance 转交。
- **MCP**：`http://127.0.0.1:47802/mcp`（Streamable HTTP），`Authorization: Bearer <~/.config/LinuxCockpit/agent/token>`。设置页「复制 Claude Code 接入命令」；只支持 stdio 的客户端用 `node scripts/cockpit-mcp.mjs`。
- **Remote**：`POST http://127.0.0.1:47801/rpc`，JSON-RPC 2.0，方法名与 MCP 工具相同（`tools/list` 列出）。
- **谁在操作**：标题栏中间的 `AgentBar.vue` 显示每个在线会话的头像（忙碌 = 4 秒内有调用，悬停看名称 / 当前页 / 状态 / 最近工具，放不下收成「+N」），`AgentActivityOverlay.vue` 在 agent 调用时给窗口描边并渐隐。agent 可调 `set_status`（`text` ≤120 字、可选 `progress` 0–100，2 分钟过期）告诉用户在忙什么；头像用 MCP initialize 请求的 `X-Cockpit-Avatar` 头（Remote 每次请求都可带）或 `clientInfo.icons`，**只收 ≤24KB 的 `data:image/png|jpeg|webp|svg+xml;base64`**，不抓远程 URL，没有则用首字母色块。
- **AI 指示配置** `config.json` 的 `agent.ui`（设置 →「AI 与远程」→「AI 指示」；放在 `agent.*` 下，所以 AI 自己改不了）：`showBar`（图标条，默认开）/ `outline`（全窗口描边，默认开）/ `busyTimeoutSec`（**Agent 过期时间**，距上次调用多久内算正在操作，描边也按它渐隐，默认 60，范围 3–600）/ `statusTtlSec`（`set_status` 文字有效期，默认 120）/ `hideIdleAfterMin`（空闲多久从图标条隐藏，0 = 不隐藏）/ `tooltipDetail`（悬停显示页面 / 状态 / 最近工具）/ `allowAvatar`（接受 agent 自带头像）/ `defaultIcon`（`icon` 随机动物图标 | `initial` 首字母）。取值统一经 `src/main/ui/composables/agentUi.ts` 的 `resolveAgentUi` 归一化 + 夹紧，渲染端不要直接读原始值。默认图标池在 `sessions.ts` 的 `AGENT_ICONS`（16 个 mdi 扁平图标，随机取未被占用的，同名客户端重连尽量拿回同一个）。
- **Agent 独立视图**（`src/main/process/agent/views.ts`）：每个 agent 会话有自己的渲染进程（同一个 App，`?agent=<会话>&name=<客户端>`，`WebContentsView`），`ui.*` / `overview` 按调用来源的会话路由到它（`inspector.ts` 的 `mainContents()` + `registerPreRunHook('ui.')` 提前建好并等加载），**用户自己的界面不受影响**。`agent.ui.isolateView=false` 回到旧行为（agent 直接操作主窗口）。要点：
  - **后台 = 1×1 宿主窗口里的完整尺寸视图**。必须是 map 着的窗口：实测从没显示 / hide / 最小化的窗口 rAF 只有 0–2 fps（Wayland 没有 map 的 surface 拿不到帧回调，Wayland 也没有「最小化」状态通知，`isMinimized()` 不可信），游戏会冻住；1×1 透明窗口下是稳定 60 fps。代价：KDE 任务栏里会有一个无可见内容的「AI 视图 · 名字」条目（Wayland 下 `skipTaskbar` 无效）。
  - **follow**：点标题栏头像 → `agent.follow`（仅用户，`agent: 'deny'`）。默认 `inplace`：把视图搬到主窗口上盖满整个窗口（视图里的 App 自带无边框外壳 + 「返回我的界面」，主窗口尺寸变化时视图跟着）；`agent.ui.followMode = 'window'` 则把宿主放大成单独窗口。同一时刻只有一个视图盖在主窗口上；`agent.unfollow` / 视图里的返回按钮回到后台。follow 时才出声，后台静音。**用户和 AI 操作的是同一个视图，会互相影响**（没有只读锁）。
  - 视图里的窗口按钮 / 返回按钮是 AI 禁区（`v-agent-forbidden`），按钮走 `agent-view:control` IPC（只接受 agent 视图的 sender），因为视图发出的命令都是 `agent-ui` 来源、调不了用户专属命令。
  - **隐私**：该 webContents 发出的 IPC 按 sender 一律打 `agent-ui`（`originOfSender`），不再靠「点击后 3 秒」的时间窗口。
  - 视图不在 `BrowserWindow.getAllWindows()` 里：广播要带上 `allAgentViewContents()`（`index.ts` 的 `broadcast` 已处理）；窗口按钮 IPC 用 `windowOfSender`。
  - 会话结束销毁视图；后台空闲 15 分钟也销毁（一整份 App 几百 MB）。`inspector.ts` 的 `refMap` / 鼠标状态按 webContents 各一份（`vs()`）。
- **独占 SDK**（`src/main/process/exclusive.ts`，设计见 `docs/exclusive-and-script-design.md`）：有状态资源（模拟器 / 存档）同一时刻只能有一个拥有者。能力用 `defineExclusiveScopes` 声明范围，写类命令在 `CommandSpec.exclusive` 里声明 `{ scope, key }`，命令注册表执行前自动获取 / 续期租约；**用户永远优先**（用户来源遇到 AI 的租约 = 直接接管，旧 AI 下一次调用收到 `lease_lost`），AI 对被占用资源立即失败（`exclusive_busy`，带占用者信息，不排队不抢）；每个租约有单调递增的 `epoch`，写盘处要 `assertFence`（或像掌机那样让写盘命令本身也声明 `exclusive`，按来源获取租约）。租约只在内存，会话结束 / 空闲超时（`agent.exclusive.idleMin`，默认 5 分钟）/ 主动释放会释放。命令 `exclusive.list / release / take-over`（接管仅用户）；外壳在页面顶部显示「被 AI 占用 · 接管」窄条（`ExclusiveBanner.vue`），AI 视图里的接管走 `agent-view:control('take-over')` 专用通道。新增有状态、不能并发的能力时先想：它的「拥有者」是谁？
- **`command_script`**（MCP / Remote 工具，`agent/script.ts` + `script-sandbox.ts`）：AI 提交一段 async 函数体，在 **QuickJS（wasm）** 沙箱里一次执行多步操作，只往返一次。沙箱里只有 `cockpit.command / sleep / log / show` 与 `args`，没有 process / require / fetch；每个命令仍走命令注册表，隐私 / 授权 / 独占照常生效。图片 base64 不进 VM（换成 `$imageRef` 句柄，`cockpit.show` 才附到返回里）。限额在 `config.json` 的 `agent.script`（`enabled / maxCalls / cpuMs / wallSec / memoryMB`，AI 改不了，入参只能调小），作为「AI 脚本」后台任务运行，面板可停止；同一会话同时只允许一个脚本。**QuickJS 句柄纪律**：`ctx.setProp(target, key, handle)` 不消费 handle，不要 `.dup()` 之后丢掉（会泄漏，运行时释放断言 `list_empty(gc_obj_list)` 失败）；`newFunction` 的返回值才需要 `.dup()`（回调 scope 会释放它）。
- **标题栏是拖拽区**（无边框窗口 `-webkit-app-region: drag`）会吞掉真实鼠标的悬停 / 滚轮，放进标题栏的可交互元素必须 `-webkit-app-region: no-drag`；CDP 合成事件绕过拖拽区，**这类问题只能用真实鼠标验证**。
- 两者共用 `src/main/process/agent/tools.ts` 的工具表，执行都走命令注册表 → 隐私 SDK 自动生效。只监听 127.0.0.1，校验 Host、拒绝带 Origin 的浏览器请求。
- **UI inspector**（`src/main/process/inspector.ts`，命令 `ui.*`）：CDP 无障碍树快照（`[ref=eN]`、可滚动位置、纯图标按钮的图标提示、`<canvas>` 也给 ref；`--boxes true` 附上每个 ref 在截图上的位置）、截图（隐私区遮盖）。两种操作方式：按 ref（`ui.click` / `ui.type`），或像人一样按**截图像素坐标**（`ui.click-at` / `ui.move` / `ui.mouse down|up` / `ui.drag` / `ui.scroll --x --y`），键盘支持字母 / 数字 / F 键、`--hold` 按住、`--action down|up`、组合键（游戏可加 `--settle false` 跳过等待）。实时游戏用 `ui.input-timeline`（MCP `ui_input_timeline`）：一次提交按毫秒偏移的键盘 / 鼠标 / 截帧事件（可交错、长按、平滑移动），主进程精确派发、中途不往返，结束或出错自动松开仍按着的键；开始前完整隐私检查，中途落到未授权区域直接中止。按坐标操作前先做命中测试：落在隐私区要授权、禁区拒绝，规则与 ref 操作一致；AI 每次点击在屏幕上闪一个标记。每次操作前等页面就绪（App 的 `data-ability-ready`：异步页面组件加载、挂载完成）与稳定（无进行中命令 + DOM 300ms 无变化）。
- **UI 写法要求**：纯图标按钮给 `aria-label` 或 `title`，否则 AI 只能看到图标名；揭示隐私的按钮（「全部显示」等）加 `v-privacy-action="'<scope>'"`。
- 开发调试：`privacy.debug-as-agent --cmd ui.snapshot`（dev only）以 AI 身份执行任意命令，查看 AI 视角。
- **元数据不许骗人**（AI 使用反馈的教训）：
  - 带 `enabled` 门控的命令必须写 `unavailableReason`（说明需要什么模式、怎么切换）——门控关闭时 dispatch 抛 `CommandUnavailableError`「命令 X 当前不可用: <原因>」（agent 侧 `code: command_unavailable`），`commands_list` 标 `available` / `unavailable_reason`；不再冒充「未知命令」。
  - UI 流程（斜杠命令、按钮）若组合调用多条命令 / 作业，在相关 `CommandSpec` 上写 `ui`（UI 入口）与 `related`（相关命令，作业写 `job:<name>`），让 agent 能从界面叫法找到命令，反之亦然。同名的命令和作业（如 `aidj.chat`）尤其要在 description 里讲清区别。
  - 命令结果里出现 `«redacted:…»` 时，网关自动附上结构化 `privacy` 说明（MCP 为首段文本、Remote 为 `_privacy`）：被脱敏的 scope、其中**授权已过期**的、可申请的。`request_clearance` 的结果带 `grants[].expiresAt`，`privacy_scopes` 带 `expires_in_s`。产生占位符的新代码要走 `shield` / `shieldFields` / `secret`，或手动 `noteRedaction(scope)`，否则这份说明会漏。
  - `ability.describe --id <能力>`（`--format md` 出 Markdown）由注册表自动生成能力清单：命令（含可用性）、后台作业、UI 入口、help 页面。

### 无头宿主 / 网页模式 / Termux（`src/headless/`）

不依赖 Electron 的运行形态：纯 Node 宿主 + 浏览器当客户端（桌面浏览器、手机浏览器均可）。核心（命令注册表、后台任务、日志、能力加载）与 Electron 版是**同一份代码**。

- **构建 / 运行**：`pnpm dev:web`（构建并启动，打印带 token 的网址，默认 `127.0.0.1:47810`；`node out/headless/index.js --host 0.0.0.0 --port N --web <dir>`）。`pnpm build:headless --only aidj,apps,…` 只构建指定能力（框架级 settings / background / help / privacy / agent / inspector / cli / logs 总会保留；复用构建期开关，环境变量 `COCKPIT_ABILITY_TOGGLE` 同 `toggle.json` 格式），完整构建约 24s（32 线程桌面机），只带 4 个能力约 7s，手机上自己构建时强烈建议用它。`pnpm pack:headless` 生成 `out/cockpit-headless.tgz`（headless + web + 只含运行时依赖的 package.json，`dbus-next` / `esbuild` 为可选依赖），手机上 `tar xzf … && npm install --omit=dev && node headless/index.js`，不需要装 electron / vite 整套工具链。构建脚本 `scripts/build-headless.mjs` 复用 `electron.vite.config.ts` 的插件 / alias / define。
- **`electron` 替身**（`electron-stub.ts`，构建期 alias）：不支持的窗口 / 对话框 / 全局快捷键等一律 nop（属性访问返回 nop，调用返回 undefined），27 个 `import 'electron'` 的文件无需改动；会被消费返回值的成员（`BrowserWindow.getAllWindows` → `[]`、`net.fetch` 含 `file://`、`safeStorage` 不可用、`app.getPath` 等）显式实现。`protocol.handle` 的回调被记下。
- **传输**（`server.ts`）：`POST /api/command`、`POST /api/cli`、`GET /api/commands`、`GET /api/info`、SSE `GET /api/events`（= `broadcast`）、`/_p/<cockpit-icon|audio|tile>/…`（把替身记下的协议处理器暴露成 HTTP，支持 Range）。除静态页面外一律要 token（`Authorization: Bearer` / `?token=` / `cockpit_token` Cookie），token 在 `~/.config/LinuxCockpit/headless-token`；命令结果里的 `cockpit-*://` 自动改写成 `/_p/`。**默认只监听 127.0.0.1**，明文 HTTP，不要暴露到公网。
- **共用 `window.cockpit`**：`src/preload/api.ts` 的 `createCockpit(transport)` 同时被 Electron preload（ipcRenderer）和网页 shim（`src/headless/web-shim.ts`，fetch + SSE）使用。渲染端手拼自定义协议 URL 必须包 `window.cockpit.hostUrl(...)`（Electron 下原样返回）。
- **宿主能力档位（caps）**：shim 声明 `native | web | none`；`window.cockpit.hasCap(id)` / `cap(id)`，未声明视为 `native`。现有 id：`window.frame` / `window.child` / `file.pick` / `file.save` / `clipboard` / `external` / `shortcut.global` / `screenshot` / `privacy.consent` / `host.wallpaper`。**UI 里凡是依赖宿主窗口 / 桌面的控件，用 `hasCap` 隐藏或降级，不要自己判断是不是 Electron**；背景预设用 `BackgroundDef.requires`。`none` 的通道由 shim nop（返回 null / false），不抛错。后端命令级的可用性仍走 `platforms` / `provides` / `dependencies`。
- **广播**：大量代码用 `for (const win of BrowserWindow.getAllWindows()) win.webContents.send(...)` 广播（`config-changed` 等）。替身的 `getAllWindows()` 返回一个**虚拟窗口**，其 `webContents.send` 直接推给所有 SSE 客户端；返回空数组会让主题 / 字体 / 缩放在网页里要刷新才生效。
- **外壳高度（`--app-vh`）**：网页模式下由 `src/main/ui/viewport.ts` 用 JS 量（`visualViewport.height − env(safe-area-inset-bottom)`，再除以根元素 CSS zoom），`<html>` 加 `.vh-js` 后 html/body/#app/`.v-application__wrap` 都取它——手机浏览器上 CSS 的 `100dvh` 可能比真正可见的区域高，外壳又锁在视口里，会让底部内容滚不到。键盘弹出时外壳随之缩小。Electron 保持 CSS 默认（`100dvh`）。每次变化会写一条 `[viewport]` warn 日志（innerHeight / visualViewport / dvh / svh / lvh / 安全区 / zoom），真机排查时直接看主机日志即可。
- **页面缩放**：Electron 用 `webFrame.setZoomFactor`，网页 shim 用 CSS `zoom`，并把 `--app-vh` 改成 `calc(100dvh / 倍数)`（CSS zoom 不改变视口的 CSS 尺寸）。根元素 CSS zoom 下 **`::view-transition-*` 遮罩里写的像素会被再乘一次倍数**（实测 zoom 1.5 时写 600,400 渲染在 900,600），所以主题扩散的起点（`App.vue` `applyTheme`）要除以 `getComputedStyle(html).zoom`；Electron 真缩放时该值为 1。起点用 `pointermove` + `pointerdown(capture)` 记录（触屏点按没有 pointermove）。
- **文件选择**：网页里 `pickFile` / `pickSaveFile` 弹 `HostFilePicker.vue`，经 `host.fs.list`（仅无头注册，`agent: 'deny'`）浏览**宿主**文件系统，因为浏览器拿不到宿主绝对路径。另有「从此设备选择」（仅选文件）：浏览器的文件选择 API 只给内容不给路径，所以 `POST /api/upload?name=` 把文件流式存进 `~/.config/LinuxCockpit/uploads/<随机>-<文件名>`（0600、≤4GiB、文件名消毒），再把宿主路径当作选择结果返回；上传目录目前不会自动清理。
- **密钥库**：`master.json` 若由 `safeStorage`（系统钥匙环）包裹，无头宿主解不开。在 Electron 里执行一次 `vault.rewrap-scrypt` 改包成 scrypt（机器指纹派生，**保护强度降低**，原文件备份 `master.json.bak-*`），两边即可共用；`vault.status` 查看。换机器（如手机 Termux 本机跑宿主）解不开，密钥需重填。
- **Termux 安装**：Electron 没有 android 构建，其 `postinstall` 会让 `pnpm install` 失败。仓库用 `patches/electron.patch`（`pnpm-workspace.yaml` 的 `patchedDependencies`）让 `install.js` 在 `process.platform === 'android'` 时直接跳过下载，锁文件在所有平台一致（`--frozen-lockfile` 可用）。此时只能用无头模式。**不要**用 `.pnpmfile.cjs` 的 `readPackage` 按平台删依赖：会改写锁文件并让 `--frozen-lockfile` 报 `pnpmfileChecksum` 不匹配。`pnpm-workspace.yaml` 的 `overrides: yauzl: ^3.0.0` 也不能删：`extract-zip@2`（electron 的 postinstall 解压用它）依赖的 `yauzl@2` 在 **Node 26 上会静默失败**（Promise 永不 resolve、进程以 0 退出、`dist` 只解出一个文件，运行时报 `Error: Electron uninstall`）。补丁会让 electron 换一个虚拟仓库目录而重新执行 postinstall，所以升级 / 打补丁后遇到这个错误先查这里（手动恢复：把旧目录的 `dist`、`path.txt` 拷过来）。升级 electron 版本后要重做补丁（`pnpm patch electron` → 改 `install.js` → `pnpm patch-commit`），并留意锁文件里 git 依赖（hustcore）被顺带重新解析的无关改动。
- **平台**：Termux 的 `process.platform` 是 `'android'`。`platforms: ['linux']` 的能力（mirror / display / dashboard / systemd / autostart）在 Termux 自动排除；其余没写 `platforms` 的默认可用。要给某个 Linux 专属能力开放 Termux，把 `'android'` 加进它的 `platforms` 之前先在真机验证（`/proc` 在 Android 上受限）。
- **移动端外壳**：`index.html` 带 viewport meta（**不要加 `viewport-fit=cover`**：它让页面延伸到 Android 手势条下面，而应用没有给底部留安全区，滚动到底的内容会被盖住；本项目没有用 `env(safe-area-inset-*)`）；网页里 `html` 背景色跟随主题（根画布默认白色，Electron 透明窗口除外）；`App.vue` 按 `sidebar.mode`（设置 → 侧边栏）决定侧栏形态——弹出式（`temporary` 抽屉，永远展开显示搜索与分组）由 App bar 左上角汉堡按钮打开，选完自动关闭；窄屏（`matchMedia ≤720px`）容器 padding 收成 `pa-2`。**只做了外壳**：各能力页面要按容器宽度自己适配（见 §11.8），尚未逐页检查。
- **计划与优先级**：`docs/headless-web-plan.md`（当前：移动端适配 + Web / GUI 稳定）。
- **窄屏 / 触屏样式约定**（手机浏览器是一等公民，改 UI 时对照）：
  - 窄屏断点用 `@media (max-width: 720px)`（≈ 弹出式侧栏切换点，页面容器宽度 ≈ 窗口宽度）；**桌面外观与行为必须不变**，新样式只在窄屏 / 触屏生效。触屏专属用 `(pointer: coarse)` / `(hover: none)`。
  - 视口尺寸一律 `var(--app-vh)` / `var(--app-vw)`，不要写 `100vh` / `100vw`（手机上不可信；网页版 CSS zoom 下 vw/vh 也不会除以倍数）。
  - **Vuetify 工具类（`.flex-wrap` / `.flex-nowrap` / `.justify-center` …）都带 `!important`**：窄屏要覆盖它们，规则也必须 `!important`（靠 scoped 属性选择器的特异性取胜），否则「看起来写了、实际没生效」。
  - 居中列里「宽度由内容决定」的盒子，子元素别写 `width: 100%` / `min(…, 100%)`（循环依赖，会被解成很小的值——播放器封面曾因此变成细长药丸）；先让父盒子 `width: 100%`。
  - 触屏没有悬停 / 右键 / HTML5 拖拽：关键信息别只放 tooltip；右键菜单补长按（`@ui/directives/long-press`（`src/main/ui/directives/long-press.ts`），只在粗指针设备上写 `user-select:none`）；拖拽排序补上下移按钮。点按之后浏览器会补发合成的 `mousemove` / `click`，手势逻辑要在 `pointerdown` 那一刻记录状态，并忽略触屏产生的合成 click。
  - **滑块防误触**（`src/main/ui/touch-guard.ts`，`main.ts` 全局安装）：触控输入下 `v-slider` / `v-range-slider` 只接受按住圆点拖动，点轨道不跳值（划页面时擦到也不会改值）；按每次输入判断（`touchstart` / 触控补发的 `mousedown`），鼠标点轨道照旧。圆点触摸热区在 `(pointer: coarse)` 下放大到 48px。自己写的进度条 / 拖动条也要遵守：触控时只认拖动手柄，不要「点哪跳哪」。
  - 自定义玻璃面板（半透明底 + `backdrop-filter`）的背景透明度写 `rgba(var(--v-theme-…), var(--glass-a, 原值))`；「模糊效果」关闭时 `html.no-blur` 把 `--glass-a` 拉到 0.94，并统一关掉 `backdrop-filter`。Vuetify 叠层（对话框 / 菜单 / 底部弹层）由 `global.css` 的通用规则处理。
  - `.page-menu-pop`（aidj 页面菜单 / 播放器菜单 / yarj 菜单共用类名）、`.v-dialog` 的宽度 / 高度夹取都在 `global.css` 里统一处理，别在组件里各写各的。
  - 网页静态资源带 `COOP: same-origin` + `COEP: credentialless`（掌机 mGBA 要 `SharedArrayBuffer`；需要安全上下文：https 或 localhost）。
  - 验证别只信静态检查：下游（opencode）看不到真实界面，它写的窄屏覆盖有过「没带 !important 实际没生效」「把封面挤成药丸」这类缺陷，合并后必须在 400px / 650px 宽度下截图看。
- **没做 / 已知缺口**：agent 系统（MCP / Remote / ui inspector / 隐私授权窗口 / agent 独立视图）未接入无头入口；缩略图（`nativeImage`）在网页模式下退回原图；Termux 真机未验证。

### 镜像源 toggle 安全性

- `toggleMirror` 只修改目标 Server 行的 `# ` 注释前缀，其余行原样保留
- 写入用临时文件 + `mv` 原子替换 (write-mirrorlist.sh)
- pkexec 拒绝 / 任何错误 → 原文件不受影响
- 所有 toggle 通过 Promise 链串行化，防止快速点击导致 IO 竞态

### UI 缩放

通过 Electron `webFrame.setZoomFactor()` 实现真正的等比缩放 (不是只改 rem)。
设置页滑块拖动时只更新数值，松手 (`@end`) 才应用缩放 + 持久化。

### 日志系统

- 基础设施 `src/main/process/logger.ts`：winston + winston-daily-rotate-file，写入 `~/.config/LinuxCockpit/logs/cockpit-YYYY-MM-DD.log`（按天轮转、10MB 上限、14 天保留、.gz 归档），同时维护当前会话的内存环形缓冲（20000 条）+ 向所有窗口广播 `cockpit:log` 事件。
- 模块获取 scoped logger：`const log = makeLogger('<scope>')`，然后 `log.info/warn/error/debug(msg, data?)`。新代码应使用它而不是裸 `console.log`。
- Logs ability（`src/abilities/logs/`）提供 UI：虚拟滚动逐行展示、按级别过滤、滑动窗口向后翻页、实时尾部、导出当前会话（`logs.query` / `logs.export` / `logs.post`）。
- 渲染端 `main.ts` 会把 `console.warn/error` 与未捕获错误通过 `logs.post` 转发进主进程日志。

### 后台任务框架

架构级设施（`src/main/process/background-tasks.ts`，与 logger 同级），**不绑定任何能力**。任何模块都能开一个跨页面存活的长跑作业，全局面板（`BackgroundTasksDialog.vue`）统一展示与交互。

- 两类任务：
  - **进程任务** `startProcessTask({ name, description, argv, cwd, env, view? })` — 真实子进程，piped stdio 环形缓冲，资源统计（CPU/内存经跨平台的 `pidusage`，GPU 显存经 nvidia-smi，缺失时降级留空），支持 stdin 写入与信号（SIGINT 等）。apps 的 `exec.background: true` 就是走这条路。
  - **作业任务** `startJobTask({ name, description, onCancel, view? })` — 无进程的抽象长跑操作，返回 `JobControl`（`pushLine` / `push` / `setProgress` / `finish` / `setCancel`）。适用于下载、转换等"前端发起、后端执行"的工作。
- **命名作业**：`registerJobHandler(name, handler)` 注册后端函数，前端经 `background.job --name <handler> --args <json>`（或 preload `btJob`）触发。handler 在后台运行（fire-and-forget，不阻塞 IPC），任务自动随 resolve/reject 标记 `exited`/`error`。
  - **⚠️ IPC 参数必须是可克隆的普通对象**：Electron 的 structured clone 无法序列化 Vue reactive proxy（会抛 `An object could not be cloned.`）。渲染端调用 `btJob`/`command` 传参前，**只要参数来自 `ref`/`computed` 的取值（数组/对象），必须先深拷贝**：`JSON.parse(JSON.stringify(data))`。尤其注意嵌套在消息里的 `playlist`/`songs` 等数组字段——`{ name, path }` 单层手动展开不一定够，统一用 JSON 深拷贝最稳妥。
- **可定制 View**：任务带 `view` id，全局面板按 `view` 渲染详情区（`src/main/ui/bt-views.ts` 注册表）。`log`（默认控制台 + stdin 输入）内置；任意能力可 `registerBtView('custom', factory)` 注册自定义展示（如结构化 response 视图）。**终止/移除等生命周期按钮属于面板，不属于 view**。
- **消息类型**：输出不仅是文本行——`JobControl.push({ line | data, label?, encoding?, mime?, progress? })` 支持结构化数据与 base64 二进制。`BtOutputMessage` 的 `line` 渲染为控制台行，`data` 由 view 按需渲染。
- 广播：`cockpit:bt` 事件（`changed` 全量列表 / `output` **实时消息** / `exit`）。**输出（日志/结构化消息）实时推送**——同一次同步突发经 `queueMicrotask` 合并为一次 IPC，跨 tick 立即送达，无人工延迟；**状态（`changed`/进度）100ms 节流合并**，避免高频 `setProgress` 打爆 IPC。渲染端侧栏按钮徽标只计运行中任务（上限 `99+`）。
- 生命周期：任务**依附于本程序**，退出时 `will-quit` 统一 SIGKILL，不留孤儿；退出前若有运行中任务，主进程拦截 `close` 广播 `cockpit:confirm-quit`，渲染端弹确认（可"以后不再提醒"，localStorage `cockpit-bt-quit-suppress`）。
- 命令：`background.list/output/start/job/input/signal/stop/kill/remove/clear-finished/clear-output`。

#### 写一个 Task（作业样板）

`registerJobHandler` 的 handler 就是一段普通 async 协程——`while` + `await` 即协程式循环，`setProgress`/`pushLine` 更新状态，无需任何模板类：

```ts
// src/abilities/<id>/jobs.ts —— 任意能力都能加，如：把一批文件下载到本地
import { registerJobHandler, type JobControl } from '../../main/process/background-tasks'

registerJobHandler('download-batch', async (control: JobControl, args: Record<string, unknown>) => {
  const { base, files, outDir } = args as { base: string; files: string[]; outDir: string }
  const ac = new AbortController()
  control.setCancel(() => ac.abort()) // 面板「停止」→ abort

  for (let i = 0; i < files.length; i++) {
    if (ac.signal.aborted) {
      control.finish('cancelled')
      return
    }
    control.pushLine(`[${i + 1}/${files.length}] 下载 ${files[i]}`)
    control.setProgress(Math.round(((i + 1) / files.length) * 100))
    await someAsyncWork(base, files[i], { signal: ac.signal }) // yield
  }
  control.finish('exited') // resolve → 自动 exited（可省）
})
```

- **协程式**：`await` 就是 yield，`while`/`for` 就是循环，和普通长任务写法无差别。
- **取消**：`setCancel` 注册 abort 回调，循环内检查 `ac.signal.aborted`（精确中断；若想零样板可只 `while(true)`，停止时靠抛异常中断，但粒度较粗，不推荐）。
- **自动收尾**：handler resolve → `exited`，reject → `error`；`control.finish(status)` 可手动覆盖（`cancelled` 等）。
- **前端触发**：`await window.cockpit.btJob('download-batch', { base, files, outDir })` —— 立即返回 taskId，任务在后台跑，面板实时看进度/日志，可随时停止。

### 新增一个 Ability

每个 ability 由几个可选的注入点组成，全部内聚在 `src/abilities/<id>/` 一个文件夹，按需添加：

1. **渲染端页面** `src/abilities/<id>/index.ts`（`Ability | Ability[]` 对象）+ `View.vue`
2. **主进程命令** `src/abilities/<id>/commands.ts`（导出 `CommandSpec[]`）——由 `src/main/process/abilities-loader.ts` 自动 glob 注册，无需改任何 import
3. **依赖声明** `src/abilities/<id>/package.json`（workspace 成员；有专属第三方依赖就写 `dependencies`，没有就留空，见 §2.2）
4. **领域类型** `src/abilities/<id>/types.ts`（不进 shared）
5. **翻译** `src/abilities/<id>/translations/{zh,en-US}.json`
6. **设置注入** `index.ts` 里的 `settings` 数组（分类/条目）；页面里要打开自己的设置用 `useSettings().open('<id>')`（`@ui/composables/settings`）：有设置页就跳到本能力的分类（可选定位到设置项），没有设置页则弹浮窗——**不要**写 `activate('settings', …)`，能力不应依赖 settings 能力存在。无页面的后端能力也可以注入设置
7. **（可选）平台过滤**：`platforms: ['linux']` 声明适用平台；多 Ability 时把数组默认导出
8. **（可选）能力依赖**：`provides: ['background-tasks']` 声明提供的能力 + `dependencies: ['background-tasks']` 声明要求的能力（见上「能力依赖」）；要求的能力无提供者 → 命令不注册、侧栏不显示
9. **（涉及个人数据时必做）隐私声明**：`privacy.ts` 定义 scope，命令声明 `privacy`、结果 `shield`，界面 `v-privacy` / `v-agent-forbidden`（见上「隐私 SDK」）

**无需改任何 yaml/注册表**——侧栏按 `category`/`name` 字母序自注入（见上）。

**依赖原则**：

- settings 是自身能力，其注入项不能调用其他能力已移除的命令（跨能力设置项应由对应能力自己注入）
- 渲染端页面不应 `import` 其他 ability 模块
- 删除能力 = 删 `src/abilities/<id>` 文件夹
- 纯后端能力（无 View.vue，如 `display` / `background`）不进侧栏，命令仍会自动加载

### 写一个 playground 能力（接口调试）

`src/abilities/playground/` 是 Provider Playground 的完整参考实现——模板驱动 API 调试。要点：

- **变量占位**：URL/headers/body 模板里写 `{name}`、`{name:type}`（`string`/`number`/`textarea`/`select`/`bool`）、约束 `range(a,b)`/`select:a,b,c`、默认值 `default(v)`。`extractAllVars`（`parser/variableParser.ts`）收集变量 → `DynamicForm.vue` 生成表单（数字区间自动变滑块）。
- **默认值**：`default(..)` 会被解析并**预填进 `varValues`**（模板激活时 `effectiveValuesFor` 合并 defaults + saved），发送时 `interpolate` 兜底，防止缺失变量把原始模板串发出去。
- **响应变换**：`respTransforms` 支持 `text` / `img` / `audio` / `audio-url` / `video-url` / `script` / `task`。同步变换在渲染端 `applyTransforms` 跑（按签名缓存）；`task` 变换的轮询在 `pg-task` 命名作业（`jobs.ts`）中跑，跨页面存活。
- **异步任务 view**：`pg-task` 完成后 `push({ data: TransformResult[] })` → `cockpit:bt` → 面板按 `view: 'response'` 渲染（`BtResponseView.vue`，文本/图片/音频/视频 + 长文本折叠）。前端在 `btJob` 返回后从环形缓冲 `btOutput` 回填一次，覆盖"任务瞬间完成、结果早于 IPC 返回"的竞态。
- **本地下载**：远程媒体/文本下载走 `playground.download-url` 命令（主进程 `fetch` 绕开渲染端 CORS），前端用 `src/main/ui/composables/download.ts` 的 `downloadUrlToLocal` / `downloadTextToLocal`（先弹原生保存对话框）。
- **持久化**：模板/全局变量/已填值/历史/上次打开的模板/右侧面板折叠态都在 localStorage（`useLocalStorage.ts`）；配置导出导入走 `playground.export` / `playground.import`。

### 写一个外部服务能力（AI DJ 参考）

`src/abilities/aidj/` 是「接外部服务」能力的参考实现——AI 歌单生成 + 本地播放器控制。要点：

- **配置**：`aidj/config.json`（`~/.config/LinuxCockpit/aidj/config.json`）存曲库目录、OpenAI 兼容端点与 API 密钥、模型、播放偏好；`loadAidjConfig` / `saveAidjConfig` 读写，设置页经 `AidjSettingsSection.vue` 注入。
- **命令**：`aidj.generate`（AI 生成歌单）、`aidj.search` / `aidj.sync` / `aidj.analyse`（曲库检索/元数据同步/分布分析）、`aidj.next/prev/toggle/stop/volume/send`（MPRIS 播放控制）、`aidj.start-persistent` / `aidj.chat`（持久模式）。
- **后台作业**：`jobs.ts` 注册 `aidj.persistent` 命名作业——在后台跑 AI DJ 自动轮播（`await` 即 yield），通过 `pushLine` / `push({ data: { type: 'now_playing' | 'status' } })` 输出，面板「停止」→ abort 并断开 DBus。
- **持续模式 AI 循环**（`aidj/loop/`）：参数在 `preferences.loop`（`policy.ts`，`resolveLoopPolicy` 归一化，设置页「AI 循环」）；**提示词不写在代码里**，一个模板一个文件放 `loop/prompts/*.md`、范式放 `loop/playbooks/*.md`（frontmatter `id/title/when` + 正文步骤），构建期经 `import.meta.glob ?raw` 内联（`loop/assets.ts`，tsx 测试时回落读磁盘），两个目录已加入 `.prettierignore`；`preferences.loop_prompts` / `loop_playbooks` 可覆盖或新增。默认 `agent` 模式：LoopAgent（`agent/runner.ts`，标准 tool-calling 循环）不逐首看曲库——按范式（`use_playbook`，如 `seed_start` / `artist_pick` / `radio_flow`）调用工具：`search_titles` / `search_lyrics`（歌词全文、繁简互通）找锚点、`tag_cloud` + `filter_library` 按标签批量缩小候选池、`dream_from_seeds`（DreamAgent）/ `ask_library_agent`（LibAgent）在池内挑、`queue_tracks`（`pin_first` 钉起点）；结束后代码固定调用 RankAgent（`agent/rank.ts`）排序、剔除并写 DJ 词。判断交给 LLM、合法性由代码保证（ID 必须存在、已播 / 同歌手上限 / 子 Agent 只能返回范围内 / Rank 不能加歌 / 起点必在首位）。新工具 `registerDjTool`、新范式 `registerDjPlaybook` 或 md 文件。曲目带短 ID（`#k3f9`），歌手解析会识别「歌名 - 歌手」反向命名（`configureArtistOrientation`）。一批 = 一次 `runAgentWorkflow`（`agent/workflow.ts`，持续会话与即时聊天 `aidj.generate` 共用），事件 `workflow_start / agent_step / tool_call / tool_result(stats) / workflow_end` 带 `batch` id；界面用 `components/workflow-view.ts`（纯函数分组 + 摘要）+ `WorkflowCard.vue` 每批一张卡片（后台面板 BtChatView 与 ChatView 的回复上方），即时聊天经 `aidj.stream-status --since N` 增量拉事件。新工具想要一句话摘要就在 `summarize()` 加一个 case（缺省只显示工具名）。
- **AIDJ 密钥**：`secrets.api_key` / `secrets.tavily.api_key` 经 `encrypt.ts` 加密落盘（`saveAidjConfig` 加密、`loadAidjConfig` 解密，旧明文首次读取时自动迁移；解密失败保留密文不清空）；`aidj.get-config` 不回传密钥只给 `secretsSet`，设置页只写不回显。新增密钥字段名必须命中 `privacy.ts` 的 `SECRET_KEY_RE`（如 `api_key`），agent 读结果才会兜底脱敏。
- **DJ 工具补充**：`random_pick`（当前池内随机，可筛选 / 限同歌手 / 避开最近歌手 / `queue=true` 直接加入，入队规则与 `queue_tracks` 共用 `queueRefs`）；`web_search`（Tavily，`agent/web-search.ts`，设置开启且有 key 才出现在工具表与系统提示里，主进程用 `net.fetch` 走系统代理）。`DjTool.enabled(policy, config)` 可按配置决定是否提供。
- **标签整理**（`aidj/sanitize/`，页面菜单「标签整理」→ `SanitizeView.vue`）：① VocabAgent 每个字段（emotion / genre / language / loudness）一次调用，把词云合并成规范词表 + 旧→新映射（`vocab.ts` 的 `repairFieldVocab` 校验：目标必须在词表内、language 必含 Unknown）→ ② 用户审核 / 手改 / 带意见重做（草稿 `aidj/sanitize/draft.json`）→ ③ 后台作业 `aidj.sanitize`：能映射的歌代码直接处理，其余交 SanitizeAgent（原始元数据 + 歌词片段，输出经 `validateAgentFields` 校验、无效重试一次），结果按词表版本缓存可断点续跑 → ④ 写入**新槽位**（`Sanitized-<日期>.metadata` / `Bilibili-Sanitized-…`，先登记为禁用再写），`aidj.sanitize-switch` 一键切换 / 切回（来源 = 当前写入目标，可链式整理）。切换后 forward：`appendMetadata` 按启用中的词表规整、两条元数据提取提示词带上词表（`vocabPromptHint`）。unknown 语言允许，宁缺勿猜。
- **元数据同步**：新歌经 NeteaseCloudMusicApi 拉歌词 → LLM 提取 `language/emotion/genre/loudness/review` → 写入 `aidj/music_metadata.jsonl`。
- **音量平衡**：`LoudnessCache` 用 `ffprobe` 测响度（LUFS/RMS），按曲目动态调音量。
- **歌词页（第二个 Ability `aidj-lyrics`）**：同文件夹 `index.ts` 导出 `Ability[]` 注册独立歌词页（`LyricsView.vue`），配置在 `aidj-lyrics/config.json`（`loadLyricsPageConfig` / `saveLyricsPageConfig`，命令 `aidj.lyrics-page-config/save`，设置页单独分类「AIDJ Lyrics」）。页面配色**只跟主题**（`--v-theme-*`，无颜色配置），但自带**卡拉OK 逐字高亮**（LRC 内联时间戳切分 `chunks`）与**歌词滚动跟随**（`scroll_follow`）两档，逻辑与桌面浮窗 `LyricsWindow.vue` 完全独立（不共用解析/渲染代码）。

## 10. 国际化 (i18n)

翻译按模块拆分：框架层在 `src/main/ui/translations/`，每个能力在自己的 `src/abilities/<id>/translations/`，每个背景在自己的 `src/background/<type>/translations/`。所有文件在运行期被合并成同一张表。

### 10.1 UI 字符串

- `src/main/ui/i18n.ts` 提供 `translate(lang, key, fallback?)` 和 `translateTemplate(lang, key, vars, fallback?)`，自动合并框架 + 各能力 + 各背景的翻译
- 每个 ability View 通过 `inject('cockpit:lang')` 获取当前语言 Ref
- 回退链：当前语言 → zh → fallback 入参 → key 本身
- 主进程通过 `src/main/process/i18n.ts` 的 `t()`/`te()` 读取同一批翻译文件（filesystem glob 合并）
- 添加新键时必须在对应模块的 `zh.json` 和 `en-US.json` 同时添加

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
> 新键必须同步添加到对应模块的 `translations/zh.json` 和 `translations/en-US.json`。
> 主进程中的字符串使用 `src/main/process/i18n.ts` 的 `t(key, fallback?)` / `te(key, vars)`。
> apps.json 的 `name`/`description`/`alias` 默认生成时至少包含 `zh` 和 `en_US` 两个语言。

## 11. 验证与协作规范（吃过亏的教训）

### 11.1 「做完」的定义：必须真的跑起来（由主 agent / 副总监执行）

> 本节的启动验证是**主 agent（副总监）**的职责。派给下游模型（opencode 等）的工作包**只做静态验收**（eslint / tsc / 一个离线自检脚本），不要求也不应该让它们 build、启动应用、开调试端口——并行包共享同一工作区与桌面，会互相抢端口、在用户桌面上弹窗。

`pnpm typecheck && pnpm lint && pnpm build` 通过 **只说明能编译，不说明能用**。凡是新增/改动能力、引入第三方依赖、改 `electron.vite.config.ts`，都必须**启动应用**验证，至少做到：

1. `pnpm build` 后 `pnpm start`（或 `electron . --remote-debugging-port=9333`）能起来，主进程日志无 `App threw an error during load`；
2. 新能力的侧栏条目出现，图标与其他条目风格一致；
3. 至少调用一次新命令（页面里 `window.cockpit.command('<ability>.<cmd>')` 或 CLI），确认返回的是预期结果/预期错误码，而不是异常；
4. UI 改动看真实界面，不只看代码。

验证时用临时 `HOME`/`XDG_CONFIG_HOME` 隔离，避免污染真实 `~/.config/LinuxCockpit`；不要用 `pkill -f <含自身命令行的模式>`（会把自己的 shell 一起杀掉），改用 `pgrep` 取 PID 再 `kill`。

### 11.2 主进程内联第三方 CJS 包的坑

能力专属依赖会被内联进 `out/main/index.js`（见 §2.2）。某些 CJS 包（如 hustpass 依赖的 `sm-crypto`）内联后会经 rollup 的 `commonjsRequire` 桩函数动态引用 Node 内置模块，**桩函数直接 throw，应用一加载就崩**，且构建、typecheck、lint 全部不报错。`electron.vite.config.ts` 已用 `cockpit-commonjs-require-shim` 插件把桩函数换成真 `require`；引入新依赖后必须按 §11.1 启动验证。

### 11.3 源码型 SDK 的接入模式（hustnet / hustpass）

这类包是带 `.ts` 扩展名 import 的源码：

- typecheck 走能力目录里的本地声明（`hustnet-api.d.ts` / `hustpass-api.d.ts`，`tsconfig.node.json` 的 `paths`），运行时由 `electron.vite.config.ts` 的 `resolve.alias` 指回真包；
- 渲染端 tsconfig（`tsconfig.web.json`）必须 `exclude` 会 import 该 SDK 的主进程文件（`sections.ts` 等）与 `.d.ts`，否则 vue-tsc 会跟进 SDK 源码报 TS5097；
- 打包后 `import.meta.url` 失效：SDK 的子进程/资源路径要在构建期解析并经 `define` 注入。

### 11.4 私有能力仓库

不入主仓库的能力（`fnaf/ut/mt/rungame/bilistats/biliviewer/campusnet/campusinfo`）各自是**独立的私有 git 仓库** `aaaa0ggMC/launcher-<id>`（嵌套在 `src/abilities/<id>/` 里，主仓库 `.gitignore` 忽略）。改这些能力要到对应目录里 `git commit`/`git push`，不会出现在主仓库 `git status` 里；新增同类能力照此建私有仓库并写 `.gitignore`（`node_modules`、`*.log*`、`*.tsbuildinfo`）。

`claudeadv`（Claude 历险记，2D 平台跳跃小游戏）同样嵌套在 `src/abilities/claudeadv/`、被主仓库忽略，但它是**公开**仓库 `aaaa0ggMC/launcher-claudeadv`（MIT）。背景图由本机 ComfyUI（Z-Image Turbo）生成，角色/敌人/音效全部程序化——AI 生图画不准主角，也出不了干净的透明小图。

`biliviewer`（本地 B 站缓存播放器）的播放通路：DASH `m4s` 经 MSE 按 sidx 分段直播（`player/dash.ts`）；FLV/blv 多段走 mpegts.js；浏览器解不了的编码（缓存多为 HEVC）由 ffmpeg 实时转成分片 MP4，经仅监听 `127.0.0.1`、URL 带随机 token 的 HTTP 推给 `<video>`（`stream.ts`，拖动进度 = 带 `?start=` 重新起流）。渲染端 `fetch('cockpit-audio://…')` 依赖 `src/main/ui/index.html` CSP 的 `connect-src` 含 `cockpit-audio:`（`*` 不匹配自定义协议）。弹幕不用官方播放器（它不能加载本地文件），`danmaku/` 自带 XML 解析 + Canvas 引擎。

### 11.5 「校园信息类」能力的敏感字段

涉及个人数据（学号、姓名、手机、邮箱、卡号、IP/MAC、余额、金额、成绩分数）的界面：**默认以 `•` 遮盖（长度固定 6–8 位，不泄露真实长度），点击该字段切换显示**（点击打码值不得冒泡触发外层的跳转等动作）；「复制为 Markdown」等导出也要遵守当前遮盖状态；密码类只写不回显，落盘走 `src/main/process/encrypt.ts`。

### 11.6 给下游模型派活时 brief 必须包含

- **AGENTS.md 相关章节与 DESIGN.md 的必读要求**，尤其：图标规则（§9「图标」）、i18n 规则（§10）、排版规范；
- **验证分工**：下游只做静态验收（eslint / tsc / 至多一个离线自检脚本），并如实列出「没验证的」；build、启动应用、真实调用命令、看真实界面**一律由副总监做**。brief 里明确写「不要启动应用 / 不要 pnpm build / 不要占端口」，并且**不要让下游必读本章 §11.1**；
- 明确不许改的文件（尤其 `electron.vite.config.ts`、`tsconfig*.json`、`package.json`）；
- 副总监自己 review 时逐项对照本章，而不是只看下游汇报。

### 11.7 自检脚本与真实用户目录（曾因此覆盖了用户的 config.json）

任何会读写 `~/.config/LinuxCockpit/`（含 `config.json`）的脚本——无论是自己写的还是下游写的——**运行前必须把 `HOME` 和 `XDG_CONFIG_HOME` 指到临时目录**，并且脚本自己要在最开头断言这一点，而不是依赖调用者记得设置：

```ts
// 必须在 import 任何项目模块之前执行
const home = process.env.HOME ?? ''
if (!home.startsWith('/tmp/'))
  throw new Error('拒绝运行：HOME 必须是 /tmp 下的临时目录，避免改写真实用户配置')
```

- **复跑下游写的脚本之前先读它的文件头**：头部若写了「需要设置 HOME」之类的前提，照做，别直接执行。
- 应用自身写 `config.json` 时（`config.set`）：读失败不得当空配置合并写回；每次写入前保留 `config.json.bak`。

### 11.8 自适应：不要让用户去拖横向滑块

信息类页面按**容器宽度**（`ResizeObserver`，而不是窗口断点——页面可能被缩放或嵌在别处）自适应，宽度不够时**换布局而不是出横向滚动条**：

- 导航：宽 ≥ 900 完整侧栏 / 640–899 只留图标 / < 640 收成顶部下拉菜单（`campusinfo/View.vue`）。
- 表格：装不下（列数 × ~120px）时转「一行一张小卡」的堆叠布局（`DataTable.vue`）。
- 周课表：容器 < 520 时转「按天分组的日程列表」（`TimetableGrid.vue`）。
- 主从布局优于「一屏塞满卡片」：一次只看一个区块，信息宁可精简也不要靠滚动补全。
- **用到的工具类必须先确认存在**：`min-h-0` 曾经根本没定义（全局只有 `.min-w-0`），导致所有 flex 容器按内容撑高、滚动容器不生效、内容被窗口裁掉，且 typecheck / lint / build 都不报错。现已在 `global.css` 补上；新增类似的工具类（`min-h-*` 等）前先 `grep` 确认。
- **看布局要量，不要猜**：需要看真实布局又不想联网时，启动应用时把 `http_proxy` / `https_proxy` 指向 `http://127.0.0.1:9`（必然拒绝连接，不会有流量发出），用 CDP 读 `getBoundingClientRect` / 截图，并用 `Emulation.setDeviceMetricsOverride` 模拟窄宽度（详见 §11.1 的隔离要求）。
- **组件里不要写 `scrollbar-width` / `scrollbar-color`**：新版 Chromium 一旦看到它们就切回系统原生（GTK）滚动条，忽略 `global.css` 里全部 `::-webkit-scrollbar` 自定义样式，还会带回箭头按钮（`global.css` 里有同样的警告）。滚动条样式统一由全局提供，页面只管 `overflow`。

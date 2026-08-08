# AGENTS.md

Linux System Cockpit — 个人系统控制中心，当前面向 Arch Linux + KDE Plasma 6 (Wayland) 开发。
Electron + Vue 3 + Vuetify 3 (Material 3)。以下为搭建、开发、迁移的完整流程。

> 核心（框架、命令注册表、UI、日志、后台任务、应用注册表、ft、logs 等）跨平台，不依赖具体发行版/桌面；
> Linux/发行版相关逻辑都隔离在对应 ability 的 service 与 `scripts/`，保持命令接口不变即可改写适配（见 README「平台适配」）。

## 1. 环境要求

**跨平台基线**：

- Node.js ≥ 22 (开发机为 v26.5.0)
- pnpm ≥ 11 (`corepack enable && corepack prepare pnpm@latest --activate`)
- Electron 可运行的桌面环境（当前主要验证于 Arch Linux + KDE Plasma 6 / Wayland）

**Linux / 发行版特定能力的系统工具**（可选，按需；缺失时仅对应能力不可用）：

- `pkexec` (polkit) — 提权操作必须
- `nvidia-smi` — GPU 信息
- `docker` — 容器管理
- `flatpak` — 包计数
- `pacman` — 镜像源 / 包计数
- `systemctl` — systemd 服务
- `plasma-apply-wallpaperimage` / `kscreen-doctor` — 壁纸 / 显示输出 (KDE)
- `konsole` — 终端启动 (可在 `~/.config/LinuxCockpit/config.json` 改)
- `ffprobe` (ffmpeg) — AIDJ 响度分析（动态音量平衡）
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
    "fuseBlur": 28 // 背景模糊 (px)
  },
  "runtime": {
    "terminal": ["konsole", "--hold", "-e"], // terminal:true 的条目用这个
    "confirmBeforeLaunch": true
  }
}
```

`theme` 的取值来自 `src/main/ui/color_schemes/*.json`（见 §9「主题」）；未知 id 自动回落 `dark`，不会弄坏 UI。

### ~/.config/LinuxCockpit/abilities.yaml — 侧栏清单

控制侧栏顺序和启用状态。各能力的专属配置已移出 yaml，独立存放在 `~/.config/LinuxCockpit/<ability-id>/config.json`（如 AIDJ 的 `aidj/config.json` 存曲库路径、API 密钥、模型与播放偏好）。

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
      manifest.ts      # ~/.config/LinuxCockpit/abilities.yaml 读取
      background-tasks.ts  # 后台任务框架 (进程/作业任务, 资源统计, stdin/信号)
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
    types.ts          # 仅框架契约 (AbilitiesManifest / LaunchResult / ProcOutputEvent / Bt*)
  main/ui/
    bt-views.ts       # 后台任务 View 注册表 (log 内置 / 能力可注册自定义)
    components/BackgroundTaskViews/  # BtLogView (控制台) / BtResponseView (结构化响应)
    composables/      # download.ts (本地下载经主进程命令) / format.ts / useLoading.ts
~/.config/LinuxCockpit/
  config.json           # 全局外壳配置（theme / uiScale / animations / window / runtime）
  abilities.yaml        # 侧栏清单（abilities 列表，不包含能力专属配置）
  <ability-id>/
    config.json         # 各能力独立配置（镜像源列表、搜索目录等）
scripts/               # pkexec helper 脚本 + polkit 规则
```

## 9. 架构要点

### CLI-first

每个操作都是一个注册命令 (`<ability>.<command>`)。UI 按钮和 CLI REPL 共享同一个 handler，不存在只能从 UI 触发的操作。

- UI: `window.cockpit.command('mirror.toggle', { name, enable })`
- CLI: `mirror.toggle --name USTC --enable true`

### Ability 动态加载

- 渲染端: `src/abilities/index.ts` 的 Vite `import.meta.glob` → 首次显示时 async `import()` (code-split)
- 主进程: `src/main/process/abilities-loader.ts` 的 `import.meta.glob` 收集 `src/abilities/*/commands.ts` → `registerAll`
- 侧栏由 `~/.config/LinuxCockpit/abilities.yaml` 驱动，增删能力文件夹 + 改 yaml 即可

### 图标

图标统一走 `AbilityIcon.vue` → `parseIcon`（`src/main/ui/icon.ts`）解析，来源优先级：

- `gi:<name>` — 侧栏 curated SVG（`src/main/ui/assets/icons/<name>.svg`，随仓库内建）
- `default/<name>[/padding]` — game-icon-pack SVG（`assets/game-icon-pack/svg/`），通过 `GameIcon.vue` 渲染 (`fill="currentColor"` 跟随主题色)
- `emoji/<emoji>` / 裸 emoji / `auto` — emoji 兜底
- `file/<path>` / 绝对路径 — 本地图片（经 `cockpit-icon://` 协议）

ability 的 `icon` 字段用 `gi:<name>` 前缀指定 curated SVG，找不到时回落 game-icon-pack，再不行才用 emoji。

### 主题 / 配色方案

- 每个配色方案是一个独立 JSON（`src/main/ui/color_schemes/*.json`），`color_schemes/index.ts` glob 注册并构建 Vuetify `ThemeDefinition`（`buildThemeDefinitions`）。
- 内置 10 个：`dark` / `light` / `pureblack` / `moonlight` / `forest` / `aurora` / `rosy` / `sepia` / `slate` + `system`（跟随系统亮暗）。
- `config.json` 的 `theme` 存方案 id；未知 id 一律回落 `DEFAULT_SCHEME_ID`（`dark`），不会弄坏 UI。
- 主题切换：开启「现代动效」时用 View Transitions API 做波纹揭示，扩散起点由 `animations.themeTransition` 决定（`corner`=左上角、`cursor`=鼠标处，见 `App.vue` 的 `applyTheme` 与 `global.css` 的 `--vt-origin-*`），关闭则即时切换。`<html>` 加 `motion-off` 类可全局关闭所有 CSS 过渡。
- ft 等画布类渲染端的配色跟随当前主题（读取 `--v-theme-*` CSS 变量），不是硬编码 hex。

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

1. **渲染端页面** `src/abilities/<id>/index.ts`（`Ability` 对象）+ `View.vue`
2. **主进程命令** `src/abilities/<id>/commands.ts`（导出 `CommandSpec[]`）——由 `src/main/process/abilities-loader.ts` 自动 glob 注册，无需改任何 import
3. **领域类型** `src/abilities/<id>/types.ts`（不进 shared）
4. **翻译** `src/abilities/<id>/translations/{zh,en-US}.json`
5. **设置注入** `index.ts` 里的 `settings` 数组（分类/条目）

然后在 `~/.config/LinuxCockpit/abilities.yaml` 的 `abilities` 列表注册（`id`/`order`/`enabled`）。

**依赖原则**：

- settings 是自身能力，其注入项不能调用其他能力已移除的命令（跨能力设置项应由对应能力自己注入）
- 渲染端页面不应 `import` 其他 ability 模块
- 删除能力 = 删 `src/abilities/<id>` 文件夹 + 改 `~/.config/LinuxCockpit/abilities.yaml`
- 纯后端能力（无 View.vue，如 `display` / `background`）不需要在 abilities.yaml 注册，命令仍会自动加载，只是不进侧栏

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
- **元数据同步**：新歌经 NeteaseCloudMusicApi 拉歌词 → LLM 提取 `language/emotion/genre/loudness/review` → 写入 `aidj/music_metadata.jsonl`。
- **音量平衡**：`LoudnessCache` 用 `ffprobe` 测响度（LUFS/RMS），按曲目动态调音量。

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

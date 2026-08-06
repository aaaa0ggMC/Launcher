# STRUCTURE — Linux Cockpit 架构

Linux System Cockpit 是运行在 Arch Linux + KDE Plasma 6 (Wayland) 上的个人系统控制中心。
技术栈：**Electron + Vue 3 + Vuetify 3 (Material 3) + TypeScript**，包管理 pnpm，构建 electron-vite。

本文讲述**架构**（分层、加载模式、核心工作流），不深入实现细节。

---

## 1. 进程与分层

```
┌──────────────────────────────────────────────────────────┐
│ main/           主程序                                    │
│  ├─ process/    Electron 主进程（后端）：窗口 / IPC /      │
│  │              命令注册表 / 加载器 / 日志管线 / 服务       │
│  └─ ui/         UI 框架（渲染端）：Vue 外壳、组件、样式、   │
│                 图标、框架层翻译、i18n 基础设施            │
├──────────────────────────────────────────────────────────┤
│ abilities/      所有能力（自包含：页面 + 命令 + 类型 +      │
│                 翻译，一个能力一个文件夹）                 │
├──────────────────────────────────────────────────────────┤
│ background/     所有背景（每种类型一个文件夹）             │
├──────────────────────────────────────────────────────────┤
│ preload/        contextBridge → window.cockpit.*（白名单）│
├──────────────────────────────────────────────────────────┤
│ shared/         框架契约类型（仅跨进程共享的类型）         │
└──────────────────────────────────────────────────────────┘
```

- 渲染端 `sandbox + contextIsolation + nodeIntegration=false`；能力操作一律经 `window.cockpit.command(name, args)` 走主进程命令注册表（CLI-first）。
- 依赖方向：`main` 与 `background` 是框架/宿主；`abilities` 是插件；各能力自包含，不相互 import；能力领域类型留在各自 `types.ts`，不进入 `shared`。

---

## 2. 核心文件树

```
src/
  main/
    index.ts                # Electron 入口：窗口 + 单例 + 生命周期 + 各管线接线
    process/
      ipc.ts                # window.* / dialog.* / clipboard.* / 命令分发 IPC
      cli.ts                # CLI REPL（与 UI 共用命令注册表）
      commands/
        types.ts            # CommandSpec / CommandContext 契约
        registry.ts         # 命令 Map + runCommand / tryRunCommand / parseArgs
      abilities-loader.ts   # 加载器：globs abilities/*/commands.ts → registerAll
      ability-loader.ts     # 外部用户能力（esbuild 即时编译）
      manifest.ts           # abilities.yaml 读取
      logger.ts             # 日志管线（winston 轮转文件 + 内存缓冲 + 广播）
      background-tasks.ts   # 后台任务框架（进程/作业任务、资源统计、stdin/信号、广播）
      paths.ts / util.ts / i18n.ts / icon-protocol.ts
    ui/
      App.vue               # 侧栏 + 搜索/快速启动 + app-bar + keep-alive 宿主（provide cockpit:* 上下文）
      main.ts               # Vuetify 初始化 + renderer 日志转发
      color_schemes/        # 主题配色注册表：*.json + index.ts（buildThemeDefinitions / resolveSchemeId）
      animations.ts         # 页面切换过渡注册表（PAGE_TRANSITIONS）
      components/           # GameIcon / AbilityIcon / BackgroundLayer / FuseLayer / TransformerModal / BackgroundTasksDialog / UiNode / LoadingBar
      components/BackgroundTaskViews/   # BtLogView（控制台）/ BtResponseView（结构化响应）
      bt-views.ts           # 后台任务 View 注册表（log 内置 / 能力可注册自定义）
      entry-actions.ts      # 应用快速启动右键动作注入（registerEntryActionProvider）
      icon.ts               # 统一图标语法解析（parseIcon / fileIconUrl）
      transformer.ts        # 应用输出 transformer 运行时
      styles/               # global.css（主题配色由 color_schemes/ 提供）
      composables/          # search.ts（统一打分搜索）/ download.ts / format.ts / useLoading.ts
      translations/         # 框架层翻译 + 语言列表
      i18n.ts               # 合并各模块翻译的 translate/translateTemplate/localize
  abilities/
    index.ts                # 渲染端加载器：globs abilities/*/index.ts，暴露列表 + settings 聚合
    types.ts                # Ability / AbilitySetting 契约
    <id>/                   # 每个能力一个文件夹
      index.ts              # 统筹加载：Ability 元数据
      View.vue              # 页面（可省略 → 纯后端能力）
      commands.ts           # 主进程命令（可省略）
      types.ts              # 领域类型
      translations/         # 该能力翻译
      service.ts / items/ / panels/ / components/ / parser/ / jobs.ts ...
  background/
    index.ts                # 加载器：globs background/*/index.ts
    types.ts                # BackgroundDef 契约
    <type>/                 # index.ts (BackgroundDef) + View.vue (+ translations/)
  preload/
    index.ts / index.d.ts   # contextBridge 白名单 API
  shared/
    types.ts                # 仅框架契约：AbilitiesManifest / LaunchResult / ProcOutputEvent / Bt* (后台任务)
~/.config/LinuxCockpit/
  config.json               # 全局外壳配置（theme / uiScale / animations / window / runtime）
  abilities.yaml            # 侧栏清单（abilities 列表，不包含能力专属配置）
  <ability-id>/
    config.json             # 各能力独立配置（镜像源列表、搜索目录等）
scripts/                    # pkexec helper 脚本 + polkit 规则
```

---

## 3. 核心工作流

### 3.1 CLI-first 命令流

**每个操作都是一个注册命令 `<ability>.<command>`**，UI 按钮与 CLI REPL 共用同一 handler：

```
UI:  window.cockpit.command('mirror.toggle', { name, enable })
      └→ ipc 'command:run' ─┐
CLI: mirror.toggle --name USTC --enable true
      └→ cliExec ──────────┘
              └→ commands/registry.runCommand()  （持有 Map，CLI 与 UI 唯一入口）
                    └→ <ability>.commands.ts 的 spec.run(ctx) ─→ 能力 service
```

- 注册点：`abilities/<id>/commands.ts` 导出 `CommandSpec[]`，由 `process/abilities-loader.ts` 的 `import.meta.glob` 自动收集并 `registerAll`。**新增能力 = 建目录，无中央总控。**
- 未注册命令 → `UnknownCommandError` → 广播 `cockpit:command-error` → 渲染端 toast。
- IPC 层记录每次命令的「命令名 + 脱敏参数」，出错时记 `命令名 failed`。

### 3.2 Ability 加载

能力完全自包含，页面与后端命令由两个加载器分别收集，布局一致：

```
渲染端:  abilities/index.ts  globs abilities/*/index.ts（仅元数据，View 懒加载 code-split）
          └→ App.vue 侧栏按 abilities.yaml 渲染，keep-alive 缓存
主进程:  process/abilities-loader.ts  globs abilities/*/commands.ts → registerAll
```

- 侧栏顺序 / 启用 / 各能力 config 都由 `~/.config/LinuxCockpit/abilities.yaml` 控制。
- 加载到的一切通过 `App.vue` 的 `provide('cockpit:*')` 暴露给单个能力，实现跨范围控制（能力列表、当前能力、configs、launch、命令列表、设置聚合等）。

### 3.3 日志流

```
任何模块: makeLogger(scope).info/warn/error(...)
    └→ process/logger.ts
        ├→ winston + daily-rotate ──→ logs/cockpit-YYYY-MM-DD.log（按天轮转、归档）
        ├→ 内存环形缓冲（当前会话，20k 条，连续重复合并为 *N）
        └→ 广播 cockpit:log ──→ logs 能力（虚拟滚动逐行展示、级别过滤、实时尾随、导出）
```

- 渲染端 `console.warn/error` 与未捕获错误经 `logs.post` 转发进主进程日志。
- 「忽略 logs 自身」只影响展示（查询/实时过滤），日志文件始终完整写入（审计）。

### 3.4 渲染三层 UI

```
Data        —— 侧栏 / app-bar / v-main 内容
Fuse        —— 半透明蒙层（rgba(background, fuseAlpha)）
Background  —— background/<type>/ 加载器驱动：透明 / 自定义图片 / KDE 壁纸（可模糊）
```

### 3.5 后台任务流

框架级设施（`process/background-tasks.ts`），让任意能力开一个跨页面存活的长跑作业：

```
任何模块:
  startProcessTask(...)          # 进程任务：真实子进程，资源统计 + stdin/信号
  startJobTask(...)              # 作业任务：无进程，pushLine/push/setProgress/finish/cancel
  registerJobHandler + startJobByName  # 命名作业：前端 background.job --name <handler> 触发
      └→ process/background-tasks.ts
          ├→ 任务注册表 + 环形输出缓冲（BtOutputMessage：line / 结构化 data / base64）
          ├→ 资源统计（pidusage 跨平台 CPU/内存，nvidia-smi GPU）
          └→ 广播 cockpit:bt ──→ BackgroundTasksDialog
              └→ 按任务 view 渲染详情区（bt-views 注册表：log 控制台 / 自定义）
```

- **作业 = 协程**：handler 是一段普通 async 函数（`while` + `await` 即循环 + yield），`setProgress`/`pushLine` 更新状态，无模板类。
- **可定制 View**：任务声明 `view` id，面板按注册表渲染详情区（生命周期按钮属面板不属于 view）；输出消息可携带结构化数据 / base64 二进制，由 view 决定展示。
- 前端**发起**（`background.job`）不阻塞：任务立即返回，handler 在主进程后台跑（fire-and-forget）。
- **输出实时 / 状态节流**：`cockpit:bt` 的 `output`（日志/结构化消息）实时推送（同步突发经微任务合并，跨 tick 立即送达）；`changed`（任务列表/进度）100ms 节流合并，避免高频 `setProgress` 打爆 IPC。日志管线（`cockpit:log`）保持逐条实时。
- 任务**依附于本程序**：退出时 `will-quit` 统一清理；有运行中任务时拦截 close 弹确认。
- 执行载体并列：终端 / systemd ability / 后台任务，由能力按需选用，非替代关系。

### 3.6 国际化

翻译按模块拆分（框架层 + 每个能力 + 每个背景的 `translations/{zh,en-US}.json`），运行期合并为一张表；渲染端 `ui/i18n.ts` 用 `import.meta.glob` 合并，主进程 `process/i18n.ts` 用 filesystem glob 合并。回退链：当前语言 → zh → fallback → key。

### 3.7 主题流

```
config.json 的 theme（id） ─→ color_schemes/index.ts
    ├→ resolveSchemeId(configured, systemPrefersDark)  # 未知 id 回落 dark；system 跟随系统亮暗
    └→ buildThemeDefinitions() ─→ Vuetify theme map（main.ts 启动 / App.vue 实时切换）
    App.vue applyTheme():
        ├→ 现代动效开 → View Transitions API 左上角波纹扩散揭示（global.css ::view-transition-*）
        └→ 现代动效关 → 即时切换（<html> 加 motion-off 全局关闭所有 CSS 过渡）
```

- 配色方案是独立 JSON（`src/main/ui/color_schemes/*.json`），新增 = 加一个 JSON + 翻译键，无需改代码。
- 渲染端画布类（如 `ft`）读取 `--v-theme-*` CSS 变量跟随主题，不硬编码 hex。

### 3.8 接口调试流（playground）

Provider Playground（`abilities/playground/`）——模板驱动 API 请求调试，全部内聚在一个文件夹：

```
模板 (RequestTemplate): URL / headers / body 含 {var:type:constraint:default(..)} 占位
    └→ extractAllVars / interpolate  →  DynamicForm 生成表单（字符串/数字区间滑块/选择/多行/布尔）
    └→ sendRequest → fetch → ResponseViewer + 响应变换（respTransforms）
         ├→ 同步变换（text/img/audio/video/script）→ applyTransforms（渲染端，缓存按签名）
         └→ 异步任务（type: task）→ btJob('pg-task') ─→ 主进程 jobs.ts
              ├→ 轮询 task-result 直到状态成功/失败，递归嵌套 task
              ├→ 地址/查询/头模板支持 {var} 插值 + {.jsonpath} 提取 + {task_id}
              └→ push({ data: TransformResult[] }) ─→ cockpit:bt → BtResponseView 渲染
```

- **变量语法**：`{name}` / `{name:type}` / `{name:type:range(a,b)}` / `{name:select:a,b,c}` / `{name:default(v)}`；数字区间自动映射为滑块。
- **持久化**：模板 / 全局变量 / 每模板已填值 / 历史 / 上次打开的模板 / 右侧面板折叠态，全部存 localStorage；导入导出走主进程命令（`playground.export` / `playground.import`）。
- **异步任务 = 后台作业**：task 变换的轮询在 `pg-task` 命名作业（`jobs.ts`）中跑，跨页面存活，面板以 `response` view 实时展示；启动后从环形缓冲 `btOutput` 回填，覆盖"任务瞬间完成、结果早于 IPC 返回"的竞态。
- **结果下载**：远程媒体（图片/音视频）经 `playground.download-url` 命令由主进程 fetch 写盘（绕开渲染端 CORS），弹原生保存对话框；响应文本同理。

---

## 4. Abilities（当前 11 个 + 2 个纯后端）

| id                    | 介绍                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard` 总览      | GridStack 卡片总览：主机 / CPU / 内存 / GPU / NVIDIA 电源管理 / 磁盘 / 容器，后台轮询实时刷新；命令 `system.stats` / `hardware.*` / `docker.*` / `dashboard.*`                                                      |
| `apps` 应用           | 应用注册表（apps.json）：搜索目录扫描、条目 CRUD、多语言、风险分级、聚类操作按钮；命令 `apps.*` / `launch.*`；服务 registry / launcher / scanner / security                                                         |
| `mirror` 软件源       | Arch 镜像源管理：`[MIRROR]` 格式解析、行级 toggle（pkexec 原子写）、测速                                                                                                                                            |
| `autostart` 启动项    | `~/.config/autostart` 自启动项启用/禁用（Hidden=true）                                                                                                                                                              |
| `systemd` 服务        | 用户 systemd 服务列表 / 启动 / 停止 / 重启                                                                                                                                                                          |
| `cli` 命令行          | CLI REPL 前端：别名启动、标签补全、`info/list` 等                                                                                                                                                                   |
| `playground` 接口调试 | Provider Playground：模板驱动 API 请求 + 变量插值 + 响应变换（文本/图片/音频/视频/脚本/异步任务），异步任务经后台任务框架轮询；命令 `playground.export` / `playground.import` / `playground.download-url`           |
| `aidj` AI DJ          | AI 歌单生成（OpenAI 兼容端点）+ 本地曲库元数据同步（NeteaseCloudMusicApi + LLM）+ MPRIS 播放控制 + ffprobe 响度平衡 + 持久轮播模式；命令 `aidj.generate` / `aidj.sync` / `aidj.status` / `aidj.start-persistent` 等 |
| `ft` 傅里叶变换       | Canvas2D 天体/傅里叶可视化（无 GPU 依赖，规避 radeonsi 崩溃）：预设、可编辑矢量表、JSON 加载/导出、2D/3D 相机，画布配色跟随当前主题                                                                                 |
| `logs` 日志           | 当前会话日志查看器：逐行虚拟滚动、级别过滤、滑动窗口翻页、实时尾随、忽略自身、导出                                                                                                                                  |
| `settings` 设置       | 设置外壳：各能力通过 `settings` 注入分类/条目（主题 / 界面缩放 / 窗口 / 界面动画 / 语言 / 启动 / 关于）                                                                                                             |

另有纯后端能力（无页面）：`display`（壁纸列出/应用、显示输出查询）与 `background`（后台任务命令 `background.*`，由全局面板驱动）。

## 5. Backgrounds（当前 3 个）

| id                   | 介绍                               |
| -------------------- | ---------------------------------- |
| `transparent` 透明   | 不绘制背景，仅由 Fuse 蒙层提供底色 |
| `image` 图片         | 自定义图片路径，可高斯模糊         |
| `wallpaper` 桌面壁纸 | 自动读取 KDE 桌面壁纸，可高斯模糊  |

---

## 6. 配置

| 文件                                              | 作用                                                            |
| ------------------------------------------------- | --------------------------------------------------------------- |
| `~/.config/LinuxCockpit/config.json`              | 全局外壳：theme / uiScale / animations.* / window.* / runtime.* |
| `~/.config/LinuxCockpit/abilities.yaml`           | 侧栏清单（abilities 列表，不包含能力专属配置）                  |
| `~/.config/LinuxCockpit/<ability-id>/config.json` | 各能力独立配置（镜像列表、搜索目录等）                          |
| `~/Apps/apps.json`                                | 每个搜索根的应用注册表（手工优先，扫描器只补充不覆盖）          |

## 7. 开发 / 构建

```bash
pnpm dev           # electron-vite dev
pnpm build         # typecheck + build
pnpm typecheck     # tsc + vue-tsc
pnpm lint          # eslint（提交前必须 0 errors）
pnpm format        # prettier（单引号 / 无分号 / printWidth 100）
```

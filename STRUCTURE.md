# STRUCTURE — Linux Cockpit 架构

Linux System Cockpit 是运行在 Arch Linux + KDE Plasma 6 (Wayland) 上的个人系统控制中心。
技术栈：**Electron + Vue 3 + Vuetify 3 (Material 3) + TypeScript**，包管理 pnpm，构建 electron-vite。

---

## 1. 进程模型

```
┌──────────────────────────────────────────────────────────┐
│  main  (Electron 主进程)                                  │
│  · 命令注册表 (CLI-first) / IPC 服务                       │
│  · launcher (spawn) / registry / scanner / mirror / 等等   │
├──────────────────────────────────────────────────────────┤
│  preload (contextBridge)                                  │
│  · window.cockpit.*  —— 一组 thin wrapper，全部走 command()│
├──────────────────────────────────────────────────────────┤
│  renderer (Vue 3 + Vuetify)                               │
│  · App.vue 侧栏 + app-bar + keep-alive 宿主               │
│  · abilities/* 动态能力页面                                │
└──────────────────────────────────────────────────────────┘
```

- 渲染进程 sandbox + contextIsolation + nodeIntegration=false。
- preload 只暴露白名单 API；所有能力操作经由 `command(name, args)` 走主进程命令注册表。

---

## 2. CLI-first 命令注册表

**每个操作都是一个注册命令 `<ability>.<command>`**，UI 按钮与 CLI REPL 共用同一 handler：

- 注册点：`src/main/commands/<ability>.ts`，每个能力一个文件导出 `CommandSpec[]`，`src/main/commands/index.ts` 汇总 `registerAll(...)`。**新增能力 = 加一个命令文件 + 一行 import，不需要改中央总控**
- 分发：`commands/registry.ts` 持有 Map，`runCommand`（UI 路径）与 `tryRunCommand`（CLI 路径）共用
- 未注册命令：`runCommand` 抛 `UnknownCommandError`，`ipc.ts` 广播 `cockpit:command-error` → 渲染端弹错误 toast
- UI 路径：`window.cockpit.command('mirror.toggle', { name, enable })` → IPC `command:run` → `runCommand`
- CLI 路径：`mirror.toggle --name USTC --enable true` → `cliExec` → `tryRunCommand`

常用命令一览：

| 命令 | 说明 |
|---|---|
| `config.get` / `config.set` | 读写 config.json，set 会广播 `cockpit:config-changed` |
| `apps.list` / `apps.get` / `apps.update` / `apps.create` / `apps.delete` | 应用注册表 CRUD |
| `apps.add-root` / `apps.remove-root` / `apps.rescan` | 搜索目录管理 / 重扫 |
| `launch.run` / `launch.action` | 启动应用 / 执行附加操作 |
| `system.stats` | 系统状态 |
| `mirror.get` / `mirror.toggle` / `mirror.test` | 镜像源 |
| `autostart.*` / `systemd.*` / `docker.*` | 自启动 / systemd / docker |
| `dashboard.*` | 总览排版 |
| `hardware.*` / `display.*` | GPU / 壁纸 |

CLI REPL 还支持：`<alias>` 直接启动、`<alias> <action>` 执行操作、`info <alias>`、`list`。

---

## 3. Ability 动态加载

侧栏由 `config/abilities.yaml` 驱动；每个能力一个目录 `src/renderer/abilities/<id>/`：

```
abilities/<id>/
  index.ts   # 元数据: id/name/icon/category/keepAlive/component(async)
  View.vue   # 页面组件
```

- 渲染端 `import.meta.glob` eager 收集 `index.ts`（只有元数据），`View.vue` 用 `defineAsyncComponent` 首次显示时才加载（code-split）。
- 侧栏顺序 / 启用 / 各能力 config 都由 `abilities.yaml` 控制。
- 新增能力 = 建目录 + 改 yaml。

---

## 4. 三层 UI 渲染：Background / Fuse / Data

渲染进程把界面拆成三层（从底到顶）：

```
Data        —— 侧栏 / app-bar / v-main 内容
Fuse        —— 半透明蒙层: rgba(var(--v-theme-background), fuseAlpha)   (z-index -1)
Background  —— 透明 / 自定义图片 / KDE 壁纸 (可高斯模糊)               (z-index -2)
```

- **BackgroundLayer**（`components/BackgroundLayer.vue`）：注册表驱动（`backgrounds/index.ts`），预制 `transparent` / `image` / `wallpaper`，各自独立组件。`image` 用 `window.backgroundImage` 路径；`wallpaper` 由主进程解析 KDE 壁纸（`window:wallpaper` IPC）。
- **FuseLayer**：当前纯色背景的载体。fuse 100% 完全盖住背景；越低背景透得越多。`图片可见度 = backgroundOpacity × (1 − fuseAlpha)`。
- 配置（`window.*`，设置→窗口）：`background` / `backgroundImage` / `backgroundOpacity` / `fuseAlpha` / `fuseBlur` / `frameless` / `rounded`。除 frameless/rounded 外均实时生效（`config.set` 广播 `cockpit:config-changed`）。
- 窗口透明逻辑：`transparent = frameless && (rounded || fuseAlpha < 1)`。
- 顶栏/侧栏半透明覆盖（`global.css`）：用 `.v-application .v-app-bar` 这类**更高 specificity** 的选择器压过 Vuetify 运行时注入的 `.bg-surface` 规则。

---

## 5. 图标系统

统一 icon 语法（`src/renderer/icon.ts` 的 `parseIcon`），条目 / 操作按钮 / 侧栏通用：

| 语法 | 含义 |
|---|---|
| `default/<名字>[/padding]` | game-icon-pack 图标（`assets/game-icon-pack/svg/{no-padding,padding}/...`，懒加载） |
| `emoji/<emoji>` | 直接展示 emoji |
| `file//abs/path` 或 `file/abs/path` | 本地图片，走 `cockpit-icon://` 协议 |
| `gi:<name>` | 侧栏旧格式（`assets/icons/` 精选） |
| 留空 / `auto` | 兜底 😎 |

- **cockpit-icon 协议**：必须注册为**非 standard** scheme（`standard: true` 会让编码后的 `%2F` 落在 URL authority 导致请求发不出去）。
- 组件：`AbilityIcon.vue`（解析语法）→ `GameIcon.vue`（curated 优先，其次 game-pack 懒加载，未命中回退 emoji）。

---

## 6. 输出 Transformer（实时输出弹窗）

apps.json 条目可配 `transformer` + `transformer_display`：

- 启动该条目时主进程以 `monitor` 模式运行（stdio 接管道、按行切分），广播 `cockpit:proc-output`（`{ pid, type: line|exit, stream, line }`）。
- 渲染端 `TransformerModal.vue` 订阅输出，把每行喂给 `transformer.onNewLine(e, ui)`，`ui` 是**组件工厂**（非 DOM 控制权）。
- ui API：`NewText / NewTitle / NewAlign / NewBar / NewStatus / NewTable / add / clear`。
- 弹窗 80% 尺寸，支持 视图/Raw 切换、自动滚动。
- monitor 模式自动去除 terminal 包装（否则输出被终端吞掉）。
- 详情见 `APPS.JSON.MD` 的 transformer 章节。

---

## 7. 无边框窗口

- `frame: false` + 渲染层自绘窗口控制（app-bar 右上：设置 / 最小 / 最大化 / 关闭），仅 frameless 时显示。
- app-bar 为 `-webkit-app-region: drag` 拖拽区，按钮 `no-drag`；双击标题栏切换最大化。
- 圆角：透明窗口 + `clip-path: inset(0 round 12px)`（能连同 fixed 的 app-bar/抽屉一起裁，`overflow:hidden` 做不到）。
- `window:minimize / toggle-maximize / close / is-maximized` IPC + `maximize/unmaximize` 事件广播。

---

## 8. 应用注册表 apps.json

每个搜索目录下一份 `apps.json`，是"应用 → 一键操作"的注册表。详见 **[APPS.JSON.MD](./APPS.JSON.MD)**。

---

## 9. 配置文件

| 文件 | 作用 |
|---|---|
| `config/config.json` | 全局外壳：theme / uiScale / window.* / runtime.* |
| `config/abilities.yaml` | 侧栏清单 + 各能力 config（镜像列表、搜索目录等） |
| `~/Apps/apps.json` | 每个搜索根的应用注册表（手工优先，扫描器只补充不覆盖） |

---

## 10. 目录结构

```
src/
  main/               # Electron 主进程
    index.ts          # BrowserWindow + 单例 + IPC 接线
    ipc.ts            # window.* / dialog.* / clipboard.* 等 chrome IPC
    commands/          # 能力注入的命令注册表 (CLI-first 核心)
      types.ts         # CommandSpec / CommandContext 契约
      registry.ts      # 命令 Map + runCommand/tryRunCommand/parseArgs
      index.ts         # 汇总各能力命令并 registerAll
      <ability>.ts     # 每能力一个文件，导出 CommandSpec[]
    registry.ts       # abilities.yaml + apps.json 读写 / 文件监听
    scanner.ts        # 应用扫描 (dedup 包装脚本 vs 目录)
    launcher.ts       # exec spec → spawn argv / monitor 输出流
    security.ts       # 目录内容风险扫描
    mirror.ts / systemd.ts / docker.ts / gpu.ts / system.ts / autostart.ts / display.ts
    i18n.ts           # 主进程翻译 (t/te, 读取 renderer 翻译文件)
    icon-protocol.ts  # cockpit-icon:// 协议
    ability-loader.ts # 外部后端能力 (esbuild 即时编译)
  preload/
    index.ts          # contextBridge → window.cockpit.*
    index.d.ts
  renderer/
    App.vue           # 三层宿主 + 侧栏 + app-bar + 弹窗
    main.ts           # Vuetify 初始化
    abilities/<id>/   # 每个能力 (index.ts + View.vue)
    backgrounds/      # Background 预制组件注册表
    components/       # AbilityIcon / GameIcon / BackgroundLayer / FuseLayer / TransformerModal / UiNode / LoadingBar
    icon.ts           # icon 语法解析
    transformer.ts    # ui 组件工厂 + UiNode 描述
    translations/      # 翻译文件: zh.json / en-US.json / index.json
    i18n.ts            # translate/translateTemplate/localize/useI18n
    styles/           # theme.ts (Material tokens) + global.css
  shared/types.ts     # 跨进程共享类型
config/
  config.json / abilities.yaml
scripts/              # pkexec helper 脚本 + polkit 规则
```

---

## 11. 安全模型

- 提权只经 `pkexec` + helper 脚本（`scripts/`），绝不直接开 root shell；polkit 规则见 `scripts/49-cockpit-pkexec.rules`。
- 启动走 `child_process.spawn(argv)`，**禁止 shell 字符串拼接**。
- 每个条目有 `security.risk`（low/medium/high）+ 自动/人工风险备注；中高风险启动前弹确认。
- 按钮背景色编码风险（越深越危险），高风险按钮为深红。

---

## 12. 开发 / 构建

```bash
pnpm dev           # electron-vite dev
pnpm build         # typecheck + build
pnpm typecheck     # tsc + vue-tsc
pnpm lint          # eslint (提交前必须 0 errors)
pnpm format        # prettier (单引号 / 无分号 / printWidth 100)
```

---

## 13. 跨层事件通道（渲染 ← 主进程）

| 通道 | 触发 |
|---|---|
| `cockpit:apps-changed` | apps.json / 目录结构变化（结构事件已去重 + 防抖，忽略 db/log 高频写入） |
| `cockpit:config-changed` | `config.set` 后广播新配置 |
| `cockpit:proc-output` | monitor 模式下的进程输出行 / 退出事件 |
| `cockpit:window-maximized` | 窗口最大化状态变化 |

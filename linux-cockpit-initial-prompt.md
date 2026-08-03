# Initial Prompt — Linux System Cockpit (Electron + Vuetify 3 / Material 3)

You are building a personal **Linux system cockpit launcher** for an Arch Linux + KDE Plasma 6 (Wayland) desktop.
It is a low-frequency, personal tool: beauty and satisfying interactions (「仪式感」) matter MORE than startup speed
or RAM usage. **The UI target is FlClash** — Material 3, dark theme, status-colored buttons, card-grid dashboard.
FlClash is a Flutter app (source at `~/Files/Repos/FlClash/`) — read it as a DESIGN reference only
(`lib/manager/app_manager.dart` sidebar, `lib/views/dashboard/dashboard.dart` grid, `lib/views/theme.dart`
pureBlack). We replicate its look with Vue + Vuetify 3, NOT Flutter — do not copy its Dart code.

## Stack decision (already made — Node ecosystem, runtime-dynamic abilities)

- **Electron (latest stable) + electron-vite + Vue 3 + TypeScript + Vuetify 3** (Vuetify 3 IS Material Design 3
  for Vue — this is the "pre-cooked" FlClash-like UI, no hand-rolled CSS tokens).
- Node v26.5.0, npm 12.0.1 and **pnpm 11.3.0** are installed. **Use pnpm** for everything
  (`pnpm dev` / `pnpm build` / `pnpm create …`) — do not mix npm lockfiles.
- Use npm packages freely (Node ecosystem is the point): `yaml` (manifest), `chokidar` (fs.watch),
  `gridstack` (draggable dashboard grid), `@mdi/font` (Vuetify icons). Charts: tiny inline SVG
  sparklines — no chart library.
- Dark theme default + pure-black mode toggle. Chinese UI labels, English code comments.
- Security: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no remote content.
  All system access in the main process; renderer talks via typed preload API `window.cockpit.*`.
- Single-instance app (e.g. `app.requestSingleInstanceLock()`). No tests/CI/publishing; short Chinese README.

## Project layout

```
Launcher/                          # 项目根 = /home/aaaa0ggmc/Projs/Launcher (prompt 文件就在这)
  src/
    main/                          # Electron 主进程: window + IPC + 系统模块
      index.ts                     # BrowserWindow, single-instance, IPC registration
      ability-loader.ts            # 动态加载能力后端: 扫描目录 → esbuild transform → import()
      registry.ts                  # apps.json 引擎: 读 / 合并 / 编辑 (搜索目录来自 Apps 能力配置)
      scanner.ts                   # 重扫启发式 (只用于日后维护, 不覆盖用户编辑)
      security.ts                  # 风险评估 (内容扫描 / 提权检测 / 网络提示)
      launcher.ts                  # exec spec → child_process.spawn (只用 argv 数组)
      mirror.ts / autostart.ts / systemd.ts / docker.ts / gpu.ts / display.ts
    preload/
      index.ts                     # contextBridge 类型化 API window.cockpit.*
    renderer/
      abilities/                   # ⚠️ 每个能力 = 一个文件夹 (动态加载, 见下)
        dashboard/index.ts         # 总览: 可拖拽卡片网格 (gridstack)
        apps/index.ts              # 应用: 注册表卡片 + 标签过滤 + 编辑 + 启动
        mirror/index.ts            # 软件源
        autostart/index.ts         # 启动项
        systemd/index.ts           # 服务
        hardware/index.ts          # 硬件
        display/index.ts           # 显示与壁纸
        cli/index.ts               # 命令行 REPL
        settings/index.ts          # 设置
      App.vue / main.ts            # 侧栏 (Vuetify v-navigation-drawer) + 页面宿主 + 顶部搜索
      styles/                      # Vuetify 主题配置 (M3 tokens)
  config/
    config.json                    # 全局外壳 ONLY
    abilities.yaml                 # 侧栏清单 + 每能力 config 块
  scripts/                         # root 辅助脚本, 一律经 pkexec 调用
  package.json
```

## Ability architecture — runtime dynamic loading (Node CAN do this; this is why we chose Electron over Flutter)

**Each sidebar feature is one folder under `src/renderer/abilities/<id>/index.ts`** (or a single file
`abilities/<id>.ts`). Sidebar is driven by `config/abilities.yaml` — order/enable/icon/category adjustable,
NOT hardcoded. Abilities load DYNAMICALLY at runtime:

- **Renderer (UI components)**: Vite `import.meta.glob('../abilities/*/index.ts', { eager: false })` +
  `'../abilities/*.ts'` → async `import()` on first show (code-split chunk). New ability folder is picked
  up on dev-server restart (instant) or `npm run build` (prod). No app-logic recompile.
- **Main process (backend logic)**: `ability-loader.ts` scans ability dirs at startup; `.ts` files are
  compiled on the fly with `esbuild.transform` (already a dependency of Vite — zero new deps) → temp `.mjs`
  → native `import()`. Plain `.js/.mjs` load directly.
- **External abilities dir** (default `~/.config/LinuxCockpit/abilities/`): backend-only modules with the
  same contract, merged at startup (backend via esbuild import; their UI ships as part of a built-in ability
  or a later v2 — do not build webview/iframe plumbing now).
- Optional v2: ability backend declares the `window.cockpit.*` channels it uses; main whitelists them.

- **Main-process backend per ability**: each ability's system logic lives in `src/main/<id>.ts`
  (`mirror.ts` ↔ mirror ability), loaded at startup; renderer abilities call it via `window.cockpit.*` IPC.

### Ability contract

```ts
// src/renderer/abilities/apps/index.ts
import type { Ability } from "../types";
export default {
  id: "apps",
  name: "应用",
  icon: "🗂️",                       // emoji | 图片路径 | null → 兜底 "😎"
  category: "system",               // 侧栏分组
  component: /* Vue SFC */,         // 页面组件
} satisfies Ability;
```

### Manifest `config/abilities.yaml` (侧栏由此驱动; 每能力自带 config, 不塞 config.json)

```yaml
sidebar:
  default: cli              # 启动默认页 (原始需求: 主页面是 CLI; 改 dashboard 即换)
  showLabels: true          # false = 纯 icon 栏
  searchBox: true           # 展开时顶部搜索框; 折叠时只留 icon 列
abilities:
  - id: dashboard
    order: 1
    enabled: true
  - id: apps
    order: 2
    enabled: true
    config:                 # ⚠️ 搜索目录归 Applications 组件管, 不假设 ~/Apps 固定
      searchRoots:
        - { path: "/home/aaaa0ggmc/Apps", watch: true }
      confirmBeforeLaunch: true
  - id: mirror
    order: 3
    enabled: true
    config:
      mirrors:
        - { name: "USTC", url: "https://mirrors.ustc.edu.cn/archlinux/$repo/os/$arch" }
        - { name: "TUNA", url: "https://mirrors.tuna.tsinghua.edu.cn/archlinux/$repo/os/$arch" }
        - { name: "Aliyun", url: "https://mirrors.aliyun.com/archlinux/$repo/os/$arch" }
        - { name: "Official", url: "https://geo.mirror.pkgbuild.com/$repo/os/$arch" }
  - id: autostart
    order: 4
    enabled: true
  - id: systemd
    order: 5
    enabled: true
  - id: hardware
    order: 6
    enabled: true
  - id: display
    order: 7
    enabled: true
    config:
      wallpaperDir: "/home/aaaa0ggmc/Pictures/Wallpapers"
  - id: cli
    order: 8
    enabled: true
    config:
      historyLimit: 500
  - id: settings
    order: 9
    enabled: true
```

`config/config.json` — GLOBAL APP CHROME ONLY (theme/language/window/runtime defaults). Domain config
(搜索目录、镜像、壁纸目录…) lives in each ability's `config:` block, NOT here:

```jsonc
{
  "theme": "dark",                // dark | light | system | pureblack
  "language": "zh",
  "window": { "width": 1280, "height": 800 },
  "runtime": {
    "terminal": ["konsole", "--hold", "-e"],   // terminal:true 的条目用这个跑
    "confirmBeforeLaunch": true
  }
}
```

## Sidebar + search

Expanded sidebar: top search box (filters abilities AND quick-launches registry apps by name/alias/tag) +
grouped ability list (icon + label). Collapsed: icon rail only. Sidebar bg `surface-variant`, content
`surface` (Vuetify theme tokens). Implement with Vuetify `v-navigation-drawer` + custom rail mode.

## App registry — apps.json design (THE core)

Search roots are configured in the Apps ability config, managed in Settings/Apps UI. No roots → Apps page
shows an empty state with an "add search directory" call-to-action.

Each search root R holds `R/apps.json`. **Initial generation is YOUR job (this build): write a complete,
hand-written `~/Apps/apps.json` per the schema below, covering every entry in "Verified system facts".**
The scanner exists only for later maintenance rescans and must never clobber user edits.

### apps.json — full field spec

```jsonc
// ~/Apps/apps.json   (每个搜索根目录各一份)
{
  "version": 1,
  "apps": {
    "<entry-id>": {                 // key: 小写连字符, 根目录内唯一
      "alias": "bv",                // CLI 快捷名; 缺省 = entry-id
      "name": "bili-viewer",        // REQUIRED 显示名
      "description": "B站终端观看器",
      "path": "bili-viewer",        // REQUIRED; 相对根目录 或 绝对路径(零散目录条目)
      "icon": "auto",               // 图片路径(.png/.svg/.webp/.jpg) > emoji > "auto" > 兜底 "😎"
      "exec": {                     // REQUIRED
        "type": "uv",
        "command": ["bili-viewer"],
        "args": [],
        "cwd": "{self}",            // "{self}" = 条目所在目录; 缺省 = path 所在目录
        "env": { "KEY": "VAL" },
        "terminal": false,          // true → config.json runtime.terminal
        "root": false               // true → 经 pkexec 提权
      },
      "tags": ["media"],            // 用户手打, 扫描不覆盖
      "tags_auto": ["python", "cli"], // 扫描器生成
      "security": {
        "risk": "medium",           // "low"|"medium"|"high" REQUIRED
        "auto_note": "检测到 curl | sh 下载行为",
        "note": "自用服务, 别暴露公网",
        "acknowledged": false       // 勾过"不再提醒"后 true
      },
      "managed": true               // false = 冻结, 扫描器跳过
    }
  }
}
```

**Icon image loading**: the renderer is sandboxed — `file://` URLs are blocked in `<img>`. Load image
icons via a custom protocol (register in main, e.g. `cockpit-icon://<abs-path>`) or read the file in
main and return a data URL over IPC. Never rely on `file://`.

### exec.type — exact semantics (generation MUST follow these)

| type | expansion | command 语义 |
|---|---|---|
| `uv` | `uv run --directory <cwd> <command...> <args...>` | 入口名, 如 `["bili-viewer"]` |
| `python` | `<cwd>/.venv/bin/python <command...>` (无 .venv 则 python3) | 脚本或 `-m 模块` |
| `node` | `node <command...>` | 如 `["app.js"]` |
| `docker` | `docker <command...> <args...>` | 完整, 如 `["start","new-api"]` |
| `systemd` | `systemctl --user <command...>` (root:true 则 systemctl) | 如 `["start","myservice"]` |
| `script` | 直接执行 path (不可执行则提示 chmod +x) | 忽略 |
| `desktop` | `gio launch <path>` | 忽略 |
| `custom` | `command` 即完整 argv, 零包装 | — |

Defaults: `cwd` = path 所在目录; `env` = {}; `terminal` = false; `root` = false.
Launch = expand → argv array → `child_process.spawn(argv, { cwd, env })`. NEVER shell string concatenation
(the Windows C++ launcher's `system()` passthrough is the anti-pattern).

### Validation (generator MUST satisfy)

- `name`/`path`/`exec` required; `path` must exist; `exec.command` required for docker/systemd/custom.
- `risk` ∈ {low, medium, high}; `version` == 1; entry-id = lowercase kebab.
- Every written entry must be launchable — verify each exec spec against the system facts below.

### Merge policy (rescan safety — scanner behavior, later)

1. Rescan root → auto-draft per detected entry. 2. `managed:false` → skip. Existing → update ONLY
`tags_auto` + `security.auto_note`; fill `description`/`exec`/`icon`/`security.risk` only if absent/null.
3. Undetected → keep, mark `"missing": true` (UI: grayed badge). 4. `chokidar` watch on roots + apps.json.

### Launch & security reminder flow

- `root:true` → pkexec helper script. `terminal:true` → runtime.terminal program.
- risk ≥ medium && !acknowledged → confirm dialog (auto_note + note + "知道了,以后不再提醒" checkbox).
- Risk badge always visible on card: green=low, amber=medium, red=high.

## The toggle pattern (the「仪式感」core)

Every state change: **status-colored button (green=ok, red=off/error, spinner=working) → confirm dialog →
execute → immediate color/icon flip.** Vuetify: `v-btn` with dynamic color + `v-progress-circular` inside,
mirroring FlClash's connection button.

## UI quality guardrails (make "ugly" hard — you are a text-only model, follow strictly)

1. **Colors**: ONLY from the Vuetify 3 theme tokens (primary / on-primary / surface / surface-variant /
   on-surface / secondary-container / error / on-error…). NEVER invent hex colors. Layering: content
   `surface` < sidebar/raised `surface-variant` < cards on raised surfaces elevated `surface` variants —
   prefer tonal layering over drop shadows.
2. **Radius**: Vuetify defaults (`rounded="lg"` cards ~12px, dialogs ~16px, FABs ~28px). Consistent.
3. **Spacing**: 4/8/12/16 grid only; card padding 16; grid gaps 14.
4. **Typography**: use Vuetify typography classes / app-level font scale — no ad-hoc sizes.
5. **Status colors** (green/amber/red) are SEMANTIC ONLY: ok / working / off / error on toggles and badges.
   Never decorative.
6. **No gratuitous effects**: no gradients, no drop shadows, no custom animations beyond
   `<transition>` fade/scale. Dark surfaces are flat.
7. **Components**: prefer Vuetify 3 built-ins (`v-card`, `v-btn` + tonal/filled variants, `v-switch`,
   `v-chip`, `v-navigation-drawer`, `v-dialog`, `v-text-field`) over custom-painted DOM.
8. **Density**: compact (`density="compact"`) like FlClash on desktop.

## Verified system facts (do not rediscover — these are real)

- node v26.5.0, npm 12.0.1 (system)
- `/etc/pacman.d/mirrorlist` currently: `Server = https://mirrors.ustc.edu.cn/archlinux/$repo/os/$arch`
- `~/.config/autostart/`: `Clash Verge.desktop`, `FlClash.desktop`, `lunarclient.desktop`, `OpenList-Desktop.desktop`, `study-reminder.desktop`
- Docker: container `new-api` running (entry: type=docker, command `["start","new-api"]`)
- `/etc/modprobe.d/nvidia-pm-override.conf`: `options nvidia NVreg_PreserveVideoMemoryAllocations=0` (toggle 0↔1; reboot required)
- GPU: NVIDIA GeForce RTX 5060 Laptop, driver 610.43.03 (nvidia-open)
- Tools present: `plasma-apply-wallpaperimage`, `kscreen-doctor`, `pkexec`, `nvidia-smi`, `docker` (user in docker group, no sudo)
- `~/Apps/` inventory — **generate initial apps.json entries for ALL**:
  - dirs: `bili-viewer` (uv run), `balance_checker`, `LangBot`, `Lyrica`, `mcp-omnisearch`, `MediaCrawler`,
    `newapi` (docker new-api), `Music` (node app.js, terminal), `Image`, `mysql`, `gallery-dl`,
    `ncmdump`, `ncm_info`, `Novels`
  - scripts (type=script): `start_ais` (= `docker start new-api`), `start_music`, `start_lyrica`,
    `start_crawler`, `bili-viewer.sh` (uv run)
  - data-only dirs (`Image`, `Novels`): type=custom, `command: ["xdg-open", "."]`
  - Unknown projects: best-guess exec + `"risk": "medium"` (user reviews every entry in the UI anyway)

## Constraints

- **KDE Plasma 6 Wayland**: `.desktop` autostart `Exec=` MUST be absolute paths — `systemd-xdg-autostart-generator` does NOT expand `%h`/`$HOME`.
- Root ops ONLY via `pkexec` + helper scripts in `scripts/`; always back up before modifying.
- NEVER shell-concat for launching. Poll systemd/docker/GPU every 3–5s; chokidar watch roots/autostart/mirrorlist.
- Must run on KDE Wayland (check Electron ozone flags if needed).

## Milestone 1 — build in this order, verify each step runs

1. Scaffold (`pnpm create @quick-start/electron@latest . --template vue-ts` or equivalent; if it refuses
   the non-empty project dir, scaffold in a temp subdir and move files in), add Vuetify 3, dark M3 theme +
   pureBlack, ability loader, sidebar from abilities.yaml with top search box, 9 ability folders as skeletons.
2. **Generate hand-written `~/Apps/apps.json`** (schema above, ALL inventory entries); Apps page renders
   cards (icon/description/tags/risk badge); editing persists back to the file.
3. Launcher: bili-viewer (uv) and new-api (docker) launch for real; risk ≥ medium shows confirm dialog.
4. Dashboard with REAL data (host/GPU/docker/RAM/disk), drag-reorderable grid (gridstack).
5. Mirror page: working USTC/TUNA/Aliyun switch (pkexec + backup + confirm).
6. Autostart page: enable/disable toggles working.
7. CLI page: REPL, alias launch, tab completion, `info <alias>`.
8. Reorder abilities in abilities.yaml → sidebar follows on restart; add a throwaway 10th ability folder →
   it appears after restart (proves dynamic loading).

Verify with `npm run dev` on this machine. Report exactly what works and what needs manual testing.

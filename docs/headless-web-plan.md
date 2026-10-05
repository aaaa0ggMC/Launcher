# 网页 / 无头 / 移动端 计划

> 当前优先级（2026-10-04 定）：**移动端适配 + Web / GUI 稳定**。
> 实现细节与约定见 `AGENTS.md`「无头宿主 / 网页模式 / Termux」一节；本文只记**目标、现状、待办与验收**。

## 1. 目标

1. **一个宿主、多个客户端**：Electron 窗口与浏览器（桌面 / 手机）连到**同一个**后端，状态（后台任务、播放、租约、授权、AI 会话）天然共享。
2. **手机浏览器可用**：外壳与常用页面在 ≈400px 宽度下不溢出、可点按、输入不被遮挡。
3. 无头宿主（纯 Node，Termux / 无桌面机器）保留，但定位是「没有 Electron 的场景」，不再是第二套要补齐的完整实现。

## 2. 现状（已做）

- 命令总线抽象：`createCockpit(transport)`（Electron preload 与网页 shim 共用）；`electron` 构建期替身；HTTP + SSE + `/_p/` 协议路由；token 鉴权。
- caps 三档（`native | web | none`）+ `BackgroundDef.requires`；宿主文件选择器（`host.fs.list`）。
- 密钥库：`vault.rewrap-scrypt`（safeStorage → scrypt，已接受降低保护强度）。
- 安装：`patches/electron.patch`（android 跳过下载）、`overrides: yauzl@^3`（Node 26 解压）。
- 外壳移动端：`sidebar.mode`（auto / always / overlay）、logo 菜单按钮、viewport meta、`--app-vh`（dvh）、命令行输出可点击链接。
- 构建：`pnpm dev:web`、`pnpm pack:headless`、`pnpm build:headless --only a,b`。

## 3. 已知缺口（要正视）

| 缺口                                                                         | 后果                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| Electron 与无头宿主是**两个进程**，内存状态不共享，磁盘文件各自读改写        | 两边同时用会互相覆盖配置；后台任务 / 播放各开各的      |
| agent 系统（MCP / Remote / 隐私授权窗口 / ui 检查器 / agent 视图）未接入网页 | 网页里涉及授权的操作只能被拒；AI 无法操作网页界面      |
| 缩略图（`nativeImage`）在网页模式退回原图                                    | 照片很多的页面（yarj）慢                               |
| `electron` 替身把未知调用 nop 掉                                             | 能力里新增的 Electron 用法在网页里「没反应」而不是报错 |
| `pnpm build` 不含 `build:headless`，无任何冒烟测试                           | 网页构建可能悄悄坏掉                                   |
| 各能力页面未按手机宽度巡检                                                   | 溢出 / 挤压 / hover-only 交互                          |
| Termux 真机未验证（`usocket` 编译、`pidusage`、`esbuild` android 包）        | 手机本机宿主可能装不上 / 部分能力不准                  |

## 4. 计划

### A. Web / GUI 稳定（先做，优先级最高）

- **A1 内嵌网页服务进 Electron** —— 设置 → 开关（`web.enabled` / `host` / `port`，默认关，沿用 token）。复用 `src/headless/server.ts`；Electron 的 `broadcast` 同时推窗口与 SSE；`command:run` 的来源打标（ui / agent-ui）保持一致。验收：GUI 里开一个后台任务，网页里能看到并停止；两边同时放歌只有一路。
- **A2 防止两个宿主抢同一份数据** —— 无头宿主启动时探测已运行的 Electron 宿主（端口 / 锁文件），默认拒绝并提示「请直接访问 Electron 内嵌的网页服务」，`--force` 才继续；`config.set` 写入加文件锁或至少保留 `.bak`（AGENTS §11.7 已要求）。
- **A3 冒烟测试** —— `build:headless --only cli,logs` → 启动 → 断言 `/api/info`、`/api/command`、401、`/_p/` Range；放进 `pnpm test`（或单独 `pnpm test:web`），HOME 隔离（§11.7）。
- **A4 替身不静默** —— `electron-stub` 对**未显式实现**的成员，首次被调用时 `log.warn('electron stub: <path> is a no-op in headless')`（每个路径一次），把「悄悄没反应」变成可见日志。
- **A5 caps 审计** —— 逐个梳理渲染端对非命令 `window.cockpit.*` 的调用（`pickFile` 31 处、窗口类、`autoFitWindow` 等），确认每个都有 caps 守卫或可接受的 nop；补 `window.child`（子窗口）的网页降级方案（页内浮层 or 新标签）。
- **A6 agent / 隐私在网页** —— 先定方案再动手：授权请求推到**用户本人的网页页面**确认（不能做成命令，沿用 `privacy:decide` 的 sender 校验思路）；agent 视图在网页下明确禁用。依赖 A1（同一宿主才有意义）。
- **A8 上传目录清理** —— `uploads/` 里的文件只增不减：设置里加「清理上传文件」/ 超过 N 天自动清理（注意：已被配置引用的路径，如背景图，不能误删，需先按引用扫描）。
- **A7 缩略图** —— 用 ffmpeg / sharp 替代 `nativeImage`（先量一下 yarj 页面的实际代价再决定）。

### B. 移动端适配

- **B1 巡检脚本** —— `scripts/mobile-audit.mjs`：CDP 设备模拟 400×860，逐个能力页截图，并检测 `scrollWidth > clientWidth`、可点击元素 < 44px、固定宽度元素；产出报告（按严重度排序）。**先做它，再谈逐页修。**
- **B2 逐页修复** —— 按 B1 报告的严重度，遵循 `DESIGN.md` 与 AGENTS §11.8（按**容器宽度**自适应，宽度不够换布局而不是出横向滚动条）。优先常用页：aidj、apps、settings、playground、logs、cli、ft。
- **B3 触控** —— hover-only 交互给出点按替代；右键菜单（`entry-actions`）给长按 / 「⋯」按钮；点击目标 ≥ 44px。
- **B4 软键盘** —— 输入框被遮挡时用 `visualViewport` 调整（聊天框、命令行）。
- **B5 PWA（可选）** —— manifest + 图标，「添加到主屏」，全屏外壳。
- **B6 Termux 真机清单** —— 记录 `pnpm pack:headless` 解包 + `npm install --omit=dev` 的真实结果、`pidusage` / `usocket` / `esbuild` 的表现，更新 AGENTS 与本文。
- **B7 体积** —— 渲染端主 chunk 约 2.8MB（gzip 860KB），手机首屏慢；评估按能力拆分 / 懒加载（`--only` 已可裁剪）。

## 5. 顺序建议

`A3`（先上冒烟测试，后面改动才有保护）→ `A1` → `A2` → `B1` → `B2`（与 A4 / A5 穿插）→ `A6` → `B3/B4` → `A7 / B5 / B7`。

## 6. 决策记录

- 宿主能力用 **caps 三档**表达，不在 UI 里判断「是不是 Electron」。
- 密钥库为易用性接受 scrypt（机器指纹）而非系统钥匙环；**不跨机器**，手机本机宿主需重填密钥。
- `pnpm install` 的平台差异用 **pnpm 补丁**（运行时判断，锁文件各平台一致），不用 `.pnpmfile.cjs`（会改写锁文件 / `--frozen-lockfile` 报错）。
- `100vh` 一律用 `var(--app-vh)`（dvh 优先）。
- 手机上**不要在本机构建**：桌面机 `pnpm pack:headless`，或手机上用 `--only` 裁剪。

## 7. 验收（本阶段结束时）

- Electron 与浏览器同时连同一宿主，状态一致；无头宿主不会误抢 Electron 的数据。
- `pnpm test` 含网页冒烟；网页构建坏了会红。
- B1 报告里「严重」项清零；常用页在 400px 宽度下无横向滚动、无被截断的主要操作。
- Termux 真机安装与启动有记录（成功或明确的失败原因）。

## 8. 进度（2026-10-04）

**B 组（移动端）**

- B1 巡检：用 CDP 设备模拟（400px）对 24 个页面逐页量横向溢出 + 截图人工过一遍（未做成可重复的脚本，仍是手工）。**所有页面横向溢出为 0。**
- B2 逐页修复：已完成 aidj（状态栏紧凑弹层、触屏交互、播放器 / 统计 / 菜单、聊天顶栏、歌词页）、ft / playground / scripting / logs / apps 页头 / 快捷键 / agent 设置、后台任务面板（主从布局）、帮助浮窗、内核防线 / 掌机工具栏、biliviewer 播放器（弹幕缩放 + 触屏手势）。
- B3 触控：aidj 长按菜单、会话「⋯」、歌单上下移、biliviewer 手势已做；其余页面的 hover-only tooltip 未逐个确认。
- B4 软键盘：外壳高度随 `visualViewport` 变化，聊天输入框不被挡；各页塌陷情况未逐页评估。
- 未做：yarj 页面逐项（地图交互）、campusinfo 等需登录页面的真实数据态、360px 下的表现、B5 PWA、B7 体积。

**A 组（Web / GUI 稳定）**

- A3 冒烟测试：`src/headless/server.test.ts`（鉴权 + 广播载荷改写）已进 `pnpm test`；`build:headless` 本身还没进 CI。
- 已修：SSE 广播载荷里的自定义协议地址（网页里点播放没反应）、COOP/COEP（掌机）。

## 9. 进度（2026-10-05）

- **SSE 断线**：同一 clientId 重连改为顶替旧连接（原来回 409 → 浏览器永久放弃重连）；页面侧退避重连 + 45s 无帧（含 15s 具名 ping）主动重建 + 前台 / 联网时检查，重连后派发 `cockpit:host-reconnected` 供页面重新同步。
- **A3 完成**：`pnpm test:web`（`scripts/smoke-web.mjs`）构建到 `out/.smoke`（`build-headless --out`，不覆盖正在用的 `out/`），临时 HOME 启动，检查静态页 / 401 / 命令 / SSE / `/_p/` Range / `web.status` / 宿主锁。
- **A1 完成（待实机验证）**：`src/main/process/web-host.ts`，`config.json` 的 `web: { enabled, host, port }`（默认关，设置 → 外观 → 网页服务；agent 不能改 `web`）。复用 `src/headless/server.ts`，自定义协议经 `net.fetch` 走 `protocol.handle`；Electron 的 `broadcast` 同时推 SSE；授权请求桌面窗口与网页悬浮窗同时显示；来自浏览器标签页的 `ui.*` 走该标签页的 DOM 桥。网页资源 `pnpm build:web`（`pnpm build` 已包含）。几处 `getAllWindows()` 广播改走广播中心。
- **A2 完成**：`~/.config/LinuxCockpit/host.lock`（`src/headless/host-lock.ts`）。无头宿主发现另一个宿主在跑时拒绝启动并提示（`--force` 继续）；Electron 发现无头宿主在跑时不开网页服务（状态里给出原因）。
- **A4 完成**：替身里没显式实现的成员被调用时，每个路径 `console.warn` 一次（`[electron-stub] dialog.showMessageBox() is a no-op…`）。
- 未做：A5–A8。

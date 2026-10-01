# Agent Access 设计：Remote / MCP / 隐私许可（Clearance）

> 状态（2026-10-01）：**P0 隐私 SDK、P1 inspector、P2 Remote、P3 MCP 已实现**（未提交）；P4（脚本沙箱 + 提权）、P5 未开始。
> 实现与设计的差异：Remote 用 HTTP JSON-RPC（`POST /rpc`）而非 WebSocket，免额外依赖、curl 可直接调用；`guard` 最多等 45s，未决则抛 `privacy_pending` 并**放弃本次动作**（批准后重试），避免动作在调用方超时后才执行。
> 范围：让脚本 / AI 通过 **Remote**（本地 WebSocket JSON-RPC）或 **MCP** 操控 Launcher——跑命令、读懂并点击 UI、执行脚本；同时用一套**隐私 SDK** 保证隐私数据默认对它们不可见，只有用户在 AI 够不着的窗口里点了同意才放行。

---

## 0. 结论先行

1. **一个网关，两种传输**。主进程新增 `AgentGateway`，Remote 和 MCP 都只是它外面的一层壳，能力完全一致。默认全部关闭；可在设置里打开，也可以用 `--with-remote` / `--with-mcp` 只对本次运行开启（不写盘）。
2. **UI 解析也遵守 CLI-first**。`ui.snapshot` / `ui.click` / `ui.type` 等是普通注册命令，CLI 里也能用；AI 拿到的是带 `ref` 的可交互树（类似 Playwright 的 aria snapshot），比 toMarkdown 精细。
3. **隐私保护是 SDK，不是网关里的过滤器**。和 `encrypt.ts` 一样：框架提供 `src/main/process/privacy.ts`（主进程）+ `src/main/ui/privacy.ts`（渲染端指令/组件），**各 ability 在产生数据的地方自己 wrap**。网关只负责打上「调用来源（origin）」，SDK 根据 origin 决定给明文还是占位符。
4. **默认脱敏，显式申请**。AI 看到的是 `«redacted:campusinfo.identity»` 这样的占位符，它知道该申请哪个 scope；调用 `request_clearance` 后弹出**独立的授权窗口**（AI 看不到也点不到），AI 只会收到 `pending`，等待用户决定。
5. **同意窗口必须在 AI 的操控范围之外**——这是整个设计里最容易出问题的一点：AI 能点 UI，所以「允许」按钮绝不能放在主窗口的 DOM 里，「永久授权」开关也不能被 AI 点到或用 `config.set` 改掉。
6. **只有「调用方决定执行什么」才算 exec**。`sh` / `background.start` / `launch.run` 这类由调用方给出任意命令行或代码的入口，能直接 `cat` 配置文件，所以需要许可（`system.exec`）。能力内部用固定参数调用外部程序的命令（如 yarj 调 ffprobe、`yarj.open-path`）只是普通命令，agent 和脚本可以直接用。会改变系统状态、但行为固定的命令（systemd / docker / 镜像源 / 壁纸…）归入 `system.control`，由用户在设置里选择是否需要询问。AI「轻松执行脚本」走沙箱脚本（只能调命令、经过同一套 SDK）。

---

## 1. 威胁模型（防什么、不防什么）

| 防                                                               | 不防                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| AI 在正常工作中**顺带**看到学号、余额、密码等（最常见）          | 本机已登录用户 / root 的恶意程序（`encrypt.ts` 也不防）                 |
| 网页 / 歌词 / 文件内容里的 **prompt injection** 诱导 AI 外泄隐私 | 用户已授予 exec 许可之后，AI 刻意绕过（届时它有 shell，等价于用户本人） |
| AI 自己点「显示」、改设置、点授权按钮来绕过                      | 局域网 / 公网攻击（v1 只监听 `127.0.0.1`，见 §6.3）                     |
| 浏览器网页通过 `localhost` 端口发起 CSRF / DNS rebinding 攻击    |                                                                         |

**由此得出的原则**：防护是「诚实边界 + 不可自助提权」。所有能让 AI 自己给自己授权的路径（点击、命令、配置文件、脚本）都必须堵上，或者归入 exec 许可。

---

## 2. 总体架构

```
 外部 AI / 脚本
   │  MCP (Streamable HTTP /mcp)  ──┐      stdio MCP 客户端
   │  Remote (WebSocket JSON-RPC) ──┤◀──── scripts/cockpit-mcp.mjs (stdio↔HTTP 桥)
   ▼                                ▼
 ┌──────────────── src/main/process/agent/ ────────────────┐
 │ server.ts      监听 127.0.0.1、token 认证、Origin 校验   │
 │ gateway.ts     会话、工具表 → registry/ui/privacy        │
 │ mcp.ts         MCP 工具/资源映射（@modelcontextprotocol/sdk）│
 │ remote.ts      JSON-RPC 方法映射                          │
 │ inspector.ts   CDP：AX 树 / 截图 / 可信输入               │
 │ sandbox.ts     沙箱脚本子进程                             │
 │ consent.ts     授权请求队列 + 授权窗口                    │
 └───────────────┬──────────────────────────────────────────┘
                 │ withOrigin({kind:'mcp', session}) ── AsyncLocalStorage
                 ▼
   commands/registry.runCommand ──► ability commands ──► privacy SDK (shield / guard)
```

### 2.1 调用来源（Origin）—— 唯一的贯穿概念

```ts
// src/main/process/privacy.ts
export type OriginKind = 'ui' | 'cli' | 'remote' | 'mcp' | 'script-agent'
export interface CallOrigin {
  kind: OriginKind
  session?: string // agent 会话 id（同一 MCP 连接 / WS 连接）
  client?: string // MCP clientInfo.name / remote hello 时声明的名字
}
export function withOrigin<T>(o: CallOrigin, fn: () => T): T // AsyncLocalStorage.run
export function currentOrigin(): CallOrigin // 默认 { kind: 'ui' }
export function isAgent(): boolean // remote | mcp | script-agent
```

- 网关里的每个调用都包在 `withOrigin` 中，**嵌套调用自动继承**：AI 跑的脚本里调用 `ctx.command(...)`，或者命令内部再调用命令，origin 仍然是 agent。
- `ipc.ts` 的 `command:run` 固定为 `ui`；`cli.ts` 为 `cli`。**渲染端无法自报 origin**（不然 AI 点按钮 → 渲染端发 IPC 就绕过了）。
- 那「AI 点按钮 → 渲染端拿到完整数据」算泄漏吗？不算：数据只进了渲染端，AI 要看还得经过 `ui.snapshot` / 截图，而这两条出口按 DOM 标签脱敏（§4）。**所以防护针对的是出口（egress），不是入口。**
- 后台任务：作业由 agent 发起时，在 task 元数据上记录 `origin`；`background.output` 被 agent 读取时，对 **ui 发起的任务**输出做出口脱敏（§3.5）。

---

## 3. 隐私 SDK（核心）

### 3.1 级别

| 级别        | 含义                                                  | 例子                                                     | 对 agent 的默认行为                  |
| ----------- | ----------------------------------------------------- | -------------------------------------------------------- | ------------------------------------ |
| `public`    | 无隐私                                                | 系统负载、命令列表                                       | 直接可见                             |
| `personal`  | 简单个人数据，**不能关联到真实身份**                  | B 站 uid / 昵称 / 粉丝数、播放历史、歌单、日志、应用列表 | **默认可见**（设置里可改成需申请）   |
| `sensitive` | 敏感个人信息，**能关联到真实的人**，或涉及金钱 / 位置 | 真实姓名、学号、手机、余额、成绩、IP/MAC、照片 GPS       | **脱敏**，可申请 clearance           |
| `secret`    | 凭据                                                  | 密码、API Key、Cookie/SESSDATA、token                    | **永不可见**，即使授权也只能写不能读 |

判定 personal 还是 sensitive 的标准：**这条数据单独泄露出去，能否定位到现实中的某个人，或造成财产损失**。能 → sensitive；不能 → personal。同一个 ability 可以两种都有（例如 bilistats：uid/粉丝数是 personal；如果接口返回了实名或手机号，那一项是 sensitive）。

另有两个**能力类** scope（不是数据，是「能做什么」）：

| scope            | 判定                                                     | 例子                                                                                                       | 对 agent 的默认行为                     |
| ---------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `system.exec`    | **调用方决定执行什么**（任意命令行 / 代码 / 可执行路径） | 完整模式脚本的 `sh`/`exec`、`background.start`、`launch.run`、`apps.create/update`（可写入任意 exec 字段） | 需申请 clearance                        |
| `system.control` | 行为固定，但会改变系统状态                               | `systemd.action`、`docker.action`、`display.apply`、`autostart.toggle`                                     | **用户可选**：允许 / 每次询问，默认允许 |

需要 root 的固定操作（`mirror.toggle`、`hardware.pm-toggle`）不走 `system.control` 开关，而是走 §5.5 的提权规则：AI 发起时**每次都要用户输入系统密码**，不共享用户的 pkexec 缓存；免密时长需要在设置里另外开启。

> 为什么能力内部跑 bash 不算 exec：例如 yarj 用固定参数调 ffprobe / exiftool，调用方只能决定「处理哪个文件」，决定不了「执行什么」，这和 agent 直接调命令没有区别，所以不设门槛。只有当调用方能把任意字符串送进 shell / spawn 时，它才能绕过整个隐私 SDK，这才是 exec。实施时逐个检查命令：凡是把调用方参数拼进 `bash -c` 的，要么改成 argv 形式，要么标 `system.exec`。

> `secret` 不开放读取的理由：AI 能做的任何正当事情都不需要读到密码明文，需要的话由命令在内部使用（例如 `campusnet.connect` 自己解密）。

### 3.2 Scope 声明（每个 ability 自己的 `privacy.ts`）

```ts
// src/abilities/campusinfo/privacy.ts
import { definePrivacyScopes } from '../../main/process/privacy'

export const P = definePrivacyScopes('campusinfo', {
  identity: { level: 'sensitive', label: 'campusinfo.privacy.identity' }, // 学号/姓名/证件
  contact: { level: 'sensitive', label: 'campusinfo.privacy.contact' }, // 手机/邮箱
  finance: { level: 'sensitive', label: 'campusinfo.privacy.finance' }, // 卡余额/消费
  grades: { level: 'sensitive', label: 'campusinfo.privacy.grades' },
  credential: { level: 'secret', label: 'campusinfo.privacy.credential' }
})
// P.identity === 'campusinfo.identity'
```

- scope id = `<ability>.<name>`，翻译键放在该 ability 的 translations 里（授权窗口要显示「AI 想查看：华中大信息 · 身份信息」）。
- 主进程启动时由 abilities-loader 顺手收集（glob `src/abilities/*/privacy.ts`），供设置页列出、授权窗口显示。

### 3.3 主进程 API（和 `encryptSecret` 一样，用在产生数据的地方）

```ts
/** 同步脱敏：非 agent 原样返回；agent 且无 clearance → 占位符。最常用。 */
shield<T>(scope: string, value: T): T | Redacted
/** 深层脱敏：对象里按 key → scope 的映射批量处理（campusinfo 的 sensitive 字段模型直接用）。 */
shieldFields<T>(obj: T, map: Record<string, string> | ((key, value, parent) => string | null)): T
/** 阻塞许可：agent 调用时若无 clearance → 弹授权窗口并等待；拒绝 → 抛 PrivacyDeniedError。用于「动作」。 */
guard(scope: string, reason?: string): Promise<void>
/** 仅判断，不弹窗。 */
hasClearance(scope: string): boolean
/** secret 专用：agent 永远拿到占位符，不弹窗。 */
secret<T>(value: T): T | Redacted
```

占位符统一为字符串 `«redacted:<scope>»`（类型 `Redacted`），AI 能读懂、也知道该申请哪个 scope；数字字段同样替换成字符串，**故意破坏类型**，避免 AI 把 `0` 当成真实余额。

**用法示例**

```ts
// campusinfo/sections.ts —— 已经有 sensitive 标记的字段模型，一行接入
return shieldFields(section, (k, v, parent) =>
  parent?.sensitive ? (parent.scope ?? P.identity) : null)

// campusnet/commands.ts
run: async (ctx) => {
  const reveal = boolOf(ctx.named.reveal)
  const cfg = await getConfig(reveal)
  return { ...cfg, password: secret(cfg.password) } // --reveal 对 agent 无效
}

// 动作：AI 想改校园网账号
run: async (ctx) => { await guard(P.credentialWrite, 'modify campus account'); ... }
```

### 3.4 命令级声明（兜底 + 给 AI 的提示）

`CommandSpec` 新增可选字段：

```ts
privacy?: {
  /** 结果里可能含的 scope —— 写进 commands_list，AI 事先知道 */
  reads?: string[]
  /** 整个命令对 agent 需要 clearance（动作 / exec 类）；框架在 run 前调用 guard */
  requires?: string[]
  /** agent 永远不可调用（如修改 agent 设置本身） */
  agent?: 'deny'
}
```

**默认规则（兜底，防止漏标）**：

- 未声明 `privacy` 的命令对 agent **可调用**，但框架会对结果再做一遍**模式脱敏**（key 名命中 `password|passwd|token|secret|apiKey|cookie|sessdata|authorization` → `secret`），并在审计日志里记 `unclassified`。
- `config.set` / 任何 `*.config.set` 被 agent 调用时，补丁里 `agent.*` 键一律拒绝。

### 3.5 出口脱敏的其他通道

| 通道                         | 处理                                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `logs.query` / `logs.export` | 级别 `personal`；附加模式脱敏（同上 key 模式 + 已知 secret 值指纹：SDK 维护一个「本次运行解密过的 secret 值」集合，日志行里出现就替换） |
| `background.output`          | agent 读取 **非 agent 发起**的任务 → 同上模式脱敏；agent 自己发起的任务原样（数据本来就是它的命令拿到的，已经脱敏）                     |
| 剪贴板                       | 不提供剪贴板读取命令（写入可以）。「复制为 Markdown」本身已遵守遮盖状态                                                                 |
| 文件导出后再读               | 读任意文件需要 exec / 文件系统能力 → 归 `exec`                                                                                          |

### 3.6 渲染端 SDK（`src/main/ui/privacy.ts`）

```vue
<!-- 指令：给 DOM 打标签，子树都受保护 -->
<div v-privacy="'campusinfo.identity'"> ... </div>
<!-- 禁区：AI 不能读也不能点（授权相关设置、token 显示） -->
<section v-agent-forbidden> ... </section>
<!-- 组件：MaskedText 泛化成框架组件，自动带 v-privacy -->
<PrivacyText scope="campusinfo.identity" :value="sid" />
```

- 指令只做一件事：设置 `data-privacy="<scope>"` / `data-agent="forbidden"`。**不改变用户看到的东西**。
- `campusinfo/MaskedText.vue` 迁移为 `src/main/ui/components/PrivacyText.vue`（行为不变：默认打码、点击切换、不冒泡），新增 `scope` prop。campusinfo 的 `sensitive` 字段模型改为携带 `scope`（缺省 `identity`）。
- `<input type="password">` 和带 `secret` 的输入框由 inspector 自动视为 `secret`，不依赖标注。

---

## 4. UI 解析与操控（Inspector）

### 4.1 为什么用 CDP

Electron 的 `webContents.debugger` 可以直接在进程内使用 Chrome DevTools Protocol，**不需要** `--remote-debugging-port`：

- `Accessibility.getFullAXTree` → Chromium 官方的无障碍树：role / name / value / checked / disabled / focusable，正好就是「clickable / inputable」的语义来源。
- `DOM.*` → 读 `data-privacy` / `data-agent`，并用 `backendDOMNodeId` 和 AX 节点对上。
- `Input.dispatchMouseEvent` / `Input.insertText` / `Input.dispatchKeyEvent` → **可信输入**（`isTrusted=true`），Vuetify 组件按真实用户操作处理。
- `Page.captureScreenshot` → 截图。

> 待验证：DevTools 打开时 `debugger.attach` 是否冲突。冲突时回退方案是在 isolated world 里注入遍历脚本（`executeJavaScriptInIsolatedWorld`），点击改用 `webContents.sendInputEvent`。

### 4.2 快照格式

`ui.snapshot [--window main] [--root <ref>] [--mode interactive|full]`

```yaml
page: campusinfo            # 当前侧栏页（ability id）
window: main  viewport: 1280x800  zoom: 1.1
- navigation "侧栏" [ref=e1]
  - button "华中大信息" [ref=e2] [selected]
  - button "AI DJ" [ref=e3]
- main
  - tablist [ref=e10]
    - tab "概览" [ref=e11] [selected]
    - tab "学业" [ref=e12]
  - group "个人信息" [privacy=campusinfo.identity]
    - text "学号" ; value «redacted:campusinfo.identity»
    - button «redacted:campusinfo.identity» [ref=e15] [privacy-action]   # 点击=揭示，受保护
  - textbox "搜索" [ref=e20] value=""
  - region [forbidden]                                                  # 子树不展开
```

规则：

- **ref**：`e<n>`，内部映射到 `backendDOMNodeId`；每次 snapshot 刷新映射。节点被移除 → 操作返回 `stale_ref`，提示重新 snapshot。
- `interactive` 模式（默认）只保留可交互节点及其承载上下文的祖先（landmark / group / heading），控制在几 KB 以内；`full` 包含全部文本。
- **脱敏按 DOM 标签，不按显示状态**：用户在界面上点开了明文，快照里照样是占位符。
- `data-agent="forbidden"` 子树：只输出一个 `region [forbidden]` 节点，不展开、不给 ref。
- 只允许检查**主窗口**和显式白名单内的子窗口（如歌词窗）；**授权窗口永远不可检查、不可注入输入**。

### 4.3 操作命令

| 命令                                                  | 说明                                     |
| ----------------------------------------------------- | ---------------------------------------- |
| `ui.click --ref e3 [--button left\|right] [--double]` | 滚动到可见 → 取 box 中心 → 可信鼠标事件  |
| `ui.type --ref e20 --text "..." [--submit]`           | 聚焦 + `insertText`                      |
| `ui.select --ref e30 --value "..."`                   | v-select：点开 → 在弹出层里找选项 → 点击 |
| `ui.key --key Enter [--ref]`                          | 键盘                                     |
| `ui.scroll --ref e40 --dy 400`                        |                                          |
| `ui.navigate --ability aidj`                          | 等价于点击侧栏，失败时给出可用 id        |
| `ui.wait --text "..." \| --ref \| --idle 500`         | 等待渲染（Vuetify 动画 / 异步加载）      |
| `ui.screenshot [--ref e10]`                           | 返回 PNG；见 4.4                         |

**动作守卫**（在 inspector 里统一执行，ability 不用管）：

- 目标节点或其祖先带 `data-privacy` → 点击 / 输入前先 `guard(scope)`（典型场景：AI 想点 PrivacyText 揭示明文）。
- 带 `data-agent="forbidden"` → 直接拒绝，**不可申请**。
- 每次 agent 操作在页面上画一个短暂的高亮框 + app-bar 显示「AI 正在操作」指示，让用户始终知道发生了什么。

### 4.4 截图

截图是最容易漏的出口：

1. 截图前通过 CDP 拿到所有 `[data-privacy]` / `[data-agent=forbidden]` / `input[type=password]` 的矩形；
2. `captureScreenshot`；
3. 截图后再取一次矩形，**两次不一致就重来**（防止布局变化导致遮盖错位），最多 3 次，仍不一致就拒绝；
4. 用不透明色块盖住（外扩 4px），色块上标注 scope。
5. 已获得对应 scope clearance 的区域不遮盖。

---

## 5. 授权（Clearance）流程

### 5.1 命名

- 对 AI 的工具：**`request_clearance`**（MCP）/ `privacy.request`（命令）。「clearance」即安全许可，比 acquire_privacy_level 更准确：申请的是**某些 scope 的许可**，不是一个全局等级。
- 参数：`{ scopes: string[], reason: string, duration?: 'once' | 'session' }`。`reason` 原样显示给用户（加引号、标明「由 AI 提供」）。

### 5.2 状态机

```
request ─► pending ─┬─► granted(once)      仅本次调用 / 本次请求后 60s 内的一次读取
                    ├─► granted(session)   本次运行始终允许（应用退出即失效）
                    ├─► denied             本请求拒绝（同一会话 30s 内重复请求同一 scope 自动拒绝，防刷屏）
                    └─► expired            用户 120s 未处理
```

- **永久授权**（`forever`）**不在授权窗口里提供**，只能在设置页开启（§7），开启时弹风险说明。
- 粒度：按 scope；级别 `secret` 不可申请；`system.exec` 可申请但授权窗口用醒目警告样式，且永久授权**不包含** `system.exec`。
- 计划中的中间档（P5）：`granted(timed)`——「允许 1 小时」（时长可选 15 分钟 / 1 小时 / 4 小时），到期自动撤销，在设置页会话列表里显示剩余时间。

### 5.3 「AI 看不到窗口，只知道要等待」

- `guard` / `request_clearance` 在调用侧阻塞，**最长 45s**（低于常见 MCP 客户端 60s 超时），期间每 10s 发一次 MCP progress notification 保活。
- 超时仍未处理 → 返回 `{ status: 'pending', requestId, hint: '用户尚未处理授权请求，可调用 wait_clearance 继续等待' }`。AI 再调用 `wait_clearance(requestId)` 继续等待。
- 返回给 AI 的只有状态，不包含窗口内容、不包含用户是否看到。

### 5.4 授权窗口——必须在 AI 够不着的地方

- 独立的 `BrowserWindow`（复用 `windows/` 子窗口注册表，`?view=privacy-consent`），置顶、获取焦点、带边框，**不属于 inspector 白名单**：无法 snapshot、无法注入输入。
- 授权结果走专用 IPC `privacy:decide`，主进程**校验 sender 必须是该窗口的 webContents**。这**不是**注册命令：CLI、脚本、agent 都调用不到。
- 防误点：按钮出现后延迟 800ms 才可用；默认焦点放在「拒绝」上（防止 AI 通过其他途径注入回车）。
- 同时有多条请求时排队显示，可以「全部拒绝」。
- 主窗口最小化 / 不在前台时，额外发一条系统通知。

> 不用 `dialog.showMessageBox`：它没法排队、样式无法跟随主题、按钮也不够用（拒绝 / 允许一次 / 本次运行始终允许 + 风险提示）。但它可以作为授权窗口创建失败时的兜底。

### 5.5 提权（pkexec / UAC）：AI 不能沾用户的密码缓存

**问题**：`scripts/49-cockpit-pkexec.rules` 对 Cockpit 的 helper 返回 `AUTH_ADMIN_KEEP`。用户输一次密码后，5 分钟内**任何人**通过 Cockpit 调 pkexec 都免密——包括 AI。AI 点一下「切换镜像源」按钮，就以 root 身份执行了，用户毫不知情。

现有提权调用点只有三处：`mirror/service.ts`（write-mirrorlist）、`dashboard/gpu.ts`（nvidia-pm-toggle）、`apps/launcher.ts`（`root: true` 的应用经 run-as-root）。

#### 框架提权 SDK：`src/main/process/elevate.ts`

三处调用统一改为：

```ts
await runElevated('write-mirrorlist', [tmpFile], { reason: te('mirror.elevate_reason', { name }) })
```

`runElevated` 是唯一的提权入口（lint 规则禁止 ability 里直接 `execFile('pkexec', ...)`），它根据**提权归属**选择路径：

| 归属 | 判定                                                              | Linux 路径                                                                        |
| ---- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 用户 | origin = ui / cli，且不在 agent 污染窗口内                        | 现状：`pkexec <helper>`，action `org.freedesktop.policykit.exec`，共享 5 分钟缓存 |
| AI   | origin = remote / mcp / script-agent，**或**处于 agent 污染窗口内 | `pkexec scripts/agent-elevate.sh <helper> ...`，走**独立的 polkit action**，见下  |

#### 「AI 点了按钮」怎么判定——污染窗口（taint）

AI 点按钮后，提权请求是渲染端通过 IPC 发出的，origin 是 `ui`，单看 origin 分辨不出来。因此由 inspector 维护一个**污染窗口**：每次 agent 执行 `ui.click/type/key/select` 时，记录 `agentUiTaint = { session, until: now + 30s }`；在这个窗口内，所有 `runElevated` 都按 **AI 发起** 处理。

- 偏向安全：如果这 30 秒里用户自己也点了提权按钮，会被当成 AI 发起、需要输入密码——多输一次密码，但绝不会少输。
- 同样的污染判定也给 §3 的出口脱敏以外的「动作类」守卫使用（`system.control`）。

#### 独立 polkit action——缓存天然隔离

polkit 的临时授权（keep 缓存）按 **action id** 记录。给 AI 提权单独注册一个 action，用户的缓存就不会被复用：

```xml
<!-- scripts/org.linuxcockpit.agent-elevate.policy → /usr/share/polkit-1/actions/ -->
<action id="org.linuxcockpit.agent-elevate">
  <description>Linux Cockpit AI 助手请求管理员权限</description>
  <message>Linux Cockpit 的 AI 助手（而不是你本人）请求以 root 执行操作</message>
  <defaults><allow_any>no</allow_any><allow_inactive>no</allow_inactive>
            <allow_active>auth_admin</allow_active></defaults>   <!-- 不带 keep -->
  <annotate key="org.freedesktop.policykit.exec.path">/opt/linux-cockpit/scripts/agent-elevate.sh</annotate>
</action>
```

- `agent-elevate.sh` 只接受白名单 helper 名（`write-mirrorlist` / `nvidia-pm-toggle`），**不接受 `run-as-root`**：AI 启动 root 应用属于 `system.exec`，必须先拿 clearance，再走用户路径输密码（也不进 broker，见下）。
- 系统密码框的 `message` 明确写着「AI 助手（而不是你本人）」，所以密码框本身就是授权确认；同时主窗口顶部显示一条横幅：「AI 请求以 root 执行：切换镜像源 USTC——请在系统密码框中确认或取消」，补充具体做什么。因此 root 类操作**不再额外弹 §5.4 的授权窗口**（避免确认两次）。
- AI 无法替你输密码：KDE 的密码框属于另一个进程的窗口，inspector 只能向本应用的 webContents 注入输入。（拿到 `system.exec` 后用 ydotool 之类的工具绕过，属于威胁模型之外，见 §1。）
- **失败即拒绝**：`.policy` 未安装、路径不匹配（`exec.path` 必须是绝对路径且精确匹配）时，AI 提权直接报错「未安装 AI 提权策略，见 AGENTS §3.1」，**绝不回落到共享缓存的用户路径**。安装脚本根据实际仓库/安装路径生成 policy 文件。

#### 设置：AI 提权免密时长（默认关闭）

polkit 的 keep 时长固定约 5 分钟，规则文件也读不到应用配置，所以「AI 免密 N 分钟」由应用自己实现——**提权 broker 会话**：

- 设置项「AI 提权免密时长」：`0`（每次都要密码，**默认**）/ 5 / 15 / 30 分钟。从 0 改成其他值时弹风险说明（「这段时间内 AI 可以不经你确认地切换镜像源、修改 NVIDIA 电源参数」），列出 broker 允许的操作。
- 开启后，AI 第一次提权时用一次密码启动 `pkexec agent-elevate.sh --broker`：一个以 root 运行的小进程，通过 **stdin 管道**（只有 Cockpit 进程持有，其他进程无法写入）接收白名单内的操作，逐条校验参数。
- broker 在以下情况退出：时长到期、所有 agent 会话断开、用户在设置页点「立即撤销」、应用退出（随 `will-quit` 一起清理）。剩余时间显示在 app-bar 的 agent 指示器上。
- broker **只执行白名单操作**，不提供通用 root shell；`run-as-root` 永远不经过 broker。

#### Windows UAC 是否适用

- **缓存共享问题在 Windows 上不存在**：UAC 没有凭据缓存，每次提权都会弹出，且在安全桌面上——CDP / SendInput 等模拟输入无法点击。所以「AI 每次都要用户确认」在 Windows 上天然成立。
- **例外**：用户把 UAC 设为「从不通知」（`EnableLUA=0` 或 `ConsentPromptBehaviorAdmin=0`）时提权是静默的。`elevate.ts` 的 win32 后端检测到这种情况时，**拒绝 AI 提权**。
- **免密时长**：抽象层是跨平台的（broker 会话 = 一次 UAC 启动一个提权 broker 进程，`Start-Process -Verb RunAs`），但目前没有任何 Windows 提权功能，**v1 只实现 Linux 后端**；win32 后端等出现第一个需要提权的 Windows 功能时再做，设置项在 Windows 上先隐藏。

---

## 6. 传输层

### 6.1 共同点

- 只监听 `127.0.0.1`；端口默认 Remote `47801`、MCP `47802`（可在设置里改，被占用时报错而不是随机换端口）。
- **Bearer token**：`~/.config/LinuxCockpit/agent/token`（0600，首次启用时生成，设置页可重新生成）。设置页显示 token 的区域标 `v-agent-forbidden`。
- **Origin 校验**：拒绝带 `Origin` 头且不是 `null` / 本应用的请求，拒绝 `Host` 不是 `127.0.0.1:<port>` / `localhost:<port>` 的请求 → 防网页 CSRF / DNS rebinding。
- 每个连接就是一个 **agent 会话**：`session` id、`client` 名称、开始时间，设置页可以看到并断开；断开时撤销该会话发起的 `once` 授权。
- 审计：`makeLogger('agent')` 记录每次调用（工具、参数经 `redactArgs`、origin、clearance 判定、耗时）。

### 6.2 MCP

- 依赖 `@modelcontextprotocol/sdk`（**已确定采用**；框架依赖 → 根 `package.json`，保持 external；需要按 AGENTS §11.1/§11.2 启动验证）。
- 传输：Streamable HTTP `POST/GET http://127.0.0.1:47802/mcp`。
- stdio 桥 `scripts/cockpit-mcp.mjs`：读取 token 文件，把 stdio 转发到 HTTP，给只支持 stdio 的客户端用：
  `claude mcp add cockpit -- node /path/to/Launcher/scripts/cockpit-mcp.mjs`
  （应用是单实例的，不能让 MCP 客户端直接拉起应用当 stdio server。桥连接失败时给出明确报错：「Launcher 未运行或 MCP 未开启」。）

**工具表**（带 `readOnlyHint` / `destructiveHint` 注解）：

| 工具                                                                                                                        | 对应                                                   |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `overview`                                                                                                                  | 当前页面、可用 ability、已持有的 clearance、待处理请求 |
| `commands_list(filter?)`                                                                                                    | 命令 + usage + `privacy.reads/requires`                |
| `command_run(name, args)`                                                                                                   | `runCommand`                                           |
| `ui_snapshot` / `ui_click` / `ui_type` / `ui_select` / `ui_key` / `ui_scroll` / `ui_navigate` / `ui_wait` / `ui_screenshot` | §4                                                     |
| `script_run(code, lang)`                                                                                                    | 沙箱脚本（§8）                                         |
| `request_clearance(scopes, reason)` / `wait_clearance(id)`                                                                  | §5                                                     |
| `privacy_scopes`                                                                                                            | 列出所有 scope、级别、当前是否持有                     |

资源：`cockpit://commands`（命令目录）、`cockpit://scopes`。

### 6.3 Remote

- WebSocket `ws://127.0.0.1:47801/`，JSON-RPC 2.0，方法与 MCP 工具一一对应（`ui.snapshot`、`command.run`、`clearance.request`…），另有事件推送：`clearance.changed`、`bt.output`（订阅制）。
- 面向自己写的脚本 / 自动化（比 MCP 更轻量，可以订阅事件）。
- **局域网访问不在 v1 范围内**。以后要做时必须加 TLS + 配对码，并在设置里明确警告。

### 6.4 开关与启动参数

```jsonc
// config.json
"agent": {
  "remote": { "enabled": false, "port": 47801 },
  "mcp":    { "enabled": false, "port": 47802 },
  "privacy": {
    "personal": "allow",          // allow | ask
    "control": "allow",           // system.control：allow | ask
    "elevateGraceMinutes": 0,     // AI 提权免密时长：0 | 5 | 15 | 30（§5.5，只能由设置页写入）

    "alwaysAllow": [],            // 永久授权的 scope（只能由设置页写入）
    "alwaysAllowAll": false        // 永久授权全部（非 secret）——需要二次确认
  }
}
```

- `--with-remote` / `--with-mcp`：**只对本次运行开启**，不写入 config；设置页显示「本次由启动参数开启」。
- 环境变量兜底：`COCKPIT_WITH=remote,mcp`。
- 应用已在运行时再执行 `cockpit --with-mcp` → `second-instance` 事件里解析 argv，开启对应服务（需要用户确认吗？——不需要，能在本机执行命令的人本来就是用户）。
- `pnpm dev --with-remote`：`electron-vite dev` 会把未知参数当成自己的选项。**待验证**：把脚本改成 `"dev": "electron-vite dev --"`，让参数透传给 Electron；如果不行就加一个 `scripts/dev.mjs` 包装，把 `--with-*` 转换成 `COCKPIT_WITH`。

---

## 7. 设置页（`settings/items/AgentSection.vue`）

整个 section 标 `v-agent-forbidden`（AI 只能看到这里是禁区）。

- **Remote / MCP**：开关、端口、状态（监听中 / 端口被占用）、「复制 MCP 配置」（复制 `claude mcp add ...` 命令）。
- **Token**：显示（默认遮盖）、重新生成。
- **已连接会话**：client 名、来源、开始时间、本会话已获得的 clearance，按钮「断开」「撤销授权」。
- **隐私**：
  - `personal` 级别：允许 / 每次询问；
  - scope 列表（按 ability 分组，显示级别）：每项可以设为「永久授权」→ 弹风险对话框（说明该 scope 包含什么数据、AI 可能把它发送给模型提供商），需要勾选「我了解风险」后才能确认；
  - 「永久授权全部」：更强的风险对话框 + 3 秒倒计时；`secret` 永远不包含在内。
- **系统操作**：`system.control` 允许 / 每次询问；「AI 提权免密时长」0 / 5 / 15 / 30 分钟（改为非 0 时弹风险说明）、broker 剩余时间、「立即撤销」按钮；AI 提权策略的安装状态（未安装时给出安装命令）。Windows 上隐藏免密时长。
- **审计**：跳转到 logs 页面，过滤 scope `agent`。

DESIGN.md 规范适用：文字按钮默认密度、间距充足；新增文案中英文同时添加。

---

## 8. 脚本：让 AI「轻松执行」但不破防

现状：`scripting/service.ts` 在主进程里用 `new Function` 执行，`ctx.sh` / `ctx.exec` 直接 spawn。对 agent 来说这等于完整 shell，而且 `new Function` 跑在主进程 realm 里，`ctx.command.constructor.constructor('return process')()` 就能拿到 `process`。**不能直接开放给 agent。**

方案：

| 模式                                        | 运行位置                                                                                              | 能力                                                                                                         | 许可                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| **沙箱脚本**（agent 默认）                  | 独立子进程 `node --permission`（不授予 fs 写 / child_process / worker 权限，fs 读只允许脚本临时文件） | `ctx.command` / `ctx.ui.*` / `ctx.log`，经 stdio RPC 回到主进程，**origin = script-agent**，照样经过隐私 SDK | 无需                                          |
| **完整脚本**（含 `sh` / `exec` / 文件系统） | 现有 `scripting` 执行器                                                                               | 全部                                                                                                         | `system.exec` clearance（每次运行或本次运行） |

沙箱脚本里调用 `ctx.command('yarj.scan')` 之类的普通命令完全没有门槛，调用 `system.control` 类命令时按用户设置决定是否询问；只有脚本自己想 spawn 任意进程时才需要 `system.exec`。

- 沙箱子进程与主进程之间**只传 JSON**，不传宿主对象 → 不存在原型链逃逸。
- 待验证：开发机 Node 26 的 `--permission` 对网络是否有限制（若没有限制，网络外发属于「AI 本来就能联网」，不在本设计的防护范围内）；未找到系统 `node` 时回退为「沙箱不可用 → 只能走 exec 许可」。
- 用户自己在 scripting 页面跑的脚本（origin = ui）行为不变。

命令归类（实施时逐个核对源码，以「调用方能否决定执行内容」为准）：

- `system.exec`：`scripting.run/eval`（完整模式）、`background.start`、`background.input`（写入非自身任务的 stdin）、`launch.run`（任意命令行形式）、`apps.create/update`（可写入任意 exec 字段）、外部 ability 加载、`aidj.web-remote-start`（对外开放端口）。
- `system.control`：`systemd.action`、`docker.action`、`display.apply`、`autostart.toggle`、`apps.delete`、`launch.action`（若只启动已登记的应用）。
- 提权（§5.5，经 `runElevated`）：`mirror.toggle`、`hardware.pm-toggle`；`root: true` 应用的启动同时属于 `system.exec`。
- 无门槛：yarj / biliviewer 等内部以固定参数调用 ffprobe / exiftool / ffmpeg 的命令，`yarj.open-path`、`yarj.show-item-in-folder` 等。

---

## 9. 隐私盘点（首轮扫描，实施时逐项核对）

| Ability                           | 数据                                                  | 级别 / scope                                       | 现状                                        | 需要做的                                                                                                                                                  |
| --------------------------------- | ----------------------------------------------------- | -------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| campusinfo                        | 学号、姓名、证件、手机、邮箱、卡号、余额、消费、成绩  | sensitive：`identity` `contact` `finance` `grades` | 字段模型已有 `sensitive`，`MaskedText` 打码 | 字段带 scope；`campusinfo.section` 结果 `shieldFields`；改用 `PrivacyText`                                                                                |
| campusinfo                        | 统一身份认证密码 / 会话                               | secret                                             | 已加密存储                                  | `config.get` 中 `secret()`；`config.set`/`logout` 需 `guard`                                                                                              |
| campusnet                         | 账号、IP、MAC、余额（`SENSITIVE_KEYS` 已存在于 View） | sensitive：`campusnet.account`                     | View 内部遮盖                               | `status` 结果 shield；View 加 `v-privacy`                                                                                                                 |
| campusnet                         | 密码；**`config.get --reveal true` 返回明文**         | secret                                             |                                             | agent 调用时 `--reveal` 无效                                                                                                                              |
| balance                           | 各平台余额 / 用量 / 订阅到期                          | sensitive：`balance.amount`                        | 无                                          | `list/check` shield；View 标注                                                                                                                            |
| balance                           | API Key、网页登录 Cookie、Codex auth                  | secret                                             | `crypto.ts` 加密                            | `config.get`/`profiles.list` 中 `secret()`；`*.login/logout`、`import`、`codex.import_auth` 需 guard；`open_window` 打开的网页窗口不在 inspector 白名单内 |
| aidj                              | OpenAI API Key、NCM / B 站 Cookie（SESSDATA）         | secret                                             |                                             | `get-config`、`bili-profile` 中 secret；`bili-qr-*`、`bili-import-credential` 禁止 agent（`agent: 'deny'`）                                               |
| aidj                              | 听歌统计、会话聊天记录、歌单                          | personal                                           |                                             | 声明 `reads`                                                                                                                                              |
| aidj                              | 局域网遥控（`web-remote-start`）                      | exec 类（对外开放端口）                            |                                             | `requires: system.exec`                                                                                                                                   |
| bilistats                         | B 站 uid、昵称、粉丝数、播放量等                      | personal                                           |                                             | 声明 `reads`；若接口含实名 / 手机 / 收益金额，单独标 sensitive                                                                                            |
| biliviewer                        | 本地缓存与观看内容                                    | personal                                           |                                             | 声明 `reads`                                                                                                                                              |
| yarj                              | 照片 GPS、轨迹、逆地理编码结果                        | sensitive：`yarj.location`                         | 无                                          | `photos/route/route-points/hierarchy*` shield 坐标；地图 View `v-privacy`；截图需遮盖地图                                                                 |
| playground                        | 全局变量（`secret` 标记）、模板里的 headers（含 key） | secret / personal                                  | 渲染端 localStorage                         | `type=password` 自动视为 secret；`playground.export` 需 guard                                                                                             |
| scripting                         | 脚本配置 `secret` 字段                                | secret                                             | password 输入框                             | 同上                                                                                                                                                      |
| logs                              | 运行日志                                              | personal + 模式脱敏                                | IPC 参数已有 `redactArgs`                   | §3.5                                                                                                                                                      |
| background                        | 任务输出                                              | 继承任务发起者                                     |                                             | §3.5                                                                                                                                                      |
| settings                          | `config.get` 全量配置                                 | personal；`agent.*` 键只能由 UI 写                 |                                             | `config.set` 拒绝 agent 写 `agent.*`                                                                                                                      |
| 外部 ability（`ability-loader`）  | 未知                                                  | 未分类 → 兜底模式脱敏                              |                                             | 审计日志标 `unclassified`                                                                                                                                 |
| 私有能力 fnaf / ut / mt / rungame | 游戏数据                                              | public                                             |                                             | 无                                                                                                                                                        |

> 私有仓库能力（campusinfo / campusnet / bilistats / biliviewer）的改动要在各自的私有仓库里提交（AGENTS §11.4）。

---

## 10. 分期实施

| 阶段                   | 内容                                                                                                                                                                                                      | 交付即可用的价值                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **P0 隐私 SDK**        | `privacy.ts`（origin ALS、scope 注册、shield/guard/secret）、`CommandSpec.privacy`、渲染端 `v-privacy` / `v-agent-forbidden` / `PrivacyText`；按 §9 给各 ability 接入；`privacy.request` + 授权窗口       | 与 agent 无关也有价值：统一 MaskedText，日志脱敏                    |
| **P1 Inspector**       | `ui.*` 命令（CDP）、快照脱敏、截图遮盖、动作守卫、操作高亮                                                                                                                                                | CLI 里就能 `ui.snapshot`，便于调试与写 UI 自检（替代手写 CDP 脚本） |
| **P2 网关 + Remote**   | `agent/server.ts`、token、Origin 校验、会话、审计、`--with-remote`、设置页                                                                                                                                | 脚本自动化                                                          |
| **P3 MCP**             | MCP 工具映射、progress 保活、stdio 桥                                                                                                                                                                     | 接入 Claude Code 等                                                 |
| **P4 脚本沙箱 + 提权** | `node --permission` 子进程、`system.exec` / `system.control` 接入、拼接 `bash -c` 的命令改为 argv；`elevate.ts`（三处 pkexec 迁移）、污染窗口、agent polkit action + 安装说明（AGENTS §3.1）、broker 会话 | AI 跑脚本 / AI 提权安全                                             |
| **P5 打磨**            | 永久授权、风险对话框、限时授权（15 分钟 / 1 小时 / 4 小时）、审计视图、agent 指示器                                                                                                                       |                                                                     |

每个阶段都要做红队自检（写成 `src/main/process/agent/*.test.ts` + 手工清单）：

- [ ] agent 直接调用 `campusinfo.section` → 只得到占位符
- [ ] agent 点击 PrivacyText → 弹出授权窗口；拒绝后快照依然是占位符
- [ ] 用户在 UI 里点开明文后，agent 快照 / 截图依然脱敏
- [ ] agent 尝试 snapshot / 点击授权窗口 → 拒绝
- [ ] agent 尝试点击设置页「永久授权」/ `config.set {agent:{...}}` → 拒绝
- [ ] agent 沙箱脚本 `ctx.command.constructor.constructor('return process')` → 子进程里没有可用的宿主对象
- [ ] agent 调用 `background.start ['cat', '~/.config/...']` → 要求 exec clearance
- [ ] `campusnet.config.get --reveal true`（agent）→ 密码仍是占位符
- [ ] 浏览器页面 `fetch('http://127.0.0.1:47802/mcp')` → 被 Origin 校验拒绝
- [ ] 日志里出现解密过的 secret 值 → `logs.query`（agent）中被替换
- [ ] 用户刚输过 pkexec 密码（5 分钟缓存内），AI 点击「切换镜像源」→ 仍然弹出系统密码框，且密码框文案标明是 AI 发起
- [ ] 卸载 agent policy 文件后 AI 提权 → 报错，不回落到用户路径
- [ ] 免密时长 = 0 时不存在 broker 进程；设为 5 分钟后到期 / 断开会话 / 退出应用 → broker 退出
- [ ] broker 收到非白名单操作（含 run-as-root）→ 拒绝

---

## 11. 已确定的决策（2026-10-01）

1. `personal` = 不能关联到真实身份的简单个人数据（B 站 uid、粉丝数等），**默认允许**；能关联到真人或涉及金钱 / 位置的归 `sensitive`。
2. 只有「调用方决定执行什么」才算 `system.exec`（需许可）；能力内部用固定参数调用外部程序的命令不设门槛；行为固定的系统操作归 `system.control`，由用户选择允许或询问（默认允许）。
3. AI 发起（含 AI 点击 UI 触发）的 pkexec 提权每次都要输入密码，不共享用户的 polkit 缓存（独立 polkit action）；AI 免密时长在设置里配置，默认 0（§5.5）。Windows UAC 本身没有缓存，天然满足；v1 只实现 Linux 后端。
4. 采用 `@modelcontextprotocol/sdk`。
5. 限时授权（15 分钟 / 1 小时 / 4 小时）列入 P5。

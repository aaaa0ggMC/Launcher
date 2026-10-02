# 独占 SDK 与 `command_script` 设计

> 状态：设计 + 实现（2026-10-02）。两个特性相互独立，但有一条交集：脚本跑得快，更需要独占保护存档。

---

## 一、独占 SDK（`src/main/process/exclusive.ts`）

### 1.1 要解决的问题

有状态的资源同一时刻只能有一个「拥有者」：宝可梦这类一个 ROM 一份存档、模拟器是渲染端单例（曾因广播导致主窗口与 AI 视图各起一个模拟器）、带存档的小游戏。
靠每个能力自己判断很难做对（要懂来源、会话、视图、生命周期）。所以做成框架设施，和隐私 SDK 同一思路：**能力只声明「这个资源要独占」，框架执行。**

### 1.2 概念

| 概念 | 说明 |
| :-- | :-- |
| 资源范围 scope | `<能力id>.<名>`，如 `gameboy.rom`。能力用 `defineExclusiveScopes` 声明，翻译键放自己的 translations |
| 资源键 key | 范围内的具体资源，如 ROM id。粒度取「会冲突的最小单位」（存档文件，不是整个模拟器） |
| 租约 lease | (scope, key) → 拥有者；含 `epoch`（每次拥有者变化 +1）、`acquiredAt`、`lastActive`、可选 `meta` |
| 拥有者 owner | `{kind:'user'}` 或 `{kind:'agent', session, client}`。来源映射：`ui` / `cli` / `script` → user；`remote` / `mcp` / `script-agent` / `agent-ui` → 该 agent 会话（用户在跟随的 AI 视图里点的是 `agent-ui`，算 AI 的） |
| 策略 policy | `exclusive`（默认）：一份资源一个拥有者；`fork`：每个 agent 会话派生自己的副本键，不冲突（`forkKey()` 只给键派生，复制数据由能力自己做） |

### 1.3 规则（全部在主进程，渲染端只展示）

1. **获取**：声明了 `exclusive` 的命令首次执行时自动获取租约；之后每次执行续期（`lastActive`）。
2. **冲突**：
   - AI 对被**另一个 AI** 占用的资源：立即失败，抛 `ExclusiveBusyError`（code `exclusive_busy`），带占用者、持续时间、空闲时间，**不排队、不抢**——让 AI 告诉用户。
   - AI 对被**用户**占用的资源：同样失败（用户优先）。
   - 用户对被 AI 占用的资源：**直接接管**（用户永远优先，AI 无权拒绝）；epoch +1，旧 AI 的下一次调用收到 `lease_lost`（说明被用户接管）。接管只能由用户发起，`agent: 'deny'`。
3. **只读命令**（截图、状态）声明 `access: 'read'`：不获取、不续期，也不被冲突拒绝。
4. **释放**：拥有者主动释放（`exclusive.release`，AI 只能释放自己的）；会话结束（`onSessionEnded`）；空闲超过 TTL（默认 5 分钟，`config.json` 的 `agent.exclusive.idleMin`，1–60）；用户接管。租约只存内存，应用重启即清空。
5. **fencing（防止被抢占的旧拥有者继续写坏存档）**：每个租约有单调递增的 `epoch`。**写盘的地方必须带 epoch 调 `assertFence(scope, key, epoch)`**，不是当前 epoch 一律拒绝。仅靠锁挡不住「已经发出去的写入」，epoch 才能保证存档不被旧拥有者覆盖。
6. **谁在跑**：租约可带 `host`（渲染端 webContents id），需要「把请求发给持有者的渲染进程」的能力用 `leaseHost()`，不再自己猜（掌机的 `engineTarget()` 可改用它）。

### 1.4 API

```ts
// 声明（能力的 exclusive.ts，loader 不需要 glob，直接 import 即可）
export const GB = defineExclusiveScopes('gameboy', {
  rom: { policy: 'exclusive', label: 'gameboy.excl.rom' }   // 翻译键
})                                                         // GB.rom === 'gameboy.rom'

// 命令声明（CommandSpec 新增字段）
{ name: 'gameboy.press',
  exclusive: { scope: GB.rom, key: () => currentRomId(), access: 'write' }, … }

// 框架 API（主进程）
acquire(scope, key, opts?: { host?: number; meta?: Record<string, unknown> }): Lease   // 抛 ExclusiveBusyError / LeaseLostError
touch(scope, key): void
release(scope, key, byOwner?): boolean
takeOver(scope, key): Lease            // 仅用户来源
assertFence(scope, key, epoch): void   // 抛 StaleEpochError
forkKey(scope, key): string            // fork 策略：key + '#' + 会话短 id；user 返回原 key
leaseOf(scope, key): LeaseInfo | undefined
listLeases(): LeaseInfo[]
onLeasesChanged(cb): () => void
```

命令的 handler 通过 `ctx.lease`（`{ scope, key, epoch }`）拿到当前租约，把 `epoch` 传给下层写盘函数。

### 1.5 命令与事件

- `exclusive.list`：所有租约（范围、键、拥有者、持续时间、空闲时间、能力名）。
- `exclusive.release --scope --key`：释放。AI 只能释放自己的。
- `exclusive.take-over --scope --key`：用户接管，`agent: 'deny'`。
- 广播 `cockpit:exclusive`（租约列表）：界面据此展示。

### 1.6 界面

- 标题栏 AI 图标条的悬停提示追加一行「占用：掌机 · 宝可梦红」。
- 外壳在当前页面顶部（App bar 下方）显示窄条：「该页面的游戏正被 {client} 占用 · [接管]」——按 scope 前缀与当前能力 id 对应；接管按钮调 `exclusive.take-over`。
- 设置 →「AI 与远程」→ 新增「独占」：空闲释放时间。

### 1.7 掌机接入（第一个使用者）

- scope `gameboy.rom`，key = ROM id。`gameboy.load / press / step / speed / save-state / load-state / reset …` 写类命令声明 `exclusive`；`gameboy.screen / status` 为 `read`。
- 渲染端 rpc 的 `load` 带上 `epoch`；存档 / 即时存档写盘命令（`internal-save-write` 等）必须带 epoch 并 `assertFence`。
- `rpc()` 的目标渲染进程改用租约 `host`（回退到现有的 `engineTarget()`）。

### 1.8 不做的事（本期）

排队 / 等待、跨重启持久化租约、claudeadv 接入（存档位置待确认，先用 `fork` 策略预留）。

---

## 二、`command_script`（MCP / Remote 工具）

### 2.1 要解决的问题

AI 玩游戏 / 做长流程时，「操作 → 截图 → 判断 → 再操作」每一步都要往返一次（一局掌机 499 次调用）。让 AI 提交一段脚本，在主进程里一次执行：能写判断和循环，只往返一次。

### 2.2 威胁模型与沙箱

AI 本来就能通过 `command_run` 调所有命令。脚本只多了**控制流**，所以只要沙箱里**只有** `cockpit.*` 这个出口，就不比现在多出权限，且每个命令仍走命令注册表（隐私 SDK、`agent: 'deny'`、授权、独占全部照常生效，来源仍是该 agent 会话）。

- 引擎：**QuickJS（`quickjs-emscripten`，wasm）**。没有 Node 的任何接口，不存在 `vm` 那种构造函数链逃逸；可限内存、限栈、用中断处理器限 CPU 时间。
- 沙箱里**没有**：`process` / `require` / `fetch` / `setTimeout` / `import()`；只有 ES 内置对象 + 下面的 `cockpit`。
- 依赖：根 `package.json`（框架依赖，agent 网关是框架的一部分），运行时从 node_modules 加载（和 esbuild 等同属 external）。

### 2.3 脚本里能用什么

```js
// 脚本体是一个 async 函数体，可以 await，用 return 返回结果
const shot = await cockpit.command('gameboy.screen', { scale: 2 })   // 图片结果见下
await cockpit.command('gameboy.press', { button: 'A', frames: 3 })
await cockpit.sleep(200)                  // 宿主侧计时，不占 CPU 预算
cockpit.log('moved', 3)                   // 日志，返回时附上（上限 200 行 / 16KB）
cockpit.show(shot, '第 3 步')              // 把图片附到最终返回里（最多 8 张）
return { hp: status.hp }
```

- `cockpit.command(name, args)`：等价于 `command_run`；返回 JSON 值。命令抛错 → 脚本里抛出 `CommandError`（含 `name` / `message` / `code`），脚本可 `try/catch`。
- **图片**：命令结果里的 `$image`（base64）**不进入 VM**——换成 `{ $imageRef: <n> }` 句柄（省 token、省内存）；`cockpit.show(ref, label)` 才会附到工具返回里。`cockpit.show` 也接受 `ui.screenshot` 的结果。
- `cockpit.sleep(ms)`：单次 ≤ 10s。

### 2.4 限额（`config.json` 的 `agent.script`，AI 无法修改）

| 项 | 默认 | 说明 |
| :-- | :-- | :-- |
| `enabled` | `true` | 总开关；关闭后工具不出现在 `tools/list` |
| `maxCalls` | 300 | 一次脚本里 `cockpit.command` 次数上限 |
| `cpuMs` | 5000 | VM 内部纯计算时间上限（中断处理器）；宿主调用 / sleep 不计 |
| `wallSec` | 120 | 整体墙钟上限（含授权等待之外的所有时间；授权窗口等待不计入） |
| `memoryMB` | 64 | QuickJS 内存上限 |
| 返回体积 | 256KB | 结果 JSON 超限则截断并标注 |

超限 → 终止脚本，返回**已完成部分**的日志与图片，并标明哪一项超限。

### 2.5 工具形态与可取消

- MCP / Remote 工具 `command_script { code: string, args?: object, maxCalls?, wallSec? }`（参数只能**调小**限额，不能调大）。`args` 作为脚本里的常量 `args`。
- 作为**后台作业任务**（`startJobTask`，名称「AI 脚本」）运行，后台任务面板可见进度（`pushLine` 记录每次命令调用）并可「停止」→ 中断沙箱。客户端断开 / 会话结束同样中断。
- 脚本之间互斥？同一会话同时只允许 1 个脚本在跑（避免交错操作同一游戏）。

### 2.6 返回值

```json
{ "ok": true, "result": <脚本 return 的值>, "logs": ["…"], "calls": 17, "elapsedMs": 4210 }
{ "ok": false, "error": { "name": "CommandError|LimitError|ScriptError", "message": "…", "line": 3, "limit": "maxCalls" }, "logs": [], "calls": 12 }
```
图片作为独立的 image 内容块附在后面（带 label）。

### 2.7 与独占的关系

脚本里的命令照常触发独占获取 / 续期；脚本被中断不会自动释放租约（拥有者仍是该会话，空闲 TTL 或会话结束才释放）。

---

## 三、工作包

| 包 | 内容 | 谁 |
| :-- | :-- | :-- |
| A1 | `exclusive.ts` 核心 + `CommandSpec.exclusive` + registry 接入 + `ctx.lease` | 副总监 |
| A2 | `exclusive.*` 命令 + `cockpit:exclusive` 广播 + 外壳窄条 + AI 图标条悬停行 + 设置项 + 翻译 | opencode |
| A3 | 掌机接入（scope、命令声明、epoch 校验、rpc 目标） | 副总监 |
| B1 | `agent/script-sandbox.ts`：QuickJS 沙箱（纯模块：代码 + 宿主函数表 + 限额 → 结果）+ 离线自检 | opencode |
| B2 | `command_script` 工具胶水：配置、作业任务、图片句柄、限额、设置页、说明文字 | opencode（依赖 B1 的接口，接口由副总监先定） |

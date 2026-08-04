# APPS.JSON — 应用注册表使用说明

每个搜索目录（config/abilities.yaml 里 apps 的 `searchRoots`）下有一份 `apps.json`，定义该目录下"应用 → 一键操作"的注册表。
手工编辑优先，扫描器（`apps.rescan`）只补充草稿、不覆盖你的修改。

> **多语言注意**：新增条目时，`name`/`description`/`alias` 推荐使用对象格式提供至少 `zh` 和 `en_US` 两种语言，见 [§8 多语言](#8-多语言)。

```jsonc
{
  "version": 1,
  "apps": {
    "bili-viewer": { /* AppEntry */ }
  }
}
```

---

## 1. 条目字段 (AppEntry)

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string 或对象 | 显示名，见 [§8 多语言](#8-多语言) |
| `alias` | string 或对象 | CLI 快捷名（`<alias>` 直接启动），见 [§8 多语言](#8-多语言) |
| `description` | string 或对象 | 描述，见 [§8 多语言](#8-多语言) |
| `path` | string | 相对搜索根或绝对路径（脚本文件 / 项目目录） |
| `icon` | string | 图标，见 [§5 图标语法](#5-图标语法) |
| `localized` | Record<string, object> | 备用多语言映射，见 [§8.2](#82-localized-字段) |
| `exec` | AppExecSpec | **主操作**：卡片上的「启动」按钮 |
| `actions` | Record<string, AppAction> | 附加操作（聚类按钮），见 [§3 附加操作](#3-附加操作-actions) |
| `tags` / `tags_auto` | string[] | 手工标签 / 扫描自动标签（显示时去重） |
| `security` | AppSecurity | 风险等级与备注 |
| `managed` | boolean | `false` 表示扫描器不再合并覆盖（手工条目） |
| `transformer` | string | JS 源码，见 [§6 输出 Transformer](#6-输出-transformer) |
| `transformer_display` | boolean | 存在 transformer 且为 true 时弹实时输出窗 |
| `missing` | boolean | 运行时标记：路径/目录已消失（不持久化） |

### 1.1 exec (AppExecSpec)

```jsonc
{
  "type": "uv",            // 见下方类型表
  "command": ["bili-viewer"],
  "args": [],              // 追加参数
  "cwd": "{self}",         // 工作目录: "{self}"=条目自身目录 / 绝对 / 相对
  "env": { "FOO": "bar" }, // 额外环境变量
  "terminal": true,        // 在终端中运行
  "root": false,           // pkexec 提权
  "path": "newapi/setup"   // script/desktop 类型的脚本目标覆盖 (默认=entry.path)
}
```

`type` 可选值：

| type | 行为 |
|---|---|
| `uv` | `uv run --directory <cwd> <command...>` |
| `python` | 优先 `<cwd>/.venv/bin/python`，否则 `python3` |
| `node` | `node <command...>` |
| `docker` | `docker <command...>` |
| `systemd` | `systemctl [--user] <command...>`（`root:true` 时用系统级） |
| `script` | `bash <脚本>`（脚本目标 = `path` 或 `entry.path`） |
| `desktop` | `gio launch <desktop 文件>` |
| `custom` | 直接 spawn `<command...>` |

> 一律 `spawn(argv)`，不做 shell 拼接。

---

## 2. 完整示例

```jsonc
"bili-viewer": {
  "name": "bili-viewer",
  "alias": "bv",
  "description": "B站本地缓存终端观看器",
  "path": "bili-viewer",
  "icon": "default/classic-tv",
  "exec": { "type": "uv", "command": ["bili-viewer"], "cwd": "{self}", "terminal": true },
  "tags": ["media", "bilibili"],
  "security": { "risk": "low" }
}
```

---

## 3. 附加操作 (actions)

一个应用可以有多个按钮。每个 action 渲染成卡片上的一个按钮，按钮背景色按有效风险着色（越深越危险）。

```jsonc
"newapi": {
  "path": "start_ais",
  "exec": { "type": "script", "command": ["start_ais"], "cwd": "{self}", "terminal": true },
  "actions": {
    "stop": {
      "name": "停止",
      "exec": { "type": "script", "command": ["stop_ais"], "cwd": "{self}", "terminal": true }
    },
    "recreate": {
      "name": "重新配置",
      "risk": "high",   // 覆盖条目级风险 → 深红按钮
      "exec": { "type": "script", "command": ["setup"], "cwd": "newapi", "path": "newapi/setup" },
      "steps": [        // 多步：中间步 headless 等待，最后一步 detached/终端
        { "type": "custom", "command": ["docker", "rm", "-f", "new-api"], "cwd": "{self}" },
        { "type": "script", "command": ["setup"], "cwd": "newapi", "path": "newapi/setup" }
      ]
    }
  }
}
```

字段：
- `name`：按钮文字
- `icon`：图标语法（可选）
- `risk`：per-action 风险覆盖；缺省用条目 `security.risk`
- `exec`：单步执行的 spec
- `steps`：多步序列，**有 steps 时覆盖 exec**。中间步 headless 且等待成功，最后一步 detached（可用自己的 terminal/root 标志）

CLI 执行操作：`launch <alias> <action>` 或 `launch.action --root ~/Apps --id newapi --action stop`。

---

## 4. 风险 (security)

```jsonc
"security": {
  "risk": "medium",          // low | medium | high
  "auto_note": "脚本涉及网络请求",  // 扫描自动生成（只读）
  "note": "自用服务, 别暴露公网",    // 人工备注
  "acknowledged": false       // 用户已确认过 → 不再弹确认
}
```

- medium/high 启动前弹确认；low 直接启动。
- 按钮颜色：low=绿 tonal / medium=琥珀 tonal / high=深红 flat。

---

## 5. 图标语法

| 语法 | 含义 |
|---|---|
| `default/<名字>` | game-icon-pack 图标（无 padding） |
| `default/<名字>/padding` | 带 padding 版本 |
| `emoji/😎` | 直接展示 emoji |
| `file//abs/path` | 本地图片（绝对路径） |
| `file/abs/path` | 同上（简写，都按绝对处理） |
| 留空 / `auto` | 兜底 😎 |

找不到的图标名也会回落 😎。图标名列表见 `src/renderer/assets/game-icon-pack/Icon_Catalog.json`。
UI 里编辑对话框的图标字段旁有 📁 按钮，可弹原生文件选择器。

---

## 6. 输出 Transformer

对"输出逐行且结构简单"的程序（如 balance-checker 查余额），可用 transformer 把 stdout 实时转成 UI 组件显示在 80% 弹窗里。

```jsonc
"transformer_display": true,
"transformer": "function Transformer() { ... }"
```

- `transformer` 是一个 JS 构造函数，实现 `onNewLine(e, ui)`；`e` 是每行输出，`ui` 是组件工厂。
- **每个 onNewLine 的返回值会被自动追加**（单个或数组）；也可在函数里 `ui.add(...)`。
- `ui` 提供组件（不直接控制 DOM）：`NewText(v,{size,mono})` / `NewTitle(v)` / `NewAlign(...items)` / `NewBar(pct,label,color)` / `NewStatus(v,color)` / `NewTable(head,rows)` / `add(...)` / `clear()`。颜色：`ok|warn|err|info`。

示例（balance-checker，把 `平台: 金额` 逐行累积成表格）：

```js
function Transformer() {
  this.head = ['平台', '余额'];
  this.rows = [];
  this.onNewLine = function (e, ui) {
    var line = String(e).trim();
    if (!line) return;
    var m = line.match(/^([^:]+):\s*(.*)$/);
    if (!m) return ui.NewText(line, { size: 'sm', mono: true });
    var isErr = /ERROR|Failed/i.test(m[2]);
    this.rows.push([m[1], { t: 'status', v: m[2], color: isErr ? 'err' : 'ok' }]);
    ui.clear();
    return ui.NewTable(this.head, this.rows);
  };
}
```

注意：
- 弹窗有 视图（组件）/ Raw（原始行）切换、自动滚动。
- 启用 transformer_display 时，launch 会自动进入 monitor 模式并**去掉 terminal 包装**（输出才能进管道）。
- transformer 运行在渲染进程（沙箱内、无 node 权限），CSP 已允许 `unsafe-eval`。

---

## 7. managed / missing / 扫描策略

- `managed: false` → 扫描器完全不动它（手工条目）。
- 扫描 `apps.rescan --root <dir>` 只做三件事：补草稿、更新 `tags_auto` 与 `security.auto_note`、缺失时标 `missing: true`。其余字段以你手写的为准。
- 扫描会**去重**：`foo.sh` / `foo.py` 等与同名目录（如 `langbot` vs `LangBot`、`balance-checker` vs `balance_checker`）只保留目录项目，避免冗余条目。

---

## 8. UI 与 CLI 操作

**UI（应用页）**：
- 「添加应用」：选存储目录、填名字/ID/路径/exec，可选创建目录（`--mkdir`）。
- 「编辑」：改主 exec、风险、图标、标签、附加操作（含多步命令文本框）、transformer。
- 卡片按钮：启动 + 各 action，颜色编码风险。

**CLI 命令**：

```bash
apps.list
apps.get    --root ~/Apps --id bili-viewer
apps.update --root ~/Apps --id bili-viewer --patch '{"name":"x"}'
apps.create --root ~/Apps --id myapp --patch '{"name":"My App","exec":{"type":"custom","command":["run.sh"]}}' --mkdir true
apps.delete --root ~/Apps --id myapp
apps.rescan --root ~/Apps
launch.run     --root ~/Apps --id bili-viewer
launch.action  --root ~/Apps --id newapi --action stop
```

CLI REPL 简写：`<alias>` 启动、`<alias> <action>` 执行操作、`info <alias>`、`list`。

---

## 8. 多语言

`name`、`description`、`alias` 支持两种格式：

**纯字符串**（向后兼容，无翻译时直接显示）：
```json
"name": "Bili Viewer"
```

**对象格式**（按当前语言自动选取）：
```json
"name": {
  "zh": "哔哩观看器",
  "en_US": "Bili Viewer"
}
```

可用码：`zh`（中文）、`en_US`/`en-US`（美国英语）。`en_US` 和 `en-US` 互通。

### 8.1 回退链

显示时按以下优先级选取：
1. 当前配置语言（`config.json` 的 `language`）
2. `en_US` / `en-US`
3. 对象中第一个有效值
4. 原始 `name`/`description`/`alias` 字段（纯字符串）

### 8.2 `localized` 字段

也可用 `localized` 字段存储翻译（与对象格式互斥）：
```json
{
  "name": "Bili Viewer",
  "localized": {
    "zh": { "name": "哔哩观看器", "description": "B站本地缓存观看器" },
    "en-US": { "description": "Local Bilibili cache viewer" }
  }
}
```

编辑器中（添加/编辑应用）有一个可折叠的「多语言 / Multi-language」区域，按所有可用语言展示名称和描述字段，填写后自动写入 `localized`。

---

## 9. 跨目录

多个搜索根各有一份 apps.json，`apps.list` 会把所有根合并返回（条目带上运行时 `root` 字段，不持久化）。同一 id 在不同目录会互相覆盖（后加载的赢），所以 id 建议全局唯一。

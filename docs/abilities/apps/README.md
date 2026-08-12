# 应用注册表（apps）

按目录扫描你手头的项目/脚本，组织成一个「应用注册表」：一键启动、附加操作按钮（如 start / stop / rebuild）、风险分级着色，还能从侧栏搜索框直接启动应用。纯跨平台能力，不依赖任何发行版或桌面环境（`exec` 的 `systemd` / `desktop` 类型除外）。

## 前置依赖

- **后台任务框架（background）**：apps 能力依赖 `background-tasks`（`meta.ts` 声明 `dependencies: ['background-tasks']`）。如果 `background` 能力被移除，apps 的命令不会注册、侧栏也不会显示。
- **终端**（可选）：`terminal: true` 的条目用 `~/.config/LinuxCockpit/config.json` 中 `runtime.terminal` 指定的命令打开（默认 `konsole --hold -e`）。
- **pkexec**（polkit，可选）：`root: true` 的条目需要，缺失时该条目无法提权启动。

## 核心概念

每个「应用」是一个注册表条目（entry），存于搜索根目录下的 `apps.json`。应用由一个**主启动操作**（`exec`）和一组**附加操作**（`actions`）组成：

```
<搜索根目录>/apps.json
  └─ apps
      └─ <id>      # 如 "bili-viewer"
          ├─ name / alias / description / icon
          ├─ exec          → 卡片上默认的「启动」按钮
          ├─ actions       → 卡片上的其他按钮（停止/重启/重建…）
          ├─ security      → 风险等级 + 备注
          ├─ tags          → 手工标签（可与 tags_auto 合并筛选）
          ├─ transformer   → 实时输出解析脚本（可选）
          └─ managed       → false = 手工条目，扫描永不覆盖
```

## 使用教程（UI）

侧栏 →「系统」→「应用」。页面以卡片网格展示每个应用。

### 搜索目录配置

先要有一个搜索根目录。页面顶部「添加目录」输入绝对路径（或点文件夹图标用原生对话框选择）。每个搜索根目录下存放一份 `apps.json` 注册表。

- 已添加的根目录以可关闭的 chip 显示在搜索框下方，点 × 立即移除。
- 在**设置 → 应用 → 搜索目录**里可以给根目录**上移 / 下移**（顺序即搜索顺序）或移除。
- 根目录被 chokidar 监视（`watch: true`）——`apps.json` 或目录结构一变，页面实时刷新。

### 列表筛选

- **搜索框**：按 名称 / 别名 / 描述 / ID 加权匹配（不区分大小写）。
- **标签 chips**：点标签只看该标签下的应用（手工 `tags` + 自动 `tags_auto` 合并去重）。
- **「显示缺失条目」**：勾选后展示 `missing: true` 的条目（注册表里还有、但目录/脚本已不存在的应用，卡片半透明）。

### 一键启动

点卡片上的「启动」按钮即可。按钮颜色编码风险等级（越深越危险）：

| 风险 | 按钮样式 |
| --- | --- |
| `low` | 绿色 tonal |
| `medium` | 橙色 tonal |
| `high` | 红色 flat（实心） |

**风险确认**：`medium` / `high` 的条目启动前弹确认框，显示自动检测出的风险说明（`auto_note`）与手工备注（`note`），可勾选「知道了，以后不再提醒」——勾选后写入 `security.acknowledged: true`，以后直接启动不再询问。

启动行为由 `exec` 的字段决定：

- `terminal: true` → 在系统终端中运行（脱离 Cockpit）。
- `background: true` → 转为**后台任务**（见下节），不弹终端。
- `root: true` → 经 `pkexec` + helper 脚本以 root 运行。
- 配了 `transformer` + `transformer_display` → 启动后弹出**实时输出弹窗**（见下节）。

### 附加操作（actions）

卡片上「启动」旁边可以挂多个动作按钮（如 `开始` / `停止` / `重建`），每个按钮的**颜色同样按风险等级着色**（单个 action 可覆盖风险，否则回落条目级 `security.risk`）。点击与「启动」走完全相同的流程（风险确认 → 执行 → 实时输出）。

一个 action 可以是：

- **单步**：一个 `exec`，独立进程。
- **多步**：`steps` 数组，每行一条命令。中间步骤**无头执行并逐个 await**（任一失败即中止并报「步骤 N 失败」），只有**最后一步**前台启动（尊重它自己的 terminal / root / background 标记）。

### 后台启动（exec.background）

`background: true` 的条目（或 action）不会开终端，而是被交到**后台任务框架**：以 piped stdio 生成子进程，出现在全局「后台任务」面板——实时控制台、CPU/内存/显存统计、stdin 输入、Ctrl+C 信号与强制停止。任务**依附于本程序**，退出 Cockpit 时会被清理。启动返回的 `taskId` 可直接定位到面板里的任务。

### 实时输出 Transformer（可选，进阶）

给条目配上 `transformer`（一段 JS 构造函数，含 `onNewLine(e, ui)`）+ 打开 `transformer_display` 后，启动即弹出实时输出弹窗（80% 宽模态）：

- `ui` 是一组组件工厂，把进程输出解析成结构化展示：`NewText` / `NewTitle` / `NewAlign` / `NewBar` / `NewStatus` / `NewTable`，以及 `add(...)` / `clear()`。
- 弹窗可切换「组件视图 / 原始输出」（原始输出带 ANSI 上色、stderr 高亮）、自动滚动、清空、看退出码。
- 组件工厂与进程输出通过 `cockpit:proc-output` 事件实时流式推送，启动到弹窗打开之间的事件也有缓冲，不会丢。

### 新建 / 编辑条目

- **添加应用**：填名称、ID（留空自动生成）、目录/脚本路径（相对根目录或绝对路径）、描述、图标、执行类型、风险等级、命令、是否终端 / 后台 / 创建目录。可在展开的「多语言 / Multi-language」区为每个语言填名称与描述。
- **编辑**：卡片上的铅笔图标。除上述外还可改别名、标签、工作目录（`{self}` 或留空 = 条目自身目录）、风险备注、root 运行开关，并可**增删附加操作行**（ID、按钮名、图标、执行类型、命令、工作目录、风险、终端/后台/root、多步命令区）与 transformer。
- **图标语法**：`default/<名字>[/padding]`（内建 SVG 图标库）、`emoji/😎`、`file//绝对路径`（本地图片，经原生对话框选择），留空或 `auto` = 默认。

### 从侧栏快速启动

apps 能力向侧栏搜索框 / 右键菜单注入**快速动作**：每个应用的主启动 + 各附加操作（作为子菜单）。搜索框里输入应用名 / 别名 / 标签即可定位；点选后由应用页接管确认与启动流程，与卡片按钮行为完全一致。

### Markdown 导出

应用页支持把注册表导出为 Markdown 摘要（名称、路径、执行命令、风险、标签、附加操作、缺失标记）。`toMarkdown` 由框架的页面导出入口调用。

## CLI 命令参考

所有操作都是注册命令，可在内置 CLI REPL（`cli` 能力）中使用。`--flag value` 为命名参数：

| 命令 | 说明 | 示例 |
| --- | --- | --- |
| `apps.list` | 列出所有搜索目录下的应用 | `apps.list` |
| `apps.get` | 读取单个条目 | `apps.get --root ~/Apps --id bili-viewer` |
| `apps.config` | 读取 Apps 能力配置（搜索目录等） | `apps.config` |
| `apps.update` | 更新/创建条目（浅合并，`exec`/`security` 逐字段合并） | `apps.update --root ~/Apps --id bili-viewer --patch {"name":"x"}` |
| `apps.delete` | 删除条目 | `apps.delete --root ~/Apps --id start-rdp` |
| `apps.add-root` | 添加搜索目录 | `apps.add-root --path /home/aaaa0ggmc/Apps` |
| `apps.remove-root` | 移除搜索目录 | `apps.remove-root --path /home/aaaa0ggmc/Apps` |
| `apps.move-root` | 调整搜索目录顺序（`--dir -1` 上移 / `1` 下移） | `apps.move-root --path /home/aaaa0ggmc/Apps --dir 1` |
| `apps.create` | 创建新条目（可选 `--mkdir true` 顺带创建项目目录） | `apps.create --root ~/Apps --id myapp --patch {"name":"My App","exec":{"type":"custom","command":["run.sh"]}} --mkdir true` |
| `apps.rescan` | 重扫目录、生成草稿并合并 | `apps.rescan --root /home/aaaa0ggmc/Apps` |
| `launch.run` | 启动应用 | `launch.run --root ~/Apps --id bili-viewer` |
| `launch.action` | 运行应用的附加操作 | `launch.action --root ~/Apps --id new-api --action stop` |

### CLI 快捷词（REPL 层，apps 注入的词汇）

除了命令，CLI REPL 还有一层按别名/标签解析的快捷方式：

| 输入 | 说明 |
| --- | --- |
| `list` / `ls` | 列出全部应用（别名或 ID + 名称） |
| `info <别名>` | 查看应用详情（名称/别名/路径/类型/风险/标签/操作） |
| `launch <别名> [操作]` | 启动应用（或它的一个附加操作） |
| `run <别名> [操作]` | `launch` 的别名 |
| `<别名>` | 直接启动（裸别名解析：匹配 别名 / ID / 标签，忽略大小写） |
| `<别名> <操作>` | 直接执行应用的附加操作（如 `new-api stop`） |

## 配置文件与文件位置

### `~/.config/LinuxCockpit/apps/config.json` — 能力配置

```jsonc
{
  "searchRoots": [
    { "path": "/home/you/Apps", "watch": true }
  ],
  "confirmBeforeLaunch": false
}
```

- `searchRoots[].path`：搜索根目录；`watch`：是否用 chokidar 监视（默认 true）。
- 该文件缺失时按空配置处理（`searchRoots: []`）。

### `~/Apps/apps.json` — 应用注册表（每个搜索根目录一份）

```jsonc
{
  "version": 1,
  "apps": {
    "bili-viewer": {
      "name": { "zh": "哔哩观看器", "en_US": "Bili Viewer" },
      "alias": "bili",
      "description": "B 站视频下载",
      "path": "bili-viewer",
      "icon": "default/television",
      "exec": {
        "type": "uv",
        "command": ["bili-viewer"],
        "cwd": "{self}",
        "terminal": true
      },
      "actions": {
        "stop": {
          "name": "停止",
          "exec": { "type": "systemd", "command": ["stop", "bili.service"] },
          "risk": "low"
        }
      },
      "tags": ["python", "下载"],
      "security": {
        "risk": "medium",
        "auto_note": "脚本内包含 sudo 提权操作",
        "note": "需要读写 ~/Downloads",
        "acknowledged": true
      },
      "managed": false
    }
  }
}
```

字段说明：

- **`name` / `description` / `alias`**：可以是字符串，也可以是对象 `{ "zh": ..., "en_US": ... }`（回退链：当前语言 → `en_US` → 第一个可用值 → 原始值）。
- **`path`**：相对搜索根目录的目录/脚本路径，或绝对路径。工作目录默认取它所在目录（脚本文件取根目录本身）。
- **`exec`**：`{ type, command[], args?, cwd?, env?, terminal?, root?, background?, path? }`。
- **`exec.type`** 与生成的实际命令：

  | type | 实际执行 |
  | --- | --- |
  | `uv` | `uv run --directory <cwd> <command> <args>` |
  | `python` | `<cwd>/.venv/bin/python`（存在时，否则 `python3`）`<command> <args>` |
  | `node` | `node <command> <args>` |
  | `docker` | `docker <command> <args>` |
  | `systemd` | `systemctl [--user] <command> <args>`（`root: true` 时去掉 `--user`） |
  | `script` | `bash <脚本路径> <args>` |
  | `desktop` | `gio launch <desktop 文件>` |
  | `custom` | `<command> <args>` |

  始终用 `spawn(argv)` 执行，**绝不做 shell 拼接**。`root: true` 时外层包一层 `pkexec scripts/run-as-root.sh <cwd> <argv...>`；`terminal: true` 时再包一层系统终端。所有提权只经 `pkexec`，绝不直接开 root shell。

- **`cwd`**：`{self}` = 条目自身目录；`~` 开头扩展到家目录；绝对路径直接用；相对路径基于条目目录。留空默认 = 条目目录。
- **`actions.<id>`**：`{ name, description?, icon?, risk?, exec, steps? }`。
- **`security`**：`risk`（`low`/`medium`/`high`）、`auto_note`（扫描器自动生成，不可手改）、`note`（手工备注）、`acknowledged`。
- **`managed: false`**：手工维护的条目，重扫时**完全不动**。不设（或 true）的条目重扫时会用扫描草稿补齐空缺字段，但只更新 `tags_auto` 与 `security.auto_note`，**永不覆盖你手工编辑的内容**。
- **`tags_auto`**：扫描器按项目类型自动打的标签（python / node / script / docker / data），与 `tags` 合并显示。

### 其他

- **使用统计**：每次启动应用会往 `~/.config/LinuxCockpit/apps.csv` 记一条 `app:<root>:<path>`（纯统计，供设置页「清空使用记录」查看/清零）。

## 自动扫描（apps.rescan）

`apps.rescan --root <dir>` 会扫描根目录下一层，为检测到的项目**生成草稿条目**：

- 目录带 `pyproject.toml` → uv 工具（取 `[project.scripts]` 首个命令，默认终端运行）。
- 目录带 `package.json` → node 应用（`main` 或 `app.js`）。
- 目录带 `.venv` → `python main.py`。
- 目录带 `Dockerfile` → `docker compose up -d`。
- 未知目录 → `xdg-open .`（中等风险）。
- 脚本/二进制文件 → `bash` 运行。

合并策略：已存在条目只补空缺字段、刷新 `tags_auto` 与 `security.auto_note`；检测不到但注册表里有的 → 标记 `missing`；`foo.sh` 与同名 `foo/` 目录并存时去重（目录项目优先）。ID 由名称小写化（非字母数字转 `-`）生成。

**风险自动评估**：扫描器会读 `.sh/.py/.js/...` 文本文件内容，按危险规则打分——`curl|sh` / `wget|sh` 下载行为、`sudo`/`pkexec` 提权、`chmod`/`chown` 权限变更、`/etc/` 与 `rm -rf` 系统级修改、网络连接（`curl`/`wget`/`nc`/`ssh`）、疑似敏感凭据（`.env`/`api_key`/`token`/`secret`）→ 综合成 `low` / `medium` / `high` 与 `auto_note`。

## 常见问题 / 已知局限

- **新目录不会自动进注册表**：chokidar 只负责「文件变了页面即时刷新」，**不会自动为新项目生成条目**。新应用需手动「添加应用」或运行 `apps.rescan`。
- **扫描只覆盖一层**：watcher `depth: 2`，嵌套太深的目录结构变化可能不触发刷新；rescan 也只扫根目录下一层。
- **terminal / background 互斥**：后台任务会接管 stdout 管道，`terminal: true` 会被忽略（终端会吞掉管道）。
- **风险确认以条目为准**：已 `acknowledged` 的条目即使手工改回高风险也不会再弹确认——如需重新询问，需在编辑里重置或清掉 `acknowledged`。
- **`systemd` 类型**：`--user` 是默认（用户服务）；只有 `root: true` 才操作系统级服务。
- **`desktop` 类型**：依赖 `gio`（glib 工具链）；其它平台无 `gio launch` 语义。
- **删除即永久**：编辑弹窗的「删除」与 `apps.delete` 会直接从 `apps.json` 移除条目，不回收站。

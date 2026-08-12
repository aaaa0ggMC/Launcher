# 后台任务 (background)

后台任务是 Linux System Cockpit 的**纯后端能力**：它没有自己的页面、不进侧栏，而是向系统提供 `background-tasks` 能力——任何能力都能启动跨页面存活的长跑任务，统一由一个**全局面板**展示与交互。本页说明这个全局面板的用法、任务类型、生命周期与退出行为。

> 依赖 `background-tasks` 能力的能力：**apps**（应用后台运行）、**AIDJ**（AI DJ 持久轮播）、**playground**（接口调试的异步任务）等。若 `background` 能力被移除，这些能力的相关命令会一并失效。

## 使用教程

### 打开后台任务面板

后台任务面板由应用外壳（App.vue）提供，不归属任何能力页面：

- 点击侧边栏**底部**的**托盘图标**按钮（`mdi-tray-full`，悬停提示「后台任务」）即可打开
- 当有任务在运行时，按钮右上角会显示**运行中任务数量徽标**（超过 99 显示 `99+`）

### 面板布局

面板由左右两栏组成：

- **左侧列表**：所有任务的列表，可搜索、按状态过滤
- **右侧详情**：选中任务的控制台输出、进度与交互操作

#### 搜索与过滤

- 顶部搜索框按 **名称 / 描述 / 命令** 匹配
- 状态下拉：`全部` / `运行中` / `已退出` / `已停止` / `错误` / `已取消`，另有 **`子窗口`** 分类只显示程序创建的浮窗（如 AIDJ 歌词窗口），可在此对子窗口置顶、无边框/圆角、最小化、最大化或关闭

### 任务类型

后台任务分两种（列表中显示「进程」或「作业」标签，进程任务还显示 `pid`）：

- **进程任务（process）**：一个真实子进程（如应用"后台运行"、`background.start` 启动的命令）。有完整控制台输出、**资源统计**，支持 **stdin 输入**与 **信号**（Ctrl+C 等）
- **作业任务（job）**：抽象的长跑操作（下载、转换、AI DJ 轮播等），没有真实进程。由能力代码推送输出行与进度，可被「取消」

两种任务都有状态：`运行中`、`已退出`、`错误`、`已取消`、`已停止`。

### 详情区（控制台）

选中一个任务后，右侧显示其控制台输出：

- 输出**实时推送**；行内 ANSI 颜色可正常渲染，stderr 行显示为错误色
- 列表采用**滑动窗口**（每页 300 行）：默认展示最新输出，向上滚动到顶部或点「加载更早的输出…」可回看更早内容
- 作业任务若带进度，会在控制台底部显示进度条（0–100%）
- 结构化数据（如 AIDJ 的 now_playing 消息）会以可折叠 JSON 块展示

#### 向进程任务输入（stdin）

选中**运行中的进程任务**时，控制台下方出现输入行：

- 输入内容回车 → 写入进程 stdin（自动补 `\n`）
- **^C 按钮** → 向进程发送 `SIGINT`（等效 Ctrl+C）
- **^D 按钮** → 发送 EOF（`\u0004`）
- 输入框内也支持 Ctrl+C / Ctrl+D 快捷键

#### 生命周期操作

详情区顶部工具栏：

- **停止**（进程）→ 先发 `SIGTERM`，3 秒内未退出则升级为 `SIGKILL`；**取消**（作业）→ 通知任务取消（如中断下载）
- **强制结束**（进程）→ 立即 `SIGKILL`
- **移除**（已结束/已停止/错误/已取消的任务）→ 从列表移除
- **清空输出**（扫帚图标）→ 清空缓冲
- **导出输出**（导出图标）→ 把该任务完整输出保存为文件（主进程从权威缓冲读取）

面板标题栏的「移除已结束 (N)」可一键清掉所有已结束/已停止/错误/已取消的任务。

### 资源统计

运行中的进程任务在列表右侧显示三个统计标签：

- **CPU**：瞬时 CPU 占用百分比（经 pidusage 跨平台读取 `/proc`）
- **内存**：常驻内存（MB，大于 1 GB 显示 GB）
- **显存**：GPU 显存占用（MB，经 `nvidia-smi` 读取 compute-apps；无 NVIDIA 卡或工具缺失时显示 `—`）

统计约每 2 秒刷新一次；**作业任务没有进程，不显示资源统计**。

### 生命周期与退出确认

- 任务**依附于本程序**：退出应用时会统一结束所有运行中的子进程（SIGKILL），不会留孤儿进程
- 关闭窗口时若有任务仍在运行，主进程会拦截关闭并弹出确认框：「有 N 个后台任务正在运行，退出程序将终止它们。确定要退出吗？」
  - 可勾选 **「以后不再提醒」**（记忆在 localStorage `cockpit-bt-quit-suppress`），之后有任务运行时直接退出
  - 点击「退出程序」才会真正关闭并终止任务；「取消」则保持窗口与任务

## 内置作业

后台能力自带一个演示级命名作业处理器：

### `download`
把 URL 流式下载到本地文件，支持取消（中断下载并删除不完整文件）。

```
background.job --name download --args {"url":"https://example.com/a.zip","out":"~/Downloads/a.zip"}
```

- `args.url`：必填，源地址
- `args.out`：必填，目标路径（支持 `~/` 开头展开到主目录，自动创建父目录）
- `args.name`：可选，面板中的显示名（默认用 handler 名 `download`）
- 过程中实时推送进度与行日志；取消后状态为 `已取消` 并清理部分文件；出错标记为 `错误`

## CLI 命令参考

后台能力注册了 12 个命令（全局面板的操作也是通过这些命令实现的）：

| 命令 | 作用 | 示例 |
| --- | --- | --- |
| `background.list` | 列出所有后台任务 | `background.list` |
| `background.output --id <id>` | 读取任务的缓冲输出 | `background.output --id bt-xxx` |
| `background.export --id <id> --path <p>` | 导出任务缓冲输出到文件 | `background.export --id bt-xxx --path /tmp/out.log` |
| `background.clear-output --id <id>` | 清空任务的缓冲输出 | `background.clear-output --id bt-xxx` |
| `background.start --name <n> --command <argv>` | 启动一个进程任务 | `background.start --name ncm --command ["node","app.js"] --cwd ~/Apps/Music` |
| `background.input --id <id> --data <s>` | 向任务写 stdin | `background.input --id bt-xxx --data "y\n"` |
| `background.signal --id <id> --signal <s>` | 发送 POSIX 信号（默认 SIGINT） | `background.signal --id bt-xxx --signal SIGINT` |
| `background.job --name <handler> --args <json>` | 启动一个命名作业 | `background.job --name download --args {"url":"...","out":"..."}` |
| `background.stop --id <id>` | 停止任务（进程 SIGTERM→SIGKILL；作业取消） | `background.stop --id bt-xxx` |
| `background.kill --id <id>` | 强制结束进程任务（SIGKILL） | `background.kill --id bt-xxx` |
| `background.remove --id <id>` | 从列表移除已结束的任务 | `background.remove --id bt-xxx` |
| `background.clear-finished` | 一键移除所有已结束的任务 | `background.clear-finished` |

参数说明：

- `--command` 接受 **JSON argv 数组**（UI 传入）或**空格分隔的字符串**（CLI 传入），如 `--command node app.js`
- `background.start` 支持 `--cwd`（工作目录）与 `--description`（描述）
- `background.job` 的 `--args` 必须是一个**无空格分隔的 JSON 对象**（CLI 解析按空格切分）；未知 handler 名会返回 `未知作业处理器`
- 任务 id 形如 `bt-<时间戳>-<序号>`，可从 `background.list` 获取

## 配置项

后台任务能力无专属配置文件。其相关行为：

- 输出缓冲：每个任务保留最近 **5000** 行输出（`background.output` / 导出读取）
- 面板侧一次最多渲染 2000 条实时消息（超出丢弃最旧）
- 状态/进度广播 **100ms** 节流合并；日志/结构化输出**实时**推送
- 资源统计每 2 秒轮询一次；CPU/内存缺失时保留上次值，显存缺失显示 `—`
- 日志文件位置同全局：`~/.config/LinuxCockpit/logs/cockpit-YYYY-MM-DD.log`（scope `background` / `background-jobs`）

## 常见问题

**面板里没有任务？**

只有能力或应用启动的任务才会出现在这里（如应用的「后台运行」、AIDJ 持久轮播、playground 的异步任务、`background.start`/`background.job`）。面板显示「暂无后台任务」即为空态。

**进程任务无法输入 / 无法发信号？**

只有**运行中**的**进程任务**支持 stdin 输入与信号；作业任务没有进程，面板不显示输入行。

**按了「停止」进程还在？**

「停止」先发 SIGTERM 优雅退出，进程若不响应会在 3 秒后自动升级为 SIGKILL；也可直接点「强制结束」。

**退出应用会不会留下孤儿进程？**

不会。任务依附于本程序，退出时统一 SIGKILL；退出前如有运行中任务会先弹确认框。

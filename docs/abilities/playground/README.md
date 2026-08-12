# 接口调试（playground / Provider Playground）

面向 API 提供方的请求调试工作台：**模板驱动**的 HTTP 请求 + 变量插值 + 响应变换。把一次 API 调用固化成「模板」——URL、请求头、请求体里写上 `{变量}` 占位符，页面自动生成填写表单；发送后响应可做多级变换，直接渲染成文本 / 图片 / 音频 / 视频，还支持对异步任务接口的轮询与嵌套管道。

能力入口：侧栏「工具」→「接口调试」。首次打开自带一个「Example API」模板（POST httpbin.org）。

## 前置依赖

- **background-tasks 能力**（后台任务框架）：`task` 类型的响应变换通过命名作业 `pg-task` 在主进程后台轮询，跨页面存活。若 `background` 能力被移除，本能力因依赖缺失自动禁用（侧栏不显示、命令不注册）。
- 其余全为纯前端能力，无系统工具 / root 权限要求。

## 界面导览

主区自上而下：**模板编辑器**（名称 / 方法 / URL / 请求头 / 请求体 / 响应变换 / 变量徽标）→ **变量表单**（自动生成的填写区 + 发送按钮 + 历史）→ **最终响应**（变换结果）→ **响应查看**（原始响应）。右侧为可折叠浮层面板：**全局变量** + **模板列表**。

## 使用教程（UI）

### 模板列表与新建

右侧面板底部列出所有模板（名称 + 方法 + URL）。点击切换；「新建」创建空模板（默认 POST）。删除当前模板需在编辑区点「删除模板」并二次确认。

### 模板编辑

- **名称**：任意文本。
- **方法**：GET / POST / PUT / DELETE / PATCH。
- **URL 模板**：可直接写占位符，如 `https://api.example.com/v1/{model:string}`。
- **请求头**：每行一条 `Key: value`，值里同样支持占位符。
- **请求体**：任意文本（通常是 JSON），占位符值会按类型自动 JSON 转义（`textarea`/`string` 类型转义引号、反斜杠、换行、制表符），保证插值后仍是合法 JSON。
- **从其他模板复制**：可从列表任选一个源模板，一键复制「全部 / 请求头 / 请求体 / 变换」。
- **变量徽标**：编辑器下方自动列出模板中出现的所有变量，区分「全局（自动填充）」（名称与全局变量重名，不生成表单字段）与「表单字段」；徽标显示类型与约束。

### 变量占位语法

模板中任意位置写 `{变量}` 即成为可填写的变量。只匹配 `{字母开头}...`，不会误伤 JSON 的 `{}` 对象。

基本形式：

| 语法 | 含义 |
| --- | --- |
| `{name}` | 简单字符串变量 |
| `{name:type}` | 指定类型：`string` / `number` / `select` / `textarea` / `bool` |
| `{name:number:range(a,b)}` | 数值区间（`a`、`b` 可为小数）——表单自动变成滑块 + 数字框双控件 |
| `{name:number:min(v)}` | 最小值约束 |
| `{name:number:max(v)}` | 最大值约束 |
| `{name:options(a,b,c)}` | 下拉选项（逗号分隔，可用引号包住选项值）——**自动识别为 select 类型** |
| `{name:select:options(a,b,c)}` | 显式 select 类型 + 选项 |
| `{name:...:default(v)}` | 默认值。`default(...)` 必须以 `:default(v)` 形式追加在**约束段之后**（解析器按 `...:default(...)` 在串尾提取），如 `{width:number:range(256,1024):default(512)}`、`{name:options(a,b):default(a)}`；`bool` 类型默认值为 `default(true/false)`，其余类型默认值可用引号包裹 |

类型可自动推断：数值类约束（`range`/`min`/`max`）自动判定为 `number`；`options(...)` 自动判定为 `select`。

完整示例（来自内置模板）：`{width:number:range(256,1024)}x{height:number:range(256,1024)}` 会生成两个滑块；`{model_name:string}` 生成普通输入框；`{prompt:textarea}` 生成多行文本框；`{api_key:string}` 出现在请求头里生成密钥输入。

> 发送时变量解析顺序：**声明默认值 → 全局变量 → 表单已填值**，后者覆盖前者。带 `default(...)` 的变量即使用户留空也会带上默认值，**不会把原始 `{...}` 模板串发到服务器**。

### 变量表单（自动生成）

编辑器下方根据模板中出现的非全局变量自动生成表单，控件形态由类型/约束决定：

- `bool` → 复选框
- `select` / `options(...)` → 下拉选择
- `number` + `range` → 滑块（区间 ≤ 2 时步进 0.1）+ 数值输入框双控件
- `number` → 数字输入框；`textarea` → 多行文本；其余 → 单行文本

底部「发送请求」按钮发起请求，显示发送状态、响应耗时与状态码。

### 发送历史

按模板独立记录历史（去重：相同变量值只更新时间戳，不重复插入）。点击顶部「历史 (N)」展开最近 20 条，每条显示时间与耗时（失败显示 Error），点击某条历史可一键回填当时的变量值再重发；「清空」清除当前模板的历史。历史随模板一起持久化、随模板删除而删除。

### 响应查看

- 顶部：状态码徽标（<400 绿色，≥400 红色）、耗时（ms）、「清空」。
- JSON 响应默认以**可折叠树**展示（语法着色、长字符串折叠、嵌套对象/数组可点开）；可切换「原始」纯文本视图。
- 「复制」把原始响应写入剪贴板；「下载」把响应体存到本地（JSON 美化后存为 `response.json`，否则存为 `response.txt`）。
- 请求出错时显示错误信息。

### 全局变量

右侧面板「全局变量」区：`key` / `value` 键值对，可「显示/隐藏」切换密钥遮罩（密码框）。全局变量**自动注入**所有模板的插值（同名变量不会再生成表单字段），适合放 API 密钥、Base URL 等共用值。

### 响应变换（核心）

模板的「响应变换」区可添加一组变换，把原始响应逐级解析成最终结果。每个变换可折叠编辑，支持排序（上/下箭头）、删除与递归嵌套。

| 类型 | 作用 |
| --- | --- |
| `text` | 按 `format` 模板提取文本。格式串里写 `{.json路径}`，如 `{.choices[0].message.content}`；命中数组时自动枚举为 `0. …` / `1. …`；用 `[X]` 同步多个数组路径（`{.data[X].id} {.data[X].name}` 逐行对齐）；不同数组根做笛卡尔积 |
| `img` | 按 `entry` 路径取图片 URL 列表（如 `{.images}`），逐个渲染图片（可下载） |
| `audio` | 按 `entry` 取**内联**音频数据（base64 或 `hex8` 编码），解码为可播放音频；`encoding` 选 Base64/Hex8，MIME 可留空自动检测（mp3/wav/ogg/flac 按文件头识别） |
| `audio-url` | 按 `entry` 取 `http(s)` 音频 URL，主进程 `fetch` 抓取后转内联可播放（绕过跨域）；多个 URL 逐条枚举 |
| `video-url` | 同 `audio-url`，渲染为视频播放器 |
| `script` | 用户 JS。参数：`object` = 解析后的响应 JSON，`global_vars` = 全局变量映射，`context` = 结果注入器。用 `context.transform.add_text(lbl, text)` / `add_img(lbl, url\|url[])` / `add_audio(lbl, src, type?)` / `add_video(lbl, src, type?)` 追加结果段；`console.log` 可用（进主进程日志）。支持 `localVars`（`context.local.NAME`）。**脚本编辑区是草稿模式**：改完要点「更新」提交才生效（提交会重新执行，按钮出现 `*` 表示有未提交改动） |
| `task` | 异步任务轮询：见下节 |

脚本示例：`context.transform.add_text('Reply', object.choices[0].message.content)`。

### 异步任务（task 变换）

适用于「提交后返回任务 ID、需轮询状态」的异步接口：

- **任务 ID 路径**（`entry`）：初始响应中任务 ID 的 JSON 路径（如 `.task_id`）。
- **轮询 URL**（`taskAddr`）：状态查询地址模板，支持 `{变量}` 插值、`{.json路径}`（从初始响应取值）与 `{task_id}`；`task_id` 未在模板/查询中自带时会自动追加到查询串。
- **请求头 / 查询参数**：轮询请求的 headers 与附加 query（同样支持插值）。
- **状态路径 / 成功值**：每次轮询从响应解析状态字段，等于「成功值」时任务完成；可选「失败值 / 失败原因路径」判定失败（HTTP 400 也视为失败）。
- **轮询间隔 (ms)**：默认 2000。
- **响应变换（嵌套）**：任务成功后，对最终响应再跑一组子变换（text/img/audio/audio-url/video-url，不可再嵌 task），并可继续嵌套。

轮询由 `pg-task` 命名作业在**主进程后台**执行，切页不中断，进度显示在全局面板（后台任务对话框，详情视图为结构化 `response` 视图）；页面收到结果后渲染到「最终响应」区。失败的任务会渲染 Error 子项（红色），每个任务结果可点「重试」只重跑该任务。

### 最终响应

汇总所有变换结果，按块渲染：长文本 >400 字符自动折叠（可展开）、图片缩略图（每张带下载）、音频/视频播放器（带下载）；结果很多时（如 200+ 条）采用增量渲染（滚动到末尾逐批加载），避免卡顿。

### 本地下载

- 图片 / 音频 / 视频 / 文本结果均可「下载」到本地，弹出**原生保存对话框**（默认文件名由 URL 或 MIME 推导，如 `mp4`/`jpg`）。
- 下载经主进程 `fetch`（`playground.download-url` 命令）写盘，**不受渲染端跨域限制**。

## CLI 命令参考

配置导出导入与远程下载这三个涉及文件/网络的操作暴露为主进程命令，可在内置 CLI REPL（`cli` 能力）中使用；其余全部为纯前端功能：

| 命令 | 说明 | 示例 |
| --- | --- | --- |
| `playground.export` | 导出配置到 JSON 文件（`--path` 与 `--data` 必填）。写入 `{ version: 1, exportedAt, data }` | `playground.export --path /abs/playground.json --data '{"templates":[]}'` |
| `playground.import` | 导入配置（`--path` 必填）。要求文件含 `data.templates` 数组 | `playground.import --path /abs/playground.json` |
| `playground.download-url` | 下载远程资源到本地（`--path` + `--url` 或 `--text`） | `playground.download-url --url https://... --path /abs/file.jpg` |

返回值说明：

- `playground.export` → `{ ok, path, error? }`；缺参返回 `{ ok: false, error: '需要 --path 与 --data' }`。
- `playground.import` → 成功 `{ ok: true, templates, globals?, savedValues?, history? }`；缺 `templates` 数组时 `{ ok: false, error: '无效文件：缺少 templates 数组' }`。
- `playground.download-url` → 成功 `{ ok: true, path, bytes? }`；HTTP 错误 `{ ok: false, error: '下载失败 (HTTP <status>)' }`。

UI 的「导出配置 / 导入配置 / 各结果下载」按钮底层即调用这三个命令。

## 配置持久化与导出导入

所有运行数据存于**渲染端 localStorage**（随应用数据目录持久化），键名：

| 键 | 内容 |
| --- | --- |
| `rp_templates` | 请求模板数组 |
| `rp_globals` | 全局变量数组 |
| `rp_values` | 每个模板的已填变量值 |
| `rp_history` | 发送历史 |
| `rp_active` | 上次打开的模板 ID（失效时自动置空） |
| `rp_panel_collapsed` | 右侧面板折叠态 |

**导出配置**（顶部「导出配置」）：把模板 / 全局变量 / 已填值 / 历史整体写成一个 JSON 文件（默认名 `playground-<时间戳>.json`）。**导入配置**：从该文件整组恢复并**覆盖**当前数据。适合备份、换机迁移或在多台机器间同步。

## 常见问题 / 已知局限

- **任务结果没出现**：快速完成的任务结果早于 IPC 返回时，页面会自动从主进程环形缓冲回填一次，正常不会丢。若仍空白，检查后台任务面板中该任务的状态与日志（`pg-task` 的输出行）。
- **脚本改了不生效**：脚本是草稿模式，必须点「更新」（`*` 表示有未提交改动）；只有提交才重新执行脚本。
- **`audio` / `video` 下载的文件名**：内联 media 会取首个 URL/名称推导；`data:` 内联音频无 URL，默认文件名由 MIME 推导（如 `download.mp3`）。
- **响应过大**：JSON 树内长字符串折叠；最终响应超过 40 条结果采用滚动增量加载，列表超长时需滚动到底部逐批展开。
- **导入会整体覆盖**：导入不是合并，会用文件内容覆盖当前模板/全局变量/历史。
- **`task` 嵌套上限**：`task` 内可嵌子变换，但子变换不可再嵌 `task`（递归仅限 `taskTransforms` 内不再有 task，避免无界轮询）。
- **依赖背景任务能力**：`task` 变换依赖 `background-tasks`；该能力不可用时本能力整体不可用。

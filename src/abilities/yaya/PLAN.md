# YAYA (Yet Another Yes Agent) 架构规划与实施进度白皮书

> **项目代号**：`yaya` (Yet Another Yes Agent)  
> **所属架构**：Linux System Cockpit 下游智能体应用 / 独立公开子项目  
> **设计基线**：Electron + Vue 3 + Vuetify 3 (Material 3) + TypeScript + SQLite  
> **当前状态**：Phase 1–3 闭环可用（会话树 / 多服务商 / 工具循环 + 审批），Phase 4 附件已接通，输出 Slot 与 MCP 待做

---

## 一、 项目愿景与生态定位

### 1.1 为什么做 YAYA？与中游代理（如 codex-proxy-node）的本质区别

在当前的 AI Agent 生态中，存在两类典型分工：
1. **中游代理（Proxy / Router，如 `aaaa0ggMC/codex-proxy-node`）**：
   - 角色：位于下游客户端与上游大模型 API 之间的请求拦截与协议转译层。
   - 限制：中游代理由于缺乏用户交互界面与操作系统本地上下文，只能做“请求转发、模型重映射、鉴权管理、基础流式修饰”，其操作空间被死死限制在 HTTP/WebSocket 协议报文内，在面对多模态二次处理、本地系统命令审批、富媒体交互式渲染时往往“畏手畏脚”。
2. **下游终端系统（YAYA）**：
   - 角色：直接面向最终用户的生产力智能体中枢。
   - 优势：拥有对 **渲染层（Vue 3 / Vuetify 组件）**、**本地文件系统（Electron Node.js API）**、**本地系统提权通道（Cockpit pkexec helper）**、**本地数据库（SQLite DAG）** 以及 **全生命周期中间件** 的最高控制权。用户上传一个超大文件、或大模型想画一张拓扑图，YAYA 都能直接在终端完成拦截、拆解与富组件渲染。

### 1.2 借鉴市面标杆产品的“甜点区”融合 (Sweet Spot Synthesis)

| 产品 / 架构 | 核心优势借鉴 | YAYA 的吸收与融合策略 |
| :--- | :--- | :--- |
| **Hermes / OpenClaw** | 极强的本地工具自主调度与错误自愈（Self-Correction） | 引入内置系统工具集（文件读写、命令执行、Cockpit 注册命令调用），支持自主尝试、报错捕获与模型自我修正。 |
| **ClaudeCode** | 终端极简开发者体验、Thinking（深度推理）非侵入折叠、清晰的工具链状态展示 | 采用双轨折叠展示：思考过程（Reasoning）与工具调用（Tool Calls）均以紧凑胶囊卡片渲染，默认收起、点击展开，杜绝冗长 JSON 污染主视野。 |
| **Codex** | 灵活的 Multi-Provider 切换与动态端点抓取 | 支持动态 `/v1/models` 与 Ollama `/api/tags` 探测，提供全局与各 Provider 独立过滤，聊天过程中支持实时无缝切模。 |
| **DSH** | 结构化任务产物、可复现的工作流树 | 采用 SQLite 树状 DAG 消息拓扑，天然支持任意历史节点的分支重试（Branch Forking）与状态快照恢复。 |
| **AIDJ** | 胶囊输入框、磨砂玻璃拟态、后台任务无头托管机制 | 继承并重构 AIDJ 的优秀 UI 基因；将工作流挂载在主进程 Background Tasks，前端刷新或切换页面即时无损恢复。 |

---

## 二、 六大核心支柱架构详解

### 1. Loop 系统：Pipeline 中间件与生命周期驱动

#### 架构挑战
传统的 Agent Loop 通常是硬编码的单向循环：`用户输入 -> LLM 生成 -> 解析 Tool Calls -> 执行 Tool -> 回传结果 -> LLM 生成`。这种“毛胚房”模式下，一旦想加入“用户敏感操作审批”、“超长文本大纲转换”、“输出特定 DSL 转交互图表”等能力，就必须侵入性地修改核心循环。

#### YAYA 洋葱模型与生命周期 Hook
```
┌─────────────────────────────────────────────────────────────────┐
│                      Agent Loop Pipeline                        │
│                                                                 │
│  [用户输入] ──► 1. onInput (拦截多模态/超长文档/注入引用)          │
│                      │                                          │
│                2. onContextBuild (装配 SQLite 消息链/动态工具)   │
│                      │                                          │
│                3. onLLMRequest (流式调用/Token & 思考广播)      │
│                      │                                          │
│        ┌─────────────┴─────────────┐                            │
│        ▼                           ▼                            │
│  [文本输出完成]             [模型发起 Tool Call]                 │
│        │                           │                            │
│        │                     4. onToolCall (权限审批/执行/重试)   │
│        │                           │                            │
│        │                     [结果回写 tool 节点] ──► 回到 step 2 │
│        │                                                        │
│  5. onOutput (解析自定义组件/生成富文本状态)                     │
│        │                                                        │
│        ▼                                                        │
│   [完成工作流]                                                  │
└─────────────────────────────────────────────────────────────────┘
```

- **Headless 无头恢复**：工作流由主进程 `WorkflowRunner` 驱动，维护 `WorkflowSnapshot`（状态机：`idle` | `streaming` | `tool_executing` | `waiting_approval` | `interrupted` | `completed` | `error`）。渲染进程关闭或重新加载时，直接通过 `yaya.workflow-snapshot` 重建状态，不丢失上下文。
- **自愈与脏数据清洗**：在组装消息上下文时，自动清洗由于中断或报错导致的空 Assistant 节点（防止触发 OpenAI / DeepSeek 严格的 `400 Invalid assistant message: content or tool_calls must be set` 异常），并在重试时自动将父级指针回溯至正常节点。

---

### 2. Session 系统：从 JSONL 到 SQLite Tree 拓扑

#### 选型评判：JSONL vs SQLite DAG
- **AIDJ 原生 JSONL 方案**：
  - *优点*：轻量、天然追加日志（Append-only）、对单线顺序对话非常友好。
  - *缺点*：在通用 Agent 场景中，用户频繁需要 **Edit & Retry（编辑某条历史重新生成）** 或 **多分支比对**。在单线 JSONL 中表示树状分支极难维护指针，修改某节点时要么重写整个大文件，要么产生混乱的版本污染。
- **YAYA SQLite Tree 方案**：
  - 每条消息对应一行数据，核心字段：`id`（UUID）、`session_id`、`parent_id`（指向父消息 UUID）。
  - **分支遍历**：通过递归 CTE（Common Table Expression）单次查询即可拉取从当前活动叶节点（`active_leaf_id`）回溯到根节点的最优主干（`getMessageBranch`）。
  - **同级导航**：查询拥有相同 `parent_id` 的兄弟节点列表（`getMessageSiblings`），前端界面直接渲染 `< 1/3 >` 翻页器，实现随时切换分支。
  - **导出兼容**：对外依然提供一键平铺导出为通用 `JSONL` 或 `Markdown` 的能力，兼顾通用性。

---

### 3. 模型与多模态 Slot 系统 (Model & IO Slots)

#### 统一 Provider 抽象与动态探测
- 不捆绑单一厂商 SDK，通过统一的 `AIProvider` 抽象向下兼容：
  - OpenAI 官方端点 / 自建 Codex Proxy
  - DeepSeek API（天然支持 `reasoning_content` 思考流式解析）
  - 本地 Ollama（动态探测 `/api/tags`，支持纯本地离线推理）
  - 兼容 vLLM、One-API、New-API 等聚合网关
- **动态探测机制**：一键调用 `yaya.provider-fetch-models`，带超时熔断自动拉取最新可用模型清单。

#### 多模态输入 Slot (Input Interceptor)
- **直接处理**：图片类附件自动转为 Base64 塞入 OpenAI Vision 格式。
- **长文本/视频/代码库预处理 Slot**：
  - 当文件大小超过阈值（如 > 200KB 或 > 10,000 字）时，`LongDocumentPlugin` 拦截输入。
  - 将大文件存入本地缓存，并在系统提示词中注入元数据：  
    `<attachment id="doc_123" name="Linux_Kernel.pdf" summary="关于Linux内核调度器的详解..." />`
  - 自动向当前轮次注入专属检索工具 `search_document(doc_id, query)`，让 AI 按需索取上下文，避免 Token 瞬间被撑爆。

#### 多模态输出 Slot (Output Renderer)
- 大模型输出 Markdown 文本时，解析自定义组件标签或代码块（如 ````mermaid`、`yaya:widget` 等）。
- 客户端前端动态挂载为交互式 Vue 3 组件（流程图、表格筛选器、系统状态仪表盘），摆脱纯文本的死板表现。

---

### 4. UI 界面：契合 Launcher 哲学与 DESIGN.md 规范

#### 布局底线与滚动机制
- **铺满内容区**：根容器与 AIDJ 一致用 `position: absolute; inset: 0; overflow: hidden`，外壳不出滚动条，只有消息区滚动。
- **会话侧栏按容器宽度切换**（ResizeObserver，不看窗口断点）：≥ 900px 常驻可收起，< 900px 变为弹出抽屉 + 遮罩。
- **浮动置顶与置底**：
  - 顶部操作栏（TopBar）与底部药丸输入条（ChatInputBox）设置 `flex-shrink: 0`，固定在视口顶端与底端。
  - 仅有中间消息列表区（`.messages-scroll-area`）具备 `overflow-y: auto`，保障无论会话多长，头部状态与输入条始终触手可及。

#### Material 3 沉浸式视觉体验
- **呼吸留白**：文字按钮一律使用默认密度（`density="default"`），禁止使用 `size="small"` 导致文字挤贴边框。
- **优雅的状态反馈**：抛弃粗暴刺眼的粗红实色 `v-alert` 弹窗，改为沉浸式轻量卡片（`background: rgba(var(--v-theme-error), 0.08); border: 1px solid rgba(var(--v-theme-error), 0.22);`），配合 `mdi-alert-circle-outline` 图标与对齐留白，带来如 Claude/ChatGPT 般的细腻质感。
- **移动端全适配**：窄屏（≤ 720px）下顶栏只留菜单 / 模型 / 新对话 / 更多，消息去掉左侧缩进，工具调用参数摘要换行显示，弹窗全屏；触屏上回车换行、用发送按钮发送，悬停才出现的操作改为常显。
- **无彩色裸 Emoji**：所有侧栏与状态图标统一采用 Curated SVG 或 MDI 单色矢量图标，与主题色无缝融合。

---

### 5. 数据保存与多模态资产 (Persistence & Assets)

- **双轨制架构**：
  - 结构化关系数据（Session 元数据、Message 树节点、工具调用记录）保存在 `~/.config/LinuxCockpit/yaya/yaya.db`。
  - 多模态实体（用户上传的文件、图片、生成的图表、音频）保存在本地独立资产目录：  
    `~/.config/LinuxCockpit/yaya/assets/<session_id>/`
- **安全预览**：通过 Electron 主进程注册专用私有协议或通过 Base64 本地管道安全访问，杜绝把大型二进制直接塞进 SQLite 导致数据库体积膨胀变慢。

---

### 6. 数据备份与第三方平台导入 (Importers)

- **导入器抽象架构**：基于主进程 Background Tasks 异步运行，避免导入成百上千条会话时阻塞渲染进程。
- **支持导入源**：
  1. **OpenAI**：解析 `conversations.json`，还原 mapping 字典中的树状分支关系。
  2. **Claude**：解析 Anthropic 导出格式，映射为 YAYA 节点。
  3. **DeepSeek / Rikkahub**：解析标准导出会话格式。

---

## 三、 详细实施进度表 (Implementation Status)

### 状态图例说明
- `[x]` **已完成**：功能完整落地，经过 TypeScript 类型检查、ESLint 校验与实机运行验证。
- `[-]` **演进中 / 部分完成**：核心原型已跑通，正按照本规划进一步优化或重构。
- `[ ]` **待实施**：已完成技术方案设计，待下阶段排期实现。

---

### 阶段一：基础设施与核心会话系统 (Foundation & Sessions)

| 模块 | 子功能 | 状态 | 当前实现位置 / 说明 |
| :--- | :--- | :---: | :--- |
| **项目基建** | 能力模块注册与元数据声明 | `[x]` | `index.ts`, `meta.ts`, `types.ts` |
| | 主进程命令集 (`CommandSpec[]`) + 隐私声明 | `[x]` | `commands.ts`（工作流 / 资产导入 = `system.exec`；审批、改配置 = 仅用户） |
| **SQLite 树库** | 表结构 (`sessions`, `messages`) | `[x]` | `services/db.ts`（`node:sqlite` 内置，无原生依赖） |
| | 分支回溯 + 同级分支一次查询附带 | `[x]` | `getMessageBranchWithSiblings`（替代界面逐条请求 siblings） |
| | 切换分支自动走到该分支最新叶子 | `[x]` | `findLatestLeaf`（旧实现会截断该分支的后续对话） |
| | 会话增删改、删除时清理资产目录 | `[x]` | `db.ts` / `assets.ts` |
| | 新对话懒创建（首次发送 / 添加附件才建会话） | `[x]` | `View.vue`（不再产生空会话） |
| | 首句自动作为会话标题、会话重命名 | `[x]` | `View.vue`, `ChatSessionList.vue` |
| **数据导出** | 导出 Markdown（当前分支 / 整棵树） | `[x]` | `services/export.ts`，`yaya.session-export[-file] --format md` |
| | 导出 JSONL | `[x]` | 同上 `--format jsonl` |

---

### 阶段二：多服务商管理与模型层 (Model Layer & Dynamic Providers)

| 模块 | 子功能 | 状态 | 当前实现位置 / 说明 |
| :--- | :--- | :---: | :--- |
| **配置存储** | 配置读写、密钥加密落盘 | `[x]` | `services/config.ts` |
| | 密钥不下发渲染端（`apiKeySet`），留空保存 = 保留 | `[x]` | `publicYayaConfig` / `mergeIncomingYayaConfig` |
| | 助手显示名 `assistantName`（默认 YAYA），提示词 `{name}` 占位 | `[x]` | 设置页「助手」，页面顶部 / 消息署名 / 导出都用它 |
| **Provider 适配** | OpenAI 兼容（流式 / reasoning_content / tool_calls） | `[x]` | `services/providers/openai.ts` |
| | 空节点清洗（防 400 content or tool_calls） | `[x]` | `runner.ts` `buildMessages` + provider |
| | Ollama / Codex Proxy（同走 OpenAI 兼容） | `[x]` | `services/models.ts`（`/api/tags` 探测） |
| | Anthropic / Gemini 原生 Provider | `[ ]` | 未实现，设置里已移除这两个选项（不装样子）；需要时先写 Provider 再开放 |
| **动态模型选择** | `/v1/models` 嗅探 | `[x]` | `fetchModelsFromEndpoint` |
| | 模型选择弹窗（全局搜索 + Provider 过滤，窄屏全屏） | `[x]` | `components/ModelSelectDialog.vue` |
| | 会话级模型切换（同时作为新对话默认） | `[x]` | `View.vue` |

---

### 阶段三：Agent Loop 与工具系统 (Agent Core & Tools)

| 模块 | 子功能 | 状态 | 当前实现位置 / 说明 |
| :--- | :--- | :---: | :--- |
| **Loop 引擎** | `WorkflowRunner`：每步节点必落终态 | `[x]` | `services/loop/runner.ts`（修复：中止后被覆盖为 completed、步数上限留下悬空 streaming 节点） |
| | 流式内存缓冲 + 拉取时叠加，token 事件带 offset 去重 / 补洞 | `[x]` | `overlayLiveBuffer` + `View.vue` `applyChunk` |
| | 重新生成 = 新兄弟分支（不再复制一条用户消息） | `[x]` | `yaya.workflow-regenerate` |
| | 编辑用户消息并重发 = 新分支 | `[x]` | `UserMessage.vue` → `workflow-start --parent` |
| | 运行中会话广播（侧栏指示） | `[x]` | `cockpit:yaya-running` / `yaya.workflow-running` |
| **工作流** | 工作流注册表：runner 只做宿主（步骤节点 / 流式 / 工具与审批 / 子 Agent / 过程记录），流程由工作流描述 | `[x]` | `services/workflow/`（`registerWorkflow`，契约见 `types.ts` 文件头） |
| | 内置工作流：`agent` 工具循环 / `chat` 纯对话 / `plan-act` 规划子 Agent + 执行 | `[x]` | `workflow/builtin.ts`；会话级选择（输入框）+ 设置里的默认工作流 |
| | 过程记录持久化（每步 Agent / 耗时 / tokens / 子 Agent 输出） | `[x]` | `messages.meta.workflow`（挂在一次运行的第一个 assistant 节点上） |
| | 流式 usage（`stream_options.include_usage`，网关不支持时自动退回） | `[x]` | `providers/openai.ts` |
| | 更多工作流（审阅 / 多 Agent 并行等）、MCP 工具编排 | `[ ]` | 照 `builtin.ts` 注册即可 |
| **内置工具** | `get_system_time` / `cockpit_list_commands` / `cockpit_command` | `[x]` | `services/tools/registry.ts`；`cockpit_command` 对需授权的命令要求确认，禁止调用 `yaya.*` |
| | `read_file`（分段 / 目录列表）/ `write_file` / `run_bash` | `[x]` | 结果统一截断，`run_bash` 可被「停止」中断 |
| | `fetch_url`（HTML 去标签、超时） | `[x]` | 同上 |
| | 工具逐个启用 / 禁用 | `[x]` | `disabledTools` + `yaya.tools-list`，设置页「工具」 |
| | ~~`search_document`~~ | 移除 | 原为返回固定字符串的假工具；等长文档 Slot 真正实现再加 |
| **安全与授权** | 工具调用内联审批（参数预览 + 允许 / 拒绝） | `[x]` | `ToolCallRow.vue`；重启后挂起的审批收敛为中断 |
| **外部生态** | MCP 客户端 | `[ ]` | `mcpServers` 配置字段已有，客户端未实现 |

---

### 阶段四：多模态与插件 Slot 系统 (Multimodal Slots)

| 模块 | 子功能 | 状态 | 当前实现位置 / 说明 |
| :--- | :--- | :---: | :--- |
| **附件** | 选文件 → 复制进会话资产目录 | `[x]` | `yaya.asset-import`（≤ 25MB，网页模式同样可用） |
| | 图片 → Vision；文本 ≤ 200KB 内联；其余给路径让模型用 `read_file` | `[x]` | `providers/openai.ts` `attachmentParts` |
| | 缩略图预览 | `[x]` | `yaya.asset-preview`（data URL，≤ 4MB） |
| | `yaya-asset://` 协议 | `[ ]` | 目前只做路径解析（已防 `../` 越界） |
| **输入预处理 Slot** | 超大文件摘要 + 检索工具 | `[ ]` | |
| **输出渲染 Slot** | Markdown 代码块高亮 + 复制 | `[x]` | `components/markdown.ts`（highlight.js 按需加载，配色跟主题） |
| | Mermaid 渲染 | `[ ]` | 需要新依赖，待定 |
| | SVG / HTML 小部件沙箱 | `[ ]` | |

---

### 阶段五：UI/UX (DESIGN.md)

| 模块 | 子功能 | 状态 | 当前实现位置 / 说明 |
| :--- | :--- | :---: | :--- |
| **布局** | 铺满内容区、常驻 / 弹出式会话侧栏 | `[x]` | `View.vue` |
| **消息** | 按「轮次」渲染：中间步骤收进过程卡片，气泡只放最终回答 | `[x]` | `components/turns.ts`（含单测）+ `AssistantTurn.vue` + `WorkflowCard.vue` |
| | 气泡：助手玻璃底 + 边框，用户 primary 色调 + 边框 | `[x]` | |
| | 右键 / 长按菜单：复制、复制选中、复制 Markdown、编辑、重新生成、删除分支 | `[x]` | `MessageMenu.vue`；长按指令移到 `@ui/directives/long-press` 共用 |
| | 输入框展开 / 收起（展开态 Ctrl+Enter 发送、Esc 收起）+ 工作流选择 | `[x]` | `ChatInputBox.vue` |
| **设置** | 分层导航：宽屏左侧导航，窄屏逐层进入；工具搜索 / 筛选 / 批量开关；服务商列表 → 详情 | `[x]` | `YayaSettingsSection.vue` + `components/settings/` |
| | 用户消息：复制 / 编辑重发 / 分支翻页 / 图片缩略图 | `[x]` | `UserMessage.vue` |
| | 停止 = 安静的「已停止」，错误 / 重启中断才用提示条 | `[x]` | `AssistantTurn.vue` |
| | 贴底自动跟随、上翻后「回到底部」 | `[x]` | `View.vue` |
| **i18n** | 全部文案走翻译（zh / en-US） | `[x]` | `translations/` |
| **移动端** | 窄屏布局、触屏常显操作、弹窗全屏 | `[x]` | 各组件 `@media (max-width: 720px)` / `(hover: none)` |

---

### 阶段六：生态连接与外部数据导入 (Importers & Ecosystem)

| 模块 | 子功能 | 状态 | 当前实现位置 / 说明 |
| :--- | :--- | :---: | :--- |
| **OpenAI 导入** | `conversations.json` → 消息树（re-parent、current_node、去重、事务） | `[x]` | `services/importers/openai.ts` |
| | 后台任务运行（进度 / 停止） | `[x]` | `jobs.ts` `yaya.import-openai` |
| **Claude / DeepSeek / Rikkahub 导入** | | `[ ]` | |

---

## 四、 后续开发路线与近期优先级 (Next Action Items)

1. **短期**：实机走一遍（桌面 + 400px / 650px 窄屏），重点看流式输出、工具审批、分支切换、附件。
2. **中期**：MCP 客户端（stdio / SSE）→ 动态挂载外部工具（设置的工具页已按来源分组 + 搜索，可直接容纳）；长文档 Slot（摘要 + 检索工具）；更多工作流。
3. **长期**：Claude / DeepSeek 等导入器；输出小部件沙箱。


---

## 五、 第二阶段（Era 2）：Plugin 架构 —— 工具 / MCP / Skill 统一为插件

> 2026-10-04 立项。参考 `aaaa0ggMC/codex-proxy-node` 的插件分层（plugin = tools + instructions + fences + contribute），
> 但 YAYA 掌握对话存储与渲染端，所以「富文本变换」只发生在**显示层**：数据库永远存模型的原文，
> 发给模型的历史与上一次逐字节相同 → 提示词缓存不受影响，也不需要 codex-proxy 那套 restoreText。

### 5.1 概念

| 概念 | 含义 |
| :--- | :--- |
| **Plugin** | 前后端结合的扩展单元。后端：0..n 个 tools、`instructions`（拼进系统提示词的片段）、生命周期（连接 / 释放）；前端（可选）：代码块渲染器（fences）、工具结果视图（toolViews）。 |
| **Tool** | 属于某个插件。对模型暴露的名字 = wire name（内置 `system` 插件不加前缀以兼容旧会话；其余 `<插件>_<工具>`，超 64 字符截断 + 稳定哈希）。可单独开关、单独设置审批（ask / auto / 跟随提供方默认）。 |
| **MCP** | 一种动态插件：每个 MCP 服务器 = 一个插件，tools 来自 `tools/list`。传输 Streamable HTTP / SSE，可配置自定义 Header（值加密存储、不下发渲染端）。 |
| **Skill** | 一种动态插件：`~/.config/LinuxCockpit/yaya/skills/<名字>/SKILL.md`（frontmatter `name` / `description` + 正文，可带附属文件）。按「渐进披露」：系统提示词只列名字与描述，模型需要时调用 `skill_load` / `skill_read_file` 取正文与附件。 |
| **Cockpit 插件** | 内置插件，把 Cockpit 自己的 agent 工具表（`commands_list` / `command_run` / `ui_*` …）在进程内直接暴露给 YAYA，`ui_*` 直接操作当前界面；结果用专门的视图优雅展示（截图、命令表、无障碍树）。 |

### 5.2 安全边界（重要）

- YAYA 的工具调用此前继承 `ui` 来源，等于用户亲手操作，**绕过了隐私 SDK**。新增来源 `local-agent`（进程内 LLM agent，属于 agent 来源）：
  工具执行一律 `withOrigin({ kind: 'local-agent', session: 'yaya:<会话>', client: <助手名> })`，脱敏 / 授权窗口 / `agent: 'deny'` 自动生效。
- YAYA 运行工作流时注册为 agent 会话（`sessions.ts`，transport `local`）：标题栏 AgentBar 出现它的小动物头像，描边提示「AI 正在操作」。
- **人机共用界面时的中途叫停**：点击 YAYA 的头像 → 暂停 / 继续 / 停止。宿主在每步开始、每次工具调用前检查暂停闸门；另提供「暂停所有 AI 操作」全局快捷键（默认不绑定）。会话控制做成通用接口（`setSessionControl`），以后 MCP 会话也能用。

### 5.3 打断不回滚（steer）

运行中输入框保持可用：发送 = 停止当前运行（保留已生成的内容与已执行的工具结果）+ 以新消息继续。
宿主组装历史时修复悬空的 tool_calls（缺结果的调用补「已中断」结果），保证不触发 400。

### 5.4 工作包

| 包 | 内容 | 负责 |
| :--- | :--- | :--- |
| A1 | 插件 SDK 契约与注册表（后端）、内置 `system` 插件迁移、tool 结果规范化（文本 / 图片 → 资产）、`yaya.plugins-list` | 副总监 |
| A2 | `local-agent` 来源、agent 会话注册、会话控制（暂停 / 继续 / 停止）+ AgentBar 弹层、宿主暂停闸门 | 副总监 |
| A3 | 渲染端插件 UI 契约：`plugins/<id>/ui.ts`（fences / toolViews），Markdown 分段渲染 | 副总监 |
| A4 | 打断不回滚：历史修复 + 运行中可发送 | 副总监 |
| B1 | MCP 插件提供方（Streamable HTTP / SSE、Header、连接状态、测试 / 刷新命令） | Step |
| B2 | Skill 插件提供方（扫描、解析、`skill_load` / `skill_read_file`、导入） | Step |
| B3 | 设置 → 插件页（插件 / MCP / Skills 三个分页、插件详情含工具开关与审批、MCP 编辑器、Skill 列表） | Step |
| B4 | Cockpit 插件（包装 agent 工具表、zod → JSON Schema、截图 / 命令表 / 快照视图） | Step（依赖 A2） |

### 5.5 进度

- [ ] A1　- [ ] A2　- [ ] A3　- [ ] A4　- [ ] B1　- [ ] B2　- [ ] B3　- [ ] B4

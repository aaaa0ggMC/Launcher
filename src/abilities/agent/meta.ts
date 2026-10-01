// 前后端共享能力元数据 — 主进程命令加载器与渲染端能力加载器共同消费。
// 前端专属（页面/设置）放 index.ts，后端专属（命令）放 commands.ts。
// 无 platforms = 全平台可用。
// Remote / MCP 网关本体是框架（src/main/process/agent/）；本能力暴露 agent.* 命令 + 设置页分类。
export const provides: string[] = ['agent-access']
export const dependencies: string[] = []

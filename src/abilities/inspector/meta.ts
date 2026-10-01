// 前后端共享能力元数据 — 主进程命令加载器与渲染端能力加载器共同消费。
// 前端专属（页面/设置）放 index.ts，后端专属（命令）放 commands.ts。
// 无 platforms = 全平台可用。
// UI inspector 本体是框架（src/main/process/inspector.ts）；本能力只暴露 ui.* 命令。
export const provides: string[] = ['ui-inspector']
export const dependencies: string[] = []

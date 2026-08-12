// 前后端共享能力元数据 — 主进程命令加载器与渲染端能力加载器共同消费。
// 前端专属（页面/设置）放 index.ts，后端专属（命令）放 commands.ts。

export const platforms: string[] = ['linux']
// AIDJ 的持久轮播 / 对话 / 元数据同步都跑在后台任务上（jobs.ts + btJob），需要 background-tasks 能力。
export const provides: string[] = []
export const dependencies: string[] = ['background-tasks']

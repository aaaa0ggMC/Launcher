// 前后端共享能力元数据 — 主进程命令加载器与渲染端能力加载器共同消费。
// 前端专属（页面/设置）放 index.ts，后端专属（命令）放 commands.ts。

export const platforms: string[] = ['linux']
export const provides: string[] = []
export const dependencies: string[] = []

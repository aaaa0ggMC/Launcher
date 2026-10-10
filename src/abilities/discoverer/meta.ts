// 前后端共享能力元数据 — 主进程命令加载器与渲染端能力加载器共同消费。
// 前端专属（页面/设置）放 index.ts，后端专属（命令）放 commands.ts。
// 全平台可用（UDP 广播在 Linux / Windows / macOS / Termux 上都能跑）；
// 依赖后台任务框架（常驻扫描作业 discoverer.scan）。
export const platforms: string[] = []
export const provides: string[] = []
export const dependencies: string[] = ['background-tasks']

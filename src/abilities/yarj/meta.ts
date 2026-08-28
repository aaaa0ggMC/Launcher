// 前后端共享能力元数据 — 主进程命令加载器与渲染端能力加载器共同消费。
// 前端专属（页面/设置）放 index.ts，后端专属（命令）放 commands.ts。

// 全平台可用（无发行版/桌面依赖；MBTiles 读取走 node:sqlite 内置模块）。
export const platforms: string[] = []

// 扫描（yarj.scan）跑在后台任务框架的命名作业上（jobs.ts + startJobByName），
// 需要 background-tasks 能力（与 apps / aidj 一致）。
export const provides: string[] = []
export const dependencies: string[] = ['background-tasks']

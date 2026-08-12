// 前后端共享能力元数据 — 主进程命令加载器与渲染端能力加载器共同消费。
// 前端专属（页面/设置）放 index.ts，后端专属（命令）放 commands.ts。
// 无 platforms = 全平台可用。
// 向系统提供「background-tasks」能力：后台任务框架（startProcessTask / btJob / 命名作业）。
export const provides: string[] = ['background-tasks']
export const dependencies: string[] = []

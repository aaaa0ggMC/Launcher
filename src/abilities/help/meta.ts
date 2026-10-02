// 前后端共享能力元数据 — 主进程命令加载器与渲染端能力加载器共同消费。
//
// help 是一个纯后端能力：它只注册 help.tree / help.read 两个命令，向外壳的
// 帮助浮窗提供各能力 `help/` 目录的导航结构与 Markdown 内容，自身没有页面。

export const platforms: string[] = []
export const provides: string[] = []
export const dependencies: string[] = []

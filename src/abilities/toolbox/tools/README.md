# 工具模块

每个分组包含 definitions.ts（纯数据，渲染端可导入）和 service.ts（主进程执行）。
工具使用 toolbox.<id> 明确命令，接口见 ../types.ts。definitions 不得导入 service。
输入文件是 ToolFile（name/mime/base64）；结果文件也使用 ToolFile，保存统一由 toolbox.export 完成。
工具不保存用户输入、文件或结果。外部程序只处理隔离临时目录，参数数组执行并清理。

# Android 客户端 v0.4

版本号 `0.4.0`，versionCode 为 `4`。网页界面来自宿主，界面更新需要同时更新宿主；APK 更新提供原生侧体验改进。

- **目录选择**：网页端的「宿主文件选择器」（`src/main/ui/components/HostFilePicker.vue`）在目录模式下新增「从设备选择文件夹」，走原生 `pickDirectory` → `ACTION_OPEN_DOCUMENT_TREE`，把 SAF 树映射成宿主上的真实路径回给页面（只认 `primary` 卷 / 手机内置存储；SD 卡、Downloads、网盘给不出确定路径，明确失败而不是猜一条）。初始目录用当前路径反推（`EXTRA_INITIAL_URI`）。
- 浏览器（非 App）拿不到宿主持有的目录路径：目录模式下显示一行说明，保留浏览与手输。文件的「从此设备选择」不变（上传后回传宿主路径）。
- 网页端「选择此文件夹」现在以路径输入框为准：用户改了路径但没按回车时，先跳到该目录列出内容（读不了就地报错、不当成选中），再交出**归一化后**的路径。此前直接确认返回的是当前列出的目录，手输 `/storage/emulated/0/xxx` 会被回退成 Termux 家目录。
- 桌面仓库版本号升到 `0.4.0`（原本 `0.3.0`）。

已通过 Gradle `assembleDebug` 编译，APK `versionCode=4 versionName=0.4.0`。Symlink 反推的卷 id 分支已移除，只保留能给出确定路径的 `primary`；新增的 Java 逻辑没有单元测试，需要在真机验证系统目录选择器的返回形态（各家 ROM 的文档 id 前缀是否一致）。

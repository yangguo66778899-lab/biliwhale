BiliWhale — 便携版
==================

这是一个免安装的便携包：解压到任意目录，双击 BiliWhale.cmd 就能跑。
数据不放在这里，统一放在 %APPDATA%\BiliWhale（卸载/换版本都不会丢）。

第一次用
--------
1. 双击 BiliWhale.cmd（会起托盘；右键图标有菜单）
2. 托盘右键 → 打开面板 → 面板「账号」页扫码登录 B 站
3. 同一个页面填「主人 UID」：你自己的另一个 B 站号（@、私信、聊天都发给它；不能填登录账号自己）
4. 设置 → DeepSeek 填 API key（或者用环境变量 BILIWHALE_API_KEY）
5. 概览页点「预演一轮」看效果；确认没问题再打开「设置 → 分享 → 允许对外分享」

想装到开始菜单（当前用户，不需要管理员）
----------------------------------------
双击 install.cmd。它会：
  - 复制到 %LOCALAPPDATA%\Programs\BiliWhale
  - 建开始菜单快捷方式（加 --desktop 再加一个桌面快捷方式）
  - 设用户环境变量 BILIWHALE_KERNEL_CMD（托盘用它拉起内核）
  - 加 --autostart 会写开机自启（只起托盘，不弹窗）
  - 最后启动托盘（-NoLaunch 可跳过）

卸载
----
双击 uninstall.cmd（默认**保留数据**）；要连数据一起删：
  uninstall.cmd --remove-data
程序目录与快捷方式会被删掉，数据在 %APPDATA%\BiliWhale 由你决定去留。

升级
----
1. 先备份：托盘面板 → 关于 → 备份数据（或命令行 `runtime\node.exe app\src\cli.ts backup`）
2. 用新的便携包覆盖 app\ 与 runtime\（老便携包：直接解压覆盖；安装版：再跑一次 install.cmd）
3. 数据不用动；配置会按 schema 自动迁移（日志里会写迁移了哪一步）
4. 想回滚：装回旧版本的 app\ + 用刚才的备份恢复数据

出问题时
--------
- 面板 → 日志 → 下载诊断包（脱敏，不含 cookie/key），把它发给开发者
- 命令行体检：runtime\node.exe app\src\cli.ts doctor
- 数据目录：%APPDATA%\BiliWhale；日志：%LOCALAPPDATA%\BiliWhale\logs

许可
----
MIT。第三方归属见 app\NOTICE。参考项目：dsh-bili-whale、dsh-bili-scroll。

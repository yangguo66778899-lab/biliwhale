# BiliWhale 便携启动器（真正干活的地方）。
#
# 为什么逻辑放在 .ps1 而不是 .cmd：cmd.exe 按系统 ANSI 代码页解析 .cmd，
# UTF-8 中文会把命令拆断（真实事故：双击只闪一下，`start` 被截成 `rt`）。
# 所以 BiliWhale.cmd 只做 ASCII 转发，中文与实际逻辑都在这里。
#
# 做的事：① 检查包是否完整 ② 设 BILIWHALE_KERNEL_CMD（两个路径都带引号）
# ③ 启动托盘（托盘负责起内核并开面板）。没有托盘 exe 时退回「在当前窗口起内核」。

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $PSCommandPath
$node = Join-Path $here "runtime\node.exe"
$cli = Join-Path $here "app\src\cli.ts"
$tray = Join-Path $here "app\shell\BiliWhaleTray.exe"

if (-not (Test-Path $node)) {
  Write-Host "找不到 runtime\node.exe：这个便携包不完整（是不是只解压了一半，或者还在压缩包里？）" -ForegroundColor Red
  Read-Host "按回车关闭"
  exit 1
}
if (-not (Test-Path $cli)) {
  Write-Host "找不到 app\src\cli.ts：这个便携包不完整。" -ForegroundColor Red
  Read-Host "按回车关闭"
  exit 1
}

# 托盘靠这个环境变量拉起内核；两个路径都带引号（目录里可能有空格和中文）
$env:BILIWHALE_KERNEL_CMD = '"{0}" "{1}" serve' -f $node, $cli

if (Test-Path $tray) {
  # 启动托盘后就退出：它会在后台起内核、开面板。关掉面板窗口不等于退出程序。
  # 注意：$args 为空时不能传 -ArgumentList（Start-Process 会报「参数为 null」直接失败）
  if ($args.Count -gt 0) {
    Start-Process -FilePath $tray -WorkingDirectory (Split-Path -Parent $tray) -ArgumentList $args | Out-Null
  } else {
    Start-Process -FilePath $tray -WorkingDirectory (Split-Path -Parent $tray) | Out-Null
  }
  exit 0
}

Write-Host "没有托盘程序，直接在当前窗口起内核（关掉这个窗口就停了）。"
& $node $cli serve

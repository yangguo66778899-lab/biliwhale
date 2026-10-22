# BiliWhale 安装脚本（当前用户，不需要管理员）
#
# 做的事：
#   1. 把本目录的 app\ 与 runtime\ 复制到 %LOCALAPPDATA%\Programs\BiliWhale
#   2. 设一个用户环境变量 BILIWHALE_KERNEL_CMD，让托盘知道怎么拉起内核
#   3. 建开始菜单快捷方式（-Desktop 再加一个桌面快捷方式）
#   4. -Autostart 时写 HKCU\...\Run（只起托盘，不弹窗、不抢焦点）
#   5. 除非 -NoLaunch，最后启动托盘
#
# 数据不会被碰：配置/账本/报告在 %APPDATA%\BiliWhale，日志在 %LOCALAPPDATA%\BiliWhale。
# 卸载见 uninstall.ps1（默认保留数据）。
param(
  [switch]$Autostart,
  [switch]$Desktop,
  [switch]$NoLaunch,
  [string]$Target = ""
)

$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $PSCommandPath
$appName = "BiliWhale"
if ([string]::IsNullOrWhiteSpace($Target)) {
  $Target = Join-Path $env:LOCALAPPDATA "Programs\$appName"
}

function Write-Step($text) { Write-Host "  $text" }
function Fail($text) { Write-Host "出错了：$text" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "BiliWhale 安装（当前用户，不需要管理员）"
Write-Host "  来源：$source"
Write-Host "  目标：$Target"
Write-Host ""

if (-not (Test-Path (Join-Path $source "app\src\cli.ts"))) { Fail "这个安装包里没有 app\src\cli.ts（包不完整）" }
if (-not (Test-Path (Join-Path $source "runtime\node.exe"))) { Fail "这个安装包里没有 runtime\node.exe（包不完整）" }

# 0) 如果内核正在跑，先请它优雅退出（托盘会重新拉起）
try {
  $runtimeFile = Join-Path (Join-Path $env:LOCALAPPDATA $appName) "runtime.json"
  if (-not (Test-Path $runtimeFile)) { $runtimeFile = Join-Path (Join-Path $env:APPDATA $appName) "local\runtime.json" }
  if (Test-Path $runtimeFile) {
    $rt = Get-Content $runtimeFile -Raw | ConvertFrom-Json
    if ($rt.port -and $rt.token) {
      try {
        Invoke-RestMethod -Method Post -Uri ("http://127.0.0.1:" + $rt.port + "/api/shutdown") -Headers @{ authorization = "Bearer " + $rt.token } -TimeoutSec 3 | Out-Null
        Write-Step "已请正在运行的内核退出（数据已落盘）"
        Start-Sleep -Seconds 1
      } catch {
        Write-Step "内核没在跑（或已退出）"
      }
    }
  }
} catch {
  Write-Step "跳过「停旧内核」（$($_.Exception.Message)）"
}

# 1) 复制程序文件
New-Item -ItemType Directory -Force -Path $Target | Out-Null
$appTarget = Join-Path $Target "app"
if (Test-Path $appTarget) { Remove-Item -Recurse -Force $appTarget }
Write-Step "复制程序文件…"
Copy-Item -Recurse -Force (Join-Path $source "app") $appTarget
Copy-Item -Recurse -Force (Join-Path $source "runtime") (Join-Path $Target "runtime")
foreach ($file in @("BiliWhale.cmd", "README.txt", "VERSION", "install.ps1", "uninstall.ps1", "install.cmd", "uninstall.cmd")) {
  $from = Join-Path $source $file
  if (Test-Path $from) { Copy-Item -Force $from $Target }
}

# 2) 用户环境变量：托盘靠它拉起内核（带引号，路径里有空格也不会坏）
$kernel = '"{0}" "{1}" serve' -f (Join-Path $Target "runtime\node.exe"), (Join-Path $appTarget "src\cli.ts")
[Environment]::SetEnvironmentVariable("BILIWHALE_KERNEL_CMD", $kernel, "User")
$env:BILIWHALE_KERNEL_CMD = $kernel
Write-Step "已设置 BILIWHALE_KERNEL_CMD（托盘用它启动内核）"

# 3) 快捷方式
$shell = New-Object -ComObject WScript.Shell
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
$link = $shell.CreateShortcut((Join-Path $startMenu "$appName.lnk"))
$link.TargetPath = Join-Path $Target "BiliWhale.cmd"
$link.WorkingDirectory = $Target
$link.Description = "BiliWhale（B 站养鱼）"
$link.Save()
Write-Step "开始菜单快捷方式已建"

if ($Desktop) {
  $desktopDir = [Environment]::GetFolderPath("Desktop")
  $deskLink = $shell.CreateShortcut((Join-Path $desktopDir "$appName.lnk"))
  $deskLink.TargetPath = Join-Path $Target "BiliWhale.cmd"
  $deskLink.WorkingDirectory = $Target
  $deskLink.Save()
  Write-Step "桌面快捷方式已建"
}

# 4) 开机自启（可选）：只起托盘，不弹窗
if ($Autostart) {
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  New-Item -Path $runKey -Force | Out-Null
  $tray = Join-Path $appTarget "shell\BiliWhaleTray.exe"
  if (Test-Path $tray) {
    Set-ItemProperty -Path $runKey -Name $appName -Value ('"{0}" --autostart' -f $tray)
    Write-Step "已设置开机自启（HKCU Run）"
  } else {
    Write-Step "没找到托盘 exe，跳过开机自启"
  }
}

# 5) 启动
if (-not $NoLaunch) {
  $tray = Join-Path $appTarget "shell\BiliWhaleTray.exe"
  if (Test-Path $tray) {
    Start-Process -FilePath $tray -WorkingDirectory $appTarget | Out-Null
    Write-Step "已启动托盘（右键图标可打开面板）"
  } else {
    Write-Step "没找到托盘 exe；可以手动运行 $Target\BiliWhale.cmd"
  }
}

Write-Host ""
Write-Host "装好了。下一步："
Write-Host "  1. 托盘右键 → 打开面板（首次要带 token，托盘会自动带上）"
Write-Host "  2. 面板「账号」页扫码登录，并填「主人 UID」（你自己的另一个 B 站号）"
Write-Host "  3. 设置 → DeepSeek 填 key（或在 secrets.json 里配）"
Write-Host "  4. 概览页点「预演一轮」，没问题再打开分享开关"
Write-Host ""
Write-Host "数据目录：$env:APPDATA\$appName（卸载默认保留）"
Write-Host ""

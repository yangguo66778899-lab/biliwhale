# BiliWhale 卸载脚本（当前用户，不需要管理员）
#
# 默认：删程序、快捷方式、开机自启、环境变量，**保留数据**（配置/账本/报告/日记）。
# 加 -RemoveData 会连数据一起删（会二次确认）。
param(
  [switch]$RemoveData,
  [switch]$Yes,
  [string]$Target = ""
)

$ErrorActionPreference = "Stop"
$appName = "BiliWhale"
if ([string]::IsNullOrWhiteSpace($Target)) {
  $Target = Join-Path $env:LOCALAPPDATA "Programs\$appName"
}
$dataDir = Join-Path $env:APPDATA $appName
$localDir = Join-Path $env:LOCALAPPDATA $appName

function Write-Step($text) { Write-Host "  $text" }

Write-Host ""
Write-Host "BiliWhale 卸载"
Write-Host "  程序：$Target"
Write-Host "  数据：$dataDir（默认保留）"
Write-Host ""

# 0) 先让内核退出
try {
  $runtimeFile = Join-Path $localDir "runtime.json"
  if (-not (Test-Path $runtimeFile)) { $runtimeFile = Join-Path $dataDir "local\runtime.json" }
  if (Test-Path $runtimeFile) {
    $rt = Get-Content $runtimeFile -Raw | ConvertFrom-Json
    if ($rt.port -and $rt.token) {
      Invoke-RestMethod -Method Post -Uri ("http://127.0.0.1:" + $rt.port + "/api/shutdown") -Headers @{ authorization = "Bearer " + $rt.token } -TimeoutSec 3 | Out-Null
      Write-Step "已请内核优雅退出"
      Start-Sleep -Seconds 1
    }
  }
} catch {
  Write-Step "内核没在跑（或已退出）"
}

# 1) 开机自启
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
try {
  if (Get-ItemProperty -Path $runKey -Name $appName -ErrorAction SilentlyContinue) {
    Remove-ItemProperty -Path $runKey -Name $appName -Force
    Write-Step "已删开机自启项"
  }
} catch {
  Write-Step "开机自启项不存在或删不掉（$($_.Exception.Message)）"
}

# 2) 快捷方式
foreach ($link in @(
    (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$appName.lnk"),
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "$appName.lnk")
  )) {
  if (Test-Path $link) {
    Remove-Item -Force $link
    Write-Step "已删快捷方式：$link"
  }
}

# 3) 环境变量
try {
  [Environment]::SetEnvironmentVariable("BILIWHALE_KERNEL_CMD", $null, "User")
  Write-Step "已删 BILIWHALE_KERNEL_CMD"
} catch {
  Write-Step "环境变量删不掉（$($_.Exception.Message)）"
}

# 4) 程序目录
if (Test-Path $Target) {
  Remove-Item -Recurse -Force $Target
  Write-Step "已删程序目录"
} else {
  Write-Step "程序目录不存在（可能已经删过）"
}

# 5) 数据（默认保留）
if ($RemoveData) {
  if (-not $Yes) {
    $answer = Read-Host "这会删掉你的日记/报告/账本（$dataDir），确定吗？输入 DELETE 继续"
    if ($answer -ne "DELETE") {
      Write-Host "  已取消删除数据（程序已卸载，数据还在）"
      exit 0
    }
  }
  foreach ($dir in @($dataDir, $localDir)) {
    if (Test-Path $dir) {
      Remove-Item -Recurse -Force $dir
      Write-Step "已删：$dir"
    }
  }
} else {
  Write-Host "  数据保留在：$dataDir"
  Write-Host "  （想一起删：uninstall.cmd --remove-data，或手动删这个目录）"
}

Write-Host ""
Write-Host "卸载完成。"
Write-Host ""

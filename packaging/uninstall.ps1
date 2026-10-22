# BiliWhale 卸载脚本（当前用户，不需要管理员）
#
# 默认：删程序、快捷方式、开机自启、环境变量，**保留数据**（配置/账本/报告/日记）。
# 加 -RemoveData 会连数据一起删（会二次确认）。
param(
  [switch]$RemoveData,
  [switch]$NoRegister,
  [switch]$Yes,
  [string]$Target = "",
  [string]$DataDir = ""
)

# uninstall.cmd 直接透传 %*：把 --remove-data / --yes / --no-register 也认下来（审计 §3.39）
foreach ($extra in $args) {
  switch -Regex ($extra) {
    '^--?remove-?data$' { $RemoveData = $true }
    '^--?yes$' { $Yes = $true }
    '^--?no-?register$' { $NoRegister = $true }
  }
}

$ErrorActionPreference = "Stop"
$appName = "BiliWhale"
if ([string]::IsNullOrWhiteSpace($Target)) {
  $Target = Join-Path $env:LOCALAPPDATA "Programs\$appName"
}
$dataDir = if ([string]::IsNullOrWhiteSpace($DataDir)) { Join-Path $env:APPDATA $appName } else { $DataDir }
# 自定义数据目录时，日志/runtime.json 在 <data>\local
$localDir = if ([string]::IsNullOrWhiteSpace($DataDir)) { Join-Path $env:LOCALAPPDATA $appName } else { Join-Path $DataDir "local" }

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
      try {
        # 写操作要 CSRF（审计 §2.13）；不然停不掉内核，下面删目录就会撞「文件被占用」
        $session = Invoke-RestMethod -Method Get -Uri ("http://127.0.0.1:" + $rt.port + "/api/session") -Headers @{ authorization = "Bearer " + $rt.token } -TimeoutSec 3
        $headers = @{ authorization = "Bearer " + $rt.token; "x-csrf-token" = $session.csrfToken }
        Invoke-RestMethod -Method Post -Uri ("http://127.0.0.1:" + $rt.port + "/api/shutdown") -Headers $headers -TimeoutSec 5 | Out-Null
        Write-Step "已请内核优雅退出"
        Start-Sleep -Seconds 2
      } catch {
        Write-Step "优雅退出没成功（$($_.Exception.Message)），继续尝试删程序目录"
      }
    }
  }
} catch {
  Write-Step "内核没在跑（或已退出）"
}

# 1) 开机自启
if (-not $NoRegister) {
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

}

# 4) 程序目录
if (Test-Path $Target) {
  try {
    Remove-Item -Recurse -Force $Target -ErrorAction Stop
    Write-Step "已删程序目录"
  } catch {
    # 内核可能还在收尾（node.exe 占着文件）：等一下再试一次，还不行就给人话（审计 §2.14）
    Write-Step "第一次删除失败（$($_.Exception.Message)），2 秒后重试"
    Start-Sleep -Seconds 2
    try {
      Remove-Item -Recurse -Force $Target -ErrorAction Stop
      Write-Step "已删程序目录（重试成功）"
    } catch {
      Write-Step "程序目录删不掉：$($_.Exception.Message)"
      Write-Step "多半是内核还在跑：托盘右键退出，或在任务管理器结束 node.exe，再跑一次卸载"
    }
  }
} else {
  Write-Step "程序目录不存在（可能已经删过）"
}

# 5) 数据（默认保留）
if ($NoRegister) {
  Write-Step "跳过注册表/快捷方式/环境变量（-NoRegister）"
}

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

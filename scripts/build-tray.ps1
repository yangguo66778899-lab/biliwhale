# 编译托盘（.NET Framework 自带 csc.exe，不需要 SDK / 不需要管理员）
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-tray.ps1
#   powershell ... -File scripts/build-tray.ps1 -Out "D:\somewhere\BiliWhaleTray.exe"
#
# 说明：csc 4.8 只支持 C# 5，托盘源码刻意不用字符串插值等新语法。

param(
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'shell\BiliWhaleTray.cs'
if (-not (Test-Path $src)) { throw "找不到托盘源码：$src" }

$frameworkDirs = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319')
)
$fw = $frameworkDirs | Where-Object { Test-Path (Join-Path $_ 'csc.exe') } | Select-Object -First 1
if (-not $fw) { throw '找不到 csc.exe：需要 .NET Framework 4.x（Windows 10/11 自带）' }

$csc = Join-Path $fw 'csc.exe'
if (-not $Out) { $Out = Join-Path $root 'shell\BiliWhaleTray.exe' }
$outDir = Split-Path -Parent $Out
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

$refs = @(
  'System.Windows.Forms.dll',
  'System.Drawing.dll',
  'System.Web.Extensions.dll',
  'System.Core.dll'
) | ForEach-Object { '/r:' + (Join-Path $fw $_) }

Write-Host "编译器：$csc"
& $csc /nologo /target:winexe /platform:anycpu /optimize+ "/out:$Out" $refs $src
if ($LASTEXITCODE -ne 0) { throw "编译失败（exit $LASTEXITCODE）" }

$size = (Get-Item $Out).Length
Write-Host ("已生成 {0}（{1:N0} 字节）" -f $Out, $size)
Write-Host ''
Write-Host '用法：'
Write-Host ('  {0}' -f $Out)
Write-Host ('  {0} --data-dir "D:\鲸鱼\.run"' -f $Out)
Write-Host ('  {0} --selftest    # 只打印它能读到什么，不显示界面' -f $Out)

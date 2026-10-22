@echo off
rem BiliWhale 便携版启动器：本目录就是程序，数据在 %APPDATA%\BiliWhale
setlocal
set "HERE=%~dp0"
if not exist "%HERE%runtime\node.exe" (
  echo 找不到 runtime\node.exe，这个便携包不完整。
  pause
  exit /b 1
)
if not exist "%HERE%app\src\cli.ts" (
  echo 找不到 app\src\cli.ts，这个便携包不完整。
  pause
  exit /b 1
)
set "BILIWHALE_KERNEL_CMD=%HERE%runtime\node.exe %HERE%app\src\cli.ts serve"
if exist "%HERE%app\shell\BiliWhaleTray.exe" (
  start "" "%HERE%app\shell\BiliWhaleTray.exe" %*
  exit /b 0
)
echo 没有托盘程序，直接在当前窗口起内核（关掉窗口就停）。
"%HERE%runtime\node.exe" "%HERE%app\src\cli.ts" serve

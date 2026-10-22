@echo off
rem BiliWhale portable launcher.
rem This file must stay pure ASCII: cmd.exe parses .cmd files in the system ANSI
rem code page, and UTF-8 Chinese here splits commands (real incident: double-click
rem flashed and exited because "start" was cut into "rt"). All logic and all
rem Chinese text live in launch.ps1, which is UTF-8 with BOM.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" %*
if errorlevel 1 (
  echo.
  echo Launch failed. Right-click launch.ps1 - Run with PowerShell to see the error.
  pause
)

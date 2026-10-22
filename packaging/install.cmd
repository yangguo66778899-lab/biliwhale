@echo off
rem 双击安装（当前用户，不需要管理员）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 pause

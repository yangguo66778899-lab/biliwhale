@echo off
rem 卸载（默认保留数据；加 --remove-data 一起删）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
if errorlevel 1 pause

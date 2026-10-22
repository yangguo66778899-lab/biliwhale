@echo off
rem Uninstall (data is kept by default; add --remove-data to delete it too).
rem Keep this file pure ASCII: cmd.exe parses .cmd files in the ANSI code page, and
rem UTF-8 Chinese here can split commands.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
if errorlevel 1 pause

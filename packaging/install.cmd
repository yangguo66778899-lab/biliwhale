@echo off
rem Install for the current user (no admin). All logic and Chinese text are in install.ps1.
rem Keep this file pure ASCII: cmd.exe parses .cmd files in the ANSI code page, and
rem UTF-8 Chinese here can split commands (that is why the old launcher only flashed).
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 pause

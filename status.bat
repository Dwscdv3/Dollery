@echo off
rem Keep this file ASCII-only. cmd.exe parses .bat with the system ANSI code page,
rem so any UTF-8 Chinese here turns into garbage. All Chinese output comes from Node.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

node src/cli.mjs status

echo.
pause
exit /b 0

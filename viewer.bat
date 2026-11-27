@echo off
rem Keep this file ASCII-only. cmd.exe parses .bat with the system ANSI code page,
rem so any UTF-8 Chinese here turns into garbage. All Chinese output comes from Node.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ==========================================================
echo   DOLLERY   COLLECTION VIEWER
echo ----------------------------------------------------------
echo   Starts a local server on 127.0.0.1 and opens it in an
echo   Edge app window. Close that window to quit.
echo ==========================================================
echo.

node viewer\server.mjs

echo.
echo Viewer stopped.
pause
exit /b 0

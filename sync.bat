@echo off
rem Keep this file ASCII-only. cmd.exe parses .bat with the system ANSI code page,
rem so any UTF-8 Chinese here turns into garbage. All Chinese output comes from Node.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ==========================================================
echo   pixiv-export   QUICK SYNC  (new bookmarks only)
echo ----------------------------------------------------------
echo   Usually 10-20 seconds. Does NOT detect removals;
echo   use sync-full.bat for that.
echo ==========================================================
echo.

node src/cli.mjs sync
if errorlevel 1 goto failed

echo.
echo ==========================================================
echo   Done. If anything changed, commit it with git.
echo ==========================================================
pause
exit /b 0

:failed
echo.
echo ----------------------------------------------------------
echo   Sync failed. Check the messages above.
echo ----------------------------------------------------------
pause
exit /b 1

@echo off
rem Keep this file ASCII-only. cmd.exe parses .bat with the system ANSI code page,
rem so any UTF-8 Chinese here turns into garbage. All Chinese output comes from Node.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ==========================================================
echo   pixiv-export   FULL SYNC
echo ----------------------------------------------------------
echo   Scans every bookmark page. Roughly 12 minutes total.
echo   Public first, then private. Ctrl+C is safe:
echo   finished channels are kept, rerun picks up from there.
echo ==========================================================
echo.

node src/cli.mjs sync --full --public-only
if errorlevel 1 goto failed

echo.
node src/cli.mjs sync --full --private-only
if errorlevel 1 goto failed

echo.
echo ==========================================================
echo   Done. Run "git diff" to review, then "git commit".
echo ==========================================================
pause
exit /b 0

:failed
echo.
echo ----------------------------------------------------------
echo   Sync failed. Check the messages above.
echo   Common causes: expired cookie, proxy not running.
echo ----------------------------------------------------------
pause
exit /b 1

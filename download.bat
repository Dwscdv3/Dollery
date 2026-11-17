@echo off
rem Keep this file ASCII-only. cmd.exe parses .bat with the system ANSI code page,
rem so any UTF-8 Chinese here turns into garbage. All Chinese output comes from Node.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ==========================================================
echo   pixiv-export   DOWNLOAD
echo ----------------------------------------------------------
echo   Enter a bookmark id range, for example:
echo       1-5        first five bookmarks
echo       1,3,7      only these three
echo       1-10,20    mixed
echo.
echo   id is the "id:" field in data files (1 = oldest).
echo   Public and private are numbered separately, so 1-3
echo   hits both sides unless you edit the command.
echo ==========================================================
echo.
set /p RANGE=id range: 
if "%RANGE%"=="" goto empty

node src/cli.mjs download --id %RANGE%
if errorlevel 1 goto failed

echo.
echo ==========================================================
echo   Done. Files are in the images folder.
echo ==========================================================
pause
exit /b 0

:empty
echo.
echo   Nothing entered, skipped.
pause
exit /b 0

:failed
echo.
echo ----------------------------------------------------------
echo   Download failed. Check the messages above.
echo   Common causes: expired cookie, proxy not running,
echo   ImageMagick (magick) missing from PATH.
echo ----------------------------------------------------------
pause
exit /b 1

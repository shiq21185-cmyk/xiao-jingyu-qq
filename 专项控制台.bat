@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal

rem ======================================================================
rem  Extra console (port 3101): the proactive / gate / promise panel.
rem  Separate process from the main console (public\console.html, port 3100)
rem  -- updating plugins will not replace this one.
rem  Needs QQ Bridge already running (it reads its config and sessions).
rem  Closing this window stops the panel only.
rem
rem  ENCODING NOTE: this file is ASCII-only on purpose. cmd.exe parses .bat
rem  with the local ANSI code page and `chcp 65001` does NOT change that, so
rem  UTF-8 Chinese in here turns into mojibake. Chinese output is printed by
rem  node at runtime instead. Same rule as start.bat.
rem ======================================================================

rem Window title: without this the tab shows the foreground process name.
title Xiao Jingyu - Extra Console 3101

echo.
echo  ========================================
echo   Extra console - port 3101
echo   http://127.0.0.1:3101/
echo  ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo  [X] node.exe not found.
    echo      Install Node.js 22.13+ or make sure it is on PATH.
    echo.
    pause
    exit /b 1
)

if not exist "%~dp0tools\extra-console\server.mjs" (
    echo  [X] tools\extra-console\server.mjs not found.
    echo      This .bat has to sit in the repo root.
    echo.
    pause
    exit /b 1
)

rem Open the browser 3s after the panel starts, then run the panel in this
rem window so its log stays visible (delete this window = stop the panel).
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:3101/"

node "%~dp0tools\extra-console\server.mjs"
if errorlevel 1 (
    echo.
    echo  The panel exited. The error is above.
    pause
)

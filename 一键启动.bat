@echo off
chcp 65001 >nul
rem ======================================================================
rem  One-click launcher for the qq-bridge stack.
rem  Runs launcher\launch-all.ps1 from whatever directory this .bat sits in,
rem  so it keeps working after the repo is moved or cloned elsewhere.
rem
rem  ENCODING NOTE: keep this file ASCII-only (see start.bat for why).
rem ======================================================================
setlocal
cd /d "%~dp0"

rem 窗口标题（同 start.bat：否则 Windows Terminal 显示前台进程名）
title 小鲸鱼 · 一键启动

set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

if not exist "%~dp0launcher\launch-all.ps1" (
    echo.
    echo [X] launcher\launch-all.ps1 not found next to this .bat
    echo     Put this file in the qq-bridge repo root, or run:
    echo       pwsh -File launcher\install.ps1
    echo.
    pause
    exit /b 1
)

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\launch-all.ps1" %*
if errorlevel 1 pause

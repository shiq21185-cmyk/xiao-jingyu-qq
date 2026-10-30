@echo off
chcp 65001 >nul
rem ======================================================================
rem  专项控制台 · 启动（独立进程）
rem
rem  这个是「主动找人 / 申请闸门 / 约定」的专用面板，
rem  和主控制台（public/console.html，端口 3100）完全是两码事：
rem  它自己起进程、自己提供页面，插件更新不会把它一起换掉。
rem
rem  需要先启动 QQ 桥接（本面板要读它的配置与会话）。
rem  关掉这个窗口 = 停止面板，不影响小鲸鱼在 QQ 里的任何行为。
rem ======================================================================
setlocal
cd /d "%~dp0"

rem 窗口标题：不设的话标签页显示的是前台进程名（node.exe）。
title 小鲸鱼 · 专项控制台（3101）

echo.
echo  ========================================
echo   小鲸鱼 · 专项控制台
echo   即将打开：http://127.0.0.1:3101/
echo  ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo  [X] 找不到 node.exe
    echo      请先安装 Node.js，或确认它在 PATH 里。
    echo.
    pause
    exit /b 1
)

if not exist "%~dp0tools\extra-console\server.mjs" (
    echo  [X] 找不到 tools\extra-console\server.mjs
    echo      这个 .bat 要放在 qq-bridge-deploy 根目录。
    echo.
    pause
    exit /b 1
)

rem 3 秒后自动开浏览器（先等面板把端口监听上）
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:3101/"

node "%~dp0tools\extra-console\server.mjs"
if errorlevel 1 (
    echo.
    echo  面板退出了，上面是报错信息。
    pause
)

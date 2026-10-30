@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 专项控制台 —— 独立进程，关掉这个窗口即停。
rem 它不影响小鲸鱼在 QQ 里的任何行为；开着只是为了让你能改这几项设置。

echo.
echo  🐋 小鲸鱼 · 专项控制台
echo  ────────────────────────────────────────
echo   地址：http://127.0.0.1:3101/
echo.
echo   说明：
echo     · 需要先启动 QQ 桥接（本控制台要读它的配置和会话）
echo     · 改设置需要控制台令牌，页面第一次会让你填
echo     · 令牌在 qq-bridge-deploy\state\console-token
echo     · 关掉这个窗口 = 停止本控制台，不影响机器人
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo  [错误] 找不到 node.exe，请先安装 Node.js 或确认它在 PATH 里。
    pause
    exit /b 1
)

node "%~dp0server.mjs"
if errorlevel 1 (
    echo.
    echo  控制台退出了，上面是报错信息。
    pause
)

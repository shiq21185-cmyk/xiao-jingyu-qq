@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ======================================================================
rem  Pick a qualified Node.
rem  qq-bridge needs >= 22.13 AND a global WebSocket (Node < 22 has none).
rem
rem  Preference order:
rem    1) whatever `node` resolves to on PATH   <- normal case, nothing hardcoded
rem    2) known absolute installs               <- fallback if PATH is broken
rem  Each candidate is asked to answer typeof WebSocket itself, so a bad
rem  Node on PATH is detected and skipped instead of crashing the bridge.
rem
rem  ENCODING NOTE: keep this file ASCII-only. cmd.exe parses .bat files using
rem  the ANSI code page and `chcp 65001` does NOT change that; UTF-8 Chinese
rem  here gets mis-decoded, swallows line endings and corrupts the script.
rem ======================================================================
rem Window title: without it the tab shows the foreground process name (node.exe),
rem which makes the launcher window look like a stray node process.
title QQ Bridge (xiao-jingyu)
set "NODE_EXE=node.exe"
node -e "process.exit(typeof WebSocket==='function'?0:1)" >nul 2>nul
if not errorlevel 1 goto :node_ready

set "NODE_EXE="
for %%P in ("C:\Program Files\nodejs\node.exe" "%~dp0..\SnowLuma\node.exe" "%~dp0SnowLuma\node.exe") do (
    if not defined NODE_EXE if exist "%%~fP" (
        "%%~fP" -e "process.exit(typeof WebSocket==='function'?0:1)" >nul 2>nul
        if not errorlevel 1 set "NODE_EXE=%%~fP"
    )
)
if not defined NODE_EXE (
    echo.
    echo [X] No qualified Node.js found. qq-bridge needs v22.13 or newer AND a global WebSocket.
    echo     Checked: "node" on PATH, then "C:\Program Files\nodejs\node.exe" and a sibling SnowLuma\node.exe.
    echo     Install Node v22.13+ and make sure it is first on PATH, then retry.
    echo.
    pause
    exit /b 1
)

:node_ready
for /f "usebackq delims=" %%V in (`"%NODE_EXE%" -v`) do set "NODE_VER=%%V"
echo [start.bat] Node: %NODE_EXE%  %NODE_VER%

rem Dry-run switch. Safe: ignored unless you set it yourself.
rem   set QQBRIDGE_DRYRUN=1    then run this file -> prints what it would run, then exits.
if defined QQBRIDGE_DRYRUN (
    echo [dry-run] harden : "%NODE_EXE%" scripts\harden-state-acl.mjs --quiet
    echo [dry-run] bridge : "%NODE_EXE%" src\bridge.js
    exit /b 0
)

rem Harden state/ ACLs (Windows needs WRITE_DAC; the directory owner normally has it,
rem so no UAC prompt in the usual case). This NEVER blocks startup: if it cannot get
rem permission it prints a copy-pasteable command and exits 0.
rem See docs/guides/SECURITY_BASELINE.md ("secrets at rest").
"%NODE_EXE%" scripts\harden-state-acl.mjs --quiet
:loop
"%NODE_EXE%" src\bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] bridge already running in another window. Exiting.
    pause
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop

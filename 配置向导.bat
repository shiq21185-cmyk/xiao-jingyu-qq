@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal

rem ======================================================================
rem  Setup wizard -- port 3220.
rem
rem  Double-click this file, a page opens in your browser, fill in your own
rem  QQ number / whitelist / persona name, click save. That writes
rem  config.json (generated from config.template.json the first time) and
rem  optionally creates a role card under roles\.
rem
rem  ENCODING NOTE: keep this file ASCII-only. cmd.exe parses .bat using the
rem  ANSI code page and `chcp 65001` does NOT change that; UTF-8 Chinese in
rem  here turns into a wall of "not recognized as an internal or external
rem  command". See start.bat for the long version of this note.
rem
rem  The server itself is started through launcher\run-hidden.vbs, so no
rem  extra console window and no taskbar entry. This window closes a moment
rem  later -- that is expected, nothing to keep open.
rem
rem  Override the port:  set SETUP_WIZARD_PORT=3221  before running.
rem ======================================================================

set "PORT=3220"
if defined SETUP_WIZARD_PORT set "PORT=%SETUP_WIZARD_PORT%"

title Xiao Jingyu - Setup Wizard

if not exist "%~dp0launcher\setup-wizard.mjs" (
    echo  [X] launcher\setup-wizard.mjs not found.
    echo      This .bat has to sit in the repo root, next to start.bat.
    echo.
    pause
    exit /b 1
)
if not exist "%~dp0config.template.json" (
    echo  [X] config.template.json not found -- the repo copy looks incomplete.
    echo      Re-clone it, or restore that file, then retry.
    echo.
    pause
    exit /b 1
)

rem ----------------------------------------------------------------------
rem  Pick a qualified Node (>= 22.13 AND a global WebSocket). Same rule as
rem  start.bat: ask each candidate to answer for itself instead of assuming.
rem ----------------------------------------------------------------------
set "NODE_EXE="
node -e "process.exit(typeof WebSocket==='function'?0:1)" >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node.exe"

if not defined NODE_EXE (
    for %%P in ("C:\Program Files\nodejs\node.exe" "C:\Program Files (x86)\nodejs\node.exe" "%~dp0..\SnowLuma\node.exe") do (
        if not defined NODE_EXE if exist "%%~fP" (
            "%%~fP" -e "process.exit(typeof WebSocket==='function'?0:1)" >nul 2>nul
            if not errorlevel 1 set "NODE_EXE=%%~fP"
        )
    )
)
if not defined NODE_EXE (
    echo.
    echo  [X] No qualified Node.js found.
    echo      This needs v22.13 or newer AND a global WebSocket.
    echo      Install Node from https://nodejs.org/ and make sure it is on PATH.
    echo.
    pause
    exit /b 1
)

rem ----------------------------------------------------------------------
rem  Already running? Then just open the page instead of starting a second
rem  one (the second would die with EADDRINUSE and you would see nothing).
rem ----------------------------------------------------------------------
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:%PORT%/healthz' -TimeoutSec 2 -ErrorAction Stop; if ($r.ok) { exit 0 } } catch { }; exit 1" >nul 2>nul
if not errorlevel 1 (
    echo  Wizard already running -- opening http://127.0.0.1:%PORT%/
    start "" "http://127.0.0.1:%PORT%/"
    exit /b 0
)

if not exist "%~dp0launcher\run-hidden.vbs" (
    echo  [X] launcher\run-hidden.vbs not found.
    echo.
    pause
    exit /b 1
)

echo  Starting the setup wizard (hidden) on http://127.0.0.1:%PORT%/ ...
start "" wscript.exe "%~dp0launcher\run-hidden.vbs" "%~dp0" "%NODE_EXE%" "%~dp0launcher\setup-wizard.mjs"

rem Give it a moment before opening the browser, then check it actually came
rem up -- otherwise the browser shows a blank "can't connect" page and the
rem real reason (port taken, node crashed) is invisible.
rem (ping, not `timeout`: timeout.exe is shadowed by MSYS/coreutils in some
rem  shells, and `timeout /t` then dies with "invalid time interval".)
ping -n 4 127.0.0.1 >nul 2>nul
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:%PORT%/healthz' -TimeoutSec 3 -ErrorAction Stop; if ($r.ok) { exit 0 } } catch { }; exit 1" >nul 2>nul
if errorlevel 1 (
    echo.
    echo  [X] The wizard did not come up on port %PORT%.
    echo      Most likely that port is taken by an old wizard that is still
    echo      running. Try opening it directly:
    echo        http://127.0.0.1:%PORT%/
    echo      If that fails too, run it in this window to see the error:
    echo        "%NODE_EXE%" launcher\setup-wizard.mjs
    echo      Or pick another port:
    echo        set SETUP_WIZARD_PORT=3221
    echo.
    pause
    exit /b 1
)

start "" "http://127.0.0.1:%PORT%/"
exit /b 0

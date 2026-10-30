@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ======================================================================
rem  Extra console (tools/extra-console) -- port 3101, started HIDDEN.
rem
rem  ENCODING NOTE: keep this file ASCII-only, same rule as start.bat.
rem  cmd.exe parses .bat files with the ANSI code page (GBK here) and
rem  `chcp 65001` does NOT change how the rest of the file is read.
rem  This file used to hold UTF-8 Chinese, an emoji and box-drawing chars;
rem  cmd read them as GBK, sliced them into fake commands and printed
rem  several lines of "not recognized as an internal or external command".
rem
rem  HOW IT STARTS: launcher\run-hidden.vbs -> wscript Run(..., 0, False).
rem  No window, no taskbar entry, and this window closes right away, so
rem  there is nothing left to keep open. Same path the one-click launcher
rem  uses, so both ways behave identically.
rem ======================================================================

if not exist "%~dp0server.mjs" (
    echo  [X] server.mjs not found next to this .bat.
    echo      Keep this file inside tools\extra-console.
    echo.
    pause
    exit /b 1
)

set "NODE_EXE="
for /f "delims=" %%P in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%P"
)
if not defined NODE_EXE (
    echo  [X] node.exe not found on PATH.
    echo      Install Node.js, or make sure it is on PATH.
    echo.
    pause
    exit /b 1
)

set "HIDER=%~dp0..\..\launcher\run-hidden.vbs"
if not exist "%HIDER%" (
    echo  [X] launcher\run-hidden.vbs not found.
    echo.
    pause
    exit /b 1
)

echo  Starting extra console (hidden) on http://127.0.0.1:3101/ ...
start "" wscript.exe "%HIDER%" "%~dp0." "%NODE_EXE%" "%~dp0server.mjs"
exit /b 0

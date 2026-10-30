@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Stopping old guard windows...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*start.bat*' -and $_.CommandLine -notlike '*restart.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo Stopping old bridge processes...
rem NOTE: start.bat launches the bridge with a RELATIVE path (node src/bridge.js),
rem so Win32_Process.CommandLine does NOT contain the repo's absolute path. The old
rem version matched '*%~dp0src\bridge.js*', which could never match, so "restart"
rem merely started one more instance while the old bridge kept running (state/bridge.log
rem shows two instances joining the DSH event stream at 04:54, stopped only by a console
rem port clash -- and one of them overwrote social-v2.json with a stale snapshot).
rem Now we kill by two routes: the PID from the lock file, plus a *bridge.js* fallback.
powershell -NoProfile -Command "$lock = Join-Path '%~dp0' 'state\bridge.lock'; $pids = @(); if (Test-Path $lock) { $raw = (Get-Content $lock -Raw).Trim(); if ($raw -match '^\d+$') { $pids += [int]$raw } }; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' -and $_.CommandLine -notlike '*node_modules*' } | ForEach-Object { $pids += $_.ProcessId }; $pids | Sort-Object -Unique | ForEach-Object { Write-Host ('  kill PID ' + $_); Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
rem Wait until the old instance is really gone (and the console port is free) before
rem deleting the lock; otherwise "lock deleted but process still alive" means two instances.
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "$live = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' -and $_.CommandLine -notlike '*node_modules*' }; if ($live) { Write-Host 'Bridge process(es) still alive:'; $live | ForEach-Object { Write-Host ('  PID ' + $_.ProcessId + '  ' + $_.CommandLine) }; exit 1 } else { exit 0 }"
if errorlevel 1 (
    echo.
    echo Restart aborted: this prevents two instances from fighting over messages
    echo and overwriting state. Kill the PIDs listed above manually, then retry.
    pause
    exit /b 1
)
del state\bridge.lock 2>nul
start "" cmd /c start.bat
echo Guard window started.

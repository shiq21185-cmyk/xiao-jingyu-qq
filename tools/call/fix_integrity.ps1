# Fix the root cause of "sidecar cannot click QQ": raise venv exe integrity to Medium.
#
# Background (measured 2026-10-25):
#   The DSH sandbox labels the whole workspace as `Low Mandatory Level`, and a Low
#   integrity label ON AN EXE FILE lowers the token of the process started from it.
#   So tools/asr/.venv/Scripts/python.exe produced a Low-integrity sidecar; a Low
#   process posting SetCursorPos / mouse_event to Medium QQ.exe is SILENTLY DROPPED
#   by UIPI (return values look fine, cursor does not move, GetLastError=0).
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\call\fix_integrity.ps1
#   add -Verify to only check without changing.

param([switch]$Verify)

$ErrorActionPreference = 'Stop'
$venv = Join-Path $PSScriptRoot '..\asr\.venv'
if (-not (Test-Path $venv)) { throw "venv not found: $venv" }

$exes = Get-ChildItem -Path $venv -Filter *.exe -Recurse -ErrorAction SilentlyContinue
$changed = 0
$already = 0
$failed = @()

foreach ($e in $exes) {
    $out = & icacls.exe $e.FullName 2>&1 | Out-String
    $isLow = $out -match 'Low Mandatory Level'
    if ($Verify) {
        if ($isLow) { $failed += $e.FullName } else { $already++ }
        continue
    }
    if (-not $isLow) { $already++; continue }
    $r = & icacls.exe $e.FullName /setintegritylevel Medium 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) { $changed++ } else { $failed += "$($e.FullName) :: $r" }
}

if ($Verify) {
    Write-Output "VERIFY: medium=$already low=$($failed.Count)"
    if ($failed.Count -gt 0) {
        $failed | ForEach-Object { Write-Output "  LOW: $_" }
        exit 1
    }
    exit 0
}

Write-Output "CHANGED=$changed ALREADY=$already FAILED=$($failed.Count)"
if ($failed.Count -gt 0) { $failed | ForEach-Object { Write-Output "  FAIL: $_" }; exit 1 }

$py = Join-Path $venv 'Scripts\python.exe'
& $py -c "print('python ok')" | Out-Null
Write-Output "python ok: $py"
Write-Output "Restart sidecar to apply: POST /api/call/stop then /api/call/start"

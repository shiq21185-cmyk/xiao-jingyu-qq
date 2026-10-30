# ============================================================
#  install-asr.ps1 —— 装语音能力（听：faster-whisper；说：edge-tts）
#
#  为什么不在仓库里带：模型 480MB + venv 好几个 G，而且模型是第三方权重，
#  更适合现场从官方源拉。这个脚本在现场重建一套一模一样的 venv。
#
#  用法：
#    pwsh -File tools\asr\install-asr.ps1
#    pwsh -File tools\asr\install-asr.ps1 -ToolsDir <tools 目录>\asr
#    pwsh -File tools\asr\install-asr.ps1 -SkipModel        # 只装依赖，模型以后再说
#    pwsh -File tools\asr\install-asr.ps1 -Mirror tsinghua  # 国内镜像
#
#  装完 config.json 里 socialV2.asr.toolsDir / socialV2.tts.toolsDir 要指向这里；
#  跑 launcher\install.ps1 的话它会自动填。
# ============================================================

[CmdletBinding()]
param(
    [string]$ToolsDir = '',
    [string]$Mirror = 'tsinghua',      # tsinghua | aliyun | official
    [string]$PythonExe = '',           # 不给就用 py -3.12 / python
    [switch]$SkipModel,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Say { param([string]$T,[string]$C='Gray') Write-Host $T -ForegroundColor $C }
function Step { param([string]$T) Say '' ; Say "==> $T" 'Cyan' }
function Ok   { param([string]$T) Say "    [OK]   $T" 'Green' }
function Warn { param([string]$T) Say "    [WARN] $T" 'Yellow' }
function Bad  { param([string]$T) Say "    [X]    $T" 'Red' }

# 默认：仓库自带的 tools\asr（脚本在 tools\asr\ 下，父目录的父目录是仓库根）
$here = $PSScriptRoot
if (-not $ToolsDir) {
    $repoRoot = Split-Path -Parent (Split-Path -Parent $here)
    $ToolsDir = $here
    Say "  目标目录：$ToolsDir"
}

$venv = Join-Path $ToolsDir '.venv'
$venvPy = Join-Path $venv 'Scripts\python.exe'
$req = Join-Path $ToolsDir 'requirements.txt'
$models = Join-Path $ToolsDir 'models'

if (-not (Test-Path $req)) { Bad "找不到 $req"; exit 1 }

$indexUrl = switch ($Mirror) {
    'tsinghua' { 'https://pypi.tuna.tsinghua.edu.cn/simple' }
    'aliyun'   { 'https://mirrors.aliyun.com/pypi/simple' }
    default    { 'https://pypi.org/simple' }
}

# ---------- 1. 找 Python ----------
Step '找 Python（需要 3.10 ~ 3.12）'
$py = $null
$cands = @()
if ($PythonExe) { $cands += $PythonExe }
$cands += @('py -3.12', 'py -3.11', 'py -3.10', 'python', 'python3')
foreach ($c in $cands) {
    $parts = $c -split ' '
    $exe = $parts[0]
    $pre = @($parts | Select-Object -Skip 1)
    $cmd = Get-Command $exe -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    $v = & $exe @pre -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
    if (-not $v) { continue }
    if ($v -match '^3\.(1[0-2])$') { $py = @($exe) + $pre; Ok "用 $c（Python $v）"; break }
}
if (-not $py) {
    Bad '没找到合适的 Python（3.10/3.11/3.12）。'
    Say '          装 Python 3.12 → https://www.python.org/downloads/' 'DarkGray'
    Say '          装的时候勾上 "Add python.exe to PATH"。' 'DarkGray'
    exit 1
}

# ---------- 2. 建 venv ----------
Step "建虚拟环境 $venv"
if (Test-Path $venvPy) {
    if ($Force) {
        Warn '-Force：删掉旧 venv 重来'
        Remove-Item $venv -Recurse -Force
    } else {
        Ok '已存在，复用'
    }
}
if (-not (Test-Path $venvPy)) {
    & $py[0] @($py | Select-Object -Skip 1) -m venv $venv
    if (-not (Test-Path $venvPy)) { Bad 'venv 创建失败'; exit 1 }
    Ok 'venv 建好'
}

# ---------- 3. 装依赖 ----------
Step '装 Python 依赖（几分钟；会下载 ctranslate2 / nvidia 的 CUDA 库，比较慢）'
& $venvPy -m pip install --upgrade pip --quiet --index-url $indexUrl 2>$null
& $venvPy -m pip install -r $req --index-url $indexUrl
if ($LASTEXITCODE -ne 0) {
    Bad "pip install 退出码 $LASTEXITCODE"
    Say '          国内网络慢的话换个镜像：-Mirror aliyun / official' 'DarkGray'
    exit 1
}
Ok '依赖装好'

# ---------- 4. 拉模型 ----------
if ($SkipModel) {
    Step '跳过模型（-SkipModel）'
} else {
    Step '下载 whisper small 模型（约 480MB，本机跑一次就够）'
    Say '    这一步走 HuggingFace；国内可能用 hf-mirror，慢就 Ctrl+C 后设 HF_ENDPOINT 再重跑。' 'DarkGray'
    New-Item -ItemType Directory -Force -Path $models | Out-Null
    $env:ASR_MODEL_DIR = $models
    $code = @'
import os, sys
try:
    from faster_whisper import WhisperModel
except Exception as e:
    print("FATAL: 没有 faster-whisper:", e); sys.exit(1)
d = os.environ.get("ASR_MODEL_DIR")
print("下载到:", d)
m = WhisperModel("small", device="cpu", compute_type="int8", download_root=d)
print("模型就绪")
'@
    $tmp = Join-Path $env:TEMP 'qq-bridge-asr-warmup.py'
    Set-Content -Path $tmp -Value $code -Encoding UTF8
    & $venvPy $tmp
    if ($LASTEXITCODE -ne 0) { Bad "模型下载失败（退出码 $LASTEXITCODE）"; }
    else { Ok '模型就绪' }
}

# ---------- 5. 自检 ----------
Step '自检'
$check = Join-Path $ToolsDir 'selftest.py'
if (Test-Path $check) {
    & $venvPy $check
    if ($LASTEXITCODE -ne 0) { Warn "自检退出码 $LASTEXITCODE（不影响基本使用，但建议看一眼上面的输出）" }
    else { Ok '自检通过' }
} else {
    Warn '没有 selftest.py，跳过'
}

Say ''
Say '  完成。把这三项填进 config.json（install.ps1 会自动填）：' 'White'
Say "    socialV2.asr.toolsDir = $(($ToolsDir -replace '\\','/'))" 'Gray'
Say "    socialV2.tts.toolsDir = $(($ToolsDir -replace '\\','/'))" 'Gray'
# spoolDir 是最容易漏、漏了又只报 "语音合成失败（引擎不可用或没联网）" 的一项。
# 默认落系统临时目录（%TEMP%），但在受限环境（如 DSH 文件沙箱）里 Python 进程
# 只能写工作区，写 %TEMP% 会抛 PermissionError，被上层吞成一句含糊的失败。
$spool = Join-Path (Split-Path -Parent (Split-Path -Parent $ToolsDir)) 'audio'
$spoolFwd = ($spool -replace '\\', '/')
Say "    socialV2.tts.spoolDir = $spoolFwd" 'Gray'
Say '      ↑ 别留空。留空=写系统 %TEMP%，在沙箱/受限账户下会 PermissionError，' 'DarkGray'
Say '        症状是"语音合成失败（引擎不可用或没联网）"，但模型和联网其实都正常。' 'DarkGray'
Say ''

# ============================================================
#  install.ps1 —— 换机器后跑这一次，把 qq-bridge 装起来
#
#  它做四件事（每一步都可重复执行，已存在的不会被覆盖）：
#    1) 检查 Node 版本（>= 22.13，且要有全局 WebSocket）
#    2) 生成 config.json（来自 config.template.json）和 launcher\paths.json
#    3) npm install（含 postinstall 的 SnowLuma SDK 补丁）
#    4) 把本仓库注册进 DSH profile（agent preset + 三个 MCP server）
#
#  用法：
#    pwsh -File launcher\install.ps1                 # 正常安装
#    pwsh -File launcher\install.ps1 -SkipNpm        # 依赖已装好，只做配置
#    pwsh -File launcher\install.ps1 -DryRun         # 只报告将要做什么
#
#  可选参数（不给就自动探测）：
#    -SnowLumaDir <dir>   SnowLuma 所在目录（解压出来的那个）
#    -ToolsDir <dir>      qq-bridge-tools 所在目录（含 web-access / asr）
#    -QQExe <path>        QQ.exe 路径
#    -EdgeExe <path>      msedge.exe 路径
#    -Profile <name>      DSH profile 名，默认 desktop
# ============================================================

[CmdletBinding()]
param(
    [string]$SnowLumaDir = '',
    [string]$ToolsDir = '',
    [string]$QQExe = '',
    [string]$EdgeExe = '',
    [string]$Profile = 'desktop',
    [switch]$SkipNpm,
    [switch]$SkipDsh,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$BridgeDir = Split-Path -Parent $PSScriptRoot     # launcher\ 的上一级 = 仓库根
$RepoParent = Split-Path -Parent $BridgeDir

$script:Failures = @()

function Say {
    param([string]$Text, [string]$Color = 'Gray')
    Write-Host $Text -ForegroundColor $Color
}

function Step { param([string]$Text) Say '' ; Say "==> $Text" 'Cyan' }
function Ok   { param([string]$Text) Say "    [OK]   $Text" 'Green' }
function Warn { param([string]$Text) Say "    [WARN] $Text" 'Yellow' }
function Bad  { param([string]$Text) Say "    [X]    $Text" 'Red'; $script:Failures += $Text }
function Info { param([string]$Text) Say "           $Text" 'DarkGray' }

# ---------- 0. 抬头 ----------
Say ''
Say '  qq-bridge 安装向导' 'White'
Say "  仓库根：$BridgeDir"
if ($DryRun) { Say '  （DryRun：只报告，不落盘）' 'Magenta' }

# ---------- 1. Node ----------
Step '检查 Node.js（需要 >= 22.13，且要有全局 WebSocket）'

$nodeExe = $null
$nodeVersion = $null
$candidates = @()
$cmd = Get-Command node.exe -ErrorAction SilentlyContinue
if ($cmd -and $cmd.Source) { $candidates += $cmd.Source }
$candidates += @(
    'C:\Program Files\nodejs\node.exe',
    'C:\Program Files (x86)\nodejs\node.exe',
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
)
if ($SnowLumaDir) { $candidates += (Join-Path $SnowLumaDir 'node.exe') }
$candidates = $candidates | Where-Object { $_ }

foreach ($c in $candidates) {
    if (-not (Test-Path -LiteralPath $c)) { continue }
    $v = & $c -v 2>$null
    if (-not $v) { continue }
    & $c -e "process.exit(typeof WebSocket==='function'?0:1)" 2>$null
    $wsOk = ($LASTEXITCODE -eq 0)
    $ver = [version]($v.TrimStart('v'))
    if ($ver -ge [version]'22.13.0' -and $wsOk) {
        $nodeExe = $c; $nodeVersion = $v.Trim(); break
    }
}
if (-not $nodeExe) {
    Bad '找不到合格的 Node.js。'
    Info '需要 v22.13 或更新版本（Node 22 之前没有全局 WebSocket，桥接会直接崩）。'
    Info '装好后确保 node 在 PATH 最前面，再重跑本脚本。'
    Info '下载：https://nodejs.org/'
} else {
    Ok "Node $nodeVersion → $nodeExe"
    $nodeDir = Split-Path -Parent $nodeExe
    if ($env:PATH -notlike "*$nodeDir*") { $env:PATH = "$nodeDir;$env:PATH" }
}

# ---------- 2. 找外部组件 ----------
Step '定位外部组件（SnowLuma / QQ / Edge / tools）'

function Find-Existing {
    param([string[]]$Paths)
    foreach ($p in $Paths) { if ($p -and (Test-Path -LiteralPath $p)) { return $p } }
    return ''
}

if (-not $SnowLumaDir) {
    $SnowLumaDir = Find-Existing @(
        (Join-Path $BridgeDir 'SnowLuma'),
        (Join-Path $RepoParent 'SnowLuma'),
        'C:\SnowLuma'
    )
}
if ($SnowLumaDir -and (Test-Path (Join-Path $SnowLumaDir 'index.mjs'))) {
    Ok "SnowLuma → $SnowLumaDir"
} elseif ($SnowLumaDir) {
    Warn "目录存在但不像 SnowLuma（缺 index.mjs）：$SnowLumaDir"
} else {
    Warn '没找到 SnowLuma。'
    Info '本仓库不携带 SnowLuma 二进制（它的 EULA §5.4 禁止再分发）。'
    Info '下载页：https://github.com/SnowLuma/SnowLuma/releases/latest'
    Info '  → 选 SnowLuma-v<版本>-win-x64.zip（约 36MB，自带 Node）'
    Info '然后：'
    Info "  node scripts\get-snowluma.mjs --zip <你下载的zip>  --dest <放哪>"
    Info '或者手动解压到仓库的同级目录，再重跑本脚本（加 -SnowLumaDir）。'
}

if (-not $ToolsDir) {
    # 仓库自带 tools\web-access，优先用它；外部的 qq-bridge-tools 只作为兜底。
    $ToolsDir = Find-Existing @(
        (Join-Path $BridgeDir 'tools'),
        (Join-Path $RepoParent 'qq-bridge-tools')
    )
}
if ($ToolsDir) {
    Ok "tools → $ToolsDir"
    $wa = Join-Path $ToolsDir 'web-access\scripts\check-deps.mjs'
    if (Test-Path $wa) { Info 'web-access：有（“和主人一起看网页”能力可用）' }
    else { Warn "web-access 不在 $ToolsDir（看网页功能不可用，其余不受影响）" }
} else {
    Warn '没找到 tools 目录。'
}

# ASR/TTS 的 Python 环境可能在仓库内 tools\asr，也可能在兄弟目录 qq-bridge-tools\asr
$AsrDir = ''
$asrCandidates = @()
if ($ToolsDir) { $asrCandidates += (Join-Path $ToolsDir 'asr') }
$asrCandidates += (Join-Path $RepoParent 'qq-bridge-tools\asr')
foreach ($cand in $asrCandidates) {
    if ($cand -and (Test-Path (Join-Path $cand '.venv\Scripts\python.exe'))) { $AsrDir = $cand; break }
}
if (-not $AsrDir) {
    foreach ($cand in $asrCandidates) {
        if ($cand -and (Test-Path (Join-Path $cand 'requirements.txt'))) { $AsrDir = $cand; break }
    }
}
if ($AsrDir -and (Test-Path (Join-Path $AsrDir '.venv\Scripts\python.exe'))) {
    Ok "asr → $AsrDir"
} elseif ($AsrDir) {
    Warn "asr 目录在 $AsrDir，但虚拟环境还没建"
    Info '需要语音能力就跑：pwsh -File tools\asr\install-asr.ps1'
} else {
    Info 'asr：没有（语音转文字/合成不可用；需要就跑 pwsh -File tools\asr\install-asr.ps1）'
}

if (-not $QQExe) {
    $qqCands = @(
        'C:\Program Files\Tencent\QQNT\QQ.exe',
        'C:\Program Files (x86)\Tencent\QQNT\QQ.exe',
        'D:\Program Files\Tencent\QQNT\QQ.exe',
        'D:\Program Files (x86)\Tencent\QQNT\QQ.exe'
    )
    foreach ($root in @('HKLM:\SOFTWARE\WOW6432Node\Tencent\QQNT', 'HKLM:\SOFTWARE\Tencent\QQNT')) {
        try {
            $inst = (Get-ItemProperty -Path $root -ErrorAction Stop).Install
            if ($inst) { $qqCands = @((Join-Path $inst 'QQ.exe')) + $qqCands }
        } catch { }
    }
    $QQExe = Find-Existing $qqCands
}
if ($QQExe -and (Test-Path $QQExe)) { Ok "QQ → $QQExe" } else { Warn '没找到 QQ.exe（自动登录小号那步会跳过，你手动开 QQ 也行）' }

if (-not $EdgeExe) {
    $EdgeExe = Find-Existing @(
        'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
        'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
    )
}
if ($EdgeExe) { Ok "Edge → $EdgeExe" } else { Warn '没找到 msedge.exe（看网页功能不可用）' }

# ---------- 3. 生成 config.json ----------
Step '生成 config.json'

$cfgPath = Join-Path $BridgeDir 'config.json'
$tplPath = Join-Path $BridgeDir 'config.template.json'
if (Test-Path $cfgPath) {
    Ok 'config.json 已存在，保留不动'
    Info '（想重新生成：先把它改名，再重跑本脚本）'
} elseif (-not (Test-Path $tplPath)) {
    Bad "缺 config.template.json，无法生成 config.json"
} else {
    $raw = Get-Content $tplPath -Raw -Encoding UTF8
    $cfg = $raw | ConvertFrom-Json

    # 只自动填「跟路径有关、用户不该手写」的几项；QQ 号等隐私项留空给你自己填。
    # 到这里说明本机还没有 config.json（在 if 的第一个分支里就已经跳过了），
    # 外面探测到的 SnowLuma / ASR 可能是老机器留下的残壳，所以填完还要用 existsSync 复核一遍。
    if ($SnowLumaDir) {
        $cfg.snowluma.homeDir = ($SnowLumaDir -replace '\\', '/')
        $bat = Join-Path $SnowLumaDir '启动-SnowLuma.bat'
        if (Test-Path $bat) { $cfg.snowluma.launcherPath = ($bat -replace '\\', '/') }
    }
    if (-not $cfg.snowluma.homeDir) {
        $sibling = Join-Path $BridgeDir '..\SnowLuma'
        if (Test-Path (Join-Path $sibling '启动-SnowLuma.bat')) {
            $resolved = (Resolve-Path $sibling).Path -replace '\\', '/'
            $cfg.snowluma.homeDir = $resolved
            $cfg.snowluma.launcherPath = "$resolved/启动-SnowLuma.bat"
        }
    }
    # ASR/TTS 的 toolsDir 刻意留空：代码默认找「仓库上级/qq-bridge-tools/asr」，
    # install-asr.ps1 也装在那儿。写死这台机器的路径反而会让换机后指向不存在的目录。

    # 衣柜要填绝对路径：src/bridge.js 的 loadWardrobe() 在 dir 为空时直接 return null，
    # 于是 seed\wardrobe\ 铺回来的那几套衣服没人读（自拍/换装一律报「衣柜清单读不到」）。
    # 模板里 selfImage 故意不带 dir，就是留给这里填的。
    if ($cfg.socialV2) {
        if (-not $cfg.socialV2.selfImage) {
            $cfg.socialV2 | Add-Member -NotePropertyName 'selfImage' -NotePropertyValue ([pscustomobject]@{}) -Force
        }
        if (-not $cfg.socialV2.selfImage.dir) {
            $wardrobeDir = ($BridgeDir -replace '\\', '/') + '/wardrobe'
            $cfg.socialV2.selfImage | Add-Member -NotePropertyName 'dir' -NotePropertyValue $wardrobeDir -Force
            Info "衣柜目录：$wardrobeDir"
        }
    }

    if ($DryRun) {
        Info "[dry] 将写入 $cfgPath"
    } else {
        $cfg | ConvertTo-Json -Depth 20 | Set-Content -Path $cfgPath -Encoding UTF8
        Ok "已生成 $cfgPath"
    }
    Warn '记得改这几项（现在都是空的）：'
    Info 'ownerQQ               —— 你自己的 QQ 号（只有它能私聊 + 用完整本地工具）'
    Info 'allow.private / allow.groups —— 允许机器人说话的 QQ / 群'
    Info 'snowluma.accessToken  —— SnowLuma 里配的 access token（留空也能跑，会自动发现）'
}

# ---------- 4. launcher\paths.json ----------
Step '写 launcher\paths.json（机器相关的路径，启动脚本读它）'

$pathsPath = Join-Path $PSScriptRoot 'paths.json'
$paths = [ordered]@{}
if ($nodeExe)        { $paths.nodeDir      = $nodeDir }
if ($SnowLumaDir)    { $paths.snowLumaDir  = $SnowLumaDir }
if ($QQExe)          { $paths.qqExe        = $QQExe }
if ($EdgeExe)        { $paths.edgeExe      = $EdgeExe }
if ($ToolsDir)       { $paths.toolsDir     = $ToolsDir }

if ($DryRun) {
    Info "[dry] 将写入 $pathsPath"
    ($paths | ConvertTo-Json) -split "`n" | ForEach-Object { Info $_ }
} else {
    ($paths | ConvertTo-Json) | Set-Content -Path $pathsPath -Encoding UTF8
    $n = $paths.Keys.Count
    Ok "已写 $pathsPath（$n 项；它不进 git，本机专用）"
}

# ---------- 5. 种子数据（人格 / 记忆 / 日记 / 表情） ----------
Step '铺种子数据（人格与记忆）'

$seedDir = Join-Path $BridgeDir 'seed'
if (-not (Test-Path $seedDir)) {
    Info '没有 seed/ 目录，跳过'
} else {
    # seed\ 里的相对路径默认与仓库根一一对应（seed\state\x → state\x），只有一处例外：
    # 群图库的备注要落在 <仓库>\media\（src/bridge.js 的 MEDIA_LIB_DIR_DEFAULT 就是它），
    # 而它在 seed\ 里按资料分类放在 data\ 下 —— 不重映射就会「铺回去了却没人读」。
    $seedRemap = @{ 'data\media\index.json' = 'media\index.json' }

    $seedFiles = Get-ChildItem $seedDir -Recurse -File
    foreach ($f in $seedFiles) {
        $rel = $f.FullName.Substring($seedDir.Length).TrimStart('\', '/')
        $target = $rel
        if ($seedRemap.ContainsKey($rel)) { $target = $seedRemap[$rel] }
        $dst = Join-Path $BridgeDir $target
        if (Test-Path $dst) {
            Info "已存在，跳过：$target"
        } elseif ($DryRun) {
            Info "[dry] 将复制 $rel → $target"
        } else {
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
            Copy-Item $f.FullName $dst
            Ok "已恢复 $target"
        }
    }
}

# ---------- 6. npm install ----------
Step '安装 npm 依赖'

if ($SkipNpm) {
    Info '按参数跳过（-SkipNpm）'
} elseif (-not $nodeExe) {
    Bad '没有合格的 Node，跳过 npm install'
} elseif ($DryRun) {
    Info "[dry] 将执行：$nodeExe <npm-cli> install"
} else {
    $npmCli = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
    if (Test-Path $npmCli) {
        Push-Location $BridgeDir
        try {
            Info '（这一步要几分钟，postinstall 会给 SnowLuma SDK 打 13 个补丁）'
            & $nodeExe $npmCli install --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { Bad "npm install 退出码 $LASTEXITCODE" } else { Ok 'npm install 完成' }
        } finally { Pop-Location }
    } else {
        Warn "找不到 npm-cli.js（$npmCli），改试 npm.cmd"
        Push-Location $BridgeDir
        try {
            & cmd /c 'npm install --no-audit --no-fund'
            if ($LASTEXITCODE -ne 0) { Bad "npm install 退出码 $LASTEXITCODE" } else { Ok 'npm install 完成' }
        } finally { Pop-Location }
    }
}

# ---------- 7. 注册进 DSH ----------
Step '把本仓库注册进 DSH（agent preset + 三个 MCP server）'

if ($SkipDsh) {
    Info '按参数跳过（-SkipDsh）'
} elseif (-not $nodeExe) {
    Bad '没有合格的 Node，跳过'
} elseif ($DryRun) {
    Info "[dry] 将执行：$nodeExe scripts\setup-dsh.mjs $Profile"
} else {
    $setup = Join-Path $BridgeDir 'scripts\setup-dsh.mjs'
    if (-not (Test-Path $setup)) {
        Bad "缺 scripts\setup-dsh.mjs"
    } else {
        Push-Location $BridgeDir
        try {
            & $nodeExe $setup $Profile
            if ($LASTEXITCODE -ne 0) { Bad "setup-dsh.mjs 退出码 $LASTEXITCODE" } else { Ok 'DSH 配置完成' }
        } finally { Pop-Location }
    }
}

# ---------- 8. 收尾 ----------
Step '结果'
if ($script:Failures.Count -eq 0) {
    Say '    安装完成。' 'Green'
} else {
    Say "    有 $($script:Failures.Count) 项没成功：" 'Yellow'
    foreach ($f in $script:Failures) { Say "      - $f" 'Yellow' }
}

Say ''
Say '  接下来（这些本脚本不替你做）：' 'White'
Say '    1. 启动 SnowLuma，登录小号，打开 OneBot（HTTP 3000 / WS 3001）'
Say '       详细步骤见 DEPLOY.md 的「一次性手动步骤」'
Say '    2. 填 config.json 里的 ownerQQ / allow.private / allow.groups'
Say '    3. 双击「QQ机器人-一键启动.bat」（或 pwsh -File launcher\launch-all.ps1）'
Say ''
Say '  自检：' 'White'
Say "    node scripts\privacy-scan.mjs        # 确认没把秘密带进仓库"
Say "    node scripts\test-role-card.mjs      # 确认人格卡能读出来"
Say ''

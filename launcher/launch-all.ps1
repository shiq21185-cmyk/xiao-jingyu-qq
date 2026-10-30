# ============================================================
#  QQ 机器人一键启动
#  由桌面上的「QQ机器人-一键启动.bat」调用
#  顺序：环境检查 -> QQ 客户端 -> SnowLuma -> 等 OneBot 就绪 -> qq-bridge
#        -> 浏览器与看网页的代理(CDP) -> 记忆守护
# ============================================================

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

# ---------------- 路径配置（可移植版） ----------------
# 这个文件不再写死任何机器相关的绝对路径。取值优先级：
#   1) launcher\paths.json —— install.ps1 生成的机器相关配置（换机器后跑一次 install 即可）
#   2) 环境变量            —— QQBRIDGE_SNOWLUMA / QQBRIDGE_QQ / QQBRIDGE_EDGE / QQBRIDGE_TOOLS
#   3) 候选列表 + 自动探测  —— 同级目录、常见安装位置、注册表
# 想永久固定某个值就改 launcher\paths.json，不要改下面的逻辑。

$BridgeDir = Split-Path -Parent $PSScriptRoot   # 仓库根 = launcher\ 的上一级
if (-not $BridgeDir) { $BridgeDir = (Get-Location).Path }

$PathsFile = Join-Path $PSScriptRoot 'paths.json'
$P = @{}
if (Test-Path $PathsFile) {
    try { $P = Get-Content $PathsFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch {
        Write-Host "  [warn] paths.json 解析失败，改用自动探测：$($_.Exception.Message)" -ForegroundColor Yellow
    }
}

function Get-Configured {
    # paths.json 优先，其次同名环境变量；都没有返回 $null
    param([string]$Key, [string]$EnvName)
    $v = $P.$Key
    if ($v -and "$v".Trim()) { return "$v".Trim() }
    if ($EnvName) {
        $e = [Environment]::GetEnvironmentVariable($EnvName)
        if ($e -and $e.Trim()) { return $e.Trim() }
    }
    return $null
}

function Find-FirstExisting {
    # 返回第一个存在的候选路径；全都不存在返回 $null
    param([string[]]$Candidates)
    foreach ($c in $Candidates) {
        if (-not $c) { continue }
        if (Test-Path -LiteralPath $c) { return $c }
    }
    return $null
}

$RepoParent = Split-Path -Parent $BridgeDir   # 兄弟目录的父级，用来找 SnowLuma / qq-bridge-tools

# --- Node：先看 PATH（和 start.bat 同源判断），再退回常见安装位置
$NodeDir = Get-Configured 'nodeDir' 'QQBRIDGE_NODE'
if (-not $NodeDir) {
    $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCmd -and $nodeCmd.Source) { $NodeDir = Split-Path -Parent $nodeCmd.Source }
}
if ($NodeDir -and -not (Test-Path (Join-Path $NodeDir 'node.exe'))) { $NodeDir = $null }
if (-not $NodeDir) {
    $nodeExeFound = Find-FirstExisting @(
        'C:\Program Files\nodejs\node.exe',
        'C:\Program Files (x86)\nodejs\node.exe',
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )
    if ($nodeExeFound) { $NodeDir = Split-Path -Parent $nodeExeFound }
}

# --- SnowLuma：配置 > 环境变量 > 兄弟目录（换机器时的常规位置）
$SnowLumaDir = Get-Configured 'snowLumaDir' 'QQBRIDGE_SNOWLUMA'
if (-not $SnowLumaDir) {
    $SnowLumaDir = Find-FirstExisting @(
        (Join-Path $RepoParent 'SnowLuma'),
        (Join-Path $BridgeDir  'SnowLuma'),
        'C:\SnowLuma'
    )
}
if (-not $SnowLumaDir) { $SnowLumaDir = Join-Path $RepoParent 'SnowLuma' }

# --- QQ 客户端：配置 > 环境变量 > 注册表登记 > 常见安装位置
$QQExe = Get-Configured 'qqExe' 'QQBRIDGE_QQ'
if (-not $QQExe) {
    $qqCandidates = @(
        'C:\Program Files\Tencent\QQNT\QQ.exe',
        'C:\Program Files (x86)\Tencent\QQNT\QQ.exe',
        'D:\Program Files\Tencent\QQNT\QQ.exe',
        'D:\Program Files (x86)\Tencent\QQNT\QQ.exe'
    )
    foreach ($root in @('HKLM:\SOFTWARE\WOW6432Node\Tencent\QQNT', 'HKLM:\SOFTWARE\Tencent\QQNT')) {
        try {
            $inst = (Get-ItemProperty -Path $root -ErrorAction Stop).Install
            if ($inst) { $qqCandidates = @((Join-Path $inst 'QQ.exe')) + $qqCandidates }
        } catch { }
    }
    $QQExe = Find-FirstExisting $qqCandidates
}
if (-not $QQExe) { $QQExe = 'C:\Program Files\Tencent\QQNT\QQ.exe' }

# --- Edge：她「看网页」要借的那个浏览器
$EdgeExe = Get-Configured 'edgeExe' 'QQBRIDGE_EDGE'
if (-not $EdgeExe) {
    $EdgeExe = Find-FirstExisting @(
        'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
        'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
    )
}
if (-not $EdgeExe) { $EdgeExe = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' }

# --- 看网页的 CDP 代理（web-access）
$ToolsDir = Get-Configured 'toolsDir' 'QQBRIDGE_TOOLS'
if (-not $ToolsDir) {
    $ToolsDir = Find-FirstExisting @(
        (Join-Path $RepoParent 'qq-bridge-tools'),
        (Join-Path $BridgeDir  'tools')
    )
}
if (-not $ToolsDir) { $ToolsDir = Join-Path $RepoParent 'qq-bridge-tools' }
$CdpDepsScript = Join-Path $ToolsDir 'web-access\scripts\check-deps.mjs'

$BotQQ         = Get-Configured 'botQQ' 'QQBRIDGE_BOTQQ'   # 小号；未配置时从 config.json 兜底
$SnowLumaWebUi = Get-Configured 'snowLumaWebUi' $null
if (-not $SnowLumaWebUi) { $SnowLumaWebUi = 'http://127.0.0.1:5099' }
$BridgeConsole = Get-Configured 'bridgeConsole' $null
if (-not $BridgeConsole) { $BridgeConsole = 'http://127.0.0.1:3100' }
# 专项控制台（tools/extra-console）：主动找人 / 申请闸门 / 约定 的独立面板。
# 独立进程、独立端口 —— 与上面那个 3100 主控制台是两码事，关掉它不影响机器人。
$ExtraConsole  = Get-Configured 'extraConsole' $null
if (-not $ExtraConsole) { $ExtraConsole = 'http://127.0.0.1:3101' }
$InspectUrl    = 'edge://inspect/#remote-debugging'            # 远程调试开关页（连不上时打开它让你勾）
$WaitOneBotSec = 150                            # 等 OneBot 端口出现的最长秒数

# 小号 QQ 没配置时，从 config.json 兜底：先 botQQ，再 ownerQQ
# （很多部署里机器人小号就配在 ownerQQ，用它兜底比误报友好）。
if (-not $BotQQ) {
    $cfgPath = Join-Path $BridgeDir 'config.json'
    if (Test-Path $cfgPath) {
        try {
            $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($cfg.botQQ) { $BotQQ = "$($cfg.botQQ)" }
            elseif ($cfg.ownerQQ) { $BotQQ = "$($cfg.ownerQQ)" }
        } catch { }
    }
}
# 仍然没有就保持空。绝不退化成字面量 '小号' 去和真实号比较 ——
# 那样每个号都会被误报成「不是小号」，反而制造假警报。

# start.bat 里写的是裸 node，PATH 上若是 v20 会直接崩（无全局 WebSocket）。
# 让本进程及其所有子进程优先命中 >=22.13 的 node。
if (Test-Path (Join-Path $NodeDir 'node.exe')) { $env:PATH = "$NodeDir;$env:PATH" }

# ---------------- 工具函数 ----------------
function Test-TcpPort {
    param([int]$Port, [string]$Target = '127.0.0.1')
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect($Target, $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch { return $false } finally { $client.Close() }
}

function Say {
    param([string]$Text, [string]$Color = 'Gray')
    Write-Host $Text -ForegroundColor $Color
}

function Pause-Exit {
    try { Read-Host '按回车键关闭此窗口' } catch { Start-Sleep -Seconds 3 }
}

# 判断 SnowLuma 当前接入的是哪个 QQ 号（data\<uin> 目录 = 已建立会话的账号）
function Get-ActiveUins {
    $dir = Join-Path $SnowLumaDir 'data'
    if (-not (Test-Path $dir)) { return @() }
    return @(Get-ChildItem $dir -Directory -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -match '^\d+$' } | ForEach-Object { $_.Name })
}

function Show-BridgeStatus {
    $tokFile = Join-Path $BridgeDir 'state\console-token'
    if (-not (Test-Path $tokFile)) {
        Say '  （还没有控制台令牌，桥接可能尚未完成首次启动）' 'DarkGray'
        return
    }
    $tok = (Get-Content $tokFile -Raw).Trim()
    try {
        $s = Invoke-RestMethod -Uri "$BridgeConsole/api/status" `
                -Headers @{ 'x-console-token' = $tok } -TimeoutSec 8 -ErrorAction Stop
        Say ("  运行模式  : {0}" -f $s.mode)
        Say ("  DSH 连接  : {0}" -f $s.dshReady)
        Say ("  小号在线  : {0}" -f $s.snowluma.accountOnline)
        Say ("  心跳正常  : {0}" -f $s.snowluma.good)
        Say ("  管理员QQ  : {0}" -f $s.ownerQQ)
        Say ("  私聊白名单: {0}" -f (($s.allowPrivate) -join ', '))
        Say ("  群聊白名单: {0}" -f (($s.allowGroups) -join ', '))
        Say ''
        Say ("  桥接控制台: {0}" -f $BridgeConsole) 'Cyan'
        Say ("  控制台令牌: {0}" -f $tok) 'Cyan'
    } catch {
        Say ("  控制台暂不可用：{0}" -f $_.Exception.Message.Split([Environment]::NewLine)[0]) 'Yellow'
    }
}

# 专项控制台：探活 + 必要时拉起。
#   为什么不直接在汇总里写死地址：那个端口可能没起（比如上次手动关了），
#   写个死链接等于让人点进一个空白页还不知道为什么。这里先试 /healthz，
#   通则直接报地址；不通就尝试用 node 拉起来再报。
function Start-ExtraConsole {
    param([string]$ConsoleUrl = 'http://127.0.0.1:3101')

    # 1) 已经在跑？
    try {
        $h = Invoke-RestMethod -Uri "$ConsoleUrl/healthz" -TimeoutSec 3 -ErrorAction Stop
        if ($h.ok) { return @{ Url = $ConsoleUrl; Started = $false; Ok = $true } }
    } catch { }

    # 2) 没在跑 —— 找到 server.mjs 再拉起来
    $server = Join-Path $BridgeDir 'tools\extra-console\server.mjs'
    if (-not (Test-Path $server)) {
        return @{ Url = $ConsoleUrl; Started = $false; Ok = $false; Reason = '文件不在（tools\extra-console\server.mjs）' }
    }
    try {
        # 起法：wscript + run-hidden.vbs → 窗口完全不出现、任务栏不留图标。
        #
        # 以前是 `cmd.exe /k title …& node …` + `-WindowStyle Minimized`：窗口是
        # 最小化了，但任务栏上一直挂着一个黑框。主人 2026-10-30 说「双击桌面的
        # 一键启动后不会多弹出一个专项控制台的 cmd」——所以就换成完全隐藏。
        # 注意：只是不显示窗口，3101 仍然是独立进程、独立页面，没并进主控制台。
        #
        # ⚠️ 路径必须当独立参数传：本仓库路径含空格，不加引号时 node 收到被
        #    空格切开的两个参数，立刻退出且不报错 —— 表现为「已启动但端口一直
        #    不监听」，极难查。
        $vbs = Join-Path $PSScriptRoot 'run-hidden.vbs'
        $nodeExe = Join-Path $NodeDir 'node.exe'
        if (-not (Test-Path $vbs)) { throw "缺少 $vbs（后台启动器）" }
        if (-not (Test-Path $nodeExe)) { throw "找不到 node.exe（$nodeExe）" }
        Start-Process -FilePath 'wscript.exe' `
            -ArgumentList @("`"$vbs`"", "`"$BridgeDir`"", "`"$nodeExe`"", "`"$server`"") `
            -WorkingDirectory $BridgeDir -WindowStyle Hidden -ErrorAction Stop | Out-Null
    } catch {
        return @{ Url = $ConsoleUrl; Started = $false; Ok = $false; Reason = $_.Exception.Message }
    }

    # 3) 最多等 8 秒让它监听上
    for ($i = 0; $i -lt 16; $i += 1) {
        Start-Sleep -Milliseconds 500
        try {
            $h = Invoke-RestMethod -Uri "$ConsoleUrl/healthz" -TimeoutSec 2 -ErrorAction Stop
            if ($h.ok) { return @{ Url = $ConsoleUrl; Started = $true; Ok = $true } }
        } catch { }
    }
    return @{ Url = $ConsoleUrl; Started = $true; Ok = $false; Reason = '已尝试启动，但 8 秒内没响应' }
}

# 轮询代理是否已连上浏览器。代理自己会不断重试，这里只负责等。
function Wait-ProxyConnected {
    param([int]$Seconds = 20)
    for ($i = 0; $i -lt $Seconds; $i += 2) {
        try {
            $h = Invoke-RestMethod -Uri 'http://127.0.0.1:3456/health' -TimeoutSec 4
            if ($h.status -eq 'ok' -and $h.connected -eq $true) { return $true }
        } catch { }
        Start-Sleep -Seconds 2
    }
    return $false
}

# 代理没连上浏览器时，把「允许远程调试」那个开关页开到前台。
# 两条路，先用可靠的那条：
#   ① 走代理自己的 POST /new —— 实测 edge:// 页面能开出来（Edge 忽略命令行里的
#      edge:// 地址，却接受 CDP 的 Target.createTarget）。开出来的页记在代理的
#      managedTabs 里，不会变成「主人自己开的页」。
#   ② 退一步用裸 URL 走 ShellExecute（别传 -FilePath，传了 Edge 会只开空白页）。
function Open-InspectPage {
    try {
        $body = $InspectUrl
        Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3456/new' -Body $body `
            -ContentType 'text/plain' -TimeoutSec 15 | Out-Null
        return $true
    } catch { }
    try {
        Start-Process $InspectUrl
        return $true
    } catch {
        try { Start-Process -FilePath $EdgeExe -ArgumentList $InspectUrl; return $true } catch { return $false }
    }
}

# 语音能力状态：读的是同一个 config.json，和桥接实际用的开关完全一致。
function Show-VoiceStatus {
    $cfgFile = Join-Path $BridgeDir 'config.json'
    if (-not (Test-Path $cfgFile)) { return }
    try { $j = (Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return }

    $asrOn = ($j.socialV2.asr.enabled -eq $true)
    $ttsOn = ($j.socialV2.tts.enabled -eq $true)
    $toolsDir = [string]$j.socialV2.asr.toolsDir
    if (-not $toolsDir) { $toolsDir = [string]$j.socialV2.tts.toolsDir }
    $pyOk = $false
    if ($toolsDir) { $pyOk = Test-Path (Join-Path $toolsDir '.venv\Scripts\python.exe') }

    if (-not $asrOn) {
        Say '  她听懂你说话: 关闭'
    } elseif ($pyOk) {
        Say '  她听懂你说话: 已开启（本机转写，音频不出这台电脑）'
    } else {
        $asrHint = if ($toolsDir) { Join-Path $toolsDir '.venv\Scripts\python.exe' } else { '（config.json 里 socialV2.asr.toolsDir 为空）' }
        Say "  她听懂你说话: 已开启，但找不到语音引擎（缺 $asrHint）" 'Yellow'
    }

    if (-not $ttsOn) {
        Say '  她自己开口  : 关闭'
    } elseif ($pyOk) {
        Say ("  她自己开口  : 已开启（引擎 {0} / 音色 {1}）" -f $j.socialV2.tts.engine, $j.socialV2.tts.voice)
    } else {
        Say '  她自己开口  : 已开启，但找不到语音引擎' 'Yellow'
    }
}

# 从 SnowLuma 配置里读真实 OneBot 端口（端口有可能会漂移）
function Get-OneBotPorts {
    $result = @{ Ws = 3001; Http = 3004 }
    $cfgDir = Join-Path $SnowLumaDir 'config'
    if (-not (Test-Path $cfgDir)) { return $result }
    $cand = Join-Path $cfgDir ("onebot_{0}.json" -f $BotQQ)
    if (-not (Test-Path $cand)) {
        $cand = (Get-ChildItem $cfgDir -Filter 'onebot_*.json' -ErrorAction SilentlyContinue |
                 Select-Object -First 1).FullName
    }
    if (-not $cand) { return $result }
    try {
        $j = Get-Content $cand -Raw -Encoding UTF8 | ConvertFrom-Json
        $ws = @($j.networks.wsServers)
        $hs = @($j.networks.httpServers)
        if ($ws.Count -gt 0 -and $ws[0].port) { $result.Ws = [int]$ws[0].port }
        if ($hs.Count -gt 0 -and $hs[0].port) { $result.Http = [int]$hs[0].port }
    } catch { }
    return $result
}

# ============================================================
Say ''
Say '============================================================' 'Cyan'
Say '                 Q Q   机 器 人   一 键 启 动' 'Cyan'
Say '============================================================' 'Cyan'
Say ''

$ports = Get-OneBotPorts

# ---------- 1. 环境检查（node + DSH） ----------
$nodeExe = Join-Path $NodeDir 'node.exe'
if (-not (Test-Path $nodeExe)) {
    Say ("[!] 找不到 node：{0}" -f $nodeExe) 'Red'
    Say '    qq-bridge 需要 Node.js >= 22.13，请确认安装路径。' 'Red'
    Say ''
    Pause-Exit
    exit 1
}
$nodeVer = (& $nodeExe -v) 2>$null
Say ("[1/7] 使用的 Node：{0}  ({1})" -f $nodeVer, $nodeExe) 'DarkGray'
Say ''

# qq-bridge 需要连上 DSH 桌面版；它没开的话桥接会一直连不上。
# DSH 没开就自动拉起来，省得每次手动先点一次。
if (-not (Test-TcpPort 19387)) {
    $dshExe = Get-Configured 'dshExe' 'QQBRIDGE_DSH'
    if (-not $dshExe) {
        $dshExe = Find-FirstExisting @(
            'C:\Program Files\DSH\DSH NEXT.exe',
            "$env:LOCALAPPDATA\Programs\DSH\DSH NEXT.exe"
        )
    }
    if ($dshExe -and (Test-Path $dshExe)) {
        Say '      DSH 没在运行，正在自动启动（首次加载较慢，请稍等）...' 'Yellow'
        Start-Process -FilePath $dshExe
        # DSH 冷启动要枚举 profile、装插件，实测 20~60 秒；端口固定 19387 后等它即可。
        $dshOk = $false
        for ($i = 0; $i -lt 120; $i++) {
            Start-Sleep -Seconds 1
            if (Test-TcpPort 19387) { $dshOk = $true; break }
        }
        if ($dshOk) {
            Say '      DSH 已就绪（127.0.0.1:19387）' 'Green'
            Start-Sleep -Seconds 3   # 端口起来后还要几秒才真正能接受 API 请求
        } else {
            Say '      [!] DSH 启动后仍没监听 19387。' 'Red'
            Say ('          可能启动失败，或端口被占用。手动打开：{0}' -f $dshExe) 'Red'
            Say '          打开后重新运行本启动器即可。' 'Red'
            Say ''
            Pause-Exit
            exit 1
        }
    } else {
        Say '      [!] DSH 桌面版没在运行，也没找到它的可执行文件。' 'Red'
        Say '          请先手动打开「DeepSeek Harness」，再运行本启动器。' 'Red'
        Say '          否则机器人连不上大脑，收不到消息。' 'Red'
        Say ''
        Pause-Exit
        exit 1
    }
} else {
    Say '      DSH 已就绪（127.0.0.1:19387）' 'Green'
}
Say ''

# ---------- 2. QQ 客户端 ----------
$qq = @(Get-Process -Name QQ -ErrorAction SilentlyContinue)
if ($qq.Count -gt 0) {
    Say ("[2/7] QQ 已在运行（{0} 个进程）" -f $qq.Count) 'Green'
} elseif (Test-Path $QQExe) {
    Say '[2/7] QQ 未运行，正在启动（会自动登录上次的账号）...' 'Yellow'
    Start-Process -FilePath $QQExe
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        if (@(Get-Process -Name QQ -ErrorAction SilentlyContinue).Count -gt 0) { break }
    }
    if (@(Get-Process -Name QQ -ErrorAction SilentlyContinue).Count -gt 0) {
        Say '      QQ 已启动' 'Green'
        Start-Sleep -Seconds 8      # 给 QQ 一点时间把界面/登录跑完
    } else {
        Say '      QQ 启动较慢或未成功，继续往下走（可稍后手动开）' 'Yellow'
    }
} else {
    Say ("[2/7] 找不到 QQ：{0}" -f $QQExe) 'Red'
}

# ---------- 3. SnowLuma ----------
Say ''
if (Test-TcpPort 5099) {
    Say '[3/7] SnowLuma 已在运行' 'Green'
} else {
    $slIndex = Join-Path $SnowLumaDir 'index.mjs'
    $slOwnNode = Join-Path $SnowLumaDir 'node.exe'
    $slRunNode = $null
    # lite 版不带 node.exe，用系统 Node（>=22.13 或 >=23.4）；完整版优先用自带 node。
    # 注意：完整版自带 node 是 v22.13，用它连自己注入的命名管道会 EPERM（收不到消息），
    # 所以只要系统 Node 合格，一律优先系统 Node，避免「检测不到 QQ 主进程」这类坑。
    if (Test-Path $slOwnNode) { $slRunNode = $slOwnNode }
    if ($nodeExe -and (Test-Path $nodeExe)) {
        $slRunNode = $nodeExe
    } elseif (-not $slRunNode) {
        $slRunNode = $nodeExe
    }
    if (-not (Test-Path $slIndex)) {
        Say ("[3/7] 找不到 SnowLuma：{0}" -f $SnowLumaDir) 'Red'
    } elseif (-not $slRunNode -or -not (Test-Path $slRunNode)) {
        Say ("[3/7] 找不到可用的 Node 来启动 SnowLuma：{0}" -f $slRunNode) 'Red'
    } else {
        Say '[3/7] 正在启动 SnowLuma（会新开一个窗口，别关它）...' 'Yellow'
        # 用系统 Node 启动（完整版自带 node v22 有命名管道 EPERM 问题，见上文）。
        # cwd 必须是 SnowLuma 目录，否则 config/ 会生成到错误的位置。
        # 用 cmd 包一层只是为了给它一个可读标题（直接起 node 时窗口标题是 node.exe）。
        $slCmd = "title QQ 网关 · SnowLuma & start `"`" /b `"$slRunNode`" index.mjs"
        Start-Process -FilePath 'cmd.exe' -ArgumentList @('/k', $slCmd) -WorkingDirectory $SnowLumaDir
        # 冷启动实测约需 40~60 秒（先枚举 QQ 进程、注入 hook，最后才 WebUI 监听），
        # 这里只等到 WebUI 起来为止；OneBot 端口在下一步继续等。
        $ok = $false
        for ($i = 0; $i -lt 90; $i++) {
            Start-Sleep -Seconds 1
            if (Test-TcpPort 5099) { $ok = $true; break }
        }
        if ($ok) { Say ("      SnowLuma 已就绪：{0}" -f $SnowLumaWebUi) 'Green' }
        else { Say '      SnowLuma 的 WebUI 还没起来（继续等 OneBot，它通常会稍后自己就绪）' 'Yellow' }
    }
}

# ---------- 3.5 账号安全检查 ----------
$uins = Get-ActiveUins
Say ''
if ($uins.Count -eq 0) {
    Say '      SnowLuma 还没接入任何 QQ。若 OneBot 一直不出现，' 'Yellow'
    Say '      请到面板的「进程注入」里对 QQ 主进程点一次「加载」。' 'Yellow'
} elseif (-not $BotQQ) {
    # 没配小号号：只报实际接入的号，不做「对不对」的判断（避免假警报）。
    Say ("      已接入 QQ：{0}" -f ($uins -join ', ')) 'Green'
    Say '      （未配置小号 QQ，跳过号段核对；可在 launcher\paths.json 填 botQQ 固定它）' 'DarkGray'
} elseif ($uins -contains $BotQQ) {
    Say ("      已接入小号 {0} ✓" -f $BotQQ) 'Green'
    $extra = @($uins | Where-Object { $_ -ne $BotQQ })
    if ($extra.Count -gt 0) {
        Say ("      [!] 同时还注入了别的号：{0}" -f ($extra -join ', ')) 'Red'
        Say '          建议只注入小号。要停掉某个号：SnowLuma 面板 -> 进程注入 -> 卸载。' 'Red'
    }
} else {
    Say ("      [!] 接入的号是 {0}，不是小号 {1}" -f ($uins -join ', '), $BotQQ) 'Red'
    Say '          请确认 QQ 登录的是小号，否则大号也会被注入（有风险）。' 'Red'
    Say '          若刚才那个号其实没错，改 launcher\paths.json 的 botQQ 即可。' 'DarkGray'
}

# ---------- 4. 等 OneBot ----------
Say ''
Say ("[4/7] 等待 OneBot 就绪（WS {0} / HTTP {1}）..." -f $ports.Ws, $ports.Http) 'Yellow'
$onebotOk = $false
for ($i = 0; $i -lt $WaitOneBotSec; $i += 2) {
    if ((Test-TcpPort $ports.Ws) -and (Test-TcpPort $ports.Http)) { $onebotOk = $true; break }
    Start-Sleep -Seconds 2
}
if ($onebotOk) {
    Say ("      OneBot 已就绪" ) 'Green'
} else {
    Say '      OneBot 端口还没起来。' 'Yellow'
    Say '      通常是因为 QQ 还没被「注入」。请打开 SnowLuma 面板：' 'Yellow'
    Say ("        {0}" -f $SnowLumaWebUi) 'Cyan'
    Say '      点左侧「进程注入」-> 找到 QQ 进程 -> 点「加载」，' 'Yellow'
    Say '      等 OneBot 端口自动出现即可（桥接会自动重连，不用重启）。' 'Yellow'
}

# ---------- 5. qq-bridge ----------
Say ''
if (Test-TcpPort 3100) {
    Say '[5/7] qq-bridge 已在运行' 'Green'
} else {
    $bat = Join-Path $BridgeDir 'start.bat'
    if (-not (Test-Path $bat)) {
        Say ("[5/7] 找不到启动脚本：{0}" -f $bat) 'Red'
    } else {
        Say '[5/7] 正在启动 qq-bridge（会新开一个窗口，别关它）...' 'Yellow'
        # start.bat 自带崩溃自动重启 + state/ 权限收紧
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'start.bat' -WorkingDirectory $BridgeDir
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 1
            if (Test-TcpPort 3100) { break }
        }
        Start-Sleep -Seconds 4      # 等它连上 DSH 并自愈 WS token
    }
}

# ---------- 6. 浏览器 + 看网页的代理（CDP） ----------
# 她「看网页」是借你日常那个 Edge（带着你的登录态），所以得先有浏览器、再有代理去连它。
#
# ⚠️ 坑：Edge 常配「开机后台自启」（--no-startup-window --win-session-start），
# 重启后有一堆 msedge.exe 但**没有窗口**。
# 更坑的是：这种后台实例即使因为之前勾过「Allow remote debugging」而开了
# DevToolsActivePort + 监听端口，CDP 连接仍会被拒（实测 ws 直接 error），
# 因为首次连接需要用户在**有窗口的浏览器**里点「允许」。没有窗口 = 永远等不到授权。
# 所以判据只看一件事：**有没有可见窗口**。只看端口文件会被后台实例骗过去。
# 正确判据：① 代理已连上 → 就绪；② 有可见窗口 → 可以尝试（用户能看见授权弹窗）。
# 只有后台进程时必须拉一个真窗口起来。

$EdgeUserData = "$env:LOCALAPPDATA\Microsoft\Edge\User Data"

function Test-EdgeWindowed {
    # 有可见主窗口 = 用户真的能看到浏览器（也才能点授权弹窗）
    $visible = @(Get-Process -Name msedge -ErrorAction SilentlyContinue |
                 Where-Object { $_.MainWindowHandle -ne 0 })
    return ($visible.Count -gt 0)
}

# 把 Edge 窗口提到前台：授权弹窗长在浏览器窗口里，窗口被别的程序盖住时
# 用户根本看不见，就会一直干等（实测踩过）。
function Bring-EdgeToFront {
    try {
        $edge = Get-Process -Name msedge -ErrorAction SilentlyContinue |
                Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if (-not $edge) { return }
        if (-not ('QqBridge.Win32Fg' -as [type])) {
            Add-Type -Namespace QqBridge -Name Win32Fg -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'@ -ErrorAction SilentlyContinue
        }
        [void][QqBridge.Win32Fg]::ShowWindow($edge.MainWindowHandle, 9)   # SW_RESTORE
        [void][QqBridge.Win32Fg]::SetForegroundWindow($edge.MainWindowHandle)
    } catch { }
}

Say ''
$webOk = $false
try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:3456/health' -TimeoutSec 4
    if ($h.status -eq 'ok' -and $h.connected -eq $true) { $webOk = $true }
} catch { }

if ($webOk) {
    Say '[6/7] 看网页的代理已就绪（已连上你的浏览器）' 'Green'
} else {
    if (Test-EdgeWindowed) {
        Say '[6/7] 浏览器窗口已在，直接尝试连接' 'Green'
    } elseif (Test-Path $EdgeExe) {
        Say '[6/7] 浏览器没真正打开（只有后台常驻进程），正在打开 Edge 窗口...' 'Yellow'
        # 显式带一个普通地址启动，避免又变成 --no-startup-window 的后台进程
        Start-Process -FilePath $EdgeExe -ArgumentList 'about:blank'
        # 等出现可见窗口（最多 30 秒）；只起后台进程不算成功
        $opened = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 1
            if (Test-EdgeWindowed) { $opened = $true; break }
        }
        if ($opened) { Say '      Edge 窗口已打开' 'Green' }
        else { Say '      Edge 窗口没出来（可能被后台进程占用，继续尝试）' 'Yellow' }
    } else {
        Say ("[6/7] 找不到 Edge：{0}" -f $EdgeExe) 'Yellow'
    }

    # 让代理开始连接：这一步**可能**触发 Edge 弹出「是否允许远程调试？」确认框。
    # ⚠️ 2026-10-22 修正（之前这里写的是"每次新浏览器实例都会弹"，不够准确）：
    #    实测查清 —— 弹窗是**按 CDP 连接**确认的，不是按浏览器实例：
    #      · 代理那条连接还活着 ⇒ **一个都不弹**。以前脚本不管三七二十一先调一次
    #        check-deps，等于把好好的连接又闯一遍，白白多要一次授权。
    #      · 只有代理真断线了（浏览器重启 / 代理被杀）才会有新连接，才可能要你点。
    #    所以现在先问：连接活着就直接跳过整段，一个字都不打扰。
    $proxyAlreadyOk = $false
    try {
        $h0 = Invoke-RestMethod -Uri 'http://127.0.0.1:3456/health' -TimeoutSec 4
        if ($h0.status -eq 'ok' -and $h0.connected -eq $true) { $proxyAlreadyOk = $true }
    } catch { }

    if ($proxyAlreadyOk) {
        $webOk = $true
        Say '      代理连接还活着，不用再授权 ✓（这一步不该打扰你）' 'Green'
    } else {
        if (Test-Path $CdpDepsScript) { & $nodeExe $CdpDepsScript *> $null }

        if (Wait-ProxyConnected -Seconds 10) {
            $webOk = $true
        } else {
            # 先问清代理"是不是在等授权" —— 只有真的在等，才值得把你叫到 Edge 前面。
            $waitingAuth = $false
            try {
                $hA = Invoke-RestMethod -Uri 'http://127.0.0.1:3456/health' -TimeoutSec 4
                if ($hA.waitingForAuth -eq $true) { $waitingAuth = $true }
            } catch { }

            if ($waitingAuth) {
                # 把 Edge 提到前台，然后明确告诉用户点什么——弹窗在浏览器里，窗口挡着就白等。
                Bring-EdgeToFront
                Say ''
                Say '      ┌─────────────────────────────────────────────────────┐' 'Yellow'
                Say '      │  👉 请到 Edge 窗口点「允许」                        │' 'Yellow'
                Say '      └─────────────────────────────────────────────────────┘' 'Yellow'
                Say '          Edge 弹了「是否允许远程调试？」确认框，点「允许」就好。' 'Yellow'
                Say '          点一次这条连接就长期有效 —— 只要浏览器不重启、代理不被杀，' 'DarkGray'
                Say '          以后不会再问。脚本最多等 90 秒（点完它会自动接上）。' 'DarkGray'
                Say ''
                if (Test-Path $CdpDepsScript) { & $nodeExe $CdpDepsScript *> $null }
                $webOk = Wait-ProxyConnected -Seconds 90
                # 期间用户可能又切走了窗口，再拉一次前台 + 重试一轮
                if (-not $webOk) {
                    Bring-EdgeToFront
                    Say '      还没连上，再试一轮（如果弹窗又出现了，点「允许」）...' 'Yellow'
                    if (Test-Path $CdpDepsScript) { & $nodeExe $CdpDepsScript *> $null }
                    $webOk = Wait-ProxyConnected -Seconds 60
                }
            } else {
                Say '      代理暂时连不上浏览器，但**不是**在等授权（浏览器可能没开）。' 'DarkGray'
                Say '      先不打扰你，聊天和其它功能照常；等你下次让她看网页时会再试。' 'DarkGray'
            }
        }
    }

    if ($webOk) {
        Say '      代理已连上浏览器 ✓' 'Green'
    } else {
        Say '      看网页这条链路暂时用不了（聊天不受影响）。' 'Yellow'
        Say ("      手动办法：Edge 打开 {0}，勾上开关，再运行一次本启动器。" -f $InspectUrl) 'DarkGray'
    }
}

# ---------- 7. 记忆索引守护（每天 0 点后整理前一天的聊天要点） ----------
Say ''
$rollover = Join-Path $BridgeDir 'plugins\qq-memory-rollover\qq-memory-rollover.mjs'
if (-not (Test-Path $rollover)) {
    Say '[7/7] 找不到记忆索引脚本，跳过（不影响聊天）' 'DarkGray'
} else {
    $rolloverNode = $rollover
    # 常驻守护：每 30 分钟醒一次，发现「上次整理≠昨天」就补做；0 点没开机，第二天上线也会补。
    $already = $false
    if (Test-Path (Join-Path $BridgeDir 'state\rollover.pid')) {
        try {
            $oldPid = [int](Get-Content (Join-Path $BridgeDir 'state\rollover.pid') -Raw)
            if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) { $already = $true }
        } catch { }
    }
    if ($already) {
        Say '[7/7] 记忆索引守护已在运行' 'Green'
    } else {
        Say '[7/7] 正在启动记忆索引守护（后台，每天自动整理前一天要点）...' 'Yellow'
        # 注意：-ArgumentList 不会自动给含空格的路径加引号。本仓库路径常含空格
        # （如 "...\Desktop\QQ bot\..."），不加引号会在空格处被拆断，node 只拿到
        # 半截模块路径而报 "Cannot find module"。这里显式加双引号。
        $p = Start-Process -FilePath (Join-Path $NodeDir 'node.exe') `
                -ArgumentList ("`"{0}`"" -f $rolloverNode) `
                -WorkingDirectory $BridgeDir -WindowStyle Hidden -PassThru
        Start-Sleep -Seconds 2
        # 立刻复核：node 起不来时会秒退，不能只看 PID 就报成功。
        if (Get-Process -Id $p.Id -ErrorAction SilentlyContinue) {
            try { Set-Content (Join-Path $BridgeDir 'state\rollover.pid') $p.Id -Encoding ASCII } catch { }
            Say ("  守护已启动（PID {0}）" -f $p.Id) 'DarkGray'
        } else {
            Say '  [!] 记忆守护启动后立即退出（不影响聊天）' 'Yellow'
            Say '      可手动排查：node "plugins\qq-memory-rollover\qq-memory-rollover.mjs"' 'DarkGray'
        }
    }
}

# ---------- 8. 身体（ESP32-S3 小板：她的耳朵和嘴） ----------
# 板子不在线就跳过 —— 一键启动不该因为"今天没接板子"而报错。
# 探活走 MQTT：板子每 5 秒往 <base>/state 发一条心跳。
# 声音改走公网中转以后，板子不必和这台电脑在同一个局域网了，UDP PING 那条路已经不通。
# 关掉这一段：paths.json 里写 "bodyDisabled": true（或设环境变量 QQBRIDGE_BODY_OFF=1）。
Say ''
# ── 主题前缀 / broker：**不再在这里设默认值** ───────────────────────────────
# 真值源只有一份：qq-bridge-deploy\state\body-config.json（控制台「身体」页可改，
# rot\tools\body_config.py 也读它）。body_probe.py / body_talk.py 都从那里取。
#
# 2026-10-28 就是因为这里硬编码了 broker.hivemq.com，切回 EMQX 后探活还在问旧
# broker，一键启动打出「板子没回心跳…这次跳过」，而板子其实好好的。
#
# 这两个键现在只是**可选覆盖**：paths.json 里不写 = 完全跟着控制台配置走。
$BodyBase = Get-Configured 'bodyBase' 'QQBRIDGE_BODY_BASE'
$BodyBroker = Get-Configured 'bodyBroker' 'QQBRIDGE_BODY_BROKER'
# 只在真的配了覆盖时才拼成命令行参数，否则让 python 自己读 body-config.json。
$BodyOverride = @()
if ($BodyBase) { $BodyOverride += @('--base', $BodyBase) }
if ($BodyBroker) { $BodyOverride += @('--broker', $BodyBroker) }
$BodyLabel = if ($BodyOverride.Count -gt 0) { ($BodyOverride -join ' ') } else { '控制台配置' }
$BodyDir = Get-Configured 'bodyDir' 'QQBRIDGE_BODY'
if (-not $BodyDir) {
    # 只在仓库的**上一层**找 `rot`（与 voice-tool 同一约定：工具在仓库外，随仓库搬家）。
    # 不写死任何绝对路径 —— 仓库要能公开、要能换机器（privacy-scan 会拦本机路径）。
    $BodyDir = Find-FirstExisting @(
        (Join-Path $RepoParent 'rot')
    )
}
# 探活脚本要用带 paho-mqtt 的解释器 —— 就是她 ASR 那个 venv，不另外装一套。
$BodyPy = Join-Path $BridgeDir 'tools\asr\.venv\Scripts\python.exe'
$BodyOff = ("$($P.bodyDisabled)" -eq 'true') -or ($env:QQBRIDGE_BODY_OFF -eq '1')
$bodyLaunched = $false   # 这一轮刚把它拉起来（进程还没出现，汇总别误报）

# 探活逻辑直接写在下面的 if 里（要把失败原因 json 里的 why 捞出来给人看），
# 所以不再单独包一个 Test-BodyBoard 函数 —— 留着没人调就是下一个坑。

if ($BodyOff) {
    Say '身体：配置里关掉了（paths.json 的 bodyDisabled=true），跳过' 'DarkGray'
} elseif (-not $BodyDir -or -not (Test-Path (Join-Path $BodyDir 'run-body-talk.cmd'))) {
    Say '身体：找不到工作区（rot\run-body-talk.cmd），跳过' 'DarkGray'
} else {
    $bodyProc = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
                  Where-Object { $_.CommandLine -like '*body_talk.py*' })
    # 探活同时把原因捞回来：退出码只能分三类，json 里的 why 才能说清
    # 「没开机」和「broker 连不上」和「心跳 JSON 坏了」的区别。
    $bodyProbeWhy = ''
    $bodyOnline = $false
    if ($BodyDir -and (Test-Path $BodyPy)) {
        $probeScript = Join-Path $BodyDir 'tools\body_probe.py'
        if (Test-Path $probeScript) {
            $argv = @($probeScript, '--timeout', '8') + $BodyOverride
            try {
                $raw = & $BodyPy @argv 2>$null
                $bodyOnline = ($LASTEXITCODE -eq 0)
                if (-not $bodyOnline -and $raw) {
                    try { $bodyProbeWhy = "$((($raw -join '') | ConvertFrom-Json).why)" } catch { $bodyProbeWhy = '' }
                }
            } catch { $bodyOnline = $false }
        }
    }
    if ($bodyProc.Count -gt 0) {
        Say ("身体：已经在听（PID {0}），不重复开" -f $bodyProc[0].ProcessId) 'Green'
    } elseif (-not $bodyOnline -and ($env:QQBRIDGE_BODY_FORCE -ne '1')) {
        Say ("身体：板子没回心跳（{0}），这次跳过 —— QQ 聊天不受影响" -f $BodyLabel) 'Yellow'
        if ($bodyProbeWhy) { Say ("      原因：{0}" -f $bodyProbeWhy) 'DarkGray' }
        Say '      板子没开机 / 没连上 Wi-Fi？主题前缀和 broker 现在都由控制台「身体」页管' 'DarkGray'
        Say ("      配置文件：{0}" -f (Join-Path $BridgeDir 'state\body-config.json')) 'DarkGray'
        Say ("      想强行开：双击 {0}" -f (Join-Path $BodyDir 'run-body-talk.cmd')) 'DarkGray'
        Say '      或设 QQBRIDGE_BODY_FORCE=1 再跑一键启动' 'DarkGray'
    } else {
        Say ("身体：板子在线（{0}），正在开「她的耳朵和嘴」（独立窗口，别关它）..." -f $BodyLabel) 'Yellow'
        # 用 -WorkingDirectory + 相对文件名（跟本文件里 dotnet/start.bat 的写法一致）：
        # 路径里就算有空格也不会踩 cmd 的引号坑。
        # $BodyOverride 为空时不追加任何参数 ⇒ body_talk.py 自己读控制台那份配置。
        $cmdLine = 'run-body-talk.cmd'
        if ($BodyOverride.Count -gt 0) { $cmdLine = $cmdLine + ' ' + ($BodyOverride -join ' ') }
        Start-Process -FilePath 'cmd.exe' `
            -ArgumentList '/k', $cmdLine `
            -WorkingDirectory $BodyDir
        $bodyLaunched = $true
    }
}

# ---------- 收尾汇总 ----------
Say ''
Say '------------------------------------------------------------' 'Cyan'
Say '  当前状态' 'Cyan'
Say '------------------------------------------------------------' 'Cyan'
Show-BridgeStatus
Show-VoiceStatus
if ($webOk) { Say '  看网页      : 已就绪（借你的 Edge）' 'Green' }
else { Say '  看网页      : 暂时不可用（不影响聊天）' 'Yellow' }

$bodyAlive = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
               Where-Object { $_.CommandLine -like '*body_talk.py*' })
if ($bodyAlive.Count -gt 0 -or $bodyLaunched) { Say '  身体        : 在听（板子上的耳朵和嘴）' 'Green' }
else { Say '  身体        : 没开（板子没接或不在这台电脑旁）' 'DarkGray' }

# 专项控制台：探活，没起就拉起来。地址单独一块打出来，方便一眼复制。
$extra = Start-ExtraConsole -ConsoleUrl $ExtraConsole
Say ''
Say '------------------------------------------------------------' 'Cyan'
Say '  专项控制台（主动找人 / 申请闸门 / 约定）' 'Cyan'
Say '------------------------------------------------------------' 'Cyan'
if ($extra.Ok) {
    if ($extra.Started) { Say '  状态        : 已为你启动（后台隐藏，不占任务栏）' 'DarkGray' }
    else { Say '  状态        : 已在运行' 'DarkGray' }
    Say ("  地址        : {0}/" -f $extra.Url) 'DarkGray'
    Say '  怎么看      : 在浏览器里开上面那个地址（不再单独弹窗了）。' 'Cyan'
    Say '  说明        : 仍是独立进程；关掉它不影响小鲸鱼在 QQ 里的任何行为。' 'DarkGray'
} else {
    Say ("  地址        : {0}/  （没起来：{1}）" -f $extra.Url, $extra.Reason) 'Yellow'
    Say '  手动启动    : 双击 qq-bridge-deploy\专项控制台.bat' 'DarkGray'
}
Say ''

if ($onebotOk -and (Test-TcpPort 3100)) {
    Say '  启动完成，可以关闭这个窗口了。' 'Green'
    Say '  机器人窗口和 SnowLuma 窗口请保持开着。' 'Green'
} else {
    Say '  启动还没完全就绪，按上面的提示处理一下。' 'Yellow'
}
Say ''
Pause-Exit


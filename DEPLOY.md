# 换机器部署（DEPLOY）

本文件只讲一件事：**把整套「QQ ↔ DSH 桥接」搬到另一台 Windows 机器上，并把人格、记忆、日记、收藏表情一起带过去。**

> 日常安装/配置说明仍在 [README.md](README.md)；这里只写「搬机器」这条路径上多出来的东西。

---

## 一、仓库里有什么、没有什么

搬机器最容易踩的坑是「以为仓库里全都有」。先看清边界：

| 东西 | 在仓库里？ | 说明 |
| --- | --- | --- |
| 桥接全部源码、脚本、preset、Web 控制台 | ✅ | `src/` `scripts/` `plugins/` `dsh/` `public/` |
| **人格卡**（`roles/<角色名>.md`） | ⚠️ 自己写 | 仓库只带 `roles/README.md` 和一张示例卡 `roles/傲娇助手.md`。你的角色卡由你自己创建（控制台「人格与角色」页可新建） |
| **日记**（`socialV2.diary.dir` 决定，默认 `data/日记/`） | ⚠️ 自己填 | 想搬就把日记同步进 `seed/data/日记/`，`install.ps1` 会恢复（见第 0 步）。**公开仓库不带任何日记** |
| **长期记忆 / 当前人格 / 模式 / 收藏表情备注** | ⚠️ 自己填 | 填进 `seed/state/`，`install.ps1` 恢复。公开仓库不带 |
| **群图库的记忆**（`media/index.json`：理由 / 备注 / 标签 / 来源） | ⚠️ 自己填 | 填进 `seed/data/media/`；`install.ps1` 会把它铺到 `<仓库>\media\`（**不是** `data\media\` —— 群图库读的就是那里） |
| **衣柜 / 皮肤** | ⚠️ 自己填 | 现在是生图服饰库（`qq_draw_image` 的 outfits 参数），不再需要 `seed/wardrobe/` 这套裁好的照片 |
| **群图库的原图**（`..\media\candidate\|library\|trash\`） | ❌ | 别人发来的私人图片，且 URL 带会过期的 `rkey`，不进 git |
| 官方工具代码（`tools/web-access/`、`tools/asr/*.py`、`tools/extra-console/`） | ✅ | 只带**代码**，不带 venv 与模型 |
| `config.json`（含你的 QQ 号、token） | ❌ | 被 `.gitignore` 挡住。由 `install.ps1` 从 `config.template.json` 生成空壳，你自己填 |
| `state/` 运行时状态（日志、令牌、会话） | ❌ | 同上。只有 5 个种子文件通过 `seed/` 带过去 |
| `node_modules/` | ❌ | `npm install` 现装 |
| **SnowLuma 本体** | ❌ | **EULA §5.4 禁止再分发**。用 `scripts/get-snowluma.mjs` 在你自己的机器上解压官方发行包 |
| **ASR/TTS 的 venv、whisper 模型与 `__pycache__`**（实测约 780 MB） | ❌ | 用 `tools/asr/install-asr.ps1` 现场装（2026-10-20 起这三条路径写进了 `.gitignore`） |
| DSH 本体、`.credentials.yaml`、DSH 的 sessions | ❌ | **绝不能**进仓库。DSH 单独装 |

**一句话**：仓库带的是**代码 + 通用文档**。人格、记忆、日记、衣柜这些「你这台机器上的真实生活」不进库 ——
公开仓库里没有它们，也不该有。外部的 SnowLuma / Python 环境 / DSH 由脚本或你自己装。

> 🔒 这条边界由 `.gitignore` 末尾那段「公开仓库的私人内容闸门」强制：`/seed/data/`、
> `/seed/wardrobe/`、`/seed/state/daily-memory.json` 等一律忽略。想整套搬家（私有 fork）时
> 把那一段删掉即可，但那样推上去就是公开的。

---

## 二、新机器需要先准备好的东西

装之前确认这四样（缺哪个，后面那一步就会跳过对应的能力）：

1. **Windows + PowerShell**（`pwsh` 或系统自带 `powershell`，任意一个）
2. **Node.js ≥ 22.13** —— 必须是 22 以上，Node 22 之前没有全局 `WebSocket`，桥接会直接崩
   - 下载：<https://nodejs.org/>
3. **DeepSeek Harness（DSH）桌面版**，能打开它的 Web 界面
4. **QQ 客户端** + 一个用来当机器人的小号

---

## 三、五步搬完

### 第 0 步：在老机器上把私人数据补进 `seed/`

`seed/` 是「人格与记忆」的载体，`install.ps1` 会把它铺回对应位置。老机器上更新过人格/记忆后，重新同步一次：

```powershell
# 在仓库根目录执行
# ⚠️ 日记可能被 config.json → socialV2.diary.dir 指到了仓库外。先确认它到底在哪：
#     node -e "const c=require('./config.json');console.log(c.socialV2?.diary?.dir||'data/日记（默认）')"
#     本机当前是 ..\小鲸鱼的日记（仓库上一级），所以下面这条 `..\` 路径不是可选动作 ——
#     它是**唯一**能把日记带进仓库的路径（`.gitignore` 里的 `/data/` 只管仓库内那个已废弃的目录）。
New-Item -ItemType Directory -Force seed\state,seed\data\日记,seed\data\media | Out-Null
Copy-Item ..\小鲸鱼的日记\*.jsonl     seed\data\日记\ -Force        # 日记（在仓库外）
Copy-Item state\daily-memory.json    seed\state\ -Force            # 长期记忆
Copy-Item state\current-role.json    seed\state\ -Force            # 当前人格
Copy-Item state\mode.json            seed\state\ -Force            # 当前模式
Copy-Item state\stickers.json        seed\state\ -Force            # 收藏表情的备注
Copy-Item ..\media\index.json        seed\data\media\ -Force       # 群图库的备注/标签/来源
```


> **图库的原图字节留在本机**（`/media/` 已被 `.gitignore` 忽略）—— 那些是别人发来的私人图片，
> 还带着会过期的腾讯直链，不该进 git 历史。仓库里只带 `index.json`（理由、备注、标签、来源）。

人格卡**要自己复制**：公开仓库里只有 `roles/README.md` 和示例卡 `roles/傲娇助手.md`。
把它拷进 `seed/roles/` 不行 —— `install.ps1` 的 seed 映射只认 `seed/state/` 与 `seed/data/`，
人格卡请直接放进 `roles/` 并跟着你的私有分支走（或备份到仓库外）。

> `seed/` 已经在 `.gitignore` 里做了 `!/seed/**` 豁免，**会**进仓库。
> 别把 `state/` 里其余文件（`bridge.log`、`console-token`、`social-v2.json`、`sessions.json`、`token-usage.jsonl`、`tool-calls.jsonl`）复制进去 —— 那些是运行时状态和令牌，既没必要也不安全。

**提交前一定要跑一次脱敏扫描**（它会按 `.gitignore` 排除不该进库的文件，逐条给出命中位置）：

```powershell
node scripts\privacy-scan.mjs
```

看到 `✅ 未发现敏感信息` 再提交。

### 第 1 步：新机器上克隆

```powershell
git clone git@github.com:shiq21185-cmyk/qq-bridge-deploy.git qq-bridge
cd qq-bridge
```

仓库是**私有**的，克隆前先把这台机器的 GitHub 凭据配好：

- **SSH（推荐）**：`ssh-keygen -t ed25519 -C "你的邮箱"` → 把 `~\.ssh\id_ed25519.pub` 内容贴进
  GitHub 的 Settings → SSH and GPG keys → New SSH key，然后 `ssh -T git@github.com` 应该回
  `Hi <你的账号>! You've successfully authenticated`。
- **HTTPS**：`git clone https://github.com/shiq21185-cmyk/qq-bridge-deploy.git qq-bridge`，
  密码处填 Personal Access Token（需 `repo` scope），不是账号密码。

> 如果 `git clone` 卡在 `github.com:443` 超时（部分网络环境会），改用 SSH 那条；
> SSH 走 22 端口不通时还可以压到 443：`ssh -T -p 443 git@ssh.github.com`。

### 第 2 步：跑安装向导

```powershell
pwsh -File launcher\install.ps1
```

它会按顺序做这些事，**每一步都可重复执行、已存在的不覆盖**：

1. 找一个合格的 Node（`PATH` → 常见安装位置 → SnowLuma 自带），顺便把你 PATH 里指向的那个排到最前
2. 探测 SnowLuma / `tools` / ASR venv / QQ.exe / msedge.exe 的位置，探测不到就明确告诉你缺什么
3. 从 `config.template.json` 生成 `config.json`（**不会**覆盖已存在的）
4. 写 `launcher\paths.json`（本机专用路径，不进 git）
5. 把 `seed/` 铺回 `roles\`、`data\`、`state\`（**目标已存在就跳过**，所以不会冲掉你手改过的人格）
6. `npm install`（postinstall 会给 `@snowluma/sdk` 打 13 个补丁）
7. `node scripts\setup-dsh.mjs desktop` —— 把两个 agent preset 与三个 MCP server 注册进 DSH

常用开关：`-SkipNpm`（依赖已装好）、`-SkipDsh`、`-DryRun`（只报告不落盘）、`-SnowLumaDir <目录>`、`-ToolsDir <目录>`。

> ⚠️ 装完 **必须重启 DSH**，preset 与 MCP 才会生效。

### 第 3 步：装 SnowLuma（本仓库不携带）

SnowLuma 的 EULA §5.4 明确禁止再分发 / 并入第三方安装包 / 用自动化脚本部署，所以仓库里没有它的任何二进制。请自己从官方渠道下载发行包：

**下载页**：<https://github.com/SnowLuma/SnowLuma/releases/latest> → 选 `SnowLuma-v<版本>-win-x64.zip`（约 36 MB，自带 Node 运行时；`-lite` 版约 4.6 MB，但要求本机 Node ≥ 22.13，且不含完整依赖）。

```powershell
# 解压到你想要的位置（默认是仓库的兄弟目录 <仓库上级>\SnowLuma）
node scripts\get-snowluma.mjs --zip "C:\Users\你\Downloads\SnowLuma-v1.14.22-win-x64.zip"

# 或者让它去下载直链（你有官方直链时）
node scripts\get-snowluma.mjs --url https://github.com/SnowLuma/SnowLuma/releases/download/v1.14.22/SnowLuma-v1.14.22-win-x64.zip
```

脚本会校验解压结果（`index.mjs` / `package.json` / `EULA.md`）并报出版本、以及是否自带 `node.exe`。目标目录已存在时它会拒绝执行，加 `--force` 才会覆盖。

解压后**回头补跑一次** `pwsh -File launcher\install.ps1`，让 `config.json` 里的 `snowluma.homeDir` 指对地方。

### 第 4 步：一次性手动步骤（脚本故意不替你做）

这几步都需要在界面上点，而且涉及账号安全，`install.ps1` 不会代劳：

1. **启动 SnowLuma**，用它的 WebUI（默认 `http://127.0.0.1:5099`，初始密码在数据库里，未改密时会重新生成）登录并接受 EULA
2. **登录机器人小号**（不是你的大号）
3. **打开 OneBot**：HTTP 端口 3000、WS 端口 3001，把 access token 记下来
4. **填 `config.json`**：
   | 字段 | 填什么 |
   | --- | --- |
   | `ownerQQ` | 你自己的 QQ 号（只有它私聊时能用完整本地工具） |
   | `allow.private` | 允许私聊的 QQ 号数组（通常就 ownerQQ） |
   | `allow.groups` | 允许机器人说话的群号数组 |
   | `snowluma.accessToken` | 第 3 步记下的 token（留空也能跑，桥接会自发现） |
   | `snowluma.homeDir` | SnowLuma 解压到哪（`install.ps1` 一般已经填好） |
   | `socialV2.diary.dir` | 日记在哪（**留空** = `<仓库>\data\日记`，正好是 `install.ps1` 铺种子的地方；本机当初改成了仓库外的 `..\小鲸鱼的日记`） |
   | `socialV2.selfImage.dir` | 衣柜图片在哪（`install.ps1` 已填成 `<仓库>/wardrobe`；留空 = 衣柜整个不可用） |

   白名单**不要留空**。`allowAllWhenEmpty` 默认 `false`，留空等于谁都不放行；反过来，如果你把它设成 `true`，就等于把 QQ 账号控制权交给了模型。

### 第 5 步：启动

双击仓库根目录的 **`一键启动.bat`**，或者：

```powershell
pwsh -File launcher\launch-all.ps1
```

启动脚本会按 `launcher\paths.json` → 环境变量 → 自动探测 的顺序找各个组件，所以换盘符、换目录都不用改脚本。

控制台默认在 <http://127.0.0.1:3100>（令牌在 `state\console-token`）。

---

## 四、可选：语音（ASR / TTS）

仓库只带 Python 源码（`tools/asr/*.py`），venv 与 whisper 模型现场装（约 2.7 GB，需要联网）：

```powershell
pwsh -File tools\asr\install-asr.ps1
```

装完在 `config.json` 里把 `socialV2.asr.enabled` / `socialV2.tts.enabled` 改成 `true`。`toolsDir` 留空即可 —— 代码默认找 `<仓库上级>\qq-bridge-tools\asr`，`install-asr.ps1` 也是装到那儿。

两点要知道：

- **入站语音**（她听你说）全程本机，音频不出机器
- **出站语音**（她开口说）默认 `engine: "edge"`，文字会发到微软的语音服务；改成 `"sapi"` 就完全离线，代价是音色机器味重

---

## 五、可选：和她一起看网页

`tools\web-access\` 是随仓库带的第三方工具（已 vendor，带 `LOCAL-PATCH.md` 记录本地补丁）。要让「一起看网页」可用，还需要：

1. 浏览器打开 `edge://inspect/#remote-debugging` 并开启远程调试（**不要**用 `--remote-debugging-port`，Chromium 136+ 已禁用该开关）
2. 配 `%USERPROFILE%\.web-access\config.env`，指向你的 Edge 用户目录
3. 跑 `node scripts\check-deps.mjs`（在 `tools\web-access\` 下）确认依赖齐

没配也不影响其它功能，只是 `web_read_link` 一类工具会报「浏览器没开着」。

---

## 六、换机器后自检

```powershell
node scripts\privacy-scan.mjs        # 确认没把秘密带进仓库
node scripts\test-role-card.mjs      # 确认人格卡能读出来
node --check src\bridge.js           # 语法门禁
```

再打开控制台 <http://127.0.0.1:3100> 看一眼：人格名、模式、白名单对不对。

---

## 七、出问题先看这几条

| 现象 | 原因 / 处理 |
| --- | --- |
| 启动脚本说找不到 Node | 装 Node ≥ 22.13，或者 `pwsh -File launcher\install.ps1 -SnowLumaDir <路径>` 后重跑 |
| 桥接起来了但 QQ 上毫无反应 | 十有八九是 DSH 端的 preset / MCP 没装或没重启。跑 `node scripts\setup-dsh.mjs desktop`，然后重启 DSH |
| 报「bridge already running」（退出码 2） | 桥接是单实例的，先关掉另一个窗口 |
| 连上了但收不到消息 | 见 README「SnowLuma 版本与上游健康」一节：通常是 HTTP token 与 WS token 不一致，或上游版本不匹配 |
| 人格/记忆没恢复过来 | 先确认 `seed/` 里到底有没有东西（公开仓库克隆下来时是空的）。`install.ps1` 只在目标**不存在**时才铺 `seed/`，想强行覆盖就先把 `roles/<角色名>.md`、`state/daily-memory.json` 改名，再重跑 |
| 语音不可用 | 没跑 `tools\asr\install-asr.ps1`，或 `config.json` 里 `asr.enabled` / `tts.enabled` 还是 `false` |
| 控制台打不开 | 端口被占或令牌不对；令牌在 `state\console-token` |

---

## 八、把改动同步回老机器（双向）

仓库是同一个，两边都能推。注意这三件事**永远不进 git**，所以两边各自维护：`config.json`、`state/`（除 `seed/` 那几个）、`launcher/paths.json`、`node_modules/`、SnowLuma 与 ASR 环境、群图库原图。

想同步人格或记忆，就按「第 0 步」把文件复制进 `seed/`、跑一次 `privacy-scan`、再提交。

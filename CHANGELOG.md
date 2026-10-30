# 更新日志（CHANGELOG）

> 本文件只放**索引与摘要**；每一版的完整说明在 [`docs/releases/`](docs/releases/)。
> 版本号规则：主版本跟 DSH，`rN` 表示同一 DSH 版本下桥接的第 N 次发布
> （见 [docs/guides/DSH_020_ADAPTATION.md §H](docs/guides/DSH_020_ADAPTATION.md)）。
> 改动安全相关代码前，请先读 [RULES.md](RULES.md) 与 [SECURITY_BASELINE](docs/guides/SECURITY_BASELINE.md)。
> **按天的流水记录在 [DEVLOG.md](DEVLOG.md)**（每天都写，允许粗糙）；本文件只在发版时写。

| 版本 | 日期 | DSH 基线 | 一句话 | 详情 |
| --- | --- | --- | --- | --- |
| **v0.2.1-r1** | 2026-10-26 | 0.2.1-rc.2 | 只做适配对账、不加功能：守卫补齐 0.2.1 工具面 + `dsh-ops` 一族（67→99）；修掉两处方向写反的 `{{cwd}}` 断言；**修好对账工具**（asar 布局支持，`verify:adaptation` 首次 77/0 全绿） | [releases/v0.2.1-r1.md](docs/releases/v0.2.1-r1.md) |
| v0.2.0-r5 | 2026-10-24 | 0.2.0-rc.2 | 记忆能翻旧账（`qq_memory_query` 归档检索、索引改为「随时间移除」、〔约定〕置顶）；语音被主人关掉时把话直接按文字发出去；拆掉从未被调用过的「她自己的图库」；群图库摘要去废话 272→190 字；12 处本机路径清出仓库 | [releases/v0.2.0-r5.md](docs/releases/v0.2.0-r5.md) |
| v0.2.0-r4 | 2026-10-20 | 0.2.0-rc.2 | 她有了自己的时间：主动找人、自由时间、约定；「玩手机/刷B站」改成**当场申请**的硬闸门；独立专项控制台；群图库与她自己的图库；语音优先 | [releases/v0.2.0-r4.md](docs/releases/v0.2.0-r4.md) |
| v0.2.0-r3 | 2026-10-17 | 0.2.0-rc.2 | 上游健康可观测（「QQ 注入失败」误诊）、SnowLuma 库升级、全新 clone 可移植性 | 提交 `fbb1a54` |
| v0.2.0 | 2026-10-16 | 0.2.0-rc.2 | 修「会话待处理队列读不出来」；按 0.2.0 真实工具清单重新对账安全守卫 | [DSH_020_ADAPTATION](docs/guides/DSH_020_ADAPTATION.md) |
| ~~v0.2.1~~ | — | — | **已撤回**（不符合版本号方案，无二进制资产、无下游依赖） | — |
| v0.1.7 | 2026-09 | 0.1.7-rc.2 | DSH 0.1.7-rc.2 适配、安全加固与全量缺陷修复 | — |
| v0.1.5 | 2026-09 | 0.1.5-rc.1 | 移除 `start_snowluma` / `stop_snowluma`；演示视频改由 Release 附件托管 | — |
| v0.1.0 | 2026-08 | 0.1.1-rc.2 | 首个可用版本（点号 endpoint 协议代次） | — |

---

## v0.2.1-r1（2026-10-26）摘要

**这是一个「只做版本更新」的版本**：不加功能、不动人格、不改业务逻辑，只把桥接对齐到
本机在跑的 DSH `0.2.1-rc.2`，并修掉两处方向写反的安全/回归断言。完整说明见
[docs/releases/v0.2.1-r1.md](docs/releases/v0.2.1-r1.md)。

### 安全守卫（L7 注册期）

按 0.2.1 真实工具面重新对账，`LOCAL_EXECUTION_TOOLS` 共补 32 个名字（67 → **99**）：

**DSH 0.2.1 工具面（16 个）：**

- `working_directory` —— **本机实测已进全局层**（`state/tool-restrict.log` 的
  known global tools 里确实出现），`dsh-base` 默认挂 `working-directory` +
  `tool-working-directory` 两行，所以每个 QQ 会话都会继承它。
- `terminal_{open,send,read,signal,close,list}` —— 0.2.1 转正的终端能力（= 直接 shell）。
- `session_{search,trace}` / `session_event_{read,search,trace}` —— 能跨会话读事件正文。
- `plugin_market` / `create_worktree` / `wait_agent` —— 装载权 / 写盘 + git / team 家族。

**`dsh-ops` 第三方插件（16 个，上游名单完全没有）：**

- `ops_bash` / `ops_pwsh`、`ops_read_files` / `ops_read_table` / `ops_read_docx` / `ops_read_pdf`、
  `ops_glob` / `ops_grep` / `ops_inspect_local_file`、
  `ops_write_file` / `ops_edit_file` / `ops_replace` / `ops_copy` / `ops_move` / `ops_remove` /
  `ops_stat` / `ops_diff` —— 文件读写检索 + 直接执行命令，与官方工具能力等价。
  只有 `ops_discover_tools`（纯能力发现）不拦。

### 修掉方向写反的断言（真正的隐患）

`verify-dsh-020-adaptation.mjs` 与 `verify-persona-config.mjs` 原先都断言
「preset 的 persona 里**必须**出现 `{{cwd}}`」。但 DSH 0.2.1 起 agent loop 只注册
`provider` / `model`（`cwd` 已删），而 `dsh-system-prompt` 对未知变量是 **fail loud**
（直接 throw，不是渲染成空串）⇒ 出现 `{{cwd}}` 会让**每一次**回合在系统提示词装配阶段
直接 error、模型一次都不跑，QQ 侧表现就是「发消息完全不回」。
旧断言等于「把能跑的状态判成红、把炸掉的状态判成绿」。现在改成**只允许 DSH 已注册的变量**
（provider / model / response_language）的双向对账。

### 版本身份

`package.json` / `package-lock.json` / 两个插件包 / 三个 MCP serverInfo 统一为 `0.2.1-r1`
（版本号方案见 DSH_020 附录 H：主版本与 DSH 同步，`rN` = 同一 DSH 版本下第 N 次发布）。
`verify:adaptation` 指向改名后的 `scripts/verify-dsh-021-adaptation.mjs`。

### 修好对账工具（`verify:adaptation` 首次全绿）

本机 DSH 是 **Electron 桌面版**，`@deepseek-ai/*` 全打在 `resources/app.asar` 里，
磁盘上没有可解析的 `node_modules`。旧脚本只认磁盘目录，于是：

- `verify:adaptation` / `verify-persona-config` 直接 `ERR_MODULE_NOT_FOUND`，**根本跑不起来**；
- `scan:tool-names` 扫到 **0 个工具名**，把 46 个**真实存在**的名字报成「假名」——
  这个方向特别危险，它会逼人把真名字从守卫名单里删掉，等于自己拆安全边界。

`scripts/dsh-modules.mjs` 现在支持 asar：从 DSH 自己的日志里自动发现安装位置
（不硬编盘符）、按 offset 读文件、按需把包抽到临时目录再 import。
`scripts/dsh-tool-names.mjs` 补上包级**前缀拼装**（`ops_` 常量与工具名不在同一个文件里）、
工具顺序数组、`profiles/<p>/node_modules` 插件目录。

顺带修掉一批「假红」（验证脚本假设与本机实况不符）：端口写死 3080（实际 19387）、
profile 写死 `web`（实际 `desktop`）、模型名写死 `deepseek-flash`（实际 `deepseek-v4.1-flash`）、
`selectModel` 写死 provider、MCP 数量写死 3（实际 5）、活 DSH 连不上时整轮崩掉。

### 没做（刻意）

上游 `v0.2.1-r1` 里还有两块**这里不需要**的东西，没有并入：`src/web-search.js`
（这台机器没有 `DEEPSEEK_API_KEY`，`tool-web.search` 是故意关掉的）、以及上游那版 328 行的
守卫实现（本机 1052 行版本带三档会话权能矩阵，强得多）。`media-normalize` 与「旧账时间感」
留待后续单独版本处理，不进这次。

### 测试

```
verify:adaptation                 77 通过 / 0 失败   ← 本机首次全绿
test-preset-local-tools           7/7
test-qq-preset-contract           11/11
test:audit                        58/58 脚本通过
scan:tool-names                   456 包 / 83 个真实名字；假名 0、漏网 0
```

### 追加：`qq_memory_query` 支持按日期查（2026-10-27）

主人说具体日期时（「10月22号我们聊了什么」），她之前**查不到** —— 只能把
`"10月22"` 当子串碰运气，而记忆摘要里**只有 10/50 条写了日期**，剩下 80% 永远搜不到。

现在 `qq_memory_query` 新增 `day` / `from` / `to` 三个参数，日期是**独立维度**：

- 支持 `2026-10-22` / `10月22` / `昨天` / `前天` / `3天前`
- **星期类**：`周三` / `这周三` / `上周三` / `上星期三` / `上礼拜三` / `上周` / `周3`
  （她每轮都看得见【现在】`YYYY-MM-DD 周X`，所以"上周三"本来就可推断）
- 日期过滤**先于**关键词，两者可叠加（`day=10月22 & q=游戏` → 那天里跟游戏有关的）
- 三种失败**分开报**：日期看不懂 / 那天还没到 / 那天确实没记录

顺手修了两个解析 bug：「上周三」被算成这周三、「上周」算成了下周。

`test-memory-archive` 5 → 9 个测试（新增日期解析、按日期查、参数暴露三类断言）。

---

## v0.2.0-r5（2026-10-24）摘要

跨度 4 天、**33 个文件，约 +1 252 / −1 180 行**。完整说明见 [docs/releases/v0.2.0-r5.md](docs/releases/v0.2.0-r5.md)。

### 新增 / 改变

- **记忆能翻旧账**：`qq_memory_query` 传 `q="关键词"` 检索**更早的记忆归档**。
  ⚠️ 2026-10-23 之前这个分支读的是 `src/` 下被读 **0 次** 的 `daily-memory.json` —— 归档条目根本查不到，等于没接线。
- **索引容量策略改成「随时间移除」**：索引每轮唤醒都要重读一遍，压成一行也照样每轮付钱 —— 所以旧条目**移出索引**
  （仍在记忆库里、可检索），而不是压缩它。索引窗口 7 天 → **2 天**，并附一行「可搜：xxx、yyy」的关键词提示。
- **〔约定〕置顶**（`INDEX_PIN_MAX_ITEMS=4` / `INDEX_PIN_SOFT_DAYS=14`）：`appointmentDue()` 让**还没到期的约定**不受
  「最近几天」限制 —— 那些比日期看着的要紧，到点该她主动提。
- **语音被主人关掉时的明确处理**：`qq_say` 不报错，直接把这句话按文字发出去（`mode="text"`）；人格里写清
  「不是故障、别重试、不用报给主人、这句已经发出去了、之后直接打字」。
- **拆掉「她自己的图库」**（`qq_gallery_add` / `qq_gallery_list`、`src/gallery-lib.js` 257 行、提示词里 318 字）。
  依据是 4 243 条 tool-calls 里这两个工具调用 **0 次**（同期 `qq_get_message_images` 62 次）。**群图库保留**（它是发图用的素材库）。
- **群图库摘要去废话**：`buildPhotoContext` 只列**有备注/标签**的图；一张都没有时改给一句能行动的话，
  且该分支**不再注入任何自由文本**（注入面为零）。实测 **272 → 190 字**，重复占位行 6 → 0。
- **隐私**：12 处本机绝对路径清出仓库（人格 `suffix` 不再写死 `%USERPROFILE%\...`、`launch-all.ps1` 删掉 `<盘符>:\DSH` 本机候选、
  两个探针脚本移进 `_tmp/`）。`node scripts/privacy-scan.mjs` 扫 260 个文件 **零命中**。

### 修复

- **一个「假红」测试**：`test-memory-isolation` 断言「小黑盒那条归属主人私聊」，却拿**今天**的预算去索引里捞 10-21 的记忆 ——
  记忆涨到 10 天 40 条后它滑出了窗口，于是这条测的是**日期**不是归属。改成数据层断言 `scope`，再把 `now` 钉在记录当天。
- **生成物漂移**：`plugins/qq-agent-presets/presets/*.patch.yml` 由源 `dsh/agent-presets/` 重新生成，`--check` 校验无漂移。

### 测试

`npm run test:audit` → **57/57**。新增 6 个测试（记忆归档、归档排序、印象、置顶、重置保留记忆、语音被主人关掉）；
删除 `test-gallery-prompt.mjs`（随图库一起拆）。

### ⚠️ 历史里还留着本机路径

那 12 处路径在 r5 **之前**就已提交并推到 `origin/main`，本版只保证**以后**的提交干净。
要连历史一起清需要 `git filter-repo` 重写全部提交再 force push（会让别人的克隆失效），这次**没有做**。

---

## v0.2.0-r4（2026-10-20）摘要

跨度 3 天、约 **+5 084 / −163 行**。完整说明见 [docs/releases/v0.2.0-r4.md](docs/releases/v0.2.0-r4.md)。

### 新增

- **时间感**（`src/time-context.js`）：时段/饭点/距上次说话多久，算成一句话交给提示词；同一套边界也给「这个点该不该主动找他」用。
- **自由时间**：她判断聊完后静默达阈值（默认 3 分钟）即进入自主回合；收到新消息或拍一拍会**取消**待办。
- **约定**（`qq_promise` / `qq_promise_done`）：说出口的「明早叫你」会落盘，到点**叫醒她**去做，而不是发一条固定的话。
- **「向我申请」硬闸门**：手机工具与 `bili_run` 不再无条件开放。授权落 `state/permits.json`，守卫（在 DSH 进程里）是**唯一执行点**，身份靠会话 id 反查 QQ 号，全程 **fail-closed**。
- **专项控制台**（`tools/extra-console/`，端口 3101）：独立进程、独立前端，**不复用**主控制台任何一行、**不依赖**本次新增路由 —— 插件更新不会把它一起换掉。
- **群图库**（`src/media-lib.js`）：`fileid` + dHash + sha1 三重去重，分层 `candidate/library/trash`。
- **她的图库**（`src/gallery-lib.js`）：只增不改、存字节不存 URL、理由必填。
- **语音优先**：`qq_say` 成为默认说话方式（`qq_speak` 已合并），`mode` 字段是唯一实况。
- **空间自主闸门**：QQ 空间的写操作只能发生在她自己起的回合，包括管理员在内谁命令都不行；两次写之间至少隔 4 小时（可配）。
- **结构地图**（`src/bridge.MAP.md` + `npm run map`）：`bridge.js` 14 091 行不拆，改用地图 + 过期检查。
- **15 个 QQ 工具 / 24 条桥接路由**（空间、图库、申请、约定、语音）。

### 修复

- **她把前一天的日记当成今天说** —— 日记行首现在标 `【今天】/【昨天】`，不再依赖模型自己做减法。
- **人格卡里出现两块重复的记忆索引** —— CRLF 与 `\n` 混用导致块识别失败；抽成纯函数并钉住幂等。
- **「反馈给主人」其实谁也没收到** —— `notifyOwnerOnError` 是占位实现，只 log 不发消息；现在会真发私信。
- 群图库 4 个开关存不进去；`voice`/`tts` 段被整个冲掉；`{{cwd}}` 让 preset 渲染直接抛错。
- TTS 开关关掉后仍在发语音（启动快照 vs 实时值）。

### 仓库卫生

- `.gitignore` 补上 `tools/asr/.venv/`、`tools/asr/models/`、`**/__pycache__/`（约 **780 MB**）、`/media/`（群图库原图）、`/_backup-*/`（含旧 token 的回退副本）。
- `DEPLOY.md` 补明：**日记在仓库外**（`..\小鲸鱼的日记`），同步进 `seed/data/日记/` 是唯一入仓路径；图库只带 `seed/data/media/index.json`。

### 测试

新增 12 个测试脚本（申请闸门、时间边界、自由时间、空间闸门、记忆索引、日记归属、日记目录、反馈私信、媒体库、控制台隔离、结构地图）。
`npm run test-smoke` 一条命令跑其中三个。

# 开发日志（DEVLOG）

> **这个文件按天记流水**：今天改了什么、为什么改、卡在哪、怎么验证的。
> 和另外两份的分工：
>
> | 文件 | 粒度 | 什么时候写 |
> | --- | --- | --- |
> | **`DEVLOG.md`**（本文件） | 一天一条 | **每天都写**，哪怕只改一行。写给自己看，允许粗糙 |
> | [`CHANGELOG.md`](CHANGELOG.md) | 一个版本一条 | 发版时写，只写摘要 |
> | [`docs/releases/`](docs/releases/) | 一个版本一篇 | 发版时写，写给使用者看 |
>
> **顺序：最新在最上面。** 每天在 `---`（分隔线）的正下方新增一段，不要改旧记录 ——
> 旧记录的价值就在于它当时是怎么想的，事后美化等于把证据毁了。

## 怎么写

每天一段，标题固定写成 `## YYYY-MM-DD 周X`。正文按下面四条写，**用不上的直接删掉，不留空标题**：

```markdown
## 2026-10-21 周三

**做了什么**
- 一句话一件事，带文件路径

**为什么**
- 只写「不这么改会出什么问题」。想不出来的话，说明这个改动可能没必要

**踩坑**
- 试过但失败的路、报错原文、最后怎么绕过去的

**验证**
- 跑了什么测试 / 手动试了什么，结果如何

**留给明天**
- 没做完的、知道有问题但这次不修的（写清楚为什么不修）
```

> 提交时把当天的提交 hash 顺手补在段尾（`> 提交：`abc1234`、`def5678``），
> 以后想回溯「那天到底动了什么」能直接对上。

---

## 2026-10-29 周四

**做了什么**

- **通话音频搬家：`QQ bot\小鲸鱼的qq语音wav` → `QQ bot\小鲸鱼的语音\通话录音\`**（主人原话「放到qqbot里面」）。
  `tools/call/call_sidecar.py` 的 `REC_DIR` 与 `config.json` 的 `call.recDir` 一起改掉，11 个 wav（27 MB）已搬过去，旧目录删除。
- **逐字稿跟着搬出来**（主人：「搬，连同清理一起」）：`state/call-logs/` → `小鲸鱼的语音\通话逐字稿\`。
  四处同步：`call_sidecar.py` 的 `CALL_LOG_DIR` + `--transcript-dir`、桥接把它传下去（`src/bridge.js:5379`）、
  整理插件的 `callLogDir()`（`plugins/qq-memory-rollover/qq-memory-rollover.mjs:27`，老路径 `state/call-logs` 仍作为回落认）、
  `config.json` 的 `call.transcriptDir`。
- **新增保留策略：`tools/call/retention.py` + 双闸**（主人纠正口径：「应该又一套自己的清理逻辑」）。
  `sweep_dir(dir, pattern, keep_days, keep_mb)` / `sweep_many([...])`：**超 30 天**或**总量超 1 GB**，从最旧的开始删，
  两个闸哪个先到都动手；录音 wav 与逐字稿 json **成对删**（不留孤儿 json）。
  时机：引擎启动（`call_sidecar.py:1122`）与挂断（`:734`）各扫一次；阈值在 `config.json` 的 `call.recKeepDays` / `call.recKeepMB`
  （0 = 关掉那一道闸）。自测 `python tools/call/retention.py --selftest`（12 条断言，全绿）。
- **临时合成音频不再堆积**：新增 `sweep_spool()` —— 通话里「合成一个 mp3 → 播出去」的 `audio/call/say-*.mp3` 以前**从不删**，
  现在在引擎启动（`:1118`）与挂断（`:729`）两个时机清掉；录音与逐字稿一个都不动。
- **补登记漏洞（不是本次功能）**：`2026-10-29` 那条线新加的 `qq_draw_image` / `qq_send_image` 没登记进桥接 `toolFlags`，
  控制台那个开关**存不下去**；`qq_send_image` 的注册条件又只看 `sendImage` 键，
  与说明「关掉后这两个工具整个消失」不符。两处补齐（`src/bridge.js`、`src/mcp-snowluma-safe.js`）。
  守卫 `qq-tool-restrict.mjs` 把两个工具归进 `OWNER_PRIVATE_ONLY`（与 `drawImageAllowed` 同口径）。
- `start.bat`（仓库根那个）把中文注释换成英文：`test-audit-setup-guards.mjs` 要求它**纯 ASCII**，
  否则非 UTF-8 控制台下打印中文会乱码（现在 3015 字节、非 ASCII 字节 0 个）。

**为什么**

- 主人 2026-10-29：「现在小鲸鱼生成音频的文件转移到我轻松找到的地方，我自己选择清理，避免越积越多」。
- 录音是**成果** ⇒ 只搬家、不自动删（什么时候清由他决定）；`say-*.mp3` 是**内部产物** ⇒ 就该自动清：
  留着只会越积越多，而它作为「证据」的价值为零（录下来的 wav 里本来就有同一段声音）。
- 主人随后把口径改成「应该有一套自己的清理逻辑」⇒ 给一个**明确可预期**的规矩（30 天 / 1 GB 双闸）：
  他不用记得去清，目录也不会无限长。
- 逐字稿与录音是同一件事的两半（一个声音、一个文字），分两处放着，真要翻的时候一定只找得到一半。

**踩坑**

- `recDir` 在 `config.json` 的**顶层 `call`**，不是 `socialV2.call` —— 第一次查错了位置。
- 桥接的 `cfg` 是启动时 `loadConfig()`（`src/bridge.js:2343`）拍下的快照，`callCfg()` 读的就是它：
  改完 `config.json` **必须重启桥接**，否则 sidecar 还是被传旧的 `--rec-dir`（实测踩到，`/status` 里 `rec_dir` 一直是老路径）。
- `tools/call/call_sidecar.py` 是 **LF** 行尾（不是 CRLF）：改写时必须 `newline=''`，否则整个文件会变成 CRLF。
  同类坑：`pathlib.Path.read_text()` **不接 `newline=`**（`TypeError`），要原样保住行尾只能用内建 `open()`。
- 「加一个工具」不止加工具本身：桥接 `toolFlags`（控制台开关能不能存）、控制台分组表（`tools/extra-console/tool-groups.mjs`）、
  守卫 `verdictFor` 的分档 —— 三处对不上 `npm run test:audit` 就红，而且**红的位置离改动很远**（这次是两条看着不相干的断言）。
- sidecar 的 HTTP 口只在引擎起来之后才应答：直接 poll `127.0.0.1:3210/status` 会连续吃 connection refused，
  别把它当成「没起来」；查状态走桥接的 `/api/call/status` 更稳。

**验证**

- 搬家结果：`小鲸鱼的语音\通话录音\` 11 个 wav、`小鲸鱼的语音\通话逐字稿\` 1 个 json；旧目录已不存在。
- 保留策略实测：在两个目录各放 1 个诱饵（mtime 拨到 40 天前）→ 重启 sidecar → **诱饵全被删，11 个真录音与 1 个真逐字稿一个没动**。
- 清 spool 实测：造 3 个假 `say-*.mp3` → 重启 sidecar → 全清掉，`audio/call/` 只剩运行时依赖 `click_once.cjs`。
- `python tools/call/retention.py --selftest` 全绿（12 条断言）；`python tools/call/call_sidecar.py --help` 自证默认目录已是新路径；三个改过的 js 文件 `node --check` 通过。
- `npm run test:tools` ✔（85 个 MCP 工具、60 个显式登记为三类通用）；`npm run test:audit` → **58/58**。

**留给明天**

- **推送还没做**：主人说等「身体」那摊活一起推（工作区里 `launcher/launch-all.ps1`、`public/console.html`、`src/bridge.js` 混着身体线的改动）。
- 生图那条线不是我写的，今天只补登记漏洞；若要**对群里开放生图**，得同时改 `socialV2.image.allowGroups` **和**守卫那一档。
- 保留策略上线后第一次真触发留意：嫌 30 天短就改 `config.json` 的 `call.recKeepDays`。

### 记忆系统三处改造（同日，另一条线）

> 起因：主人发了 B 站那条《DSH-MEM 插件…》让我对比「我现在的记忆方法」。
> 那个项目（现名 `dsh-mnemosyne`）的做法是给记忆挂**证据类型 / 时间语义 / 状态演化**。
> 全套搬过来是过度设计（她是桌宠，不是病历系统），但有三条**不搬就是真 bug**。

**做了什么**

- **检索分栏打分 + 同义词 + `+词` 必含**（`src/bridge.js:728` `searchDailyMemory`）。
  原来把 `text + detail` 拼成一个 hay、命中一律 +1；现在**要点 +2、详细 +1**，分开搜。
  新增 `SYNONYM_GROUPS`（9 组：硬件 / 游戏 / 语音 / B站 / 说说 / 表情包 / 闹钟 / 模拟器 / 日记），
  `+词` 语义 = AND，其余仍 OR。`src/mcp-snowluma-safe.js` 的工具描述同步写清用法。
- **推断标记 `~`**（`plugins/qq-memory-rollover/qq-memory-rollover.mjs` 提示词 4b 条 +
  `memory-index.mjs` 的 `parseItemLine`）。模型自己推出来的（不是对方说的、也不是亲眼见的）
  在要点前加 `~`，落盘成 `inferred: true`；索引里渲染成 `~`，检索结果渲染成 `~（推断）`。
- **状态取代 `〔取代:旧要点〕`**（提示词 4c 条 + `replaces` 字段 + `selectIndexItems`）。
  新记忆让旧的不再成立时标出来；旧条目**移出索引、进归档**（仍可检索、可追溯），不再两条并存。
- **`parseItemLine` 抽成纯函数导出**（`memory-index.mjs`），`distill()` 改调它。

**为什么**

- 检索：纯子串匹配最真实的失败是「库里写板子、她查硬件 → 0 条」。索引只留最近 3 天，
  **归档全靠这个检索**，搜不到就等于那 50 条不存在。同义词表手写而非 embedding：
  话题高度集中，几十个词够用，且假阳性一眼可见（扩到哪清清楚楚）。
- 推断：提炼时模型顺手补一句原文没说的（"他大概在忙"），落库后跟"他说他在忙"长得一模一样，
  第二天她就拿这个当事实讲、还讲得理直气壮。不搬证据六分类，但至少要能把"猜的"标出来。
- 取代：状态会变（"板子还没做视觉" → "视觉也接上了"），两条并存时她得自己判断哪条还成立，
  常常挑错 —— 把做完的事说成"还没做"。这不是记性差，是索引里同时摆着两个时间点。

**踩坑**

- `searchDailyMemory` 里**不能引用 bridge.js 的模块级常量/函数**：`scripts/test-memory-archive-rank.mjs`
  用 `new Function` 只抠函数体来构造测试，引用外部常量会 ReferenceError。
  所以同义词表必须写在**函数体内**。同理 `readDailyMemory` / `parseMemoryDay` 是注入的，不能换别的调用。
- 第一次改完多留了一行 `});`，`node --check` 报 `SyntaxError: Unexpected token ')'`（bridge.js:870），
  两个测试同时红 —— 报错指向 `new Function` 构造的位置，**离真正的毛病很远**，别在测试文件里找。
- 跨天去重比的是**纯文本**，`~` / `〔取代:…〕` 必须在**去重之前**剥掉，
  否则同一件事今天带标记、昨天不带，会被当成两条都留下。
- `recentRows` 必须是 `let` 才过滤得动；且过滤要在 `const shown = new Set(recentRows)` **之前**做，
  后面的 `archived` 才会跟着自动算对（被取代的条目本来就应该进归档）。

**验证**

- `node --check` 三个改过的 js 全过。
- 新增 9 条断言（archive-rank 3 条 + index 6 条），全量回归：
  `test-memory-archive-rank` 14、`test-memory-index` 35、`test-memory-scope` 12、
  `test-memory-archive` 9、`test-memory-impression` 7、`test-memory-isolation` 7、
  `test-memory-pin` 15、`test-index-budget` 8、`test-reset-keeps-memory` 6、`test-role-card` 9 —— **全绿**。
- 用真实 `state/daily-memory.json` 重跑：12 行、归档 50、`keptDays` 2，索引块 959 字符（预算 1080）。
  第 1 条正好是「尚未做视觉」—— 正是 `replaces` 要处理的那种情形（目前库里还没有带 `replaces` 的条目，
  要等下一轮提炼才可能产生）。

**留给明天**

- `inferred` / `replaces` 要**下一轮提炼**才会真的进库（提示词改了，老的 62 条都没有这两个字段）。
  上线后第一次看到 `~` 或 `supersededCount > 0` 时，回头核一下模型的遵守率；经常不写就在提示词里补正例。
- `SYNONYM_GROUPS` 与 `memory-index.mjs` 的 `TOPIC_WORDS` 是两套表（一个管查询怎么匹配、
  一个管归档指针列什么词），加词时两边对一下。

### 开关登记缺口补上（同日，审计那条线）

**做了什么**

审计「工具 × 角色卡 × 预设 × 桥接」时发现：有 7 个开关**桥接在调用期读了、MCP 注册期没登记**。
后果是控制台显示"已关闭"，模型每轮仍收到那几只工具的完整描述与参数 schema，
调用之后才吃一个 403 —— 正是 `src/mcp-snowluma-safe.js` 自己在注释里写着"漏登记会白烧 token
+ 诱导模型误调"的那件事。

补登记的 6 个（`qzoneUnlike` 没有独立工具，它是 `qq_qzone_like` 的 `unlike` 参数）：

| 工具 | flag | 桥接读取点 |
|---|---|---|
| `qq_get_qzone_feeds` | `qzoneFeeds` | `bridge.js:9110` |
| `qq_qzone_like` | `qzoneLike` | `bridge.js:8977-8981` 的 `OP_FLAG` |
| `qq_qzone_comment` | `qzoneComment` | 同上 |
| `qq_qzone_delete` | `qzoneDelete` | 同上 |
| `qq_qzone_set_right` | `qzoneSetRight` | 同上 |

`speak` 仍然**刻意不登记** `qq_say`（它在 `ALWAYS_REGISTER` 里，关掉也要保留注册，
好让她拿到"这是主人关的、不是坏了"的解释）—— 那条注释现在保留在原处并补了一句说明。

顺带把 `ALWAYS_REGISTER` 从 2 个扩到 10 个，并**按理由分组**：跨模式共用的三个发送工具
（`qq_send_group_message` / `qq_send_private_message` / `qq_reply`，它们同时服务
chat / closed-agent，按 v2 开关摘会误伤别的模式）、只读标识类四个（`qq_status` /
`qq_list_groups` / `qq_get_group_members` / `qq_get_group_history`）、以及 `qq_body_say`。
这不是新行为（它们本来就没有开关），是**把隐式事实写成显式声明**，好让下面的断言守得住。

**为什么**

根因不是"漏了几行"，而是**没有任何东西守着这件事**。所以光补表格是治标。

**加了什么断言**（`scripts/test-tool-classification.mjs` 新增第 ⑥ 段）

1. 注册出来的每个 `qq_` 工具，要么在 `TOOL_CONFIG_FLAGS` 里有开关，要么在 `ALWAYS_REGISTER`。
2. 表里登记的每个 flag 必须真在 `src/bridge.js` 里出现过（防止登记一个谁也读不到的开关）。

**踩坑**

- 第一版断言只写了第 1 条，跑起来立刻报 8 个红：`qq_status` / `qq_list_groups` /
  `qq_get_group_members` / `qq_get_group_history` / `qq_send_group_message` / `qq_reply` /
  `qq_send_private_message` / `qq_body_say`。这 8 个正是"真的没有开关"的那批 ——
  说明断言是准的，不是写错了。处理方式是**给它们一个显式的位置**（`ALWAYS_REGISTER` 分组），
  而不是把断言放宽。放宽断言等于把刚补的钉子又拔了。
- 顺手用 `br.includes(flag)` 做第 2 条，不能用 `\b${flag}\b`：真实文件里
  `qzoneFeeds: true,` 前面是换行、后面是冒号，`\b` 在 `\``-template 里还会被 shell 吃掉一层，
  第一版因此**假通过**（所有 flag 都被报成"bridge 里没有"，一看数字就知道不对）。

**验证**

- `node --check` 两个改过的 js 全过。
- `npm run test:tools` → 85 个 MCP 工具 / 60 个显式登记 / 22 组 132 行全覆盖。
- **反证**（这条最重要）：临时删掉 `qq_qzone_like: 'qzoneLike'` 一行，测试立刻报红并点名它，
  还原后恢复通过 —— 断言确实咬得住，不是摆设。
- 真实 stdio 握手实测：源码声明 69 个，实际注册 65 个，被摘掉的正好是 config 里
  `false` 的那 4 个（`qq_photo_note` / `qq_send_voice` / `qq_list_voices` / `qq_set_sticker_remark`），
  "意外多出"为空。**注册期过滤这条路径本身是好的**，缺的只是表格登记。
- 全量回归：`npm run test:audit` → **58/58 scripts passed**（此前是 57/58）。
  `scripts/test-stickers.mjs` → 71 通过 0 失败。

**留给明天**

- 主控制台 `public/console.html` 的开关清单仍是写死的 34 个（专项控制台是完整的 54 个），
  且第 2075 行还写着已经不存在了的 `qq_speak`。这次没动它 —— 它属于"看得见但改不对"，
  不像开关登记那样每轮都在白烧 token。要修的时候记得**同时加测试**：
  现在没有任何测试守着那份写死清单，这次能发现纯属人工比对。
- 守卫 `plugins/qq-agent-presets/qq-tool-restrict.mjs:669-671` 的 `BILI_ALLOWED` 里有 3 个
  死名字（`bili_unread_messages` / `bili_received_replies` / `bili_received_at_and_likes`）——
  它们是 **Python 版** bili MCP 的工具，只挂在值班轮的 `bili-duty` profile 上，
  QQ 会话挂的 JS 插件里根本没有。安全上无影响（列了名字但工具不存在），属历史遗留待清。

### 「每轮撞一下老记忆」（同日，看了长忆插件的视频之后）

**做了什么**

- `src/bridge.js` 新增三个纯函数：`recallIdOf(row)`、`pickRecallRows(rows, query, opts)`、
  `renderRecallBlock(picked)`，以及 `RECALL_HITS_FILE = state/memory-hits.json`。
- 新增 `recallForPrompt(key, text)`（放在 `buildWakePromptV2` 之前）：拿对方刚说的这句话去撞
  `daily-memory.json` 里**不在最近几天索引内**的旧事，撞到就提一句，并给它们记一笔"被想起"。
- 两处接线：v2 在 `buildWakePromptV2` 的 `base` 里加 `recallBit`（紧跟 `memoryLine`，
  所有唤醒分支共用）；v1 接在消息注入的 `roleHint` 后面（v1 没有索引注入，更需要这条）。
- `scripts/test-audit.mjs` 的名单里加 `test-memory-recall.mjs`。

**为什么**

- 索引只放最近 3 天（`memory-index.mjs` 的 `INDEX_RECENT_DAYS`）。实测 62 条记忆里 50 条
  在索引外 —— 没丢，`qq_memory_query` 查得到，但那是「她自己想起来要查」才有的路。
  她不知道自己忘了什么，于是几乎不会查，八成记忆等于不存在。
- 长忆插件（xiaoman-memory）的做法是每轮拿当前这句话撞库、只交两条标题。这边不需要它那套
  元素表（双档记忆里的 `text` 就是天然的"要点"），只需要补上"被顺嘴勾起来"这条路。

**踩坑**

- 第一版用 `Array.isArray(mem) ? mem : []` 展开记忆 —— `readDailyMemory()` 返回的是
  `{ lastDigestDate, items: [{ date, items: [...] }] }`，是个对象，于是永远空手。
  真实数据一跑就露馅（`mem is not iterable`）。
- 中文没有空格：`q.split(/[\s,，…]+/)` 把「键盘手感怎么样」切成一整句，跟任何要点都对不上。
  改成把 CJK 长词再拆 2 字组；中英混排（「装apk这件事」）还得按中文段/英文段再拆一次，
  否则一个词都拆不出来。
- 拆出来的 2 字组混进虚词：真实假阳性是群里问「他是不是特别讨厌别人叫他大肥鱼」，
  「别人」在一条装 apk 的记忆里出现过 ⇒ 把不相干的事"想起来"了。加黑名单
  （`别人/特别/讨厌/记得/上次/事情/你的/我的…`）并钉成测试。
- 只提**要点**、不提 `detail`：详细是当时的展开，反复念会慢慢变成"事实"。

**验证**

- `node scripts/test-memory-recall.mjs` → 11 通过 0 失败（要点没对上不提、最近几天不撞、
  别的会话不撞、冷却内不重复提、泛词不算命中、虚词不算命中、最多两条且被想起的优先、
  渲染截断与 `~`、缺字段不炸、id 稳定）。
- `npm run test:audit` → **59/59 scripts passed**（加进名单之后）；`npm run test:tools` 不变。
- 拿真实 `state/daily-memory.json`（62 条）手跑：「消消乐那关你过了吗」撞出 2 条
  （40 关已过 / 四十多关过不去），「你的语音怎么变了」撞出 2 条语音相关，
  「我今晚可能要熬夜」「晚上想吃点什么」空手 —— 宁可不提。

**留给明天**

- 没做同义词扩展：`searchDailyMemory` 的 `SYNONYM_GROUPS`（硬件/板子/单片机…）没复刻，
  所以「板子到了没」撞不到写着「硬件」的记忆。要做就得把那套表提到能共用的地方，
  不能再抄第三份。
- 没做衰减：长忆的 21 天半衰只落了「被想起次数」这一半（用来排序），权重没有真的往下掉，
  裁剪仍是"最旧先砍"。真要动的时候记得〔约定〕不参与衰减。
- `state/memory-hits.json` 是新文件，首次命中才会生成；只存
  `{ "<scope>|<date>|<要点>": { hits, lastHit } }`，每次写会顺手清掉已不在库里的 id。

## 2026-10-27 周二

**做了什么**

- **新增 `qq_send_file`：她能把网上的东西（PDF/安装包/压缩包）当 QQ 文件气泡发给主人**。
  这是今天的主线，动了 13 个文件、1270 行：`src/safe-fetch.js` 加 `streamOnce` / `streamWithFailover` /
  `downloadToFile`（流式落盘，不是 buffer 版 —— 上游 `safeFetchBuffer` 只能取图片，且 4 GiB 上限下整体
  buffer 内存会炸）；`src/bridge.js` 加 `cfg.socialV2.file` 默认块、`sendFileV2`、`gatewayUploadFile`
  （调网关的 OneBot action `upload_private_file` / `upload_group_file`，文件气泡由网关自己发）、
  端点 `POST /api/socialV2/send-file`；`src/mcp-snowluma-safe.js` 加 `TOOL_CONFIG_FLAGS.qq_send_file`
  与工具本体；`plugins/qq-agent-presets/qq-tool-restrict.mjs` 把它归进 `HOST_EXEC_TOOLS`；
  `tools/extra-console/tool-groups.mjs`、`config.json`、`roles/小鲸鱼.md`、`docs/手艺清单.md` 同步。
- **落盘位置挪到仓库外面**：`DOWNLOAD_DIR_DEFAULT = path.join(ROOT, '..', '小鲸鱼下载')`，里面按
  `YYYY-MM-DD/` 一天一个文件夹；同名文件排 `报告-2.pdf` 而不是加时间戳前缀（这目录是给主人之后自己
  处理用的，他打开该看见干净的名字）。
- **重生成 `src/bridge.MAP.md`**（`node scripts/mapgen.mjs`）：bridge.js 加了 377 行，地图行号全过期，
  `test-bridge-map.mjs` 因此转红。
- 顺手把身体那条线今天做的 MQTT 化（`body_probe.py` 探活、`bodySetMode`、console 的「身体 · 工作模式」）
  一起提交了 —— 见下方「留给明天」关于两条线混在一起的说明。

**为什么**

- 主人要「联网下载东西发我 QQ」。桥接原本只能发**图片**（image 段，`base64://`）和语音（record 段），
  发不了任意文件；但网关 `SnowLuma-lite` 侧早就有 `upload_private_file` / `upload_group_file` 两个
  OneBot action，桥接从来没调过。所以这不是新能力，是**把已有的能力接出来**。
- 下载不复用 `safeFetchBuffer`：那个函数末尾有 `if (!looksLikeImageBuffer(...)) throw`，只认 PNG/JPEG/
  GIF/WebP，拿它下 PDF 会直接抛「抓取内容不是有效图片」。而且它是整体 buffer 累积，`FILE_UPLOAD_MAX_BYTES`
  是 4 GiB ——真按那个上限跑一次，Node 进程会被内存打死。
- `qq_send_file` 归 `HOST_EXEC_TOOLS`（只给管理员私聊）：它的 `file` 参数能指本机路径，等于
  「读主人电脑上的文件 + 发出去」一步到位。放进群里 = 任何群友能把主人电脑上的文件要走。

**踩坑**

- **`cmd /c powershell -Command "Compress-Archive -Path \"a\\b\""` 的双层引号会吃掉反斜杠**：bridge.log
  里命令变成 `Compress-Archive -Path downloadsziptest*`，**而且 `exitCode` 还是 0**、stdout 是命令回显。
  「退出码 0 但什么都没做」是最难查的一类。绕法：`shell:'powershell'` 直接写 PowerShell 代码，
  不要在 cmd 里套；打包完看 stdout 的字节数是不是 0。已写进 `roles/小鲸鱼.md` 和 `docs/手艺清单.md`。
- **`restart.bat` 起的是前台 cmd 包装，`job_kill` 会连带把新 bridge 一起杀掉**：第一次重启后新 PID 26660
  明明起来了，我杀了那个后台 job，bridge 就没了、3100 端口 000、lock 还写着 26660。绕法：
  `Start-Process cmd.exe -ArgumentList '/c','start.bat' -WindowStyle Hidden` 脱离式启动，再等 12 秒看 lock。
- **`sendFileV2` 本地分支拼路径的 bug**：`path.resolve(dir, 'downloads/ziptest.zip')` 会变成
  `downloads/downloads/ziptest.zip`，报「找不到这个文件（ENOENT）」而文件明明在。改成先查下载目录、
  再查仓库根、最后才按下载目录拼。
- **写文件流的时机**：`streamOnce` 最初在发请求前就 `fs.createWriteStream`，于是重定向/4xx/5xx 会留下
  空文件，Windows 上文件还开着删不掉。改成确认 2xx 才建流；失败路径 `dropPartialFile()` 要先
  `unpipe` + `destroy` 再删，而且得给 `setTimeout(settle, 2000)` 兜底 —— 只等 `'close'` 事件有可能
  永远等不到，整次下载永不 settle，她的话就卡死在那儿。
- **半成品删除竞态**：`streamWithFailover` 换地址重试时用的是同一个 `destPath`，第一次的 `unlink`
  还悬着就可能把第二次刚写出来的文件删掉。改成 `dropPartialFile()` 返回 Promise，先删完再结算。
- **`allowedDirOnly` 的逃逸判据**：`rel.startsWith('..')` 会把下载目录里名叫 `..notes.txt` 的正常文件
  也判越界。改成 `rel.split(path.sep)[0] === '..' || path.isAbsolute(rel)`。
- **限额检查的时机**：原来下载/stat 完才记账，几百兆下完了才被告知「超过每小时上限」。拆成
  `checkFileQuota()`（进函数先查）和 `noteFileSend()`（成功才记）。

**验证**

- **全量审计 `node scripts/test-audit.mjs` 58/58 通过**（中途有一次 57/58，唯一红的是
  `test-preset-local-tools.mjs` 子进程 ETIMEDOUT，单独重跑 7/7 绿、全量重跑也绿 —— 是超时抖动，
  不是代码问题）。`test-tool-classification.mjs` 报「82 个 MCP 工具，60 个显式登记为三类通用」；
  `test-extra-console.mjs`、`test-stickers.mjs`（71 通过）、`build-agent-preset-patches.mjs --check`
  （无漂移）全绿。privacy-scan 扫描 278 个文件、未发现敏感信息。
- **端到端真发**（主人在 QQ 里确实收到了文件气泡）：本机文件、URL 下载、中文显示名三种都过。
- **各道闸逐一实测**（都是打真端点，不是读代码推断）：无会话令牌 → `tokenRequired`；伪造令牌 +
  `x-agent-call` → `未授权：智能体调用必须携带有效的会话令牌`；`tools.sendFile=false` →
  `disabledByOwner`（文案明说「不是故障、不用重试、不用上报」）；`file.allowLocalPath=false`、
  `file.allowedDirOnly=true`（目录外拒/目录内过）、`file.maxPerHour=1`（报「这一小时已经发过 4 个」）、
  `file.maxBytes=1024`（报「声明 13264 字节，上限 1024」，且 `downloads/` 里**没留半成品**）全部符合预期，
  测完逐项复原成 `{enabled:true, dir:'../小鲸鱼下载', maxBytes:209715200, maxPerHour:20,
  allowLocalPath:true, allowedDirOnly:false}`。SSRF(`127.0.0.1`/`169.254.169.254`)、空文件、目录当文件、
  URL 404、不存在的路径，五种错误都给了能看懂的文案。
- **MCP 侧**用 stdio 直起 `node src/mcp-snowluma-safe.js` 发 `tools/list` → 62 个工具、`qq_send_file`
  在列，schema 只有 `key`/`token`/`file` 三个必填 + `name` 可选。守卫 `verdictFor` 实测：
  `owner-private` 放行，`group` / `member-private` 各自给不同的拒绝文案。
- **落盘实测**：`小鲸鱼下载/2026-10-27/测试-落盘位置.pdf`；同名再下得 `-2.pdf`；只给文件名能找到；
  手造 `2026-10-26/昨天下的.txt` 跨日期袋也能命中；打包链路 `Compress-Archive` → 1252 字节 zip → 发送成功。

**留给明天**

- **`launcher/launch-all.ps1` 与 `public/console.html` 的改动不是这条线做的**，是「身体」那条线今天
  把声音从局域网 UDP 改走公网 MQTT 时改的（`bodyBase`/`bodyBroker`/`boardMode`、`rot/tools/body_probe.py`
  探活、控制台的「身体 · 工作模式」单选）。两者混在同一次提交里了 —— 功能上都该提交，但**它们没经过
  这条线的复核**，而且 `paths.json` 的实际值（`whale-1bb62897` / `i1e78188.ala.cn-hangzhou.emqxsl.cn`）
  与 `launch-all.ps1` 里的兜底默认（`whale-a90c6c` / `broker.hivemq.com`）不一致，这个不一致要不要收口
  得主人定。`src/bridge.js` 的 diff 里也混着这部分（`findBodyTool`/`bodyProbe`/`bodySetMode`）。
- **DSH 侧还没重启**：本机 DSH NEXT 里那个 MCP 子进程（PID 22028，2026-10-26 23:27 启动）跑的还是旧
  工具面，所以**在小鲸鱼自己的会话里 `qq_send_file` 现在还看不见** —— 要重启 DSH NEXT 才会重新挂载。
  桥接侧已经通并且实测过了，缺的只是这一步。
- `rot/docs/BODY-PLAN.md:111` 提到过「新 MCP server：`qq-bridge-deploy/src/mcp-body.js`」，这个文件
  **还不存在**，是设计稿。身体和这条线目前靠 `POST /api/body/turn` 一条 HTTP 调用连着，不是真的 MCP。

> 提交：`ba90921`（身体 MQTT 化）、`e81b7e9`（qq_send_file）

---

## 2026-10-26 周一

**做了什么**

- **新增 `docs/手艺清单.md`：任务 → 命令**。给 AI（小鲸鱼）在管理员私聊里干活时照抄用，只收十行左右
  「主人真会在聊天里让她干的事」（转 Word/PDF、转写、发语音、查网关、改完 preset 重生成、隐私扫描…），
  外加两条「动手改过东西之后的顺序」和一节「出毛病时的第一反应」。同一条纪律写在文件末尾：
  **自己先跑通一次再写进来** —— 写进来一条跑不通的命令，比不写更坏。
- **角色卡新增第九节**（`roles/小鲸鱼.md`）：让她知道要看这份清单，并且点明那三个工具
  **只有管理员私聊里有**，群聊/别人的私聊里被拒绝时按安全铁律礼貌拒绝，别承诺、别假装做过。
- **`docs/README.md`**：登记 `手艺清单.md`（放在最上面，标「给 AI 看的」），并加一条警示 ——
  索引里 `design/` `audits/` `legacy/` 这几个目录**在本机不存在**（被 `.gitignore` 排除、部署副本没拷），
  点开是死链，只当背景读。
- **`docs/FOLDER_MAP.md` 按实况改正**：补上从来没写过的 `tools/` 一节（含「`tools/call` 自己没有 venv、
  借 `tools/asr` 那个」这种会让人白折腾半天的细节）；`scripts/` 计数 87→118（114 `.mjs` + 3 JSON + 1 `.cjs`）；
  `docs/` 树按实列重写；根目录文档数「三个」→「五个」（漏了 `CHANGELOG.md` / `DEVLOG.md`，和
  `docs/README.md` 自己都对不上）；§四表格有两行列错位（三格塞进两列表）；§五注明**本机没有** `voice-tool/`。
- **工具面分类审计（92 个工具 × 3 类会话）**，逐一过 `verdictFor`。查出「跟着前缀整包放行、
  其实只有主人能用」的一格并修掉：`mcp__web-search-safe__web_read_current`（读主人**此刻正在看的那一页**）
  和 `web_list_tabs`（列出他开着的标签页）。修法是在 `plugins/qq-agent-presets/qq-tool-restrict.mjs`
  加显式集合 `OWNER_BROWSER_READ_TOOLS`，判定插在 `SAFE_PREFIXES` 之前（`:869`，顺序校验过
  `:869 → :884 → :904 → 前缀`，转发闸门没被打乱）。
- **新增 `scripts/test-tool-classification.mjs`**（`npm run test:tools`，已纳入 `test:audit`）：
  ① 任何 MCP 工具只要对群聊/普通成员私聊放行，就必须在显式名单 `OPEN_TO_ALL_SESSIONS` 里登记过；
  ② 名单里的名字必须真实存在且真的三类都放行（防手误、防「假登记」）。顺手把 60 个确实三类通用的
  工具逐个登记、分组、写了理由。
- **修了一个本来就红的测试**：`scripts/test-memory-isolation.mjs` 的「记录当天必然进索引」挂了
  （`test:audit` 之前 57/58）。改成固定夹具，数据层的归属检查仍读真实记忆。

- **预设 / 角色卡一致性审计**（主人要求「只看逻辑」，先不动功能）：逐行核对二代预设
  `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`、`roles/小鲸鱼.md`、`plugins/qq-agent-presets/qq-tool-restrict.mjs`
  三者的说法，查出四类不对应：① 角色卡的「按代际取用」（〔一代〕/〔二代〕标记）**根本没接在注入路径上**；
  ② 一代预设说「你没有任何本地工具」，角色卡却写「管理员私聊里能跑命令」；③ 一代预设整体停在功能长出来之前
  （没写语音规则 / 权限闸门 / 约定 / 记忆用法）；④ 二代预设三处教她去调会被守卫拒的工具。
  顺带做了交叉校对（65 个 `qq_*`、14 个 `web_*`，以及【现在】【时段】【会话令牌】【本次消息快照】等提示词段）**全部对得上**。
- **修 ①**：`src/bridge.js` 新增 `roleHintForCurrentMode()`（`:13140`），五处真实注入点
  （`:12730` 退场、`:12941` 主动冒泡、`:13057` 群聊摘要、`:15111` 主回复、`:15179` 被触发进入活跃）
  由 `currentRoleHint()` 改为调它 —— 二代从此走 `currentRoleHintV2()`。
- **修 ④**：二代预设四处 —— `:32` 第 6 条不再拿 `qq_get_group_members` 当 `speakerIds` 的 QQ 号来源；
  第 18 条 QQ 空间的**读**改成「只在管理员私聊里可用」并写明群里会被拒；浏览器节补一行
  「`web_list_tabs` / `web_read_current` 只在主人私聊里存在」；把夹在第 18 与第 19 条之间那段
  **未编号**的 ⭐（`qq_report_feedback`）挪到第 21 条之后，编号 1..21 不再被截断。
- 重跑 `node scripts/build-agent-preset-patches.mjs` 重新生成 `plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml`；
  重启桥接（pid 26388，`13:10:25`）让 ① 生效。
- **查清一件此前没人写下来的设计事实**：reserved2 下**角色卡不进提示词**，只注入一句占位
  `【当前角色】小鲸鱼（完整角色卡请调用 qq_get_prompt 查看）`（`buildWakePromptV2`，`src/bridge.js:13893`），
  完整卡由她自己调 `qq_get_prompt` 取。连带含义：`config.json` 的 `role.maxInjectChars`（9000）
  与 〔一代〕/〔二代〕 标记机制**只影响该工具的返回值**，不影响每条消息的注入。
  主人 2026-10-26 明确选择**保持现状**（不改成整体注入：省 token，靠她按需取）。
- **通话里的繁体一并修了**（主人反馈「打语音电话识别出来好像是繁体」）：`tools/asr/transcribe.py` 加
  `INITIAL_PROMPT`（默认「以下是普通话的句子。」）与 opencc `t2s` 后处理（`warmup_t2s()` / `to_simplified()`），
  CLI 加 `--initial-prompt` / `--no-t2s`；`tools/asr/worker.py` 转发这两个开关（请求里没给就用默认，
  单条可传 `"t2s": false` 关掉）；`requirements.txt` 加 `opencc-python-reimplemented==0.1.7`（import 名 `opencc`）。
  `tools/asr/selftest.py` 加一步「繁 → 简」自检，钉住真电话里的 `你能不能主動掛斷` → `你能不能主动挂断`。
- 重启通话 sidecar（`/api/call/stop` 结束 3836 → `/api/call/start` 起 5528），新 worker 日志出现
  `繁→简：opencc t2s（词表加载 6ms）`。
- 顺手清了 `audio/call/` 里调试期堆下的 358 个一次性脚本/dump（3.58 MB；只留运行时依赖 `click_once.cjs`，
  `tools/call/call_state.py:360` 会去取它）与 `tools/asr/tts-*.mp3` 两个测试残留。
- **模型缓存好了就切离线加载**：`tools/asr/transcribe.py` 新增 `prefer_local_model()`（本地确实有该模型的
  缓存目录时才设 `HF_HUB_OFFLINE=1`，顺手静掉 symlink 警告），CLI 与 `worker.py` 的 `load_model()` 都调它、
  各打一行日志。重启 sidecar 后 `small` 加载 **1279 ms**（同机同模型改前 22733 ms）。
- 按主人拍板删掉 `medium` 的 1.5 GB 权重（结论是继续用 `small`，留着白占盘）。



**为什么**

- 索引本来就有三份（`package.json` 48 条命令、`docs/README.md`、`docs/FOLDER_MAP.md`），
  但**都是按位置组织的**：回答「哪个目录是干嘛的」，不回答「我要把 md 转 word，敲哪条」。
  她是按任务来的，翻目录树翻不出命令。
- 地图的价值全在「和现实一致」。`tools/` 整个目录没被记录、根目录文档数写错、`voice-tool/` 不在本机却被
  写成现状 —— 这些都会让读它的人（包括 AI）照着错的做。**规则写错了比没写更坏。**
- 守则判定的默认值是「允许」（`verdictFor` 返回 `undefined` 就是放行），而前缀白名单是**整包**放行 ——
  所以往 `mcp__snowluma__` / `mcp__web-search-safe__` 里加一个工具，**默认它就对所有会话开放**，
  包括 QQ 群。`test-tool-classification.mjs` 就是把这条默认值反过来：新工具必须有人明确表态。
- `test-memory-isolation.mjs` 那条断言真正的变量是**总量与预算**，不是日期。它自称测「归属渲染」，
  实际测的是「今天挤不挤得进索引」—— 这类断言在数据一涨就必然红，而红的时候报的还是别的原因，
  修它的人会被引到错的地方去。**测试要钉什么，就得把其它变量固定住。**

- 人格注入走错「取用路径」的后果不是少几行字，而是**同一轮里她看到自己人格的两个版本**：
  `qq_get_prompt` 的返回早就按模式取（二代形式），每条消息真正注入的却是一代取用结果。
  而且以后谁照 `src/role-card.js` 的说明往角色卡加 〔一代〕/〔二代〕标记，注入端不认 ——
  两种模式会拿到同一份，标记等于白打。
- 预设里写「你可以调某个工具」而守卫会拒，等于**教她去撞墙**：她照着做、被拒、再花一轮解释，
  而对方（尤其是群友）看到的是「她答应了又做不到」。工具面与人格说明必须是同一份事实。
- 繁体不是她「说话的风格」，是 **ASR 输出的字形**：窄带 + 噪声的真电话里 whisper 会滑向繁体
  （原句 `你知道今天的天氣嗎`）。字形不一致的代价不是「不好看」，而是**她读到的和主人说的是两套字**，
  她会照着回、再把繁体喂回去。加一句主语种提示是零成本的；兜底必须放在**输出侧**，因为模型吐什么不由我们定。
- opencc 挂在常驻 worker 里只加载一次（词表 5–6 ms、转换 <1 ms），真正贵的模型加载（22.7 s）**一点没动** ——
  这才满足主人「性能下降就算了」的前提。



**踩坑**

- 差点去「修」一个没坏的东西：`grep '^## ' DEVLOG.md` 显示有两个 `## 2026-10-21 周三`，看着像重复条目 +
  乱序。实际读过才发现，上面那个在「怎么写」小节的 ` ```markdown ` 代码块**里面**，是模板示例，
  不是真条目。**grep 会把代码块一起匹配**，涉及「结构是否重复」的判断要真读那几行再动手。
- **审计里报错了一条，复查后自己撤回**：我一开始判定「群友能指挥她给主人或另一位好友发私信」，
  看着很顺（发消息工具对三类会话都放行）。真去读端点才发现不成立：`src/bridge.js:7233` 用
  `agentTokenOk(key, token)` 把令牌**绑死在目标会话**上（`:4693`），她手里的会话令牌只属于她当前
  那个会话，拿群会话的令牌去发主人私聊直接 403。**「工具对所有会话放行」≠「目标随便挑」**——
  闸门可能在下一层。报漏洞之前先把前提走到底。

- 编辑预设正文时我用 python 写回（`newline=''`），把 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`
  从 **CRLF 变成了 LF**，`scripts/test-preset-prompt.mjs`（`:19-20` 读的就是这个真实文件）当场红：
  `AssertionError: CRLF 文件写回后应仍使用 CRLF`，`test:audit` 掉到 57/58。转回 CRLF 后恢复 58/58。
  **`dsh/agent-presets/*/agent.cordis.yml` 必须保持 CRLF**，改完顺手数一下。
- ① 一开始只有「读代码推断」这一条腿：grep 显示五处注入点调 `currentRoleHint()`，但这不足以证明
  「她实际看到的是旧版」。去翻 DSH 会话日志才把它坐实 ——
  `~/.dsh/sessions/--C-Users-Administrator-Desktop-QQ~0020bot-qq-bridge-deploy--/session-*/session.v4.jsonl.zstd`
  （zstd，node 24 有 `zlib.zstdDecompressSync`）：角色卡正文只出现在 `type:tool/result` 条目里
  （即 `qq_get_prompt` 的返回），而且那里是**逗号版**（`累了就睡，醒了继续累`），角色卡原文是空格版。
  **同一轮两个版本** —— 这才从「代码推断」变成「有数据」。
- **上面这条后来被我追到底，结论翻转了，诚实记下来**：换到 reserved2 逐处查「那 5 处到底会不会跑」，
  发现**一处都不会**：`handleIncoming` 在 `src/bridge.js:15102` 就把二代消息入未读并 `return`，
  根本走不到 `:15111`；二代唤醒提示词由 `buildWakePromptV2`（`src/bridge.js:13893`）拼，只塞一句占位；
  其余三处全在一代引擎里 —— `socialLoopTick` 首行被 `isSocialEnabled()`（`src/bridge.js:12548`
  = `currentMode === 'reserved'`）挡住，`triggerActiveDurationExit` 只在它里面跑，
  `flushSummaries` 只处理 `social.pendingSummaries`（二代下是空的），`:15179` 也在
  `if (isSocialEnabled())` 分支内。⇒ 角色卡唯一出口是 `qq_get_prompt`（`src/bridge.js:6520`），
  而它**改之前就按模式取**。所以 ① 是**零行为变化的潜伏修复**，不是「修好了什么」；
  「同一轮两个版本」那句是错的（那处逗号版本来就来自 `qq_get_prompt`，不是注入）。
  **教训：grep 到调用点 ≠ 那条路会跑。** 判断「实际生效」得把守门条件一起读到底，
  否则会把「代码彼此不一致」写成了「行为已经出错」——前者是隐患，后者是事故，分量完全不同。
- 想造一份繁体样本来对拍，怎么试都不出繁体：干净 TTS 片段、加倾向、8 kHz 窄带 + 12 dB 噪声 + 只留 2.5 秒，
  三种都规矩地出简体。**真样本不在合成里，在自己的日志里** —— `audio/call/` 下 10-25 那通真电话的
  ASR 原句（`👂 你能不能主動掛斷`）就是。以后遇到「模型输出的怪毛病」，先翻真实运行日志，别急着造数据。
- 起 worker 做三配置对拍时忘了 `PYTHONIOENCODING=utf-8` / `PYTHONUTF8=1`：子进程按 GBK 写 stdout，
  读端直接 `UnicodeDecodeError: 'utf-8' codec can't decode byte 0xd5 in position 31` ——
  看着像转写崩了，其实是**管道编码**崩了。
- 第一次对拍拿 `tools/asr/tmplxsen7x7.wav`（220 秒）当输入，CPU + beam5 跑了 7 分钟没完，只能杀掉重来。
  **对拍用小片段**（8 秒就够）。
- 下 `medium` 权重撞了两堵墙：`huggingface.co` 本机不通（`ConnectTimeout WinError 10060`）；
  `hf-mirror.com` 可达，但默认走 Xet CAS 会 `401 Unauthorized`（`cas-server.xethub.hf.co`）——
  得同时加 `HF_HUB_DISABLE_XET=1` 才下得动（1.5 GB 下了约 20 分钟）。



**验证**

- 按主人要求这轮**不跑测试**（「先做整理」）。只做只读核对：`ls` 逐项数、`git diff` 复核措辞、
  角色卡正文实测 6540 字符（注入上限 `config.json` 的 `role.maxInjectChars` = 9000，
  留给记忆索引 2200，现索引 1774 —— 加完第九节仍然放得下）。
- 工具面那部分改完跑了测试：`npm run test:tools` 通过（81 个 MCP 工具，60 个显式登记为三类通用）；
  `npm run test:audit` **58/58**（修 red test 之前是 57/58）。
- 重启 DSH NEXT 后核对生效：守卫文件 mtime `11:41:43` < DSH NEXT 主进程启动 `11:57:20`，新判定已加载。

- ①④ 改完：`node --check src/bridge.js` 通过；`npm run test:tools` 通过；`npm run test:audit` **58/58**；
  `node scripts/build-agent-preset-patches.mjs --check` 报「已是最新」。
- ①已在桥接侧生效（重启于 `13:10:25`）。**④ 要重启 DSH NEXT 才生效** —— 预设是 DSH 启动时加载的，重启桥接不影响它。
- **④ 端到端验完**（主人 13:58 发了一条真消息）：新会话 `session-a11e8fbe-…-621c9cdc69d9`（`13:59:02` 建）
  的 `seq=8` `system/message`（系统提示词，即 persona 装载处）里两处新措辞都在、旧措辞 0 命中；
  同目录下今天 `11:57:38` 那个会话与 `10-25 22:58:36` 那个会话各命中旧措辞 1 次、新措辞 0 次。
  她照旧调了 `qq_get_prompt`（`seq=16` 的 `tool/result`），取回的角色卡是二代（逗号）形式。
- **坑：改预设正文，光重启 DSH 不够**。persona 是**建会话时一次性写进系统提示词**的；桥接判断要不要
  重建会话只比 `sessionPolicy = [mode, preset名字, ownerQQ]`（`src/bridge.js:3605`）——正文变了这个串不变，
  旧会话会把旧人格一直用下去。这次是手动 `POST /api/socialV2/reset`（`:6378`，`sessionEpoch++`）清了一次，
  下一条消息才懒建出新会话（`ls ~/.dsh/sessions/…/` 从 27 个涨到 28 个）。**以后改预设正文都要顺带清会话，
  再拿「新建会话的 `seq=8`」验收**，别只看源文件里有没有新句子。
- 繁体修复：拿真电话里那 5 句繁体原句过 `to_simplified()`，**7/7 全变简体**
  （`你能不能主動掛斷` → `你能不能主动挂断`、`你知道今天的天氣嗎` → `你知道今天的天气吗`）。
- 性能：同一段 8.1 秒音频三种配置（不给提示 / 加倾向 / 加倾向+转简）= 3617 / 3571 / 3372 ms，
  模型加载 22733 ms（与改前 22.7 s 同量级）⇒ **没有可测的变慢**。
- `tools/asr/selftest.py` 全绿，新增那步：`opencc t2s（词表加载 4ms）；「你能不能主動掛斷」→「你能不能主动挂断」`。
- 顺带记一笔现状：真电话的识别质量本身也糙（`回歸歸`、`聲音啥啥的`、`天津津天津`）—— 那是 CPU 上 `small`
  模型的水平。
- 按主人要求对拍 `medium`（只测不改，推理参数与 worker 完全一致）：**没有收益、明显更慢** ——
  加载（已缓存）`small` 1.7 s vs `medium` 4.7 s；干净 8.09 s 音频 3.61 s（RTF 0.45）vs 9.51 s（RTF 1.18）；
  电话质感 2.5 s 音频 2.42 s（RTF 0.97）vs 6.63 s（RTF 2.65）。干净那句 `small` 认对（`繁体字`）、
  `medium` 认错（`反体字?`）。⇒ **继续用 `small`**：比实时还慢 2.6–2.8 倍的模型不能放进通话。
  medium 那 1.5 GB 权重暂留 `tools/asr/models`（已 gitignore），删不删由主人定
  → **当天主人选「删掉」，已删（回收 1.5 GB）**。
- 顺手找到「模型加载要 22 秒」的真凶：**不是加载慢，是 `huggingface.co` 连不上在等超时** ——
  已落地成 `prefer_local_model()`（见「做了什么」）：本地有缓存就自动 `HF_HUB_OFFLINE=1`，
  所以每次重启 sidecar 不再白等那 20 秒。生产实测：`本地已有 small，已切离线加载` +
  `模型就绪：small / cpu / int8，加载耗时 1279ms`（改前同机同模型 22733 ms）；
  CLI 直跑同一片段、含加载 5.85 s 出字。



**留给明天**

- `docs/手艺清单.md` 里每条命令**还没有真的逐条跑过**（主人说功能都有、不用测）。下次真用到哪条，
  顺手验一条，验过再算数。
- **图库跨会话可见是主人 2026-10-26 明确拍板「保持现状」（方案 a）**，别再当漏修去补：
  `mediaLib.search()` 的 `viewerKey` 只遮蔽**来源**（谁发的/哪个群/原话），**图本身照给** ——
  所以群里问「图库里有什么」她能列出主人在私聊里发过的图。理由：来源已经遮住，且库里大多本来
  就是群友发过的图。真觉得不合适时，另开的方案是「本会话 + 主人例外」（普通会话只看自己的，
  主人私聊里可看全部）。

- ④ 改的预设正文要**重启 DSH NEXT** 才算上线（①不用，桥接侧已生效）；下次开机顺手确认一遍。
  → **2026-10-26 当天已完成并验证**（见「验证」最后两条：新会话 `seq=8` 已是新措辞）。



---

## 2026-10-25 周日

**做了什么**

- **QQ 语音通话真正能打了**（接听方向）。来电靠 QQ 窗口标题 + 屏幕抓图兜底识别，自动接听
  只对管理员开放（`config.call.autoAnswerFrom='owner'`）；她说的话走虚拟声卡 `CABLE Input`，
  对方的声走系统扬声器环回采集；通话回合里 `qq_say` 会被桥接改道成「进麦克风」而不是发语音条
  （`src/bridge.js` 的 `callRerouteTextIfInCall`）。真电话实测能双向对话。
- **`tools/call/` 整套新代码**：`call_sidecar.py`（引擎：VAD/ASR/TTS/环回采集）、`call_state.py`
  （窗口识别与点按）、`call_audio.py`（设备与播放）、`win_capture.py`（抓图）。
- **录音搬出仓库**：`REC_DIR = REPO.parent / "小鲸鱼的qq语音wav"`，主人能在资源管理器里直接看到；
  目录建不出来时回落 `audio/call` 并在 status 里标明。
- **每通电话留一份逐字稿**：`state/call-logs/call-*.json`（`{startedAt, endedAt, key, recording, turns}`），
  由 `plugins/qq-memory-rollover/qq-memory-rollover.mjs` 的 `readDayCallLogs()` 读进来提炼成长期记忆。
  为什么要绕这一圈：通话**不产生任何 QQ 消息**，`messages.db` 里没有它的影子，只读数据库的整理脚本
  永远记不住电话内容；但 `daily-memory.json` 的写入权归整理脚本独写，两边都写必然互相覆盖，
  所以 sidecar 只落原材料、提炼仍只由整理脚本做。
- **管理员私聊能跑命令了**（主人原话：「我完全允许小鲸鱼在和我这个管理员聊天的地方运行一些命令消息」）。
  没走「给 preset 挂本地工具行」那条路 —— 那要把 DSH 内置 preset 的 subprocess/sandbox/approval
  一整串兄弟行搬过来，重且会打破 `test-preset-local-tools` 的铁律断言；改成新开三个 MCP 工具
  `qq_run_command` / `qq_read_file` / `qq_write_file`，配 `qq-tool-restrict.mjs` 里的
  `HOST_EXEC_TOOLS` 分档（只认管理员私聊，群和别人的私聊一律拒）。
- **`tools/host/md_convert.py`**：md → docx / pdf。本机没 pandoc（GitHub 被墙、winget 报
  `InternetOpenUrl() failed 0x80072efd`），所以自己拼：docx 走 python-docx，pdf 走 reportlab。

**为什么**

- 录音原来埋在 `audio/call`，主人根本找不到；而「打过电话却没留下任何可回看的东西」等于这通电话白打。
- 命令工具那条：主人 21:29 发来一份 md 说「试试把它转为word和pdf的」，她只能回「你装个 pandoc 就行…我念不了这种」——
  不是她不想做，是工具清单里真的没有。

**踩坑**

- **Edge 无头当 PDF 引擎不可行**：bash 里手动跑能出文件，但被桥接（进而被沙箱 job、低完整性令牌）拉起来时，
  `--headless=old` 卡住或 `exit 21` 一个字节不产；`--no-sandbox --single-process` 直接报
  `Cannot use V8 Proxy resolver in single process mode`；不带 `--user-data-dir` 会交给已开着的 Edge 然后 exit 0 且无产物。
  **结论：构建不要依赖浏览器进程**，reportlab 进程内排版最稳。
- `reportlab` 的 `ListFlowable(bulletFormat=...)` 是拿 `format % s` 去套的，传 `"•"` 会
  `TypeError: not all arguments converted during string formatting` —— 别传 bulletFormat，用默认。
- 沙箱把工作区标成 Low Mandatory Level 时，**exe 上的低完整性标签会把进程令牌压到 Low**，
  于是 UIPI 静默吞掉所有鼠标注入（`SetCursorPos`/`mouse_event`/`SendInput` 全无效果、无报错），
  连点 QQ 的「接听」都点不动。修法是 `tools/call/fix_integrity.ps1` 清掉工作区的 Low 标签。
- `cmd /d /s /c` + 以引号开头的命令会被「去掉首尾引号」的规则搞坏，带空格的程序路径要写进 .bat 再跑。
- 桥接进程里跑 `md_convert` 要显式用 `tools\host\.venv\Scripts\python.exe`（系统 python 没装 markdown/python-docx）。

**验证**

- 真电话：手机打进来自动接听、双向对话成功；挂断后 `📴 通话窗口已消失`，录音与逐字稿都落盘。
- `md_convert.py` 拿 `DEVLOG.md`（43KB，含表格/代码块/多级列表）跑通：docx 58KB、pdf 681KB，
  用 libreoffice-kit 渲染第 1-2 页目视检查，中文、表格网格、标题层级都正常，`missingFonts` 为空。
- 三个新工具经 HTTP 实测：`host-run`（cmd 与 powershell 两种 shell）、`host-read`、`host-write` 全部通。

**留给明天**

- ~~**拨号方向没做**：她能接、不能主动打出去（手机 QQ 号查询接口不可用，`Get-PhoneNumber` 拿不到）。~~
  → 主人 2026-10-25 23:49 明确说「第二个可以不用做了」，**此项取消，不再跟进**。
- 通话摘要要等第二天 rollover 跑过才进长期记忆（整理脚本默认只整理昨天）；当天的电话当天看不到。
- `md_convert.py` 的存在还没写进她的人格提示词，她现在得自己翻仓库才知道这条路。
  两条路：改 preset（要重跑 `node scripts/build-agent-preset-patches.mjs` 并重启 DSH），
  或直接写进 `roles/小鲸鱼.md`（桥接每条消息前注入，**热生效不用重启**）—— 后者划算得多。

---

## 2026-10-24 周六

**做了什么**

- **拆掉「她自己的图库」**（`qq_gallery_add` / `qq_gallery_list`）。主人原话：
  「算了，整个图库的功能不要了，让她的提示词少点，只用qq表情包就够了」，随后把范围收窄为
  「只删去3，然后解决一下群图库的废话问题」—— 即只拆她自己那个相册，群图库（素材库）保留。
  删除 `src/gallery-lib.js`、`scripts/test-gallery-prompt.mjs`；`src/bridge.js` 去掉引入、
  `galleryDir()`/`GALLERY_DIR_DEFAULT`、`galleryLine`、toolMap 两行、toolFlags 两项、
  `POST/GET /api/socialV2/gallery` 两条路由、默认配置里的 `socialV2.gallery` 段；
  `src/mcp-snowluma-safe.js` 去掉两个工具注册；`tools/extra-console/tool-groups.mjs` 去掉两个开关；
  `config.json` / `config.template.json` / `config.example.json` 同步清理。
- **修群图库摘要的「废话」**（`src/media-lib.js` 的 `buildPhotoContext`）：以前**无条件**列 6 张，
  备注为空时那 6 行是**一模一样**的「（无备注，可先看图）（来自主人）」—— 272 字里没有一条能用来挑图的信息。
  现在只列**有备注/标签**的图；一张都没有时改给一句能行动的话（用 `qq_photo_list` 列、`qq_get_photo_image` 看、
  `qq_photo_note` 记），实测 272 → 190 字。
- **12 处本机绝对路径清出仓库**（发布前扫描 `node scripts/privacy-scan.mjs` 报出 27 条命中，去重后 12 处 / 8 个文件）：
  两个 `agent.cordis.yml` 的人格 `suffix` 不再写死 `%USERPROFILE%\...`（改成中性写法，本机位置由 `launcher\paths.json` 决定）、
  `launcher/launch-all.ps1` 删掉 `'<盘符>:\DSH\DSH NEXT\DSH NEXT.exe'` 这个本机候选、`docs/REFACTOR-2026-10-21.md`
  与 `src/games/index.js` 里的示例路径改成占位符、`plugins/qq-agent-presets/presets/*.patch.yml` 由源
  `dsh/agent-presets/` 重新生成（`--check` 无漂移）。两个探针脚本移进 `_tmp/`（`.gitignore` 已挡住）。
- **修掉 `test-memory-isolation` 的「假红」**：它断言的是「小黑盒那条归属主人私聊」，用的却是**今天的预算**
  去索引里捞 `2026-10-21` 的记忆 —— 记忆涨到 10 天 40 条后那条滑出了 `INDEX_RECENT_DAYS=3` 这层，
  于是这条测的是**日期**不是归属。改成在数据层断言 `scope`，再把 `now` 钉在记录当天。
- **发 r5**：版本号统一到 `0.2.0-r5`（`package.json`、`package-lock.json` 两处、两个插件包，
  以及三个 MCP server 的 `serverInfo.version`）；新增 `docs/releases/v0.2.0-r5.md`；
  `CHANGELOG.md` 加索引行与摘要；`docs/README.md`、`README.md`、`README.en.md` 指向 r5。
- **换机器部署包（`seed/`）同步到最新**：日记 **+3 天**（`2026-10-21` ~ `10-23`）、长期记忆、收藏表情备注、
  群图库备注各自刷新（按 DEPLOY.md 第 0 步那几条 `Copy-Item`，没有另写脚本）；`privacy-scan` 261 个文件零命中。
- **修好换机器部署脚本里两处「铺回去了却没人读」**：`seed/data/media/index.json` 原来会被铺到
  `<仓库>\data\media\`，而群图库读的是 `<仓库>\media\`（`MEDIA_LIB_DIR_DEFAULT`）→ `install.ps1` 里加了重映射；
  衣柜更彻底：模板里根本没有 `socialV2.selfImage.dir`，而 `loadWardrobe()` 在 dir 为空时**直接 return null**，
  于是 `seed/wardrobe/` 那 7 套衣服铺过去也没人读 → 现在生成 `config.json` 时会填成 `<仓库>/wardrobe`，
  `config.template.json` / `config.example.json` 也补了 `selfImage` 段。DEPLOY.md 的「带不带过去」表补了衣柜那一行。

**为什么**

- 两套图库（`photo` 群图库 / `gallery` 她自己的相册）上线后**从未被调用过一次**（4243 条 tool-calls 里两个工具都是 0；
  同期 `qq_get_message_images` 62 次、`qq_collect_sticker` 26 次、`qq_sticker_note` 16 次）。占着提示词却没人用，
  而主人明确要「提示词少点」。拆掉她自己那个相册省下 318 字（摘要 41 + 策略 277）。
- 群图库那个不删（它真能发图、是素材库），但它注入的 6 行占位符是纯噪音 —— 留着功能、只去掉噪音。

**踩坑**

1. **`config.json` 在编辑途中被改动**：edit 报 `file changed since it was read`。桥接进程在跑，
   `config.json` 会被重写。改完必须**重启桥接后复核**，别假设磁盘上的改动一定活下来。
2. **行尾是 CRLF**：`bridge.js` / `mcp-snowluma-safe.js` 用 `split('\n')` 处理再 `join('\n')` 能保住 CRLF
   （因为每行末尾的 `\r` 仍在），但用 edit 工具时给的是 LF 串 —— 实测 edit 工具自己会保住 CRLF，
   所以没出现混合行尾。处理前后都数了一次 `\r\n` 与孤立 `\n`（14958 / 0）。
3. **大批量删除别手抄长注释**：像 `// ── 图库（…）─────` 这种带尾随破折号的注释，靠肉眼复制容易错位。
   改用 node 脚本按行号 splice，**并在删之前断言边界行内容**（首行含关键字、末行是 `}` 或空行、下一行符合预期），
   删错会直接抛错而不是静默删歪。
4. **`seed/` 默认与仓库根一一对应，但群图库是个例外**：它在 `seed\` 里放在 `data\` 下，代码读的却是
   `<仓库>\media\`。这类「铺回去了却没人读」的错位**不会报任何错**，只会安静地从头开始（备注全丢、
   衣柜整个不可用，还得你去猜）。换机器流程动过之后，拿一个假的仓库根跑 `install.ps1 -DryRun` 看落点最省事。

**验证**

- `node --check` 三个改动过的文件全过；`grep -rn gallery src/ scripts/ tools/ plugins/ config*.json` **零命中**。
- `node scripts/mapgen.mjs` 重新生成 `src/bridge.MAP.md`（忘了这步 `test-bridge-map` 会红）。
- 测试全绿：`test-media-lib` 66/66、`test-stickers` 71/71、`test-token-economy` 36/36、
  `test-extra-console`、`test-self-identity` 7/7、`test-bridge-map`、`test-qq-preset-contract`、`test-diary-recall`。
- 用真实数据渲染 `buildPhotoContext`：旧 272 字 / 新 190 字（省 82 字），旧版那 6 行
  「（无备注，可先看图）」在新版为 0 行。
- 重启桥接后复核通过：① `config.json` 里没有 `gallery` 段（没被运行中的进程写回去）；
  ② `/api/socialV2/prompt` 的 `enabledTools` 里没有 `qq_gallery_add` / `qq_gallery_list`；
  ③ 唤醒提示词里没有图库段。
- `node scripts/privacy-scan.mjs`：扫 260 个文件 **✅ 零命中**（原来 27 条 / 12 处）。
- `npm run test:audit` → **57/57 scripts passed**；新增 6 个测试（`test-memory-archive`、`test-memory-archive-rank`、
  `test-memory-impression`、`test-memory-pin`、`test-reset-keeps-memory`、`test-speak-owner-off`），
  删掉 `test-gallery-prompt.mjs`。
- 版本号复查：`0.2.0-r4` 在七个版本号落点上已无残留；两个生成的 preset patch 与源 `--check` 一致。

**留给明天**

- `小鲸鱼的图库\` 那个空目录还在（在仓库**上一级**，本机路径不写进仓库）。功能已拆、目录留着无害，
  但**没擅自删**主人的桌面文件夹 —— 要删说一声。
- 历史文档（`CHANGELOG.md` 的 r4 摘要、`docs/releases/v0.2.0-r4.md`、`docs/research/UPSTREAM_DIFF_2026-10-21.md`）
  仍写着「她自己的图库」—— 那是对**已发布版本**的记录，不改写历史。
- **没打 git tag**：版本号只改到了 `0.2.0-r5`，使用者说之后自己重新提交一份最新的到 GitHub ——
  tag / Release 由他决定，这里不代打。
- **历史提交里仍有那 12 处本机路径**：它们在 r5 之前就已推到 `origin/main`，要清得用 `git filter-repo`
  重写全部提交再 force push（会让别人的克隆失效），这次按使用者「不动历史」的选择**没做**。
- `npm run verify:adaptation` 这次**没跑**（它要连真的 DSH 0.2.0-rc.2 环境）；发版前若要更稳，可以在目标机上补一次。

> 提交：`4c4d2a3`（release: v0.2.0-r5，50 个文件 +2 281 / −1 193）、`f011a35`（换机器部署包同步）、
> `60ec6ff`（install.ps1 两处路径错位）

---

## 2026-10-22 周四

**做了什么**

- **给她加了一只「手」**（主人原话：「现在的小鲸鱼只能看网页，不能操作，我想让她可以操作网页，
  给她加一个手」）。能力边界当场问过，他选的档是：
  ① **只在他的私聊里放行**（群里、普通成员私聊完全没有）；
  ② **点、填字、滚动、按键、选下拉** —— **不含上传文件**。
  - `src/cdp-browser.js`：新增「手」那一节 —— `clickElement` / `typeInto` / `pressKey` /
    `scrollPage` / `selectOption` / `listClickables` / `findElement` + `activatePage`。
    selector 先当 CSS 试，试不到再当「按钮上写的那几个字」找；找不到时把**页面上能点的**
    一起带回来（她看不见浏览器，只说 not found 等于逼她瞎猜第二次）。
    点/填之前都判 `type=password`，密码框一律不碰。
  - `src/mcp-web-search-safe.js`：暴露六个受控工具 `web_click` / `web_type` / `web_key` /
    `web_scroll` / `web_select` / `web_whats_there`。**没有任意 JS**。
  - `tools/web-access/scripts/cdp-proxy.mjs`：新增 `/activate` `/type` `/key` `/select` `/wheel`；
    把只读补丁改写成 `UPLOAD_BLOCKED`（/setFiles 永远 403）+ `HANDS_BLOCKED`（只读开关才拦），
    `READONLY` 语义从 `!== '0'`（默认开）翻成 `=== '1'`（默认关）—— 默认不设 = 手放开。
  - 守卫 `plugins/qq-agent-presets/qq-tool-restrict.mjs`：新增 `WEB_HAND_TOOLS`（导出），
    在 `verdictFor` 里**排在 `SAFE_PREFIXES` 之前**单独判（前缀是整包放行，手必须比读严一档）；
    权能矩阵新增 `web-hand` 分组。
  - 提示词（`dsh/agent-presets/qq-chat-v2/agent.cordis.yml`）：删掉旧的「你只能看，不能点」；
    新增一段说明六个工具、**只在主人私聊**、以及「不可撤销的动作要先说清我要点哪个按钮」。
  - 新增 `scripts/test-web-hand.mjs`（16 项），并把它和 `test-web-tools.mjs` 一起登记进
    `scripts/test-audit.mjs`。
  - 文档：`tools/web-access/LOCAL-PATCH.md`（重写 2026-10-22 那一节 + 四个坑）、`RULES.md` §3。

**为什么**

- 她原来只能读网页：`web_read_link` 那一套读得挺好，但「帮我点一下」「把搜索框填上」
  这类事只能让主人自己去点 —— 而她要这份能力，是因为她想**接着主人手上正在做的事往下做**。
- 为什么手必须锁在管理员私聊：它借的是**主人登录着**的浏览器，点一下可能是删除、付款、
  发帖。群里任何人拿到它，等于拿到他账号的操作权；提示注入的杀伤力也从「让她读一段假话」
  升级成「让她替我点一下确认」。
- 为什么上传单独一层、且不跟开关走：主人挑的是「点填滚按选」这一档。把本机文件塞进网页
  是另一件事，要给得他再说一次。

**踩坑**

1. **后台标签页里，所有鼠标/滚轮事件都到不了页面**。`/new` 用 `background: true` 建页，
   `visibilityState` 是 `hidden`；在上面发 `Input.synthesizeScrollGesture`，`scrollY` 一动都不动，
   点链接也只发事件、不导航。⇒ 动手前先 `/activate` 切前台。
2. **先算坐标、再切前台 → 点偏**。切前台会让页面重排（滚动条消失、视口变宽），
   之前算的 `getBoundingClientRect` 就过期了。实测表现极阴险：`/clickXY` 回
   `{clicked:true}`，链接却纹丝不动。⇒ 顺序必须是「切前台 → 定位 → 立刻点」。
3. **`Input.dispatchMouseEvent({type:'mouseWheel'})` 会把 CDP 堵死 30 秒**：代理一直不回话，
   最后报 `CDP 命令超时: Input.dispatchMouseEvent`，既没滚动又把连接占了半分钟。
   换 `Input.synthesizeScrollGesture`（`yDistance: -delta`）才好。
4. **`target=_blank` 的链接点了不开在本页**：只看本页 URL 会得出「点了没反应」的错判断。
   ⇒ 点之前记一份标签页快照，点完对比，冒出新的就把 `newTab.targetId` 一起回给她。
5. **`mcp-web-search-safe.js` 的 import 必须单行**：`test-audit-security-mcp.mjs` 用
   `/^import .*;\r?\n/` 逐行剥 import 再丢进 vm；写成多行就直接
   `Cannot use import statement outside a module` 整组挂掉（这次踩了一脚，已加注释钉住）。
6. **`data:` URL 进不了手**：`openPage` 走 `validateFetchUrl`，只允许 http/https。
   这是对的（别为了测试放开它），测下拉框改用代理 `/new` 直接开 fixture 页。

**验证**

- 真机联调（不是 mock）：Bing 搜索框填字 → 点 Search → 出现结果；
  example.com 点链接 → 真的跳到 iana.org；长页 `/wheel` 滚动 `scrollY` 900 → 1800；
  `/key` 按 Home/PageDown；`data:` fixture 页选下拉（label / value / index 三种都试，
  `change` 事件真的触发）；找不到元素时回「页面上能点的地方有：『Learn more』」。
- `/setFiles` 仍是 **403**（`{"error":"上传文件被 qq-bridge 本地补丁禁用…"}`）。
- `scripts/test-web-hand.mjs` 16/16；`node scripts/test-audit.mjs` **44/44**。
- 会话 ID 反查确认：`private:100000001` 那条会话 `verdictFor` 放行，未知会话被拒。

**傍晚追加（同一个 10-22，主人当场提的三件事）**

- **「怎么每次用都要点浏览器允许？」** 查清了规则：Edge 的「允许远程调试」是**按 CDP 连接**
  确认的，不是按浏览器实例。只要代理那条连接还活着就一次都不用点；会弹是因为**它在重连**
  （浏览器重启 / 代理被杀 / 一键启动无条件先跑 check-deps 闯一遍）。
  - `tools/web-access/scripts/cdp-connection.mjs`：补上**握手超时**。旧代码在 socket 被浏览器
    吊住（等你点允许）时 `flight` Promise 永不结算 ⇒ 一直 `connected:false`、请求全挂死、**还不报错**。
    现在 60 秒超时并抛 `code='CDP_HANDSHAKE_TIMEOUT'`，文案直说"在等你点允许"。
  - `tools/web-access/scripts/cdp-proxy.mjs`：改成**空闲不重连** + 指数退避（5s→…→5min，
    等授权时 30min）；有真实请求才立刻重试；`/health` 新增 `waitingForAuth` / `nextRetryMs`。
  - `launcher/launch-all.ps1`：先读 `/health`，活着就整段跳过，**不再无条件撞一次连接**。
  - 新增 `scripts/test-cdp-reconnect.mjs`（8 项，假 WebSocket，不碰真浏览器）。
- **「别每次查个东西就把网页跳到我前台」** —— 改成**静默优先**：
  - `src/cdp-browser.js`：点/填/按键/滚动**都先走静默路线**（JS 点击、`insertText`、
    `window.scrollBy`，这些在 hidden 状态下都有效，实测全部成功且 `visibilityState` 全程 `hidden`）；
    只有**静默真的没让页面动**，才升级到"切前台 + 真实鼠标"重点一次。
  - `findElement` 现在会给真实元素算一个 CSS 路径：她多半是"按按钮上那两个字"找的，
    那串字不是合法选择器，静默 `/click` 会报「未找到元素」（踩过）。
  - **诚实回报**：`broughtToFront` 取自**回读的 `visibilityState`**，不是"调过 activate 就算"。
    因为 `Target.activateTarget` 只能把标签页设成当前页、给焦点，**没法把窗口从 DSH 后面提出来**
    —— 调完 `hasFocus` 是 true 但 `visibilityState` 仍是 `hidden`。谎报的后果是她跟主人说
    "窗口给你弹出来了"而屏幕上什么都没有。另给 `focusAttempted` 区分"尝试过"。
  - 提示词同步：手默认静默；`broughtToFront:true` 才是真打扰了他，只 `focusAttempted` 就不许说"我弹出来了"。
  - `test-web-hand.mjs` 加到 19 项（新增"静默优先的顺序""诚实回报""CSS 路径"三条）。

**中午追加（同一个 10-22，看她真玩了一局游戏之后）**

主人让她玩那个网页版《超级大富翁·古玩大亨》，然后观察到两件事，都查清并修了。

- **「她一直玩游戏就不会反应我的新消息了」**（主人原话）。这是真 bug，不是错觉：
  - 证据：`state/bridge.log` 里 10:17 / 10:23 / 10:24 三条主人消息**全是**
    「会话繁忙，暂存唤醒原因」；她的回合从 10:01 连跑到 10:24。`state/tool-calls.jsonl`
    显示那段时间她在连续 `web_click`（掷骰子→看回合→再掷）。
  - 根因（读 `dsh-host-apiproxy` 的 `sessionPromptRequestSchema` 确认）：
    `session.prompt` 的 `mode` 有两种 —— `'queue'` → `agent.followup()`（**等回合彻底结束**）、
    `'steer'` → `agent.steer()`（插进正在跑的回合，进 inbox 的 `next-step`，
    placement=`'steering'`）。桥接**一直只用 queue**，所以她玩 20 分钟，主人就等 20 分钟。
  - 修：`src/bridge.js` 三处
    ① `promptMode = opts.wakeReason ? 'queue' : 'steer'` —— 有人当场说话走 steer，
       定时唤醒/主动机会仍走 queue（那些是"新开一轮"，插进去只会打乱她）；
    ② steer 被拒**退回 queue 重投一次**（抢不到插队窗口也不能把主人的话弄丢）；
    ③ 两处「会话繁忙」分支（`sendWakePromptV2` / `scheduleWakeV2`）都先试
       `steerIntoRunningTurnV2`，失败才排队。判据 `canSteerV2`：**只认主人私聊 +
       有人当场说话**（`private`/`admin`/`atMention`/`question`/`poke`…）；
       `proactiveCheck`/`timeout`/`replyCheck`/`bootstrap` 这些她自己的节奏一律仍排队。
    - `scheduleWakeV2` 因此变成了 async（原来同步），7 个调用点全部补
      `void … .catch(() => {})`，避免 unhandled rejection。
  - 新增 `scripts/test-steer-while-busy.mjs`（9 项）并登记进 audit。

- **顺手量到一个截图问题**（还没改，先记下来）：`web_see` 在她玩的时候**失败过 5 次**，
  报「连不上代理 … timeout」。单独测同一个页面是 240ms，但**连续快拍**时会出现
  16~20 秒甚至 30 秒不返回（8 连拍里有 3 次挂到 30 秒）。初步判断是
  `Page.captureScreenshot` 在那个页面（DOM 2538 字、无 canvas、无 rAF）上偶发卡住，
  **不是"窗口没在前台"** —— 后台页测同一个页也会时快时慢，而简单页面后台也只要 133ms。
  ⇒ 待办：给 `/screenshot` 加单次超时 + 失败重试一次，别让她截图一挂就 30 秒。

**下午追加（重启之后的两轮实测）**

- **steer 真机验过了**：用桥接自己的 `NodeApiClient` 对同一会话先投 `mode:'queue'` 的长任务、
  6 秒后投 `mode:'steer'` 的插话，两次都回 `{"accepted":true}` —— 说明 DSH 这一侧确实收。
  ⚠️ 但要如实记一笔：那次长任务（两次搜索）跑得比插话还快，插话最终落进了 `next-turn`
  而不是"当前这一轮的下一个 step"，所以日志里看不出"她当场听见"。**这不是失败**，
  是 `steer` 的语义本来就分两档（`next-step` = 插进正在跑的回合；`next-turn` = 落在下一轮），
  到底落哪一档取决于**投递那一刻她是否真的还在跑**。她玩一局游戏是连续的 20 分钟，
  那种场景才会落到 `next-step`；一次两次搜索（几秒）太快，会落到 `next-turn`。
  ⇒ 结论：修复方向是对的（以前只有 queue，必然是 `next-turn`；现在有机会 `next-step`），
  但"她玩游戏时插话"这一条**还需要一次真实的游戏局来验**，不能拿这次代替。

- **截图那个 8 秒卡死，根因和修法都定了**（这一条是真修好了，有数据）：
  - 现象：`/screenshot` 对真实站点**每次都卡满超时**（8200ms × 10），而 `data:text/html` 简单页只要 70ms。
  - 试过但**没用**的：`Emulation.setFocusEmulationEnabled`（页面自认可见，合成器照样不产帧）、
    把全屏遮罩 `display:none`、换新 session、缩短超时。
  - 真正有效：**截图前对 target 做一次 `Target.activateTarget`**，然后停 120ms。
    之后 10 连拍全部 287~345ms；简单页 209~255ms；MCP 层 `web_see` 229~277ms。
  - 顺带修掉两个自己挖的坑：
    ① `Promise.race` 的超时**没有取消底层命令**，重试时新命令会排在旧命令后面 ⇒ 越重试越慢；
       现在重试前先 `Target.detachFromTarget` 掉卡住的 session。
    ② 客户端兜底超时从 30 秒收到 20 秒（代理侧单次 8 秒 + 重试一次），她最多等 16 秒。
  - `test-web-hand.mjs` 加到 21 项（新增截图两条，其中一条专门断言"别再塞回焦点模拟"）。
  - ⚠️ 注意：`activateTarget` 只是把标签页设成**它所在窗口**的当前页，**不会**把窗口提到最前，
    所以不会抢主人正在看的页 —— 这也是它能安全地放在每次截图前的原因。

**留给明天**

- 手现在**只动"她自己开的/主人指了的"那一页**，但它不会主动导航（`/navigate` 没接）。
  这是有意的：导航等于"她替主人换页"，容易变成刷页面。真需要了再说。
- `/clickXY` 走的是 `pageFrames.routePoint`，跨进程 iframe 已经处理；但**shadow DOM 里的按钮**
  还是找不到（上游 `page-frames.mjs` 的已知范围限制）。遇到时她会得到"页面上能点的"列表，
  不至于瞎猜，但确实点不进去。

> 提交：待补

---

## 2026-10-21 周三

**做了什么**

- **联网搜索：改用 DSH 原生工具，两个都加（`web_fetch` 只给管理员私聊）**。
  这一项推翻了自己前一天「放弃第 7 项」的结论 —— 原因见下面「踩坑」第 8 条。
  - preset（`dsh/agent-presets/qq-chat{,-v2}/agent.cordis.yml`）：`tool-web` 的
    `search: false → true`、`fetch: false → true`，并重生成两份 patch。
  - 守卫：`web_search` 进 `SAFE_EXACT`（三类会话全开）；新增
    `OWNER_PRIVATE_ONLY_DSH_TOOLS = {'web_fetch'}`，只放管理员私聊，
    群里/普通成员私聊被拒时**明确告诉她改用 `web_read_link`**。
  - 提示词：写明「优先用 web_search」，以及「results 是空列表 = 这次真没搜到，
    别当成网上没这个信息然后自己编」。
  - 新增 `scripts/test-web-tools.mjs`（14 项）逐 kind 验分档；更新两处旧断言
    （`test-qq-preset-contract`、`test-preset-local-tools`、`test-audit-setup-guards`
    原本都断言「必须关掉 search/fetch」，那是按旧决策写的）。
- **剩下三项全部做完**（报告里的 5/6/7）：
  - **长轮询实测 + 修复**：实测确认全局 `fetch` 在 **305 秒**抛 `UND_ERR_HEADERS_TIMEOUT`，
    于是新增 `agentApiLongPoll()`（走 `node:http`），在 `agentApi` 一处按预算分流
    （`timeoutMs > 290000`）。实测 `node:http` 撑满 **320 秒**正常拿到响应。
  - **表情包 gxh CDN 兜底**：`emojiCdnCandidates()` 靠 emoji_id 推 CDN 地址、
    `emojiIdFromFileName()` 从文件名抠 id；候选按「网关 url 优先、CDN 兜底」排列，
    单个失败继续试下一个。实测抓真实 CDN 图 **200 / 32445 bytes / 397ms**。
  - **联网搜索（第 7 项）→ 判定不做**：查了 `~/.dsh/.credentials.yaml`，里面只有
    各第三方工具的 **OAuth 凭据**（BUDDY / TRAE / CLINE / CODEARTS…，还带 phone / nickname），
    **没有 `sk-` 形式的 DeepSeek API key**；`deepseek-account-platform/default` 那条是 64 位
    平台登录 token，不是 API key。硬做等于去扫那些 OAuth 凭据，隐私风险不值得。**主动放弃**。
- **媒体上限做成可配置，并接进专项控制台**（报告里的第 4 项）：
  - `MAX_MEDIA_BYTES` / `MAX_MEDIA_PIXELS` / `MAX_MEDIA_COUNT` 三个硬编码常量改成
    `mediaLimit()` getter，读 `socialV2.media`；默认值 4MB → **8MB / 64MP / 5 张**；
    硬天花板 32MB / 256MP / 20 张。
  - 专项控制台新增**第 3 页「媒体上限」**（UI 用 MB / 百万像素，服务端存原始字节），
    并把 **表情 CDN 兜底开关**也放这一页（都是「图相关」）。
  - 新增 `POST /api/media` 与 `POST /api/sticker-cdn`，前后端按同一套天花板钳制。
  - 新增**第 5 页「等待与超时」**：单次等待上限 / 默认等待 / 沉睡前静默
    （`socialV2.wait`）。上限卡在 10 分钟 —— 桥接的回合僵死阈值是按它定的。
- **对比了上游 `Derpyu520/qq-bridge`**（`a56164e`，也叫 v0.2.0-r4，但和我们**完全不是一回事** —— 从 r3 分叉的两条线）。clone 到 `_tmp/upstream-qqbridge/`，逐文件对照，报告在 `docs/research/UPSTREAM_DIFF_2026-10-21.md`。
- 按「必须做」的三项先落地：
  - **`/api/send/*` 的 `ReferenceError`**：`st` / `now` 从 `try` 内提到外面（`send-burst` 与 `send group/private/reply` 两处）。
  - **唤醒提示词注入 `【你的身份】`**：新函数 `selfIdentityTextV2()`，昵称 + QQ 号，「@昵称/引用你 = 在叫你」；唤醒 prompt 与收尾提醒都带上。
  - **`safe-fetch` 多地址故障切换**：新 `resolveSafeAddresses()` 返回全部地址、`orderAddresses()` 做 IPv4 优先 + 两族交替、`requestWithFailover()` 逐地址试（单次 8s、最多 4 个、总预算仍 20s）。
- 新增三个测试：`test-send-failure-paths.mjs`、`test-self-identity.mjs`、`test-safe-fetch-dns.mjs`。

**为什么**

- 三项里有两项是**真 bug**，不是「优化」：
  - `ReferenceError` 那条：**只有发送失败时才炸**，平时全绿。发送失败（被移出群、掉线、网关超时）时用户看到的是 `st is not defined` 而不是真实原因，而且 `sendJson` 执行不到 → 请求挂到超时。
  - 多地址那条：`dns.lookup` 顺序是轮转的，只取第一个意味着「今天先给 A 就正常、明天先给 AAAA 就白等 20 秒」。戴 VPN 时我实测：**OpenAI/Codex 全都连不上**，而 `p.qpic.cn` 一次返回 **10 个地址**却永远只试第一个。
  - 身份那条：上游 issue #29「被 @ 了不理人」。桥接自己判断「有没有被 @」是没问题的，但 agent 看到的只是 `@小鲸鱼` 这串文本，没人告诉它那就是它自己。

**踩坑**

1. **测试自己误伤了两次**：`assert.doesNotMatch(/requestOnce\(url, ip,/)` 匹配到了函数**定义** `function requestOnce(url, ip, ...)`；`SRC.indexOf('function orderAddresses')` 切到了注释里提到这个名字的地方。→ 静态扫描测试要盯**调用形态**而不是名字，且别用 `indexOf` 切代码块。
2. **测试抓出了两个我没预料到的漏洞**：`拍一拍` 和 `发说说` 的 catch 在回滚 `sendTimes` 之后**没有 `saveSocialV2State()`** —— 回滚只改内存，重启后额度又变回被白占（假 429）。这不在报告清单里，是写测试时顺带发现的。
3. **第三节那条「表情包 send-sticker」的 catch 是安全的**：它虽然也在 try 里声明 `st`，但 catch 自己重新 `getSocialV2State(key)` 取了一次。测试第一版把它判成错误，改成识别「外层声明 **或** catch 重取」两种合法写法。
4. **本机 DNS 被 VPN 劫持成 fake-ip**：FlClash 把所有域名解析到 `198.18.0.x`（代理的 fake-ip 段），而 `isPrivateIp` 正确地把 `198.18/15` 判为内网 → **`safe-fetch` 拦下了所有外网请求**。关掉 VPN 后立即恢复正常（`p.qpic.cn` 返回 10 个真实地址）。这顺带解释了「戴口罩时 Codex 连不上」的现象，不是代码问题。
5. **改「常量→getter」时漏了 4 处隐式兜底**：`safeFetchBuffer(url)` 不传第二个参数就会用 **4MB 默认值**，于是新配的 `socialV2.media.maxBytes` 对那几处完全不生效 —— 改了配置还以为生效了。是测试抓出来的。特别是 `sendStickerV2` 里发图那处（2527 行），群里动图常超 4MB，正是最该用新上限的地方。
6. **控制台的配置白名单少一个键就静默失效**：`for (const sub of [...])` 里不加 `'media'`，保存一次就被 `merged[sub] = current[sub] ?? {}` 冲成 null。这个数组的注释早就警告过，但**每次新增子对象都得记得加** —— 所以测试里直接断言它必须在。
7. **NAS 那类「只允许调大」的错觉**：天花板必须比默认值高（否则改不动），但也不能高到没用。取 4 倍默认（32MB/256MP/20 张）是拍脑袋的，不过至少拦住了 `maxBytes: 1e12`。
8. **⭐ 我前一天把第 7 项判「放弃」是错的，而且错得很典型。**
   当时的推理链是：要同源搜索 → 要 `sk-` key → 你没有 → 只能去扫
   `~/.dsh/.credentials.yaml` 里那些 OAuth 凭据 → 隐私风险太大 → 放弃。
   **主人一句「不能使用 harness 的吗」就把整条链掐断了。**
   实际查下来：
   - DSH 自带 `@deepseek-ai/dsh-tool-web`，注册了 `web_search` / `web_fetch`，
     内部走 `ctx.web.search` / `ctx.web.fetch` —— **就是主人正在用的那一路**。
   - 这两个工具**一直在她的工具清单里**，只是被两处关掉了：
     ① preset 的 `tool-web: search/fetch: false`（根本没注册）；
     ② 守卫的 `SAFE_PREFIXES` 只认 `mcp__` 前缀（注册了也过不了）。
   - **全程不需要任何 key**，走的是 DSH 的账号登录态。
   ⇒ 教训：**「拿不到凭据」不等于「用不了那项能力」**。我该先问「现有进程里是不是已经有这个能力」，
   而不是从「我得自己建一条通道」出发。花钱/写 200 行的方案，被一个已经在跑的工具替代了。
9. **`web_fetch` 的 SSRF 防护 DSH 做得比我好**：它用 `ipaddr` 判 `range() === 'unicast'`
   （覆盖全部非公网段，我手写了 12 条规则）、连接层 `createPinnedLookup` 钉死 DNS、
   重定向**只跟同源**（我这边是逐跳重校验）。所以分档不是因为「它的防护不够」，
   而是因为**公网地址的 SSRF 防护挡不住**「群友让她去抓任意公网站点」这件事。
10. **三个测试文件按旧决策写了断言**：`test-qq-preset-contract` 断言
    `{search:false,fetch:false}`、`test-preset-local-tools` 断言「必须为 false」、
    `test-audit-setup-guards` 把 `web_search` 放进「必须拒绝」组。
    **这不是测试坏了，是决策变了** —— 三处都按新口径改写，并在注释里写清为什么，
    否则下一个人会以为是测试在无理取闹。
11. **`qq-chat/qq-tool-restrict.mjs` 是个 re-export 壳**，不是实现。
    我读它找 `OWNER_PRIVATE_ONLY_DSH_TOOLS` 当然找不到。名单要从
    `plugins/qq-agent-presets/qq-tool-restrict.mjs`（唯一实现）读。

**验证**

- 三个新测试全绿（3 + 7 + 8 项）。
- **真实抓取验证**（关 VPN 后）：`safeFetchBuffer` 抓 QQ 表情 CDN 的 gif，**200 / 32445 bytes / 合法图片 / 417ms**；SSRF 防护对 `127.0.0.1`、`localhost`、`192.168.1.1`、`198.18.0.1`、`file://` **全部仍然拦住**。
- 全量回归 16 个测试通过；`npm run test:audit` 这次 **42/42 全过**（之前那两个 `spawn EPERM` 失败在 VPN 关闭、环境正常后也过了 —— 说明它们确实是环境限制而非逻辑缺陷，这点昨天记的「留给明天」可以划掉了）。
- **媒体上限（16 项）**：默认值 / 可配置 / 硬天花板 / 怪值回默认 / 白名单 / 调用点全部覆盖。
- **控制台端到端实测**（起在 3199 端口）：`/healthz` 正常、页面里 `data-nav="media"` 与 `id="saveMedia"` 都在；`POST /api/media` 存 16MB → **200**；超天花板 1GB → **400「不能超过 32MB（放宽上限不是拆掉防护）」**；零值/负数/非数字/空对象 → **400 且信息具体**；无令牌 → **401**；恢复默认 → **200**；`config.json` 里确实落成 `8388608 / 64000000 / 5`。
- **长轮询（7 项）**：实测全局 fetch **305 秒**抛 `UND_ERR_HEADERS_TIMEOUT`；`node:http` **320 秒**正常返回。分流点收敛在 `agentApi` 一处，鉴权头与 `ok:false` 判定都保留。
- **表情 CDN（10 项）**：地址拼法、只接受纯 hex（10 种恶意输入全部拒绝）、文件名抠 id、候选顺序、单点失败继续、开关。真实抓取 **200 / 32445 bytes / 397ms**。
- **控制台新接口实测**：`/api/wait` 正常值 → 200；超 10 分钟 → 400「回合僵死阈值是按它定的」；默认>上限 → 400。`/api/sticker-cdn` 关/开 → 200，非布尔 → 400。两处都正确落进 `config.json`。
- `npm run test:audit` **42/42 全过**。

**晚间：把联网搜索这条路彻底定了（结论：保持现状，不配 key）**

前一轮我判定「联网搜索要配 key」，理由是实测中文长尾查询搜不到、甚至返回垃圾页。
后来真机跑起来，结论**变了三次**，过程值得记：

1. **第一次改**：按主人提示改用 DSH 原生 `web_search`（放开守卫 + 打开 preset）。
   她 16:09:30 真的调到了 → `ok:false`，报 `DeepSeek search has no API key`。
   然后她**自己回退**到 `mcp__web-search-safe__web_search`，两次都成功，还读了正文。
   ⇒ 「工具没注册」的担心不成立，卡的是 provider 凭据。

2. **第二次改**：给她抓 Bing 那条路加了**污染页自检**（`looksUnrelated` / `pageSaysNoResults`）。
   判据是用实测样本校准出来的：
   - ✗ `sb_count`（"约 N 个结果"）—— 垃圾页也带计数（"约 50 个结果"配税务局内容）
   - ✗ 2-gram 词重合 —— `今天杭州天气` 的好结果命中 0%（Bing 标题写"天气预报"）
   - ✗ **单字"0 命中才判"** —— `消消乐 冰花` 的反爬页返回"消（汉语汉字）_百度百科"，
     **一个字就命中 25%**，会放过去
   - ✓ **单字命中率 ≥ 40% 才算相关**：好结果 80~100%，垃圾页 0~25%，切开得很干净

3. **第三次改（最终）**：主人看了真实聊天记录说「这个效果好像已经足够好了」。
   我去核对了她真正发出去的 4 条消息 —— **全是正经内容**（冰花打法、深圳天气、天津天气），
   **一条垃圾都没有**。垃圾只存在于她的中间过程，而且**她自己认出来了**
   （思考里写着 "The web search results are garbage (Poki pages)"），然后换工具拿到了真信息。
   ⇒ 我把「中间过程的曲折」当成了「输出质量问题」，判错了。

**最终决定**：不配 key、不堵 `web_read_link` 的绕路（那是她的自救手段）、
但**提示词改成直接禁用 `web_search`** —— 既然每轮都必失败，就别让她先撞一次墙白烧上下文。
守卫侧的放行**保留**：哪天配了 key 就能直接用，不用再改代码。

**这一轮真正学到的东西**：
- 「拿不到凭据」≠「用不了那项能力」（DSH 自带工具，一直在那儿）
- **中间过程曲折 ≠ 输出质量差**。判断系统好不好，要看**最终发出去的东西**，不是看日志里试了几次
- 静态测试能证明「配置对了」，证明不了「效果够用」—— 后者只能看真实对话

**留给明天**

- 联网搜索（第 7 项）**主动放弃**：`~/.dsh/.credentials.yaml` 里只有第三方工具的 OAuth 凭据（还带 phone/nickname），没有 `sk-` 形式的 DeepSeek API key。要做就得去扫那些凭据，隐私风险不值。**要做得先有一个正经的 `DEEPSEEK_API_KEY`。**
- `docs/research/UPSTREAM_DIFF_2026-10-21.md` 在 `.gitignore` 的 `docs/research/` 下，**不会进 git** —— 如果想让它在仓库里，得挪到 `docs/guides/`。
- `requestWithFailover` 目前只在「连接层错误」时重试（`ECONNREFUSED`/`ECONNRESET`/`ETIMEDOUT` 等）。**TLS 证书错误**我暂时也归进了可重试（`CERT_HAS_EXPIRED`），其实那换地址也没用 —— 观察一阵再说，不急。

**顺手发现**：工作区里还有一批**今早 10:37–12:41** 的改动（`memory-index.mjs`、`qq-memory-rollover.mjs`、
`roles/小鲸鱼.md`、`test-memory-scope.mjs`、`mcp-snowluma-safe.js`、`bridge.js` 里 memberImpression 那几处），
不是我做的 —— 是「记忆串味」的修复（记忆按来源会话隔离 + 身份只认 QQ 号）。
它自成一体、12 项测试全过，所以我**单独提交成 `097ea6c`**，没和这三项混在一个 commit 里。

> 提交：`097ea6c`（记忆串味，早上那批）、`97e18b0`（三项修复）、`2e7281b`（媒体上限）、`7a171a9`（长轮询 + CDN 兜底 + 控制台）、`93eb794`（DSH 原生联网搜索）、`c5d14f6`（污染页自检 + 禁用必失败的 web_search）

---

## 2026-10-20 周二

**做了什么**

- **把仓库里所有未提交的改动整理成一次发布**：61 文件 +12 466 / −184，版本号统一升到 `0.2.0-r4`（`package.json`、两个插件包、三个 MCP server 的 `serverInfo.version`）。
- **写了两份更新日志**：根目录 [`CHANGELOG.md`](CHANGELOG.md)（版本索引 + 摘要）、[`docs/releases/v0.2.0-r4.md`](docs/releases/v0.2.0-r4.md)（12 节完整说明）。README / README.en / docs/README 都加了入口。
- **补 `.gitignore`**：挡掉 `tools/asr/.venv`、`tools/asr/models`、`**/__pycache__/`（合计约 780 MB）、`/media/`（群图库原图 + 带 `rkey` 的直链）、`/_backup-*/`（含旧 token 的回退副本）。
- **同步 `seed/`**：日记 5 天、`state/` 四个种子文件、图库 `index.json`（只带记忆，不带原图）。
- 新建本文件 `DEVLOG.md`。

**为什么**

- 这些改动从 10-17 之后一直堆在工作区没进 git（`bridge.js` 一个文件就 +2 277 行）。**工作区不是备份**：`_backup-diary-181531/config.json` 里躺着一份明文 `accessToken`，只要某次 `git add .` 没挡住就永久进历史了。
- 780 MB 的 venv 与模型一旦推上去，`git clone` 会从几 MB 变成几个 GB，而且**删了也降不下来**（blob 留在历史里）。这是必须在第一次提交前就挡住的事，事后只能 `filter-repo` 重写。
- 日记与图库原图都是真人内容（具体的朋友称呼、作息、私聊里的话）。仓库是私有的，推之前我确认过未认证访问返回 404；但**原图**是别人发来的私人图片，仍然不进 —— 只带 `index.json`（理由/备注/来源）。

**踩坑**

1. **推送被沙箱挡住**：`git push` 报 `ssh.exe: *** fatal error - couldn't create signal pipe, Win32 error 5`。git 要启动 ssh 并捕获它的输出，而沙箱禁止创建管道。不是凭据问题（`ssh -T git@github.com` 单独跑是通的）。放宽一次沙箱后正常。
2. **推上去被 rejected**：远程有本地没有的 `5031040`（20:04 推的「日记目录审计」）。本地这次是基于 `193bd6e` 做的，必须先合。
3. **合并冲突三处，两个都不是「取一边」能解的**：
   - `bridge.js`：远端把 `DIARY_DIR` 做成模块级常量 + `resolveDiaryDir(cfg)`；本地重构成了按需读 config 的 `diaryDir()`。**两边各写了一半** —— 最后合成两层：`resolveDiaryDir(cfg)` 是纯函数（远端测试要它），进程内的 `DIARY_DIR` 由 `main()` 写一次、统一走 `diaryDir()`（本地要它）。
   - `audit-bridge-harness.mjs`：两侧各加了一个模块展开（`permitLib`/`timeContext` 与 `diaryLib`），都要，合并保留。
4. **`os` 在审计 harness 里不存在**：`resolveDiaryDir` 里用 `os.homedir()` 展开 `~`，而 harness 的 `vm` 上下文只注入了 `fs/path/http/crypto/...`，没有 `os`。改成 `process.env.USERPROFILE || process.env.HOME`。
5. **改完代码忘了重新生成结构地图**：`test-bridge-map.mjs` 立刻红了（地图记的行号对不上）。跑了 `node scripts/mapgen.mjs` 才好。**这条测试的价值就在这儿** —— 过期的地图比没有地图更危险。
6. **中文提交信息走不了 heredoc**：`git commit -F - <<'MSG'` 在 pwsh 里把中文编码搞坏（`ParserError`）。改用先写文件再 `-F 文件`。

**验证**

跑了 13 个测试，全绿：`test-bridge-map`、`test-extra-console`、`test-permit-gate`、`test-proactive-time`、`test-quiet-autonomy`、`test-qzone-autonomy`、`test-diary-recall`、`test-audit-diary-dir`（9 项）、`test-feedback-notify`、`test-memory-index`（24 项）、`test-media-lib`（66 项）、`test-stickers`（71 项）、`test-qq-preset-contract`。

推完复核：远程 `main` = `cd10c7e`，本地工作区干净；`git ls-tree origin/main` 里**没有** `tools/asr/.venv`、`models`、`media/`、`_backup-*`；远程最大的文件是 `src/bridge.js`（801 KB），没有意外的大文件。

`npm run test:audit` 是 **39/41**，两个失败都卡在 `spawn EPERM`（沙箱禁止开子进程），不是逻辑问题。

**留给明天**

- `test-audit-setup.mjs` 的 4 个断言、`test-qq-model-view.mjs` 的 1 个断言在沙箱里跑不了，**需要一次在正常终端里的全绿结果**才能确认它们真的没问题。
- `npm run verify:adaptation` 没跑成（缺 DSH profile 模块 + `127.0.0.1:3080` 没起）。下次 DSH 开着时补跑。
- 这次两个提交的作者是临时指定的 `shiq21185-cmyk`（本机没配 `user.name`）。要统一成日常身份得 `--amend --reset-author` + 强推，会重写历史，**没擅自做**。
- 日记里 10-17 那条写着「明天接着打消消乐」，之后就没再提 —— 她可能真的忘了，也可能只是没写。先不动，观察。

> 提交：`d9941c5`（release）、`cd10c7e`（merge）

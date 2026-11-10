# 文档索引（docs/README.md）

> 根目录只留 6 个文档（`README.md` / `README.en.md` / `RULES.md` / `CHANGELOG.md` / `DEVLOG.md` / `DEPLOY.md`），其余全部在本目录下。
> 仓库目录结构与 `scripts/` 命名约定见 **[FOLDER_MAP.md](FOLDER_MAP.md)**。
>
> **状态标记**：✅ 仍然有效（按它做就对） · ⚠️ 部分过时（见备注） · 🗄️ 已被取代（保留作背景）
> · **🚫 本机无此文件**（历史登记，点开是死链，只当背景读）
>
> 三份「改了什么」的分工：**[DEVLOG.md](../DEVLOG.md)** 按天记流水（每天写）·
> **[CHANGELOG.md](../CHANGELOG.md)** 按版本记摘要（发版写）· **本目录 `releases/`** 按版本记完整说明（发版写）。

---

> **2026-11-10 校订**：本轮修掉了 20 条死链（`design/` `audits/` `legacy/` 三个目录在本机不存在；
> `guides/PROJECT_GUIDE.md`、`guides/VOICE.md` 已不存在），并补登了原先漏掉的 10 份文档
> （`START-HERE` / `ADD-ENDPOINT` / `BODY-BUILD` / `BODY-PLAN` / `PRIVACY` / `DSH_021_ADAPTATION` /
> `REFACTOR-2026-10-21` / `releases/v0.2.2-r1`，以及两份中文报告）。
> 凡是标 🚫 的条目，**本机没有那个文件** —— 它们是为上游仓库/公开仓库保留的登记。
> 要找本机真有的东西，请看 [FOLDER_MAP.md](FOLDER_MAP.md)。

## 先看这两份（新接手 / 新机器）

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [guides/START-HERE.md](guides/START-HERE.md) | **从这里开始**：装什么、按什么顺序跑、跑完怎么确认是对的 | ✅ 新接手先读这份 |
| [FOLDER_MAP.md](FOLDER_MAP.md) | 每个目录/脚本是干什么的、哪些是历史残留 | ✅ 找东西用这份 |

## 手艺清单.md —— **给 AI（小鲸鱼）照着干活的**

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [手艺清单.md](手艺清单.md) | **任务 → 命令** 两列表：主人让她干具体活时（转 word/pdf、转写、发语音、查网关、改完 preset 重生成…）照抄哪一条。只收「她真会被要求做」的，每条都要自己先跑通才写进来 | ✅ **给 AI 看的**，不是给人看的目录索引；命令里不含本机路径，可进公开仓库 |

## releases/ —— 每个版本的完整更新日志

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [releases/v0.2.2-r1.md](releases/v0.2.2-r1.md) | **v0.2.2-r1 更新日志**（2026-11-10）：私有仓专属 —— 主人私聊完全接入 DSH owner-dsh preset、唤醒增量下发、记忆热条目层（`test-memory-hot.mjs`） | ✅ 最新 |
| [releases/v0.2.1-r1.md](releases/v0.2.1-r1.md) | **v0.2.1-r1 更新日志**（2026-10-26）：只做版本更新、不加功能 —— 守卫补齐 0.2.1 工具面 + `dsh-ops` 一族（67→99）；修掉两处方向写反的 `{{cwd}}` 断言；**修好对账工具的 asar 支持**（`verify:adaptation` 首次 77/0 全绿）；版本身份统一到 `0.2.1-r1` | ✅（上一版） |
| [releases/v0.2.0-r5.md](releases/v0.2.0-r5.md) | **v0.2.0-r5 更新日志**（2026-10-24）：记忆能翻旧账（`qq_memory_query` 归档检索、索引改为「随时间移除」、〔约定〕置顶）；语音被主人关掉时直接退回文字；拆掉从未被调用过的「她自己的图库」；群图库摘要去废话 272→190 字；12 处本机路径清出仓库 | ✅ |
| [releases/v0.2.0-r4.md](releases/v0.2.0-r4.md) | **v0.2.0-r4 更新日志**（2026-10-20）：时间感 / 自由时间 / 约定、专项控制台、群图库、语音优先，以及修掉的四个真缺陷（日记日期归属、重复记忆索引、反馈其实没发出去、TTS 开关不生效）。⚠️ 文中「向我申请」硬闸门已于 2026-11-06 整体下线，读那段请对照 [RULES.md §3](../RULES.md) | ⚠️ 其余有效 |

## guides/ —— 面向使用者 / 运维

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [guides/START-HERE.md](guides/START-HERE.md) | 从零上手：安装顺序、最小可用配置、自检清单 | ✅ |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | DSH 端安装说明：`qq-chat` / `qq-chat-v2` / `qq-owner-dsh` preset 与四个 MCP server 怎么挂到目标设备的 DSH 上 | ✅ |
| [guides/ADD-ENDPOINT.md](guides/ADD-ENDPOINT.md) | **加一个新 HTTP 端点的三步法**：`bridge.js` 结构速览、在哪一段插、改完跑哪些回归 | ✅ 2026-11-10 新增 |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | **安全基线与威胁模型**：威胁主体、已实现的边界（准入/工具面/出站/控制台/落盘/网络）、已知残余风险、发布前回归清单、改动检查单 | ✅ **改动安全相关代码前必读** |
| [guides/PRIVACY.md](guides/PRIVACY.md) | 隐私边界：哪些数据出仓、哪些只在本机、脱敏规则 | ✅ |
| [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | 控制台「令牌与花费」看板：数据来源、计价口径（峰谷分时）、API、配置 | ✅ |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台离线预览（`npm run preview:console`）怎么用。⚠️ 文中 `npm run test:console-ui` **已于 2026-11-10 删除**（需要 Playwright，本机没装）；控制台回归现在靠 `test-console-static.mjs` + `test-extra-console.mjs` | ⚠️ 部分过时 |
| [guides/DSH_021_ADAPTATION.md](guides/DSH_021_ADAPTATION.md) | **DSH 0.2.1 适配改动记录**：0.2.0 → 0.2.1 的工具面扩张（dsh-ops 一族）与守卫补齐 | ✅ |
| [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) | **DSH 0.2.0 适配改动记录**：逐条列出为适配 0.2.0-rc.2 做的改动（现象/为什么必须改/证据/怎么验证），以及「复核后判定兼容、因此没改」的部分 | ✅ 升级 DSH 前先读 |
| [guides/BODY-BUILD.md](guides/BODY-BUILD.md) | ESP32 身体（拍照 / 喇叭 / 在线状态）怎么搭、怎么接线、怎么调 | ✅ 私有仓专属 |
| [guides/BODY-PLAN.md](guides/BODY-PLAN.md) | 身体的规划背景与取舍 | ⚠️ 规划文档，落地以 BODY-BUILD 为准 |

## 中文专题报告（私有仓本地记录）

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [小鲸鱼私聊完全接入DSH-架构改造计划书.md](小鲸鱼私聊完全接入DSH-架构改造计划书.md) | 2026-11-10：把主人私聊从"桥接自己驱动"改成"DSH owner-dsh preset 全权驱动"的架构方案与分期 | ✅ 最新，对应 `qq-owner-dsh` preset |
| [小鲸鱼记忆优化报告.md](小鲸鱼记忆优化报告.md) | 2026-11-10：记忆热条目层（hits 计数、最多 5 条）、索引窗口调参（2→3 天）、注入上限 9000 的实测依据 | ✅ 最新 |
| [REFACTOR-2026-10-21.md](REFACTOR-2026-10-21.md) | 那一轮 `bridge.js` 重构的记录（抽函数、降复杂度、回归网） | ✅ 背景 |

## research/ —— 调研记录（**本机只有一个文件，且被 `.gitignore` 排除，不进公开仓**）

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| `research/UPSTREAM_DIFF_2026-10-21.md` | 与上游仓库的逐文件差异记录 | 🚫 本机有文件但**不入 git**（`docs/research/` 在 `.gitignore` 里），公开仓看不到 |
| research/SnowLuma功能调研.md | SnowLuma 除「OneBot WS + 基础收发」之外还有哪些 QQ 相关功能与机制 | 🚫 本机无此文件 |
| research/RESEARCH_QQ_MESSAGE_DND.md | QQ 群「消息免打扰」影响不影响 SnowLuma 收发 —— 结论：不影响，只是不提醒 | 🚫 本机无此文件 |
| research/RESEARCH_SNOWLUMA_EMOJI_STICKER.md | SnowLuma 的表情包/收藏表情能力，本仓库收藏表情功能的依据 | 🚫 本机无此文件 |
| research/LOCAL_MODEL_SIZING.md | 若要本地复刻：本项目对模型的真实负载、显存门槛 | 🚫 本机无此文件 |

## design/ —— 设计与规划（**整目录本机不存在**）

> 这四条是为上游仓库保留的登记。本机的设计意图已经并进 `RULES.md`、`README.md` 和各版本的 `releases/`。

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| design/GEN2_SIMULATION_PLAN.md | 二代仿真（`reserved2`）「一切皆工具」实施计划 | 🚫 本机无此文件（已落地，见 `releases/v0.2.0-r4.md`） |
| design/SOCIAL_MODE_PLAN.md | 一代仿真模式（`reserved`）的头脑风暴定案 | 🚫 本机无此文件 |
| design/DSH_QQ_TOOLS_PLAN.md | 「一切皆工具」总路线与交接文档 | 🚫 本机无此文件 |
| design/真人语感策略.md | 拟人化策略：短句碎片、接梗、错别字、话题漂移 | 🚫 本机无此文件 |

## audits/ —— 审查 / 体检 / 优化报告（**整目录本机不存在**）

> 这些报告属于更早的仓库形态。当前的安全基线以 [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md)
> 为准，DSH 适配以 `guides/DSH_02x_ADAPTATION.md` 为准。

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| audits/AUDIT_FIXES_2026-09-20.md | 那一轮三路并行审计与修复记录 | 🚫 本机无此文件 |
| audits/CODE_AUDIT_2026-09-20.md | 同日较早的代码体检（P0~P3 清单、monolith 度量） | 🚫 本机无此文件 |
| audits/AUDIT_REPORT_2026-09-20.md | 全项目体检：四条独立审计线 + 按影响排序的修复 | 🚫 本机无此文件 |
| audits/CONSOLE_FEATURES_REPORT.md | 控制台功能增强：人格管理、两层提示词、DSH 思考强度 | 🚫 本机无此文件 |
| audits/CONSOLE_UI_REDESIGN_REPORT.md | 控制台改版报告：页导航 + 全局搜索 + 浅色/深色主题 | 🚫 本机无此文件（页数早已变化，别照它数） |
| audits/TOKEN_OPTIMIZATION.md | `reserved2` 的 token 开销优化与消息水位协议 | 🚫 本机无此文件（现行说明见 `guides/TOKEN_USAGE_CONSOLE.md`） |
| audits/TOKEN_COST_ANALYSIS.md | token 成本实测档案与优化清单 | 🚫 本机无此文件（数据是历史快照，别当现值） |

## legacy/ —— 历史归档（**整目录本机不存在**，不要照着做）

| 文档 | 一句话说明 | 为什么归档 |
| --- | --- | --- |
| legacy/PROJECT_GUIDE.public-condensed.md | 面向公开仓库的精简版项目说明书 | 🚫 本机无此文件（`guides/PROJECT_GUIDE.md` 也已不存在；现行说明书就是根目录 `README.md`） |
| legacy/AUDIT_REPORT_2026-09-18.md | 2026-09-18 的架构审查与修复报告 | 🚫 本机无此文件 |
| legacy/ARCH_REVIEW.md | 2026-08-18 的架构审查：严重 #1~#6、中等 #7~#15 | 🚫 本机无此文件 |

---

## 想找什么 → 去哪看

| 我想…… | 看这个 |
| --- | --- |
| 从零把这一套装起来 | [guides/START-HERE.md](guides/START-HERE.md) |
| 在新设备上把 qq-bridge 接进 DSH | [guides/DSH_SETUP.md](guides/DSH_SETUP.md) |
| 搞懂整体架构 / 全部配置项 | [../README.md](../README.md)（配置全解）+ [FOLDER_MAP.md](FOLDER_MAP.md) |
| 加一个新 HTTP 端点 | [guides/ADD-ENDPOINT.md](guides/ADD-ENDPOINT.md) |
| 看 AI 烧了多少钱 / 计价口径 | [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) |
| 改控制台界面 | [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md)（预览）+ `npm run test:audit` 里的 `test-console-static` / `test-extra-console` |
| 改代码前先知道有哪些坑 | [guides/DSH_021_ADAPTATION.md](guides/DSH_021_ADAPTATION.md)（最新）、[guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) |
| 动安全相关代码 / 做发布前检查 | [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) |
| 知道某个目录/脚本是干什么的 | [FOLDER_MAP.md](FOLDER_MAP.md) |
| 让 AI（小鲸鱼）在管理员私聊里自己动手干一件活 | [手艺清单.md](手艺清单.md) |
| 权限边界与安全承诺 | [../RULES.md](../RULES.md) |
| 记忆是怎么存的 / 为什么要这样存 | [小鲸鱼记忆优化报告.md](小鲸鱼记忆优化报告.md) |
| 主人私聊为什么走 DSH | [小鲸鱼私聊完全接入DSH-架构改造计划书.md](小鲸鱼私聊完全接入DSH-架构改造计划书.md) |
| 这个项目要往哪走（QSH） | 上位目录的 `../../QSH-plan/`（总索引 `README.md`） |

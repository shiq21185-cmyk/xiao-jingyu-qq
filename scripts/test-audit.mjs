// Safe audit suite: fixtures and mocks only, never production QQ/DSH.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'test-audit-bridge.mjs', 'test-audit-protocol.mjs', 'test-audit-protocol-helpers.mjs',
  'test-audit-security.mjs', 'test-audit-security-mcp.mjs',
  'test-audit-setup.mjs', 'test-audit-setup-guards.mjs',
  // DSH 会话队列（inbox 投影）解析：0.2.0 把队列从 control baseline 的
  // `value.queues[<id>]` 挪进了 `value.projections[<id>].values.inbox`。
  // 认错形状的后果不是"少清几条"，而是**每一次退役会话都抛错**、旧任务继续跑，
  // 且只留下一行日志 —— 必须有登记期断言钉住（活 DSH 侧的实测见
  // scripts/test-dsh-session-retire.mjs）。
  'test-dsh-inbox-projection.mjs',
  'test-md-to-plain.mjs', 'test-slang-learn.mjs', 'test-mux-reconnect.mjs',
  'test-token-economy.mjs', 'test-qq-model-view.mjs', 'test-qq-preset-contract.mjs',
  // 🔴 QQ 空间「自主闸门」（2026-10-19 主人要求）：**写操作只能是她自己起的回合**，
  //    任何人在对话里命令她去做都不能成立 —— 包括管理员。
  //    这条边界由桥接在执行期强制，判错的失败方向是"被命令的发声被放行"，
  //    正是主人明确要挡的事，所以必须每次回归都跑。
  //    测试直接从 src/bridge.js 抽出真实判据求值（不照抄名单，避免两份漂移）。
  'test-qzone-autonomy.mjs',
  // 🔴 日记「日期归属」（2026-10-19 真实事故）：她把**前一天**的日记当成今天讲了出去
  //    （「没刷视频，打了一下午消消乐」，而当天 phone_* 调用数为 0）。
  //    根因是注入提示词的日记行只有日期戳、不标"这是昨天"，模型得自己换算才不讲错。
  //    修复后行首显式标【今天】/【昨天】/【具体日期】，并在摘要末尾禁止拿过去当今天说。
  //    这条必须有回归：错一次就是对着群友编造自己的经历，而且事后极难察觉。
  'test-diary-recall.mjs',
  // 🔴 「向我申请」闸门（2026-10-19 主人要求）：手机工具与 bili_run 必须**他当场同意**
  //    才放行。判错的失败方向是"群里/别人私聊里能动主人的手机和账号"，
  //    而那在 QQ 里看起来就是"小鲸鱼自己在玩"，极难察觉。必须每次回归都跑。
  //    测试用临时沙箱（不碰生产 state/），并逐条验 fail-closed。
  'test-permit-gate.mjs',
  'test-quiet-autonomy.mjs',
  // 🔴 主动找人 + 时间感 + 约定的纯函数（时段/饭点/深夜系数、授权文件形状）。
  //    时段边界写错一个 >= 就会让她半夜问"吃了没"，而这种错误在真实对话里
  //    几乎无法复现（要正好那个钟点、正好被唤醒），只能靠单测钉住。
  'test-proactive-time.mjs',
  // 🔴 记忆索引的容量策略与重复块 bug（2026-10-20 真事故）。
  //    索引原先按 daily-memory.json **全量平铺**、只增不减：实测日均 +138 字符，
  //    约 12 天就会再撞 role.maxInjectChars，而超限截断是**从头砍**的 ——
  //    索引在文件末尾 ⇒ 砍掉的正是最新记忆，越积累丢得越多。
  //    现在改成"最近 7 天 / 最多 30 条 + 归档指针"，由主人拍板。
  //    （2026-10-23 又收成"最近 3 天 + 约定例外"，见下面那组。）
  //    同时钉住那次"人格卡里出现两块相同索引"的行尾 bug。
  'test-memory-index.mjs',
  // 🔴 上面那条讲的是 2026-10-20 的策略（7 天 / 30 条）。**2026-10-23 主人又改了**：
  //    「记忆就是要精简，也不是重点常驻，是随时间移除的」⇒ 逐条只留最近 3 天，
  //    更早的整条移出索引（只留在 daily-memory.json，可检索），未到期的约定例外钉住。
  //    下面这一组守的就是新策略的每一块。以前只有 test-memory-index 在名单里、
  //    这七个都不在 —— 等于"改了规则也没人发现"，所以整组必须进回归。
  //    体积预算：条数管不住体积，超限截断是从头砍的（索引在文件末尾 ⇒ 砍最新记忆）。
  'test-index-budget.mjs',
  // 🔴 记忆串味（2026-10-21 真事故）：提炼不带会话维度 + 机器人自己的私聊也参与 +
  //    印象拿昵称当 key。守三件事：会话按 QQ 号分开、排除机器人自己、身份只认 QQ 号。
  'test-memory-scope.mjs',
  // 索引跨会话共享，每条必须带来源（私聊<QQ>｜ / 群<群号>｜）：她同时面对好几个会话，
  // 不标来源就会把"谁说的"记混 —— 那正是串味最典型的样子。
  'test-memory-isolation.mjs',
  // 🔴 「可用 qq_memory_query 检索」曾经是假的（2026-10-23 查实）：daily-memory.json
  //    在 src/ 下被读 0 次，归档条目根本查不到。这两条钉住：桥接真的有读取路径、
  //    按关键词能命中且带来源、有字符预算、端点与 MCP 面都暴露 q/limit/archive。
  'test-memory-archive.mjs',
  // 上面那套检索的排序与预算细节：同分按新近、命中两个词的优先、limit 只影响显示条数
  // 不影响 matched 总数、预算再紧也留一条（空索引会被读成"我没有任何记忆"）。
  'test-memory-archive-rank.mjs',
  // 🔴 记忆索引只放最近 3 天 ⇒ 实测 62 条里 50 条在索引外，只有她**主动**去
  //    qq_memory_query 才看得见，而她不知道自己忘了什么（2026-10-29 照
  //    xiaoman-memory 的「联想不是搜索」补的）。这条钉住每轮撞一次旧事的三条纪律：
  //    要点没对上就不提、别的会话的旧事不撞、刚提过的不再提。
  'test-memory-recall.mjs',
  // 印象单条 50 → 120 字（主人 2026-10-23：200 太大）、条数上限 20。50 字会切掉
  // 「关系定位」「不真记仇」这类关键结论；20 条对齐 memory-update 端点。
  'test-memory-impression.mjs',
  // 🔴 「约定 / 还欠着的事」要能超出 3 天窗口留着（主人 2026-10-23 要的"额外保留"）。
  //    时间识别最容易写错且最难在真实对话里复现：相对词按**条目自己那天**往后推
  //    （10-17 写的"明天"是 10-18，不是今天的明天）、跨年、周几、到期即下线、
  //    "说好话"不算约定、只留 4 条、预算紧时先砍普通记忆。
  'test-memory-pin.mjs',
  // 🔴 「清除上下文」不能连记忆一起删（2026-10-23 真实丢了 4 个会话的记忆）：
  //    /api/session/reset 与聊天 /reset 原来是裸 conversations.delete(key)，
  //    话题/想法/印象/约定全跟着没了。这条钉住"上下文换新、记忆留下"。
  'test-reset-keeps-memory.mjs',
  // 🔴 「语音是主人自己关的」不能当成出错（2026-10-23）：端点原来直接 403，
  //    她当故障重试了 3 天。这条钉住"关着的渠道要安静改发文字、并说清不是故障"。
  'test-speak-owner-off.mjs',
  // 🔴 专项控制台的**隔离性**（2026-10-19 主人要求：独立一个，别混进主控制台，
  //    怕插件更新把定制冲掉）。这个测试守的正是那个承诺：
  //    它只许 import node 内置、只许调桥接**原版就有**的端点、数据只落 state/。
  //    哪天有人（包括我）图省事给它加一个 import '../src/xxx.js'，这里就红。
  'test-extra-console.mjs',
  'test-reply-wait.mjs', 'test-preset-prompt.mjs', 'test-role-card.mjs',
  // 🔴 preset 产物（plugins/qq-agent-presets/presets/*.patch.yml）是**生成物**，
  //    DSH 启动时读的就是它，但唯一权威源是 dsh/agent-presets/<preset>/*.yml。
  //    直接改产物"当场也生效"，所以看不出问题——直到有人跑 setup-dsh.mjs，
  //    它会把产物重新生成一遍，手改的提示词被**静默抹掉**。
  //    这条 --check 早就写好了，却一直不在 audit 名单里，导致整整两轮 URL 规则
  //    改在产物上漂了一天没人发现。必须每次回归都跑。
  'test-agent-preset-patches.mjs',
  // 令牌账本 / 价目表 与 体检修复回归（纯函数，无外部依赖）
  'test-token-usage.mjs', 'test-hardening.mjs',
  // 语音发送（纯函数 + 端点存在性；真发语音只在 --live 或 CLI 里做）
  'test-voice.mjs',
  // 🔴 入站语音转文字（《进阶篇》进阶 3）的接线契约。转写引擎本身在
  //    _ref/asr-lib-test.mjs（假 worker 验协议）与 _ref/asr-live-test.mjs（真跑 whisper）里验，
  //    这里只钉桥接侧三件事：关着时行为与以前逐字一致、开着时文字进 textContent/plainContent、
  //    以及**转写失败/抛异常绝不能吞掉这条消息**。
  'test-audit-voice-inbound.mjs',
  // 🔴 出站语音合成（她说的话 → 本机 TTS → 语音条）的接线契约。合成引擎在
  //    _ref/tts-lib-test.mjs（假 worker 验协议）与 _ref/tts-live-test.mjs / _ref/tts-verify-test.mjs
  //    （真 python、真 edge 引擎、产物再喂回 whisper 质检）里验，这里钉的是**接线**：
  //    两个开关都挡得住、合成成功真的作为 record 段发出、合成失败一条消息都不发、
  //    产物发完就删、且限流必须判在合成之前（超限时不该先花掉几秒和一次网络请求）。
  'test-audit-voice-speak.mjs',
  // 🔴 日记目录可配置（config.json → socialV2.diary.dir）。主人要直接打开看，所以它不在
  //    仓库里了，而是指到工作目录。这条钉两件容易写错的事：相对路径按 **ROOT** 解析
  //    （不是 process.cwd()）、以及没配/空串时**必须**回到原来的 data/日记（老日记不能消失）。
  'test-audit-diary-dir.mjs',
  // 音量：参数校验 + 真的调用 ffmpeg 调音量 + 自算 RMS 验证增益
  'test-voice-volume.mjs',
  // 边界：并发/异常输入/上传限额/越权（纯函数段 + 可选的 live 段）
  'test-voice-edge.mjs',
  // 语音图形界面（参数解析/鉴权/路径穿越/文件名净化；live 段需普通终端）
  'test-voice-gui.mjs',
  // 控制台静态契约（跑不了 Playwright 的环境下的替代回归）
  'test-console-static.mjs',
  // 语音系统整体结构检查（入口/依赖/端点/开关/文档一致性）
  'test-voice-system.mjs',
  // SnowLuma 账号/token 自发现（换 QQ 账号后 token 会变，写死的工具会 401）
  'test-snowluma-conn.mjs',
  // 启动器与编码（乱码根因：.cmd 里的非 ASCII 会被 cmd 按 ANSI 解码）
  'test-encoding.mjs',
  // 控制台乱码机制（UTF-8 字节被按 GBK 解码）+ chcp 修复
  'test-console-encoding.mjs',
  // 🔴 铁律 L7（仿真会话不得拥有本地执行能力）：注册期断言——
  //    preset 挂了守卫、守卫的 restrict 名单覆盖全部已知本地工具、且执行期一律拒绝。
  //    这是唯一挡住"绕过桥接直连 OneBot HTTP"的东西（见 QSH_PLAN.md §0.1/§5.2），
  //    所以必须在每次回归里跑，而不是一次性验收。
  'test-preset-local-tools.mjs',
  // 🔴 工具面分类不变式（2026-10-26 审计后加）：**新工具默认是"对群聊开放"**，
  //    因为守卫的兜底白名单是前缀整包放行（`mcp__snowluma__` / `mcp__web-search-safe__`）。
  //    那次审计就是这么查出两格的：`web_read_current`（读主人此刻正在看的那一页）与
  //    `web_list_tabs`（列出他开着的所有标签页）跟着前缀落进了"三类会话全开"，
  //    于是群聊里任何人都能让她去念主人屏幕上的浏览器。修法 = 同名前必须更早按会话分档判一次。
  //    这条测试专门盯"漏一格"：任何 MCP 工具只要群聊/普通成员私聊能过，就必须在
  //    OPEN_TO_ALL_SESSIONS 里被**显式**登记过。必须每次回归都跑 ——
  //    否则下一个新工具又会静默地对群聊开放，而没人知道。
  'test-tool-classification.mjs',
  // 🔴 网页上的「手」（2026-10-22 主人要的「给她加一个手」）：
  //    web_click / web_type / web_key / web_scroll / web_select / web_whats_there。
  //    它借的是**主人登录着的浏览器**，点一下可能是删除/付款/发帖 ——
  //    所以每条边界都要在回归里钉住：
  //      · 六个工具**只给管理员私聊**（群里/普通成员私聊一律拒，且理由说清是权限）；
  //      · 判定必须排在 SAFE_PREFIXES 之前（否则 mcp__web-search-safe__ 前缀整包放行）；
  //      · **上传永远关死**（/setFiles 不随只读开关消失）；
  //      · **没有任意 JS** 的入口、**密码框不点不填**；
  //      · 提示词里真的写了这只手（否则她照旧会说"我点不了"）。
  'test-web-hand.mjs',
  // DSH 原生 web_search / web_fetch 的分档（web_fetch 只给管理员私聊）。
  'test-web-tools.mjs',
  // 🔴 「怎么每次用都要点浏览器允许」（2026-10-22 主人当场提的问题）。
  //    实测查清：Edge 的「允许远程调试」是**按 CDP 连接**确认的，不是按浏览器实例。
  //    所以真正要保证的是"没人用的时候绝不重连"。三个边界在这里钉住：
  //      · 握手被吊住（弹窗没人点）必须超时报错 —— 旧实现会永久挂住、还不报错，
  //        表现就是"卡住"，比报错难查得多；
  //      · 已连接时反复 connect() 不能新建 socket（每多一条连接就可能多一次弹窗）；
  //      · 真断线后要能连回来（别为了"不打扰"把能力弄丢）。
  //    全程用假 WebSocket，不碰真实浏览器、不需要任何授权。
  'test-cdp-reconnect.mjs',
  // 🔴 「她玩游戏时不理我」（2026-10-22 主人当场报的）。
  //    实测：她一个回合连跑 20 多分钟，这期间主人发的三条消息全被
  //    「会话繁忙，暂存唤醒原因」挡在队列里。根因是桥接只用 mode:'queue'，
  //    而 DSH 的 steer 能把消息插进正在跑的回合。四条边界在这里钉住：
  //      · 即时消息走 steer、定时唤醒仍走 queue；
  //      · steer 被拒要退回 queue（不能把主人的话弄丢）；
  //      · 只有「主人私聊 + 有人当场说话」才许插队；
  //      · 两处繁忙分支都要真的试过 steer（只改一处等于没修）。
  'test-steer-while-busy.mjs',
  // ⭐ 网页游戏接入层（2026-10-22 主人要的「通用游戏接口」）。
  //    守的不是"某个游戏能不能玩"，而是**协议与边界**：
  //      · 加游戏 = 放一个 adapter.js（不用改任何代码）；
  //      · 路径闸门（"游戏名"是唯一可能变成任意文件读取的地方）；
  //      · 适配器三能力缺一要在加载期就报；
  //      · 四个工具只给管理员私聊，且理由讲"游戏"不讲"抓网页"；
  //      · 她只能传动作 id，拿不到 eval。
  'test-games-layer.mjs',
  // 🔴 网页游戏**执行层**的判据（2026-10-22 主人说「你可以再测试测试」之后补的）。
  //    这一天连踩三个坑，全都是"只在真跑时才暴露、静态检查查不出"的时序问题：
  //      ① 只看"待决的人是不是她" ⇒ 拿提交前的快照当结果（掷了骰子还要再掷）；
  //      ② 改成"观察她离开再回来" ⇒ 踩 250ms 采样盲区，一直等满超时，**每步 5190ms**；
  //      ③ 用"局面指纹变了"判断后又硬等 AI 走完 ⇒ 单步被拖到 6 秒以上。
  //    最终解：指纹对比 + 停在 AI 回合就返回（每步 215ms，实测 40 步 9 秒）。
  //    这个测试把"判据"钉住，防止有人改回去。
  'test-games-runtime.mjs',
  // qq-mode-console 的 settings 契约：0.2.0 删除了 ctx.settings.register()，
  // 命名空间改为由 loader entry id + 导出的 Config 推导。断言三点前提都在，
  // 并且那条已删除的 API 不会被照旧注释加回来。
  'test-qq-mode-plugin.mjs',
  // SnowLuma 上游健康（被误诊成「qq-bridge 注入失败」的那个失败形态）：
  //   · good 必须取自心跳 status.good / get_status —— 取自 get_login_info 会**静默失效**
  //     （SDK 不校验 data 载荷，good 会永远停在 null，整条权威信号变成死分支）；
  //   · 静默检测不得冒充 hook 检测（心跳是 SnowLuma 本地定时器无条件发的）；
  //   · 客户端库版本不得低于 bot_status 出现的版本。
  'test-snowluma-upstream-health.mjs',
];
let failed = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, stdio: 'inherit', timeout: 60000,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;

// reserved2 提示词与插件边界的静态契约；不调用模型，不向 QQ 发送消息。
// 这些检查只能防止关键协议/能力被误删，不能证明聊天质量无损。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';

const preset = yaml.load(fs.readFileSync(
  new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url), 'utf8',
));
const persona = preset.find((row) => row.id === 'persona');
const prefix = persona?.config?.prefix ?? '';

test('reserved2 YAML resolves to the expected persona and template variables', () => {
  assert.equal(persona?.name, '@deepseek-ai/dsh-persona');
  assert.match(prefix, /\{\{model\}\}/);
  // ⚠️ 工作目录**写死**，不再用 {{cwd}}：本机 DSH 版本只注册了 provider/model，
  //    {{cwd}} 会让整条 preset 渲染时抛 "unknown prompt variable" 而装配失败。
  //    所以这里断言的是"写死且指向仓库会话目录"，不是"含 {{cwd}} 模板变量"。
  assert.match(persona.config.suffix, /Your working directory is .+qq-bridge-deploy/);
  assert.doesNotMatch(persona.config.suffix, /\{\{cwd\}\}/, 'suffix 不该再使用未注册的 {{cwd}}');
  assert.equal(Object.hasOwn(persona.config, 'text'), false);
});

test('local/admin tool restrictions and existing compaction budgets stay intact', () => {
  assert.deepEqual(preset.map((row) => row.id), [
    'persona', 'tool-web', 'tool-ask-user', 'tool-todo', 'qq-tool-restrict', 'compaction',
  ]);
  // 2026-10-23 主人改主意：tool-web 的 search **关掉**（这台机器没配 DEEPSEEK_API_KEY，
  // 她的会话跑在 provider=workbuddy 上，web_search 一调就报「no API key」）；
  // fetch 仍开着，安全边界靠守卫分档：web_fetch → OWNER_PRIVATE_ONLY_DSH_TOOLS，仅管理员私聊。
  // 守卫那边的分档由 test-web-tools.mjs 钉住。
  assert.deepEqual(preset.find((row) => row.id === 'tool-web').config, { search: false, fetch: true });
  assert.equal(preset.find((row) => row.id === 'qq-tool-restrict').name, './qq-tool-restrict.mjs');
  const compaction = preset.find((row) => row.id === 'compaction');
  assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true });
  assert.deepEqual(compaction.config.find((row) => row.id === 'tool-result-pruner').config, {
    thresholdChars: 50000, headChars: 45000, tailChars: 2000,
  });
  for (const text of ['你没有本地工具', '群友没有管理权限', 'API 令牌', '角色由桥接注入']) {
    assert.ok(prefix.includes(text), `missing safety rule: ${text}`);
  }
});

test('snapshots are optional, partial snapshots require reading, and watermarks are not message IDs', () => {
  assert.match(prefix, /可能附带【本次消息快照】/);
  assert.match(prefix, /partial=true[^。]*继续读取/);
  assert.match(prefix, /readThroughSeq 是桥接本地的 seq，不是 QQ messageId/);
  assert.match(prefix, /没有水位[^。]*省略 throughSeq/);
  assert.match(prefix, /首次进入会话、角色变化[^。]*qq_get_prompt/);
});

test('one closing action can acknowledge the read watermark after the full observation', () => {
  assert.match(prefix, /qq_mark_read\(throughSeq=/);
  assert.match(prefix, /qq_set_wake_config\(config=[^)]*throughSeq=/);
  assert.match(prefix, /不需先 mark_read/);
  assert.match(prefix, /qq_wait_for_messages\(timeoutMs=300000\)/);
  assert.match(prefix, /短等待不能代替/);
  assert.match(prefix, /preSleepWaitRemainingMs[^。]*继续等待/);
  assert.match(prefix, /若你参与回复[^。]*重新观察/);
});

test('pre-reply quiet checks, waiting for replies and pre-sleep observation have distinct instructions', () => {
  assert.match(prefix, /先理解并处理当前消息/);
  assert.match(prefix, /【首答前】[^\n]*qq_wait_for_messages\(purpose="reply", quietMs=10000\)/);
  assert.match(prefix, /读取和思考花掉的时间也算，已安静足够就立即返回/);
  assert.match(prefix, /不要再重开一次普通长等待/);
  assert.match(prefix, /预算到但 quiet=false 不等于对方说完/);
  assert.match(prefix, /【等下文】[^\n]*purpose="messages", timeoutMs=60000~120000/);
  assert.match(prefix, /【回复后】[^\n]*qq_wait_for_messages\(purpose="messages"\)/);
  assert.match(prefix, /短静默不算沉睡前观察/);
  assert.match(prefix, /5 分钟观察不是回复的前置条件/);
  assert.match(prefix, /只有准备收尾时[^。]*preSleepWaitRemainingMs/);
});

test('social autonomy and visual, forwarding, sticker and web capabilities remain described', () => {
  for (const text of [
    '【反 AI 味：拒绝有求必应】', '【保持主体性】', '【学习群友策略】',
    '【不要当群管家/主持人】', '普通对话默认 1 条，最多 2 条', '不要用空格断句',
    '不会自动发送到 QQ', 'qq_get_message_images', 'qq_get_forward_msg', 'nestedForwardIds',
    'qq_send_poke', 'qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker',
    'qq_collect_sticker', 'qq_sticker_note',
    'qq_set_sticker_remark', '只有管理端明确开启后才能用',
    'qq_list_voices', 'qq_send_voice', '不要假装发了语音',
    'mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch',
  ]) assert.ok(prefix.includes(text), `missing capability or voice rule: ${text}`);
});

// ── 常驻语音（2026-10-20 主人要求：默认开口说，发不出去才打字）──────────────
// 这一组不是"提醒她注意"，而是她**日常说话方式**的合同：
//   · 默认用 qq_say（语音优先），不是 qq_send_message
//   · 返回的 mode 是唯一实况，看到 text 不能重复补发（那会给对方造成重复消息）
//   · 三条必须打字的例外（看/引用@/连试两次失败）
//   · 语音被主人关掉时是「安静退回文字」，不是故障（2026-10-23 主人要求）
// 少任何一条，行为都会退化成"又变回打字"、"语音失败后重复发送"，或者把设置当成 bug 反复重试。
test('voice-first speaking is the default and its fallback contract is described', () => {
  for (const text of [
    '【说话方式：有语音就用语音】',
    'qq_say',
    '默认开口说，能发语音就发语音，发不出去才打字',
    '他发文字、他发语音、群里跟你说话 —— 你都回语音',
    '`mode` 是**唯一可信的实况**',
    '**看到 text 不要再补发一次**',
    // 语音被主人关掉：不是故障，安静改文字
    '语音可能是主人自己关掉的',
    '不是故障、不是坏了、不用重试、不用换工具、也不用报给主人',
    // 三个必须打字的例外
    '内容需要被看清楚',
    '引用某条消息',
    '@ 某人',
    '连试两次都被退成文字',
    // 语音本身的写法约束
    '单条 300 字以内',
    '别带 Markdown / 列表 / 代码块',
  ]) assert.ok(prefix.includes(text), `missing voice-first rule: ${text}`);
});

test('autonomy limits and the observation escape hatch stay described', () => {
  // These rules were previously unguarded: deleting any of them left every test green.
  for (const text of [
    // 沉睡前观察唯一的逃生口：明确结束语可以跳过 5 分钟等待。
    '除非对方明确“不聊了/晚安/下了/拜拜”等结束语',
    // [SILENT] 是桥接的退出标记，误用会静默吞掉回复。
    '不要用 [SILENT]',
    // 记忆面
    '【记忆卫生】', 'qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear',
    // 2026-10-23 主人要求「告诉她可以索引」：得让她知道能带关键词搜更早的归档，
    // 否则角色卡里那句「更早的 N 条已移出索引…（可搜：xxx）」等于没说。
    '想不起以前的事，就带关键词去搜记忆库',
    'q="消消乐"',
    '更早的记忆归档',
    '不是删了，只是搬走了',
    '先搜关键词，别直接说"我记不清了"',
    // 黑话面
    'qq_slang_query', 'qq_slang_submit', '不重复提交',
    // 频率上限
    '普通闲聊约 3~5 轮一张', '别刷屏', '每条只能一张，不能附带文字', '不要频繁拍',
    // 会话令牌是硬前置，漏传会被拒绝。
    '作为 token 参数传入',
    // 指定成员唤醒
    'triggers.speakerIds', '不凭记忆乱填',
  ]) assert.ok(prefix.includes(text), `missing rule: ${text}`);
});

// ── QQ 空间：读可命令、写必须自主（2026-10-19 主人要求）─────────────────────
// 为什么单独一组断言：这条规矩不是"提醒她注意"，而是桥接在**执行期**强制的边界
// （/api/socialV2/qzone-action 检查 st.turnAutonomous）。提示词里那一段是给她
// 解释"为什么被拒"用的；一旦被删掉，她会把 403 当成故障反复重试。
// 桥接侧的判据另由 test-qzone-autonomy.mjs 钉住（纯函数、不依赖运行中的桥接）。
test('qzone read-vs-write split and the autonomy rule stay described', () => {
  for (const text of [
    // 读写分野与五个写工具
    '【QQ 空间：写操作只能是你自己想做的】',
    'qq_send_qzone_msg', 'qq_qzone_like', 'qq_qzone_comment', 'qq_qzone_delete', 'qq_qzone_set_right',
    // 只读的两个（命令有效）
    'qq_get_qzone_list', 'qq_get_qzone_feeds',
    // 核心约束：连管理员也不能命令
    '都不能照做', '包括管理员本人',
    // 群里拿不到自主回合，别反复试
    '群里**永远**给不了你自主回合',
    // 回合中途有人说话会撤销自主资格
    '自主资格会立刻作废',
  ]) assert.ok(prefix.includes(text), `missing qzone autonomy rule: ${text}`);
});

// ── 语音合成只剩一个入口（2026-10-20 合并 qq_speak → qq_say）─────────────
//
// 为什么要合并：两个工具参数几乎相同、语义相近，还共用同一个 speak 开关。
// 主控制台那份写死清单里只列了 qq_speak，用户取消勾选会把 qq_say 一起关掉
// 却看不见 —— 那份清单里根本没有 qq_say。
//
// 合并**保留**了 qq_speak 的两个独有能力，而不是直接删掉它：
//   ① verify 参数（是否回读校验）
//   ② mode="voice-only"（语音发不出去就报错，**不**退文字）
// 后者是 qq_speak 的原始语义（"我就是要发语音"），丢掉它等于砍掉一种表达方式。
test('语音合成只有一个入口 qq_say，且继承了 qq_speak 的两种能力', () => {
  const mcp = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8');
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');

  assert.ok(!mcp.includes("'qq_speak'"), 'qq_speak 应当已从 MCP 注册表删除（已合并进 qq_say）');
  assert.ok(mcp.includes("'qq_say'"), 'qq_say 必须还在（它是合并后的唯一入口）');

  assert.match(mcp, /verify: z\.boolean/, 'qq_say 应当继承 verify 参数');
  assert.match(mcp, /mode: z\.enum\(\['voice-first', 'voice-only'\]\)/, 'qq_say 应当继承 voice-only 模式参数');
  assert.ok(mcp.includes('voice-only'), '工具描述必须说明 voice-only 是什么');

  assert.ok(bridge.includes('voiceOnly'), '桥接应当实现 voiceOnly 分支');
  assert.match(bridge, /if \(opts\.voiceOnly === true\)[\s\S]{0,260}throw new Error/,
    'voiceOnly 时语音失败必须抛错，而不是退文字');
  assert.ok(bridge.includes("String(body.mode ?? '') === 'voice-only'"),
    '端点应当把 mode="voice-only" 解析成 voiceOnly');

  assert.ok(!prefix.includes('qq_speak'), '提示词不该再提 qq_speak —— 该工具已不存在');
  assert.ok(prefix.includes('qq_say'), '提示词必须提 qq_say');
  assert.ok(prefix.includes('voice-only'), '提示词应当告诉她 voice-only 这个选项');

  assert.ok(!bridge.includes("speak: 'qq_speak'"), '工具名映射应当指向 qq_say，不该再是 qq_speak');
});

console.log(`reserved2 persona prefix: ${prefix.length} characters (not a model-token estimate)`);

// ── 主动找主人 / 申请闸门 / 时间感 / 约定（2026-10-19 主人要求）─────────────
// 这一组对应的都是**执行期真会发生的事**：
//   · 手机与 bili_run 由 qq-tool-restrict 的 PERMIT_TOOL_SCOPES 硬拦（test-permit-gate.mjs 钉住）
//   · 约定到点由 schema
// 如果只删提示词，她会拿到 403 却不知道为什么、也不知道该先申请 —— 那是最糟的体验。
test('proactive reaching-out, permit gate and promises stay described', () => {
  for (const text of [
    // 想他就可以来找他
    '【想他的时候（私聊）】',
    '想他的时候，可以直接来找他',
    // 申请闸门
    '【有件事要问他：先申请】',
    'qq_request_permission',
    'scope="phone"',
    '需要主人当场同意',
    '别反复申请',
    // 时间感
    '【时间感：你知道现在几点】',
    '**吃饭的时候说自己也饿了**',
    // 约定
    '【约好的事：到点叫你】',
    'qq_promise_done',
    'kind=wakeup/remind/checkin',
  ]) assert.ok(prefix.includes(text), `missing proactive rule: ${text}`);
});

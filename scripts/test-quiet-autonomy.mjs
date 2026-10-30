// 「聊完静默期 = 她的自由时间」的契约测试（2026-10-20 主人要求）。
//
// 背景：主人说"感觉小鲸鱼自主的时间太少了，希望她现在判断结束对话后的短暂时间
//   也算她的自由时间" → 门槛 3 分钟、空间三件事全部放行。
//
// 这组测试守的几件事：
//   ① 原有判据一条没松（AUTONOMOUS_WAKE_REASONS 仍是那三个）
//   ② 盖章用"现在"当 turnStartedAt（不然会被 15 分钟 TTL 当场判过期）
//   ③ 收到新消息/拍一拍能取消待办（不然变成"边聊边发说说"）
//   ④ 静默回合不盖章
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const SRC = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');

test('静默盖章：只加钩子，原有自主判据一条没松', () => {
  // ① 自主唤醒集合**没被改动**（这是关键：改了它就会"边聊边发说说"）
  const m = /const AUTONOMOUS_WAKE_REASONS = new Set\(\[([^\]]+)\]\)/.exec(SRC);
  assert.ok(m, '找不到 AUTONOMOUS_WAKE_REASONS');
  const reasons = m[1].match(/'([^']+)'/g).map((x) => x.replace(/'/g, ''));
  assert.deepEqual(reasons.sort(), ['proactiveCheck', 'replyCheck', 'timeout'],
    '自主唤醒集合必须仍是这三个 —— 把 private/admin 并进去会让"边聊边发说说"成立');

  // ② 15 分钟 TTL 没被改
  assert.match(SRC, /const AUTONOMOUS_TURN_TTL_MS = 15 \* 60 \* 1000/,
    '15 分钟的 TTL 盖子不该被改');

  // ③ 静默门槛：默认 2.5 分钟，但**可在控制台改**（2026-10-20 主人要求数字可调）
  assert.match(SRC, /const AUTONOMOUS_QUIET_GRANT_MS_DEFAULT = 2\.5 \* 60 \* 1000/,
    '静默门槛的默认值应当是 2.5 分钟');
  assert.match(SRC, /function quietGrantMs\(\)/, '门槛应当能现读 cfg（可调），不是一个死常量');
});

test('静默盖章：盖章时用"现在"当起点，否则会被 TTL 当场判过期', () => {
  const i = SRC.indexOf('const AUTONOMOUS_QUIET_GRANT_MS');
  const j = SRC.indexOf('const WAKE_PRIORITY', i);
  const seg = SRC.slice(i, j);
  // 盖章处必须写 Date.now()，不能沿用上一轮的 turnStartedAt
  assert.match(seg, /st\.turnStartedAt = Date\.now\(\);/, '盖章必须刷新 turnStartedAt');
  // 双保险：盖章前再确认一次没有新消息
  assert.match(seg, /lastIncomingAt/, '盖章前应当再确认一次无新消息（定时器可能与会话处理交错）');
  assert.match(seg, /saveSocialV2State\(\);/, '盖章必须落盘（否则重启就丢）');
  assert.match(seg, /t\.unref/, '定时器应当 unref（不拖住进程退出）');
});

test('静默盖章：有人开口/动手就能取消', () => {
  // 收到新消息处
  assert.match(SRC, /回合内收到新消息，自主标记已撤销[\s\S]{0,300}cancelQuietAutonomy\(key, '收到新消息'\)/,
    '收到新消息必须取消待办盖章');
  // 拍一拍处
  assert.match(SRC, /回合内收到拍一拍，自主标记已撤销[\s\S]{0,300}cancelQuietAutonomy\(key, '收到拍一拍'\)/,
    '收到拍一拍必须取消待办盖章');
});

test('静默盖章：只在非自主、非静默的回合后才安排', () => {
  assert.match(SRC, /if \(!wasAutonomous && !isSilentTurn\) \{[\s\S]{0,80}scheduleQuietAutonomy\(key\)/,
    '只该在"非自主且非静默"的回合后安排盖章');
});

test('静默盖章：门槛是 2.5 分钟，且频率闸门挡住"每次聊完都发"', () => {
  // ① 门槛默认 2.5 分钟，且可调
  assert.match(SRC, /const AUTONOMOUS_QUIET_GRANT_MS_DEFAULT = 2\.5 \* 60 \* 1000/,
    '静默门槛的默认值应当是 2.5 分钟');
  assert.match(SRC, /function quietGrantMs\(\)/, '静默门槛应当可调（现读 cfg）');

  // ② 频率默认 4 小时，且可调
  assert.match(SRC, /const QZONE_WRITE_MIN_GAP_MS_DEFAULT = 4 \* 60 \* 60 \* 1000/,
    '两次空间写之间默认至少隔 4 小时');
  assert.match(SRC, /function qzoneWriteMinGapMs\(\)/, '频率门槛应当可调（现读 cfg）');

  // ③ 两个空间写端点都必须过频率闸门（漏一个就有一条路能绕过去）
  const gateCalls = [...SRC.matchAll(/qzoneWriteGapCheck\(/g)].length;
  assert.ok(gateCalls >= 3, `频率检查应当被调用（含定义）至少 3 处，实际 ${gateCalls}`);

  // ④ 成功处必须记录时间戳，否则频率记不住、永远放行
  const marks = [...SRC.matchAll(/qzoneWriteMark\(/g)].length;
  assert.ok(marks >= 3, `写成功后应当记录时间戳（含定义）至少 3 处，实际 ${marks}`);

  // ⑤ 时间戳存 state（不是内存变量）—— 否则重启就清零，等于绕过约束
  assert.match(SRC, /st\.qzoneWriteAt = Date\.now\(\)/,
    '写操作时间戳应当存进 state，重启不清零');
});

test('数字不能在提示词里写死，必须由桥接每轮动态注入', () => {
  // 背景（主人 2026-10-20 实测踩到）：他在控制台把间隔改成 5 小时，
  // 而 preset 里写着"至少隔 4 小时" ⇒ 她按 4 小时规划、白撞一次 429。
  //
  // 修法：preset 里删掉具体数字，由 bridge 的 buildWakePromptV2 **每轮现算**注入。

  const yaml = fs.readFileSync(
    new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url), 'utf8');

  // ① preset 里不能再出现那两个写死的具体数字
  assert.ok(!yaml.includes('至少隔 4 小时'),
    'preset 里不该再写死"至少隔 4 小时" —— 主人在控制台改过之后它就是错的');
  assert.ok(!yaml.includes('接着 **2.5 分钟**'),
    'preset 里不该再写死"2.5 分钟"');

  // ② preset 里要指引她去看动态注入的那段（否则她不知道以哪个为准）
  assert.ok(yaml.includes('自由时间（当前实际设置）'),
    'preset 里应当指引她看每轮注入的【自由时间】那段');

  // ③ bridge 里必须有动态注入
  assert.ok(SRC.includes('const autonomyLine = \'【自由时间（当前实际设置）】\'')
    || SRC.includes('【自由时间（当前实际设置）】'),
    'bridge 应当动态拼出【自由时间】那段');
  assert.match(SRC, /const _qGrantMs = /, 'bridge 应当现算静默门槛');
  assert.match(SRC, /const _gGapMs = /, 'bridge 应当现算空间写间隔');

  // ④ 必须拼进 base（所有唤醒分支共用），不能只挂在某一个分支上
  assert.match(SRC, /const base = [\s\S]{0,400}autonomyLine/,
    'autonomyLine 必须拼进 base —— 只挂某个分支的话，其它唤醒方式就看不到这些数字');

  // ⑤ 尾零不能留（6.5 显示成 "6.50" 读着别扭）
  assert.ok(!SRC.includes("h.toFixed(2)) + ' 小时'"),
    '小时数应当去掉尾零（6.5 而不是 6.50）');
});

test('静默盖章：提示词必须说清"允许≠必须"和"读不受限"', () => {
  const yaml = fs.readFileSync(
    new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url), 'utf8');
  // 主人原话："自由时间不是一定要发说说，我不希望每个对话结束她都去发说说"
  assert.ok(yaml.includes('不等于"必须"') || yaml.includes('不等于\"必须\"'),
    '提示词必须写明"允许不等于必须"——否则她拿到权就会去用');
  assert.ok(yaml.includes('别把静默期当打卡'), '提示词应当点明"别把静默期当打卡"');
  // ⚠️ 这里原来是「preset 里应当写出 2.5 分钟 / 4 小时」，已作废：
  //    那两个数字**不能在 preset 里写死** —— 主人在控制台改过之后 preset 就是错的
  //    （他实测踩到：改成 5 小时、preset 还写着 4 小时）。
  //    现在改成「preset 要指引她去看动态注入的那段」，具体值由 bridge 每轮现算。
  assert.ok(yaml.includes('自由时间（当前实际设置）'),
    'preset 应当指引她看每轮注入的【自由时间】那段，而不是自己写死数字');
  assert.ok(yaml.includes('只限制**写**'), '提示词必须说清"读不受限"，免得她以为被关起来了');
});

test('静默盖章：门槛改了就调，日志不硬编码分钟数', () => {
  // 门槛已调成 2.5 分钟，所以硬编码检查改成"不能出现任何写死的分钟数"
  assert.ok(!SRC.includes('聊完静默 3 分钟') && !SRC.includes('聊完静默 2.5 分钟'),
    '日志不能硬编码分钟数 —— 调了门槛日志会骗人（实测踩过）');
  // 改成"由门槛算出来"之后，日志用 quietMin 变量
  assert.match(SRC, /const quietMin = Math\.round\(quietGrantMs\(\) \/ 60000\)/,
    '日志里的分钟数应当由门槛算出来');
  assert.match(SRC, /const quietMin = Math\.round\(quietGrantMs\(\) \/ 60000\)/,
    '分钟数应当由门槛算出来');
});

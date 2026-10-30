// 「发现出问题要主动告诉主人」的回归测试（2026-10-20 主人要求）。
//
// 主人原话："现在小鲸鱼出现问题好像不能及时反馈给我，之前的说说出现问题都没有找我，
//            我不问出来就一直不能发现，给她加一个，让她自己发现问题qq告诉我"
//
// 背景（我查出来的真问题）：
//   · qq_report_feedback 只把内容写进 state/feedback.json（控制台能看）
//   · /api/socialV2/feedback 里那段 notifyOwnerOnError 是**占位实现** ——
//     名字叫"通知 owner"，实际只 log 一句，根本没发消息
//     ⇒ 她"反馈了"，但没有任何人收到
//
// 这组断言守的：
//   ① 占位实现必须换成真发私信（不是只写日志）
//   ② 默认口径：warning/error 推、info 只记录；支持 notify 覆盖
//   ③ 工具描述必须告诉她"会真的发私信"（否则她以为只是写日志，不会用）
//   ④ 提示词里必须有"发现出问题要告诉他"这一条
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const BRIDGE = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
const MCP = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8');
const YAML = fs.readFileSync(new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url), 'utf8');

test('反馈端点必须真的发私信，不能只写日志', () => {
  // ⚠️ 之前这里是个假的：log 一句"可通知 owner"就完事。
  assert.ok(!BRIDGE.includes('错误级反馈，可通知 owner'),
    '不能再留那句占位日志 —— 它名字叫"通知"但什么都没发');

  // 必须调 sendToQQ 发到 owner 那条私聊
  assert.match(BRIDGE, /const ownerKey = `private:\$\{cfg\.ownerQQ\}`/,
    '通知要发给 owner 的私聊');
  assert.match(BRIDGE, /sendToQQ\(ownerKey, notifyText\)/,
    '必须真的调 sendToQQ 发出去');

  // 通知失败要落日志（否则又变成"悄悄没发出去"）
  assert.match(BRIDGE, /通知主人失败：/,
    '发送失败必须记日志，不能静默吞掉');

  // 不能 await：通知失败不该让她的工具调用失败
  assert.match(BRIDGE, /不 await：通知失败不该让她的工具调用失败/,
    '通知应当异步发，不能阻塞/影响她的工具返回');
});

test('默认口径：warning/error 推、info 只记录，且支持 notify 覆盖', () => {
  assert.match(BRIDGE, /const wantNotify = typeof body\.notify === 'boolean'/,
    '要支持 body.notify 覆盖默认');
  assert.match(BRIDGE, /: \(level === 'warning' \|\| level === 'error'\);/,
    '默认口径应当是 warning/error 才推');
});

test('工具描述必须说清"会真的发私信"，并带上 notify 参数', () => {
  assert.ok(MCP.includes('会真的给他发一条 QQ 私信'),
    '工具描述必须写明会真发私信 —— 否则她以为只是写日志，根本不会用');
  assert.ok(MCP.includes('同一个问题反复发生，每次都报'),
    '描述里要写明"每次都报"（主人选定：不去重）');
  assert.match(MCP, /notify: z\.boolean\(\)\.optional\(\)/,
    '要有 notify 参数（她说"这个一定要告诉他"时用）');
  // 参数和调用体都要带上
  assert.match(MCP, /async \(\{ key, token, level, message, notify \}\)/,
    '处理函数要解构 notify');
  assert.match(MCP, /JSON\.stringify\(\{ key, level, message, notify \}\)/,
    '调用桥接接口时要传 notify');
});

test('提示词里必须有"发现出问题要告诉他"这一条', () => {
  // 之前的提示词里**完全没提** feedback —— 这是她"知道却不说"的根因
  assert.ok(YAML.includes('发现出问题，要主动告诉他'),
    '提示词要有一条讲这个');
  assert.ok(YAML.includes('qq_report_feedback'),
    '要点名工具');
  assert.ok(YAML.includes('每次都报'),
    '要写明"同一问题反复发生每次都报"');
  assert.ok(YAML.includes('通知，不是对话'),
    '要说清这是通知不是对话，免得她等回复');
  // 三句话怎么写
  assert.ok(YAML.includes('发生了什么') && YAML.includes('你试过什么') && YAML.includes('现在是什么状态'),
    '要教她怎么写：发生了什么 + 试过什么 + 现在什么状态');
});

test('提示词编号不能乱（插条目不破坏原有序号）', () => {
  // 我一开始插入时吃掉了原第 19 条的标题，导致孤儿内容 —— 这条防再犯
  const nums = [...YAML.matchAll(/^\s+(\d+)\.\s*【/gm)].map((m) => Number(m[1]));
  assert.ok(nums.length >= 18, '编号条目太少，可能被误删');

  // 必须严格递增（允许从 3 开始，因为 1-2 是别处的）
  for (let i = 1; i < nums.length; i += 1) {
    assert.ok(nums[i] > nums[i - 1],
      '编号必须递增：' + nums[i - 1] + ' 后面出现了 ' + nums[i] + '（插入新条目时破坏了顺序）');
  }
  // 申请那条的标题必须在（我一度把它删了）
  assert.ok(YAML.includes('有件事要问他：先申请'),
    '「先申请」那条的标题必须还在 —— 我曾把它的标题吃掉，内容成了孤儿');
});

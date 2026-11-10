// 管理员私聊「手眼脑」守卫的行为钉子（2026-11-10 加）。
//
// 这个测试存在的理由（真实缺口）：
//   `plugins/qq-agent-presets/qq-tool-restrict-owner.mjs` 是 qq-owner-dsh preset
//   专用的守卫，它把 read/write/edit/glob/grep/pwsh/ops_bash 这 7 个 DSH 原生
//   本地工具在**管理员私聊**里放行，其它两档（群聊 / 普通成员私聊）仍然拒绝。
//
//   但在这之前，全仓**没有任何测试钉它的判定行为**：
//     · `test-agent-preset-patches.mjs` 只校验 patch 文件把哪个守卫接到了哪个
//       preset 上（接线对不对），不校验守卫本身判得对不对；
//     · `test-tool-classification.mjs` 只跑主守卫 `qq-tool-restrict.mjs`。
//   所以如果有人把它改成「三类会话全放行」、或者把 `pwsh` 从集合里删掉，
//   56 个回归脚本会**全绿**，而群里的人就能让它在主人电脑上跑命令了。
//
// 断言（每一条都是"漏一格就红"）：
//   ① 手眼脑 7 个名字，只有 owner-private 放行；group / member-private 一律拒。
//   ② 拒绝文案必须说清「只允许管理员私聊」—— 她读到的解释得是对的。
//   ③ 集合之外的工具判定必须与主守卫**逐条一致**（不能因为换了守卫就放宽）。
//   ④ 越权面（subagent / workflow / plugin_manager / terminal_* / ops_* 整族）
//      在 owner 档仍然拒 —— 这是「手眼脑」和「能动一切」的分界。
//   ⑤ fail-closed：会话反查不到时按 member-private 处理，手眼脑全拒。
//
// 跑：node scripts/test-owner-guard.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as owner from '../plugins/qq-agent-presets/qq-tool-restrict-owner.mjs';
import * as base from '../plugins/qq-agent-presets/qq-tool-restrict.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWNER_GUARD_SRC = path.join(HERE, '..', 'plugins', 'qq-agent-presets', 'qq-tool-restrict-owner.mjs');

const OWNER = 'owner-private';
const GROUP = 'group';
const MEMBER = 'member-private';

const allow = (name, kind) => owner.verdictFor(name, kind) === undefined;
const denyReason = (name, kind) => owner.verdictFor(name, kind);

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✔ ${name}`);
  } catch (error) {
    fail++;
    console.log(`  ✘ ${name}`);
    console.log(`      ${error.message}`);
  }
}

// 「手 + 眼 + 脑」—— 与 qq-tool-restrict-owner.mjs 的 OWNER_DSH_HAND_EYE_BRAIN 一致。
// 刻意在这里重抄一遍而不是 import：这个集合本身就是被测对象，抄一遍才能发现
// 「有人悄悄改小了它」（少放一个工具 = 主人私聊里少一只手，得有人知道）。
const HAND_EYE_BRAIN = ['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'ops_bash'];

console.log('管理员私聊手眼脑守卫（qq-tool-restrict-owner）');

// ───────────────────────────────────────────────────────────────────────────
// ① 手眼脑：只有管理员私聊放行
// ───────────────────────────────────────────────────────────────────────────
console.log('\n① 手眼脑工具只在 owner-private 放行');
for (const name of HAND_EYE_BRAIN) {
  test(`${name}：owner 放行 / group 拒 / member 拒`, () => {
    assert.ok(allow(name, OWNER), `${name} 在管理员私聊里必须可用`);
    assert.ok(!allow(name, GROUP), `${name} 在群里必须拒绝`);
    assert.ok(!allow(name, MEMBER), `${name} 在普通成员私聊里必须拒绝`);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// ② 拒绝文案要说对
// ───────────────────────────────────────────────────────────────────────────
console.log('\n② 拒绝理由必须说清「只允许管理员私聊」');
for (const name of HAND_EYE_BRAIN) {
  test(`${name}：群聊与成员私聊的拒绝文案可读且指明是权限`, () => {
    for (const kind of [GROUP, MEMBER]) {
      const reason = denyReason(name, kind);
      assert.equal(typeof reason, 'string', `${name}/${kind} 必须返回字符串理由`);
      assert.ok(reason.includes('只允许管理员私聊'), `拒绝理由应写明「只允许管理员私聊」，实际：${reason}`);
      assert.ok(reason.includes(name), `拒绝理由应带上工具名，实际：${reason}`);
    }
  });
}

// ───────────────────────────────────────────────────────────────────────────
// ③ 集合之外：判定与主守卫逐条一致
// ───────────────────────────────────────────────────────────────────────────
console.log('\n③ 手眼脑之外的工具：判定与主守卫逐条一致');
const OTHERS = [
  // 越权面：派生 agent / 装插件 / 终端 / 调度
  'subagent', 'subagent_fork', 'workflow', 'skill', 'plugin_manager',
  'terminal_open', 'terminal_send', 'schedule_create', 'create_goal',
  'create_worktree', 'wait_agent', 'ralph',
  // ops_ 整族（刻意不放行 —— 只给 pwsh / ops_bash 两把刀，不给整族）
  'ops_read_files', 'ops_write_file', 'ops_glob', 'ops_grep', 'ops_replace',
  'ops_copy', 'ops_move', 'ops_remove', 'ops_stat', 'ops_diff', 'ops_subprocess',
  // QQ MCP：两类守卫都该放行（管理员私聊）
  'mcp__snowluma__qq_send_message', 'mcp__snowluma__qq_run_command',
  'mcp__snowluma__qq_screenshot', 'mcp__snowluma__qq_draw_image',
  'mcp__snowluma__qq_call_answer', 'mcp__body__body_photo',
  'mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_click',
  // DSH 原生 web
  'web_fetch', 'web_search',
];
for (const name of OTHERS) {
  for (const kind of [OWNER, GROUP, MEMBER]) {
    test(`${name} @ ${kind}：与主守卫一致`, () => {
      const o = allow(name, kind);
      const b = base.verdictFor(name, kind) === undefined;
      assert.equal(o, b,
        `${name} 在 ${kind} 档上 owner 守卫=${o ? '放行' : '拒绝'}，`
        + `主守卫=${b ? '放行' : '拒绝'} —— 两份守卫不能对同一个工具给出不同答案`);
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// ④ 越权面在 owner 档仍然拒绝
// ───────────────────────────────────────────────────────────────────────────
console.log('\n④ 越权面在管理员私聊里也必须拒绝（手眼脑 ≠ 能动一切）');
const STILL_DENIED_IN_OWNER = [
  'subagent', 'subagent_fork', 'workflow', 'plugin_manager',
  'terminal_open', 'terminal_send', 'schedule_create', 'create_worktree',
  'ops_read_files', 'ops_write_file', 'ops_remove', 'ops_subprocess',
  'ops_load_sdk', 'ops_tools', 'ops_sandbox',
];
for (const name of STILL_DENIED_IN_OWNER) {
  test(`${name}：owner 档仍然拒绝`, () => {
    assert.ok(!allow(name, OWNER), `${name} 不该在管理员私聊里放行 —— 那是越权面，不是手眼脑`);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// ⑤ fail-closed：反查不到会话 = 最不信任
// ───────────────────────────────────────────────────────────────────────────
console.log('\n⑤ fail-closed：反查不到会话时按 member-private 处理');
for (const name of HAND_EYE_BRAIN) {
  test(`${name}：反查不到会话时拒绝`, () => {
    // sessionKind 没导出（它依赖 state/sessions.json 的真实施内容），但守卫的反查
    // 失败一律落到 MEMBER_PRIVATE —— 所以验 MEMBER 档的判定就够了。
    assert.ok(!allow(name, MEMBER), `${name} 在反查不到会话时必须拒绝`);
  });
}

test('守卫源码保留 fail-closed 的三处 fallback', () => {
  const src = fs.readFileSync(OWNER_GUARD_SRC, 'utf8');
  assert.ok(/if \(key === null\) return SESSION_KIND\.MEMBER_PRIVATE/.test(src),
    'sessionKind 里「反查不到会话 ⇒ 当成 member-private」那句不能被删');
  assert.ok(/typeof sid !== 'string' \|\| sid === ''\) return SESSION_KIND\.MEMBER_PRIVATE/.test(src),
    'sessionKind 里「没有 session id ⇒ 当成 member-private」那句不能被删');
  assert.ok(/owner !== '' && key === `private:\$\{owner\}`/.test(src),
    'owner 私聊的判定必须同时要求 ownerQQ 已配且 key 完全一致');
});

test('手眼脑集合就是那 7 个名字（不能被悄悄改大或改小）', () => {
  const src = fs.readFileSync(OWNER_GUARD_SRC, 'utf8');
  const block = /const OWNER_DSH_HAND_EYE_BRAIN = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  assert.ok(block, '找不到 OWNER_DSH_HAND_EYE_BRAIN 定义');
  const names = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(names, [...HAND_EYE_BRAIN].sort(),
    `手眼脑集合变了：现在 ${names.join(',')}，本测试钉的是 ${[...HAND_EYE_BRAIN].sort().join(',')}`
    + '。改集合要同时改这个测试，并想清楚是放开了什么');
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exitCode = 1;

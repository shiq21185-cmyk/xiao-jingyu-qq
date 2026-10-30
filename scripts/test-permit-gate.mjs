// 「向我申请」闸门的判定测试 —— 直接调守卫的纯函数 verdictFor，不启动 DSH。
//
// 这个测试存在的理由：手机工具与 bili_run 的执行期卡点**只有**守卫这一处
// （它们是 DSH 直接挂的 MCP server，不经过桥接）。如果 verdictFor 的 permit 分支
// 写错（顺序错、scope 漏、fail-open），群友或普通成员就能动主人的手机/账号，
// 而且在 QQ 里看起来就是"小鲸鱼自己在玩"。
//
// ⚠️ 为什么不用真的 state/permits.json：
//   仓库的 state/ 是 ACL 收紧过的（只有属主 + SYSTEM + Administrators），
//   DSH 沙箱 / 测试进程可能根本没有写权限 —— 而且**不该**为了测试去放宽它。
//   守卫的读路径按 findRepoRoot() 找仓库根，所以这里改用「临时目录 + 一份最小仓库骨架」：
//   放一个 state/sessions.json（owner 映射）+ config.json（ownerQQ），
//   再把它当仓库根来验证。这样测试既隔离又不需要碰生产状态。
//
// 跑：node scripts/test-permit-gate.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  privilegeMatrix,
  verdictFor,
  permitGatedTools,
  permitScopeOf
} from '../plugins/qq-agent-presets/qq-tool-restrict.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 夹具里的号码是**假的**：曾经在这里写真实 ownerQQ / 好友 / 群号，
// 那些值会随测试一起进 git 历史。测试只要求「有号码可用」，具体数字无意义。
const OWNER_QQ = '100000001';
const FRIEND_QQ = '100000002';
const GROUP_QQ = '100000003';
const OWNER = `private:${OWNER_QQ}`;
const OWNER_SID = 'session-test-owner';
const GROUP_SID = 'session-test-group';
const MEMBER_SID = 'session-test-member';

/**
 * 伪造一份仓库骨架，让守卫的 ownerLookup() 读到我们想要的映射。
 *
 * 关键点：守卫是**按它自己文件的位置**往上找仓库根的（findRepoRoot），
 * 所以不能只改状态文件 —— 得把守卫模块也放进那个骨架里。
 * 做法：把真实的 qq-tool-restrict.mjs 复制进临时骨架的 plugins/qq-agent-presets/，
 * 它 import 的只有 node 内置模块，复制过去能独立跑。
 *
 * 这也顺带证明了一件事：守卫不依赖仓库里任何别的文件，单独搬走仍然工作。
 */
function makeSandbox({ ownerQQ = OWNER_QQ, sessions = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-gate-'));
  const guardDir = path.join(dir, 'plugins', 'qq-agent-presets');
  fs.mkdirSync(guardDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs'),
    path.join(guardDir, 'qq-tool-restrict.mjs')
  );
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ ownerQQ, allow: { private: [Number(OWNER_QQ), Number(FRIEND_QQ)], groups: [Number(GROUP_QQ)] } }, null, 2)
  );
  fs.writeFileSync(
    path.join(dir, 'state', 'sessions.json'),
    JSON.stringify({ sessions }, null, 2)
  );
  return dir;
}

function writePermits(dir, grants) {
  fs.writeFileSync(
    path.join(dir, 'state', 'permits.json'),
    JSON.stringify({ version: 1, grants, requests: {} }, null, 2) + '\n',
    'utf8'
  );
}

// 每个沙箱都要 import 一份"自己的"守卫：模块路径不同 ⇒ 各自独立的缓存，
// 也各自按自己的位置找仓库根。动态 import 用 cache-busting query 保证不复用。
let sandboxSeq = 0;
async function loadGuard(dir) {
  const file = path.join(dir, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
  sandboxSeq += 1;
  return import(`file://${file.replace(/\\/g, '/')}?v=${sandboxSeq}`);
}

const GATED = permitGatedTools();
assert.ok(GATED.length > 0, '应当至少有一个需要申请的工具');

// ── 1. 名单本身（不依赖沙箱）────────────────────────────────────────────────
{
  const scopes = new Set(GATED.map((g) => g.scope));
  assert.deepEqual([...scopes].sort(), ['bili', 'phone']);
  assert.ok(GATED.some((g) => g.tool === 'bili_run'), 'bili_run 必须需要申请');
  // 只读的手机工具不该被闸门挡住，否则她连"设备在不在线"都判断不了
  assert.equal(permitScopeOf('mcp__phone__phone_status'), null);
  assert.equal(permitScopeOf('mcp__phone__phone_flows'), null);
  // 截图必须挡住（它能看到主人屏幕上的东西）
  assert.equal(permitScopeOf('mcp__phone__phone_screen'), 'phone');
  assert.equal(permitScopeOf('mcp__phone__phone_game_move'), 'phone');
  // 不在名单里的工具返回 null
  assert.equal(permitScopeOf('mcp__snowluma__qq_send_message'), null);
  assert.equal(permitScopeOf(undefined), null);
}

// ── 2. 群聊 / 普通成员：授权文件写了也没用（最关键的一条）──────────────────
{
  const dir = makeSandbox({
    sessions: { [OWNER]: OWNER_SID, [`group:${GROUP_QQ}`]: GROUP_SID, [`private:${FRIEND_QQ}`]: MEMBER_SID }
  });
  const now = Date.now();
  const full = {
    [`group:${GROUP_QQ}`]: { phone: { expiresAt: now + 3600000 }, bili: { expiresAt: now + 3600000 } },
    [`private:${FRIEND_QQ}`]: { phone: { expiresAt: now + 3600000 }, bili: { expiresAt: now + 3600000 } }
  };
  writePermits(dir, full);
  const g = await loadGuard(dir);

  const groupReason = g.verdictFor('mcp__phone__phone_tap', 'group', { agent: { session: { id: GROUP_SID } } });
  assert.ok(typeof groupReason === 'string', '群聊永远不能拿到手机工具');
  assert.ok(groupReason.includes('管理员私聊'), `群聊拒绝理由应说明只给管理员私聊，实际：${groupReason}`);

  const memberReason = g.verdictFor('mcp__phone__phone_screen', 'member-private', { agent: { session: { id: MEMBER_SID } } });
  assert.ok(typeof memberReason === 'string', '普通成员私聊永远不能拿到手机工具');
  assert.ok(memberReason.includes('管理员私聊'));

  assert.ok(typeof g.verdictFor('bili_run', 'group', { agent: { session: { id: GROUP_SID } } }) === 'string');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✔ 群聊/普通成员：写了授权也拿不到（fail-closed）');
}

// ── 3. 没有授权时：owner 私聊也拒绝，且理由要说清"去申请"────────────────────
{
  const dir = makeSandbox({ sessions: { [OWNER]: OWNER_SID } });
  writePermits(dir, {});
  const g = await loadGuard(dir);
  const agent = { session: { id: OWNER_SID } };

  const reason = g.verdictFor('mcp__phone__phone_tap', 'owner-private', { agent });
  assert.ok(typeof reason === 'string' && reason.includes('qq_request_permission'),
    `没有授权时必须给出申请指引，实际：${reason}`);
  const bili = g.verdictFor('bili_run', 'owner-private', { agent });
  assert.ok(typeof bili === 'string' && bili.includes('qq_request_permission'));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✔ owner 私聊但没申请：拒绝 + 给出申请指引');
}

// ── 4. 有授权时 owner 放行；按 scope 分别授权；过期立刻失效 ────────────────
{
  const dir = makeSandbox({ sessions: { [OWNER]: OWNER_SID } });
  const agent = { session: { id: OWNER_SID } };
  const now = Date.now();
  writePermits(dir, { [OWNER]: { phone: { expiresAt: now + 60000, grantedAt: now, requestId: 't', why: '测试' } } });
  const g = await loadGuard(dir);

  assert.equal(g.verdictFor('mcp__phone__phone_tap', 'owner-private', { agent }), undefined,
    '有效授权期间必须放行');
  // bili 没被授权 → 仍然拒绝（一张票不能通吃两类）
  assert.ok(typeof g.verdictFor('bili_run', 'owner-private', { agent }) === 'string');

  // 过期：守卫的缓存是 2 秒，这里等过缓存再读（生产里也是这个口径）
  writePermits(dir, { [OWNER]: { phone: { expiresAt: now - 1, grantedAt: now - 999, requestId: 't', why: '' } } });
  await new Promise((r) => setTimeout(r, 2100));
  assert.ok(typeof g.verdictFor('mcp__phone__phone_tap', 'owner-private', { agent }) === 'string',
    '过期授权必须失效');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✔ owner 有授权才放行 / scope 各自独立 / 过期失效');
}

// ── 5. 拒绝优先：BILI_DENIED 不会被 permit 分支放过去 ──────────────────────
{
  const dir = makeSandbox({ sessions: { [OWNER]: OWNER_SID } });
  const now = Date.now();
  writePermits(dir, { [OWNER]: { bili: { expiresAt: now + 3600000 } } });
  const g = await loadGuard(dir);

  // 就算给了 bili 授权，改设置/登录这类仍然必须拒（它们根本不在 permit 名单里）
  assert.ok(typeof g.verdictFor('bili_config', 'owner-private') === 'string');
  assert.ok(typeof g.verdictFor('bili_login_start', 'owner-private') === 'string');
  // 只读的 bili_search 一直放行，不需要申请
  assert.equal(g.verdictFor('bili_search', 'group'), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✔ 拒绝优先：bili_config/bili_login 仍被拒');
}

// ── 6. fail-closed：没有仓库根 / 坏文件 / 没有 sessions 映射 ────────────────
{
  // ① 没有 sessions 映射 ⇒ 归为 member-private ⇒ 手机工具被拒
  const dir = makeSandbox({ sessions: {} });
  writePermits(dir, { [OWNER]: { phone: { expiresAt: Date.now() + 3600000 } } });
  const g = await loadGuard(dir);
  assert.ok(typeof g.verdictFor('mcp__phone__phone_tap', 'member-private', { agent: { session: { id: 'unknown-sid' } } }) === 'string');
  fs.rmSync(dir, { recursive: true, force: true });

  // ② 授权文件是坏 JSON ⇒ 当成没有授权（owner 也要被拒）
  const dir2 = makeSandbox({ sessions: { [OWNER]: OWNER_SID } });
  fs.writeFileSync(path.join(dir2, 'state', 'permits.json'), '{ this is not json', 'utf8');
  const g2 = await loadGuard(dir2);
  assert.ok(typeof g2.verdictFor('mcp__phone__phone_tap', 'owner-private', { agent: { session: { id: OWNER_SID } } }) === 'string',
    '坏授权文件必须 fail-closed');
  fs.rmSync(dir2, { recursive: true, force: true });
  console.log('✔ fail-closed：缺映射 / 坏文件都当作没有授权');
}

// ── 7. 权能矩阵必须把新分组建出来（控制台页面靠它）───────────────────────
{
  const matrix = privilegeMatrix();
  const group = matrix.groups.find((x) => x.id === 'permit-gated');
  assert.ok(group, '权能矩阵必须有一个「要申请才放行」分组');
  assert.ok(group.tools.includes('mcp__phone__phone_game_move'));
  assert.ok(group.tools.includes('bili_run'));
  // 同一个工具不能同时出现在 permit-gated 与 bili-owner 里（否则界面自相矛盾）
  const ownerGroup = matrix.groups.find((x) => x.id === 'bili-owner');
  assert.ok(!ownerGroup.tools.includes('bili_run'), 'bili_run 已归入申请闸门，不该再出现在 bili-owner');
  console.log('✔ 权能矩阵分组与判定一致');
}

console.log('\npermit gate: all checks passed');

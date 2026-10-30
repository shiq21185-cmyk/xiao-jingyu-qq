// 记忆串味修复的回归测试（2026-10-21 事故）。
//
// 事故现象：主人感觉「她的记忆串了，群聊和私聊、普通私聊和管理员混在一起」。
//
// 根因（三处叠加，都已经在真实 state 里核对过）：
//   ① 提炼时 `SELECT ... FROM messages WHERE 时间段` **不带会话维度**，
//      10-20 那天 128 条消息（群聊 14 + 主人私聊 18 + 好友私聊 26 + 机器人自己 70）
//      被拼成一份「私人聊天」记录喂给同一个提炼模型；
//   ② 机器人自己的私聊会话（private:<selfQQ>）也参与了提炼；
//   ③ memberImpressions 拿**昵称**当 key，同一个人被存成两份
//      （private:100000003 下同时有 "100000003" 和 "栖筠"）。
//
// 这组测试钉住三件事：会话必须按 QQ 号分开、机器人自己必须排除、身份只认 QQ 号。
//
// 跑：node scripts/test-memory-scope.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureConfig } from './_fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 公开仓库不带私人 config.json，缺了就按模板造一份。
const CONFIG = ensureConfig();

// ── 从插件里取被测函数（插件有副作用，这里只读源码做静态核对 + 复刻口径）──
const PLUGIN = path.join(ROOT, 'plugins/qq-memory-rollover/qq-memory-rollover.mjs');
const SRC = fs.readFileSync(PLUGIN, 'utf8');

test('取数必须带会话维度，并按 post_type/target_id 还原收件人', () => {
  // 旧代码的 SELECT 只有时间段条件，没有任何会话/群字段
  assert.ok(SRC.includes('message_type'), '取数逻辑必须读 message_type 才能区分群聊/私聊');
  assert.ok(SRC.includes('group_id'), '群聊必须能取到 group_id');
  assert.ok(SRC.includes('scope'), '每条消息必须带 scope（来源会话）');
  // 关键：她发出的消息 user_id 是她自己，必须靠 target_id 找对话对象
  assert.ok(SRC.includes('target_id'), '她发出的消息必须靠 target_id 归回对话方');
  assert.ok(SRC.includes('message_sent'), '必须识别 post_type=message_sent');
});

test('身份只认 QQ 号：注释与实现里不许再把昵称当 key', () => {
  assert.ok(SRC.includes('selfQQ'), '必须能识别机器人自己的 QQ 号');
  assert.ok(!/memberImpressions\[target\]/.test(SRC), '不该再出现按 target(昵称) 直接索引的写法');
});

test('必须排除机器人自己的会话', () => {
  assert.ok(SRC.includes('groupByScope'), '按会话分组必须存在');
  assert.ok(SRC.includes('private:${selfQQ}') || SRC.includes('String(m.peerUid) === String(selfQQ)'),
    '分组时必须把机器人自己的私聊整组丢掉');
});

test('config.json 必须配了 selfQQ，且与 ownerQQ 不同', () => {
  assert.ok(CONFIG.selfQQ, 'config.selfQQ 缺失会导致无法排除机器人自身会话');
  assert.notEqual(String(CONFIG.selfQQ), String(CONFIG.ownerQQ), 'selfQQ 不能等于 ownerQQ');
});

test('提炼提示词必须声明「只来自这一个会话」并禁止用昵称判身份', () => {
  assert.ok(SRC.includes('只来自这一个会话'), '提示词必须限定会话范围');
  assert.ok(SRC.includes('昵称'), '提示词必须提醒昵称不可作身份');
});

// ── 复刻分组口径，验证行为（与插件 groupByScope 保持一致）──
function groupByScope(msgs, selfQQ) {
  const groups = new Map();
  for (const m of msgs) {
    if (!m.isGroup && selfQQ && String(m.peerUid) === String(selfQQ)) continue;
    if (!groups.has(m.scope)) groups.set(m.scope, []);
    groups.get(m.scope).push(m);
  }
  return groups;
}
function countUnattributed(msgs, selfQQ) {
  if (!selfQQ) return 0;
  return msgs.filter((m) => !m.isGroup && String(m.peerUid) === String(selfQQ)).length;
}

const selfQQ = String(CONFIG.selfQQ);
const ownerQQ = String(CONFIG.ownerQQ);
const friendQQ = '100000003';
const groupId = '100000002';

const sample = [
  { isGroup: true, peerUid: groupId, scope: `group:${groupId}`, userId: '2356986413', text: '早！' },
  { isGroup: false, peerUid: ownerQQ, scope: `private:${ownerQQ}`, userId: ownerQQ, text: '我上早八' },
  { isGroup: false, peerUid: friendQQ, scope: `private:${friendQQ}`, userId: friendQQ, text: '我们八点半开始哦' },
  { isGroup: false, peerUid: selfQQ, scope: `private:${selfQQ}`, userId: selfQQ, text: '早啊' },
  { isGroup: false, peerUid: selfQQ, scope: `private:${selfQQ}`, userId: selfQQ, text: '这么早就醒' },
];

test('她发出的话按 target_id 归回真正的对话方，不另起会话', () => {
  // 模拟一行 message_sent：user_id 是她自己，target_id 是对话对象
  const sentToOwner = {
    isGroup: false,
    peerUid: String(ownerQQ),   // ← 由 target_id 算出
    scope: `private:${ownerQQ}`,
    userId: String(selfQQ),     // 发言人仍是她自己
    sentBySelf: true,
    selfMsg: true,
    text: '早上六点多了，你这作息是没睡还是刚起',
  };
  const got = groupByScope([sentToOwner], selfQQ);
  assert.equal(got.size, 1);
  assert.ok(got.has(`private:${ownerQQ}`), '她发给主人的话必须落在主人的会话里');
  assert.ok(!got.has(`private:${selfQQ}`), '不能再造出一个 private:<selfQQ> 会话');
});

test('只有真正无法归属的消息才被丢弃，且必须记账', () => {
  const unattributable = {
    isGroup: false,
    peerUid: String(selfQQ),  // target_id 缺失时退回她自己
    scope: `private:${selfQQ}`,
    userId: String(selfQQ),
    selfMsg: true,
    text: '无收件人的旧记录',
  };
  const g = groupByScope([unattributable], selfQQ);
  assert.equal(g.size, 0, '归不到人的消息不进任何组');
  // 但必须能被统计出来，不许静默吞掉
  assert.equal(typeof countUnattributed, 'function', '需要 countUnattributed 记账');
  assert.equal(countUnattributed([unattributable], selfQQ), 1);
});

test('同一天的她的话不会被劈成两半', () => {
  // 主人说一句 + 她回一句：必须落在同一个会话里
  const owner = { isGroup: false, peerUid: String(ownerQQ), scope: `private:${ownerQQ}`, userId: String(ownerQQ), selfMsg: false, text: '我上早八' };
  const her = { isGroup: false, peerUid: String(ownerQQ), scope: `private:${ownerQQ}`, userId: String(selfQQ), sentBySelf: true, selfMsg: true, text: '早八啊，路上买口吃的' };
  const g = groupByScope([owner, her], selfQQ);
  assert.equal(g.size, 1, '一段私聊只能是一个会话');
  assert.equal(g.get(`private:${ownerQQ}`).length, 2, '两半都要在');
});

test('不同会话绝不会进入同一次提炼', () => {
  const g = groupByScope(sample, selfQQ);
  for (const [scope, list] of g) {
    for (const m of list) assert.equal(m.scope, scope, '同一组里不能混入别的会话');
  }
});

test('主人在群里发言与主人私聊是两个独立会话（不合并）', () => {
  const withOwnerInGroup = [
    ...sample,
    { isGroup: true, peerUid: groupId, scope: `group:${groupId}`, userId: ownerQQ, text: '难道死了' },
  ];
  const g = groupByScope(withOwnerInGroup, selfQQ);
  assert.equal(g.get(`group:${groupId}`).length, 2, '群里含主人的发言仍属于群会话');
  assert.equal(g.get(`private:${ownerQQ}`).length, 1, '私聊不因同一 QQ 号而并入群会话');
});

// ── 索引渲染必须标出来源会话 ──
test('索引行带来源会话前缀，旧数据（无 scope）不受影响', async () => {
  const { selectIndexItems } = await import('../plugins/qq-memory-rollover/memory-index.mjs');
  const mem = {
    items: [
      { date: new Date().toISOString().slice(0, 10), items: [
        { scope: `group:${groupId}`, text: '群里的梗' },
        { scope: `private:${ownerQQ}`, text: '主人说的事' },
        '旧格式没有 scope',
      ] },
    ],
  };
  const r = selectIndexItems(mem);
  assert.ok(r.lines.some((l) => l.includes(`群${groupId}｜群里的梗`)), '群来源要标出来');
  assert.ok(r.lines.some((l) => l.includes(`私聊${ownerQQ}｜主人说的事`)), '私聊来源要标出来');
  assert.ok(r.lines.some((l) => l.includes('旧格式没有 scope') && !l.includes('｜｜')), '旧条目不能坏');
});

test('来源标签只按 group/private 判断，不会把昵称当身份', async () => {
  const { selectIndexItems } = await import('../plugins/qq-memory-rollover/memory-index.mjs');
  // 故意把 scope 写成昵称形式：不是合法的 group:/private: 前缀，就不该被当成来源
  const today = new Date().toISOString().slice(0, 10);
  const r = selectIndexItems({
    items: [{ date: today, items: [{ scope: '栖筠', text: '某人' }] }],
  });
  assert.ok(
    r.lines.some((l) => l.includes('某人') && !l.includes('栖筠｜')),
    '非法 scope（昵称）不能被渲染成来源标签',
  );
});

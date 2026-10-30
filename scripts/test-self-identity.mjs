// 【你的身份】注入的回归（2026-10-21，来源：上游 issue #29「被 @ 了不理人」）。
//
// ── 为什么必须有这个文件 ──────────────────────────────────────────────────
// agent 能看到的消息里只有 `@小鲸鱼` 这串**文本**。桥接内部知道那是自己
// （nameMention 判定用的就是 selfNickname），但 **agent 不知道** —— 没人告诉它
// 「小鲸鱼」= 它自己。于是它把「@自己」当成「@别人」，已读不回或答非所问。
//
// 这不是「可能」：上游 issue #29 就是这么复现的。更麻烦的是它**只在群里被 @ 时显现**，
// 自检和单聊都正常，所以特别容易漏。
//
// ── 这个文件钉住什么 ──────────────────────────────────────────────────────
//   ① 身份行必须真的进到唤醒 prompt 里（不是只存在于某个变量里）
//   ② 昵称与 QQ 号都要出现 —— 群名片可能与昵称不同，at/引用段里带的是号码
//   ③ 收尾提醒（buildWakeReminderPromptV2）也要带，因为那一轮她照样要看新消息
//   ④ 身份未知时**不注入空行**（「你的昵称是（）」比不注入更糟：她可能真以为名字叫「（）」）
//
// 跑：node scripts/test-self-identity.mjs
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
let passes = 0;

async function test(name, run) {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    run(h);
    passes++;
    console.log('PASS', name);
  } catch (error) {
    failures++;
    console.error('FAIL', name, '→', error.message);
  } finally {
    await h.close();
  }
}

const KEY = 'group:1001';

console.log('— 1. 身份行真的进了唤醒 prompt —');
await test('昵称与 QQ 号都出现在唤醒提示词里', async (h) => {
  h.setSelfIdentity('小鲸鱼', '10001');
  h.state.sessions[KEY] = 'session-1';
  const prompt = h.buildWakePromptV2(KEY, 'atMention');
  assert.match(prompt, /【你的身份】/, '唤醒 prompt 必须带身份段');
  assert.match(prompt, /小鲸鱼/, '必须写明昵称');
  assert.match(prompt, /10001/, '必须写明 QQ 号（at/引用段里带的是号码）');
});

await test('明确说出「@昵称」指的是自己', async (h) => {
  h.setSelfIdentity('小鲸鱼', '10001');
  h.state.sessions[KEY] = 'session-1';
  const prompt = h.buildWakePromptV2(KEY, 'atMention');
  assert.match(prompt, /@小鲸鱼/, '必须点明「@昵称」这种写法');
  assert.match(prompt, /别当成别人/, '必须明确「指的都是你」这层语义');
});

await test('身份段排在角色段之后、令牌段之前（先知道我是谁）', async (h) => {
  h.setSelfIdentity('小鲸鱼', '10001');
  h.state.sessions[KEY] = 'session-1';
  const prompt = h.buildWakePromptV2(KEY, 'atMention');
  const iRole = prompt.indexOf('【当前角色】');
  const iId = prompt.indexOf('【你的身份】');
  const iToken = prompt.indexOf('【会话令牌】');
  assert.ok(iId >= 0, '缺身份段');
  if (iRole >= 0) assert.ok(iRole < iId, '角色段应该在身份段之前');
  if (iToken >= 0) assert.ok(iId < iToken, '身份段应该在令牌段之前');
});

console.log('— 2. 收尾提醒也要带身份 —');
await test('buildWakeReminderPromptV2 带身份段', async (h) => {
  h.setSelfIdentity('小鲸鱼', '10001');
  h.state.sessions[KEY] = 'session-1';
  const reminder = h.buildWakeReminderPromptV2(KEY);
  assert.match(reminder, /【你的身份】/, '收尾提醒也要带身份（那一轮同样要看新消息）');
  assert.match(reminder, /小鲸鱼/);
});

console.log('— 3. 身份未知时不注入空行 —');
await test('昵称和号码都为空 → 返回空串，不注入', async (h) => {
  h.setSelfIdentity('', '');
  assert.equal(h.selfIdentityTextV2(), '', '身份未知时必须是空串');
  h.state.sessions[KEY] = 'session-1';
  const prompt = h.buildWakePromptV2(KEY, 'timeout');
  assert.doesNotMatch(prompt, /【你的身份】/, '不能注入「你的昵称是（）」这种半截话');
});

await test('只有昵称也能用（号码缺失时不硬凑）', async (h) => {
  h.setSelfIdentity('小鲸鱼', '');
  const text = h.selfIdentityTextV2();
  assert.match(text, /小鲸鱼/);
  assert.doesNotMatch(text, /QQ \)/, '号码缺失时不能出现空的 QQ 括号');
  assert.match(text, /你的 QQ 号/, '应该退化成「带你的 QQ 号就是在叫你」的说法');
});

await test('只有号码也能用', async (h) => {
  h.setSelfIdentity('', '10001');
  const text = h.selfIdentityTextV2();
  assert.match(text, /10001/);
  assert.match(text, /昵称还没取到/, '昵称缺失时要说明，不能装作知道');
});

console.log(`\n结果: ${passes} 通过 / ${failures} 失败`);
process.exit(failures ? 1 : 0);

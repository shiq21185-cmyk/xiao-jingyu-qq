// 「她玩游戏时不理主人」那条修复的回归（2026-10-22 主人当场报的问题）。
//
// 现象：主人发了三条消息（10:17 / 10:23 / 10:24），桥接日志全是
//   「会话繁忙，暂存唤醒原因」—— 因为她一个回合从 10:01 连跑到 10:24（在玩网页游戏）。
//
// 根因（读 DSH 源码确认，不是猜）：
//   `session.prompt` 的 `mode` 有两种（dsh-host-apiproxy 的 sessionPromptRequestSchema）：
//     · 'queue' → agent.followup(message)：**等当前回合彻底结束**才当成下一轮；
//     · 'steer' → agent.steer(message)：插进**正在跑的回合**（inbox 的 next-step，
//                placement='steering'），下一步就看得见。
//   桥接一直只用 'queue' ⇒ 长回合里主人说话等于石沉大海。
//
// 这个测试钉住四件事（全部纯静态 + 纯函数，不碰真会话、不花 token）：
//   ① 即时消息（无 wakeReason）走 steer；定时唤醒仍走 queue；
//   ② steer 被拒要**退回 queue**，不能把主人的话丢掉；
//   ③ 只有"主人私聊 + 有人当场说话"才允许插队（群里/普通成员/她自己的节奏都不许）；
//   ④ 两处"会话繁忙"分支都真的尝试过 steer（不再只会排队）。
//
// 跑：node --test scripts/test-steer-while-busy.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

console.log('— 1. 即时消息走 steer，定时唤醒走 queue —');
test('promptMode 由「有没有 wakeReason」决定，即时消息是 steer', () => {
  assert.match(src, /const promptMode = opts\.wakeReason \? 'queue' : 'steer'/,
    '没有 wakeReason（= 有人当场说话）必须走 steer；带 wakeReason（定时唤醒/主动机会）仍走 queue');
});

test('真正投递时用的是 promptMode，不是写死的 queue', () => {
  assert.match(src, /api\.sessions\.prompt\(\{ sessionId, mode: promptMode, content \}\)/,
    '投递那行必须用 promptMode —— 写死 queue 就是这次的问题本身');
  // 别处（黑话学习等）仍可以显式用 queue，那是"排队做别的事"，不是"回人话"
  const hardcoded = [...src.matchAll(/api\.sessions\.prompt\(\{ sessionId, mode: 'queue'/g)];
  assert.ok(hardcoded.length <= 3, `写死 queue 的地方不该继续增加（现在 ${hardcoded.length} 处，都是黑话/研究这类后台任务）`);
});

console.log('— 2. steer 被拒必须退回 queue（不能把主人的话弄丢）—');
test('steer 失败会重投一次 queue，并留日志', () => {
  const i = src.indexOf("const promptMode = opts.wakeReason ? 'queue' : 'steer'");
  const block = src.slice(i, i + 1800);
  assert.match(block, /if \(promptMode === 'steer'\)/, '要有专门的 steer 失败分支');
  assert.match(block, /api\.sessions\.prompt\(\{ sessionId, mode: 'queue', content \}\)/, '失败后要真的用 queue 重投');
  assert.match(block, /steer 失败.*退回 queue/, '要留日志，否则以后查不到"这条消息绕了路"');
  // 重投也失败时要抛出，别静默吞掉
  assert.match(block, /throw retryError/, '两条路都失败必须抛出，不能静默');
});

console.log('— 3. 谁能插队：只给「主人私聊 + 有人当场说话」—');
test('STEERABLE_WAKE_REASONS 包含"人说话"那几种，不包含她自己的节奏', () => {
  const i = src.indexOf('const STEERABLE_WAKE_REASONS = new Set([');
  assert.ok(i > 0, '应该有 STEERABLE_WAKE_REASONS');
  const block = src.slice(i, src.indexOf(']);', i));
  for (const must of ['private', 'admin', 'atMention', 'question', 'poke']) {
    assert.match(block, new RegExp(`'${must}'`), `${must}（有人当场说话）应该允许插队`);
  }
  for (const never of ['proactiveCheck', 'timeout', 'replyCheck', 'bootstrap']) {
    assert.doesNotMatch(block, new RegExp(`'${never}'`),
      `${never} 是她自己的节奏/系统唤醒，插进去只会打断她 —— 必须仍然排队`);
  }
});

test('canSteerV2 只认主人私聊，且只认 reserved2 模式', () => {
  const i = src.indexOf('function canSteerV2(');
  assert.ok(i > 0, '应该有 canSteerV2');
  const block = src.slice(i, src.indexOf('\n  }', i));
  assert.match(block, /currentMode !== 'reserved2'/, '非 reserved2 模式不该有这套打断机制');
  assert.match(block, /cfg\.ownerQQ/, '要先有 ownerQQ');
  assert.match(block, /key !== `private:\$\{String\(cfg\.ownerQQ\)\}`/, '只认主人私聊 —— 群里/普通成员私聊不许插队');
  assert.match(block, /STEERABLE_WAKE_REASONS\.has/, '还得是"有人说话"那几种原因');
});

console.log('— 4. 两处"会话繁忙"分支都真的试过 steer —');
test('scheduleWakeV2 和 sendWakePromptV2 的繁忙分支都调用 steerIntoRunningTurnV2', () => {
  const hits = [...src.matchAll(/const steered = await steerIntoRunningTurnV2\(key, reason, seq\)/g)];
  assert.equal(hits.length, 2,
    `两处繁忙分支都要试 steer（现在 ${hits.length} 处）—— 只改一处的话另一条路径照样"不理人"`);
  // 两处都要在 steer 失败时退回排队
  const fallbacks = [...src.matchAll(/steer 未成功（\$\{steered\.error\}），退回排队/g)];
  assert.equal(fallbacks.length, 2, '两处都要有"退回排队"的日志');
});

test('steer 的提示词要讲清"别装没看见，也别丢掉手上的事"', () => {
  const i = src.indexOf('async function steerIntoRunningTurnV2(');
  const block = src.slice(i, i + 2000);
  assert.match(block, /插话/, '要让她认出这是插话，不是新任务');
  assert.match(block, /别装没看见/, '核心要求：有人说话就得听见');
  assert.match(block, /别丢掉手上那件事|可以继续/, '也不能因为一句话就把正在做的事扔了');
  assert.match(block, /api\.sessions\.prompt\(\{ sessionId, mode: 'steer'/, '插入要用真的 steer');
});

test('steer 只用轻量提示，不塞完整 wake prompt（避免把长回合又撑大）', () => {
  const i = src.indexOf('async function steerIntoRunningTurnV2(');
  const block = src.slice(i, i + 2600);
  assert.doesNotMatch(block, /buildWakePromptV2/,
    'insert 一条完整 wake prompt 会把她正在做的事彻底打断，而且很贵 —— 这里只要"你说话了"这句话');
});

console.log('— 5. 原来的排队机制没被删掉（没有 steer 支持的场景还得靠它）—');
test('pendingWakeReasons 队列仍然存在，且有界', () => {
  assert.match(src, /st\.pendingWakeReasons\.push\(\{ reason, seq \}\)/, '排队仍要保留');
  assert.match(src, /pendingWakeReasons\.length > 20/, '有界（最多 20 条）不能被删');
  // 补发逻辑还在
  assert.match(src, /补发繁忙期间积压的唤醒/, '回合结束后补发积压唤醒的逻辑要保留');
});

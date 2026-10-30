// 网页游戏执行层的回归（2026-10-22，按主人「你可以再测试测试」之后补的）。
//
// 这一天连踩三个坑，每个都只在**真跑**时才暴露，静态检查全查不出：
//
//   ① `waitUntilIdle` 只看"待决的人是不是她" → 拿提交前的快照当结果，
//      表现为"掷了骰子还要再掷"。
//   ② 改成"先观察她离开、再等她回来" → 踩采样盲区（页面是一次同步跳变，
//      250ms 采样采不到中间态），于是一直等满超时：**每步 5190ms**，而读一次只要 4ms。
//   ③ 用"局面指纹变了"判断 → 又出现另一种慢：AI 连走多步时，硬等它走完会把单步
//      拖到 6 秒以上。她关心的是"我这一步生效了吗"，不是"AI 走完了吗"。
//
// 所以这个测试守的是**这三条的判据**，以及"至少 2 名玩家"这个游戏规则边界。
// ⚠️ 它是静态 + 纯函数验证（不启动浏览器），因为真跑需要主人的 Edge。
//    真跑的压测脚本在 _tmp/stress-long.mjs（40 步 + 5 次重启，见 DEVLOG）。
//
// 跑：node --test scripts/test-games-runtime.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const runtime = read('src/games/browser-runtime.js');
const server = read('src/mcp-games.js');

console.log('— 1. 等局面稳定：判据必须是"状态真的变了" —');
test('waitUntilIdle 接收"提交前的局面"并算指纹（不能只看待决者是谁）', () => {
  assert.match(runtime, /async waitUntilIdle\(tab, before, waitMs/, '要传入提交前的局面');
  assert.match(runtime, /const sig = \(b\) =>/, '要有局面指纹函数');
  assert.match(runtime, /const beforeSig = sig\(before\)/, '要记下提交前的指纹');
  assert.match(runtime, /if \(sig\(b\) === beforeSig\) continue;/, '指纹没变 ⇒ 页面还没处理，继续等');
  // 关键：不能只靠"观察到她离开"（采样盲区）
  assert.doesNotMatch(runtime, /let leftHerTurn = false/, '不能再用"观察到离开"的判据 —— 那是采样盲区');
});

test('act 在提交**之前**就记下局面（否则拿不到正确的对比基线）', () => {
  const i = runtime.indexOf('async act(tab, actionId');
  const block = runtime.slice(i, i + 1200);
  const beforeAt = block.indexOf('beforeBoard = await this.observe(tab)');
  const submitAt = block.indexOf('window.__GAME_IO__.act(');
  assert.ok(beforeAt > 0, 'act 里要记提交前的局面');
  assert.ok(submitAt > 0, 'act 里要提交选择');
  assert.ok(beforeAt < submitAt, '必须先记局面再提交 —— 顺序反了就拿到提交后的快照');
});

console.log('— 2. AI 回合不要硬等（否则单步从 215ms 变 6000ms）—');
test('停在 AI 回合时直接返回，并把 aiStillPlaying 报上去', () => {
  assert.match(runtime, /why: 'ai-turn'/, '要有"在 AI 回合就返回"的分支');
  assert.match(runtime, /aiStillPlaying: true/, '要如实说 AI 还在走（她可以据此决定要不要再看一眼）');
});

test('轮询间隔不要过大（大于 500ms 会明显拖慢每步）', () => {
  // 找 waitUntilIdle 里那个轮询 setTimeout 的数字（不依赖具体换行/缩进）
  const i = runtime.indexOf('async waitUntilIdle');
  assert.ok(i > 0, '应该有 waitUntilIdle');
  const block = runtime.slice(i, i + 1600);
  const m = block.match(/setTimeout\(r,\s*(\d+)\)/);
  assert.ok(m, '应该有轮询间隔');
  const ms = Number(m[1]);
  assert.ok(ms <= 500, `轮询间隔 ${ms}ms 太大 —— 实测 250ms 时每步 215ms，更大就明显变慢`);
});

console.log('— 3. 至少 2 名玩家（游戏自己的规则）—');
test('aiCount 被夹到 [1,3]，并如实告诉她调整过', () => {
  assert.match(server, /const n = Math\.max\(1, Math\.min\(3, wanted\)\)/, 'aiCount 最小 1（游戏要求至少 2 名玩家）');
  assert.match(server, /const aiAdjusted = n !== wanted/, '要记录"是否调整过"');
  assert.match(server, /至少要 2 名玩家/, '要如实说明为什么按 1 个开');
});

console.log('— 4. 重新开始不能碰原生 confirm（它会锁死页面）—');
test('回设置页走接口，不点带 confirm 的按钮', () => {
  assert.match(runtime, /restartToSetup/, '要走接口里的 restartToSetup');
  // 不能去点 btn-restart —— 那个 handler 里有 confirm()，会冻住整个页面 JS 线程
  assert.doesNotMatch(runtime, /getElementById\('btn-restart'\)/,
    '绝不能去点 btn-restart：它的处理函数里有原生 confirm()，会把页面锁死（实测踩过）');
});

test('ui.js 里的接口要有 restartToSetup，且注释写明为什么绕开 confirm', () => {
  const uiPath = path.resolve(ROOT, '..', '小鲸鱼的游戏', '1.guwan-dafuweng', 'js', 'ui.js');
  if (!fs.existsSync(uiPath)) return; // 主人删了游戏就跳过
  const ui = fs.readFileSync(uiPath, 'utf8');
  assert.match(ui, /window\.__GAME_IO__ = \{/, '游戏要暴露 __GAME_IO__');
  assert.match(ui, /restartToSetup\(\)/, '要有 restartToSetup');
  assert.match(ui, /confirm\(\) 会锁死整个页面的 JS 线程|confirm/, '注释要讲清为什么绕开 confirm');
  assert.match(ui, /get\(\) \{ return state; \}/, 'get() 要直接返回闭包里的真 state');
});

console.log('— 5. 玩家名来自"她此刻是谁"，不是写死的 —');
test('玩家名读 state/current-role.json，不写死「小鲸鱼」', () => {
  assert.match(server, /function currentPlayerName\(\)/, '要有 currentPlayerName()');
  assert.match(server, /current-role\.json/, '要从当前角色文件读');
  assert.match(server, /playerName \?\? currentPlayerName\(\)/, '默认值要用当前角色名');
  // 「小鲸鱼」只能作为**兜底**出现，不能直接当默认值用
  const badDefaults = [
    /playerName \?\? '小鲸鱼'/,
    /playerName \|\| '小鲸鱼'/,
  ];
  for (const re of badDefaults) {
    assert.doesNotMatch(server, re, '不能把「小鲸鱼」写死成默认玩家名 —— 主人明确要求不能写死');
  }
});

console.log('— 6. 界面就是那一局（不是"另算一份再同步"）—');
test('她走的是游戏自己的 Engine.choose，界面才会跟着动', () => {
  const uiPath = path.resolve(ROOT, '..', '小鲸鱼的游戏', '1.guwan-dafuweng', 'js', 'ui.js');
  if (!fs.existsSync(uiPath)) return;
  const ui = fs.readFileSync(uiPath, 'utf8');
  // 接口里的 act 必须调 Engine.choose（它外面包了 renderAll + maybeAuto）
  const i = ui.indexOf('act(choice) {');
  assert.ok(i > 0, '接口里要有 act(choice)');
  const block = ui.slice(i, i + 600);
  assert.match(block, /Engine\.choose\(state, want\)/,
    '必须走 Engine.choose —— 它外面包了 renderAll() + maybeAuto()，界面和 AI 才会跟着动');
  assert.doesNotMatch(block, /state\.pending = null/, '不要自己改 state 绕过引擎');
});

test('执行层不再"从外面塞一份 state 进来"（那条路界面不会重画）', () => {
  assert.doesNotMatch(runtime, /__GAME_IO__\.set\(/, '不要再往页面塞 state 副本');
  assert.doesNotMatch(runtime, /syncToPage/, '不再是"算完再同步"，而是直接玩页面里那一局');
});

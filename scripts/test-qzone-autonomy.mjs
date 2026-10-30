// QQ 空间「自主闸门」的判据回归测试（2026-10-19）。
//
// 为什么必须有这个文件
// --------------------
// 主人要求：空间的**写操作**（发说说/点赞/评论/删除/改可见性）只能发生在
// 「她自己起的回合」里 —— 任何人在对话里命令她去做都不能成立，**包括管理员**。
//
// 这条约束的实现落点是**执行期**的：桥接的 /api/socialV2/qzone-action 与
// /api/socialV2/send-qzone 都检查 st.turnAutonomous，而 turnAutonomous 由
// sendWakePromptV2 按唤醒原因置位（isAutonomousWakeReason）。
//
// 判据本身是纯逻辑，但它的**失败方向**极其危险：一旦判错，被命令的发声就会放行，
// 而那是主人明确要挡的事。所以这里从 bridge.js 源码里**抽出真实判据求值**，
// 而不是照抄一份可能漂移的名单 —— 照抄的名单会随源码改动而失真，测了等于没测。
//
// 做法：把 bridge.js 里 AUTONOMOUS_WAKE_REASONS 集合与 isAutonomousWakeReason 的
// 定义按源码原文读出并 eval，保证"测的就是线上那一段代码"。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BRIDGE = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

/** 从源码里抽出 AUTONOMOUS_WAKE_REASONS 的定义 + isAutonomousWakeReason 的实现。 */
function extractPredicate() {
  const setMatch = BRIDGE.match(/const AUTONOMOUS_WAKE_REASONS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(setMatch, '在 bridge.js 里找不到 AUTONOMOUS_WAKE_REASONS 的定义（判据被删了？）');
  const fnMatch = BRIDGE.match(
    /function isAutonomousWakeReason\(reason\) \{\s*return AUTONOMOUS_WAKE_REASONS\.has\(String\(reason \?\? ''\)\.split\(':'\)\[0\]\);\s*\}/,
  );
  assert.ok(fnMatch, '在 bridge.js 里找不到 isAutonomousWakeReason 的实现（判据被改了？）');
  // eslint-disable-next-line no-new-func
  return new Function(`
    const AUTONOMOUS_WAKE_REASONS = new Set([${setMatch[1]}]);
    ${fnMatch[0]}
    return isAutonomousWakeReason;
  `)();
}

const isAutonomous = extractPredicate();

test('判据只认三种"没人找她"的唤醒原因', () => {
  // 主人原话：「凡是不是别人触发的回合都算」。这三类都是桥接**自己**排的：
  //   proactiveCheck —— 冷场久了给她一次主动冒泡的机会（最典型的"自己想的"）
  //   timeout        —— 她自己设的有限潜水到期
  //   replyCheck     —— 她刚说完，回来看有没有人接
  for (const reason of ['proactiveCheck', 'timeout', 'replyCheck']) {
    assert.equal(isAutonomous(reason), true, `${reason} 应当算自主回合`);
  }
});

test('凡是由"别人开口/动手"触发的回合一律不算自主（fail-closed）', () => {
  const notAutonomous = [
    'private',        // 有人私聊她
    'atMention',      // 有人 @ 她
    'question',       // 有人提问
    'nameMention',    // 有人叫她名字
    'anyMessage',     // 有人说话就唤醒
    'probability',    // ⚠️ 哪怕"随机唤醒"，触发者仍是别人的消息
    'poke',           // 有人拍她/拍别人
    'bootstrap',      // 会话引导
    'admin',          // 控制台手动唤醒
    'unknown-reason', // 未来新增原因：默认不算自主（安全方向）
    '',
  ];
  for (const reason of notAutonomous) {
    assert.equal(isAutonomous(reason), false, `${JSON.stringify(reason)} 不应当算自主回合`);
  }
});

test('带子类型的唤醒原因按冒号前的基名判定', () => {
  // 桥接会产出 `keyword:小鲸鱼` / `speaker:某人的昵称` 这类复合原因，
  // 它们都属于"别人说话触发"，绝不能因为带了子类型就被误判成自主。
  assert.equal(isAutonomous('keyword:小鲸鱼'), false);
  assert.equal(isAutonomous('speaker:某个群友'), false);
  assert.equal(isAutonomous('keyword:DeepSeek'), false);
  // 反向：自主原因即使将来带上子类型，也应仍按基名认出。
  assert.equal(isAutonomous('proactiveCheck:any'), true);
});

test('非法输入不抛异常，且一律按"不自主"处理', () => {
  for (const bad of [undefined, null, 0, 123, {}, [], true]) {
    assert.equal(isAutonomous(bad), false, `${JSON.stringify(bad)} 应安全地判为不自主`);
  }
});

test('桥接确实把判据用在写操作的两处入口上', () => {
  // 判据写对了但没接上，等于没有约束。这里断言两个入口都做了检查：
  //   ① /api/socialV2/qzone-action  —— 点赞/评论/删除/改可见性
  //   ② /api/socialV2/send-qzone    —— 发说说
  const qzoneActionCount = (BRIDGE.match(/url\.pathname === '\/api\/socialV2\/qzone-action'/g) || []).length;
  assert.equal(qzoneActionCount, 1, 'qzone-action 端点应当存在且只有一个');
  const sendQzoneCount = (BRIDGE.match(/url\.pathname === '\/api\/socialV2\/send-qzone'/g) || []).length;
  assert.equal(sendQzoneCount, 1, 'send-qzone 端点应当存在且只有一个');
  // 旧的裸比较不该再出现在**闸门判定位置**。
  // ⚠️ 判据函数 isAutonomousTurnActive 内部**本来就应该**有裸比较（那是它的实现），
  //    所以这里只检查"两个写入口的闸门语句"，不全文搜 —— 全文搜会误伤实现与注释。
  const gateLines = BRIDGE.split('\n').filter((l) =>
    /^\s*if \(!isAutonomousTurnActive\(/.test(l),
  );
  assert.equal(gateLines.length, 2, `两个写入口都应走 isAutonomousTurnActive()（实际 ${gateLines.length} 处）`);
  // 闸门判定语句里不得出现对 turnAutonomous 的直接比较（那会绕过 TTL）。
  for (const line of gateLines) {
    assert.doesNotMatch(line, /turnAutonomous/, `闸门语句不该直接比较 turnAutonomous：${line.trim()}`);
  }
  // 撤销与复位也必须存在，否则标记会泄漏到下一轮。
  assert.match(BRIDGE, /st\.turnAutonomous = isAutonomousWakeReason\(reason\)/, '唤醒时必须按原因置位');
  assert.ok(
    (BRIDGE.match(/st\.turnAutonomous = false/g) || []).length >= 2,
    '回合内收到新消息/拍一拍时应撤销，回合结束时应复位',
  );
});

test('判据带 TTL 兜底：回合结束事件丢失时标记会失效', () => {
  // 为什么这条必须有：复位挂在 turn/end 分支里，而那条路径上有 continue，
  // 且桥接不保证一定收得到 turn/end。没有 TTL 就会出现"标记泄漏 ⇒ 写操作被放行"。
  assert.match(BRIDGE, /const AUTONOMOUS_TURN_TTL_MS = /, '应当定义自主标记的 TTL');
  // 判据函数必须同时检查 ①标记 ②起点时间 ③未超时。
  const fnMatch = BRIDGE.match(
    /function isAutonomousTurnActive\(st\) \{[\s\S]*?\n  \}/,
  );
  assert.ok(fnMatch, '找不到 isAutonomousTurnActive 的实现');
  const body = fnMatch[0];
  assert.match(body, /st\.turnAutonomous !== true/, '判据必须检查自主标记');
  assert.match(body, /turnStartedAt/, '判据必须检查起点时间（没有起点就无法判新旧）');
  assert.match(body, /AUTONOMOUS_TURN_TTL_MS/, '判据必须应用 TTL');
  assert.match(body, /Date\.now\(\) - startedAt <= AUTONOMOUS_TURN_TTL_MS/, 'TTL 比较方向必须正确');
});

test('只读的动态流不受闸门限制（主人明确说「去看看说说」可以命令）', () => {
  // qzone-feeds 是纯读，不应出现 turnAutonomous 检查。
  const m = BRIDGE.match(/url\.pathname === '\/api\/socialV2\/qzone-feeds'\) \{[\s\S]*?\n        \}/);
  assert.ok(m, '找不到 qzone-feeds 端点');
  assert.doesNotMatch(m[0], /turnAutonomous/, '只读的动态流不该被自主闸门挡住');
});

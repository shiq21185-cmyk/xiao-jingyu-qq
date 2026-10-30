// 「每轮撞一下老记忆」—— 2026-10-29 加的那条路。
//
// 为什么单独钉：
//   角色卡里的记忆索引只放最近 3 天，她 62 条记忆里 50 条在索引外。这条补丁让
//   每轮唤醒顺手撞一次归档，撞到就提一句。它一旦乱提，比不提更糟 —— 她会把两件
//   不相干的事缝成一件，而且还是"我顺嘴想起来的"，听着特别像真的。所以钉死三件事：
//     ① 要点里一个词都没对上就不提（只在「详细」里沾边的不算）
//     ② 最近几天的、别的会话的、刚提过的，一律不提
//     ③ 泛词（一半记忆里都有的词）不算命中，否则「今天」能勾出五十条
//
// 跑：node scripts/test-memory-recall.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `bridge.js 里找不到 ${name}()`);
  const lineStart = src.lastIndexOf('\n', start) + 1;
  const indent = src.slice(lineStart, start);
  assert.match(indent, /^[ \t]*$/, `${name}() 前面不该有别的代码`);
  const re = new RegExp(`\\r?\\n${indent}\\}\\r?\\n`, 'g');
  re.lastIndex = start;
  const hit = re.exec(src);
  assert.ok(hit, `${name}() 找不到同缩进的结尾`);
  const closeAt = hit[0].indexOf('}');
  return src.slice(start, hit.index + closeAt + 1);
}

const { recallIdOf, pickRecallRows, renderRecallBlock } = new Function(
  [
    extractFn(SRC, 'recallIdOf'),
    extractFn(SRC, 'pickRecallRows'),
    extractFn(SRC, 'renderRecallBlock'),
    'return { recallIdOf, pickRecallRows, renderRecallBlock };'
  ].join('\n')
)();

// 固定「现在」= 2026-10-29 21:00，免得测试随真实时间老化。
const NOW = new Date('2026-10-29T21:00:00').getTime();
const row = (date, text, extra = {}) => ({ date, text, scope: 'private:1', ...extra });

test('要点命中就提；只在详细里沾边的不提', () => {
  const rows = [
    row('2026-10-01', '换了新键盘，青轴的', { detail: '说打字声音太大被室友投诉' }),
    // 「键盘」只出现在详细里：说明这条事讲的是花屏，提出来她会缝成一件
    row('2026-10-02', '显卡驱动回滚到旧版本才不花屏', { detail: '换键盘那天顺口提了一句' })
  ];
  const picked = pickRecallRows(rows, '键盘手感怎么样', { now: NOW });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].text, '换了新键盘，青轴的');
});

test('最近几天的条目不再提（它本来就在角色卡索引里）', () => {
  const rows = [row('2026-10-28', '新键盘到了，青轴的')];
  assert.equal(pickRecallRows(rows, '键盘', { now: NOW }).length, 0);
  // recentDays 调成 0 就又能撞到 —— 证明拦住它的是时间窗口，不是别的原因
  assert.equal(pickRecallRows(rows, '键盘', { now: NOW, recentDays: 0 }).length, 1);
});

test('别的会话的旧事一律不撞（私聊的事不能被塞进群聊）', () => {
  const rows = [row('2026-10-01', '新键盘到了', { scope: 'group:100000002' })];
  assert.equal(pickRecallRows(rows, '键盘', { now: NOW, scope: 'private:1' }).length, 0);
  assert.equal(pickRecallRows(rows, '键盘', { now: NOW, scope: 'group:100000002' }).length, 1);
});

test('刚提过的不再提（否则每句话都勾它一次，很快成噪音）', () => {
  const rows = [row('2026-10-01', '新键盘到了，青轴的')];
  const id = recallIdOf(rows[0]);
  const hits = { [id]: { hits: 1, lastHit: NOW - 60 * 60 * 1000 } };
  assert.equal(pickRecallRows(rows, '键盘', { now: NOW, hits }).length, 0);
  // 过了冷却窗口就又能提
  const old = { [id]: { hits: 1, lastHit: NOW - 7 * 60 * 60 * 1000 } };
  assert.equal(pickRecallRows(rows, '键盘', { now: NOW, hits: old }).length, 1);
});

test('泛词不算命中：一半记忆里都有的词指不了任何一件事', () => {
  const rows = [];
  for (let i = 0; i < 9; i += 1) rows.push(row('2026-10-0' + ((i % 9) + 1), `键盘第 ${i} 次出问题`));
  rows.push(row('2026-10-05', '她送的那条红围巾还挂着'));
  // 「键盘」df=9 → 权 0；只剩「红围巾」能锁定
  const picked = pickRecallRows(rows, '键盘 红围巾', { now: NOW });
  assert.equal(picked.length, 1);
  assert.match(picked[0].text, /红围巾/);
});

test('最多两条，且被想起过的排在前面', () => {
  const rows = [
    row('2026-10-01', '键盘青轴，吵'),
    row('2026-10-02', '键盘换了静音的'),
    row('2026-10-03', '键盘又进灰了')
  ];
  const picked = pickRecallRows(rows, '键盘', { now: NOW, top: 2 });
  assert.equal(picked.length, 2);
  const idLast = recallIdOf(rows[2]);
  const hits = { [idLast]: { hits: 3, lastHit: 0 } };
  const boosted = pickRecallRows(rows, '键盘', { now: NOW, top: 2, hits });
  assert.equal(boosted[0].text, '键盘又进灰了', '被想起过的那条该排第一（「被想起又会变重」）');
});

test('空查询 / 全是标点 → 什么都不提', () => {
  const rows = [row('2026-10-01', '新键盘到了')];
  assert.equal(pickRecallRows(rows, '', { now: NOW }).length, 0);
  assert.equal(pickRecallRows(rows, '   ', { now: NOW }).length, 0);
  assert.equal(pickRecallRows(rows, '，。！？', { now: NOW }).length, 0);
  assert.equal(pickRecallRows(rows, '啊', { now: NOW }).length, 0, '一个字的词太容易撞，不要');
});

test('条目缺字段不炸（老库没有 inferred/detail）', () => {
  const rows = [{ date: '2026-10-01', text: '新键盘到了', scope: 'private:1' }];
  const picked = pickRecallRows(rows, '键盘', { now: NOW });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].inferred, false);
  assert.equal(pickRecallRows([{ text: '没有日期的老条目' }], '老条目', { now: NOW }).length, 1, '日期缺失当成很旧，照样能撞');
});

test('渲染：只给日期和要点，长要点截断，推断带 ~', () => {
  const block = renderRecallBlock([
    { date: '2026-10-01', text: '新键盘到了，青轴的', inferred: false },
    { date: '2026-10-02', text: '她其实不太喜欢这个声音'.repeat(8), inferred: true }
  ]);
  assert.match(block, /^〔想起〕/);
  assert.match(block, /\n- 10-01 新键盘到了，青轴的/);
  assert.match(block, /\n- 10-02 ~她其实不太喜欢/);
  const longLine = block.split('\n').find((l) => l.includes('她其实'));
  assert.ok(longLine.length <= 70, '长要点必须截断，不能把 200 字详细倒进提示词');
  assert.ok(longLine.endsWith('…'));
  assert.equal(renderRecallBlock([]), '');
  assert.equal(renderRecallBlock([{ date: '2026-10-01', text: '' }]), '');
});

test('拆出来的虚词不算命中（「别人」不是话题）', () => {
  // 真实踩到的假阳性：群里问「他是不是特别讨厌别人叫他大肥鱼」，
  // 「别人」在另一条 apk 记忆里出现过，于是被"想起来"了 —— 完全不相干。
  const rows = [row('2026-10-01', '群友让我装一个翻译 apk，别人发来的我不装')];
  assert.equal(pickRecallRows(rows, '他是不是特别讨厌别人叫他大肥鱼', { now: NOW }).length, 0);
  // 换成真话题词就命中：证明拦住它的是黑名单，不是别的原因
  assert.equal(pickRecallRows(rows, '他是不是特别讨厌装apk这件事', { now: NOW }).length, 1);
});

test('同一条记忆的 id 稳定：来源+日期+要点', () => {
  const a = recallIdOf({ scope: 'private:1', date: '2026-10-01', text: ' 新键盘到了 ' });
  const b = recallIdOf({ scope: 'private:1', date: '2026-10-01', text: '新键盘到了' });
  assert.equal(a, b, '两边的空白不该让同一条记忆变成两条');
  assert.notEqual(a, recallIdOf({ scope: 'private:2', date: '2026-10-01', text: '新键盘到了' }));
});

// 热条目层（2026-11-09 新增）：
// 「把最常被用起来、却掉出索引的记忆捞回来」。
//
// 为什么要有这一层（实测数据）：
//   155 条记忆里只有 18 条进索引（最近 3 天）。而被真正用起来的 48 条记忆
//   —— **48 条全部落在归档区**，一条都不在索引里。索引装的几乎只是流水账，
//   最常被想起来的那些事（主人有课的时间、硬件折腾习惯）反而看不见。
//
// 要钉住的性质：
//   ① 窗口外的记忆，只要"被想起够多次"，就能回到索引，且带〔常想起〕标记
//   ② 被想起 1 次的不算（多半是某轮误召回），不占每轮都付钱的常驻位
//   ③ 被取代过的不回索引（否则"还没做视觉"和"视觉也接上了"又同时出现）
//   ④ 推断出来的不占常驻位（可能是错的，不能每轮都读）
//   ⑤ 老的记忆按半衰期衰减，但**有地板**：再老也保留一半分，不会彻底归零
//   ⑥ 不传 recallHits 时，行为与改动前**完全一致**（向后兼容）
//   ⑦ 预算紧张时，砍普通旧记忆优先于砍热条目
import assert from 'node:assert/strict';
import {
  selectIndexItems,
  INDEX_HOT_MAX_ITEMS,
  INDEX_HOT_MIN_HITS,
  INDEX_HOT_STALE_DAYS
} from '../plugins/qq-memory-rollover/memory-index.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`❌ ${name}\n   ${e.message}`);
    failed += 1;
  }
}

const NOW = new Date('2026-11-09T12:00:00');
const item = (text, scope = 'private:1', extra = {}) => ({ scope, text, ...extra });
// key 格式必须与 src/bridge.js 的 recallIdOf 一致：scope|date|text
const keyOf = (date, text, scope = 'private:1') => `${scope}|${date}|${text}`;
const mem = (...days) => ({ items: days.map(([date, items]) => ({ date, items })) });

// 「最近 3 天」的边界：11-09 / 11-08 / 11-07 在窗口内，11-06 及更早在窗口外。
const OLD = '2026-10-01';   // 39 天前，稳稳在窗口外
const OLDER = '2026-09-01'; // 69 天前

// ── ① 热条目能回索引 ───────────────────────────────────────────────────────

test('窗口外的记忆，被想起够多次就能回到索引，并带〔常想起〕标记', () => {
  const m = mem([OLD, [item('主人每周三有早八的课')]]);
  const hits = { [keyOf(OLD, '主人每周三有早八的课')]: { hits: 5, lastHit: NOW.getTime() } };
  const r = selectIndexItems(m, { now: NOW, recallHits: hits });
  const line = r.lines.find((l) => l.includes('早八'));
  assert.ok(line, `热条目没进索引：${JSON.stringify(r.lines)}`);
  assert.match(line, /〔常想起〕/, '热条目必须带〔常想起〕标记，否则她会当成"最近发生的"');
  assert.equal(r.hotCount, 1);
});

test('不传 recallHits 时，行为与改动前完全一致（向后兼容）', () => {
  const m = mem([OLD, [item('一条很老的记忆')]]);
  const r = selectIndexItems(m, { now: NOW });
  assert.equal(r.lines.length, 0, '老记忆不该凭空出现');
  assert.equal(r.hotCount, 0);
});

// ── ② 门槛：1 次不算热 ─────────────────────────────────────────────────────

test('只被想起 1 次的不算热（多半是误召回，不占常驻位）', () => {
  const m = mem([OLD, [item('只被误勾起来过一次的事')]]);
  const hits = { [keyOf(OLD, '只被误勾起来过一次的事')]: { hits: 1 } };
  const r = selectIndexItems(m, { now: NOW, recallHits: hits });
  assert.equal(r.lines.length, 0);
  assert.equal(INDEX_HOT_MIN_HITS, 2, '门槛就是 2，改它要同时改这条测试和注释');
});

test('想起 2 次刚好够格', () => {
  const m = mem([OLD, [item('想起两次的事')]]);
  const hits = { [keyOf(OLD, '想起两次的事')]: { hits: 2 } };
  const r = selectIndexItems(m, { now: NOW, recallHits: hits });
  assert.equal(r.hotCount, 1);
});

// ── ③ 被取代的不回索引 ─────────────────────────────────────────────────────

test('被取代过的记忆，即使历史上很热也不回索引', () => {
  const m = mem(
    [OLD, [item('板子还没做视觉')]],
    ['2026-10-05', [item('视觉也接上了', 'private:1', { replaces: '板子还没做视觉' })]]
  );
  const hits = { [keyOf(OLD, '板子还没做视觉')]: { hits: 9 } };
  const r = selectIndexItems(m, { now: NOW, recallHits: hits });
  const joined = r.lines.join('\n');
  assert.ok(!joined.includes('板子还没做视觉'),
    '被取代的旧事不该回到索引，否则新旧两条会再次并存');
});

// ── ④ 推断的不占常驻位 ─────────────────────────────────────────────────────

test('推断出来的记忆不占常驻位（it 可能是错的，不能每轮都读）', () => {
  const m = mem([OLD, [item('主人大概在忙项目', 'private:1', { inferred: true })]]);
  const hits = { [keyOf(OLD, '主人大概在忙项目')]: { hits: 8 } };
  const r = selectIndexItems(m, { now: NOW, recallHits: hits });
  assert.equal(r.hotCount, 0);
});

// ── ⑤ 半衰期带地板 ─────────────────────────────────────────────────────────

test('新近的热条目排在更老的前面（衰减生效，在触地板之前）', () => {
  // ⚠️ 选天数要落在**地板之前**：半衰期 30 天、地板 0.5 ⇒ 30 天以后分数都是 0.5，
  //    两条都触底时分数相同，就观察不到"新的排前面"。
  //    所以这里用 10 天 vs 20 天（0.794 vs 0.630）。
  const m = mem(
    ['2026-10-20', [item('二十天前但常被想起的事')]],
    ['2026-10-30', [item('十天前也常被想起的事')]]
  );
  const hits = {
    [keyOf('2026-10-20', '二十天前但常被想起的事')]: { hits: 5 },
    [keyOf('2026-10-30', '十天前也常被想起的事')]: { hits: 5 }
  };
  const r = selectIndexItems(m, { now: NOW, recallHits: hits, hotMaxItems: 1 });
  assert.equal(r.hotCount, 1);
  assert.match(r.lines.join('\n'), /十天前也常被想起/,
    '同样 5 次命中时，更新的一条分数更高（0.794 > 0.630）');
});

test('衰减有地板：69 天前、命中 5 次的分数仍高于「地板以下」的直觉值', () => {
  // 没有地板的话 0.5^(69/30)=0.20，有地板是 0.5。
  // 用「两条竞争一个位置」来观察：69 天前命中 5 次 vs 窗口内那条……窗口内在窗口里，
  // 所以这里改成比较 69 天/5 次 和 1 天/2 次 —— 前者应该有竞争力（地板保住了它）。
  const m = mem(
    [OLDER, [item('很老但想起五次的事')]],
    ['2026-11-06', [item('不新不旧想起两次的事')]]
  );
  const hits = {
    [keyOf(OLDER, '很老但想起五次的事')]: { hits: 5 },
    [keyOf('2026-11-06', '不新不旧想起两次的事')]: { hits: 2 }
  };
  const r = selectIndexItems(m, { now: NOW, recallHits: hits, hotMaxItems: 1 });
  assert.match(r.lines.join('\n'), /很老但想起五次/,
    '5×地板0.5=2.5 应胜过 2×接近1 —— 要是没有地板，5×0.20=1.0 就会输');
});

// ── ⑥ 条数上限 ─────────────────────────────────────────────────────────────

test('热条目有上限，不会把索引撑回全量', () => {
  const items = [];
  const hits = {};
  for (let i = 0; i < 20; i += 1) {
    const t = '热记忆第' + i + '条';
    items.push(item(t));
    hits[keyOf(OLDER, t)] = { hits: 3 };
  }
  const r = selectIndexItems(mem([OLDER, items]), { now: NOW, recallHits: hits });
  assert.ok(r.hotCount <= INDEX_HOT_MAX_ITEMS,
    `热条目 ${r.hotCount} 条超过了上限 ${INDEX_HOT_MAX_ITEMS}`);
});

// ── ⑦ 预算紧张时的优先级 ───────────────────────────────────────────────────

test('预算紧张时先砍普通旧记忆，热条目留到后面', () => {
  // 构造：窗口内一条普通 + 窗口外一条热，预算**只够一条**。
  // 固定开销 INDEX_BLOCK_OVERHEAD_CHARS=420，所以 maxChars=470 ⇒ 条目区只剩 50 字符，
  // 刚好只装得下一条（每条含前缀约 30~46 字符）。
  const m = mem(
    [OLDER, [item('被想起五次的旧事')]],
    ['2026-11-09', [item('今天刚发生的一件挺长的事情内容内容内容')]]
  );
  const hits = { [keyOf(OLDER, '被想起五次的旧事')]: { hits: 5 } };
  const r = selectIndexItems(m, { now: NOW, recallHits: hits, maxChars: 470 });
  const joined = r.lines.join('\n');
  assert.ok(r.droppedForBudget >= 1, `预算应当真的砍掉了东西，实际 dropped=${r.droppedForBudget}`);
  assert.ok(joined.includes('被想起五次的旧事'),
    `热条目被砍掉了，实际索引：${JSON.stringify(r.lines)}`);
  assert.ok(!joined.includes('今天刚发生'), '应该先砍普通旧记忆');
});

// ── ⑧ keptDays 不被热条目污染 ──────────────────────────────────────────────

test('keptDays 只数普通记忆的天数（热条目来自更早，不能算进"最近几天"）', () => {
  const m = mem(
    [OLDER, [item('很久以前的热事')]],
    ['2026-11-09', [item('今天的事')]]
  );
  const hits = { [keyOf(OLDER, '很久以前的热事')]: { hits: 5 } };
  const r = selectIndexItems(m, { now: NOW, recallHits: hits });
  assert.equal(r.keptDays, 1,
    'keptDays 应当是 1（只有今天），不能因为热条目把标题写成"最近很多天"');
});

// ── ⑩ 退出机制：只进不出是不行的（2026-11-09 补）──────────────────────────

test('很久没再被想起的热条目会退出（不能只进不出）', () => {
  // 主人 2026-10-23 的原则：「记忆是随时间移除的」。
  // 第一版只有进门没有出门 —— 一条记忆只要历史上被想起过 2 次就永远占着常驻位，
  // 与这个原则冲突。现在按 lastHit 算闲置天数，超过阈值就退回归档。
  const m = mem([OLD, [item('一个半月没再提过的旧事')]]);
  const staleMs = NOW.getTime() - (INDEX_HOT_STALE_DAYS + 1) * 86400000;
  const hits = { [keyOf(OLD, '一个半月没再提过的旧事')]: { hits: 9, lastHit: staleMs } };
  const r = selectIndexItems(m, { now: NOW, recallHits: hits });
  assert.equal(r.hotCount, 0, '闲置超阈值的应当退回归档');
});

test('刚被想起过的仍然在（没被误伤）', () => {
  const m = mem([OLD, [item('昨天还想起来过的事')]]);
  const freshMs = NOW.getTime() - 1 * 86400000;
  const hits = { [keyOf(OLD, '昨天还想起来过的事')]: { hits: 3, lastHit: freshMs } };
  const r = selectIndexItems(m, { now: NOW, recallHits: hits });
  assert.equal(r.hotCount, 1);
});

test('闲置正好在阈值边界上时仍然保留（不卡太死）', () => {
  const m = mem([OLD, [item('刚好在边界上的事')]]);
  const edgeMs = NOW.getTime() - INDEX_HOT_STALE_DAYS * 86400000;
  const hits = { [keyOf(OLD, '刚好在边界上的事')]: { hits: 3, lastHit: edgeMs } };
  const r = selectIndexItems(m, { now: NOW, recallHits: hits });
  assert.equal(r.hotCount, 1, '正好等于阈值应当保留，超过才淘汰');
});

test('没有 lastHit 字段的旧账本不被误删（向后兼容）', () => {
  // 早期的 memory-hits.json 只有 {hits:N}，没有时间戳。
  // 不能因为字段缺失就把一条真热记忆踢掉。
  const m = mem([OLD, [item('老账本里的热记忆')]]);
  const hits = { [keyOf(OLD, '老账本里的热记忆')]: { hits: 5 } };
  const r = selectIndexItems(m, { now: NOW, recallHits: hits });
  assert.equal(r.hotCount, 1);
});

test('条数上限是硬的：再多够格的也只进 5 条（不会随时间增长）', () => {
  const items = [], hits = {};
  const nowMs = NOW.getTime();
  for (let i = 0; i < 100; i += 1) {
    const t = '够格的热记忆' + i;
    items.push(item(t));
    hits[keyOf(OLDER, t)] = { hits: 50, lastHit: nowMs };  // 全是刚想起过的
  }
  const r = selectIndexItems(mem([OLDER, items]), { now: NOW, recallHits: hits, maxChars: 99999 });
  assert.equal(r.hotCount, INDEX_HOT_MAX_ITEMS,
    `100 条够格的热记忆也只能进 ${INDEX_HOT_MAX_ITEMS} 条，实际进了 ${r.hotCount}`);
});

// ── ⑨ 坏数据不炸 ───────────────────────────────────────────────────────────

test('hits 结构不合法时不炸（顶层不是对象 / 值缺失）', () => {
  const m = mem([OLD, [item('某条老记忆')]]);
  for (const bad of [null, undefined, [], 'x', 42]) {
    const r = selectIndexItems(m, { now: NOW, recallHits: bad });
    assert.equal(r.hotCount, 0);
  }
  const r2 = selectIndexItems(m, { now: NOW, recallHits: { [keyOf(OLD, '某条老记忆')]: {} } });
  assert.equal(r2.hotCount, 0, 'hits 字段缺失应当当作 0');
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);

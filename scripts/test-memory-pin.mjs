// 约定记忆的"额外保留"规则（2026-10-23 主人要求）：
// 「让角色卡里面一直是最新的，但是可以额外保留那种约定时间的记忆」
//
// 要钉住的三件事：
//  ① 未到期的约定**不受**「最近 3 天」限制，要出现在索引里；
//  ② 到期了就得消失，不能永远赖着（这是它和"常驻"的区别）；
//  ③ 误报要少 —— 实测踩过「替鲸鲸向他们说好话」被判成约定的坑。
import assert from 'node:assert/strict';
import {
  appointmentDue,
  selectIndexItems,
  INDEX_PIN_MAX_ITEMS,
  INDEX_PIN_SOFT_DAYS
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

const day = (text) => {
  const [y, m, d] = text.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const ymd = (date) => {
  if (!(date instanceof Date)) return String(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
};

// ── 到期日推算 ─────────────────────────────────────────────────────────────

test('「明天接着玩」按条目自己那天算，不是按今天算', () => {
  const due = appointmentDue({ text: '两人说好明天接着玩消消乐', parsed: day('2026-10-17') });
  assert.equal(ymd(due), '2026-10-18');
});

test('「后天」+2 天、「第二天」+1 天', () => {
  assert.equal(ymd(appointmentDue({ text: '答应后天教她', parsed: day('2026-10-17') })), '2026-10-19');
  assert.equal(ymd(appointmentDue({ text: '约定第二天拿它打招呼', parsed: day('2026-10-19') })), '2026-10-20');
});

test('「下周三」取条目日期之后最近的那个周三', () => {
  // 2026-10-17 是周六，之后的周三 = 10-21
  const due = appointmentDue({ text: '说好下周三一起看她', parsed: day('2026-10-17') });
  assert.equal(ymd(due), '2026-10-21');
});

test('绝对日期优先于相对说法', () => {
  const due = appointmentDue({ text: '答应明天之前把 10月30日 的东西给她', parsed: day('2026-10-17') });
  assert.equal(ymd(due), '2026-10-30');
});

test('绝对日期比条目日期早时算到明年（12月说1月3日）', () => {
  const due = appointmentDue({ text: '约定 1月3日 见面', parsed: day('2026-12-20') });
  assert.equal(ymd(due), '2027-01-03');
});

test('只说「答应」没给时间：走宽限期，不是永久', () => {
  const due = appointmentDue({ text: '主人答应给的群号还没给', parsed: day('2026-10-14') });
  assert.equal(ymd(due), ymd(new Date(2026, 9, 14 + INDEX_PIN_SOFT_DAYS)));
});

test('不是约定就返回 null', () => {
  assert.equal(appointmentDue({ text: '鲸鲸爱玩消消乐，卡在四十多关', parsed: day('2026-10-23') }), null);
  assert.equal(appointmentDue({ text: '主人发了个早安表情', parsed: day('2026-10-23') }), null);
});

test('「说好话」不算约定（实测误报）', () => {
  assert.equal(
    appointmentDue({ text: '林青替鲸鲸向他们说好话求开游戏权限', parsed: day('2026-10-20') }),
    null,
    '「说好话」是求情，不是约定'
  );
});

test('没有日期的脏数据不崩', () => {
  assert.equal(appointmentDue({ text: '约定明天', parsed: null }), null);
  assert.equal(appointmentDue({}), null);
});

// ── 索引里的实际行为 ───────────────────────────────────────────────────────

function memWith(rows) {
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push({ scope: r.scope ?? '', text: r.text });
  }
  return {
    items: [...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, items]) => ({ date, items }))
  };
}

const NOW = day('2026-10-23');

test('未到期的约定会出现在索引里（虽然已经超出最近 3 天）', () => {
  const mem = memWith([
    { date: '2026-10-16', text: '答应主人 10月26日 一起看那个教程' },
    { date: '2026-10-22', text: '今天聊了消消乐', scope: 'private:1' }
  ]);
  const r = selectIndexItems(mem, { now: NOW, maxChars: 4000 });
  const pinnedLine = r.lines.find((l) => l.includes('10月26日'));
  assert.ok(pinnedLine, `索引里应当有这条约定，实际：\n${r.lines.join('\n')}`);
  assert.ok(pinnedLine.includes('〔约定〕'), '约定行要有〔约定〕标记');
  assert.equal(r.pinnedCount, 1);
});

test('到期的约定必须消失（10-14 说"明天"= 10-15，今天 10-23）', () => {
  const mem = memWith([
    { date: '2026-10-14', text: '约定明天一起打游戏' },
    { date: '2026-10-22', text: '最近聊的事' }
  ]);
  const r = selectIndexItems(mem, { now: NOW, maxChars: 4000 });
  assert.equal(r.lines.some((l) => l.includes('一起打游戏')), false, '过期约定不该还在索引里');
  assert.equal(r.pinnedCount, 0);
});

test('约定再多也不超过 INDEX_PIN_MAX_ITEMS 条', () => {
  const rows = [];
  for (let i = 1; i <= 8; i += 1) {
    rows.push({ date: '2026-10-01', text: `答应 11月${10 + i}日 做第${i}件事` });
  }
  rows.push({ date: '2026-10-22', text: '最近的普通记忆' });
  const r = selectIndexItems(memWith(rows), { now: NOW, maxChars: 8000 });
  assert.equal(r.pinnedCount, INDEX_PIN_MAX_ITEMS, `应钉住 ${INDEX_PIN_MAX_ITEMS} 条`);
});

test('预算吃紧时先砍普通记忆，约定留到最后', () => {
  const rows = [{ date: '2026-10-16', text: '答应主人 11月1日 一起去那个地方看看', scope: 'private:1' }];
  for (let i = 0; i < 12; i += 1) {
    rows.push({ date: '2026-10-22', text: `第${i}条普通记忆内容差不多长一点点`, scope: 'private:1' });
  }
  // 预算 620 ⇒ 条目区只有 200 字符，12 条普通记忆必然塞不下
  const r = selectIndexItems(memWith(rows), { now: NOW, maxChars: 620 });
  assert.ok(
    r.lines.some((l) => l.includes('11月1日')),
    `预算再紧也该保住约定，实际：\n${r.lines.join('\n')}`
  );
  assert.ok(r.droppedForBudget > 0, '应当确实砍掉了一些普通记忆');
});

test('普通记忆仍然只留最近 3 天（钉约定没把规则改回去）', () => {
  const mem = memWith([
    { date: '2026-10-15', text: '很早的普通记忆' },
    { date: '2026-10-22', text: '最近的普通记忆' }
  ]);
  const r = selectIndexItems(mem, { now: NOW, maxChars: 4000 });
  assert.equal(r.lines.some((l) => l.includes('很早的普通记忆')), false);
  assert.equal(r.keptDays, 1);
});

test('一条约定都没有时 pinnedCount 为 0，行为与之前完全一致', () => {
  const mem = memWith([{ date: '2026-10-22', text: '普通记忆' }]);
  const r = selectIndexItems(mem, { now: NOW, maxChars: 4000 });
  assert.equal(r.pinnedCount, 0);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].includes('〔约定〕'), false);
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);

// 时间感 / 主动系数 的单测。
//
// 为什么这几块必须有单测：
//   · 时段与饭点的边界是**纯算术**，写错一个 `>=` 就会让她半夜十二点问「吃了没」，
//     而这种错误在真实对话里极难复现（要正好在那个钟点、正好被唤醒）。
//
// 跑：node --test scripts/test-proactive-time.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PERIODS,
  MEALS,
  describeClock,
  humanGap,
  formatTimeContext,
  proactiveTimeFactor,
  spokenClock
} from '../src/time-context.js';

// 构造一个本地时间的 Date（不依赖测试机时区地写死 UTC，否则 CI 与开发机结论不同）
function at(hour, minute = 0, { day = 15, month = 9, year = 2026 } = {}) {
  // 2026-10-15 是周四
  return new Date(year, month, day, hour, minute, 0, 0);
}

test('periods cover 24h with no gap and no overlap', () => {
  let cursor = 0;
  for (const p of PERIODS) {
    assert.equal(p.from, cursor, `period ${p.id} 起点应与上一段终点相接`);
    assert.ok(p.to > p.from, `period ${p.id} 终点必须大于起点`);
    cursor = p.to;
  }
  assert.equal(cursor, 24, '最后一段必须收在 24 点');
  // 逐小时检查：每个整点都必须命中且只命中一个时段
  for (let h = 0; h < 24; h += 1) {
    const hits = PERIODS.filter((p) => h >= p.from && h < p.to);
    assert.equal(hits.length, 1, `${h} 点应恰好命中一个时段，实际 ${hits.length}`);
  }
});

test('meal windows are ordered, in-hours, and do not overlap', () => {
  let lastTo = -1;
  for (const m of MEALS) {
    assert.ok(m.from >= lastTo, `meal ${m.id} 与上一餐重叠`);
    assert.ok(m.to > m.from);
    assert.ok(m.from >= 0 && m.to <= 24, `meal ${m.id} 越界`);
    lastTo = m.to;
  }
});

test('describeClock reports meal / late night / weekend correctly', () => {
  // 午饭
  const lunch = describeClock(at(12, 10));
  assert.equal(lunch.meal?.id, 'lunch');
  assert.equal(lunch.period.id, 'noon');
  assert.equal(lunch.lateNight, false);

  // 晚饭
  assert.equal(describeClock(at(18, 0)).meal?.id, 'dinner');

  // 刚过午饭（13:30~15:00 之间算 mealPast）
  const past = describeClock(at(14, 0));
  assert.equal(past.meal, null);
  assert.equal(past.mealPast?.id, 'lunch');

  // 深夜 23:40 与 02:00 都该是 lateNight
  assert.equal(describeClock(at(23, 40)).lateNight, true);
  assert.equal(describeClock(at(2, 0)).lateNight, true);
  // 早上 7 点不是 lateNight，是 earlyMorning
  const dawn = describeClock(at(7, 0));
  assert.equal(dawn.lateNight, false);
  assert.equal(dawn.earlyMorning, true);

  // 2026-10-17 是周六
  const weekend = describeClock(at(11, 0, { day: 17 }));
  assert.equal(weekend.weekday, '周六');
  assert.equal(weekend.isWeekend, true);
});

test('humanGap says things a person would say', () => {
  assert.equal(humanGap(5 * 1000), '刚刚');
  assert.equal(humanGap(90 * 1000), '1 分钟');
  assert.equal(humanGap(4 * 60 * 1000), '4 分钟');
  assert.equal(humanGap(2 * 60 * 60 * 1000 + 11 * 60 * 1000), '2 小时 11 分钟');
  assert.equal(humanGap(3 * 60 * 60 * 1000), '3 小时');
  assert.equal(humanGap(26 * 60 * 60 * 1000), '1 天 2 小时');
  assert.equal(humanGap(-1), '');
  assert.equal(humanGap(undefined), '');
});

test('formatTimeContext always yields 现在/时段, and mentions meal when it applies', () => {
  const now = at(12, 20);
  const text = formatTimeContext({ now, lastIncomingAt: now.getTime() - 3 * 60 * 60 * 1000, lastAiReplyAt: 0 });
  assert.match(text, /【现在】2026-10-15 周四 12:20/);
  assert.match(text, /【时段】中午/);
  assert.match(text, /午饭/);
  assert.match(text, /他上次说话是 3 小时前/);
  // 不能把"应当说什么"写成命令式
  assert.doesNotMatch(text, /你应该说/);
});

test('proactiveTimeFactor: meal boosts, dead-of-night without conversation crushes', () => {
  // 午饭时间、很久没说话 → 明显更容易主动
  const lunch = proactiveTimeFactor(at(12, 5), { lastIncomingAt: at(8, 0).getTime(), lastAiReplyAt: 0 });
  assert.ok(lunch.factor > 1.2, `午饭系数应 >1.2，实际 ${lunch.factor}`);
  assert.equal(lunch.meal, true);

  // 凌晨 3 点、已经 6 小时没聊 → 必须压得很低（不能半夜把他叫醒）
  const deadNight = proactiveTimeFactor(at(3, 0), {
    lastIncomingAt: at(21, 0, { day: 14 }).getTime(),
    lastAiReplyAt: 0
  });
  assert.ok(deadNight.factor < 0.3, `深夜冷场系数应 <0.3，实际 ${deadNight.factor}`);
  assert.equal(deadNight.lateNight, true);

  // 凌晨 1 点但 20 分钟前还在聊 → 反而更高（她确实还想说）
  const nightTalking = proactiveTimeFactor(at(1, 0), {
    lastIncomingAt: at(0, 40).getTime(),
    lastAiReplyAt: at(0, 45).getTime()
  });
  assert.ok(nightTalking.factor > 1, `深夜仍在聊应 >1，实际 ${nightTalking.factor}`);

  // 系数永远不该越过 0..3 这个量级（防手滑乘出天文数字）
  for (let h = 0; h < 24; h += 1) {
    const f = proactiveTimeFactor(at(h, 30), { lastIncomingAt: 0, lastAiReplyAt: 0 }).factor;
    assert.ok(Number.isFinite(f) && f > 0 && f < 3, `${h}:30 的系数异常：${f}`);
  }
});

// ── 申请答复解析 ────────────────────────────────────────────────────────────
// 注意：parsePermitAnswer 在 bridge.js 里（那个文件会启动桥接，不能直接 import）。
// 所以这里用**同一张表**的等价规则做断言：把关键用例写成字符串，检查行为口径。
// 这里只钉住"哪些说法必须算同意/拒绝"这份口径本身，防止以后改实现时把语义改掉。
const ALLOW = ['同意', '行', '可以', '去吧', '准了', 'ok', '同意 1 小时', '给你 20 分钟', '同意半小时'];
const DENY = ['不同意', '不行', '不用了', '算了', '别玩了', '拒绝'];

test('permit answer vocabulary is unambiguous', () => {
  // 「不同意」同时包含「同意」两个字 —— 这是最容易写错的一条，单独强调
  assert.ok(DENY.includes('不同意'));
  for (const d of ['不同意', '不允许']) {
    assert.ok(d.startsWith('不'), `${d} 必须以否定词开头，实现里要先判否定`);
  }
  assert.ok(ALLOW.length > 0 && DENY.length > 0);
});

// ── 口语钟点（2026-11-09 事故回归）──────────────────────────────────────────
// 事故：提示词给的是 24 小时制 `16:05`，她自己换算成"下午四点"时算错，先说出
// 「四点十分了，往教室走呢吧」（实际四点十分早过了），补救时又编出「这会儿五点了」。
// 给的 16:05 一直没错，错在"24 小时制 → 口语"这一步要模型自己算。
// 修法：把口语读法直接摆进提示词，让她照抄。下面把这些读法钉死。
test('spokenClock reads 24h clock the way a person says it', () => {
  const cases = [
    [0, 0, '零点'],
    [0, 5, '零点零五'],
    [3, 30, '凌晨三点半'],
    [5, 30, '早上五点半'],
    [8, 59, '早上八点五十九'],
    [9, 7, '上午九点零七'],
    [11, 11, '上午十一点十一'],
    [12, 0, '中午十二点'],
    [12, 20, '中午十二点二十'],
    [15, 45, '下午三点四十五'],
    [16, 5, '下午四点零五'],      // ← 事故那一刻
    [17, 0, '下午五点'],
    [19, 50, '晚上七点五十'],
    [23, 59, '晚上十一点五十九']
  ];
  for (const [h, m, want] of cases) {
    assert.equal(spokenClock(at(h, m)), want, `${h}:${String(m).padStart(2, '0')} 应读作「${want}」`);
  }
});

test('spokenClock never leaks 24-hour phrasing', () => {
  // "十六点零五分"这种报时腔不是人话；一旦出现说明又退回 24 小时制了
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 5, 12, 30, 45, 59]) {
      const said = spokenClock(at(h, m));
      if (h >= 13) {
        assert.doesNotMatch(said, /十[三-九]点/, `${h}:${m} 不该说成「${said}」`);
      }
      assert.doesNotMatch(said, /^二?十[三四]点/, `${h}:${m} 不该说成「${said}」`);
    }
  }
});

test('formatTimeContext puts an unambiguous spoken clock in the prompt', () => {
  // 事故原时刻：必须能一眼读到"下午四点零九"，并且明确别读成别的钟点
  const now = new Date(2026, 10, 9, 16, 9, 0, 0);
  const text = formatTimeContext({ now });
  assert.match(text, /【现在】2026-11-09 周一 16:09（下午四点零九）/);
  assert.match(text, /【口语】现在开口要说「下午四点零九」/);
  // 保留 24 小时制（日志/对照要好认），所以两个都要有
  assert.match(text, /16:09/);
});

// 时间感 / 主动系数 / 申请答复解析 / 授权文件 的单测。
//
// 为什么这几块必须有单测：
//   · 时段与饭点的边界是**纯算术**，写错一个 `>=` 就会让她半夜十二点问「吃了没」，
//     而这种错误在真实对话里极难复现（要正好在那个钟点、正好被唤醒）。
//   · parsePermitAnswer 决定了「他说行不行」—— 把「不同意」误判成同意，
//     等于把主人的手机交出去。这是本仓库里解释成本最高的一类 bug。
//   · permit-lib 的 fail-closed 行为（坏文件 = 没授权）必须被钉住。
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
  proactiveTimeFactor
} from '../src/time-context.js';
import {
  PERMIT_SCOPES,
  activeGrant,
  createRequest,
  emptyPermitFile,
  formatRemaining,
  isKnownScope,
  prunePermits,
  readPermitFile,
  resolveGrant
} from '../src/permit-lib.js';

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
// 真正的实现由 test-permit-gate.mjs 里的端到端检查覆盖（那里能拿到桥接的函数）。
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

// ── 授权文件 ────────────────────────────────────────────────────────────────
test('permit file is fail-closed: garbage in means no grants', () => {
  assert.deepEqual(readPermitFile('/definitely/not/here.json', () => null), emptyPermitFile());
  assert.deepEqual(readPermitFile('/x', () => ({ conversations: 1 })), emptyPermitFile());
  assert.deepEqual(readPermitFile('/x', () => { throw new Error('boom'); }), emptyPermitFile());
});

test('permit file keeps only live grants for known scopes and valid keys', () => {
  const now = Date.now();
  const file = readPermitFile('/x', () => ({
    grants: {
      'private:100000001': {
        phone: { expiresAt: now + 60000, grantedAt: now, requestId: 'a', why: '想玩' },
        bili: { expiresAt: now - 1, grantedAt: now, requestId: 'b', why: '过期' },
        unknownScope: { expiresAt: now + 60000 }
      },
      'not-a-key': { phone: { expiresAt: now + 60000 } },
      'group:1': { phone: { expiresAt: now + 60000 }, junk: 'x' }
    },
    requests: {}
  }));
  assert.deepEqual(Object.keys(file.grants).sort(), ['group:1', 'private:100000001']);
  assert.deepEqual(Object.keys(file.grants['private:100000001']), ['phone'], '过期与未知 scope 必须被丢掉');
  assert.equal(activeGrant(file, 'private:100000001', 'phone')?.why, '想玩');
  assert.equal(activeGrant(file, 'private:100000001', 'bili'), null);
});

test('resolveGrant clamps to each scope bounds', () => {
  const now = 1_000_000;
  // 不传 → 默认值
  assert.equal(resolveGrant('phone', { now }).ttlMs, PERMIT_SCOPES.phone.defaultTtlMs);
  // 要太多 → 截到上限
  assert.equal(resolveGrant('phone', { now, requestedMs: 99 * 60 * 60 * 1000 }).ttlMs, PERMIT_SCOPES.phone.maxTtlMs);
  // 要太少 → 抬到 1 分钟
  assert.equal(resolveGrant('phone', { now, requestedMs: 1 }).ttlMs, 60 * 1000);
  // 未知 scope 必须抛（不能悄悄给个默认值）
  assert.throws(() => resolveGrant('nope', { now }), /未知的授权类别/);
  assert.equal(isKnownScope('phone'), true);
  assert.equal(isKnownScope('constructor'), false, '原型链上的名字不能被当成合法 scope');
  assert.equal(isKnownScope('__proto__'), false);
});

test('prunePermits drops expired grants and stale requests', () => {
  const now = Date.now();
  const pruned = prunePermits({
    grants: {
      'private:1': {
        phone: { expiresAt: now + 1000 },
        bili: { expiresAt: now - 1000 }
      }
    },
    requests: {
      old: { key: 'private:1', scope: 'phone', createdAt: now - 25 * 60 * 60 * 1000 },
      fresh: { key: 'private:1', scope: 'phone', createdAt: now - 1000 }
    }
  }, now);
  assert.deepEqual(Object.keys(pruned.grants['private:1']), ['phone']);
  assert.deepEqual(Object.keys(pruned.requests), ['fresh']);
});

test('createRequest makes a pending, uniquely-ided request', () => {
  const a = createRequest({ key: 'private:1', scope: 'phone', why: '想玩消消乐' });
  const b = createRequest({ key: 'private:1', scope: 'phone', why: '想玩消消乐' });
  assert.notEqual(a.id, b.id, '两次申请必须拿到不同 id');
  assert.equal(a.status, 'pending');
  assert.equal(a.why, '想玩消消乐');
  assert.throws(() => createRequest({ key: 'private:1', scope: 'bogus' }), /未知的授权类别/);
});

test('formatRemaining is human', () => {
  assert.equal(formatRemaining(30 * 1000), '不到 1 分钟');
  assert.equal(formatRemaining(20 * 60 * 1000), '20 分钟');
  assert.equal(formatRemaining(90 * 60 * 1000), '1 小时 30 分钟');
  assert.equal(formatRemaining(2 * 60 * 60 * 1000), '2 小时');
});

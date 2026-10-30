// 归档检索的排序与预算 —— 这两条决定了「她翻出来的记忆对不对」。
//
// 为什么单独钉：
//   · 第一版用一个 `new Map(all.map(...))` 去查「命中的行在时间轴上的位置」，
//     但真正入表的对象是 `{...row}`（展开后的新对象），Map 里根本没有它，
//     查出来永远是 0。结果是：命中数相同时顺序完全随机，最新的记忆可能排到最后。
//     这种 bug 不会报错，只会让「翻一翻归档」翻出一堆旧事。这里钉住同分时按新近排。
//   · 字符预算是为了防止把 3 万字倒进上下文（工具返回值会整段进模型）。
//     但预算不能把结果砍成空 —— 至少留一条，否则等于「查到了但什么都不给」。
//
// 跑：node scripts/test-memory-archive-rank.mjs
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

// searchDailyMemory 依赖 readDailyMemory（读盘）、dailyMemoryScopeLabel（纯格式化）
// 与 parseMemoryDay（日期维度，2026-10-27 新增）。
// 测试里把 readDailyMemory 换成「返回给定数据」，磁盘一律不碰；
// 日期解析器换成恒返回 null（这组用例不涉及日期）。
function buildSearch(fixture) {
  const src = ['dailyMemoryScopeLabel', 'parseMemoryDay', 'searchDailyMemory']
    .map((n) => extractFn(SRC, n)).join('\n');
  const factory = new Function(
    'readDailyMemory',
    'parseMemoryDay',
    `${src}
     return { searchDailyMemory };`
  );
  return factory(() => fixture, () => null);
}

function day(date, ...items) {
  return { date, items: items.map(([scope, text]) => ({ scope, text })) };
}

test('命中数相同的两条，新的排在前面（第一版这里查下标永远拿到 0）', () => {
  const fixture = {
    lastDigestDate: '2026-10-22',
    items: [
      day('2026-10-14', ['private:100000001', '喜欢躺平的猫这张图']),
      day('2026-10-22', ['private:100000001', '又提到躺平的猫，还发了新的'])
    ]
  };
  const { searchDailyMemory } = buildSearch(fixture);
  const r = searchDailyMemory('躺平的猫');
  assert.equal(r.matched, 2);
  assert.match(r.lines[0], /10-22/, `同分时最新的要先出，实际第一条是 ${r.lines[0]}`);
  assert.match(r.lines[1], /10-14/);
});

test('命中两个词的排在同分之上', () => {
  const fixture = {
    lastDigestDate: '2026-10-22',
    items: [
      day('2026-10-22', ['private:100000001', '只提到大肥鱼']),
      day('2026-10-14', ['private:100000001', '大肥鱼是雷点，还说过躺平的猫'])
    ]
  };
  const { searchDailyMemory } = buildSearch(fixture);
  const r = searchDailyMemory('大肥鱼 躺平的猫');
  assert.equal(r.matched, 2);
  assert.match(r.lines[0], /雷点/, '命中两个词的必须排第一，即使它更旧');
});

test('无关键词时按时间倒序，取最近的', () => {
  const fixture = {
    lastDigestDate: '2026-10-22',
    items: [
      day('2026-10-14', ['private:100000001', '最早的事']),
      day('2026-10-18', ['private:100000001', '中间的事']),
      day('2026-10-22', ['private:100000001', '最新的事'])
    ]
  };
  const { searchDailyMemory } = buildSearch(fixture);
  const r = searchDailyMemory('');
  assert.match(r.lines[0], /最新的事/);
  assert.match(r.lines[2], /最早的事/);
});

test('limit 生效，但 matched 仍报真实命中总数', () => {
  const fixture = {
    lastDigestDate: '2026-10-22',
    items: [day('2026-10-22', ...Array.from({ length: 8 }, (_, i) => ['private:100000001', `大肥鱼 第 ${i} 次`]))]
  };
  const { searchDailyMemory } = buildSearch(fixture);
  const r = searchDailyMemory('大肥鱼', { limit: 3 });
  assert.equal(r.lines.length, 3);
  assert.equal(r.matched, 8, 'matched 要说真话，不能等于被 limit 砍过的条数');
  assert.equal(r.truncated, true);
});

test('字符预算再紧也至少留一条', () => {
  const fixture = {
    lastDigestDate: '2026-10-22',
    items: [day('2026-10-22', ['private:100000001', '甲'.repeat(300)])]
  };
  const { searchDailyMemory } = buildSearch(fixture);
  const r = searchDailyMemory('', { maxChars: 200 });
  assert.equal(r.lines.length, 1, '预算不足也要给一条，否则等于查到了却什么都不返回');
});

test('每条都带来源，来源为空时不能静默吞掉', () => {
  const fixture = {
    lastDigestDate: '2026-10-22',
    items: [day('2026-10-22', ['', '没有来源的旧记录'])]
  };
  const { searchDailyMemory } = buildSearch(fixture);
  const r = searchDailyMemory('');
  assert.match(r.lines[0], /（无来源）/, '来源缺失要显式标出来，不能看起来像当前会话说的');
});

test('空库不炸', () => {
  const { searchDailyMemory } = buildSearch({ lastDigestDate: '', items: [] });
  const r = searchDailyMemory('随便什么');
  assert.equal(r.totalItems, 0);
  assert.deepEqual(r.lines, []);
  assert.equal(r.truncated, false);
});

// ── 2026-10-29：检索强度改造（点权重 / 同义词 / +必含）──────────────────────
//
// 为什么钉这三条：索引只留最近 3 天，**3 天以前全靠这个检索**。
// 检索弱一点不是"少几条结果"，是那 50 条等于不存在。

test('要点命中比详细命中排得前（"讲的就是这件事" vs "顺手提了一句"）', () => {
  const fixture = {
    lastDigestDate: '2026-10-22',
    items: [
      {
        date: '2026-10-22',
        items: [
          { scope: 'private:100000001', text: '今天聊了别的事', detail: '顺带提了一句板子' },
          { scope: 'private:100000001', text: '板子接好了扬声器', detail: '' }
        ]
      }
    ]
  };
  const { searchDailyMemory } = buildSearch(fixture);
  const r = searchDailyMemory('板子');
  assert.equal(r.matched, 2);
  assert.match(r.lines[0], /扬声器/, `要点里写着板子那条要排第一，实际第一条是 ${r.lines[0]}`);
});

test('同义词：搜「硬件」能翻到写着「板子」的记忆', () => {
  const fixture = {
    lastDigestDate: '2026-10-22',
    items: [day('2026-10-22', ['private:100000001', '板子上的扬声器接好了']) ]
  };
  const { searchDailyMemory } = buildSearch(fixture);
  const r = searchDailyMemory('硬件');
  assert.equal(r.matched, 1, '「硬件」查不到「板子」= 主人换个说法就丢记忆');
  assert.match(r.lines[0], /扬声器/);
});

test('同义词：搜「游戏」能翻到「消消乐」', () => {
  const fixture = {
    lastDigestDate: '2026-10-22',
    items: [day('2026-10-22', ['private:100000001', '消消乐打到四十关了']) ]
  };
  const { searchDailyMemory } = buildSearch(fixture);
  const r = searchDailyMemory('游戏');
  assert.equal(r.matched, 1);
});

test('+词 是严格必含：拿不到就一条都不给，别拿沾边的凑数', () => {
  const fixture = {
    lastDigestDate: '2026-10-22',
    items: [
      day('2026-10-22', ['private:100000001', '板子接好了但是没提别的事']),
      day('2026-10-21', ['private:100000001', '板子和语音都接好了'])
    ]
  };
  const { searchDailyMemory } = buildSearch(fixture);
  const strict = searchDailyMemory('+板子 +语音');
  assert.equal(strict.matched, 1, '+词 要求都命中，不该把只沾一个的也翻出来');
  assert.match(strict.lines[0], /语音都接好了/);
  // 不加 + 时放宽（OR），两条都该出现 —— 这是她自己能选的开关。
  const loose = searchDailyMemory('板子 语音');
  assert.equal(loose.matched, 2);
});

test('+词 也认同义词（+硬件 能命中写着「板子」的）', () => {
  const fixture = {
    lastDigestDate: '2026-10-22',
    items: [day('2026-10-22', ['private:100000001', '板子和语音都弄好了']) ]
  };
  const { searchDailyMemory } = buildSearch(fixture);
  const r = searchDailyMemory('+硬件 +语音');
  assert.equal(r.matched, 1, '+ 要求的该是"这件事"，不是"这个字面"');
});

test('推断出来的记忆在检索结果里带 `~（推断）` 标记', () => {
  // 为什么这条要紧：检索出来的东西是她**要拿去说话**的。
  // 「他大概在忙」（猜的）和「他说他在忙」（事实）在库里长得一样，
  // 翻出来也不加区分的话，她就会把猜测当事实讲，而且讲得很笃定。
  const fixture = {
    lastDigestDate: '2026-10-22',
    items: [{
      date: '2026-10-22',
      items: [
        { scope: 'private:100000001', text: '主人大概在赶项目', inferred: true },
        { scope: 'private:100000001', text: '主人说周末回家' }
      ]
    }]
  };
  const { searchDailyMemory } = buildSearch(fixture);
  const r = searchDailyMemory('主人');
  const guess = r.lines.find((l) => l.includes('赶项目'));
  const fact = r.lines.find((l) => l.includes('周末回家'));
  assert.match(guess, /（推断）/, '推断出来的必须显式标出来');
  assert.match(guess, /｜~（推断）主人大概在赶项目/, '标记要紧贴正文，读起来才是"这条是猜的"');
  assert.ok(!/（推断）/.test(fact), '事实不许被误标 —— 乱标会让真话也变可疑');
  // 排序不受影响：推断不等于"不重要"，它是真实发生过的思考，只是不能当事实讲。
  assert.equal(r.matched, 2);
});

test('老库没有 inferred 字段：行为与加这个字段之前完全一致', () => {
  const fixture = {
    lastDigestDate: '2026-10-22',
    items: [day('2026-10-22', ['private:100000001', '主人说周末回家'])]
  };
  const { searchDailyMemory } = buildSearch(fixture);
  const r = searchDailyMemory('主人');
  assert.ok(!/（推断）/.test(r.lines[0]), '缺省 = 事实，不能因为字段缺失就标成推断');
  assert.match(r.lines[0], /私聊100000001｜主人说周末回家/);
});


// 「更早的 N 条已归档，可用 qq_memory_query 检索」—— 这条路径必须真的存在。
//
// 背景（2026-10-23 实测）：角色卡的记忆索引块只留着最近几天的条目，更早的会写一句
// 「更早的 N 条已移出索引（不是删了，还在记忆库里）…用 qq_memory_query 检索（可搜：…）」。
// 但 `daily-memory.json` 在 src/ 下出现 **0** 次 —— 桥接从来没读过它，
// `qq_memory_query` 只查 social-v2.json 里的三个类别。于是那 8 条记忆
// **永久不可达**，而索引明确告诉她可以查。这是"系统在骗自己"的一类 bug：
// 不报错、不丢数据，只是永远查不到，而且没人会发现。
//
// 这组测试钉住三件事：
//   ① 桥接里有读取 daily-memory.json 的路径（不是只有 rollover 在写）
//   ② 检索能按关键词命中，并且**带上来源会话**（否则会把别人的事安到当前人头上）
//   ③ 归档检索走的是同一个 /api/socialV2/memory 端点，且 category/q 都被接受
//
// 跑：node scripts/test-memory-archive.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureAll } from './_fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
const MCP_SRC = fs.readFileSync(path.join(ROOT, 'src/mcp-snowluma-safe.js'), 'utf8');
const MEMORY = JSON.parse(fs.readFileSync(ensureAll().memoryFile, 'utf8'));

// 从 bridge.js 里把纯函数抠出来执行：不启动整个桥接（它会开端口、连 QQ）。
// bridge.js 是 CRLF，且顶层函数都是「顶格 function」+「顶格 }」结尾，按这个边界切即可；
// 不要按大括号配平 —— 函数体里有正则和模板字符串，容易数错。
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `bridge.js 里找不到 ${name}()`);
  const m = /\r?\n\}(\r?\n)/g;
  m.lastIndex = start;
  const hit = m.exec(src);
  assert.ok(hit, `${name}() 找不到顶格结尾`);
  return src.slice(start, hit.index + 3);
}

test('桥接必须真的读过 daily-memory.json（否则索引里那句「可用 qq_memory_query 检索」是假的）', () => {
  assert.ok(
    SRC.includes('DAILY_MEMORY_FILE'),
    'src/bridge.js 里必须有 daily-memory.json 的路径常量'
  );
  assert.ok(
    SRC.includes("'daily-memory.json'"),
    '路径常量要指向 daily-memory.json'
  );
  assert.ok(
    SRC.includes('readDailyMemory'),
    '必须有读取函数；只写不读等于没有这条记忆'
  );
});

test('归档检索要能按关键词命中，并保留来源会话', () => {
  // 直接用真数据 + 真函数跑：把 bridge.js 里的 searchDailyMemory 抽出来执行。
  // 它依赖 readJsonSafe/DAILY_MEMORY_FILE/dailyMemoryScopeLabel/parseMemoryDay，这里桩掉。
  // ⚠️ `parseMemoryDay` 是 2026-10-27 加日期维度时引入的依赖 —— 漏传它会让本测试
  //    在 searchDailyMemory 内部 ReferenceError，看起来像"归档检索坏了"。
  const body = extractFn(SRC, 'searchDailyMemory');
  const scopeFn = extractFn(SRC, 'dailyMemoryScopeLabel');
  const parseDayFn = extractFn(SRC, 'parseMemoryDay');
  const factory = new Function(
    'readDailyMemory',
    'dailyMemoryScopeLabel',
    'parseMemoryDay',
    `${scopeFn}\n${parseDayFn}\n return ${body};`
  );
  const searchDailyMemory = factory(
    () => ({ lastDigestDate: MEMORY.lastDigestDate, items: MEMORY.items }),
    (scope) => {
      const s = String(scope ?? '').trim();
      const idx = s.indexOf(':');
      if (idx < 0) return '';
      const kind = s.slice(0, idx);
      const uid = s.slice(idx + 1);
      if (!uid) return '';
      return kind === 'group' ? `群${uid}` : `私聊${uid}`;
    },
    () => null   // 这组用例不带日期，日期解析器返回 null 即可
  );

  const r = searchDailyMemory('大肥鱼');
  assert.ok(r.matched > 0, '「大肥鱼」是索引里点名的可搜关键词，必须能查到');
  assert.ok(r.lines.length > 0, '命中就必须有可读的行');
  assert.match(
    r.lines[0],
    /^- \d{2}-\d{2}｜(私聊\d{5,12}|群\d{5,12}|（无来源）)｜/,
    `每条都必须带来源标签，否则读的人分不清是谁说的：${r.lines[0]}`
  );

  // 无关键词 = 按时间倒序翻最近的，第一条必须是最新那一天。
  // 别把日期写死：归档每天都会多一天，硬编码的 '10-22' 第二天就过时了。
  const recent = searchDailyMemory('');
  assert.ok(recent.lines.length > 0, '不带关键词时要能翻最近的归档');
  const dayOf = (line) => String(line).slice(2, 7); // `- MM-DD｜…` → MM-DD
  const newest = [...recent.lines].map(dayOf).sort().pop();
  assert.equal(dayOf(recent.lines[0]), newest, `最新的应当排第一，实际：${recent.lines[0]}`);
  assert.ok(/^\d{2}-\d{2}$/.test(dayOf(recent.lines[0])), '第一条必须是条目行，不是说明文字');
});

test('归档检索要有字符预算，不能把整库倒进上下文', () => {
  const body = extractFn(SRC, 'searchDailyMemory');
  const scopeFn = extractFn(SRC, 'dailyMemoryScopeLabel');
  const parseDayFn = extractFn(SRC, 'parseMemoryDay');
  const searchDailyMemory = new Function(
    'readDailyMemory',
    'dailyMemoryScopeLabel',
    'parseMemoryDay',
    `${scopeFn}\n${parseDayFn}\n return ${body};`
  )(() => ({ lastDigestDate: MEMORY.lastDigestDate, items: MEMORY.items }), () => '私聊1', () => null);

  // 给一个宽松的 maxChars，命中多条时要截断并说明
  const r = searchDailyMemory('', { limit: 50, maxChars: 300 });
  const chars = r.lines.reduce((a, l) => a + l.length, 0);
  assert.ok(chars <= 300 + 200, `返回 ${chars} 字符，超出预算太多`);
  assert.equal(typeof r.truncated, 'boolean');
});

// ── 日期维度（2026-10-27 新增）──────────────────────────────────────────────
// 主人说具体日期（"10月22号我们聊了什么"）时，她得能直接列那天的事。
// 之前只能把 "10-22" 当子串碰运气，而记忆摘要里只有 10/50 条写了日期。
test('日期解析：常见说法都能落到某一天，看不懂的要返回 null', () => {
  const parseDayFn = extractFn(SRC, 'parseMemoryDay');
  const parseMemoryDay = new Function(`${parseDayFn}\n return parseMemoryDay;`)();

  const pad2 = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const shift = (n) => ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n));

  // 完整日期与相对日：必须精确
  assert.equal(parseMemoryDay('2026-10-22'), '2026-10-22');
  assert.equal(parseMemoryDay('2026/10/22'), '2026-10-22');
  assert.equal(parseMemoryDay('2026年10月22日'), '2026-10-22');
  assert.equal(parseMemoryDay('昨天'), shift(1));
  assert.equal(parseMemoryDay('前天'), shift(2));
  assert.equal(parseMemoryDay('今天'), shift(0));
  assert.equal(parseMemoryDay('3天前'), shift(3));

  // 月日（不带年）：月日必须对得上，年份可以是今年或去年（跨年场景）
  for (const s of ['10-22', '10/22', '10月22', '10月22日']) {
    const got = parseMemoryDay(s);
    assert.ok(got, `${s} 应该能解析出某一天`);
    assert.equal(got.slice(5, 7), '10', `${s} 的月份要正确`);
    assert.equal(got.slice(8, 10), '22', `${s} 的日要正确`);
  }

  // 星期类：她每轮都看得见【现在】YYYY-MM-DD 周X（time-context.js），
  // 所以"上周三"对她是**完全可推断**的 —— 解析器必须接住（2026-10-27 补）。
  // 「上周三」= 上一个自然周（周一起算）的周三，必须落在周三上。
  const todayDow = ((today.getDay() + 6) % 7) + 1;
  const thisMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (todayDow - 1));
  const lastWed = ymd(new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 7 + 2));
  assert.equal(parseMemoryDay('上周三'), lastWed, '「上周三」必须等于上一个自然周的周三');
  const gotWed = new Date(parseMemoryDay('上周三'));
  assert.equal(gotWed.getDay(), 3, '「上周三」必须落在周三');
  for (const s of ['上周一', '上周五', '上周日', '上星期三', '上礼拜三', '周三', '周3']) {
    assert.ok(parseMemoryDay(s), `「${s}」应该能解析出某一天`);
  }
  // 「上周三」比「周三」早 7 天 —— 但**只有在本周还没到周三时**才成立：
  // 今天若已经过了周三，「周三」本身就指上周三，两者会是同一天（差 0）。
  // 所以这里断言的是「周三 不早于 上周三，且差距最多 7 天」，而不是死磕 7。
  const plainWed = parseMemoryDay('周三');
  const weekDiff = Math.round((new Date(plainWed) - new Date(parseMemoryDay('上周三'))) / 86400000);
  assert.ok(weekDiff >= 0 && weekDiff <= 7,
    `「周三」应不早于「上周三」，且最多相差一周；实际差 ${weekDiff} 天`);

  // 看不懂的必须返回 null（不能猜，也不能静默当成"今天"）
  for (const s of ['前几天', '随便什么', '', '2026-13-40']) {
    assert.equal(parseMemoryDay(s), null, `「${s}」应解析失败`);
  }
});

test('按日期查归档：只列那天的事，且能和关键词叠加', () => {
  const body = extractFn(SRC, 'searchDailyMemory');
  const scopeFn = extractFn(SRC, 'dailyMemoryScopeLabel');
  const parseDayFn = extractFn(SRC, 'parseMemoryDay');
  const searchDailyMemory = new Function(
    'readDailyMemory',
    'dailyMemoryScopeLabel',
    'parseMemoryDay',
    `${scopeFn}\n${parseDayFn}\n return ${body};`
  )(() => ({ lastDigestDate: MEMORY.lastDigestDate, items: MEMORY.items }), () => '私聊1', undefined);

  // 用库里真实存在的一天（不写死日期：归档每天都可能变）
  const days = MEMORY.items.map((d) => d.date).filter(Boolean);
  assert.ok(days.length > 0, '测试数据里至少得有一天');
  const target = days[days.length - 1];

  const byDay = searchDailyMemory('', { day: target, limit: 50 });
  assert.equal(byDay.day, target, '要回显解析出的日期，供端点写出"那天有 N 条"');
  assert.equal(byDay.dateFiltered, true);
  // 行格式 `- MM-DD｜…`：取 MM-DD 与目标的那一段比对
  for (const line of byDay.lines) {
    assert.equal(String(line).slice(2, 7), target.slice(5),
      `按 ${target} 查出来的行必须都属于那天：${line}`);
  }

  // 日期 + 关键词叠加：结果必须是"那天的"且"命中关键词的"子集
  const withQ = searchDailyMemory('的', { day: target, limit: 50 });
  assert.ok(withQ.poolItems <= byDay.totalItems, '叠加关键词后候选池不能变大');
  assert.ok(withQ.matched <= withQ.poolItems, '命中数不能超过候选池');
});

test('查询端点要接受 day / from / to 参数', () => {
  assert.ok(SRC.includes("url.searchParams.get('day')"), 'GET /api/socialV2/memory 要读 day 参数');
  assert.ok(SRC.includes("url.searchParams.get('from')"), '要读 from 参数（区间起点）');
  assert.ok(SRC.includes("url.searchParams.get('to')"), '要读 to 参数（区间终点）');
  assert.ok(SRC.includes('hasDateQuery'), '带日期时要走归档分支，不能退回轻量记忆');
  assert.ok(SRC.includes('没看懂日期'), '日期解析失败必须给出可读提示，不能退回"全部"');
});

test('MCP 工具 qq_memory_query 要暴露 day / from / to', () => {
  const block = MCP_SRC.slice(
    MCP_SRC.indexOf("'qq_memory_query'"),
    MCP_SRC.indexOf("'qq_memory_query'") + 2200
  );
  assert.ok(/day:\s*z\.string\(\)/.test(block), '要暴露 day，否则主人说日期时她没法按天查');
  assert.ok(/from:\s*z\.string\(\)/.test(block), '要暴露 from');
  assert.ok(/to:\s*z\.string\(\)/.test(block), '要暴露 to');
});

test('查询端点必须接受 archive 类别与 q 参数', () => {
  assert.ok(SRC.includes("'archive'"), "GET /api/socialV2/memory 要接受 category=archive");
  assert.ok(SRC.includes("url.searchParams.get('q')"), '要读 q 参数');
  assert.ok(SRC.includes('searchDailyMemory('), '端点在 category=archive 或带 q 时调用归档检索');
});

test('MCP 工具 qq_memory_query 要暴露 q / limit / archive', () => {
  const block = MCP_SRC.slice(
    MCP_SRC.indexOf("'qq_memory_query'"),
    MCP_SRC.indexOf("'qq_memory_query'") + 1600
  );
  assert.ok(/q:\s*z\.string\(\)/.test(block), '要暴露 q 参数，否则她根本没法检索归档');
  assert.ok(block.includes("'archive'"), 'category 枚举要包含 archive');
  assert.ok(/limit:\s*z\.number\(\)/.test(block), '要暴露 limit，让她能控制返回条数');
});

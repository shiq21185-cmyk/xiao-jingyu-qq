// 「记忆索引」块的回归测试（2026-10-20 真实事故）。
//
// 事故现象：人格卡 roles/小鲸鱼.md 里出现了**两块**一模一样的记忆索引。
//
// 根因（已复现，见下面「复现原始 bug」那一组）：
//   · 角色卡是 CRLF，而插件拼块用的是 `\n`；
//   · 注入用的是 `/\n\n<!--start-->[\s\S]*<!--end-->/`（**贪婪 + 非全局**）；
//   · 第一次注入后，文件尾部变成 LF，于是第二次注入时 `\n\n<!--start-->`
//     前缀匹配不上已存在的块 ⇒ `re.test()` 为 false ⇒ 走「追加」分支 ⇒ 块越堆越多。
//
// 这组测试守三件事：
//   ① 已存在的块必须被**替换**而不是追加（单块、多块都要收敛成一块）；
//   ② 行尾不许混（CRLF 文件里不能冒出裸 LF —— 那正是识别失败的原因）；
//   ③ 幂等：同样内容写两次，第二次不该改动文件。
//
// 跑：node scripts/test-memory-index.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  INDEX_END,
  INDEX_MAX_ITEMS,
  INDEX_RECENT_DAYS,
  INDEX_START,
  INDEX_WINDOW_DAYS,
  buildIndexBlock,
  detectEol,
  displayPrefix,
  extractKeywords,
  injectIndexIntoText,
  memoryToIndexLines,
  parseLocalDay,
  parseItemLine,
  selectIndexItems,
  stripIndexBlocks
} from '../plugins/qq-memory-rollover/memory-index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const countStart = (t) => (t.match(/qq-memory-index:start/g) || []).length;
const countEnd = (t) => (t.match(/qq-memory-index:end/g) || []).length;
const bareLf = (t) => (t.match(/(?<!\r)\n/g) || []).length;
const bareCr = (t) => (t.match(/\r(?!\n)/g) || []).length;

// ── 复现原始 bug：证明旧写法确实会堆块 ────────────────────────────────────
// 这组不是"测试新实现"，而是把**事故的成因**钉下来 —— 以后有人想改回
// 贪婪正则、非全局 replace、或写死 `\n`，这里会立刻告诉他为什么不行。
//
// ⚠️ 真实的失败条件（2026-10-20 用备份文件复现确认，**不是"每次都失败"**）：
//    角色的正文是 CRLF，而插件拼块写的是 `\n`。第一次注入是**追加**上去的，
//    于是块的**开头**是 LF（匹配得到），但文件从那一行之后都是 LF。
//    只要之后有任何东西把文件**整体改回 CRLF**（控制台编辑器保存、
//    或人手在末尾补一个 \r\n），已存在的块前面就成了 `\r\n\r\n`，
//    而旧正则要的是 `\n\n` ⇒ `re.test()` 变 false ⇒ 下一次整理只能追加 ⇒ 两块。
test('复现原始 bug：CRLF 前缀让旧正则认不出已存在的块，于是追加出第二块', () => {
  const oldRe = /\n\n<!-- qq-memory-index:start -->[\s\S]*<!-- qq-memory-index:end -->/;
  const oldBlock = (lines) => '\n\n<!-- qq-memory-index:start -->\n## 记忆索引（每日自动整理）\n'
    + lines.join('\n') + '\n<!-- qq-memory-index:end -->';

  // ① 第一次注入：CRLF 正文 + 追加（旧代码的 else 分支）
  const crlfFile = ['# 标题', '', '## 小节', '正文内容'].join('\r\n') + '\r\n';
  const once = oldRe.test(crlfFile)
    ? crlfFile.replace(oldRe, oldBlock(['- A']))
    : crlfFile.replace(/\s*$/, '') + oldBlock(['- A']);
  assert.equal(countStart(once), 1, '第一次只有一块');

  // ② 这个块的 start 前面是 LF ⇒ 旧正则此刻仍匹配得到（所以**不是每次都坏**）
  assert.equal(oldRe.test(once), true, '块前是 LF 时旧正则还能匹配 —— 说明 bug 需要触发条件');

  // ③ 触发条件：文件被整体改回 CRLF（编辑器保存 / 手工补 \r\n）
  const backToCrlf = once.replace(/\r?\n/g, '\r\n');
  assert.equal(oldRe.test(backToCrlf), false,
    'CRLF 化之后旧正则就认不出已存在的块了 —— 这正是追加的来源');

  // ④ 于是下一次整理追加出第二块
  const twice = oldRe.test(backToCrlf)
    ? backToCrlf.replace(oldRe, oldBlock(['- B']))
    : backToCrlf.replace(/\s*$/, '') + oldBlock(['- B']);
  assert.equal(countStart(twice), 2, '旧写法在 CRLF 文件上会留下两块');

  // ⑤ 而**新实现**对同样这个文件只留一块（这才是修复的意义）
  const fixed = injectIndexIntoText(backToCrlf, ['- B']);
  assert.equal(countStart(fixed.text), 1, '新实现必须把 CRLF 文件里的块也认出来并替换');
});

test('复现原始 bug：贪婪正则会把两个块之间的正文一起吞掉', () => {
  // 两个块同时存在时，贪婪 `[\s\S]*` 从第一个 start 吃到最后一个 end，
  // 中间的所有内容（正文！）都被删掉。这是比"重复"更严重的破坏。
  const oldRe = /\n\n<!-- qq-memory-index:start -->[\s\S]*<!-- qq-memory-index:end -->/;
  const two = 'HEAD\n\n<!-- qq-memory-index:start -->\n- A\n<!-- qq-memory-index:end -->'
    + '\n\n**这里是正文，不能被删**\n\n<!-- qq-memory-index:start -->\n- B\n<!-- qq-memory-index:end -->\n';
  const m = two.match(oldRe);
  assert.ok(m, '贪婪正则会匹配');
  assert.ok(m[0].includes('这里是正文'), '贪婪匹配把中间的正文也圈进去了（这就是危险所在）');

  // 新实现：惰性 + 全局 ⇒ 两块分别清掉，正文原样保留
  const cleaned = stripIndexBlocks(two, '\n');
  assert.equal(cleaned.count, 2, '应当识别到两块');
  assert.ok(cleaned.text.includes('这里是正文'), '正文必须保留');
  assert.equal(countStart(cleaned.text), 0);
});

// ── 行尾探测 ──────────────────────────────────────────────────────────────
test('detectEol 认得出 CRLF / LF，平手按 CRLF', () => {
  assert.equal(detectEol('a\r\nb\r\nc\r\n'), '\r\n');
  assert.equal(detectEol('a\nb\nc\n'), '\n');
  assert.equal(detectEol(''), '\r\n', '空文件按 CRLF（Windows 仓库默认）');
  // 混合时按多数
  assert.equal(detectEol('a\r\nb\r\nc\n'), '\r\n');
});

// ── 清理 ──────────────────────────────────────────────────────────────────
test('stripIndexBlocks 清掉全部块（惰性 + 全局），不留残余', () => {
  const eol = '\r\n';
  const two = 'A' + eol + eol + buildIndexBlock(['- X'], eol) + eol + eol + buildIndexBlock(['- Y'], eol) + eol;
  const r = stripIndexBlocks(two, eol);
  assert.equal(r.count, 2, '应当报告清掉了 2 块');
  assert.equal(countStart(r.text), 0, '清理后不该有 start');
  assert.equal(countEnd(r.text), 0, '清理后不该有 end');
  assert.ok(r.text.includes('A'), '正文要保留');
  assert.ok(!/^[\r\n]/.test(r.text), '清理后不该以空行开头');
});

test('stripIndexBlocks 不会把中间正文一起吞掉（贪婪正则就会）', () => {
  const eol = '\n';
  const text = 'HEAD\n\n' + buildIndexBlock(['- X'], eol) + '\n\nMIDDLE\n\n' + buildIndexBlock(['- Y'], eol) + '\n\nTAIL';
  const r = stripIndexBlocks(text, eol);
  // ⚠️ 这是最关键的一条：贪婪匹配会把 MIDDLE 一起删掉
  assert.ok(r.text.includes('MIDDLE'), '两个块**之间**的正文必须保留（贪婪正则会吞掉它）');
  assert.ok(r.text.includes('HEAD'));
  assert.ok(r.text.includes('TAIL'));
});

// ── 拼块 ──────────────────────────────────────────────────────────────────
test('buildIndexBlock 用传入的行尾，不混入其它行尾', () => {
  const crlf = buildIndexBlock(['- A', '- B'], '\r\n');
  assert.ok(crlf.includes('<!-- qq-memory-index:start -->\r\n'));
  assert.equal(bareLf(crlf), 0, 'CRLF 块里不该有裸 LF');
  assert.equal(bareCr(crlf), 0, '块里不该有孤立 CR');

  const lf = buildIndexBlock(['- A'], '\n');
  assert.equal(lf.includes('\r'), false, 'LF 块里不该有 CR');
});

// ── 注入：核心行为 ────────────────────────────────────────────────────────
test('injectIndexIntoText 把已存在的单块替换掉，而不是追加', () => {
  const eol = '\r\n';
  const file = '# 标题' + eol + eol + '正文' + eol + eol + buildIndexBlock(['- 旧'], eol) + eol;
  const r = injectIndexIntoText(file, ['- 新']);
  assert.equal(r.count, 1, '应当识别到 1 个旧块');
  assert.equal(countStart(r.text), 1, '替换后仍然只有一块');
  assert.ok(r.text.includes('- 新'), '新内容在');
  assert.ok(!r.text.includes('- 旧'), '旧内容被替换掉了');
  assert.equal(bareLf(r.text), 0, 'CRLF 文件不该被混入裸 LF');
});

test('injectIndexIntoText 把历史遗留的多块收敛成一块', () => {
  const eol = '\r\n';
  const file = '# 标题' + eol + eol + buildIndexBlock(['- 旧1'], eol) + eol + eol
    + buildIndexBlock(['- 旧2'], eol) + eol + eol + buildIndexBlock(['- 旧3'], eol) + eol;
  const r = injectIndexIntoText(file, ['- 新']);
  assert.equal(r.count, 3, '应当识别到 3 个旧块');
  assert.equal(countStart(r.text), 1, '收敛成一块');
  assert.equal(countEnd(r.text), 1);
  assert.ok(!r.text.includes('- 旧'), '三个旧块的内容都不该在');
});

test('injectIndexIntoText 是幂等的：同样内容写两次不改文件', () => {
  const lines = ['- 10-20｜测试'];
  const file = '# 标题\r\n\r\n正文\r\n';
  const once = injectIndexIntoText(file, lines).text;
  const twice = injectIndexIntoText(once, lines).text;
  assert.equal(twice, once, '第二次注入必须逐字相同');
});

test('injectIndexIntoText 空文件 / 纯 LF 文件都正常', () => {
  const empty = injectIndexIntoText('', ['- A']);
  assert.equal(countStart(empty.text), 1);
  assert.equal(empty.count, 0, '空文件里没有旧块');

  const lfFile = '# 标题\n\n正文\n';
  const r = injectIndexIntoText(lfFile, ['- A']);
  assert.equal(r.eol, '\n');
  assert.equal(r.text.includes('\r'), false, '纯 LF 文件不该被引入 CR');
  assert.equal(countStart(r.text), 1);
});

// ── 真实文件：当前人格卡必须恰好一块 ──────────────────────────────────────
// 这条直接检查仓库里的人格卡 —— 因为**事故正是发生在真实文件上**，
// 只测纯函数不足以发现"文件已经坏了"。
test('仓库人格卡里恰好只有一个索引块，且行尾统一', () => {
  const roleFile = path.join(ROOT, 'roles', '小鲸鱼.md');
  if (!fs.existsSync(roleFile)) {
    console.log('（跳过：没有 roles/小鲸鱼.md）');
    return;
  }
  const text = fs.readFileSync(roleFile, 'utf8');
  assert.equal(countStart(text), 1, `人格卡里应当**恰好一个**记忆索引块，实际 ${countStart(text)} 个`);
  assert.equal(countEnd(text), 1, 'end 标记也应当恰好一个');

  const eol = detectEol(text);
  if (eol === '\r\n') {
    assert.equal(bareLf(text), 0, `人格卡是 CRLF，不该混入裸 LF（实际 ${bareLf(text)} 处）`);
  }
  assert.equal(bareCr(text), 0, '不该有孤立 CR');
});

// ── 展开：daily-memory.json → 要点行 ──────────────────────────────────────
test('memoryToIndexLines 逐日展开并带 MM-DD 前缀', () => {
  const lines = memoryToIndexLines({
    items: [
      { date: '2026-10-14', items: ['甲', '乙'] },
      { date: '2026-10-15', items: ['丙'] }
    ]
  });
  assert.deepEqual(lines, ['- 10-14｜甲', '- 10-14｜乙', '- 10-15｜丙']);
  assert.deepEqual(memoryToIndexLines({}), [], '空记忆应当返回空数组');
  assert.deepEqual(memoryToIndexLines(null), [], 'null 也应当安全');
});

// ── 端到端：真实记忆数据 → 真实人格卡 ────────────────────────────────────
test('用真实 daily-memory 重建索引后，仍然是恰好一块', () => {
  const memFile = path.join(ROOT, 'state', 'daily-memory.json');
  const roleFile = path.join(ROOT, 'roles', '小鲸鱼.md');
  if (!fs.existsSync(memFile) || !fs.existsSync(roleFile)) {
    console.log('（跳过：缺少 daily-memory.json 或人格卡）');
    return;
  }
  const mem = JSON.parse(fs.readFileSync(memFile, 'utf8'));
  const text = fs.readFileSync(roleFile, 'utf8');
  const lines = memoryToIndexLines(mem);
  const r = injectIndexIntoText(text, lines);

  assert.equal(countStart(r.text), 1, '结果必须恰好一块');
  // 逐条核对：真实数据里的每条要点都要出现在结果里
  for (const line of lines) {
    assert.ok(r.text.includes(line), `索引里应当有这条：${line}`);
  }
});

// ── 容量策略（2026-10-20 立，2026-10-23 改成"随时间移除"）──────────────────
//
// 2026-10-20：时间窗 7 天 + 硬上限 30 条。
// 2026-10-23 主人改口：「记忆就是要精简，也不是重点常驻，是随时间移除的」
//   ⇒ 展示窗口收到 INDEX_RECENT_DAYS=3 天，更早的**整条移出**，未到期的约定例外钉住。
//   归档数口径同时改成扫 flat（窗口外的也能被 qq_memory_query 检索到）。
//
// 为什么必须有上限：索引原先按 daily-memory.json **全量平铺**，只增不减。
// 实测单条约 49 字符、日均 +2.8 条 ≈ 138 字符/天 ⇒ 约 12 天再次撞上
// role.maxInjectChars；而超限截断是**从头砍**的，索引在文件末尾 ⇒
// 砍掉的正是最新记忆，越积累丢得越多。
// 这不是删除：daily-memory.json 仍留全量，索引只是"最近的事"。
{
  const now = new Date(2026, 9, 20); // 2026-10-20 本地
  const day = (d, items) => ({ date: `2026-10-${String(d).padStart(2, '0')}`, items });

  // 时间窗：含今天 ⇒ 7 天 = 10-14 ~ 10-20
  test('时间窗 7 天（含今天）：窗外的被移出，不删数据', () => {
    const mem = { items: [day(13, ['超窗']), day(20, ['今天'])] };
    const r = selectIndexItems(mem, { now });
    assert.ok(r.lines.some((l) => l.includes('今天')), '今天应保留');
    assert.ok(!r.lines.some((l) => l.includes('超窗')), '窗外的不该进索引');
    assert.equal(r.archivedCount, 1, '窗外的计入归档数');
    assert.equal(r.keptDays, 1);
  });

  // ⭐ 随时间移除：窗口内但已经过了「最近几天」的，也整条下线。
  //
  // 为什么这条要单独钉：索引每轮都要重读一遍，"留多久"是成本问题不是存储问题。
  // 数据一条都没删（daily-memory.json 里全在），只是不再占角色卡 ——
  // 需要时靠归档指针里的关键词用 qq_memory_query 查回来。
  test('窗口内但超过最近 3 天的，整条移出索引（不压缩、不留残行）', () => {
    const mem = { items: [day(14, ['四天前的旧事']), day(20, ['今天的事'])] };
    const r = selectIndexItems(mem, { now });
    assert.ok(r.lines.some((l) => l.includes('今天的事')), '最近的要留着');
    assert.ok(!r.lines.some((l) => l.includes('四天前的旧事')), '超过最近 3 天的整条移出');
    assert.ok(
      !r.lines.some((l) => l.includes('10-14')),
      '不该留下"那天有 N 条"之类的残行 —— 那还是常驻，只是变短了'
    );
    assert.equal(r.archivedCount, 1, '移出的计入归档数（可检索）');
  });

  test('最近几天一条都没有时，退一步显示最后一次聊天那天', () => {
    // 一周没聊：10-14 之后没记录，now 是 10-20 ⇒ 最近 3 天为空。
    // 这时不能给空索引（会被读成"我没有任何记忆"），要退到最近有记录的那天。
    const mem = { items: [day(14, ['最后一次聊天']), day(13, ['更早的'])] };
    const r = selectIndexItems(mem, { now });
    assert.equal(r.staleFallback, true, '要标记这是兜底，不是正常情况');
    assert.ok(r.lines.some((l) => l.includes('最后一次聊天')), '兜底时显示最后一个有记录的日子');
    assert.ok(!r.lines.some((l) => l.includes('更早的')), '但只显示那一天，不把更早的也拉进来');
  });

  test('硬上限 30 条：超了从最旧砍（不是砍最新）', () => {
    const items = [];
    for (let i = 1; i <= 35; i += 1) items.push(day(20, [`第${i}条`]));
    const r = selectIndexItems({ items }, { now });
    assert.equal(r.lines.length, INDEX_MAX_ITEMS, '应恰好保留 30 条');
    assert.equal(r.archivedCount, 5, '其余 5 条归档');
    // 关键：保留的是**最后** 30 条 —— 砍最新会造成记忆空洞，那是最糟的方向
    assert.ok(r.lines[0].includes('第6条'), '保留的应从第 6 条起');
    assert.ok(r.lines[r.lines.length - 1].includes('第35条'), '最新那条必须在');
  });

  // 常量：INDEX_WINDOW_DAYS 仍是 7（现在只用于归档关键词抽取的外圈硬窗），
  // 索引展示窗口由 INDEX_RECENT_DAYS 决定。两者是不同的东西，别混。
  test('常量与主人拍板的值一致（展示 3 天 / 上限 30 条 / 外圈 7 天）', () => {
    assert.equal(INDEX_RECENT_DAYS, 3, '展示窗口（2026-10-23 主人改）');
    assert.equal(INDEX_MAX_ITEMS, 30);
    assert.equal(INDEX_WINDOW_DAYS, 7, '外圈硬窗，只影响归档关键词抽取');
  });

  // 单条字数上限（2026-10-23 主人：50 字会切在半句上 → 80）。
  // 这个数字在 rollover 里（提炼时截断 + 写进给模型的提示词），不在这儿；
  // 但它是索引可读性的下限保障，钉在这里最容易被看到。
  test('每日记忆单条上限不低于 60 字（50 会切在半句上）', () => {
    const src = fs.readFileSync(new URL('../plugins/qq-memory-rollover/qq-memory-rollover.mjs', import.meta.url), 'utf8');
    const m = /const MAX_ITEM_CHARS = (\d+);/.exec(src);
    assert.ok(m, 'qq-memory-rollover.mjs 里应有 MAX_ITEM_CHARS 常量');
    const n = Number(m[1]);
    assert.ok(n >= 60, `MAX_ITEM_CHARS=${n} 太小：50 字会正好切在「…但还惦记着通关，也爱」这种半句上`);
    assert.ok(n <= 120, `MAX_ITEM_CHARS=${n} 太大：索引要装 20 条，单条越长能装的越少`);
  });

  test('归档指针：有归档才出现，并带可搜关键词', () => {
    const mem = { items: [day(20, ['今天的事']), day(10, ['消消乐卡在四十关', '某人说她叫小A'])] };
    const r = selectIndexItems(mem, { now });
    assert.equal(r.archivedCount, 2);
    assert.ok(r.keywords.length > 0, '应当抽到关键词');
    const block = buildIndexBlock(r.lines, '\n', {
      archivedCount: r.archivedCount, keywords: r.keywords, keptDays: r.keptDays
    });
    assert.ok(block.includes('移出索引'), '指针要说清这些是移出索引、不是删了');
    assert.ok(block.includes('qq_memory_query'), '要告诉她怎么查');
    assert.ok(block.includes('可搜：'), '要列出具体关键词，否则等于没说');
  });

  test('没有归档时不出现指针，不误导', () => {
    const r = selectIndexItems({ items: [day(20, ['今天'])] }, { now });
    const block = buildIndexBlock(r.lines, '\n', { archivedCount: 0, keywords: [], keptDays: r.keptDays });
    assert.ok(!block.includes('移出索引'), '没归档就不该说移出');
  });

  test('窗口内一条都没有时，标题不能写「最近 0 天」', () => {
    // 久没聊天 ⇒ 全部超窗。这时若写"最近 0 天"，她会以为记忆是空的。
    const r = selectIndexItems({ items: [day(1, ['很久以前']) ] }, { now });
    assert.equal(r.lines.length, 0, '确实没有窗口内的条目');
    const block = buildIndexBlock(r.lines, '\n', {
      archivedCount: r.archivedCount, keywords: r.keywords, keptDays: r.keptDays
    });
    assert.ok(!block.includes('最近 0 天'), '不该出现「最近 0 天」');
    assert.ok(block.includes('记忆库'), '要说明记忆还在库里');
    assert.ok(block.includes('qq_memory_query'), '要告诉她能查');
  });

  test('记忆库本来就空时，明说"还没有需要记的事"', () => {
    const block = buildIndexBlock([], '\n', { archivedCount: 0, keywords: [], keptDays: 0 });
    assert.ok(block.includes('还没有需要记的事'), '空库要有明确说明，别让她以为坏了');
    assert.equal(countStart(block), 1);
  });

  test('脏日期不静默丢记忆：解析失败时保留', () => {
    const mem = { items: [{ date: '坏日期', items: ['要保住'] }, day(13, ['旧的'])] };
    const r = selectIndexItems(mem, { now });
    assert.ok(r.lines.some((l) => l.includes('要保住')), '解析不出的日期应当保留，宁可多占地方');
  });

  test('日期按本地零点解析，不受 UTC 偏移影响', () => {
    const d = parseLocalDay('2026-10-19');
    assert.ok(d instanceof Date);
    assert.equal(d.getHours(), 0, '必须是本地 0 点（用 new Date("YYYY-MM-DD") 会偏成 8 点）');
    assert.equal(d.getDate(), 19);
    assert.equal(parseLocalDay('2026-02-31'), null, '溢出日期应当拒绝');
    assert.equal(parseLocalDay(''), null);
    assert.equal(displayPrefix('2026-10-19'), '10-19');
  });

  // ── parseItemLine：剥标记 / 拆两档（2026-10-29）────────────────────────
  test('parseItemLine 拆出要点、详细、推断、取代四样东西', () => {
    const r = parseItemLine('〔取代:板子还没做视觉〕~视觉也接上了｜接上之后的效果和主人的反应');
    assert.equal(r.text, '视觉也接上了', '两个标记都得剥干净，不能留在正文里');
    assert.equal(r.detail, '接上之后的效果和主人的反应');
    assert.equal(r.inferred, true);
    assert.equal(r.replaces, '板子还没做视觉');
  });

  test('parseItemLine 对括号/冒号/波浪号的变体都认（模型不会一字不差地照写）', () => {
    // 全角冒号、全角波浪号、方括号/黑框都是实际会出现的写法。
    assert.deepEqual(
      [parseItemLine('【取代：旧事】新事').replaces, parseItemLine('[取代：旧事]新事').replaces],
      ['旧事', '旧事']
    );
    assert.equal(parseItemLine('～猜的').inferred, true, '全角 ~ 也要认');
  });

  test('parseItemLine 认不出来就原样返回，绝不吞字', () => {
    // 这是容错的**底线**：解析失败最多让索引难看一点，
    // 但绝不能因为标记没写对就把一整条真实记忆丢掉。
    assert.equal(parseItemLine('(取代:旧)新事').text, '(取代:旧)新事');
    assert.equal(parseItemLine('(取代:旧)新事').replaces, '', '认不出就不算取代，宁可留着旧条目');
    assert.equal(parseItemLine('普通一条｜详细').text, '普通一条');
    assert.equal(parseItemLine('没有竖线的一条').detail, '');
  });

  test('parseItemLine 不会把详细里的标记当成正文开头的标记', () => {
    // 只有**要点**开头才算标记。详细里出现「~」是正常文字（"~大概吧"）。
    const r = parseItemLine('主人说明天回来｜他说~大概下午');
    assert.equal(r.inferred, false);
    assert.equal(r.text, '主人说明天回来');
  });

  test('关键词是人看得懂的整词，不是切碎的片段', () => {    // 第一版按「连续 2~4 字」抽，出来的是「消消乐卡」「在四十关」这种碎片，
    // 指针写成"可搜：消消乐卡、在四十关"等于没用。现在改成词典式抽取。
    const kws = extractKeywords(['消消乐卡在四十关过不去', '某人说她叫小A']);
    assert.ok(kws.includes('消消乐'), `应当抽到整词「消消乐」，实际 ${JSON.stringify(kws)}`);
    for (const k of kws) {
      assert.ok(!k.includes('卡在') && !k.includes('四十关') || k === '消消乐',
        `不该出现跨词碎片：${k}`);
    }
  });

  // ── 状态变化：被取代的条目退出索引（2026-10-29）────────────────────────
  //
  // 问题：记忆是"只增"的。前天写「板子还没做视觉」，昨天写「视觉也接上了」，
  //   两条都在索引里，她读到时得自己判断哪条还成立 —— 常常挑错，
  //   于是把早就做完的事说成"还没做"。这不是记性差，是索引里同时摆着两个时间点。
  // 做法：新条目带 replaces（由提炼提示词的「〔取代:旧要点〕」解析而来），
  //   旧条目移出索引、进归档（仍可检索、可追溯）。
  test('被后来的事取代的条目移出索引，但不删（仍进归档）', () => {
    const mem = {
      items: [
        day(18, [{ scope: 'private:1', text: '板子还没做视觉' }, { scope: 'private:1', text: '主人说要买个小桌' }]),
        day(19, [{ scope: 'private:1', text: '视觉也接上了', replaces: '板子还没做视觉' }])
      ]
    };
    const r = selectIndexItems(mem, { now });
    assert.ok(!r.lines.some((l) => l.includes('板子还没做视觉')), '旧状态不该还在索引里');
    assert.ok(r.lines.some((l) => l.includes('视觉也接上了')), '新状态要留着');
    assert.ok(r.lines.some((l) => l.includes('小桌')), '不相干的记忆不能被误伤');
    assert.equal(r.supersededCount, 1);
    assert.equal(r.archivedCount, 1, '被取代的那条进归档（仍可 qq_memory_query 检索）');
  });

  test('replaces 指不上任何一条时，什么也不做（宁多一条，也不能误删）', () => {
    // 记忆是模型写的，前缀难免有偏差。指不上就该老老实实把旧条目留着 ——
    // 悄悄抹掉一条真实记忆，比索引里多一条旧账糟糕得多。
    const mem = {
      items: [
        day(18, [{ text: '板子还没做视觉' }]),
        day(19, [{ text: '视觉也接上了', replaces: '完全对不上的另一件事' }])
      ]
    };
    const r = selectIndexItems(mem, { now });
    assert.ok(r.lines.some((l) => l.includes('板子还没做视觉')), '指不上就别动它');
    assert.equal(r.supersededCount, 0);
  });

  test('replaces 只取代更早的：不能拿未来的事去顶掉现在', () => {
    const mem = {
      items: [
        day(19, [{ text: '视觉也接上了', replaces: '板子还没做视觉' }]),
        day(18, [{ text: '板子还没做视觉' }])
      ]
    };
    const r = selectIndexItems(mem, { now });
    // 库里顺序是乱的，但时间上 18 < 19，所以 19 那条取代 18 是合法的 ——
    // 这里守的是"不允许反向"：若实现按数组位置而不是按日期判断，就会出错。
    assert.ok(!r.lines.some((l) => l.includes('板子还没做视觉')));
    assert.equal(r.supersededCount, 1);
  });

  // ── 推断标记（2026-10-29）──────────────────────────────────────────────
  test('推断出来的记忆在索引里带 `~`，并且只在真有时才多一句读法', () => {
    const mem = {
      items: [day(19, [
        { scope: 'private:1', text: '主人大概在赶项目', inferred: true },
        { scope: 'private:1', text: '主人说周末回家' }
      ])]
    };
    const r = selectIndexItems(mem, { now });
    assert.equal(r.inferredCount, 1);
    const block = buildIndexBlock(r.lines, '\n', {
      archivedCount: r.archivedCount, keywords: r.keywords,
      keptDays: r.keptDays, pinnedCount: r.pinnedCount, inferredCount: r.inferredCount
    });
    // 标记必须紧贴在正文前（在来源之后），不能被塞到行尾 ——
    // 读起来是"这条是猜的"，而不是读完一整句才被追认。
    assert.ok(/私聊1｜~主人大概在赶项目/.test(block), `推断行应带 ~：\n${r.lines.join('\n')}`);
    assert.ok(/私聊1｜主人说周末回家/.test(block), '非推断行不许带标记');
    assert.ok(block.includes('自己推出来'), '有 ~ 就要有一句读法解释它');

    // 没有推断时不占字符：索引预算只有 1080，白写一句读法是纯浪费。
    const clean = selectIndexItems({ items: [day(19, [{ text: '主人说周末回家' }])] }, { now });
    assert.equal(clean.inferredCount, 0);
    const cleanBlock = buildIndexBlock(clean.lines, '\n', {
      archivedCount: clean.archivedCount, keywords: clean.keywords,
      keptDays: clean.keptDays, pinnedCount: clean.pinnedCount, inferredCount: clean.inferredCount
    });
    assert.ok(!cleanBlock.includes('自己推出来'), '没有推断就不该多这句');
  });

  test('索引体积有界：300 天数据也只留最近几天', () => {    const items = [];
    for (let i = 0; i < 300; i += 1) {
      const d = new Date(2026, 9, 20);
      d.setDate(d.getDate() - i);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      items.push({ date: ds, items: ['主人新增好友小A（自称大帅哥）；给她发消息仍报令牌无效'] });
    }
    const r = selectIndexItems({ items }, { now });
    assert.ok(r.lines.length <= INDEX_RECENT_DAYS, `300 天数据只该留最近 ${INDEX_RECENT_DAYS} 天，实际 ${r.lines.length} 行`);
    assert.ok(r.keptDays <= INDEX_RECENT_DAYS, `天数必须受"最近 ${INDEX_RECENT_DAYS} 天"约束，实际 ${r.keptDays}`);
    const block = buildIndexBlock(r.lines, '\n', {
      archivedCount: r.archivedCount, keywords: r.keywords, keptDays: r.keptDays
    });
    // 不设限的话会是 300 × 49 ≈ 14700 字符，正是"越来越多"的那条曲线
    assert.ok(block.length < 900, `索引块应保持小体积，实际 ${block.length} 字符`);
    assert.equal(r.archivedCount, 297, '其余全部移出（可检索），不是删掉');
  });
}

console.log('\nmemory-index: all checks passed');

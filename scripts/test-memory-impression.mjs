// 印象（memberImpression）的容量与截断 —— 这两条是最容易悄悄丢信息的地方。
//
// 为什么值得单独钉住：
//   · 原来 traits 只留 10 条、每条切到 50 字。50 字正好切在「关系定位」之前，
//     她写「今天午休醒了以后问「那我是你的谁呀」… 爱问、不真记仇。」，
//     落库只剩前 50 字，「不真记仇」这种**下次真能用上**的判断就没了。
//   · 去重原来是拿「截断后的 50 字」比的：两条只在后半句不同的印象会被判成同一条，
//     后一条直接丢掉 —— 不报错、不提示，只是悄悄没了。
//
// 这组测试直接调 appendMemoryV2()（纯函数，不碰网络/磁盘），钉住：
//   ① 200 字的印象能整条存下，不会在 50 字处被切
//   ② 只在后半句不同的两条印象都要留下
//   ③ 超过 20 条时按 FIFO 丢最老的，不是丢最新的
//   ④ 空内容不进库
//
// 跑：node scripts/test-memory-impression.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { truncateText } from '../src/md-to-plain.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');

// 从 bridge.js 里现读默认值，别在测试里另抄一份数字 ——
// 否则改了默认值、测试还在钉旧数，两处会慢慢漂开。
function readIntConst(src, name) {
  const m = src.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(m, `bridge.js 里找不到常量 ${name}`);
  return Number(m[1]);
}
const TRAIT_CHARS = readIntConst(SRC, 'IMPRESSION_TRAIT_CHARS_DEFAULT');
const MAX_TRAITS = readIntConst(SRC, 'IMPRESSION_MAX_TRAITS');

// 从 bridge.js 抽出 appendMemoryV2 及其依赖，在一个沙箱里跑。
//
// 注意：appendMemoryV2 不是顶层函数（它缩进 2 空格，定义在一个块里），
// 所以不能按「顶格 }」切 —— 会一路吃到大后面去。这里按「和 function 关键字
// 同缩进的 }」收尾，缩进从源码里现读，别写死。
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `bridge.js 里找不到 ${name}()`);
  const lineStart = src.lastIndexOf('\n', start) + 1;
  const indent = src.slice(lineStart, start);
  assert.match(indent, /^[ \t]*$/, `${name}() 前面不该有别的代码`);
  // bridge.js 是 CRLF，这里必须把 \r 一起吃掉，否则永远匹配不上。
  const re = new RegExp(`\\r?\\n${indent}\\}\\r?\\n`, 'g');
  re.lastIndex = start;
  const hit = re.exec(src);
  assert.ok(hit, `${name}() 找不到同缩进的结尾`);
  const closeAt = hit[0].indexOf('}');
  return src.slice(start, hit.index + closeAt + 1);
}

function buildAppend(maxChars = TRAIT_CHARS) {
  const parts = ['appendMemoryV2', 'redactKnownTokensOnly'].map((n) => extractFn(SRC, n));
  // 两个外部依赖都用桩：
  //   truncateText 用真实现（它就是 md-to-plain 导出的，没必要复刻）
  //   KNOWN_AGENT_TOKENS 给空数组 —— 它只用于把会话令牌替换成 ***，
  //   这组测试不关心令牌，也不该依赖运行时态
  // 印象长度/条数上限是 bridge.js 的模块级量，抽出来的函数体会引用它们，
  // 所以必须一并注入，否则一调用就是 ReferenceError。
  const factory = new Function(
    'truncateText',
    'KNOWN_AGENT_TOKENS',
    'saveSocialV2State',
    'impressionTraitMaxChars',
    'IMPRESSION_MAX_TRAITS',
    `${parts.join('\n')}
     return { appendMemoryV2 };`
  );
  // saveSocialV2State 是落盘副作用，纯函数测试里必须桩掉 ——
  // 否则跑一次测试就会把真实 state/social-v2.json 写坏。
  return factory(truncateText, [], () => {}, () => maxChars, MAX_TRAITS);
}

const { appendMemoryV2 } = buildAppend();

function emptyState() {
  return { activeTopics: [], pendingThoughts: [], memberImpressions: {}, promises: [] };
}

test('真实长印象要整条存下（原来在 50 字处被切）', () => {
  const st = emptyState();
  const long =
    '今天午休醒了以后问「那我是你的谁呀」「我们之间是什么关系」，我答朋友，她也没闹。' +
    '之前说自己要每天被我主动找到。爱问、不真记仇。';
  assert.ok(long.length > 50, `样本必须先超过 50 字，才测得出原来的 bug，实际 ${long.length}`);
  assert.ok(
    long.length <= TRAIT_CHARS,
    `这条真实印象 ${long.length} 字必须装得进当前上限 ${TRAIT_CHARS} 字 —— 装不进就说明上限定小了`
  );
  appendMemoryV2(st, 'memberImpression', long, { target: '100000003', displayName: '林青' });

  const rec = st.memberImpressions['100000003'];
  assert.ok(rec, '印象要落到 target 名下');
  assert.equal(rec.traits.length, 1);
  assert.equal(rec.traits[0], long, '整条都要留下，不能在 50 字处截断');
  assert.ok(rec.traits[0].includes('不真记仇'), '关键判断不能丢');
});

test(`超长印象截到 ${TRAIT_CHARS} 字（不是 50 字）`, () => {
  const st = emptyState();
  const huge = '甲'.repeat(TRAIT_CHARS + 180);
  appendMemoryV2(st, 'memberImpression', huge, { target: '100000003' });
  const stored = st.memberImpressions['100000003'].traits[0];
  assert.equal(stored.length, TRAIT_CHARS, `应截到 ${TRAIT_CHARS} 字，实际 ${stored.length}`);
});

test('只在后半句不同的两条印象都要留下（去重比原文，不比截断结果）', () => {
  const st = emptyState();
  // head 本身就要超过 50 字，这样两条的 50 字前缀才会相同 —— 正是原来被误判成重复的形态。
  const head =
    '今天午休醒了以后问「那我是你的谁呀」「我们之间是什么关系」，我答朋友，她也没闹，也没追问。' +
    '之前还说过自己要每天被我主动找到，说一整天没消息会生气。';
  assert.ok(head.length > 50, `head 必须超过 50 字，实际 ${head.length}`);
  const a = `${head}爱问、不真记仇。`;
  const b = `${head}也会自己说「原谅你」，但记得住。`;
  assert.equal(a.slice(0, 50), b.slice(0, 50), '这两条的 50 字前缀必须相同，才测得出原来的 bug');

  appendMemoryV2(st, 'memberImpression', a, { target: '100000003' });
  appendMemoryV2(st, 'memberImpression', b, { target: '100000003' });
  assert.equal(st.memberImpressions['100000003'].traits.length, 2, '后半句不同就是两条不同的印象');
});

test('完全相同的印象不重复入库', () => {
  const st = emptyState();
  const x = '爱聊夜话';
  appendMemoryV2(st, 'memberImpression', x, { target: '100000003' });
  appendMemoryV2(st, 'memberImpression', x, { target: '100000003' });
  assert.equal(st.memberImpressions['100000003'].traits.length, 1);
});

test(`超过 ${MAX_TRAITS} 条时丢最老的，保留最新的`, () => {
  const st = emptyState();
  for (let i = 1; i <= MAX_TRAITS + 5; i += 1) {
    appendMemoryV2(st, 'memberImpression', `印象编号 ${i}`, { target: '100000003' });
  }
  const traits = st.memberImpressions['100000003'].traits;
  assert.equal(traits.length, MAX_TRAITS, `上限应为 ${MAX_TRAITS} 条，实际 ${traits.length}`);
  assert.ok(!traits.includes('印象编号 1'), '最老的应被挤出');
  assert.ok(traits.includes(`印象编号 ${MAX_TRAITS + 5}`), '最新的必须留着');
});

test('空内容 / 纯空白不入库', () => {
  const st = emptyState();
  appendMemoryV2(st, 'memberImpression', '', { target: '100000003' });
  appendMemoryV2(st, 'memberImpression', '   \n  ', { target: '100000003' });
  const rec = st.memberImpressions['100000003'];
  assert.equal(rec?.traits?.length ?? 0, 0, '空白不该变成一条印象');
});

test('印象必须挂在 target 上，不能落到公共区', () => {
  const st = emptyState();
  appendMemoryV2(st, 'memberImpression', '爱问关系', { target: '100000003' });
  assert.deepEqual(Object.keys(st.memberImpressions), ['100000003']);
  assert.equal(st.activeTopics.length, 0, '印象不该污染话题列表');
});

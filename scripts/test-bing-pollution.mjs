// Bing 反爬污染页的自检回归（2026-10-21 实测事故）。
//
// ── 事故经过（同一查询连抓十几次的结果分布）────────────────────────────────
//   `消消乐 冰花`：
//     · 0 条（页面写「没有与此相关的结果」）—— 诚实，等于没搜到；
//     · 8 条，全是**瑞典女权主义**；
//     · 8 条，全是 **WhatsApp 网页版**；
//     · 8 条，全是**电子税务局**；
//     · 8 条，Mihon 漫画阅读器；
//     · 8 条，小红书攻略（这条是对的）。
//   `蚌埠住了什么意思` → 8 条飞书官网；`今天杭州天气` → 曾返回 DeepSeek 官网。
//
// ⚠️ 关键：这些垃圾页的 HTML **结构完全合法**（`b_algo` / `h2` / `a href` 一应俱全），
//    旧解析器照单全收。**这比返回空列表危险得多** —— 空列表她会说「没搜到」，
//    垃圾列表她会照着胡说。
//
// ── 判据怎么定的（用实测筛掉的）────────────────────────────────────────────
//   ✗ `sb_count`（「约 N 个结果」）—— 垃圾页也带计数（实测「约 50 个结果」配税务局内容）
//   ✗ 2-gram 词重合 —— `今天杭州天气` 的好结果命中 0%（Bing 标题写的是「天气预报」）
//   ✓ **单字重合（去虚词）**：
//       DeepSeek Harness 100% / 原神 新角色 100% / 今天杭州天气 20%（都对）
//       消消乐 冰花 0% / 蚌埠住了什么意思 0%（都是垃圾）
//   ⇒ 判据是「一个查询实字都没出现在任何结果的标题+摘要里」才整批丢弃（保守阈值，防误杀）。
//
// 跑：node --test scripts/test-bing-pollution.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'mcp-web-search-safe.js'), 'utf8');

// 把三个纯函数抽出来单测（它们不依赖网络）
function loadHelpers() {
  const start = SRC.indexOf('const QUERY_STOP_CHARS');
  const end = SRC.indexOf('async function bingSearch(');
  assert.ok(start > 0 && end > start, '找不到 QUERY_STOP_CHARS / looksUnrelated / pageSaysNoResults');
  const block = SRC.slice(start, end);
  return new Function(`${block}; return { queryContentChars, looksUnrelated, pageSaysNoResults };`)();
}
const { queryContentChars, looksUnrelated, pageSaysNoResults, relevanceRatio } = loadHelpers();

console.log('— 1. pageSaysNoResults：明确无结果要认出来 —');
test('认出 b_no 标记', () => {
  assert.equal(pageSaysNoResults('<li class="b_no"><h1>没有与此相关的结果</h1>'), true);
});

test('认出中文文案（即使没有 class 标记）', () => {
  assert.equal(pageSaysNoResults('<div>没有与此相关的结果: <strong>xxx</strong></div>'), true);
});

test('正常结果页不误判', () => {
  assert.equal(pageSaysNoResults('<li class="b_algo"><h2>杭州天气预报</h2>'), false);
});

console.log('— 2. queryContentChars：只留实字 —');
test('去掉虚词与标点', () => {
  const got = queryContentChars('消消乐 冰花怎么消');
  assert.ok(got.includes('消'));
  assert.ok(got.includes('冰'));
  assert.ok(got.includes('花'));
  assert.ok(!got.includes('怎'), '"怎" 是虚词，不该参与判定');
  assert.ok(!got.includes('么'), '"么" 是虚词');
  assert.ok(!got.includes(' '), '空格不是字');
});

test('英文查询保留字母数字', () => {
  const got = queryContentChars('DeepSeek Harness');
  assert.ok(got.includes('d'));
  assert.ok(got.includes('h'));
});

console.log('— 3. looksUnrelated：垃圾页要判出来，好结果不能误杀 —');
const mk = (...titles) => titles.map((t) => ({ title: t, url: 'https://x.test/', snippet: '' }));

// ⚠️ 下面每条「垃圾」用例的标题都是**实测抓到的原文**，不是编的。
test('❌ 垃圾页：消消乐 冰花 ← 税务局内容（命中率 0%）', () => {
  const results = mk('自然人电子税务局扣缴端怎么更换选择地区', '新版电子税务局如何一键零申报');
  assert.equal(looksUnrelated('消消乐 冰花', results), true);
});

test('❌ 垃圾页：消消乐 冰花 ← WhatsApp（命中率 0%）', () => {
  assert.equal(looksUnrelated('消消乐 冰花', mk('WhatsApp网页版', 'WhatsApp 网页版')), true);
});

test('❌ 垃圾页：消消乐 冰花 ← 「消（汉语汉字）」—— 单字命中 25% 也要拦', () => {
  // 这条是校准时的关键用例：用「0 命中才判」会放过它（"消"字命中了）
  assert.equal(looksUnrelated('消消乐 冰花', mk('消 （汉语汉字）_百度百科')), true, '命中率 25% < 40%，应判垃圾');
});

test('❌ 垃圾页：蚌埠住了什么意思 ← 飞书官网（命中率 0%）', () => {
  assert.equal(looksUnrelated('蚌埠住了什么意思', mk('下载飞书 App 及桌面客户端', '文档 - 飞书文档 - Feishu')), true);
});

test('❌ 垃圾页：今天杭州天气 ← dat 文件教程（命中率 0%）', () => {
  assert.equal(looksUnrelated('今天杭州天气', mk('如何打开dat文件 - 百度经验')), true);
});

test('❌ 垃圾页：今天杭州天气 ← DeepSeek 官网（命中率 0%）', () => {
  assert.equal(looksUnrelated('今天杭州天气', mk('DeepSeek | Into the Unknown')), true);
});

test('✅ 好结果不能误杀：DeepSeek Harness（100%）', () => {
  assert.equal(looksUnrelated('DeepSeek Harness', mk('DeepSeek Harness - GitHub', 'DeepSeek Harness 教程')), false);
});

test('✅ 好结果不能误杀：今天杭州天气（实测 80%，标题写的是「天气预报」）', () => {
  // 关键用例：query 里没有「预报」，但 天/气 在标题里 → 命中率够
  assert.equal(looksUnrelated('今天杭州天气', mk('杭州天气预报,杭州7天天气预报,杭州15天天气预报')), false);
});

test('✅ 好结果不能误杀：原神 新角色（100%）', () => {
  assert.equal(looksUnrelated('原神 新角色', mk('原神新角色爆料', '原神 3.0 新角色')), false);
});

test('✅ 好结果不能误杀：鸣潮 新角色（100%，她真实搜过的那次）', () => {
  assert.equal(looksUnrelated('鸣潮 新角色', mk('鸣潮新角色公布 - 官方')), false);
});

test('✅ 真结果：消消乐 冰花 命中了就该放行（100%）', () => {
  // 反证：这个查询本身没问题，是必应有时给垃圾
  assert.equal(looksUnrelated('消消乐 冰花', mk('开心消消乐冰花怎么消除', '消消乐冰花道具攻略')), false);
});

test('摘要里命中也算（不只是标题）', () => {
  const results = [{ title: '某某新闻', url: 'https://x.test/', snippet: '今天杭州天气晴，最高 26 度' }];
  assert.equal(looksUnrelated('今天杭州天气', results), false, '摘要提到也算相关');
});

console.log('— 4. 边界 —');
test('查询没有实字（纯符号）→ 不判垃圾（无从判断就不误杀）', () => {
  assert.equal(looksUnrelated('？？？', mk('随便什么')), false);
  assert.equal(looksUnrelated('', mk('随便什么')), false);
});

test('结果为空 → 谈不上"不相关"', () => {
  assert.equal(looksUnrelated('消消乐 冰花', []), false, '空结果走的是另一条分支（note 里说明没搜到）');
});

console.log('— 5. 接线：自检真的接进 bingSearch 了 —');
test('bingSearch 会调 pageSaysNoResults 并返回空 + note', () => {
  const start = SRC.indexOf('async function bingSearch(');
  const body = SRC.slice(start, start + 2200);
  assert.match(body, /pageSaysNoResults\(html\)/, '必须检查无结果标记');
  assert.match(body, /looksUnrelated\(query, results\)/, '必须检查相关性');
  assert.match(body, /results: \[\]/, '判为垃圾时要清空 results');
  assert.match(body, /note:/, '必须带 note 说明为什么是空的（否则她分不清「没搜到」和「被顶替」）');
});

test('note 会原样传给模型（不能被吞掉）', () => {
  // 工具处理函数把整个 result 序列化后交给模型
  assert.match(SRC, /JSON\.stringify\(result, null, 2\)/, '整个 result（含 note）都要序列化');
});

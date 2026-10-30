// bridge.js 结构地图的时效性检查（2026-10-20）。
//
// 背景：主人说"文件太大"，我们决定**不拆 main()**，改用结构地图（src/bridge.MAP.md）
// 让我改代码前先查表定位。但地图靠行号，行号会随代码变化过期 ——
// **过期的地图比没有地图更危险**（照着旧行号改，会改错地方）。
//
// 所以这条测试：读地图里记的关键行号，去实际代码里核对，对不上就报错。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const MAP = new URL('../src/bridge.MAP.md', import.meta.url);
const SRC = new URL('../src/bridge.js', import.meta.url);

test('结构地图存在，且包含关键内容', () => {
  assert.ok(fs.existsSync(MAP), '缺少 src/bridge.MAP.md —— 跑 node scripts/mapgen.mjs');
  const md = fs.readFileSync(MAP, 'utf8');
  assert.match(md, /总行数：/, '地图要记录总行数');
  assert.ok(md.includes('内嵌函数'), '地图要有内嵌函数清单');
  assert.ok(md.includes('拆分时踩过的坑'), '地图要记下踩过的坑');
  assert.ok(md.includes('main()'), '地图要标出 main() 的范围');
});

test('地图里的 main() 起始行与代码一致', () => {
  const md = fs.readFileSync(MAP, 'utf8');
  const src = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);

  // 地图里的分区行形如：| **1569–13980** | **`main()` 主体（88%）** |
  const m = /\*\*(\d+)–(\d+)\*\*\s*\|\s*\*\*`main\(\)`/.exec(md);
  assert.ok(m, '地图里找不到 main() 的行号区间');
  const from = Number(m[1]);
  const to = Number(m[2]);

  const realStart = src.findIndex((l) => /^(?:async )?function main\b/.test(l)) + 1;
  assert.equal(from, realStart,
    '地图说 main() 从第 ' + from + ' 行开始，实际在第 ' + realStart
    + ' 行 —— 地图过期了，跑 node scripts/mapgen.mjs');

  let callLine = -1;
  for (let i = src.length - 1; i >= 0; i -= 1) {
    if (/^main\(\)\.catch/.test(src[i].trim())) { callLine = i + 1; break; }
  }
  let realEnd = -1;
  for (let i = callLine - 2; i > realStart; i -= 1) {
    if (src[i] === '}') { realEnd = i + 1; break; }
  }
  assert.equal(to, realEnd,
    '地图说 main() 到第 ' + to + ' 行结束，实际在第 ' + realEnd
    + ' 行 —— 地图过期了，跑 node scripts/mapgen.mjs');
});

test('地图记的总行数与实际接近（±20 行容差）', () => {
  const md = fs.readFileSync(MAP, 'utf8');
  const src = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
  const m = /总行数：\*\*(\d+)\*\*/.exec(md);
  assert.ok(m, '地图里找不到总行数');
  const claimed = Number(m[1]);
  const real = src.length;
  assert.ok(Math.abs(claimed - real) <= 20,
    '地图记的总行数 ' + claimed + '，实际 ' + real
    + ' —— 差得太多，地图过期了，跑 node scripts/mapgen.mjs');
});

test('地图表格里列的已抽出模块都真实存在', () => {
  const md = fs.readFileSync(MAP, 'utf8');
  // ⚠️ 只查**表格行**（以 | 开头），不查正文 ——
  //    正文里提到的可能是历史说明（比如"试拆过 xx 后回滚了"），那种文件本来就不该存在。
  //    2026-10-20 就踩过：回滚后正文写了 qq-text.js 的回滚说明，测试把它当成"模块缺失"。
  const names = [...md.matchAll(/^\|\s*`src\/([\w.-]+)\.js`\s*\|/gm)].map((x) => x[1]);
  for (const n of names) {
    const f = new URL('../src/' + n + '.js', import.meta.url);
    assert.ok(fs.existsSync(f), '地图表格说已抽出 src/' + n + '.js，但文件不存在');
  }
  // 空表也算正常（回滚后就没有已抽出的模块了）
});

test('地图里列的顶层函数确实在那些行上', () => {
  const md = fs.readFileSync(MAP, 'utf8');
  const src = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
  // 抽表格行：| 250 | `readJsonSafe` | 22 |
  const rows = [...md.matchAll(/^\|\s*(\d+)\s*\|\s*`(\w+)`\s*\|\s*(\d+)\s*\|$/gm)];
  assert.ok(rows.length > 10, '地图里的函数表太短，可能生成失败');
  for (const [, lineStr, name] of rows) {
    const line = Number(lineStr);
    const text = src[line - 1] ?? '';
    assert.ok(
      new RegExp('(?:async )?function ' + name + '\\b').test(text),
      '地图说 ' + name + ' 在第 ' + line + ' 行，但那里是：' + text.trim().slice(0, 60)
    );
  }
});

// ⭐ 2026-10-21 加：上面那条只查"地图指的行号上有这个函数"，
// 但**新增了函数却忘了重生成地图**时，它照样绿（旧条目全对）。
// 这里补一条双向核对：地图里的函数集合必须与实际完全一致 —— 多了、少了都红。
test('地图的函数集合与实际完全一致（新增/删除函数也要更新地图）', () => {
  const md = fs.readFileSync(MAP, 'utf8');
  const src = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);

  // 地图里的（顶层 + 内嵌全表）
  const inMap = new Set(
    [...md.matchAll(/^\|\s*\d+\s*\|\s*`(\w+)`\s*\|/gm)].map((m) => m[1])
  );

  // 实际的：缩进 0（顶层）和缩进 2（main 内嵌）
  const actual = new Set();
  for (const l of src) {
    const m = /^ {0,2}(?:async )?function (\w+)/.exec(l);
    if (m) actual.add(m[1]);
  }

  const missing = [...actual].filter((n) => !inMap.has(n));
  const extra = [...inMap].filter((n) => !actual.has(n));

  assert.deepEqual(missing, [],
    '这些函数在代码里存在、地图里没有（新增了函数却忘了重生成地图？跑 node scripts/mapgen.mjs）：'
    + missing.join(', '));
  assert.deepEqual(extra, [],
    '这些函数地图里有、代码里已经没了（删了函数却忘了重生成地图？跑 node scripts/mapgen.mjs）：'
    + extra.join(', '));
});

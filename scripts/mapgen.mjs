// 生成 bridge.js 结构地图。
//
// 为什么需要它（主人 2026-10-20：「你调取的文件也太大了，能不能分成几个小的」）：
//   改 1.4 万行文件里的某处时，我得先读一大段才能定位。有了地图，先查表 → 精确读那几十行。
//
// ⚠️ main() 的边界**不能**用大括号配平算 —— 字符串/注释/正则里的 { } 会让它失准
//    （第一版算出 main 只有 1 行）。改成：main 定义行 → 到 `main().catch` 之前最后一个顶格 `}`。
import fs from 'node:fs';

const SRC = 'src/bridge.js';
const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
const total = lines.length;

function collectFns(indent) {
  const re = new RegExp(`^${' '.repeat(indent)}(?:async )?function (\\w+)`);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = re.exec(lines[i]);
    if (m) out.push({ name: m[1], start: i + 1 });
  }
  return out;
}
const topFns = collectFns(0);
const innerFns = collectFns(2);

const mainStart = (topFns.find((f) => f.name === 'main') || {}).start;

let callLine = -1;
for (let i = lines.length - 1; i >= 0; i -= 1) {
  if (/^main\(\)\.catch/.test(lines[i].trim())) { callLine = i + 1; break; }
}
let mainEnd = -1;
for (let i = callLine - 2; i > mainStart; i -= 1) {
  if (lines[i] === '}') { mainEnd = i + 1; break; }
}
const mainSize = mainEnd - mainStart + 1;
const mainPct = ((mainSize / total) * 100).toFixed(0);

for (let i = 0; i < topFns.length; i += 1) {
  const next = i + 1 < topFns.length ? topFns[i + 1].start : total + 1;
  topFns[i].size = next - topFns[i].start;
}
for (let i = 0; i < innerFns.length; i += 1) {
  const next = i + 1 < innerFns.length ? innerFns[i + 1].start : total + 1;
  innerFns[i].size = next - innerFns[i].start;
}

const buckets = [];
for (let s = mainStart; s < mainEnd; s += 1000) {
  const e = Math.min(s + 999, mainEnd);
  const inB = innerFns.filter((f) => f.start >= s && f.start <= e);
  buckets.push({ from: s, to: e, count: inB.length, sample: inB.slice(0, 4).map((f) => f.name) });
}

const md = [];
const push = (...xs) => md.push(...xs);

push('# bridge.js 结构地图', '');
push(`> 自动生成于 ${new Date().toLocaleString('zh-CN')}。**改代码前先查这里**，别通读全文。`);
push('> 重新生成：`node scripts/mapgen.mjs`（或 `npm run map`）', '');
push('## 规模', '');
push(`- 总行数：**${total}**`);
push(`- 顶层函数：**${topFns.length}** 个`);
push(`- \`main()\` 内嵌函数：**${innerFns.length}** 个`);
push(`- \`main()\` 占 **${mainSize} 行（${mainPct}%）** —— 这就是"文件太大"的主体`, '');
push('## 文件分区', '');
push('| 行段 | 内容 |', '| --- | --- |');
push('| 1–95 | import + 常量 |');
push(`| 96–${mainStart - 1} | 顶层工具函数（JSON 读写、角色卡、preset、日志、脱敏…） |`);
push(`| **${mainStart}–${mainEnd}** | **\`main()\` 主体（${mainPct}%）** |`);
push(`| ${mainEnd + 1}–${total} | 启动：\`main().catch(...)\` + 进程级钩子 |`, '');
push('## 顶层函数', '');
push('| 行号 | 函数 | 约行数 |', '| --- | --- | --- |');
for (const f of topFns) push(`| ${f.start} | \`${f.name}\` | ${f.size} |`);
push('');
push('## `main()` 内部密度', '');
push('（每 1000 行有几个内嵌函数；密度高的地方是功能密集区，改之前多读几行）', '');
push('| 行段 | 内嵌函数 | 代表 |', '| --- | --- | --- |');
for (const b of buckets) push(`| ${b.from}–${b.to} | ${b.count} | ${b.sample.join(', ') || '—'} |`);
push('');
push('## 内嵌函数全表', '');
push(`<details><summary>点开（${innerFns.length} 个）</summary>`, '');
push('| 行号 | 函数 | 约行数 |', '| --- | --- | --- |');
for (const f of innerFns) push(`| ${f.start} | \`${f.name}\` | ${f.size} |`);
push('', '</details>', '');
push('## 已抽出的模块', '');
push('');
push('| 文件 | 内容 | 原位置 |', '| --- | --- | --- |');
push('（暂无。2026-10-20 试拆过 `src/qq-text.js`，后来按主人决定回滚了 —— 见下方「关于拆分」）');
push('');
push('## 拆分时踩过的坑（务必记住）', '');
push('1. **搬函数必须连常量一起搬，并查"还有谁在用那个常量"**。');
push('   `REASONING_EFFORT_OPTIONS` 搬走后 bridge 里还有 4 处在用，忘了导出 ⇒ `/api/dsh/model` 500。');
push('   查法：搜常量名看**全部**出现点，不是只看定义处。');
push('2. **加 import 不能只看"行首是 import 的行"**。');
push('   多行 import 的中间行不以 `import` 开头，按行首判断会把新 import 插进别人中间 ⇒ 语法错。');
push('3. **审计 harness 要跟着改**：`scripts/audit-bridge-harness.mjs` 用 `...sensitive` 那种写法');
push('   把各模块导出摊进 VM 上下文，新模块不摊进去 ⇒ 测试里 `XXX is not defined`。');
push('4. **改完必须跑全量** `node scripts/test-audit.mjs`。');
push('   上面两个错都**不在正常聊天路径上**，手动试发现不了，只有测试能抓。');
push('5. **别用大括号配平算 main() 边界**：字符串/正则里的 `{` 会骗过它。');

fs.writeFileSync('src/bridge.MAP.md', md.join('\n'), 'utf8');
console.log('已生成 src/bridge.MAP.md');
console.log(`  main(): ${mainStart}-${mainEnd} (${mainSize} 行, ${mainPct}%)`);
console.log(`  顶层函数 ${topFns.length} / 内嵌 ${innerFns.length}`);

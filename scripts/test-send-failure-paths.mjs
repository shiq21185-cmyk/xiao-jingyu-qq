// 「发送端点的失败路径」回归（2026-10-21，来源：上游 issue 与代码对照）。
//
// ── 背景 ──────────────────────────────────────────────────────────────────
// `/api/socialV2/send-burst` 与 `/api/send/{group,private,reply}` 都在 try 里
// **预占**发送额度（往 st.sendTimes 里 push），失败时在 catch 里**回滚**。
// 而 `st` / `now` 曾经声明在 try 内部 —— catch 是另一个块作用域，看不见它们。
//
// 后果（这是最糟的一类）：只要发送失败就抛
//   `ReferenceError: st is not defined`
// 于是：
//   ① 真实错误（「你已被移出该群」）被这个 ReferenceError 遮盖，日志里查不到根因；
//   ② `sendJson` 那一行根本执行不到，HTTP 请求一直挂着直到客户端超时；
//   ③ 预占的额度没回滚，后续正常发送会被假的 429 拦住。
//
// 而且它**只在失败路径出现** —— 平时全是绿的，所以必须有测试盯着。
//
// ── 这个测试怎么盯 ────────────────────────────────────────────────────────
// 用静态扫描（读源码文本）而不是跑真实请求：真实失败路径要控网关、要它恰好掉线，
// 在单测里不可靠。这里只看结构：**每个带 catch 回滚的块，st/now 必须声明在 try 外面**。
//
// 跑：node --test scripts/test-send-failure-paths.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const LINES = SRC.split(/\r?\n/);

/** 找出所有「catch 里回滚 sendTimes」的位置，返回它所在 try 的起始行。 */
function findRollbackCatches() {
  const out = [];
  for (let i = 0; i < LINES.length; i += 1) {
    // 回滚的特征写法：在 catch 里 indexOf(now) + splice
    if (!/st\.sendTimes\.indexOf\(now\)/.test(LINES[i])) continue;
    // 往上找最近的 `} catch (error) {`
    let j = i;
    while (j >= 0 && !/^\s*\} catch \(\w+\) \{/.test(LINES[j])) j -= 1;
    assert.ok(j >= 0, `第 ${i + 1} 行的回滚找不到它所在的 catch`);
    // 再往上找最近的 `try {`
    let k = j;
    while (k >= 0 && !/^\s*try \{$/.test(LINES[k])) k -= 1;
    assert.ok(k >= 0, `第 ${j + 1} 行的 catch 找不到对应的 try`);
    out.push({ rollbackLine: i + 1, catchLine: j + 1, tryLine: k + 1 });
  }
  return out;
}

test('catch 里回滚发送额度的块，st 必须可用（外层声明，或在 catch 里重新取）', () => {
  const sites = findRollbackCatches();
  assert.ok(sites.length > 0, '没找到任何回滚点 —— 说明这段代码被重构了，请同步更新本测试');
  for (const site of sites) {
    // 合法的两种写法：
    //   (a) const st 声明在 try 外面（catch 直接可见）；
    //   (b) catch 内部自己重新 `const st = getSocialV2State(key)`。
    // 非法写法只有一个：只声明在 try 里，catch 既没重取也没有外层声明。
    const before = LINES.slice(Math.max(0, site.tryLine - 60), site.tryLine - 1).join('\n');
    const catchChunk = LINES.slice(site.catchLine - 1, site.catchLine + 6).join('\n');
    const declaredOutside = /const st = getSocialV2State\(key\)/.test(before);
    const refetchedInCatch = /const st = getSocialV2State\(key\)/.test(catchChunk);
    assert.ok(
      declaredOutside || refetchedInCatch,
      `第 ${site.tryLine} 行的 try 里声明了 st，而 catch（第 ${site.catchLine} 行）既没重新取、外层也没有 —— 发送失败时会 ReferenceError`
    );

    // now 是纯值，没有「重新取」的合法写法，必须在 try 外面。
    assert.match(
      before,
      /const now = Date\.now\(\)/,
      `第 ${site.tryLine} 行的 try 之前没有声明 now —— catch（第 ${site.catchLine} 行）里会 ReferenceError`
    );
  }
});

test('try 内部不得声明 st 又不给 catch 重取（块作用域陷阱）', () => {
  const sites = findRollbackCatches();
  for (const site of sites) {
    const before = LINES.slice(Math.max(0, site.tryLine - 60), site.tryLine - 1).join('\n');
    const head = LINES.slice(site.tryLine, site.tryLine + 8).join('\n');
    const catchHead = LINES.slice(site.catchLine - 1, site.catchLine + 6).join('\n');
    const declaredInsideTry = /const st = getSocialV2State\(key\)/.test(head);
    if (!declaredInsideTry) continue; // 已经提外面了，没问题
    const declaredOutside = /const st = getSocialV2State\(key\)/.test(before);
    const refetched = /const st = getSocialV2State\(key\)/.test(catchHead);
    assert.ok(
      declaredOutside || refetched,
      `第 ${site.tryLine} 行的 try 内部声明了 st，而 catch 没有重新取 —— 这就是那个 ReferenceError 陷阱`
    );
  }
});

test('回滚额度之后一定要 saveSocialV2State + 回一个明确错误', () => {
  const sites = findRollbackCatches();
  for (const site of sites) {
    // catch 块的范围：从 catch 行到下一个 `return;` 或 `}` 结束为止，取 25 行足够
    const chunk = LINES.slice(site.catchLine - 1, site.catchLine + 25).join('\n');
    assert.match(chunk, /saveSocialV2State\(\)/, `第 ${site.catchLine} 行的 catch 回滚后没有 saveSocialV2State`);
    assert.match(
      chunk,
      /sendJson\(\{ ok: false, error:/,
      `第 ${site.catchLine} 行的 catch 没有回给调用方明确错误 —— 请求会挂到超时`
    );
  }
});

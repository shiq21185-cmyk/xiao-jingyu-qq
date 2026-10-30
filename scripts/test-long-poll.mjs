// 长轮询绕开 undici 300 秒 headersTimeout 的回归（2026-10-21 实测确认）。
//
// ── 实测数据（这是本文件存在的唯一理由）────────────────────────────────────
// 用一个 320 秒后才回头的本地服务端试：
//   · 全局 fetch（undici）→ **305 秒** 抛 `UND_ERR_HEADERS_TIMEOUT`，必然失败；
//   · node:http           → 撑满 320 秒正常拿到响应。
//
// 而桥接的等待端点允许等到 `socialV2.wait.maxMs`（默认 600000 = 10 分钟），
// `qq_request_permission` 更是给到 620 秒。也就是说：**任何超过 5 分钟的等待，
// 走全局 fetch 都注定失败。**
//
// 后果链：AI 拿不到结果 → 重试 → 桥接侧 activeWaits 仍占着会话 → 重新等待被 429
// → 空转烧 token，而且模型会以为「他还没回话」而不是「我的等待断了」。
//
// ── 这个文件钉住什么 ──────────────────────────────────────────────────────
//   ① 存在 node:http 的长轮询通道
//   ② **分流点在 agentApi 一处**（调用方不用自己记住走哪条通道，也就不会漏）
//   ③ 阈值 290000（> 300s 才分流，留 10s 余量避免边界抖动）
//   ④ 长轮询通道仍然保留同样的鉴权头与 ok:false 判定（不能是一条裸通道）
//   ⑤ socket timeout 必须是 0（否则等待期间没数据会被自己掐断）
//
// 跑：node scripts/test-long-poll.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');

test('存在 node:http 的长轮询通道（不是全局 fetch）', () => {
  assert.match(MCP, /function agentApiLongPoll/, '必须有 agentApiLongPoll');
  assert.match(MCP, /import http from 'node:http'/m, '必须引入 node:http');
  const start = MCP.indexOf('function agentApiLongPoll');
  const body = MCP.slice(start, MCP.indexOf('async function agentApi('));
  assert.doesNotMatch(body, /await fetch\(/, '这条通道里不能用全局 fetch —— 那正是要绕开的东西');
  assert.match(body, /mod\.request\(/, '要用 node:http 的 request');
});

test('分流点收敛在 agentApi 一处（调用方不用自己判断）', () => {
  const start = MCP.indexOf('async function agentApi(');
  const head = MCP.slice(start, start + 600);
  assert.match(head, /if \(timeoutMs > 290000\) return agentApiLongPoll\(path, init\)/, 'agentApi 里要按预算分流');
  // 阈值必须是 290000：> 300s 才分流，留 10s 余量
  assert.match(head, /timeoutMs > 290000/, '阈值写成 290000（300s 减 10s 余量）');
  // 不允许调用方各自写分支（排除函数定义行与注释）
  const callSites = (MCP.match(/.*agentApiLongPoll\(.*/g) || [])
    .filter((l) => !/^\s*(\/\/|function )/.test(l.trim()) && !l.includes('function agentApiLongPoll'));
  assert.equal(callSites.length, 1, `agentApiLongPoll 只该在 agentApi 里被调用一次，实际 ${callSites.length} 处：${callSites.map((s) => s.trim()).join(' | ')}`);
});

test('长轮询通道保留鉴权头与 ok:false 判定（不是裸通道）', () => {
  const start = MCP.indexOf('function agentApiLongPoll');
  const body = MCP.slice(start, MCP.indexOf('async function agentApi('));
  assert.match(body, /x-console-token/, '必须带控制台令牌');
  assert.match(body, /headers\['x-agent-call'\] = '1'/, "必须声明「这是一次智能体调用」");
  assert.match(body, /\.\.\.\(init\.headers \?\? \{\}\)/, '调用方传的头（含 x-agent-token）要展开进来');
  assert.match(body, /body\.ok === false/, '200 + ok:false 也要当失败（否则静默错误）');
  assert.match(body, /content-length/, '要显式给 content-length');
});

test('socket timeout 必须是 0（等待期间本来就没字节往来）', () => {
  const start = MCP.indexOf('function agentApiLongPoll');
  const body = MCP.slice(start, MCP.indexOf('async function agentApi('));
  assert.match(body, /timeout: 0/, 'socket idle timeout 必须关掉，否则空闲即断');
  assert.match(body, /setTimeout\(\(\) => \{[\s\S]{0,200}\}, timeoutMs\)/, '用自己的预算做总超时');
});

test('超时错误要说人话（不能只抛 ECONNRESET）', () => {
  const start = MCP.indexOf('function agentApiLongPoll');
  const body = MCP.slice(start, MCP.indexOf('async function agentApi('));
  assert.match(body, /等待超时/, '超时要给出可读说明');
  assert.match(body, /长轮询没等到回应|没等到回应/, '要讲清是「等待断了」而不是对方没说话');
});

test('普通请求仍然走 undici（长轮询是例外，不是全改）', () => {
  const start = MCP.indexOf('async function agentApi(');
  const body = MCP.slice(start, start + 1200);
  assert.match(body, /await fetch\(/, '普通请求继续用 fetch（更省事，且都在 300s 内）');
});

test('预算超过 300s 的调用确实存在（否则这条通道没意义）', () => {
  // request-permission 等主人回话最多 10 分钟 → 620s
  assert.match(MCP, /timeoutMs: 620000/, '申请闸门需要 >300s 预算');
  // 等待端点也有长预算
  const long = (MCP.match(/timeoutMs: (\d{6,})/g) || [])
    .map((s) => Number(s.replace(/\D/g, '')))
    .filter((n) => n > 290000);
  assert.ok(long.length >= 1, `应至少有一个 >290s 的预算，实际 ${long.length} 个`);
});

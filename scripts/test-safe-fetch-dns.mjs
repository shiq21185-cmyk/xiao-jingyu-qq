// DNS 多地址故障切换的回归（2026-10-21，来源：上游 r4 与实测现象）。
//
// ── 修的到底是什么 ────────────────────────────────────────────────────────
// 原来 `resolveSafeHost` 校验了**全部**解析结果，却只 `return addresses[0]`。
// 而 `dns.lookup` 的返回顺序是**轮转/不确定**的 —— 同一个域名今天先给 A、明天先给 AAAA。
// 本机常常只有 IPv4 出口，于是：
//
//   · 抢到第一个是 AAAA 的那次请求 → 连不上 → 一路等到 20 秒超时；
//   · 同一时刻抢到 A 的那次 → 正常拿到图。
//
// 表现就是「**部分**表情包/图片/网页时好时坏」，而且重试一次往往就好了。
// QQ 的表情 CDN（gxh.vip.qq.com / p.qpic.cn / multimedia.nt.qq.com.cn）与
// raw.githubusercontent.com 都同时有 AAAA/A 记录，所以命中率不低。
//
// ── 这个文件钉住什么 ──────────────────────────────────────────────────────
//   ① `resolveSafeAddresses` 返回**全部**地址，而不是一个
//   ② 排序 **IPv4 优先、两族交替**（v6-only 主机也能第一时间命中）
//   ③ 任何一个地址落在内网/本机 → **整条拒绝**（不能"校验公网的、实际连内网的"）
//   ④ 多地址时单次预算 8s < 总预算 20s（坏地址要早点放弃）
//   ⑤ 单地址时仍用满 20s 总预算（慢速滴流要等得住）
//
// 跑：node scripts/test-safe-fetch-dns.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'safe-fetch.js'), 'utf8');

test('对外导出 resolveSafeAddresses（返回全部地址）', () => {
  assert.match(SRC, /export async function resolveSafeAddresses/, '必须导出 resolveSafeAddresses');
  // 关键：不能还留着「只取第一个」的老实现
  assert.doesNotMatch(
    SRC,
    /export async function resolveSafeHost\(hostname\) \{[\s\S]{0,1200}?return addresses\[0\]\.address;\s*\}/,
    'resolveSafeHost 里不能再直接 return addresses[0]（那是老的单地址实现）'
  );
});

test('地址排序：IPv4 优先、两族交替', () => {
  assert.match(SRC, /function orderAddresses/, '必须有 orderAddresses');
  assert.match(SRC, /const v4 = addresses\.filter/, '要分出 v4');
  assert.match(SRC, /const v6 = addresses\.filter/, '要分出 v6');
  // 交替排布的实现特征：同一个循环里先 push v4[i] 再 push v6[i]
  assert.match(SRC, /for \(let i = 0; i < max; i \+= 1\)/, '必须用 max 循环做交替');
  assert.match(SRC, /if \(v4\[i\]\) ordered\.push\(v4\[i\]\)/, '交替要放 v4');
  assert.match(SRC, /if \(v6\[i\]\) ordered\.push\(v6\[i\]\)/, '交替要放 v6');
  // 反例：不能写成「v4 全放前面、v6 全放后面」（那样 v4 全坏时还得等一轮）
  assert.doesNotMatch(SRC, /ordered\.push\(\.\.\.v4, \.\.\.v6\)/, '不能简单拼接（必须交替）');
});

test('解析结果必须逐个校验，一个内网就整条拒绝', () => {
  const start = SRC.indexOf('export async function resolveSafeAddresses');
  const body = SRC.slice(start, start + 1600);
  assert.match(body, /for \(const \{ address \} of addresses\)/, '必须遍历全部地址校验');
  assert.match(body, /isPrivateIp\(address\)/, '逐个校验 isPrivateIp');
  assert.match(body, /域名解析到内网\/本机地址，已阻止/, '命中内网要整条拒绝');
});

test('多地址时用单次预算 8s，单地址时仍用满 20s', () => {
  assert.match(SRC, /const REQUEST_TIMEOUT_MS = 20000;/, '总预算应为 20s');
  assert.match(SRC, /const ATTEMPT_TIMEOUT_MS = 8000;/, '单次预算应为 8s');
  assert.match(SRC, /const MAX_ADDRESS_ATTEMPTS = 4;/, '最多试 4 个地址');
  // 单地址走满总预算，多地址才切到单次预算
  assert.match(
    SRC,
    /list\.length === 1 \? REQUEST_TIMEOUT_MS : Math\.min\(ATTEMPT_TIMEOUT_MS, remaining\)/,
    '必须区分单地址/多地址的预算'
  );
});

test('故障切换只换连接目标，不换 Host/SNI', () => {
  const start = SRC.indexOf('async function requestWithFailover');
  assert.ok(start > 0, '必须有 requestWithFailover');
  const body = SRC.slice(start, start + 1400);
  assert.match(body, /requestOnce\(url, list\[i\], limit, binary, budget\)/, '要逐地址调用 requestOnce');
  // requestOnce 内部仍然是 host: url.host —— 换的是 hostname(IP)，不是 Host 头
  assert.match(SRC, /host: url\.host,/, 'Host 头必须是原站点域名，不能变成 IP');
  assert.match(SRC, /servername: url\.protocol === 'https:'/, 'SNI 必须是原站点域名（TLS 才不会失败）');
});

test('策略类错误不重试（内网/非法 URL 换地址也没用）', () => {
  const start = SRC.indexOf('async function requestWithFailover');
  const body = SRC.slice(start, start + 1600);
  assert.match(body, /isRetryableError\(error\)/, '必须区分「可重试」与「策略拒绝」');
  const helper = SRC.slice(SRC.indexOf('function isRetryableError'));
  const helperBody = helper.slice(0, helper.indexOf('\n}\n'));
  assert.match(helperBody, /ECONNREFUSED/, '连接被拒值得换地址');
  assert.match(helperBody, /ECONNRESET/, '连接被重置值得换地址');
  assert.match(helperBody, /ETIMEDOUT/, '超时值得换地址');
  // 明确不该把「禁止访问内网」当可重试
  assert.doesNotMatch(helperBody, /内网|禁止访问|URL 无效/, '策略拒绝不能被当成可重试');
});

test('两个 fetch 入口都改走故障切换（别漏掉 buffer 那条）', () => {
  const safeFetchBody = SRC.slice(SRC.indexOf('export async function safeFetch('));
  assert.match(safeFetchBody.slice(0, 900), /requestWithFailover\(url, addresses/, 'safeFetch 要走故障切换');
  const bufferBody = SRC.slice(SRC.indexOf('export async function safeFetchBuffer('));
  assert.match(bufferBody.slice(0, 900), /requestWithFailover\(url, addresses/, 'safeFetchBuffer 也要走故障切换（图片正是重灾区）');
  // 老的单地址调用点必须清干净（注意别把 `function requestOnce(url, ip, ...)` 的定义当调用）
  assert.doesNotMatch(
    SRC,
    /(?<!function )requestOnce\(url, ip,/,
    '不能再有 requestOnce(url, ip, ...) 这种单地址调用'
  );
});

test('超时的错误对象要标 retryable（否则不会换地址）', () => {
  const matches = SRC.match(/error\.retryable = true/g) || [];
  assert.ok(matches.length >= 2, '定时器超时与 socket 超时两处都要标 retryable，实际 ' + matches.length + ' 处');
});

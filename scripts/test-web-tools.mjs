// DSH 原生联网搜索 / 抓取的分档回归（2026-10-21 主人决定「两个都加，
// web_fetch 只允许管理员私信使用」）。
//
// ── 背景 ──────────────────────────────────────────────────────────────────
// 我们自己的 `mcp__web-search-safe__web_search` 是抓 Bing HTML，实测中文长尾查询
// **大概率全灭**（「消消乐 冰花」「蚌埠住了什么意思」三连空，失败时抓到的是
// 反爬挑战页 —— 84K 字符但 b_algo/h2 都是 0 个）。
//
// 而 DSH 原生 `web_search` 走 `ctx.web.search`，和主人在 Harness 里用的是**同一路**。
// 它一直在 DSH 的 asar 里，只是被 preset 的 `search: false` 关掉了、又被守卫挡了。
//
// ── 为什么两个工具要分档 ──────────────────────────────────────────────────
//   · `web_search` 参数只有 `queries: string[]` —— **不接受 URL ⇒ 没有 SSRF 面**。
//     群友没法借它让桥接去访问任意地址。所以三类会话全开是安全的。
//   · `web_fetch`  参数是**任意 URL** —— 群里给出去等于人肉代理。
//     DSH 的 SSRF 防护能挡私网（ipaddr 判 non-unicast + 连接层 pin DNS + 只跟同源重定向），
//     但**挡不住公网**：群友可以让她去抓任意公网站点，确认她的出口 IP、让她读钓鱼页。
//     ⇒ 只对管理员私聊开放。
//
// ⚠️ 本测试直接调 `verdictFor(name, kind)`：`kind` 是 **字符串**（不是 agent 对象），
//    取值见守卫里的 SESSION_KIND 常量。守卫按 `exec.agent.session.id` 反查得出 kind，
//    那部分（ownerLookup / sessionKind）由 test-permit-gate.mjs 覆盖 —— 这里只验分档。
//
// 跑：node --test scripts/test-web-tools.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'js-yaml';
import { verdictFor } from '../plugins/qq-agent-presets/qq-tool-restrict.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 与守卫里的 SESSION_KIND 对应（那边没导出，这里照抄字符串值，并由本文件断言它们真的生效）
const OWNER = 'owner-private';
const GROUP = 'group';
const MEMBER = 'member-private';
const ALL = [OWNER, GROUP, MEMBER];

const v = (name, kind) => verdictFor(name, kind);

console.log('— 1. web_search：三类会话全开（它不接受 URL，没有 SSRF 面）—');
test('web_search 在管理员私聊放行', () => {
  assert.equal(v('web_search', OWNER), undefined, '管理员私聊必须能用');
});

test('web_search 在群聊放行', () => {
  assert.equal(v('web_search', GROUP), undefined, '群聊要用它查资料（中文长尾只有它能查到）');
});

test('web_search 在普通成员私聊放行', () => {
  assert.equal(v('web_search', MEMBER), undefined);
});

console.log('— 2. web_fetch：只给管理员私聊（它接受任意 URL）—');
test('web_fetch 在管理员私聊放行', () => {
  assert.equal(v('web_fetch', OWNER), undefined, '主人私聊要能读正文');
});

test('web_fetch 在群聊被拒，且给出替代方案', () => {
  const r = v('web_fetch', GROUP);
  assert.ok(typeof r === 'string' && r.length > 0, '群聊必须被拒');
  assert.match(r, /只允许管理员私聊/, '拒绝理由要说清是权限问题');
  assert.match(r, /web_read_link/, '要告诉她群里该改用哪个工具（否则她会反复试同一个）');
});

test('web_fetch 在普通成员私聊被拒', () => {
  const r = v('web_fetch', MEMBER);
  assert.ok(typeof r === 'string' && r.length > 0, '普通成员私聊必须被拒');
  assert.match(r, /只允许管理员私聊/);
});

test('web_fetch 不在 SAFE_EXACT 里（否则就跟着 web_search 一起全放了）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'plugins/qq-agent-presets/qq-tool-restrict.mjs'), 'utf8');
  const start = src.indexOf('const SAFE_EXACT = new Set([');
  const block = src.slice(start, src.indexOf('])', start));
  assert.doesNotMatch(block, /'web_fetch'/, "绝不能把 web_fetch 放进 SAFE_EXACT —— 那等于三类会话全放，闸门白装");
  assert.match(block, /'web_search'/, 'web_search 应该在 SAFE_EXACT 里');
});

console.log('— 3. 原有安全边界没被放松 —');
test('本地执行类工具仍然全拒（没顺手放开）', () => {
  for (const name of ['pwsh', 'bash', 'write', 'edit', 'read']) {
    for (const kind of ALL) {
      assert.ok(typeof v(name, kind) === 'string', `${name} 在 ${kind} 必须仍然被拒`);
    }
  }
});

test('手机工具仍然受申请闸门约束（没被这次改动顺带放开）', () => {
  for (const kind of ALL) {
    assert.ok(typeof v('mcp__phone__phone_screenshot', kind) === 'string', '手机工具必须仍然需要授权');
  }
});

test('未知工具仍然默认拒绝（白名单没变成放行一切）', () => {
  assert.ok(typeof v('some_random_tool', OWNER) === 'string', '不在名单里的一律拒，含管理员私聊');
});

test('mcp__web-search-safe__* 仍然全部放行（原有通道没被影响）', () => {
  for (const name of ['mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch', 'mcp__web-search-safe__web_read_link']) {
    assert.equal(v(name, GROUP), undefined, `${name} 应继续放行`);
  }
});

console.log('— 4. preset 侧把没 key 的 web_search 关掉，fetch 留给守卫分档 —');
test('qq-chat-v2 的 tool-web 是 search:false / fetch:true', () => {
  const docs = YAML.loadAll(fs.readFileSync(path.join(ROOT, 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml'), 'utf8'));
  const flat = JSON.stringify(docs);
  // 2026-10-23 主人要求关掉：这台机器没配 DEEPSEEK_API_KEY，她的会话 provider=workbuddy
  // 用不了账号登录态，一调就报「no API key」，白占一次往返还会被当成故障。
  assert.ok(flat.includes('"search":false'), 'search 必须关（没配 DEEPSEEK_API_KEY，开了只会报错）');
  assert.ok(flat.includes('"fetch":true'), 'fetch 必须打开（分档由守卫做，不靠关工具）');
  assert.doesNotMatch(flat, /"search":true/, '不能还留着 search:true');
});

test('生成出来的 patch 也同步了（DSH 实际读的是它，不是源文件）', () => {
  const patch = fs.readFileSync(path.join(ROOT, 'plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml'), 'utf8');
  assert.match(patch, /id: tool-web/, 'patch 里要有 tool-web');
  assert.match(patch, /search: false/, 'patch 里 search 要是 false');
  assert.match(patch, /fetch: true/, 'patch 里 fetch 要是 true');
});

// 2026-10-21 晚修正：实测 `web_search` 在这台机器**每次都报没有 DEEPSEEK_API_KEY**
// （16:09 那次真调用就是 `ok:false`），所以提示词改成「直接别用」，
// 不再让她先撞一次墙 —— 那会白烧一轮上下文。
// 守卫侧的放行**仍然保留**：哪天配了 key，她就能直接用，不用再改代码。
test('提示词禁止她用 web_search（没 key 必失败，别浪费轮次）', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml'), 'utf8');
  assert.match(yml, /不要用\s*`?web_search`?/, '要明说不要用');
  assert.match(yml, /DEEPSEEK_API_KEY/, '要说清原因（没这个 key）');
  assert.match(yml, /每次都报错/, '要说明是「已知必失败」，否则她会想试一次');
  assert.match(yml, /搜索就用\s*mcp__web-search-safe__web_search/, '要指定替代工具');
});

test('提示词说明空列表不是「网上没有」（防止自己编答案）', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml'), 'utf8');
  assert.match(yml, /空列表/, '要提到空列表');
  assert.match(yml, /别当成/, '要讲清空列表 ≠ 网上没有');
});

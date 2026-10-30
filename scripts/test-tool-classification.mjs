// 工具面分类不变式测试 —— 防「新工具默认对群聊开放」（2026-10-26 加）。
//
// 这个测试存在的理由（真实事故苗子）：
//   守卫的执行期白名单是**前缀整包放行**（SAFE_PREFIXES 里的 `mcp__snowluma__`、
//   `mcp__web-search-safe__`）。所以往那两个 MCP server 里**新增一个工具**时，
//   如果没人记得同时去 verdictFor 里先判一次，它就从第一天起对所有会话开放 ——
//   包括 QQ 群。判定的默认值是"允许"，而默认值应该是"必须有人明确表态"。
//
//   2026-10-26 的工具面审计就是这么查出两格的：`web_read_current`（读主人此刻
//   正在看的那一页）与 `web_list_tabs`（列出他开着的标签页）跟着前缀落进了
//   "三类会话全开"，于是群聊里任何人都能让她去念主人屏幕上的浏览器。
//   已修（见 OWNER_BROWSER_READ_TOOLS），本测试就是那次修的钉子。
//
// 断言两条，都是"漏一格就红"：
//   ① 任何 MCP 工具只要在**群聊 / 普通成员私聊**里被放行，就必须在
//      `OPEN_TO_ALL_SESSIONS` 这份显式名单里 —— 新工具要么登记，要么被更早拒掉。
//   ② 名单里的每个 MCP 名字都必须真实存在、且真的三类都放行（防手误、防登记了
//      但其实被更早的判定拒掉，那种"假登记"会让名单失去意义）。
//
// 跑：node scripts/test-tool-classification.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verdictFor,
  privilegeMatrix,
  OPEN_TO_ALL_SESSIONS,
  OWNER_AND_GROUP_TOOLS
} from '../plugins/qq-agent-presets/qq-tool-restrict.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 三类会话的字符串值 —— 与守卫里的 SESSION_KIND 一致（那个常量没导出，
// 导出它没有意义：真正的真相是 verdictFor 本身，这里只需要喂对字面量）。
const OWNER = 'owner-private';
const GROUP = 'group';
const MEMBER = 'member-private';

// 三个 MCP server 的文件 → DSH 里的工具名前缀。
// 前缀必须写对：守卫看到的是**全名**（`mcp__snowluma__qq_say`），
// 审计脚本第一版忘了加前缀，于是所有 qq_* 都撞上兜底拒绝，得出一张全红的假表。
const SERVERS = [
  ['src/mcp-snowluma-safe.js', 'mcp__snowluma__'],
  ['src/mcp-web-search-safe.js', 'mcp__web-search-safe__'],
  ['src/mcp-host-server.js', 'mcp__snowluma-host__']
];

/**
 * 从 MCP server 源码里抓注册的工具名。
 *
 * 为什么用正则扫源码而不是"问活的 MCP server"：这些 server 是 DSH 拉起来的 stdio 进程，
 * 测试里起一遍要握手、要超时控制，还依赖 DSH 在跑。而"注册了哪些工具"这件事，
 * 源码里 `server.tool(\n  '名字',` 这个写法就是它的唯一真相（65 个全是这个形状）。
 * ⚠️ 如果哪天改成别的注册写法（比如从表里循环注册），这里会**解析到 0 个**而静默通过 ——
 *    所以下面有 `names.length > 0` 的硬断言把这种情况挡住。
 */
function toolNames(file) {
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*server\.tool\(\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const m = /^\s*'([^']+)'/.exec(lines[j]);
      if (m) { out.push(m[1]); break; }
    }
  }
  return out;
}

const all = [];
for (const [file, prefix] of SERVERS) {
  const names = toolNames(file);
  assert.ok(names.length > 0,
    `${file} 里一个 server.tool(...) 都没解析到 —— 注册写法变了，本测试的解析方式要跟着改（别让它静默失效）`);
  for (const n of names) all.push(prefix + n);
}

// 重名自检：不同 server 里同名工具会被前缀区分，真出现重复说明解析串了。
assert.equal(new Set(all).size, all.length,
  `工具全名出现重复：${all.filter((n, i) => all.indexOf(n) !== i).join(', ')}`);

// ── ① 群聊/普通成员私聊能过的，必须在显式名单里 ──────────────────────────
// 2026-10-29 起有第三种放行形态：「管理员私聊 + 群聊」放、普通成员私聊不放
// （生图 qq_draw_image/qq_send_image 就是这一档，主人口径 m01927）。
// 它不满足 OPEN_TO_ALL_SESSIONS 的"三类通用"语义，所以单独一个登记表。
const silentlyOpen = [];
for (const n of all) {
  const g = verdictFor(n, GROUP, {});
  const m = verdictFor(n, MEMBER, {});
  if (g !== undefined && m !== undefined) continue;
  const registered = m === undefined
    ? OPEN_TO_ALL_SESSIONS.has(n)                       // 三类通用
    : OWNER_AND_GROUP_TOOLS.has(n);                     // 群聊 + 管理员私聊
  if (!registered) {
    silentlyOpen.push(`${n}（群聊：${g === undefined ? '放行' : '拒'}；成员私聊：${m === undefined ? '放行' : '拒'}）`);
  }
}
assert.deepEqual(silentlyOpen, [],
  '这些工具会被群聊或普通成员私聊放行，但没在 OPEN_TO_ALL_SESSIONS / OWNER_AND_GROUP_TOOLS 里登记。\n'
  + '新工具必须三选一：① 在 verdictFor 里更早地按会话分档拒掉；'
  + '② 确认它确实可以三类通用，加进 plugins/qq-agent-presets/qq-tool-restrict.mjs 的 OPEN_TO_ALL_SESSIONS；'
  + '③ 只在管理员私聊 + 群聊放行，加进 OWNER_AND_GROUP_TOOLS。\n'
  + silentlyOpen.join('\n'));

// ── ② 名单不能有"假登记" ────────────────────────────────────────────────
const mcpInList = [...OPEN_TO_ALL_SESSIONS].filter((n) => n.startsWith('mcp__'));
const unknown = mcpInList.filter((n) => !all.includes(n));
assert.deepEqual(unknown, [],
  `OPEN_TO_ALL_SESSIONS 里这些名字在 MCP server 源码里找不到（写错/工具已删）：${unknown.join(', ')}`);

const notReallyOpen = [];
for (const n of mcpInList) {
  for (const [label, kind] of [['管理员私聊', OWNER], ['群聊', GROUP], ['普通成员私聊', MEMBER]]) {
    const r = verdictFor(n, kind, {});
    if (r !== undefined) notReallyOpen.push(`${n} @ ${label}：${String(r).slice(0, 40)}…`);
  }
}
assert.deepEqual(notReallyOpen, [],
  '这些工具登记成了"三类通用"，但实际判定里有会话被拒 —— 名单和判定不一致：\n'
  + notReallyOpen.join('\n'));

// ── ③ OWNER_AND_GROUP_TOOLS：管理员私聊 + 群聊放行、普通成员私聊拒绝 ──────
// 生图这一档（主人口径 m01927：群里也开、别的好友不开）。三个方向都钉死，
// 免得以后有人"顺手"把它挪进 OPEN_TO_ALL_SESSIONS 或 OWNER_PRIVATE_ONLY。
for (const n of OWNER_AND_GROUP_TOOLS) {
  assert.equal(verdictFor(n, OWNER, {}), undefined, `${n} 应当对管理员私聊放行`);
  assert.equal(verdictFor(n, GROUP, {}), undefined, `${n} 应当对群聊放行（主人要求群里也能出图）`);
  assert.notEqual(verdictFor(n, MEMBER, {}), undefined,
    `${n} 绝不能对普通成员私聊放行（一张图 ¥0.038，预算不能对每个陌生人敞开）`);
}

// ── ④ 今天修的那两格，钉死 ─────────────────────────────────────────────
for (const n of [
  'mcp__web-search-safe__web_read_current',
  'mcp__web-search-safe__web_list_tabs'
]) {
  assert.equal(verdictFor(n, OWNER, {}), undefined,
    `${n} 应当对管理员私聊放行（那是给他自己看的）`);
  assert.notEqual(verdictFor(n, GROUP, {}), undefined,
    `${n} 绝不能对群聊放行 —— 它读的是主人屏幕上的浏览器（2026-10-26 审计修的就是这一格）`);
  assert.notEqual(verdictFor(n, MEMBER, {}), undefined,
    `${n} 绝不能对普通成员私聊放行 —— 同上`);
}

// ── ⑤ 权能矩阵必须是**全量**的（2026-10-29 重整）────────────────────────
// 矩阵是控制台那页「哪类人 × 哪个工具」的表。它以前只登记了 77 个工具里的 39 个，
// 剩下 46 个照样被前缀白名单放行，但表上看不见 —— 看表的人会以为"没列出来的就是没有"。
// 这条断言把它钉死：三个 MCP server 注册的每个工具都必须在某个组里露面。
const matrix = privilegeMatrix();
const rowsInMatrix = new Map();
for (const g of matrix.groups) {
  assert.ok(g.id && g.label, `矩阵分组缺 id/label：${JSON.stringify(g.id ?? '(空)')}`);
  assert.ok(Array.isArray(g.tools) && g.tools.length > 0,
    `矩阵分组 ${g.id} 里没有工具 —— 空组只会让表看起来更全，实际上什么也没说`);
  for (const t of g.tools) {
    assert.ok(!rowsInMatrix.has(t),
      `工具 ${t} 在矩阵里出现了两次（${rowsInMatrix.get(t)} 与 ${g.id}）—— 一张表里同一个工具两行，读者没法判断哪行算数`);
    rowsInMatrix.set(t, g.id);
  }
}
const notInMatrix = all.filter((n) => !rowsInMatrix.has(n));
assert.deepEqual(notInMatrix, [],
  `这些 MCP 工具**会被放行**，但没进控制台权能矩阵 —— 看表的人会误以为它们不存在。\n`
  + `补进 privilegeMatrix() 的某个分组里（或者先在 verdictFor 里拒掉再归类）：\n`
  + notInMatrix.join('\n'));

// 每组成员必须"同一档"：如果一组里混了放行和拒绝，说明分组写错了，
// 读者会以为整组都是一个口径。判定仍以 verdictFor 为准，这里只是防止误导。
const mixedGroups = [];
for (const g of matrix.groups) {
  const grids = new Set(g.tools.map((t) =>
    [OWNER, GROUP, MEMBER].map((k) => (verdictFor(t, k, {}) === undefined ? '放' : '拒')).join('')));
  if (grids.size > 1) mixedGroups.push(`${g.id}：${[...grids].join(' / ')}`);
}
assert.deepEqual(mixedGroups, [],
  `这些分组里混了不同档位的工具，表上会读成"整组一个口径"：\n${mixedGroups.join('\n')}`);

// ── ⑥ 每个 qq_ 工具都必须能被控制台关掉（2026-10-29 审计补）─────────────
// 起因：审计发现 6 个开关（qzoneFeeds / qzoneLike / qzoneComment / qzoneDelete /
// qzoneSetRight / qzoneUnlike）桥接在**调用期**读了，MCP 注册期却没登记 ⇒
// 控制台显示"已关闭"，模型每轮仍收到完整描述，调用之后才吃 403。
// 那正是 src/mcp-snowluma-safe.js 自己在注释里写着"别漏登记"的那件事，
// 只是一直没人守 —— 所以把它变成断言。
//
// 断言两向：
//   ① 注册出来的每个 qq_ 工具，要么在 TOOL_CONFIG_FLAGS 里有开关，
//      要么在 ALWAYS_REGISTER（刻意的常驻例外：关了也要保留注册，
//      好让她拿到"这是主人关的、不是坏了"这句解释）。
//   ② 表里的每个开关名字必须真在 src/bridge.js 里出现过 —— 防止登记一个
//      谁也读不到的开关（控制台显示"能关"，实际关了没效果，更隐蔽）。
const mcpSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
const flagStart = mcpSrc.indexOf('const TOOL_CONFIG_FLAGS = {');
const flagEnd = mcpSrc.indexOf('\n};', flagStart);
assert.ok(flagStart > 0 && flagEnd > flagStart,
  'TOOL_CONFIG_FLAGS 表没解析到 —— 表结构变了，本测试的解析方式要跟着改（别让它静默失效）');
const flagBody = mcpSrc.slice(flagStart, flagEnd);

const toolToFlag = new Map();
for (const m of flagBody.matchAll(/^\s*(qq_[a-z_0-9]+):\s*'([A-Za-z]+)'/gm)) toolToFlag.set(m[1], m[2]);

const alwaysStart = mcpSrc.indexOf('const ALWAYS_REGISTER = new Set([');
const alwaysEnd = mcpSrc.indexOf(']);', alwaysStart);
assert.ok(alwaysStart > 0 && alwaysEnd > alwaysStart,
  'ALWAYS_REGISTER 没解析到 —— 结构变了，本测试要跟着改');
const alwaysRegister = new Set();
for (const m of mcpSrc.slice(alwaysStart, alwaysEnd).matchAll(/'(qq_[a-z_0-9]+)'/g)) alwaysRegister.add(m[1]);

const SNOWLUMA_PREFIX = 'mcp__snowluma__';
const qqTools = all.filter((n) => n.startsWith(SNOWLUMA_PREFIX))
  .map((n) => n.slice(SNOWLUMA_PREFIX.length));

const uncloseable = qqTools.filter((n) => !toolToFlag.has(n) && !alwaysRegister.has(n));
assert.deepEqual(uncloseable, [],
  '这些 qq_ 工具注册了，但没有任何开关能关掉它（控制台里看不见、也关不了）：\n'
  + uncloseable.join('\n')
  + '\n→ 在 src/mcp-snowluma-safe.js 的 TOOL_CONFIG_FLAGS 里加一行'
  + ' `<工具名>: \'<flag>\'`（flag 必须是 bridge.js 的 socialV2.tools 里真有的键）；'
  + '确实该常驻的才加进 ALWAYS_REGISTER，并写清楚理由。');

const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const deadFlags = [...new Set(toolToFlag.values())].filter((f) => !bridgeSrc.includes(f));
assert.deepEqual(deadFlags, [],
  'TOOL_CONFIG_FLAGS 里这些开关在 src/bridge.js 里一次都没出现 ——'
  + '登记了却没人读，控制台显示"打开了"实际不起作用：\n' + deadFlags.join('\n'));

console.log(`✔ 工具面分类不变式成立：共 ${all.length} 个 MCP 工具，`
  + `${mcpInList.length} 个显式登记为"三类通用"，其余按会话分档拒绝；`
  + `权能矩阵 ${matrix.groups.length} 组共 ${rowsInMatrix.size} 行，MCP 工具全覆盖`);

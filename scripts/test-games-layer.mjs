// 网页游戏接入层的回归（2026-10-22，主人要的「通用游戏接口」）。
//
// 主人原话：「我在 小鲸鱼的游戏 里面放入了第一个游戏，能不能让小鲸鱼直接接入这里去玩
// 游戏」，并明确「以后这里可能也会放其他的游戏，都是网页的，不专门针对某一个」。
//
// 所以这个测试守的**不是**《古玩大亨》能不能玩，而是**协议和边界**：
//   ① 加游戏 = 放一个 adapter.js，不用改任何代码（目录扫描 + 元数据读取）；
//   ② 路径闸门：`..`、绝对路径、盘符、越界名一律拒（这是唯一能把"游戏名"变成
//      任意文件读取的地方）；
//   ③ 适配器协议：observe/actions/act 三个必须有，缺哪个要**明确**报出来；
//   ④ 四个工具只给管理员私聊（和"网页上的手"同一档），且拒绝理由要说"游戏"不说"抓网页"；
//   ⑤ 游戏目录默认能找到（踩过：`src/games/` 往上算错一级，静默变成空列表）。
//
// 全程不碰浏览器、不启动游戏 —— 只验协议与边界。
//
// 跑：node --test scripts/test-games-layer.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  gamesRoot, listGames, findGame, readAdapterMeta, loadAdapter, resolveInsideRoot,
} from '../src/games/index.js';
import { verdictFor, GAME_TOOLS } from '../plugins/qq-agent-presets/qq-tool-restrict.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const OWNER = 'owner-private';
const GROUP = 'group';
const MEMBER = 'member-private';

// 在一个临时目录里造游戏，避免依赖主人真实的游戏目录
function fixtureRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-games-'));
  // 一个 engine 型
  const a = path.join(dir, '1.demo-engine');
  fs.mkdirSync(a, { recursive: true });
  fs.writeFileSync(path.join(a, 'adapter.js'), `// @adapter {"name":"演示·引擎","kind":"engine","about":"测试用"}
return { observe(){}, actions(){}, act(){}, reset(){} };
`);
  // 一个 ui 型
  const b = path.join(dir, '2.demo-ui');
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(b, 'adapter.js'), `// @adapter {"name":"演示·界面","kind":"ui"}
return { observe(){}, actions(){}, act(){} };
`);
  // 一个没有适配器的目录（不该被列出）
  fs.mkdirSync(path.join(dir, '3.no-adapter'), { recursive: true });
  // 一个编号目录里再套一层（要能认出来）
  const c = path.join(dir, '4.nested', 'inner');
  fs.mkdirSync(c, { recursive: true });
  fs.writeFileSync(path.join(c, 'adapter.js'), `// @adapter {"name":"演示·嵌套"}
return { observe(){}, actions(){}, act(){} };
`);
  return dir;
}

console.log('— 1. 加游戏 = 放一个 adapter.js（不用改代码）—');
test('目录扫描：有 adapter.js 的才算游戏，没有的自动忽略', () => {
  const root = fixtureRoot();
  const ids = listGames(root).map((g) => g.id).sort();
  assert.deepEqual(ids, ['1.demo-engine', '2.demo-ui', '4.nested/inner'],
    `应该只列出带 adapter.js 的目录（含嵌套一层），实际：${ids.join(', ')}`);
  assert.ok(!ids.includes('3.no-adapter'), '没有 adapter.js 的目录不能算游戏');
});

test('元数据来自 @adapter 那一行，且**读它不需要执行代码**', () => {
  const root = fixtureRoot();
  const g = findGame('1.demo-engine', root);
  const meta = readAdapterMeta(g);
  assert.equal(meta.name, '演示·引擎');
  assert.equal(meta.kind, 'engine');
  assert.equal(meta.about, '测试用');
  assert.equal(meta.id, '1.demo-engine', 'id 应该等于目录名（嵌套时是 a/b）');
});

test('按名字找：完整 id / 去掉编号 / 只写后半段 / 模糊包含 都能命中', () => {
  const root = fixtureRoot();
  assert.equal(findGame('1.demo-engine', root).id, '1.demo-engine', '完整 id');
  assert.equal(findGame('demo-engine', root).id, '1.demo-engine', '去掉编号前缀');
  assert.equal(findGame('engine', root).id, '1.demo-engine', '模糊包含');
});

test('名字找不到时，把现在有哪些报出来（别让她瞎猜）', () => {
  const root = fixtureRoot();
  assert.throws(() => findGame('根本不存在的游戏', root), /1\.demo-engine/, '拒绝理由里要列出有哪些');
});

console.log('— 2. 路径闸门：这是唯一能把"游戏名"变成任意读文件的地方 —');
test('.. / 绝对路径 / 盘符 / 越界一律拒', () => {
  const root = fixtureRoot();
  for (const bad of ['..', '../..', '../../Windows', 'C:\\Windows', '/etc/passwd', '\\\\server\\share']) {
    assert.throws(() => resolveInsideRoot(root, bad), /越界|绝对路径|不能为空|不在/,
      `"${bad}" 必须被拒 —— 否则游戏名就成了任意文件读取`);
  }
});

test('正常名字能解析，且结果确实在根目录里', () => {
  const root = fixtureRoot();
  const abs = resolveInsideRoot(root, '1.demo-engine');
  assert.ok(abs.startsWith(root), '解析结果必须在根目录下面');
});

console.log('— 3. 适配器协议：三个能力缺一不可，缺了要明确说 —');
test('缺 observe / actions / act 会指名道姓地报错（而不是运行到一半才炸）', () => {
  const root = fixtureRoot();
  const dir = path.join(root, '5.broken');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'adapter.js'), 'return { observe(){} };  // 缺 actions/act');
  assert.throws(() => loadAdapter(findGame('5.broken', root)), /缺能力.*actions|缺能力.*act/,
    '缺能力要在加载期就报，并指出缺哪个');
});

test('完整适配器能加载，且拿到的是三个以上函数', () => {
  const root = fixtureRoot();
  const { adapter, meta } = loadAdapter(findGame('2.demo-ui', root));
  for (const fn of ['observe', 'actions', 'act']) {
    assert.equal(typeof adapter[fn], 'function', `${fn} 应该是函数`);
  }
  assert.equal(meta.kind, 'ui');
});

test('适配器里没有 fs / 网络能力（只给了 GameIO）', () => {
  const src = read('src/games/index.js');
  const i = src.indexOf('export function loadAdapter');
  const block = src.slice(i, i + 1200);
  assert.match(block, /new Function\('GameIO'/, '只注入 GameIO 一个参数');
  assert.doesNotMatch(block, /require\(|from 'node:fs'.*factory/i, '不要给适配器塞 require');
});

console.log('— 4. 四个工具只给管理员私聊 —');
test('GAME_TOOLS 正好四个，名字都在 mcp__games__ 下', () => {
  assert.equal(GAME_TOOLS.size, 4, `应该是四个（list/look/reset/act），实际 ${GAME_TOOLS.size}`);
  for (const name of GAME_TOOLS) assert.match(name, /^mcp__games__/, `${name} 应该挂在 games 包里`);
});

test('管理员私聊放行；群聊/普通成员私聊拒绝，且理由讲"游戏"不讲"抓网页"', () => {
  for (const name of GAME_TOOLS) {
    assert.equal(verdictFor(name, OWNER), undefined, `${name} 在主人私聊里必须能用`);
    for (const kind of [GROUP, MEMBER]) {
      const r = verdictFor(name, kind);
      assert.ok(typeof r === 'string' && r.length > 0, `${name} 在 ${kind} 必须被拒`);
      assert.match(r, /只允许管理员私聊/, '要明说是权限问题');
      assert.match(r, /游戏/, '理由要讲游戏（她拿到讲"抓网页"的理由会以为用错工具，然后反复重试）');
      assert.doesNotMatch(r, /抓任意网页/, '不能套用 web_fetch 的文案');
    }
  }
});

test('游戏工具没被塞进 SAFE_EXACT / SAFE_PREFIXES（那等于放给所有会话）', () => {
  const src = read('plugins/qq-agent-presets/qq-tool-restrict.mjs');
  const exact = src.slice(src.indexOf('const SAFE_EXACT = new Set(['), src.indexOf('])', src.indexOf('const SAFE_EXACT = new Set([')));
  assert.doesNotMatch(exact, /mcp__games__/, '不能进 SAFE_EXACT');
  // 前缀里也不该有 mcp__games__
  const prefixes = src.slice(src.indexOf('const SAFE_PREFIXES = ['), src.indexOf(']', src.indexOf('const SAFE_PREFIXES = [')));
  assert.doesNotMatch(prefixes, /mcp__games__/, '不能靠前缀整包放行');
});

console.log('— 5. 游戏目录默认要能找到（踩过：算错一级会静默变空）—');
test('gamesRoot 指向真实存在的目录，且能找到那个游戏', () => {
  const root = gamesRoot();
  assert.ok(fs.existsSync(root), `默认游戏目录应该存在：${root}`);
  // 主人真实目录里现在有一个游戏；如果他把游戏全删了，这条会失败 —— 那是他要的信号
  const ids = listGames(root).map((g) => g.id);
  assert.ok(ids.some((id) => id.includes('guwan-dafuweng')), `应该能认出《古玩大亨》，实际：${ids.join(', ') || '（空）'}`);
});

test('REPO_ROOT 是从 src/games/ 往上两级（不是一级）', () => {
  const src = read('src/games/index.js');
  assert.match(src, /const REPO_ROOT = path\.resolve\(HERE, '\.\.', '\.\.'\)/,
    '这里曾算错一级，导致默认目录指向 qq-bridge-deploy/小鲸鱼的游戏（不存在）');
});

console.log('— 5.5 引擎会话必须跨调用延续（踩过的坑）—');
test('同一个游戏连着 loadAdapter 两次，拿到的是同一局（否则 reset 开的局下一次就没了）', () => {
  // 事故形态：`game_reset` 开好局 → `game_look` 报
  // "Cannot read properties of null (reading 'players')"，
  // 因为每次调用都新建了一个空 EngineSession。
  const src = read('src/games/index.js');
  assert.match(src, /const ioCache = new Map\(\)/, '要有按游戏缓存的 ioCache');
  assert.match(src, /ioCache\.set\(cacheKey, GameIO\)/, 'node-engine 型要把 GameIO 存进缓存');
  assert.match(src, /const cached = ioCache\.get\(cacheKey\)/, 'loadAdapter 要先查缓存');
  assert.match(src, /adapter: factory\(cached\)/, '命中缓存时要复用同一个 io 重新构造适配器');
});

test('真跑一遍：reset 之后 check 能看到那一局，act 之后状态继续往前走', async () => {
  const { gamesRoot: gr, listGames: lg, findGame: fg, loadAdapter: la } = await import('../src/games/index.js');
  const all = lg(gr());
  const g = all.find((x) => x.id.includes('guwan-dafuweng'));
  if (!g) return; // 主人把游戏删了就不测这条
  const meta = (await import('../src/games/index.js')).readAdapterMeta(fg(g.id, gr()));
  if (meta.kind !== 'node-engine') return; // 只对 Node 引擎型有意义

  const a1 = la(g);
  const reset = await a1.adapter.reset(a1.io, { players: [
    { name: '测试', color: '#fff', isAI: false },
    { name: 'AI', color: '#000', isAI: true, aiLevel: 'normal' },
  ] });
  assert.equal(reset.ok, true, '开局要成功');
  const info1 = reset.after.players[0];
  assert.equal(info1.cash, 10000, '开局现金应该是 10000');

  // 关键：**重新 loadAdapter**（模拟 MCP 的第二次工具调用）
  const a2 = la(g);
  const board = await a2.adapter.observe(a2.io);
  assert.ok(board && Array.isArray(board.players) && board.players.length === 2,
    '第二次调用必须看到同一局 —— 这正是曾经报 null 的地方');

  // 再走一步，确认状态真的在推进
  const acts1 = await a2.adapter.actions(a2.io);
  assert.ok(acts1.actions.length > 0, '应该有可做的动作');
  const r = await a2.adapter.act(a2.io, acts1.actions[0].id);
  assert.equal(r.ok, true, '动作要执行成功');
  assert.ok(r.after, '做完要带回局面');
});

console.log('— 6. 她拿不到 eval（只能传动作 id）—');
test('MCP 工具的参数里没有「脚本/表达式」这类入口', () => {
  const src = read('src/mcp-games.js');
  const tools = [...src.matchAll(/^server\.tool\(\s*\n?\s*'([a-zA-Z0-9_]+)'/gm)].map((m) => m[1]).sort();
  assert.deepEqual(tools, ['game_act', 'game_list', 'game_look', 'game_reset'], `工具集合要正好是这四个，实际：${tools.join(', ')}`);
  // 参数 schema 里不该出现 expr/script/source/eval
  for (const bad of [/expr:/, /script:/, /source:/, /eval:/]) {
    assert.doesNotMatch(src, bad, `参数里不该有 ${bad} —— 她能传的只有游戏名 + 动作 id`);
  }
});

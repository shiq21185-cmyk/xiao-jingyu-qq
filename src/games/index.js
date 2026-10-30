// ============================================================================
// 网页游戏「接入层」—— 让小鲸鱼能**看懂并操作**放在本机的网页游戏。
// ============================================================================
//
// 主人 2026-10-22：「我在 小鲸鱼的游戏 里面放入了第一个游戏，能不能让小鲸鱼直接
// 接入这里去玩游戏」，并且明确要的是**接口**：
//   「因为以后这里可能也会放其他的游戏，都是网页的，不专门针对某一个」。
//
// ── 所以这一层的设计目标是「N 个游戏共用一个协议」，不是给《古玩大亨》写死一套 ──
//
// 分三层，每层只关心一件事：
//
//   ① **协议层**（本文件）：游戏目录 → 一个 GameAdapter。适配器只要实现五个能力
//       `observe() / actions() / act() / reset() / status()`，上层（MCP 工具、桥接、
//       以后可能的控制台）就都能用。**加新游戏 = 在 games/ 下放一个 adapter.js**，
//       不必改这一层的任何代码。
//
//   ② **适配器层**（`games/<名字>/adapter.js`）：每个游戏自己知道"状态长什么样、
//      有哪些合法动作、怎么执行一个动作"。两种写法都支持：
//        · `engine` 型 —— 游戏把纯逻辑引擎暴露在页面里（像《古玩大亨》的 Engine.choose）
//          适配器直接调引擎，**不需要点页面、不抢窗口、一步几毫秒**；
//        · `ui` 型 —— 只能通过点按钮推进（没有引擎接口）。
//          适配器把"动作"映射成选择器，交给现有的网页手去点（会走静默优先那条路）。
//
//   ③ **执行层**：借用已经在跑的 CDP 代理（`src/cdp-browser.js`），
//      在游戏页面里 `eval` 一小段由**适配器自己**提供的脚本。
//      ⚠️ 这不是"给她任意 JS"：脚本只来自本仓库的适配器文件，
//         她能传的只有 `actionId` 和参数 —— 拿不到 eval 通道。
//
// ── 安全边界（和"网页上的手"同一档）────────────────────────────────────────
//   · 游戏目录被**限定**在 `GAMES_ROOT` 下面（默认 `../小鲸鱼的游戏`），
//     并且必须真的有 `adapter.js` 才算一个游戏 —— 不能拿它去读任意路径。
//   · 只有**主人私聊**能用（守卫那边的 `GAME_TOOLS`，见 qq-tool-restrict.mjs）。
//   · 适配器脚本在本进程里通过 `new Function` 编译后丢给页面执行，
//     参数用 JSON 序列化传入，不做字符串拼接（避免她构造注入）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngineIO } from './node-runtime.js';
import { createBrowserIO } from './browser-runtime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ⚠️ 本文件在 src/games/ 下 ⇒ 仓库根是**上两级**（不是上一级）。
// 2026-10-22 踩过：写成 '..' 会算成 src/，于是默认游戏目录被解析到
// `qq-bridge-deploy\小鲸鱼的游戏`（不存在），listGames() 静默返回空数组 ——
// 表现为"游戏明明在那儿，她看不到"。这类错误不会报错，只会悄悄少一堆东西。
const REPO_ROOT = path.resolve(HERE, '..', '..');

/**
 * 游戏根目录。默认放**仓库旁边的** `小鲸鱼的游戏/`；可用环境变量覆盖
 * （`QQBRIDGE_GAMES_DIR`），也接受 config.json 的 `games.dir`。
 *
 * 为什么要可配：主人以后可能把这个目录搬到别处（比如 D 盘），
 * 或者干脆让朋友送一包游戏过来。写死路径会在搬家时静默失效。
 *
 * 为什么默认是"上一级"：仓库本身是 `Desktop\QQ bot\qq-bridge-deploy\`，
 * 而游戏放在 `Desktop\QQ bot\小鲸鱼的游戏\` —— 它们是兄弟目录。
 * 但这两种布局（在仓库里 / 在仓库旁边）都要能工作，所以都试一遍。
 */
export function gamesRoot(env = process.env, cfg = null) {
  const fromEnv = String(env.QQBRIDGE_GAMES_DIR ?? '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  const fromCfg = String(cfg?.games?.dir ?? '').trim();
  if (fromCfg) return path.resolve(REPO_ROOT, fromCfg);
  const candidates = [
    path.resolve(REPO_ROOT, '..', '小鲸鱼的游戏'),  // 仓库的兄弟目录（当前布局）
    path.resolve(REPO_ROOT, '小鲸鱼的游戏'),        // 仓库内部
    path.resolve(REPO_ROOT, '..', 'games'),
  ];
  for (const dir of candidates) {
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* 继续找 */ }
  }
  return candidates[0];
}

/**
 * 把一个目录名/相对路径解析成**根目录内的**绝对路径。
 *
 * 🔴 这是这一层唯一的路径闸门：任何 `..`、绝对路径、盘符、符号链接逃逸都要挡住，
 *    否则"游戏名"就成了任意文件读取的入口（她能从群里被指使去读 C:\path\to\secret）。
 *    失败方向必须是"拒绝"，不是"尽量试试"。
 */
export function resolveInsideRoot(root, name) {
  const raw = String(name ?? '').trim();
  if (!raw) throw new Error('游戏名不能为空');
  if (/^[a-zA-Z]:|^\\\\|^\//.test(raw)) throw new Error(`游戏名不能是绝对路径：${raw}`);
  const abs = path.resolve(root, raw);
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`游戏名越界了（不在 ${root} 里面）：${raw}`);
  }
  return abs;
}

/**
 * 列出现在能玩哪些游戏。
 *
 * 判据：某个子目录里（或它下面两层内）存在 `adapter.js`。
 * 之所以允许两层，是因为主人的目录结构已经带了一层编号前缀
 * （`1.guwan-dafuweng/`），以后大概还会 `2.xxx/`、`3.xxx/`。
 */
export function listGames(root = gamesRoot()) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const dir of entries) {
    if (!dir.isDirectory()) continue;
    if (dir.name.startsWith('.') || dir.name === 'node_modules') continue;
    const base = path.join(root, dir.name);
    const direct = path.join(base, 'adapter.js');
    if (fs.existsSync(direct)) {
      out.push({ id: dir.name, dir: base, adapter: direct });
      continue;
    }
    // 再看一层（兼容 1.xxx/2.xxx 这种编号目录里再套一层的情况）
    let inner = [];
    try { inner = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const sub of inner) {
      if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
      const cand = path.join(base, sub.name, 'adapter.js');
      if (fs.existsSync(cand)) out.push({ id: `${dir.name}/${sub.name}`, dir: path.join(base, sub.name), adapter: cand });
    }
  }
  return out;
}

/** 找一个游戏；找不到就把现在有哪些报出来（别让她瞎猜名字）。 */
export function findGame(name, root = gamesRoot()) {
  const games = listGames(root);
  const wanted = String(name ?? '').trim();
  if (!wanted) {
    if (games.length === 1) return games[0];
    throw new Error(games.length
      ? `要指定玩哪个游戏。现在有：${games.map((g) => g.id).join('、')}`
      : `游戏目录里还没有任何游戏（${root}）。接入一个游戏 = 在那个目录里放一个 adapter.js。`);
  }
  const hit = games.find((g) => g.id === wanted)
    // 容错：允许只写后半段（"guwan-dafuweng" 对 "1.guwan-dafuweng"）
    || games.find((g) => g.id.endsWith(`/${wanted}`) || g.id.replace(/^\d+\./, '') === wanted)
    || games.find((g) => g.id.includes(wanted));
  if (!hit) {
    throw new Error(`没有这个游戏：${wanted}。现在有：${games.map((g) => g.id).join('、') || '（一个都没有）'}`);
  }
  // 路径闸门：命中之后再用根目录校验一次（防止 id 被构造出 ../）
  resolveInsideRoot(root, hit.id);
  return hit;
}

/**
 * 读一个游戏的适配器清单（纯数据，不执行）。
 *
 * 适配器文件里除了代码，还要有一行 `// @adapter meta` 的 JSON ——
 * 这样"列游戏"不必执行任何代码就能显示名字/说明/类型，安全也快。
 * 没写 meta 也能用，只是显示得朴素些。
 */
export function readAdapterMeta(game) {
  let text = '';
  try { text = fs.readFileSync(game.adapter, 'utf8'); } catch { return { id: game.id, name: game.id }; }
  // @adapter 那行 JSON **允许跨行**（真实适配器的 meta 常常一段话写不完，
  // 分几行更好读）。所以匹配从 `@adapter` 开始，一直吃到"括号配平"为止 ——
  // 而不是"吃到行尾"。2026-10-22 踩过：按行尾匹配导致 kind 读成 unknown，
  // 于是 node-engine 的运行时没被挂上，表现为 adapter.reset 里 io.host undefined。
  const start = text.indexOf('@adapter');
  let m = null;
  if (start >= 0) {
    const braceAt = text.indexOf('{', start);
    if (braceAt >= 0) {
      let depth = 0;
      let end = -1;
      for (let i = braceAt; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') {
          depth -= 1;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end > braceAt) {
        // ★必须把行注释剥掉★：真实适配器的 @adapter 常常写成多行，每行前面带 `//`，
        // 于是括号配平能过、JSON.parse 却炸（2026-10-22 踩过：kind 读成 unknown，
        // 导致 node-engine 运行时没挂上，表现为 adapter.reset 里 io.host undefined）。
        const raw = text.slice(braceAt, end + 1)
          .split('\n')
          .map((line) => line.replace(/^\s*\/\/\s?/, '').replace(/\s*\/\/\s*$/, ''))
          .join('\n');
        m = [raw];
      }
    }
  }
  let meta = {};
  // m 是 [rawJson]（不是正则的 match 数组），所以取 m[0]。
  if (m) { try { meta = JSON.parse(m[0]); } catch { meta = {}; } }
  return {
    id: game.id,
    name: String(meta.name ?? game.id),
    kind: String(meta.kind ?? 'unknown'),      // 'engine' | 'ui'
    mode: String(meta.mode ?? 'browser'),       // 'browser'（借 CDP）| 'server'（后话）
    entry: String(meta.entry ?? 'index.html'),  // 相对 game.dir 的入口页
    about: String(meta.about ?? ''),
    ...meta,
  };
}

/**
 * 把适配器文件变成可用的对象。
 *
 * 为什么用 `new Function` 而不是 `import`：适配器是**本仓库的代码**（跟着游戏目录走），
 * 而游戏目录可能在仓库外面（甚至另一块盘）。用 import 要处理 file:// URL、缓存、
 * 每次热更新还得打 cache-busting。这里只需要拿到一个函数，`new Function` 更直接。
 *
 * ⚠️ 但它拿到的**只有**全局 `globalThis` 和两个注入物（`GameIO`），没有 fs、没有 net：
 *    适配器是被信任的本地代码，但它没必要有文件系统能力。
 */
// ★会话缓存（2026-10-22 重要）★
// 引擎型游戏的 state 存在内存里，而 MCP 工具是**每次调用都重新 loadAdapter** ——
// 如果不缓存，`game_reset` 开的局在 `game_look` 时就不见了（表现为
// "Cannot read properties of null (reading 'players')"，实测踩过）。
// 所以按游戏目录缓存 GameIO：同一个游戏多次调用共用同一局。
const ioCache = new Map();

export function loadAdapter(game) {
  const text = fs.readFileSync(game.adapter, 'utf8');
  const meta = readAdapterMeta(game);
  // 适配器文件是**一段函数体**，必须以 `return { ... }` 结尾（模板见 src/games/README.md）。
  // 这样它既不用 export、也不依赖模块系统 —— 游戏目录可以在仓库外面、甚至在别的盘。
  const factory = new Function('GameIO', `"use strict";\n${text}`);
  // GameIO：适配器能看到的全部东西。
  //   · kind=node-engine 时额外带 host / describe / syncToPage（见 node-runtime.js），
  //     这样适配器不用自己载入引擎、也不用管页面同步；
  //   · kind=engine/ui（浏览器型）时只带基础字段，页面交互由 io.js 提供。
  // 同一局要跨调用延续：先看缓存里有没有这个游戏的 io。
  // 只有 node-engine 型需要缓存（它把 state 放在内存里）；
  // 浏览器型每次重建没关系（state 在页面里）。
  const cacheKey = `${game.dir}::${meta.kind}`;
  const cached = ioCache.get(cacheKey);
  // ★两种执行方式都要缓存★：
  //   · node-engine  —— state 在内存里；
  //   · browser-play —— tab 在内存里（记住打开的是哪个标签页，跨调用复用）。
  // 不缓存的话每次调用都会重新开局，她永远走不到第二步。
  if (cached) {
    return { meta, adapter: factory(cached), io: cached };
  }
  const GameIO = {
    gameDir: game.dir,
    entry: meta.entry,
    meta,
    // Node 引擎型：把运行时挂上（循环依赖用动态 require 避免 —— 这里直接构造）
    ...(meta.kind === 'node-engine' ? createEngineIO(game, meta) : {}),
    ...(meta.kind === 'browser-play' ? { play: createBrowserIO(game, meta), tab: null, board: null } : {}),
  };
  if (meta.kind === 'node-engine' || meta.kind === 'browser-play') ioCache.set(cacheKey, GameIO);
  const adapter = factory(GameIO);
  for (const fn of ['observe', 'actions', 'act']) {
    if (typeof adapter?.[fn] !== 'function') {
      throw new Error(`适配器 ${game.id} 缺能力：${fn}()（协议要求 observe/actions/act）`);
    }
  }
  return { meta, adapter, io: GameIO };
}

/**
 * 统一的"玩一局"入口 —— MCP 工具只需要跟这一个函数打交道。
 *
 * 它把"读状态 / 列可选动作 / 执行一个动作"这三件事说成同一套话，
 * 上层不用知道底下是引擎型还是点按钮型。适配器负责一切与游戏有关的细节。
 */
export async function withGame(name, io, fn) {
  const root = gamesRoot();
  const game = findGame(name, root);
  const { meta, adapter } = loadAdapter(game);
  return await fn({ game, meta, adapter, io });
}

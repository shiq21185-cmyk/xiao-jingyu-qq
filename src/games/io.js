// 「游戏 IO」—— 适配器与网页之间的那一层。
//
// 适配器只跟这个对象打交道（见 src/games/index.js 的 GameIO）：
//   io.evalInPage(expr)  → 在游戏页面里跑一段表达式，拿回它的返回值
//   io.openGame(game)    → 打开游戏入口页（如果还没开）
//   io.installHook(game) → 把 game_io_hook.js 注入页面（让 state 够得着）
//
// 为什么要有 installHook：游戏（`1.guwan-dafuweng`）的 `ui.js` 把 state 关在闭包里，
// 外面拿不到。两条路：改它的 index.html（侵入），或者用 CDP 注入（不侵入）。
// 这里选**不侵入**：`Page.addScriptToEvaluateOnNewDocument` 让钩子在页面每次加载时
// 先于其它脚本 실행，然后重新加载一次就生效 —— 游戏文件一个字节都不动。
// （主人以后可能直接换掉某个游戏目录里的文件，我们不该依赖"文件被改过"。）
import fs from 'node:fs';
import path from 'node:path';
import { openPage, closePage, evalValue, listTabs } from '../cdp-browser.js';

/**
 * 在页面里跑一段表达式。
 *
 * ⚠️ 这是**唯一**能把代码送进页面的口子，所以它不对外暴露：
 *    只有适配器（本仓库的代码）通过 GameIO 拿到它；MCP 工具只传 actionId。
 *    她拿不到 eval —— 这一点和"网页上的手"那一档是同一个设计。
 */
export async function evalInPage(targetId, expr, timeoutMs = 20000) {
  if (!targetId) throw new Error('没有打开的游戏页');
  return await evalValue(targetId, expr, timeoutMs);
}

/**
 * 把钩子脚本注入到"这个页面每次加载时都会先跑"的位置。
 *
 * 为什么要重载一次：`addScriptToEvaluateOnNewDocument` 只影响**之后**的加载。
 * 已经打开着的页面里没有钩子，所以注入完要 reload 一次。
 *
 * 返回值里带 `installed:true` 表示注入命令被接受了（不等于页面已经加载完）。
 */
export async function installHook(game, targetId) {
  const hookPath = path.join(game.dir, 'game_io_hook.js');
  const source = fs.readFileSync(hookPath, 'utf8');
  const proxy = process.env.QQBRIDGE_PROXY_URL || 'http://127.0.0.1:3456';
  // 走代理的 /eval：先用 CDP 的 addScriptToEvaluateOnNewDocument 装脚本，再重载。
  const payload = JSON.stringify({ source });
  const res = await fetch(`${proxy}/inject?target=${encodeURIComponent(targetId)}`, {
    method: 'POST',
    body: payload,
    signal: AbortSignal.timeout(15000),
  }).catch((e) => { throw new Error(`注入钩子失败（连不上代理）：${e?.message ?? e}`); });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok || data?.error) throw new Error(data?.error || `注入钩子返回 ${res.status}：${text.slice(0, 160)}`);
  return data;
}

/** 看看这个游戏现在是不是已经开着（标题/URL 里带它的目录名）。 */
export async function findOpenGameTab(game) {
  const tabs = await listTabs().catch(() => []);
  const key = path.basename(game.dir).toLowerCase();
  return (tabs || []).find((t) => String(t.url || '').toLowerCase().includes(key))
    || (tabs || []).find((t) => String(t.title || '').includes('大富翁'))
    || null;
}

/**
 * 打开游戏入口页（如果没开就开）。
 *
 * 注意：`openPage` 走 `validateFetchUrl`，只允许 http/https —— 所以**不能用 file://**
 * 直接开。两个选择：
 *   ① 让代理直接 `/new` 一个 file:// URL（代理自己有这个能力，且是主人的本机文件）；
 *   ② 用游戏自带的 `server.js`（`node server.js 7777`）起一个 http 服务。
 * 这里用 ①：不额外起进程，也不要求主人记得开服务器。
 */
export async function openGamePage(game, targetId = '') {
  if (targetId) return { targetId, opened: false };
  const existing = await findOpenGameTab(game);
  if (existing) return { targetId: existing.targetId, opened: false, title: existing.title };
  const entry = path.join(game.dir, game.meta?.entry || 'index.html');
  const fileUrl = 'file:///' + entry.replace(/\\/g, '/');
  const proxy = process.env.QQBRIDGE_PROXY_URL || 'http://127.0.0.1:3456';
  const res = await fetch(`${proxy}/new`, {
    method: 'POST',
    body: fileUrl,
    signal: AbortSignal.timeout(45000),
  }).catch((e) => { throw new Error(`打不开游戏页（连不上代理）：${e?.message ?? e}`); });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok || !data?.targetId) throw new Error(data?.error || `打开游戏页失败：${text.slice(0, 160)}`);
  return { targetId: data.targetId, opened: true, url: fileUrl };
}

export { closePage };

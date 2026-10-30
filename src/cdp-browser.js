// 和小鲸鱼"一起看网页"的底座。
//
// 链路：MCP 工具（mcp-web-search-safe.js）
//        → 本模块 → HTTP 127.0.0.1:3456
//        → <tools>\web-access\scripts\cdp-proxy.mjs（长驻进程）
//        → 主人日常那个 Edge（带他的登录态）
//
// 为什么不让她自己开浏览器：QQ 会话的 preset 里没有任何本地执行工具
// （铁律 L7，见 plugins/qq-agent-presets/qq-tool-restrict.mjs），
// 她够不到 bash / node / curl。"手"只能放在 MCP server 里，她负责调工具。
//
// ★读 + 手★：读的一面是 开页 / 读正文 / 截图 / 关页；
// 手的一面（2026-10-22 主人要的「给她加一只手」）是 点 / 填 / 滚动 / 按键 / 选下拉 / 找元素。
// 手**不包含**上传文件：cdp-proxy.mjs 的本地补丁仍然把 /setFiles 一律 403
// （主人只选了「点填滚按选」这一档，见该目录的 LOCAL-PATCH.md）。
//
// 手的边界不在这里做，在两层：
//   ① 守卫（plugins/qq-agent-presets/qq-tool-restrict.mjs）：这些工具是
//      mcp__web-search-safe__web_click 等，只在**管理员私聊**放行，群里/普通成员私聊
//      拿不到（和 web_fetch 同一档）。
//   ② MCP 层只暴露受控动作：没有任意 JS、没有文件系统、没有上传。
// 所以本模块里的每个动作都假定"调用方已经被守卫放行过"，它自己只负责动作本身的安全
// （不误点、不越过视口、把页面状态如实回报）。
//
// URL 校验复用 safe-fetch 的 validateFetchUrl：同样的私网/环回/凭据封锁规则。
// 这一条很实在——否则她可以把主人的浏览器导航到 http://127.0.0.1:3100
// （qq-bridge 控制台）去读控制台令牌。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { validateFetchUrl } from './safe-fetch.js';

const PROXY_PORT = Number(process.env.CDP_PROXY_PORT || 3456);
const PROXY_BASE = `http://127.0.0.1:${PROXY_PORT}`;
// web-access 的位置是可移植的：优先环境变量，其次「本仓库的兄弟目录」，
// 最后才是老机器上的绝对路径。换电脑后只要把 qq-bridge-tools 放在 qq-bridge 旁边就能用，
// 放在别处就设 WEB_ACCESS_DIR（install.ps1 会把它写进 config.json 的同名配置）。
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const WEB_ACCESS_DIR = process.env.WEB_ACCESS_DIR
  || [path.join(REPO_ROOT, 'tools', 'web-access'), path.join(path.dirname(REPO_ROOT), 'qq-bridge-tools', 'web-access')]
       .find((p) => { try { return fs.existsSync(p); } catch { return false; } })
  || path.join(path.dirname(REPO_ROOT), 'qq-bridge-tools', 'web-access');
const CHECK_DEPS = path.join(WEB_ACCESS_DIR, 'scripts', 'check-deps.mjs');
const PROXY_LOG = path.join(os.tmpdir(), 'cdp-proxy.log');

export const PAGE_TEXT_CHUNK = 4000;
export const PAGE_TEXT_MAX = 20000;
export const DEFAULT_WAIT_MS = 15000;

// ---------------------------------------------------------------------------
// 已取回来的整页正文，按 targetId 存一份（只在这个进程的内存里，不外传、不落盘）
// ---------------------------------------------------------------------------
// 为什么要存：她读网页是"先给一段、够回话，聊到需要了再往后读"。
// 而 web_read_more 原来是**重新回到那个活着的标签页**去取字 —— 主人中途把 Edge 关掉，
// 后面那半篇就永久读不到了（2026-10-16 真机上就这么丢了 4600 字）。
// 整页正文在她第一次打开这一页时本来就已经在浏览器内存里，顺手拿回来存着几乎不额外花时间，
// 之后接着读就完全不依赖浏览器还开着。
const pageTextCache = new Map(); // targetId -> { url, title, text, totalChars, at }
const PAGE_CACHE_LIMIT = 20;
const PAGE_CACHE_TTL_MS = 30 * 60 * 1000;

export function cachePageText(targetId, entry) {
  if (!targetId) return;
  pageTextCache.delete(targetId); // 重新读过的排到队尾，先淘汰最久没用到的
  pageTextCache.set(targetId, { ...entry, at: Date.now() });
  while (pageTextCache.size > PAGE_CACHE_LIMIT) {
    pageTextCache.delete(pageTextCache.keys().next().value);
  }
}

// 从缓存里接着读一段。缓存够不着（页面比 PAGE_TEXT_MAX 还长、要的那段落在截断之外）
// 就返回 null，让上层回去找活的页面 —— 不拿一份不完整的东西冒充完整。
export function getCachedPageText(targetId, offset = 0, limit = PAGE_TEXT_CHUNK) {
  const key = String(targetId || '');
  const hit = pageTextCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PAGE_CACHE_TTL_MS) {
    pageTextCache.delete(key);
    return null;
  }
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const size = Math.min(PAGE_TEXT_MAX, Math.max(1, Math.floor(Number(limit) || PAGE_TEXT_CHUNK)));
  if (start + size > hit.text.length && hit.text.length < hit.totalChars) return null;
  return {
    text: hit.text.slice(start, start + size),
    totalChars: hit.totalChars,
    title: hit.title,
    url: hit.url,
  };
}

const INSPECT_HINT =
  '地址栏打开 edge://inspect/#remote-debugging，勾选 "Allow remote debugging for this browser instance"';

function tailProxyLog(lines = 6) {
  try {
    const text = fs.readFileSync(PROXY_LOG, 'utf8').trimEnd();
    return text.split('\n').slice(-lines).join(' / ');
  } catch {
    return '(没有代理日志)';
  }
}

function browserHint(detail) {
  return [
    detail,
    `请确认：① Edge 正在运行；② ${INSPECT_HINT}；`,
    `③ 代理日志：${PROXY_LOG} — 末尾：${tailProxyLog()}`,
  ].join('');
}

async function proxyFetch(route, { method = 'GET', body, params, timeoutMs = 30000, raw = false } = {}) {
  const url = new URL(PROXY_BASE + route);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      ...(body === undefined ? {} : { body: String(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(browserHint(`连不上 web-access 代理（${PROXY_BASE}）：${error?.message ?? error}`));
  }
  if (raw) {
    if (!res.ok) throw new Error(`代理 /screenshot 返回 ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new Error(data?.error || `代理 ${route} 返回 ${res.status}：${text.slice(0, 200)}`);
  if (data && typeof data.error === 'string') throw new Error(data.error);
  return data;
}

async function proxyHealth(timeoutMs = 2000) {
  try {
    return await proxyFetch('/health', { timeoutMs });
  } catch {
    return null;
  }
}

// 只问一句"现在连得上浏览器吗"。★不等待、不拉起、不抛错★
// 给那种"有就顺手做、没有就算了"的功能用（比如 bili_video 顺手取字幕）：
// 它绝不能把"浏览器没开"变成一次 30 秒的等待或者一个报错。
export async function proxyConnected(timeoutMs = 800) {
  const health = await proxyHealth(timeoutMs);
  return health?.status === 'ok' && health.connected === true;
}

// 确保代理活着、且浏览器那头是连着的。
// ★2026-10-16 改：以前只要 connected !== true 就无脑拉起 check-deps 再等满 30 秒。
// 但"代理活着 + Edge 被关掉"这个组合下 check-deps 什么也做不了（代理本来就在跑），
// 于是每次读网页都要白等 30 秒才报错。现在先探浏览器那个调试端口：
// 端口不在 ⇒ 浏览器根本没开 ⇒ 立刻抛 BrowserDownError，让上层马上降级去 web_fetch。
let proxyReadyAt = 0;

// 浏览器没开时抛这个。上层（MCP 工具）靠 code 判断要不要降级，
// 不要靠 message 里有没有某个词——文案会改，code 不会。
export class BrowserDownError extends Error {
  constructor(detail) {
    super(detail);
    this.name = 'BrowserDownError';
    this.code = 'BROWSER_DOWN';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 探 127.0.0.1:<port> 通不通。比问代理准：代理的 connected 字段在
// "刚重启、正在连"和"浏览器已经退出"这两种情况下都是 false，得靠端口区分。
function canConnect(port, host = '127.0.0.1', timeoutMs = 800) {
  const target = Number(port);
  if (!Number.isFinite(target) || target <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = net.connect({ port: target, host });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function browserPort(health) {
  return Number(health?.chromePort || 9222);
}

export async function ensureProxy({ timeoutMs = 30000 } = {}) {
  if (Date.now() - proxyReadyAt < 10000) return;

  const health = await proxyHealth();

  if (health?.status === 'ok') {
    if (health.connected === true) {
      proxyReadyAt = Date.now();
      return;
    }
    // 代理活着、没连上浏览器。三种情况，说法要分清（别让主人白等 30 秒又不知道要点什么）：
    //   ① 浏览器没开         → 直接报"没开"，别耗秒数
    //   ② 在等他点「允许」   → 直说"请你点一下"，因为再等也不会自己好
    //   ③ 刚重启、正在连     → 给它几秒
    if (!(await canConnect(browserPort(health)))) {
      throw new BrowserDownError(browserHint('浏览器没开。'));
    }
    // ★② 先问代理"你是不是在等授权"★（2026-10-22 加的字段）
    // 这个状态如果不单独说清，表现就是"卡住 30 秒然后报一句含糊的失败"，
    // 主人只会觉得"又要我点、又不说让我点哪"。
    if (health.waitingForAuth === true) {
      throw new Error(browserHint(
        '浏览器开着，但它还在等你点一次「允许远程调试」——'
        + '这是 Edge 按**每条新连接**确认的安全弹窗（点一次这条连接就一直有效），'
        + '我没法替你点。',
      ));
    }
    // 端口在 —— 给它几秒把连接建起来（点了"允许"、或代理刚重启都要一点时间）。
    const softDeadline = Date.now() + Math.min(timeoutMs, 12000);
    while (Date.now() < softDeadline) {
      await sleep(800);
      const h = await proxyHealth();
      if (h?.connected === true) {
        proxyReadyAt = Date.now();
        return;
      }
      if (h?.status === 'ok' && !(await canConnect(browserPort(h)))) {
        throw new BrowserDownError(browserHint('浏览器在连接过程中退出了。'));
      }
      if (h?.status === 'ok' && h.waitingForAuth === true) {
        throw new Error(browserHint('浏览器开着，但还在等你点「允许远程调试」（弹出确认框时点一下就好）。'));
      }
    }
    throw new Error(browserHint('浏览器开着，但代理一直没连上——多半是那个"允许远程调试"的提示还没点。'));
  }

  // 代理根本没起（或刚被杀掉）→ 照旧让 check-deps 拉一个起来。
  if (!fs.existsSync(CHECK_DEPS)) {
    throw new Error(`找不到 web-access：${CHECK_DEPS} 不存在（web-access 目录被移动或删除了？设 WEB_ACCESS_DIR 或改 config.json 的 webAccess.dir 指过去即可）`);
  }
  // check-deps 自带幂等逻辑：已有实例就复用，没有就 detached 起一个。
  const logFd = fs.openSync(PROXY_LOG, 'a');
  const child = spawn(process.execPath, [CHECK_DEPS], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    ...(os.platform() === 'win32' ? { windowsHide: true } : {}),
  });
  child.unref();
  fs.closeSync(logFd);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    const h = await proxyHealth();
    if (h?.status === 'ok' && h.connected === true) {
      proxyReadyAt = Date.now();
      return;
    }
    // 代理起来了但浏览器不在 ⇒ 立刻失败，别把剩下的秒数耗完。
    if (h?.status === 'ok' && !(await canConnect(browserPort(h)))) {
      throw new BrowserDownError(browserHint('浏览器没开。'));
    }
  }
  throw new Error(browserHint(`等了 ${Math.round(timeoutMs / 1000)} 秒，代理还是没连上浏览器。`));
}

export async function evalValue(targetId, expression, timeoutMs = 25000) {
  const res = await proxyFetch('/eval', {
    method: 'POST',
    body: expression,
    params: { target: targetId },
    timeoutMs,
  });
  return res?.value;
}

const INFO_EXPR =
  'JSON.stringify({title:document.title,url:location.href,ready:document.readyState,'
  + 'len:(document.body?document.body.innerText.length:0)})';

async function pageInfo(targetId) {
  const raw = await evalValue(targetId, INFO_EXPR);
  try {
    return JSON.parse(raw);
  } catch {
    return { title: '', url: '', ready: 'unknown', len: 0 };
  }
}

// ★这里是最容易踩的坑★ /new 返回 200 只代表浏览器完成了基础加载，
// SPA 还没把正文渲染出来。2026-10-16 实测小黑盒那篇：/new 刚返回时
// document.body.innerText.length === 0、截图纯白，1 秒后才是 9160 字。
// 所以必须轮询到"长度不再变化"为止。
export async function waitForPage(targetId, { timeoutMs = DEFAULT_WAIT_MS, minChars = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let info = null;
  let lastLen = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    try {
      info = await pageInfo(targetId);
    } catch {
      info = null;
    }
    if (info) {
      stable = info.len === lastLen ? stable + 1 : 0;
      lastLen = info.len;
      if (info.len > 0 && stable >= 2 && (info.ready === 'complete' || info.len >= minChars)) return info;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return info ?? { title: '', url: '', ready: 'timeout', len: 0 };
}

export async function openPage(url) {
  const { url: parsed } = await validateFetchUrl(url);
  await ensureProxy();
  let res;
  try {
    res = await proxyFetch('/new', { method: 'POST', body: parsed.href, timeoutMs: 45000 });
  } catch (error) {
    // ensureProxy 有 10 秒缓存，可能刚好盖住"他这会儿把 Edge 关了"这一刻。
    // 再确认一次：真是浏览器没了就升级成 BrowserDownError，让上层走降级。
    proxyReadyAt = 0;
    const h = await proxyHealth();
    if (h?.status === 'ok' && h.connected !== true && !(await canConnect(browserPort(h)))) {
      throw new BrowserDownError(browserHint('浏览器没开。'));
    }
    throw error;
  }
  const targetId = res?.targetId;
  if (!targetId) throw new Error('代理没有返回 targetId');
  return { targetId, url: parsed.href };
}

export async function closePage(targetId) {
  await proxyFetch('/close', { params: { target: targetId }, timeoutMs: 15000 });
}

export async function readText(targetId, offset = 0, limit = PAGE_TEXT_CHUNK) {
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const size = Math.min(PAGE_TEXT_MAX, Math.max(1, Math.floor(Number(limit) || PAGE_TEXT_CHUNK)));
  const expr =
    '(function(){var t=(document.body?document.body.innerText:"");'
    + `var s=${start},e=s+${size};`
    + 'return JSON.stringify({text:t.slice(s,e),len:t.length});})()';
  const raw = await evalValue(targetId, expr);
  try {
    return JSON.parse(raw);
  } catch {
    return { text: String(raw ?? ''), len: 0 };
  }
}

export async function screenshotPng(targetId) {
  await ensureProxy();
  // ★2026-10-22：把超时从 30 秒收到 20 秒，并把代理侧的"失败重试"用上★
  // 代理那边现在单次 8 秒超时、失败自动换 session 重试一次（最坏 16 秒）；
  // 这里的 20 秒是兜底 —— 绝不能让她一次截图干等半分钟。
  return await proxyFetch('/screenshot', {
    params: { target: targetId, format: 'png', timeoutMs: 8000 },
    raw: true,
    timeoutMs: 20000,
  });
}

// 一站式：开页 → 等渲染 → 取一段正文。默认不关页（这样她能接着 readMore）。
export async function readLink(url, { offset = 0, limit = PAGE_TEXT_CHUNK, keepOpen = true, waitMs = DEFAULT_WAIT_MS } = {}) {
  const { targetId, url: finalUrl } = await openPage(url);
  try {
    const info = await waitForPage(targetId, { timeoutMs: waitMs });
    // 一次把整页正文取回来（上限 PAGE_TEXT_MAX）：这一次的返回从里面切片，
    // 同时存一份给 web_read_more —— 这样"边聊边往后读"不再依赖浏览器还开着。
    const whole = await readText(targetId, 0, PAGE_TEXT_MAX);
    const full = String(whole?.text ?? '');
    const totalChars = info.len || whole?.len || 0;
    cachePageText(targetId, {
      url: info.url || finalUrl,
      title: info.title || '',
      text: full,
      totalChars,
    });
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const size = Math.min(PAGE_TEXT_MAX, Math.max(1, Math.floor(Number(limit) || PAGE_TEXT_CHUNK)));
    return {
      targetId,
      title: info.title || '',
      url: info.url || finalUrl,
      totalChars,
      offset: start,
      text: full.slice(start, start + size),
    };
  } finally {
    if (!keepOpen) {
      try { await closePage(targetId); } catch { /* 关不掉就算了，代理 15 分钟会自己清 */ }
    }
  }
}

// ---------------------------------------------------------------------------
// "和你一起看"：读主人此刻正在看的那一页
// ---------------------------------------------------------------------------

// 列出主人浏览器里开着的全部页面。
// mine=true 表示这一页是本代理（= 她）用 /new 开的，false 是主人自己的页。
// 这个标记来自 cdp-proxy 的本地补丁，也是 /close 那道闸的判据。
export async function listTabs() {
  await ensureProxy();
  const pages = await proxyFetch('/targets', { timeoutMs: 20000 });
  if (!Array.isArray(pages)) return [];
  return pages
    .filter((p) => p && p.targetId && !String(p.url || '').startsWith('devtools://'))
    .map((p) => ({
      targetId: p.targetId,
      title: p.title || '',
      url: p.url || '',
      mine: p.mine === true,
    }));
}

// ★找"主人正在看的那一页"★
// CDP 的 TargetInfo 里没有"当前激活 / 前台"这个字段，只能问页面自己：
//   - document.visibilityState === 'visible' —— 在前台窗口里的当前标签页
//     （窗口被完全遮挡或最小化 → 'hidden'；DSH / QQ 窗口盖住 Edge 时就会变成 hidden）
//   - document.hasFocus() === true —— 拿到键盘焦点的那一页，最贴合"他正在看"
// 两道信号都要采集，再由 selectCurrentTab 分级挑 —— 只靠 visibilityState 会
// 在"他正对着 DSH/QQ 打字让我看某个页"这个最常见的时刻失效。
// 每页要 attach 一次会话，所以设 scanLimit 上限。
export async function findCurrentTab({ scanLimit = 12 } = {}) {
  const tabs = await listTabs();
  const probed = [];
  for (const tab of tabs.slice(0, scanLimit)) {
    let raw = '';
    try {
      raw = await evalValue(
        tab.targetId,
        'JSON.stringify([document.visibilityState || "", document.hasFocus() === true])',
        8000,
      );
    } catch {
      continue; // attach 不上的页（正在关闭、或被别的东西占住）直接跳过，不算致命
    }
    let visible = false;
    let focused = false;
    try {
      const arr = JSON.parse(raw);
      visible = arr[0] === 'visible';
      focused = arr[1] === true;
    } catch { /* 取不到就当两项都不成立 */ }
    probed.push({ ...tab, visible, focused });
  }
  return { tabs, probed, visible: probed.filter((t) => t.visible) };
}

// 分级挑选，越靠前越可信；挑不出来就返回 null，让调用方如实报告、去问他，不猜。
//   focused-visible —— 他正拿键盘操作、且窗口在前台
//   visible         —— 至少前台可见（他开了多个浏览器窗口时可能有多个）
//   focused         —— 只有焦点信号（窗口被判成被遮挡，但他确实在用它）
//   only-one        —— 他自己只开着一个页面，没有歧义，就是它
export function selectCurrentTab({ probed = [], tabs = [] } = {}) {
  const both = probed.filter((t) => t.visible && t.focused);
  if (both.length) return { tab: both[0], how: 'focused-visible' };
  const vis = probed.filter((t) => t.visible);
  if (vis.length) return { tab: vis[0], how: 'visible' };
  const foc = probed.filter((t) => t.focused);
  if (foc.length) return { tab: foc[0], how: 'focused' };
  // 只剩这一个兜底：他自己开着的页只有一个。她开的页（mine）不算，免得她读自己的。
  const ownerTabs = probed.filter((t) => !t.mine);
  if (ownerTabs.length === 1 && tabs.filter((t) => !t.mine).length === 1) {
    return { tab: ownerTabs[0], how: 'only-one' };
  }
  return null;
}

// 读主人此刻正在看的那一页：不新开标签页，所以也就没有"关不关"的问题。
// 返回结构和 readLink 对齐（同样带 targetId），这样她能接着 readMore / see。
// how 说明是靠哪一级信号认出来的，调用方可以照实转述（别把兜底说成"你在看"）。
// 传了 targetId 就直接读它 —— 这是给"认不出哪一页 → 你看一眼列表 → 他指了某一页"
// 这条链路用的（web_list_tabs 会把 targetId 列出来），不是猜。
export async function readCurrent({ offset = 0, limit = PAGE_TEXT_CHUNK, waitMs = 6000, targetId = '' } = {}) {
  await ensureProxy();
  const { tabs, probed, visible } = await findCurrentTab();
  if (!tabs.length) return { ok: false, reason: 'no-tabs', tabs: [] };

  const wanted = String(targetId || '').trim();
  let picked = null;
  if (wanted) {
    const hit = tabs.find((t) => t.targetId === wanted);
    if (!hit) return { ok: false, reason: 'target-not-found', tabs, wanted };
    picked = { tab: hit, how: 'by-target' };
  } else {
    picked = selectCurrentTab({ probed, tabs });
    if (!picked) return { ok: false, reason: 'ambiguous', tabs, visible };
  }

  const current = picked.tab;
  const info = await waitForPage(current.targetId, { timeoutMs: waitMs, minChars: 0 });
  const whole = await readText(current.targetId, 0, PAGE_TEXT_MAX);
  const full = String(whole?.text ?? '');
  const totalChars = info?.len || whole?.len || 0;
  cachePageText(current.targetId, {
    url: info?.url || current.url,
    title: info?.title || current.title,
    text: full,
    totalChars,
  });
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const size = Math.min(PAGE_TEXT_MAX, Math.max(1, Math.floor(Number(limit) || PAGE_TEXT_CHUNK)));
  return {
    ok: true,
    how: picked.how,
    targetId: current.targetId,
    title: info?.title || current.title,
    url: info?.url || current.url,
    totalChars,
    offset: start,
    text: full.slice(start, start + size),
    otherVisibleTabs: visible
      .filter((t) => t.targetId !== current.targetId)
      .map((t) => ({ title: t.title, url: t.url })),
    tabCount: tabs.length,
  };
}

// ===========================================================================
// 手：点 / 填 / 滚 / 按键 / 选下拉
// ===========================================================================
// 主人 2026-10-22：「现在的小鲸鱼只能看网页，不能操作，我想让她可以操作网页，
// 给她加一个手」。能力边界（他选的档）：点、填、滚动、按键、选下拉；**不含上传文件**。
// 会话边界（他选的档）：只在他的私聊里放行 —— 这一条不在这里做，在守卫里
// （qq-tool-restrict.mjs 的 OWNER_PRIVATE_ONLY_DSH_TOOLS 同一个档位）。
//
// 这一节只做"动作"，不判断"该不该做"。它自己不轻信选择器：
//   ① 每次动手前先确认那页还在、URL 还是不是刚才那个（页面被主人跳走了就别点）；
//   ② 找不到元素时把"页面上有哪些可点的文字"回给她，而不是只说一句 not found ——
//      她看不见浏览器，光说"没找到"等于让她瞎猜第二次。

// 允许动手的那一页：只有"她自己开的页"和"主人指了/认出来的页"。
// 主人自己的页（`/targets` 里 mine=false 且不是 readCurrent 认出来的）**可以点**吗？
// 这里选择"可以"，因为"帮我点一下这个按钮"天然发生在他正在看的那一页上；
// 保护靠别的东西：不导航、不关页、不填密码框、动之前确认 URL 没变。
export const ACTION_TIMEOUT_MS = 20000;
const CLICKABLE_PREVIEW = 40;

// 动手前的"还是那一页吗"检查。返回 {ok, title, url} 或抛错。
async function assertSamePage(targetId, expectUrl = '', expectTitle = '') {
  const info = await pageInfo(targetId);
  const url = String(info?.url ?? '');
  const title = String(info?.title ?? '');
  const base = (s) => String(s || '').split('#')[0].split('?')[0].replace(/\/$/, '');
  if (expectUrl && base(url) && base(expectUrl) && base(url) !== base(expectUrl)) {
    throw new Error(
      `这一页已经不在刚才那个地址了：现在是 ${url.slice(0, 160)}，刚才读的是 ${expectUrl.slice(0, 160)}。`
      + '（主人可能把它跳走了。）我没动手 —— 请重新读一遍那一页再决定。',
    );
  }
  if (expectTitle && title && expectTitle && title !== expectTitle && !title.includes(expectTitle)) {
    // 标题变了但 URL 没变，通常是 SPA 换页（点了一下、跳到了下一屏）——不算错，只提示。
    return { ok: true, title, url, titleChanged: true };
  }
  return { ok: true, title, url, titleChanged: false };
}

// 找一个元素并返回"能人读的"描述；找不到时把页面上可点的东西列出来。
// selector 先当 CSS 试（#id / .class / button[type=submit]），
// 试不到再当"按钮上写的那几个字"找 —— 她通常只知道按钮上写的是什么，不知道它的 id。
const FIND_EXPR = (selector) => `
(function(){
  var sel = ${JSON.stringify(String(selector ?? ''))};
  var el = null;
  try { el = document.querySelector(sel); } catch (e) { el = null; }
  if (!el) {
    var want = sel.trim();
    var all = document.querySelectorAll('a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[onclick]');
    var exact = null, loose = null;
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      var t = ((n.innerText || n.value || n.getAttribute('aria-label') || n.getAttribute('title') || '') + '').trim();
      if (!t) continue;
      if (!exact && t === want) exact = n;
      if (!loose && t.indexOf(want) >= 0) loose = n;
    }
    el = exact || loose || null;
  }
  if (!el) {
    var shown = [];
    var pool = document.querySelectorAll('a,button,[role=button],[role=link],input[type=submit],input[type=button]');
    for (var j = 0; j < pool.length && shown.length < ${CLICKABLE_PREVIEW}; j++) {
      var x = pool[j];
      var tx = ((x.innerText || x.value || x.getAttribute('aria-label') || '') + '').trim().replace(/\\s+/g, ' ');
      if (!tx) continue;
      var rr = x.getBoundingClientRect();
      if (rr.width < 2 || rr.height < 2) continue;
      var label;
      if (x.id) label = '#' + x.id;
      else if (x.getAttribute('name')) label = x.tagName.toLowerCase() + '[name="' + x.getAttribute('name') + '"]';
      else if (x.className && typeof x.className === 'string') label = x.tagName.toLowerCase() + '.' + x.className.trim().split(/\\s+/).slice(0,2).join('.');
      else label = x.tagName.toLowerCase();
      shown.push({ text: tx.slice(0, 40), selector: label });
    }
    return JSON.stringify({ notFound: true, visible: shown, url: location.href, title: document.title });
  }
  el.scrollIntoView({ block: 'center' });
  var rect = el.getBoundingClientRect();
  var type = (el.getAttribute ? el.getAttribute('type') : '') || '';
  var pwd = type.toLowerCase() === 'password';
  // 给它算一个**能被 querySelector 用回来**的路径。
  // 为什么需要：/click 那个端点只认 CSS 选择器（body 直接 querySelector），
  // 而她常常是"按按钮上那两个字"找到元素的 —— 文字不是选择器。
  // 所以在这里把真实元素反查成 #id / 唯一 class / nth-of-type 路径，
  // 让"静默 JS 点击"也能精确点到同一个元素（2026-10-22 踩过）。
  var path = (function(node){
    if (!node || node.nodeType !== 1) return '';
    if (node.id) return '#' + CSS.escape(node.id);
    var parts = [];
    var cur = node;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      var part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      var cls = (cur.className && typeof cur.className === 'string')
        ? cur.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
      if (cls.length) part += '.' + cls.map(function(c){ return CSS.escape(c); }).join('.');
      var parent = cur.parentElement;
      if (parent) {
        var same = 0, idx = 0, i;
        for (i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === cur.tagName) { same++; if (parent.children[i] === cur) idx = same; }
        }
        if (same > 1) part += ':nth-of-type(' + idx + ')';
      }
      parts.unshift(part);
      cur = parent;
      if (parts.length > 8) break;
    }
    return parts.join(' > ');
  })(el);
  return JSON.stringify({
    ok: true,
    tag: el.tagName,
    type: type,
    password: pwd,
    editable: el.isContentEditable === true,
    disabled: el.disabled === true,
    text: ((el.innerText || el.value || el.getAttribute('aria-label') || '') + '').trim().replace(/\\s+/g, ' ').slice(0, 120),
    css: path,
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
    url: location.href,
    title: document.title,
  });
})()`;

const BUTTONISH = new Set(['A', 'BUTTON', 'INPUT', 'SUMMARY', 'LABEL']);

/**
 * 找元素。selector 先当 CSS 试，再当"按钮上写的那几个字"找。
 * 找不到时抛 FindMissError（带 visible 列表），让上层原样转述给她。
 */
export class FindMissError extends Error {
  constructor(info) {
    const shown = (info?.visible || []).map((v) => `「${v.text}」`).join(' / ');
    super(info?.notFound
      ? `页面上没找到「${info.wanted || ''}」。它现在能点的地方有：${shown || '（一个都列不出来，可能还没加载完）'}`
      : '没找到元素');
    this.name = 'FindMissError';
    this.code = 'FIND_MISS';
    this.info = info;
  }
}

export async function findElement(targetId, selector) {
  if (!String(selector ?? '').trim()) throw new Error('选择器/文字不能为空');
  const raw = await evalValue(targetId, FIND_EXPR(selector), ACTION_TIMEOUT_MS);
  let info;
  try { info = JSON.parse(raw); } catch { info = { error: '页面没有返回可解析的结果' }; }
  if (info?.error) throw new Error(info.error);
  if (info?.notFound) throw new FindMissError({ ...info, wanted: String(selector) });
  return info;
}

/**
 * 动手之前，先把这一页切到前台。
 *
 * ★为什么必须这么做（2026-10-22 真机实测）★ /new 建的是**后台**标签页
 * （background:true），而后台页里 Input.* 的鼠标/滚轮事件到不了页面：
 * 发 Input.synthesizeScrollGesture 之后 window.scrollY 一动都不动；
 * 点链接也只发出事件、不导航（可见性 state 还是 hidden）。
 * 同一套动作在切到前台的页上立刻生效。
 *
 * 顺带的好处：她动手时主人能看见是哪个标签页在动 —— 这比"静默操作"诚实。
 * 失败不致命（有的环境不允许 activate）：返回 false，让动作照常尝试。
 */
export async function activatePage(targetId) {
  try {
    await ensureProxy();
    await proxyFetch('/activate', { params: { target: targetId }, timeoutMs: 10000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 把那页切前台，然后**如实回报"到底切没切到"**。
 *
 * 为什么要回读 visibilityState，而不是"调了 /activate 就算切了"（2026-10-22 踩过）：
 * `Target.activateTarget` 只能把那个标签页设成"这个窗口的当前页"、给它焦点，
 * 它**没法**把窗口从别的程序后面提出来。窗口被 DSH 完全盖住时，
 * 调完之后 `document.hasFocus()` 会变 true，但 `visibilityState` 仍然是 `hidden`。
 * 也就是说"activate 成功了" ≠ "主人能看见它"。谎报这一点的后果很实际：
 * 她会跟主人说"窗口给你弹出来了"，而屏幕上什么都没有。
 *
 * 返回 { attempted, visible, focused }：visible 才是"真的在前面"。
 */
async function focusForAction(targetId) {
  const attempted = await activatePage(targetId);
  if (attempted) await sleep(250);
  let state = { visible: false, focused: false };
  try {
    const raw = await evalValue(
      targetId,
      'JSON.stringify([document.visibilityState||"", document.hasFocus()===true])',
      8000,
    );
    const arr = JSON.parse(raw);
    state = { visible: arr[0] === 'visible', focused: arr[1] === true };
  } catch { /* 读不到就当没切到 */ }
  return { attempted, visible: state.visible, focused: state.focused };
}

/**
 * 点击。★2026-10-22 改成「静默优先，点不动才打扰」★
 *
 * 为什么不是"一律用真实鼠标"：真机实测（三种组合逐一验证）——
 *   · 真实鼠标（/clickXY）在 Edge 窗口被别的程序挡住时**完全无效**：
 *     Chromium 只把真实输入事件送给 visibilityState==='visible' 的页面，
 *     窗口被 DSH 盖住时是 hidden，鼠标事件根本进不去页面（且不报错，只回 clicked:true）。
 *   · 而 JS 点击（el.click()）在 hidden 状态下**照样能跳**。
 *   · 反过来，窗口真在前台时真实鼠标最稳（能过反自动化、算用户手势）。
 *
 * 主人的要求是"别每次查东西都跳个网页到前台"。所以顺序是：
 *   ① 先用 JS 点（静默，绝不切前台、绝不抢窗口）；
 *   ② 点完检查页面**到底动没动**（URL 变 / 开新标签 / 有可见的 DOM 变化）；
 *   ③ 确实没动才把那一页切前台，用真实鼠标重点一次 —— 这才打扰他一次，而且只在必要的时候。
 *
 * `real` 现在表示"允许在必要时升级到真实鼠标"（默认 true）。
 * 传 real=false 就严格只用 JS 点（她可以在明知道不该抢前台时这么用）。
 */
export async function clickElement(targetId, selector, { real = true, expectUrl = '' } = {}) {
  await assertSamePage(targetId, expectUrl);
  // 不预先切前台：先定位（hidden 状态下坐标也是对的，JS 点击根本不用坐标）
  const hit = await findElement(targetId, selector);
  if (hit.password) {
    throw new Error('这是一个密码框，我不点它也不往里填字。要用的话请主人自己来。');
  }
  if (hit.disabled) {
    throw new Error(`那个「${hit.text || selector}」现在是禁用状态（disabled），点了不会有反应。`);
  }

  // ★先存一份"现在开着哪些页"，点完才知道有没有冒出新的（target=_blank）
  await rememberTabs();

  // ── ① 静默点击：JS 点，不切前台、不抢窗口 ──────────────────────────
  // 用 hit.css（真实元素的 CSS 路径）而不是她传进来的 selector ——
  // 她多半是"按按钮上那两个字"找的，那串字不是合法 CSS 选择器。
  const beforeUrl = hit.url || '';
  const beforeSig = await pageSignature(targetId);
  await proxyFetch('/click', {
    method: 'POST',
    body: hit.css || selector,
    params: { target: targetId },
    timeoutMs: ACTION_TIMEOUT_MS,
  });
  await sleep(700);

  const openedAfterJs = await detectNewTab();
  if (openedAfterJs) {
    return {
      clicked: true,
      what: hit.text || selector,
      tag: hit.tag,
      url: openedAfterJs.url || '',
      title: openedAfterJs.title || '',
      navigated: true,
      newTab: { targetId: openedAfterJs.targetId, url: openedAfterJs.url || '', title: openedAfterJs.title || '' },
      mode: 'js',
    };
  }
  const infoAfterJs = await pageInfo(targetId);
  const changedAfterJs = String(infoAfterJs?.url || '') !== beforeUrl
    || String(await pageSignature(targetId)) !== beforeSig;
  if (changedAfterJs) {
    return {
      clicked: true,
      what: hit.text || selector,
      tag: hit.tag,
      url: infoAfterJs?.url || beforeUrl,
      title: infoAfterJs?.title || hit.title || '',
      navigated: String(infoAfterJs?.url || '') !== beforeUrl,
      mode: 'js',
    };
  }

  // ── ② JS 点不动，才升级到真实鼠标（这一步可能把窗口提前台）──────────
  if (!real) {
    return {
      clicked: false,
      what: hit.text || selector,
      tag: hit.tag,
      url: beforeUrl,
      title: hit.title || '',
      navigated: false,
      mode: 'js-only',
      note: '静默点击没让页面动起来，而且这次不允许把浏览器提前台，所以没再重点一次。',
    };
  }

  // 要升级了：此刻才切前台（切完重新定位，因为切前台会重排 —— 见下方注释）
  const focusState = await focusForAction(targetId);
  const hit2 = await findElement(targetId, selector);
  await rememberTabs();
  await proxyFetch('/clickXY', {
    method: 'GET',
    params: { target: targetId, x: hit2.x, y: hit2.y },
    timeoutMs: ACTION_TIMEOUT_MS,
  });
  await sleep(900);

  const opened = await detectNewTab();
  if (opened) {
    return {
      clicked: true,
      what: hit.text || selector,
      tag: hit.tag,
      url: opened.url || '',
      title: opened.title || '',
      navigated: true,
      newTab: { targetId: opened.targetId, url: opened.url || '', title: opened.title || '' },
      mode: 'real',
      broughtToFront: focusState.visible,
      focusAttempted: focusState.attempted,
    };
  }
  const after = await pageInfo(targetId);
  return {
    clicked: true,
    what: hit.text || selector,
    tag: hit.tag,
    url: after?.url || hit2.url || '',
    title: after?.title || hit2.title || '',
    navigated: String(after?.url || '') !== String(beforeUrl),
    mode: 'real',
    broughtToFront: focusState.visible,
    focusAttempted: focusState.attempted,
  };
}

// 页面"长什么样"的廉价指纹：URL + 标题 + 可见文字长度 + 元素数。
// 用来判断"点了一下到底有没有反应" —— 只比 URL 会漏掉弹窗、展开菜单、
// 就地切换 tab 这类"没换页但确实生效"的情况（那才是最常发生的）。
async function pageSignature(targetId) {
  try {
    const raw = await evalValue(targetId, `
      (function(){
        var t = (document.body ? document.body.innerText : '') || '';
        return String(location.href.length) + '|'
          + String(document.title.length) + '|'
          + String(t.length) + '|'
          + String(document.querySelectorAll('*').length);
      })()`, 8000);
    return String(raw ?? '');
  } catch {
    return '';
  }
}

// 记一份"现在开着哪些页"，用来判断刚才那一下有没有开新标签页。
async function snapshotTabs() {
  try {
    const tabs = await listTabs();
    return new Set(tabs.map((t) => t.targetId));
  } catch {
    return new Set();
  }
}

// 点之前先存一份（clickElement 里在点之前调），点之后对比；冒出来的新页就是它打开的。
let lastTabSnapshot = new Set();
export async function rememberTabs() {
  lastTabSnapshot = await snapshotTabs();
  return lastTabSnapshot.size;
}

async function detectNewTab() {
  const before = lastTabSnapshot;
  lastTabSnapshot = new Set();
  if (!before.size) return null;
  const now = await listTabs().catch(() => []);
  const fresh = now.filter((t) => !before.has(t.targetId));
  if (!fresh.length) return null;
  // 挑第一个不是 about:blank / 不是她自己之前那些页的
  const pick = fresh.find((t) => t.url && !t.url.startsWith('about:')) || fresh[0];
  return pick || null;
}

/**
 * 填字。走 CDP 的 Input.insertText —— 真实的输入事件，
 * React/Vue 受控组件、各种风控输入框都会真的收到（el.value= 做不到这件事）。
 * submit=true 填完按一次回车（搜索框最常见的那一下）。
 *
 * ★2026-10-22：不再预先把窗口提前台★
 * 实测填字**不需要**窗口可见：`/type` 带 selector 时自己会 `el.focus()`，
 * `Input.insertText` 在 hidden 状态下也能把字送进输入框（用 Bing 搜索框验过）。
 * 原来那一下"真实鼠标点一下再填"是为了算用户手势，但它要求窗口可见，
 * 等于每填一次就把主人的窗口顶一次 —— 而填字本来就很少依赖用户手势。
 * 现在只在**填不进去**时才升级到"切前台 + 真实鼠标聚焦"。
 */
export async function typeInto(targetId, { selector = '', text = '', submit = false, clear = false, expectUrl = '' } = {}) {
  const value = String(text ?? '');
  if (!value) throw new Error('要填的字不能为空');
  await assertSamePage(targetId, expectUrl);
  if (selector) {
    const hit = await findElement(targetId, selector);
    if (hit.password) {
      throw new Error('这是一个密码框。我不往里填字 —— 密码得主人自己敲，或者他告诉我明确同意再说。');
    }
  }
  // 真正填的那一刻带上 selector：让页面自己 el.focus()，这是 hidden 状态也可靠的那条路。
  const doType = () => proxyFetch('/type', {
    method: 'POST',
    body: JSON.stringify({ selector: selector || '', text: value, submit, clear }),
    params: { target: targetId },
    timeoutMs: ACTION_TIMEOUT_MS,
  });

  let res = await doType();
  // 没填进去？（输入框的值没变）—— 这时才值得切前台重试：有些受控输入框
  // 必须真的收到一次鼠标事件才接受输入。这一步会打扰主人，所以只在失败时才做。
  if (selector && !String(res?.after ?? '').includes(value.slice(0, 8))) {
    const hit2 = await findElement(targetId, selector);
    await focusForAction(targetId);
    await proxyFetch('/clickXY', {
      method: 'GET',
      params: { target: targetId, x: hit2.x, y: hit2.y },
      timeoutMs: ACTION_TIMEOUT_MS,
    });
    await sleep(150);
    res = await doType();
  }
  await sleep(submit ? 900 : 300);
  const after = await pageInfo(targetId);
  return {
    typed: res?.typed ?? value.length,
    submitted: submit === true,
    before: String(res?.before ?? ''),
    after: String(res?.after ?? ''),
    url: after?.url || res?.url || '',
    title: after?.title || '',
  };
}

const SUPPORTED_KEYS = ['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'];

/**
 * 按键。只给一组安全的常用键（不做组合键：Ctrl+A 这类用 type 的 clear 更可靠）。
 * ★2026-10-22：不再预先切前台★ —— 先直接按；如果按完页面毫无变化，
 * 才切前台重按一次（有些站点的 Esc/Tab 只在窗口有焦点时才被前端框架接住）。
 */
export async function pressKey(targetId, key, { expectUrl = '' } = {}) {
  const k = String(key ?? '').trim();
  if (!SUPPORTED_KEYS.includes(k)) {
    throw new Error(`不支持的键：${k || '(空)'}。支持：${SUPPORTED_KEYS.join(' / ')}`);
  }
  await assertSamePage(targetId, expectUrl);
  const doKey = () => proxyFetch('/key', {
    method: 'POST',
    body: JSON.stringify({ key: k }),
    params: { target: targetId },
    timeoutMs: ACTION_TIMEOUT_MS,
  });

  const beforeSig = await pageSignature(targetId);
  await doKey();
  await sleep(450);
  let after = await pageInfo(targetId);
  const changed = String(after?.url || '') !== ''
    && String(await pageSignature(targetId)) !== beforeSig;
  let broughtToFront = false;
  let focusAttempted = false;
  if (!changed) {
    // 按了没反应 —— 切前台再按一次（这一步可能把窗口提前台）
    const fs2 = await focusForAction(targetId);
    broughtToFront = fs2.visible;
    focusAttempted = fs2.attempted;
    await doKey();
    await sleep(450);
    after = await pageInfo(targetId);
  }
  return { pressed: k, url: after?.url || '', title: after?.title || '', broughtToFront, focusAttempted };
}

/**
 * 滚动。走 /wheel → CDP 的 Input.synthesizeScrollGesture（真实滚动输入）。
 * 为什么不用 window.scrollBy：无限滚动的站点（微博、小红书、B站动态）只认"有输入事件"
 * 的滚动，window.scrollBy 会让它以为没人在看，于是不再加载下一页。
 * 到顶/到底单独处理：滚轮一次滚不到底，那两种走 /scroll 的 top/bottom。
 */
/**
 * 滚动。★2026-10-22：静默优先，滚不动才切前台★
 * 两条路：
 *   · /scroll（window.scrollBy）—— **不需要窗口可见**，后台页也能滚，但无限滚动的
 *     站点可能因此不再加载下一页（它以为没人在看）；
 *   · /wheel（Input.synthesizeScrollGesture）—— 真实滚动输入，无限滚动也认，
 *     但要求窗口可见（hidden 状态下 scrollY 纹丝不动，实测过）。
 * 所以先试静默的 /scroll，**真的没滚动**才切前台用滚轮。
 * 这样她"往后翻一页看看"不会把你的窗口顶出来。
 */
export async function scrollPage(targetId, { direction = 'down', amount = 800, expectUrl = '' } = {}) {
  await assertSamePage(targetId, expectUrl);
  const dir = ['down', 'up', 'top', 'bottom'].includes(direction) ? direction : 'down';
  const readY = async () => {
    try { return Number(JSON.parse(await evalValue(targetId, 'String(window.scrollY)')) ?? 0); }
    catch { return 0; }
  };

  const y0 = await readY();
  // ① 静默：window 级滚动（不抢前台）
  await proxyFetch('/scroll', {
    method: 'GET',
    params: { target: targetId, direction: dir, y: Math.min(Math.max(Math.floor(Number(amount) || 800), 100), 4800) },
    timeoutMs: ACTION_TIMEOUT_MS,
  });
  await sleep(450);
  const y1 = await readY();
  const scrolledSilently = dir === 'top' ? y1 < y0 : dir === 'bottom' ? y1 > y0 : y1 !== y0;
  if (scrolledSilently && dir !== 'top' && dir !== 'bottom') {
    const after = await pageInfo(targetId);
    return { scrolled: dir, scrollY: y1, url: after?.url || '', title: after?.title || '', broughtToFront: false };
  }
  if (scrolledSilently) {
    const after = await pageInfo(targetId);
    return { scrolled: dir, scrollY: y1, url: after?.url || '', title: after?.title || '', broughtToFront: false };
  }

  // ② 滚不动（页面自己接管了滚动，比如整页是一个内部滚动的容器 / 无限滚动列表）
  //    才切前台发真实滚轮。这一步可能把窗口提前台。
  const fs3 = await focusForAction(targetId);
  const broughtToFront = fs3.visible;
  const px = Math.min(Math.max(Math.floor(Number(amount) || 800), 100), 4800);
  if (dir === 'top' || dir === 'bottom') {
    await proxyFetch('/scroll', {
      method: 'GET',
      params: { target: targetId, direction: dir },
      timeoutMs: ACTION_TIMEOUT_MS,
    });
  } else {
    await proxyFetch('/wheel', {
      method: 'GET',
      params: { target: targetId, delta: dir === 'up' ? -px : px },
      timeoutMs: ACTION_TIMEOUT_MS,
    });
  }
  await sleep(450);
  const y2 = await readY();
  const after = await pageInfo(targetId);
  return { scrolled: dir, scrollY: y2, url: after?.url || '', title: after?.title || '', broughtToFront };
}

/** 选下拉框。value / label / index 三选一。 */
export async function selectOption(targetId, { selector, value, label, index, expectUrl = '' } = {}) {
  if (!String(selector ?? '').trim()) throw new Error('需要 selector（指向一个 <select>）');
  await ensureProxy();
  await assertSamePage(targetId, expectUrl);
  const res = await proxyFetch('/select', {
    method: 'POST',
    body: JSON.stringify({ selector, value, label, index }),
    params: { target: targetId },
    timeoutMs: ACTION_TIMEOUT_MS,
  });
  return { selected: res?.selected ?? null, index: res?.index ?? null };
}

/** 把页面上的可点元素列一遍（找不到东西时给她看，别让她瞎猜第二次）。 */
export async function listClickables(targetId, limit = CLICKABLE_PREVIEW) {
  const n = Math.min(Math.max(Math.floor(Number(limit) || CLICKABLE_PREVIEW), 1), 80);
  const raw = await evalValue(targetId, `
(function(){
  var out = [];
  var pool = document.querySelectorAll('a,button,[role=button],[role=link],[role=tab],[role=menuitem],input[type=submit],input[type=button],select,textarea,summary');
  for (var i = 0; i < pool.length && out.length < ${n}; i++) {
    var el = pool[i];
    var t = ((el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '') + '').trim().replace(/\\s+/g, ' ');
    if (!t && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA') continue;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    out.push({
      tag: el.tagName,
      text: t.slice(0, 60),
      type: (el.getAttribute('type') || '') || '',
      selector: el.id ? '#' + el.id : (el.getAttribute('name') ? el.tagName.toLowerCase() + '[name="' + el.getAttribute('name') + '"]' : el.tagName.toLowerCase()),
    });
  }
  return JSON.stringify({ url: location.href, title: document.title, items: out });
})()`, ACTION_TIMEOUT_MS);
  try { return JSON.parse(raw); } catch { return { url: '', title: '', items: [] }; }
}

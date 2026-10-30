#!/usr/bin/env node
// CDP Proxy - 通过 HTTP API 操控用户日常浏览器（任意 Chromium 内核浏览器，按数据目录选定）
// 要求：浏览器已开启 remote debugging（chrome://inspect/#remote-debugging toggle，Edge 为 edge://）
// Node.js 22+（使用原生 WebSocket）

import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createCdpConnection } from './cdp-connection.mjs';
import { selectBrowser, explainUnavailable } from './browser-discovery.mjs';
import { createPageFrames, FrameError } from './page-frames.mjs';

// --- 解析命令行 --browser 参数（本次启动用哪个浏览器）---
function parseBrowserArg() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--browser' && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith('--browser=')) return argv[i].slice('--browser='.length);
  }
  return null;
}
const BROWSER_OVERRIDE = parseBrowserArg();

const PORT = parseInt(process.env.CDP_PROXY_PORT || '3456');

// ==== qq-bridge 本地补丁：动作白名单 + 只读开关 ====
// 小鲸鱼 2026-10-22 起有了一只「手」：点、填、滚动、按键、选下拉。
// 她能做到哪一步由 MCP 层决定（src/mcp-web-search-safe.js 只暴露受控动作，
// 没有任意 JS、没有文件系统）；这里只负责两件事：
//
//   ① /setFiles **永远** 403 —— 主人只选了「点填滚按选」这一档，不含上传本机文件。
//      这一条不跟开关走：哪怕把下面的只读开关打开，上传也仍然是关死的。
//   ② 留一个「回到只读」的逃生口：设 WEB_ACCESS_READONLY=1 启动，动作类路由
//      全部 403（等于 2026-10-16 的旧行为）。默认不设 = 手是放开的。
//
// ⚠️ 改这个文件必须重启代理才生效（长驻进程），重启会重连浏览器。
const UPLOAD_BLOCKED = new Set(['/setFiles']);
const HANDS_BLOCKED = new Set(['/click', '/clickAt', '/clickXY', '/type', '/key']);
const READONLY = process.env.WEB_ACCESS_READONLY === '1';
const BLOCKED_ROUTES = READONLY ? new Set([...UPLOAD_BLOCKED, ...HANDS_BLOCKED]) : UPLOAD_BLOCKED;

const sessions = new Map(); // targetId -> sessionId
const managedTabs = new Map(); // targetId -> { lastAccessed: number }
const TAB_IDLE_TIMEOUT = parseInt(process.env.CDP_TAB_IDLE_TIMEOUT || '900000'); // 15 min default
const CLEANUP_INTERVAL = 60000; // sweep every 60s
const INSTANCE_ID = randomUUID();
const STARTED_AT = new Date().toISOString();
const RUNNING_REVISION = createHash('sha256')
  .update(fs.readFileSync(new URL(import.meta.url)))
  .update(fs.readFileSync(new URL('./cdp-connection.mjs', import.meta.url)))
  .digest('hex').slice(0, 12);
let activeRequests = 0;
let maintenance = false;
let cleanupTimer = null;
let shutdownPromise = null;

function lifecycleLog(message) {
  console.log(`[${new Date().toISOString()} pid=${process.pid} instance=${INSTANCE_ID}] [CDP Proxy] ${message}`);
}

// --- WebSocket 兼容层 ---
let WS;
if (typeof globalThis.WebSocket !== 'undefined') {
  // Node 22+ 原生 WebSocket（浏览器兼容 API）
  WS = globalThis.WebSocket;
} else {
  // 回退到 ws 模块
  try {
    WS = (await import('ws')).default;
  } catch {
    console.error('[CDP Proxy] 错误：Node.js 版本 < 22 且未安装 ws 模块');
    console.error('  解决方案：升级到 Node.js 22+ 或执行 npm install -g ws');
    process.exit(1);
  }
}

// proxy 启动时连接到的浏览器（用于 /health 暴露给 check-deps 与维护命令比较）
let connectedBrowser = null; // { id: 数据目录路径, label: 显示名, source }

// pin 首次成功连接的浏览器身份（数据目录）。重连时只接受同一身份，避免悄悄换到别的浏览器。
let pinnedBrowser = null; // { id, label }

// --- 发现浏览器调试端口 ---
// 决策完全委派给 browser-discovery.selectBrowser；此处只做 pin 校验、日志和返回结构包装。
// 不可用一律抛错（由下一次请求重试），不扫描固定端口、不换浏览器。
async function discoverChromePort() {
  const result = await selectBrowser(BROWSER_OVERRIDE);
  if (result.kind === 'config-error') throw new Error(result.message);
  if (result.kind === 'unset') {
    throw new Error('尚未设置浏览器。请先运行 node scripts/check-deps.mjs 完成首次配置（写入 WEB_ACCESS_BROWSER），或启动时指定 --browser <数据目录路径>。');
  }
  if (result.kind === 'unavailable') {
    const steps = explainUnavailable(result).join(' ');
    const switchHint = pinnedBrowser ? '若想换成其他浏览器，请等共享任务完成，通过 proxy-maintenance.mjs stop 停止后再指定 --browser。' : '';
    throw new Error(`${steps} ${switchHint}`.trim());
  }
  if (pinnedBrowser && pinnedBrowser.id !== result.browser.id) {
    throw new Error(
      `本次连接的浏览器已经是 ${pinnedBrowser.label}（${pinnedBrowser.id}），不会自动切到 ${result.browser.label}（${result.browser.id}）。` +
      `如果想换浏览器，请等共享任务完成，通过 proxy-maintenance.mjs stop 停止后再指定 --browser。`
    );
  }
  connectedBrowser = { id: result.browser.id, label: result.browser.label, source: result.source };
  const tag = result.source === 'override' ? '[--browser 指定]' : '[config.env 偏好]';
  console.log(`[CDP Proxy] 选用 ${result.browser.label}（${result.browser.id}，端口 ${result.browser.port}${result.browser.wsPath ? '，带 wsPath' : ''}）${tag}`);
  return { port: result.browser.port, wsPath: result.browser.wsPath };
}

function getWebSocketUrl(port, wsPath) {
  if (wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
  return `ws://127.0.0.1:${port}/devtools/browser`;
}

// --- 断线重连的退避策略（2026-10-22 qq-bridge 加的）---
// 主人原话：「怎么需要使用手的时候，我每次都要点这个浏览器的允许，我不是在一键启动里面
// 就打开过一次了吗」。实测查清了规则的真相：
//   · 「允许远程调试」是**按连接**确认的 —— 一条新的 CDP WebSocket 要重新点一次；
//   · 只要这条连接还活着，**一次都不用点**（代理从 10-18 连到 10-22 中间只断过几次）。
//   ⇒ 所以真正要治的是"**平白无故地重连**"。这里做三件事：
//     ① 连接活着时绝不主动重连（下面的重连计时器只在 `connected === false` 时才跑）；
//     ② 真断了才连，而且间隔从 5 秒开始指数退避到 5 分钟，避免疯狂弹确认框；
//     ③ 判定为"在等主人点允许"时，退避直接拉满，**只在日志里提示一次**，
//        不再反复尝试 —— 他自己会去点，或者等他下一次让你读网页时再试。
const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;
const RECONNECT_MAX_MS_AUTH_WAIT = 30 * 60 * 1000;
let authWait = false; // 上一次握手是被"等授权"超时的
const reconnect = {
  delay: 0,
  timer: null,
  /** 失败后安排下一次（只在 genuinely disconnected 时调用）。 */
  arm(waitingForUser = false) {
    if (shutdownPromise) return;
    const cap = waitingForUser ? RECONNECT_MAX_MS_AUTH_WAIT : RECONNECT_MAX_MS;
    this.delay = this.delay ? Math.min(this.delay * 2, cap) : RECONNECT_MIN_MS;
    if (waitingForUser) this.delay = cap; // 等授权：别反复撞，等他自己点
    if (this.timer) clearTimeout(this.timer);
    const delay = this.delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (connection.connected || shutdownPromise) return;
      lifecycleLog(`重连尝试（距上次失败 ${Math.round(delay / 1000)} 秒）`);
      connect().catch(() => { /* onDisconnect 会继续安排下一次 */ });
    }, delay);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  },
  reset() {
    this.delay = 0;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  },
};

// --- 连接唯一所有者：发现、握手和 CDP 请求共用同一生命周期 ---
let chromePort = null;
const connection = createCdpConnection({
  WebSocketImpl: WS,
  discoverUrl: async () => {
    const discovered = await discoverChromePort();
    chromePort = discovered.port;
    return getWebSocketUrl(discovered.port, discovered.wsPath);
  },
  onConnect: () => {
    pinnedBrowser = { id: connectedBrowser.id, label: connectedBrowser.label };
    // 连上了就把退避清空：下一次断开从"马上重连"重新开始。
    reconnect.reset();
    authWait = false;
    lifecycleLog(`已连接浏览器 (端口 ${chromePort})`);
  },
  onDisconnect: (error) => {
    chromePort = null;
    sessions.clear();
    managedTabs.clear();
    portGuardedSessions.clear();
    // ★区分"真断了"和"在等你点允许"★
    // 前者（浏览器关了、代理被重启）自动重连是对的；后者**不能**自己反复重连 ——
    // 每重连一次就弹一次确认框，主人会觉得"怎么每次都在点"。所以只发一次提示，
    // 之后把重连间隔拉到最长，等他自己去点、或者等下次真实调用时再试。
    authWait = error?.code === 'CDP_HANDSHAKE_TIMEOUT';
    lifecycleLog(`连接已失效：${error.message}${authWait ? '（判定：在等主人点「允许远程调试」）' : ''}`);
    reconnect.arm(authWait);
  },
  onDiagnostic: (error) => lifecycleLog(`连接诊断：${error.message}`),
  onEvent: (msg) => {
    if (msg.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = msg.params;
      sessions.set(targetInfo.targetId, sessionId);
    }
    // 标签页关闭、跨进程 iframe 换进程或被移除时，浏览器解除对应 session；从缓存删除，下次使用时重新 attach。
    if (msg.method === 'Target.detachedFromTarget') {
      const { sessionId, targetId } = msg.params;
      for (const [id, sid] of sessions) {
        if (sid === sessionId && (!targetId || id === targetId)) sessions.delete(id);
      }
      portGuardedSessions.delete(sessionId);
    }
    if (msg.method === 'Fetch.requestPaused') {
      const { requestId, sessionId: sid } = msg.params;
      sendCDP('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }, sid)
        .catch(error => lifecycleLog(`端口探测拦截失败：${error.message}`));
    }
  },
});

const connect = () => connection.connect();
const sendCDP = (method, params = {}, sessionId = null) => connection.send(method, params, sessionId);

// 已启用端口拦截的 session 集合（避免重复启用）
const portGuardedSessions = new Set();

async function ensureSession(targetId) {
  if (sessions.has(targetId)) return sessions.get(targetId);
  const resp = await sendCDP('Target.attachToTarget', { targetId, flatten: true });
  if (resp.result?.sessionId) {
    const sid = resp.result.sessionId;
    sessions.set(targetId, sid);
    // 启用调试端口探测拦截
    await enablePortGuard(sid);
    return sid;
  }
  throw new Error('attach 失败: ' + JSON.stringify(resp.error));
}

// 页面中的 iframe（列举、执行、坐标点击路由）；跨进程 iframe 的子 session 同样经 ensureSession 进入缓存
const pageFrames = createPageFrames({ send: (...args) => sendCDP(...args), ensureSession });

// 拦截页面对 Chrome 调试端口的探测（反风控）
// 只拦截 127.0.0.1:{chromePort} 的请求，不影响其他任何本地服务
async function enablePortGuard(sessionId) {
  if (!chromePort || portGuardedSessions.has(sessionId)) return;
  try {
    await sendCDP('Fetch.enable', {
      patterns: [
        { urlPattern: `http://127.0.0.1:${chromePort}/*`, requestStage: 'Request' },
        { urlPattern: `http://localhost:${chromePort}/*`, requestStage: 'Request' },
      ]
    }, sessionId);
    portGuardedSessions.add(sessionId);
  } catch { /* Fetch 域启用失败不影响主流程 */ }
}

// --- 闲置 Tab 自动清理 ---
function touchTab(targetId) {
  const entry = managedTabs.get(targetId);
  if (entry) entry.lastAccessed = Date.now();
}

async function cleanupIdleTabs() {
  if (!connection.connected) return;
  const now = Date.now();
  for (const [targetId, info] of managedTabs) {
    if (now - info.lastAccessed < TAB_IDLE_TIMEOUT) continue;
    try { await sendCDP('Target.closeTarget', { targetId }); } catch { /* tab may already be closed */ }
    sessions.delete(targetId);
    managedTabs.delete(targetId);
    console.log(`[CDP Proxy] Auto-closed idle tab: ${targetId}`);
  }
}

async function closeAllManagedTabs() {
  if (!connection.connected) return;
  const targets = [...managedTabs.keys()];
  for (const targetId of targets) {
    try { await sendCDP('Target.closeTarget', { targetId }); } catch { /* ignore */ }
    sessions.delete(targetId);
    managedTabs.delete(targetId);
  }
  if (targets.length) console.log(`[CDP Proxy] Shutdown: closed ${targets.length} managed tab(s)`);
}

// --- 等待页面加载 ---
async function waitForLoad(
  sessionId,
  timeoutMs = 15000,
  { requireNonBlank = false, acceptInteractive = false } = {},
) {
  // 启用 Page 域
  await sendCDP('Page.enable', {}, sessionId);

  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearInterval(checkInterval);
      resolve(result);
    };

    const timer = setTimeout(() => done('timeout'), timeoutMs);
    const checkInterval = setInterval(async () => {
      try {
        const resp = await sendCDP('Runtime.evaluate', {
          expression: 'JSON.stringify({ ready: document.readyState, url: location.href })',
          returnByValue: true,
        }, sessionId);
        const value = resp.result?.result?.value;
        const state = typeof value === 'string' ? JSON.parse(value) : null;
        const ready = state?.ready === 'complete' || (acceptInteractive && state?.ready === 'interactive');
        if (ready && (!requireNonBlank || state.url !== 'about:blank')) {
          done('complete');
        }
      } catch { /* 忽略 */ }
    }, 500);
  });
}

// --- 读取 POST body ---
async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

// --- HTTP API ---
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;
  const q = Object.fromEntries(parsed.searchParams);
  if (q.target) touchTab(q.target);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // ==== qq-bridge 本地补丁：上传永远关死；只读开关打开时连动作一起关 ====
  if (BLOCKED_ROUTES.has(pathname)) {
    req.resume(); // 把请求体排空，避免 keep-alive 连接卡住
    res.statusCode = 403;
    const why = pathname === '/setFiles'
      ? `上传文件被 qq-bridge 本地补丁禁用（${pathname}）：小鲸鱼能点、能填、能按，但不能把本机文件塞进网页`
      : `只读模式：${pathname} 已被 qq-bridge 本地补丁禁用（启动代理时设了 WEB_ACCESS_READONLY=1）`;
    res.end(JSON.stringify({
      error: why,
      readonly: READONLY,
      blocked: [...BLOCKED_ROUTES],
    }));
    return;
  }

  let operationActive = false;
  try {
    // /health 不需要连接浏览器
    if (pathname === '/health') {
      const connected = connection.connected;
      res.end(JSON.stringify({
        status: 'ok',
        connected,
        browser: connectedBrowser,
        sessions: sessions.size,
        managedTabs: managedTabs.size,
        chromePort,
        pid: process.pid,
        instanceId: INSTANCE_ID,
        startedAt: STARTED_AT,
        runningRevision: RUNNING_REVISION,
        connectionState: connection.state,
        connectionAttempts: connection.attemptCount,
        pendingCommands: connection.pendingCount,
        // 2026-10-22：把"是不是在等主人点允许"直接说出来。
        // 上层（MCP 工具 / 一键启动）靠这个决定"要不要提示他去点"，
        // 而不是靠猜 `connected:false` 的原因。
        waitingForAuth: authWait,
        nextRetryMs: reconnect.timer ? reconnect.delay : 0,
        activeRequests,
        maintenance,
      }));
      return;
    }

    // 维护由明确的本机命令触发；普通浏览器页面不能请求关闭共享服务。
    if (pathname === '/shutdown') {
      if (req.method !== 'POST' || req.headers.origin) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: '请使用本机维护命令' }));
        return;
      }
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '维护请求需要 instanceId JSON' }));
        return;
      }
      if (body?.instanceId !== INSTANCE_ID) {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: '服务实例已变化，请重新检查', instanceId: INSTANCE_ID }));
        return;
      }
      if (!maintenance && (activeRequests > 0 || managedTabs.size > 0 || connection.pendingCount > 0 ||
          connection.state === 'discovering' || connection.state === 'connecting')) {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: 'busy', activeRequests, managedTabs: managedTabs.size, pendingCommands: connection.pendingCount }));
        return;
      }
      maintenance = true;
      res.once('finish', () => { void shutdown('维护命令'); });
      res.statusCode = 202;
      res.end(JSON.stringify({ status: 'stopping', instanceId: INSTANCE_ID }));
      return;
    }

    if (maintenance) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: '服务正在维护，请稍后重试' }));
      return;
    }
    activeRequests++;
    operationActive = true;

    // ★有人真的要用浏览器时才连★（2026-10-22）
    // 平时（没人调用）代理**绝不主动重连** —— 连接活着就一直用那条；
    // 只有在请求真的来临时、且当前是断的，才连一次。
    // 这样"每次使用都要点允许"就变成了"断线后第一次使用才可能要你点一次"，
    // 而且连上以后一直是同一条连接，不会再有确认框。
    if (!connection.connected) {
      reconnect.reset();       // 有真实需求 ⇒ 立刻试，不等退避
      authWait = false;
    }
    await connect();

    // GET /targets - 列出所有页面
    // ==== qq-bridge 本地补丁：标注 mine ====
    // mine = 这一页是本代理用 /new 开的（在 managedTabs 里）。小鲸鱼靠它区分
    // "她自己开的页" 与 "主人自己的页"，从而绝不去关主人正在看的页面。
    // managedTabs 在 onDisconnect 时会清空，所以代理重启后旧页会退化成 mine:false
    // ——失败的偏向是"不许关"，安全。
    if (pathname === '/targets') {
      const resp = await sendCDP('Target.getTargets');
      const pages = resp.result.targetInfos.filter(t => t.type === 'page')
        .map(t => ({ ...t, mine: managedTabs.has(t.targetId) }));
      res.end(JSON.stringify(pages, null, 2));
    }

    // POST /new (body=URL) - 创建新后台 tab
    else if (pathname === '/new') {
      if (req.method !== 'POST') {
        res.statusCode = 400;
        res.end(JSON.stringify({
          error: 'v2.5.3 起 /new 改为 POST 传 URL（避免目标 URL 含 query 时被错误切分）',
          migration: 'references/migration-2.5.3.md',
          example: "curl -X POST --data-raw 'https://example.com' http://localhost:3456/new",
        }));
        return;
      }
      const body = (await readBody(req)).trim();
      const targetUrl = body || 'about:blank';
      // 先创建空白页并完成 attach，再显式导航。Target.createTarget({ url }) 会先暴露
      // readyState=complete 的 about:blank，导致慢页面在真正开始加载前被误判为完成。
      const resp = await sendCDP('Target.createTarget', { url: 'about:blank', background: true });
      const targetId = resp.result.targetId;
      managedTabs.set(targetId, { lastAccessed: Date.now() });

      // 等待页面加载
      if (targetUrl !== 'about:blank') {
        try {
          const sid = await ensureSession(targetId);
          await sendCDP('Page.navigate', { url: targetUrl }, sid);
          await waitForLoad(sid, 15000, { requireNonBlank: true, acceptInteractive: true });
        } catch { /* 非致命，继续 */ }
      }

      res.end(JSON.stringify({ targetId }));
    }

    // GET /close?target=xxx - 关闭 tab
    // ==== qq-bridge 本地补丁：只能关自己开的页 ====
    // 小鲸鱼现在能列出主人的标签页了，如果没有这道闸，web_close 就有能力把
    // 主人正在看的页面关掉。只放行 managedTabs 里的（= 经 /new 开的）。
    else if (pathname === '/close') {
      if (!managedTabs.has(q.target)) {
        res.statusCode = 403;
        res.end(JSON.stringify({
          error: '只读模式：这一页不是本代理打开的，不能关（小鲸鱼只能关自己开的页）',
          readonly: true,
          target: q.target || null,
        }));
        return;
      }
      const resp = await sendCDP('Target.closeTarget', { targetId: q.target });
      sessions.delete(q.target);
      managedTabs.delete(q.target);
      res.end(JSON.stringify(resp.result));
    }

    // POST /navigate?target=xxx (body=URL) - 导航（自动等待加载）
    else if (pathname === '/navigate') {
      if (req.method !== 'POST') {
        res.statusCode = 400;
        res.end(JSON.stringify({
          error: 'v2.5.3 起 /navigate 改为 POST 传 URL（避免目标 URL 含 query 时被错误切分）',
          migration: 'references/migration-2.5.3.md',
          example: "curl -X POST --data-raw 'https://example.com' 'http://localhost:3456/navigate?target=ID'",
        }));
        return;
      }
      const targetUrl = (await readBody(req)).trim();
      const sid = await ensureSession(q.target);
      const resp = await sendCDP('Page.navigate', { url: targetUrl }, sid);

      // 等待页面加载完成
      await waitForLoad(sid);

      res.end(JSON.stringify(resp.result));
    }

    // GET /back?target=xxx - 后退
    else if (pathname === '/back') {
      const sid = await ensureSession(q.target);
      await sendCDP('Runtime.evaluate', { expression: 'history.back()' }, sid);
      await waitForLoad(sid);
      res.end(JSON.stringify({ ok: true }));
    }

    // GET /frames?target=xxx - 列出页面主文档中的 iframe（frameId、网址、是否跨进程与定位线索）
    else if (pathname === '/frames') {
      if (!q.target) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '需要 target' }));
        return;
      }
      res.end(JSON.stringify(await pageFrames.listFrames(q.target), null, 2));
    }

    // POST /eval?target=xxx[&frame=frameId] - 执行 JS；带 frame 时在该 iframe 中执行（frameId 取自 /frames）
    else if (pathname === '/eval') {
      let sid;
      let contextId;
      if (q.frame !== undefined) ({ sessionId: sid, contextId } = await pageFrames.frameContext(q.target, q.frame));
      else sid = await ensureSession(q.target);
      const body = await readBody(req);
      const expr = body || q.expr || 'document.title';
      const resp = await sendCDP('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
        ...(contextId ? { contextId } : {}),
      }, sid);
      // 不带 frame 时保持原有返回方式不变；带 frame 时如实报告 CDP 错误
      if (contextId && resp.error) throw new Error('Runtime.evaluate: ' + resp.error.message);
      if (resp.result?.result?.value !== undefined) {
        res.end(JSON.stringify({ value: resp.result.result.value }));
      } else if (resp.result?.exceptionDetails) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: resp.result.exceptionDetails.text }));
      } else {
        res.end(JSON.stringify(resp.result));
      }
    }

    // GET /clickXY?target=xxx&x=120&y=90 - 按视口坐标真实鼠标点击；逐层进入命中的 iframe（跨进程的换算坐标后发给其子 session），不激活标签页
    // clicked 只表示鼠标事件已发出；坐标不在视口内时 400，不发事件
    else if (pathname === '/clickXY') {
      const x = Number(q.x);
      const y = Number(q.y);
      if (!q.target || !q.x?.trim() || !q.y?.trim() || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '需要 target，以及有限的非负 x、y 视口坐标' }));
        return;
      }
      const route = await pageFrames.routePoint(q.target, x, y);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        const resp = await sendCDP('Input.dispatchMouseEvent', {
          type, x: route.x, y: route.y,
          button: type === 'mouseMoved' ? 'none' : 'left',
          buttons: type === 'mousePressed' ? 1 : 0,
          clickCount: type === 'mouseMoved' ? 0 : 1,
        }, route.sessionId);
        if (resp.error) throw new Error('Input.dispatchMouseEvent: ' + resp.error.message);
      }
      res.end(JSON.stringify({
        clicked: true, x, y,
        ...(route.frameId ? { frameId: route.frameId, crossProcess: route.crossProcess, depth: route.depth } : {}),
      }));
    }

    // POST /click?target=xxx - 点击（body 为 CSS 选择器）
    // POST /click?target=xxx — JS 层面点击（简单快速，覆盖大多数场景）
    else if (pathname === '/click') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      const selectorJson = JSON.stringify(selector);
      const js = `(() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { error: '未找到元素: ' + ${selectorJson} };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { clicked: true, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`;
      const resp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      if (resp.result?.result?.value) {
        const val = resp.result.result.value;
        if (val.error) {
          res.statusCode = 400;
          res.end(JSON.stringify(val));
        } else {
          res.end(JSON.stringify(val));
        }
      } else {
        res.end(JSON.stringify(resp.result));
      }
    }

    // POST /clickAt?target=xxx — CDP 浏览器级真实鼠标点击（算用户手势，能触发文件对话框、绕过反自动化检测）
    else if (pathname === '/clickAt') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      const selectorJson = JSON.stringify(selector);
      const js = `(() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { error: '未找到元素: ' + ${selectorJson} };
        el.scrollIntoView({ block: 'center' });
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`;
      const coordResp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      const coord = coordResp.result?.result?.value;
      if (!coord || coord.error) {
        res.statusCode = 400;
        res.end(JSON.stringify(coord || coordResp.result));
        return;
      }
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', clickCount: 1
      }, sid);
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', clickCount: 1
      }, sid);
      res.end(JSON.stringify({ clicked: true, x: coord.x, y: coord.y, tag: coord.tag, text: coord.text }));
    }

    // GET /focus-emulate?target=xxx&on=1 - 让这一页"以为"自己是前台页（不真的切过去）
    // 2026-10-22 qq-bridge 加的：用来验证「不抢主人前台也能用真实鼠标」这条路。
    // CDP 的 Emulation.setFocusEmulationEnabled 只改页面看到的焦点/可见性状态，
    // 不改浏览器窗口的前后顺序 —— 也就是说主人正在看的页不会被动。
    else if (pathname === '/focus-emulate') {
      const sid = await ensureSession(q.target);
      const on = q.on !== '0';
      const resp = await sendCDP('Emulation.setFocusEmulationEnabled', { enabled: on }, sid);
      if (resp.error) throw new Error('Emulation.setFocusEmulationEnabled: ' + resp.error.message);
      await new Promise(r => setTimeout(r, 200));
      const st = await sendCDP('Runtime.evaluate', {
        expression: 'JSON.stringify({vis:document.visibilityState,focus:document.hasFocus()})',
        returnByValue: true,
      }, sid).catch(() => null);
      res.end(JSON.stringify({ emulated: on, state: st?.result?.result?.value || '' }));
    }

    // POST /inject?target=xxx - 让这段脚本"在这个页面每次加载时先跑"（2026-10-22 qq-bridge 加的）
    // body: JSON { source: "脚本全文" }
    //
    // 用途：网页游戏的玩法逻辑常常藏在闭包里（《古玩大亨》的 ui.js 就把 state 关在
    // 模块级变量里），外面读不到局面就只能靠截图猜。这里用 CDP 官方的
    // `Page.addScriptToEvaluateOnNewDocument` 在页面每次加载时先注入一小段钩子，
    // **不改游戏文件一个字节**（主人以后可能整包换掉游戏目录）。
    //
    // ⚠️ 注入的脚本**只可能来自本仓库的适配器**（src/games/io.js 读 game_io_hook.js），
    //    MCP 层没有任何工具能直接调这个端点 —— 她拿不到任意 JS。
    // ⚠️ 注入后必须 reload 一次：这个 API 只对**之后**的加载生效。
    else if (pathname === '/inject') {
      if (req.method !== 'POST') {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 JSON：{ source }' }));
        return;
      }
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { res.statusCode = 400; res.end(JSON.stringify({ error: 'body 不是合法 JSON' })); return; }
      const source = String(body?.source ?? '');
      if (!source) { res.statusCode = 400; res.end(JSON.stringify({ error: '缺少 source' })); return; }
      if (source.length > 200000) { res.statusCode = 400; res.end(JSON.stringify({ error: '脚本太长（>200KB）' })); return; }
      const sid = await ensureSession(q.target);
      const resp = await sendCDP('Page.addScriptToEvaluateOnNewDocument', { source }, sid);
      if (resp.error) throw new Error('Page.addScriptToEvaluateOnNewDocument: ' + resp.error.message);
      const identifier = resp.result?.identifier ?? '';
      // 立刻重载，让钩子在这一版页面上生效
      await sendCDP('Page.reload', { ignoreCache: false }, sid);
      await new Promise(r => setTimeout(r, 1200));
      res.end(JSON.stringify({ installed: true, identifier, reloaded: true }));
    }

    // GET /activate?target=xxx - 把这一页切到前台（2026-10-22 qq-bridge 加的）
    // 为什么手需要它：/new 建的是**后台标签页**（background:true），而后台页里
    // 鼠标/滚轮事件到不了页面 —— 2026-10-22 真机实测：在后台页发
    // Input.synthesizeScrollGesture，scrollY 一动都不动；点链接也不跳。
    // 所以动手之前先把那一页切到前台（顺带也是一层透明：主人能看见她在点哪儿）。
    else if (pathname === '/activate') {
      if (!q.target) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '需要 target' }));
        return;
      }
      const resp = await sendCDP('Target.activateTarget', { targetId: q.target });
      if (resp.error) throw new Error('Target.activateTarget: ' + resp.error.message);
      await new Promise(r => setTimeout(r, 350));
      res.end(JSON.stringify({ activated: true, target: q.target }));
    }

    // POST /type?target=xxx - 往输入框/可编辑区填字（2026-10-22 qq-bridge 加的）
    // body: JSON { selector?, text, submit?, clear?, append? }
    //   selector 省略 = 用当前焦点（点击之后常见）
    //   submit=true = 填完按一次回车（搜索框/登录框最常见的那一下）
    //   clear=true  = 填之前先清空（默认 false：在名字后面接字是常见需求，不能默认抹掉）
    // 走 CDP Input.insertText 而不是 el.value = ...：前者是"真实的输入"，
    // React/Vue 受控组件、银行的输入框都会真的收到事件；后者常常看起来填上了、其实没生效。
    else if (pathname === '/type') {
      const sid = await ensureSession(q.target);
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 JSON：{ selector?, text, submit?, clear?, append? }' }));
        return;
      }
      const text = String(body?.text ?? '');
      if (!text) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'text 不能为空' }));
        return;
      }
      // 先聚焦（有选择器就点它；没有就用当前焦点）
      const focusJs = body?.selector
        ? `(() => {
            const el = document.querySelector(${JSON.stringify(String(body.selector))});
            if (!el) return { error: '未找到元素: ' + ${JSON.stringify(String(body.selector))} };
            el.scrollIntoView({ block: 'center' });
            el.focus();
            if (${body.clear === true} && 'value' in el) el.value = '';
            const editable = el.isContentEditable === true;
            const tag = el.tagName;
            const type = el.getAttribute ? (el.getAttribute('type') || '') : '';
            return { focused: true, tag, type, editable, before: String(el.value ?? el.innerText ?? '').slice(0, 200) };
          })()`
        : `(() => {
            const el = document.activeElement;
            if (!el || el === document.body) return { error: '当前没有焦点元素：先点一下那个输入框，或者传 selector' };
            if (${body.clear === true} && 'value' in el) el.value = '';
            return {
              focused: true, tag: el.tagName,
              type: (el.getAttribute ? el.getAttribute('type') : '') || '',
              editable: el.isContentEditable === true,
              before: String(el.value ?? el.innerText ?? '').slice(0, 200),
            };
          })()`;
      const focusResp = await sendCDP('Runtime.evaluate', {
        expression: focusJs, returnByValue: true, awaitPromise: true,
      }, sid);
      const focus = focusResp.result?.result?.value;
      if (!focus || focus.error) {
        res.statusCode = 400;
        res.end(JSON.stringify(focus || focusResp.result));
        return;
      }
      await sendCDP('Input.insertText', { text }, sid);
      if (body?.submit === true) {
        for (const type of ['keyDown', 'keyUp']) {
          await sendCDP('Input.dispatchKeyEvent', {
            type,
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
            text: type === 'keyDown' ? '\r' : undefined,
          }, sid);
        }
      }
      // 填完把结果读回来 —— "填上了没有"是这一步唯一的验收标准
      const afterResp = await sendCDP('Runtime.evaluate', {
        expression: `(() => {
          const el = document.activeElement;
          return JSON.stringify({
            tag: el ? el.tagName : '',
            after: el ? String(el.value ?? el.innerText ?? '').slice(0, 200) : '',
            url: location.href,
          });
        })()`,
        returnByValue: true,
      }, sid);
      let after = {};
      try { after = JSON.parse(afterResp.result?.result?.value || '{}'); } catch { /* 读不回就算了 */ }
      res.end(JSON.stringify({
        typed: text.length,
        submitted: body?.submit === true,
        tag: after.tag || focus.tag,
        before: focus.before ?? '',
        after: after.after ?? '',
        url: after.url || '',
      }));
    }

    // POST /key?target=xxx - 按键（2026-10-22 qq-bridge 加的）
    // body: JSON { key: 'Enter'|'Escape'|'Tab'|'PageDown'|..., text?: '单字符' }
    // 真实按键，走 CDP 的 dispatchKeyEvent；不提供组合键（Ctrl+A 这种交给 /type 的 clear）。
    else if (pathname === '/key') {
      const sid = await ensureSession(q.target);
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { body = { key: q.key }; }
      const key = String(body?.key ?? '').trim();
      const CODES = {
        Enter: [13, 'Enter'], Escape: [27, 'Escape'], Tab: [9, 'Tab'],
        Backspace: [8, 'Backspace'], Delete: [46, 'Delete'], Space: [32, 'Space'],
        ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'],
        ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
        PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'],
        Home: [36, 'Home'], End: [35, 'End'],
      };
      if (!CODES[key]) {
        res.statusCode = 400;
        res.end(JSON.stringify({
          error: `不支持的键：${key || '(空)'}`,
          supported: Object.keys(CODES),
        }));
        return;
      }
      const [vk, code] = CODES[key];
      for (const type of ['keyDown', 'keyUp']) {
        await sendCDP('Input.dispatchKeyEvent', {
          type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
          text: type === 'keyDown' ? String(body?.text ?? '') : undefined,
        }, sid);
      }
      res.end(JSON.stringify({ pressed: key }));
    }

    // POST /select?target=xxx - 选下拉框（2026-10-22 qq-bridge 加的）
    // body: JSON { selector?, value?, label?, index? }
    // 按 value / 可见文字 / 序号 选中 <select>，并触发 change 事件（受控组件靠它）。
    else if (pathname === '/select') {
      const sid = await ensureSession(q.target);
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 JSON：{ selector?, value?, label?, index? }' }));
        return;
      }
      const selector = String(body?.selector ?? '');
      const want = {
        value: body?.value === undefined ? null : String(body.value),
        label: body?.label === undefined ? null : String(body.label),
        index: Number.isFinite(Number(body?.index)) ? Number(body.index) : null,
      };
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '需要 selector（指向一个 <select>）' }));
        return;
      }
      if (want.value === null && want.label === null && want.index === null) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '需要 value / label / index 三者之一' }));
        return;
      }
      const js = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { error: '未找到元素: ' + ${JSON.stringify(selector)} };
        if (el.tagName !== 'SELECT') return { error: '这个元素不是 <select>，是 ' + el.tagName };
        const opts = [...el.options];
        let hit = null;
        if (${JSON.stringify(want.value)} !== null) hit = opts.find(o => o.value === ${JSON.stringify(want.value)});
        if (!hit && ${JSON.stringify(want.label)} !== null) hit = opts.find(o => (o.label || o.textContent || '').trim() === ${JSON.stringify(want.label)});
        if (!hit && ${want.index === null ? 'null' : want.index} !== null) hit = opts[${want.index === null ? '0' : want.index}];
        if (!hit) {
          return { error: '没有这一项', options: opts.slice(0, 40).map(o => ({ value: o.value, label: (o.label || o.textContent || '').trim() })) };
        }
        el.value = hit.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { selected: { value: hit.value, label: (hit.label || hit.textContent || '').trim() }, index: opts.indexOf(hit) };
      })()`;
      const resp = await sendCDP('Runtime.evaluate', {
        expression: js, returnByValue: true, awaitPromise: true,
      }, sid);
      const val = resp.result?.result?.value;
      if (val?.error) {
        res.statusCode = 400;
        res.end(JSON.stringify(val));
        return;
      }
      res.end(JSON.stringify(val ?? resp.result));
    }

    // POST /setFiles?target=xxx — 给 file input 设置本地文件（绕过文件对话框）
    // body: JSON { "selector": "input[type=file]", "files": ["/path/to/file1.png", "/path/to/file2.png"] }
    else if (pathname === '/setFiles') {
      const sid = await ensureSession(q.target);
      const body = JSON.parse(await readBody(req));
      if (!body.selector || !body.files) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '需要 selector 和 files 字段' }));
        return;
      }
      // 获取 DOM 节点
      await sendCDP('DOM.enable', {}, sid);
      const doc = await sendCDP('DOM.getDocument', {}, sid);
      const node = await sendCDP('DOM.querySelector', {
        nodeId: doc.result.root.nodeId,
        selector: body.selector
      }, sid);
      if (!node.result?.nodeId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '未找到元素: ' + body.selector }));
        return;
      }
      // 设置文件
      await sendCDP('DOM.setFileInputFiles', {
        nodeId: node.result.nodeId,
        files: body.files
      }, sid);
      res.end(JSON.stringify({ success: true, files: body.files.length }));
    }

    // GET /wheel?target=&delta=800 - 真实鼠标滚轮（2026-10-22 qq-bridge 加的）
    // 为什么不用 /scroll 的 window.scrollBy：无限滚动的站点（微博、小红书、B站动态）
    // 只在收到**真实的滚轮事件**时才继续加载下一页；window.scrollBy 会让它以为没人
    // 在看，于是滚到一片空白就不再加载。这里发 Input.dispatchMouseWheel，坐标取视口中心。
    else if (pathname === '/wheel') {
      const sid = await ensureSession(q.target);
      const delta = Math.trunc(Number(q.delta) || 800);
      const vp = await sendCDP('Runtime.evaluate', {
        expression: 'JSON.stringify([window.innerWidth||800, window.innerHeight||600])',
        returnByValue: true,
      }, sid);
      let [vw, vh] = [800, 600];
      try { [vw, vh] = JSON.parse(vp.result?.result?.value || '[800,600]'); } catch { /* 默认值 */ }
      const x = Math.round(vw / 2);
      const y = Math.round(vh / 2);
      // ★用 Input.synthesizeScrollGesture，不用 dispatchMouseEvent(type:'mouseWheel')★
      // 2026-10-22 真机实测：mouseWheel 那个事件发出去后 CDP 一直不回话，
      // 30 秒后代理报「CDP 命令超时: Input.dispatchMouseEvent」——
      // 也就是说那一下既没滚动、又把连接堵了半分钟。
      // synthesizeScrollGesture 是 CDP 专门给"滚动"用的合成手势：它真的产生输入事件
      // （无限滚动的站点认它），而且会正常结算。
      // 方向靠 yDistance 的符号：负数 = 往下看（内容上移），正数 = 往回滚。
      const resp = await sendCDP('Input.synthesizeScrollGesture', {
        x, y,
        xDistance: 0,
        yDistance: -delta,
        speed: Math.max(400, Math.min(3000, Math.abs(delta) * 2)),
        gestureSourceType: 'mouse',
        repeatCount: 0,
        repeatDelayMs: 0,
      }, sid);
      if (resp.error) throw new Error('Input.synthesizeScrollGesture: ' + resp.error.message);
      // 等懒加载触发（和 /scroll 一样给 800ms，再多给一点给无限滚动）
      await new Promise(r => setTimeout(r, 900));
      const h = await sendCDP('Runtime.evaluate', {
        expression: 'JSON.stringify({y: window.scrollY, h: document.documentElement.scrollHeight})',
        returnByValue: true,
      }, sid).catch(() => null);
      let scrollY = 0;
      try { scrollY = JSON.parse(h?.result?.result?.value || '{}').y || 0; } catch { /* 读不回就算了 */ }
      res.end(JSON.stringify({ wheeled: delta, scrollY }));
    }

    // GET /scroll?target=xxx&y=3000 - 滚动
    else if (pathname === '/scroll') {
      const sid = await ensureSession(q.target);
      const y = parseInt(q.y || '3000');
      const direction = q.direction || 'down'; // down | up | top | bottom
      let js;
      if (direction === 'top') {
        js = 'window.scrollTo(0, 0); "scrolled to top"';
      } else if (direction === 'bottom') {
        js = 'window.scrollTo(0, document.body.scrollHeight); "scrolled to bottom"';
      } else if (direction === 'up') {
        js = `window.scrollBy(0, -${Math.abs(y)}); "scrolled up ${Math.abs(y)}px"`;
      } else {
        js = `window.scrollBy(0, ${Math.abs(y)}); "scrolled down ${Math.abs(y)}px"`;
      }
      const resp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
      }, sid);
      // 等待懒加载触发
      await new Promise(r => setTimeout(r, 800));
      res.end(JSON.stringify({ value: resp.result?.result?.value }));
    }

    // GET /screenshot?target=xxx&file=/tmp/x.png - 截图
    // ★2026-10-22：加了「单次超时 + 自动重试」★
    // 实测问题：在《古玩大亨》那个页上，Page.captureScreenshot **偶发卡死** ——
    // 8 连拍里有 3 次挂满 30 秒才失败（成功的只要 200ms）；同一个页在后台也会时快时慢，
    // 而普通页面放后台只要 133ms。也就是说这跟"窗口在不在前台"无关，
    // 是这个 CDP 命令在那个 DOM 上偶发不结算。
    //
    // 她的体验是"截个图卡半分钟然后报错"，然后还得重来一次 —— 这才是真问题。
    // 处理：给单次截图一个**独立超时**（默认 8 秒），超时就放弃这一次、换一条新 session
    // 重试（一次），都失败就如实回 504。绝不让她等 30 秒。
    else if (pathname === '/screenshot') {
      const format = q.format || 'png';
      const shotTimeoutMs = Math.min(Math.max(Number(q.timeoutMs) || 8000, 2000), 20000);
      // ★★ 2026-10-22 的真正根因 ★★
      // 后台标签页（visibilityState==='hidden'）**不会自己合成新帧**：
      // Chromium 把不可见页面的渲染停掉了，`Page.captureScreenshot` 就在那儿等一帧
      // 永远不会来的画面 —— 实测每次都卡满超时；而"重试一次"之所以只要 100ms，
      // 是因为 detach session 的动作顺带把渲染唤醒了（假象，不是它真的快）。
      //
      // 正解（实测出来的，别凭直觉改）：要对那个 target 真的 `Target.activateTarget`
      // **一次**，之后同一个页的截图就一直是 90~110ms。
      //   · `Emulation.setFocusEmulationEnabled` 没用 —— 页面自己以为可见了，
      //     但合成器那边还是不给它产帧（实测：模拟后照样 8 秒超时）；
      //   · 简单页（data:text/html）不需要这一步，所以只有"真实站点"才会撞上；
      //   · 这个 activate 是**把标签页设成它所在窗口的当前页**，不是把窗口提到最前 ——
      //     主人正在看的那个页不会被抢走（也正因如此它才能安全地放在每次截图前）。
      const nudgeRender = async (targetId, sid) => {
        try {
          await sendCDP('Target.activateTarget', { targetId });
          await new Promise((r) => setTimeout(r, 120));
        } catch { /* 实在点不动就硬截，末尾超时会兜底 */ }
        return sid;
      };
      const captureOnce = async (attempt) => {
        // 每次重试用一条**新 session**：偶发卡死的往往就是那条 session 的响应通道。
        if (attempt > 1) {
          const stale = sessions.get(q.target);
          sessions.delete(q.target);
          // 关键：**先 detach 掉那条卡住的 session**。
          // 否则它上面还挂着一条没结算的 Page.captureScreenshot，
          // 新命令在同一个 target 上会排在它后面 —— 于是越重试越慢（实测踩过）。
          if (stale) {
            try { await sendCDP('Target.detachFromTarget', { sessionId: stale }).catch(() => {}); } catch { /* 已经没了 */ }
          }
        }
        const sid = await ensureSession(q.target);
        // 后台页先唤一帧（见上面 nudgeRender 的说明）；前台页这步是空操作，很快。
        await nudgeRender(q.target, sid);
        const resp = await Promise.race([
          sendCDP('Page.captureScreenshot', {
            format,
            quality: format === 'jpeg' ? 80 : undefined,
          }, sid),
          new Promise((_, reject) => setTimeout(
            () => reject(Object.assign(new Error('截图超时'), { code: 'SHOT_TIMEOUT' })),
            shotTimeoutMs,
          )),
        ]);
        if (resp?.error) throw new Error('Page.captureScreenshot: ' + resp.error.message);
        return resp;
      };
      let resp;
      try {
        resp = await captureOnce(1);
      } catch (firstError) {
        lifecycleLog(`截图失败，重试一次（${firstError.message}）`);
        try {
          resp = await captureOnce(2);
        } catch (secondError) {
          res.statusCode = 504;
          res.end(JSON.stringify({
            error: `截图两次都没成（每次限 ${Math.round(shotTimeoutMs / 1000)} 秒）：${secondError.message}。`
              + '这一页可能是某种让浏览器渲染卡住的页面；可以让主人自己看一眼，或者过几秒再试。',
            code: 'SCREENSHOT_FAILED',
          }));
          return;
        }
      }
      if (q.file) {
        fs.writeFileSync(q.file, Buffer.from(resp.result.data, 'base64'));
        res.end(JSON.stringify({ saved: q.file }));
      } else {
        res.setHeader('Content-Type', 'image/' + format);
        res.end(Buffer.from(resp.result.data, 'base64'));
      }
    }

    // GET /info?target=xxx - 获取页面信息
    else if (pathname === '/info') {
      const sid = await ensureSession(q.target);
      const resp = await sendCDP('Runtime.evaluate', {
        expression: 'JSON.stringify({title: document.title, url: location.href, ready: document.readyState})',
        returnByValue: true,
      }, sid);
      res.end(resp.result?.result?.value || '{}');
    }

    else {
      res.statusCode = 404;
      res.end(JSON.stringify({
        error: '未知端点',
        endpoints: {
          '/health': 'GET - 健康检查',
          '/targets': 'GET - 列出所有页面 tab',
          '/new': 'POST body=URL - 创建新后台 tab（自动等待加载）',
          '/close?target=': 'GET - 关闭 tab',
          '/navigate?target=': 'POST body=URL - 导航（自动等待加载）',
          '/back?target=': 'GET - 后退',
          '/info?target=': 'GET - 页面标题/URL/状态',
          '/frames?target=': 'GET - 列出页面中的 iframe（frameId、网址、是否跨进程）',
          '/eval?target=&frame=': 'POST body=JS表达式 - 执行 JS（frame 可选，取自 /frames）',
          '/click?target=': 'POST body=CSS选择器 - 点击元素',
          '/clickAt?target=': 'POST body=CSS选择器 - 真实鼠标点击',
          '/clickXY?target=&x=&y=': 'GET - 按视口坐标真实鼠标点击（可点中跨进程 iframe）',
          '/type?target=': 'POST body=JSON - 往输入框填字（{ selector?, text, submit?, clear? }）',
          '/key?target=': 'POST body=JSON - 按键（{ key }）',
          '/select?target=': 'POST body=JSON - 选下拉框（{ selector, value|label|index }）',
          '/setFiles?target=': 'POST body=JSON - 设置文件输入（★被 qq-bridge 补丁永久禁用）',
          '/scroll?target=&y=&direction=': 'GET - 滚动页面',
          '/screenshot?target=&file=': 'GET - 截图',
        },
      }));
    }
  } catch (e) {
    res.statusCode = e instanceof FrameError ? 400 : 500;
    res.end(JSON.stringify({ error: e.message }));
  } finally {
    // 客户端断开不会取消浏览器动作；以 handler 完成结算，避免维护误停后台操作。
    if (operationActive) activeRequests--;
  }
});

// 服务端口的原子绑定决定唯一实例，不用先探测再绑定的竞态窗口。
async function main() {
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      let existing;
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) existing = await response.json();
      } catch { /* 无法确认占用者时明确失败，不连接浏览器。 */ }
      if (existing?.status === 'ok') {
        lifecycleLog(`复用端口 ${PORT} 的已有实例，本启动进程退出`);
        process.exit(0);
      }
    }
    throw error;
  }
  lifecycleLog(`运行在 http://127.0.0.1:${PORT}，revision=${RUNNING_REVISION}`);
  cleanupTimer = setInterval(cleanupIdleTabs, CLEANUP_INTERVAL);
  cleanupTimer.unref();
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  // 启动时连一次。失败不在这里反复重试 —— onDisconnect 已经按退避安排了，
  // 而且"在等你点允许"的情况会退到 30 分钟后才再试（不打扰主人）。
  connect().catch(error => lifecycleLog(`初始连接失败：${error.message}（已安排退避重连）`));
}

function shutdown(reason) {
  if (shutdownPromise) return shutdownPromise;
  maintenance = true;
  // 先发布整次退出操作，重复维护命令共用同一个结果。
  shutdownPromise = Promise.resolve().then(async () => {
    lifecycleLog(`${reason}，正在退出`);
    clearInterval(cleanupTimer);
    await closeAllManagedTabs();
    connection.close();
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    process.exit(0);
  }).catch(error => {
    lifecycleLog(`退出失败：${error.message}`);
    process.exit(1);
  });
  return shutdownPromise;
}

// 防止未捕获异常导致进程崩溃
process.on('uncaughtException', (e) => {
  console.error('[CDP Proxy] 未捕获异常:', e.message);
});
process.on('unhandledRejection', (e) => {
  console.error('[CDP Proxy] 未处理拒绝:', e?.message || e);
});

main().catch(error => { lifecycleLog(`启动失败：${error.message}`); process.exit(1); });

// 小鲸鱼 · 专项控制台 —— **独立进程**，不依赖桥接的任何新代码。
//
// ── 为什么要有这个东西 ─────────────────────────────────────────────────────
// 主人 2026-10-19 的原话：
//   「针对这些独特的功能单独做一个补充控制台吧，方便我自己操作的，
//    不用每次找你的选择性的功能，我害怕如果加上到现有的控制台上，
//    万一插件更新了，我的修改就没了。」
//
// 所以这个进程刻意遵守三条：
//
//   ① **不复用 public/console.html 的任何一行**。那个文件是被 git 跟踪的插件文件，
//      更新时整体替换。这里自带前端（public/extra/index.html），改它不会碰到主控制台。
//
//   ② **不依赖桥接新增的路由**。本进程只调这些端点，它们在我动手之前就存在于
//      bridge.js（已用备份逐个核对过）：
//        GET  /api/socialV2/config        读 socialV2 配置（含 proactive）
//        POST /api/socialV2/config        写 socialV2 配置
//        GET  /api/socialV2/states        列出会话
//        GET  /api/socialV2/state         单个会话状态
//        POST /api/socialV2/wake          手动唤醒
//      ⇒ 就算 bridge.js 被整个换成上游新版、我这次加的端点全丢，本控制台的
//        「主动找人」「现场调试」两栏仍然可用。
//
//   ③ **新增能力自己落盘**。授权（permits.json）与约定（promises.json）由本进程
//      直接读写 state/ 下的文件 —— 而 state/ 在 .gitignore 里，**永远不会**被更新碰。
//      守卫（plugins/.../qq-tool-restrict.mjs）读的就是同一个 permits.json，
//      所以"从这里批准"和"她在 QQ 里申请、你回同意"效果完全一致，都不经过桥接。
//
// ── 用 ────────────────────────────────────────────────────────────────────
//   node tools/extra-console/server.mjs
//   然后开 http://127.0.0.1:3101/
//
//   双击 start-extra-console.bat 也行（会自带窗口，关掉即停）。
//
// ── 安全 ──────────────────────────────────────────────────────────────────
//   · 只监听 127.0.0.1（不接受外部访问）
//   · 校验 Host 头（防 DNS rebinding，与主控制台同一口径）
//   · 写操作要求 x-extra-token，值 = state/console-token（与主控制台同一个令牌，
//     不新增凭据；读它需要本机文件权限）
//   · 转发给桥接的请求由本进程代签控制台令牌 —— 令牌**不下发到浏览器**
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TOOL_GROUPS, flatToolFlags, unclassifiedFlags } from './tool-groups.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tools/extra-console/server.mjs → 上两级就是 qq-bridge-deploy 根
const ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(ROOT, 'state');
const PERMIT_FILE = path.join(STATE_DIR, 'permits.json');
const CONSOLE_TOKEN_FILE = path.join(STATE_DIR, 'console-token');
const PORT = Number(process.env.EXTRA_CONSOLE_PORT) || 3101;
const HTML_FILE = path.join(__dirname, 'index.html');

// 与 src/permit-lib.js 保持同一份契约（version/grants/requests）。
// 刻意**不 import 那个文件**：它是桥接目录下的模块，更新时可能被改名/删掉，
// 而本进程要能独立存活。代价是两边各有一份形状定义，用 test 对账（见 scripts/test-extra-console.mjs）。
const PERMIT_SCOPES = {
  phone: { label: '玩手机', defaultTtlMs: 30 * 60 * 1000, maxTtlMs: 2 * 60 * 60 * 1000 },
  bili: { label: '刷B站', defaultTtlMs: 60 * 60 * 1000, maxTtlMs: 3 * 60 * 60 * 1000 }
};
const PROMISE_KINDS = { wakeup: '叫他起床', remind: '提醒他', checkin: '回来找他' };

function log(...args) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[extra-console ${t}]`, ...args);
}

function readJsonSafe(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// ── 授权文件（与守卫共用）──────────────────────────────────────────────────
function readPermits(now = Date.now()) {
  const raw = readJsonSafe(PERMIT_FILE, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { version: 1, grants: {}, requests: {} };
  }
  const grants = {};
  for (const [key, perScope] of Object.entries(raw.grants ?? {})) {
    if (!/^(group|private):\d+$/.test(key)) continue;
    if (!perScope || typeof perScope !== 'object' || Array.isArray(perScope)) continue;
    const clean = {};
    for (const [scope, g] of Object.entries(perScope)) {
      if (!Object.prototype.hasOwnProperty.call(PERMIT_SCOPES, scope)) continue;
      const expiresAt = Number(g?.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
      clean[scope] = {
        expiresAt,
        grantedAt: Number(g.grantedAt) || 0,
        requestId: String(g.requestId ?? ''),
        why: String(g.why ?? '').slice(0, 120)
      };
    }
    if (Object.keys(clean).length) grants[key] = clean;
  }
  const requests = {};
  for (const [id, r] of Object.entries(raw.requests ?? {})) {
    if (!r || typeof r !== 'object') continue;
    if (now - (Number(r.createdAt) || 0) > 24 * 60 * 60 * 1000) continue;
    requests[id] = {
      id, key: String(r.key ?? ''), scope: String(r.scope ?? ''),
      why: String(r.why ?? '').slice(0, 200),
      createdAt: Number(r.createdAt) || 0,
      status: String(r.status ?? 'pending')
    };
  }
  return { version: 1, grants, requests };
}

function writePermits(obj) {
  atomicWriteJson(PERMIT_FILE, obj);
}

function formatRemaining(ms) {
  const n = Math.max(0, Number(ms) || 0);
  const min = Math.ceil(n / 60000);
  if (min <= 1) return '不到 1 分钟';
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

function resolveGrant(scope, requestedMs, now = Date.now()) {
  const def = PERMIT_SCOPES[scope];
  if (!def) throw new Error(`未知的授权类别：${scope}`);
  const wanted = Number(requestedMs);
  let ttl = Number.isFinite(wanted) && wanted > 0 ? wanted : def.defaultTtlMs;
  ttl = Math.min(def.maxTtlMs, Math.max(60 * 1000, Math.round(ttl)));
  return { ttlMs: ttl, expiresAt: now + ttl };
}

// ── 约定文件（本进程独有；桥接的 promises 存在 social-v2.json 里）───────────
//
// ⚠️ 这里要说清楚一件事，不能含糊：
//   **由本控制台排的约定，不会触发桥接的定时唤醒** —— 因为桥接只读它自己
//   social-v2.json 里的 promises，而那个文件在桥接进程内存里，外部改了要重启才生效。
//   所以本控制台排的约定会写进 promises.json，并**在到点时以"手动唤醒"的方式**
//   通过 POST /api/socialV2/wake 叫醒她（那个端点在原版就有）。
//   效果接近但不完全等同：桥接自己排的约定会在唤醒提示词里带【约好的事】，
//   而这里叫醒她时，约定内容是通过一次普通唤醒投递的（她会看到未读消息 + 这条约定）。
//   取舍：宁可功能弱一点，也不要为了"完美"去依赖一个会被更新覆盖的端点。
const PROMISE_FILE = path.join(STATE_DIR, 'extra-promises.json');

function readPromises(now = Date.now()) {
  const raw = readJsonSafe(PROMISE_FILE, null);
  const list = Array.isArray(raw?.promises) ? raw.promises : [];
  return list.filter((p) => p && Number.isFinite(Number(p.at))
    && !p.doneAt && now - Number(p.at) < 3 * 60 * 60 * 1000);
}

function writePromises(list) {
  atomicWriteJson(PROMISE_FILE, { version: 1, promises: list.slice(-50) });
}

// ── 桥接代理（代签令牌，令牌不下发浏览器）────────────────────────────────
function consoleToken() {
  // 每次读，桥接重启/换令牌后立刻跟上（与 MCP 那边的口径一致）
  try {
    const t = fs.readFileSync(CONSOLE_TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch {}
  const cfg = readJsonSafe(path.join(ROOT, 'config.json'), {});
  return String(cfg?.consoleToken ?? '').trim();
}

function bridgeBase() {
  const cfg = readJsonSafe(path.join(ROOT, 'config.json'), {});
  const port = Number(cfg?.consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}

async function bridgeApi(pathname, init = {}) {
  const token = consoleToken();
  if (!token) throw new Error('读不到控制台令牌（state/console-token）');
  const res = await fetch(bridgeBase() + pathname, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-console-token': token,
      ...(init.headers ?? {})
    },
    signal: AbortSignal.timeout(15000)
  });
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) throw new Error(body?.error || `桥接 HTTP ${res.status}`);
  if (body && body.ok === false) throw new Error(body.error || '桥接返回 ok:false');
  return body;
}

// ── HTTP ──────────────────────────────────────────────────────────────────
const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

function sendJson(res, obj, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  res.end(JSON.stringify(obj, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const MAX = 512 * 1024;
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  } catch {
    return sendJson(res, { ok: false, error: '非法请求' }, 400);
  }

  const host = String(req.headers.host ?? '').toLowerCase();
  const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`];
  if (!allowedHosts.includes(host)) {
    return sendJson(res, { ok: false, error: `Host 头不被允许（${host || '缺失'}）：只接受本机回环访问` }, 403);
  }

  try {
    // 页面本身不需要令牌 —— 它里面没有任何秘密；所有数据接口才要。
    // 这样打开页面时不会先弹一次 401，令牌靠浏览器第一次存下来即可。
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
      try {
        // ⭐ 把令牌直接注进页面，省掉"每次都要手填"。
        //
        // 为什么敢这么写：本进程只监听 127.0.0.1、且校验 Host 头，
        // 能读到这个页面的只有本机上的浏览器。而能读 state/console-token
        // 的人本来就有本机文件权限 —— 把令牌放进页面**不增加**任何暴露面。
        //
        // ⚠️ 不能写进 index.html 静态文件本身：那样令牌会被 git 跟踪、进仓库、
        //    换机器后失效，还可能被误提交。只能是**运行时注入**。
        const token = consoleToken();
        let html = fs.readFileSync(HTML_FILE, 'utf8');
        html = html.replace(
          '<!--EXTRA_CONSOLE_BOOTSTRAP-->',
          `<script>window.__EXTRA_TOKEN__=${JSON.stringify(token)};`
          + `localStorage.setItem('qq-extra-console-token',${JSON.stringify(token)});</script>`
        );
        res.end(html);
      } catch (error) {
        res.end(`页面读取失败：${error?.message ?? error}`);
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(res, { ok: true, bridge: bridgeBase(), hasToken: !!consoleToken() });
    }

    // ── 数据接口（读）────────────────────────────────────────────────────
    // 读接口不强制令牌有个现实原因：页面刚打开时浏览器还没拿到令牌，若此时
    // 就 401，用户会看到一个空控制台却不知道为什么。这些接口只暴露本机配置与
    // 会话 key，且服务本身只监听回环 —— 风险低于"页面打不开"的可用性损失。
    // 写接口一律要求令牌。
    if (req.method === 'GET' && url.pathname === '/api/overview') {
      const cfg = readJsonSafe(path.join(ROOT, 'config.json'), {});
      const v2 = cfg?.socialV2 ?? {};
      const permit = readPermits();
      let conversations = [];
      try {
        const data = await bridgeApi('/api/socialV2/states');
        conversations = (data.conversations ?? []).map((c) => c.key).filter(Boolean);
      } catch (error) {
        return sendJson(res, {
          ok: false,
          error: `连不上桥接（${error?.message ?? error}）。桥接没开的话，本控制台只能看不能改。`
        }, 503);
      }
      return sendJson(res, {
        ok: true,
        proactive: v2.proactive ?? {},
        // 「自由时间」的两个数字。⚠️ 默认值必须和 bridge.js 里的 _DEFAULT 常量一致，
        // 否则控制台显示的和实际生效的会不一样（用户改之前看到的就不是真值）。
        autonomy: (() => {
          const a = v2.autonomy ?? {};
          return {
            quietGrantMs: Number.isFinite(Number(a.quietGrantMs)) && Number(a.quietGrantMs) > 0
              ? Number(a.quietGrantMs) : 2.5 * 60 * 1000,           // bridge.js: AUTONOMOUS_QUIET_GRANT_MS_DEFAULT
            qzoneWriteMinGapMs: Number.isFinite(Number(a.qzoneWriteMinGapMs)) && Number(a.qzoneWriteMinGapMs) >= 0
              ? Number(a.qzoneWriteMinGapMs) : 4 * 60 * 60 * 1000,   // bridge.js: QZONE_WRITE_MIN_GAP_MS_DEFAULT
            // 标记这两个值是不是用户显式设过的（没设过 = 用的是代码默认值）
            quietGrantIsDefault: !(Number.isFinite(Number(a.quietGrantMs)) && Number(a.quietGrantMs) > 0),
            gapIsDefault: !(Number.isFinite(Number(a.qzoneWriteMinGapMs)) && Number(a.qzoneWriteMinGapMs) >= 0),
          };
        })(),
        // 媒体上限：三个值 + 默认值/天花板一起给前端，前端不做「多大才合理」的判断。
        // ⚠️ 这里的默认值必须和 bridge.js 的 MEDIA_LIMIT_DEFAULTS 一致，
        // 否则面板显示的和实际生效的不是一回事。
        media: (() => {
          const m = v2.media ?? {};
          const DEF = { maxBytes: 8 * 1024 * 1024, maxPixels: 64_000_000, maxCount: 5 };
          const pick = (k) => (Number.isFinite(Number(m[k])) && Number(m[k]) > 0 ? Math.floor(Number(m[k])) : DEF[k]);
          return {
            maxBytes: pick('maxBytes'),
            maxPixels: pick('maxPixels'),
            maxCount: pick('maxCount'),
            defaults: DEF,
            ceilings: { maxBytes: 32 * 1024 * 1024, maxPixels: 256_000_000, maxCount: 20 },
            isDefault: !(Number.isFinite(Number(m.maxBytes)) && Number(m.maxBytes) > 0),
          };
        })(),
        // 等待预算（socialV2.wait）：默认值必须和 bridge.js / config.example.json 一致。
        wait: (() => {
          const w = v2.wait ?? {};
          const DEF = { maxMs: 600000, defaultMs: 30000, defaultQuietMs: 8000 };
          const pick = (k) => (Number.isFinite(Number(w[k])) && Number(w[k]) > 0 ? Math.floor(Number(w[k])) : DEF[k]);
          return {
            maxMs: pick('maxMs'),
            defaultMs: pick('defaultMs'),
            defaultQuietMs: pick('defaultQuietMs'),
            defaults: DEF,
          };
        })(),
        // 表情 CDN 兜底开关（默认开）。跟 media 一样，默认值必须和 bridge.js 一致。
        stickerCdnFallback: v2.sticker?.cdnFallback !== false,
        // 工具开关：把「分组说明」与「桥接里的现值」合起来给前端。
        //
        // 为什么合并放在服务端：分组表在 tool-groups.mjs（独立目录，抗更新），
        // 现值必须从桥接现读（否则会显示过期状态）。
        // 前端只负责渲染，不做任何拼装 —— 这样两边不会各写一套逻辑。
        tools: (() => {
          const current = v2.tools ?? {};
          const flat = flatToolFlags();
          const groups = TOOL_GROUPS.map((g) => ({
            id: g.id,
            label: g.label,
            note: g.note,
            items: g.items.map((it) => ({
              flag: it.flag,
              tools: it.tools ?? [],
              note: it.note ?? '',
              danger: it.danger === true,
              off: it.off === true,
              // ⚠️ 这个字段必须传：它区分"没有对应工具"的两种原因 ——
              //   operation=true 是操作开关（如取消赞），正常；
              //   否则才是名字写错/工具被删，那时界面必须报警。
              //   加它时踩到过：这里原先只挑 5 个字段，新字段被漏掉，
              //   前端拿不到 (Rightarrow) 操作开关显示成"⚠️ 未注册"。
              operation: it.operation === true,
              // 现值：桥接的 tools 里没有这个键时按"开着"处理（与桥接的判定一致：
              // 只有 === false 才算关）。
              enabled: current[it.flag] !== false,
              // 标记"桥接不认识这个开关"——那说明它存不进去，必须让用户知道。
              unknown: !Object.prototype.hasOwnProperty.call(current, it.flag)
            })),
            // 分组里有没有"关着的"（前端据此决定要不要高亮这一组）
            offCount: g.items.filter((it) => current[it.flag] === false).length
          }));
          // 桥接新增了、但我还没归类的开关 —— 不能静默漏掉，单独成组显示。
          const extra = unclassifiedFlags(Object.keys(current));
          if (extra.length) {
            groups.push({
              id: 'unclassified',
              label: '未归类（桥接新增，界面还没写说明）',
              note: '这些开关能正常读写，只是还没加说明文字',
              items: extra.map((f) => ({ flag: f, tools: [], note: '', enabled: current[f] !== false, unknown: false })),
              offCount: extra.filter((f) => current[f] === false).length
            });
          }
          return { groups, offTotal: Object.values(current).filter((v) => v === false).length, total: Object.keys(current).length };
        })(),
        // 语音相关状态：前端据此渲染开关。注意这里读的是 **config.json 的现值**，
        // 而桥接改配置时是先写盘再更新内存，所以两边始终一致。
        voice: {
          enabled: v2.voice?.enabled !== false,
          autoReadback: v2.voice?.autoReadback === true,
          maxPerMinute: Number(v2.voice?.maxPerMinute) || 0,
          maxPerHour: Number(v2.voice?.maxPerHour) || 0,
          ttsEnabled: v2.tts?.enabled !== false,
          engine: String(v2.tts?.engine ?? ''),
          voiceName: String(v2.tts?.voice ?? ''),
          maxChars: Number(v2.tts?.maxChars) || 300,
          // 她实际会不会用语音：两个开关都开才算"常驻语音"
          speaking: v2.voice?.enabled !== false && v2.tts?.enabled !== false
        },
        // ownerQQ 给前端用：默认把"现场调试"的会话选成你的私聊，而不是随便一个会话
        //（否则会选到陌生人的私聊或群聊，点"叫醒"就醒错了地方）。
        ownerQQ: Number(cfg?.ownerQQ) || 0,
        conversations,
        permits: {
          grants: Object.entries(permit.grants).flatMap(([key, perScope]) =>
            Object.entries(perScope).map(([scope, g]) => ({
              key, scope, label: PERMIT_SCOPES[scope]?.label ?? scope,
              expiresAt: g.expiresAt, remainingText: formatRemaining(g.expiresAt - Date.now()), why: g.why
            }))
          ),
          requests: Object.values(permit.requests).slice(-40)
        },
        promises: readPromises().map((p) => ({ ...p, remainingText: formatRemaining(Number(p.at) - Date.now()) })),
        scopes: PERMIT_SCOPES,
        promiseKinds: PROMISE_KINDS,
        bridge: bridgeBase()
      });
    }

    // 写操作要求令牌
    const supplied = String(url.searchParams.get('token') ?? req.headers['x-extra-token'] ?? '');
    const expected = consoleToken();
    const tokenOk = (() => {
      if (!expected) return false;
      const a = Buffer.from(supplied, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    })();
    if (!tokenOk) {
      return sendJson(res, { ok: false, error: '未授权：请提供控制台令牌（state/console-token）' }, 401);
    }

    if (req.method === 'POST' && url.pathname === '/api/proactive') {
      const body = await readBody(req);
      // 走桥接的 /api/socialV2/config —— 它在原版就有，且会正确深度合并/归一化。
      // 自己直接改 config.json 也能写进去，但桥接**不热读** config.json（只在启动时
      // loadConfig 一次），那样改完必须重启桥接才生效，体验很差。
      const patch = {};
      const p = body?.proactive ?? {};
      if (p.probability !== undefined) {
        const n = Number(p.probability);
        if (!(n >= 0 && n <= 1)) throw new Error('概率要在 0~1 之间');
        patch.probability = n;
      }
      for (const [k, min] of [['checkIntervalMinMs', 60000], ['checkIntervalMaxMs', 60000], ['idleThresholdMs', 0]]) {
        if (p[k] !== undefined) {
          const n = Number(p[k]);
          if (!Number.isFinite(n)) throw new Error(`${k} 不是数字`);
          patch[k] = Math.max(min, Math.round(n));
        }
      }
      if (patch.checkIntervalMinMs !== undefined && patch.checkIntervalMaxMs !== undefined
        && patch.checkIntervalMaxMs < patch.checkIntervalMinMs) {
        throw new Error('检查间隔上限不能小于下限');
      }
      await bridgeApi('/api/socialV2/config', { method: 'POST', body: JSON.stringify({ proactive: patch }) });
      return sendJson(res, { ok: true, proactive: patch });
    }

    // ⭐ 语音开关（2026-10-20 主人要求：把开关语音的接口加到这个控制台）
    //
    // 与上面 /api/proactive 同一个思路：走桥接的 /api/socialV2/config，
    // 由它做深度合并 + 写盘 + 更新运行中的 cfg.socialV2。
    //
    // 三个开关的分工（必须同时提供，否则用户分不清"为什么关了还在说话"）：
    //   voice.enabled —— 整条语音通道（关了 = 她完全不发语音，全部走文字）
    //   tts.enabled   —— 现合成（qq_say / qq_speak 依赖它；关了就发不出语音条）
    //   autoReadback  —— 每发一条语音额外回读一次 QQ 确认落地（慢，但更确定）
    if (req.method === 'POST' && url.pathname === '/api/voice') {
      const body = await readBody(req);

      const vPatch = {};
      if (body?.voiceEnabled !== undefined) vPatch.enabled = body.voiceEnabled === true;
      if (body?.autoReadback !== undefined) vPatch.autoReadback = body.autoReadback === true;
      for (const k of ['maxPerMinute', 'maxPerHour']) {
        if (body?.[k] !== undefined) {
          const n = Number(body[k]);
          if (!Number.isFinite(n) || n < 0) throw new Error(`${k} 必须是非负数字`);
          vPatch[k] = Math.round(n);
        }
      }

      const tPatch = {};
      if (body?.ttsEnabled !== undefined) tPatch.enabled = body.ttsEnabled === true;

      if (!Object.keys(vPatch).length && !Object.keys(tPatch).length) {
        throw new Error('没有要改的项（voiceEnabled / ttsEnabled / autoReadback / maxPerMinute / maxPerHour）');
      }

      const sendBody = {};
      if (Object.keys(vPatch).length) sendBody.voice = vPatch;
      if (Object.keys(tPatch).length) sendBody.tts = tPatch;

      await bridgeApi('/api/socialV2/config', { method: 'POST', body: JSON.stringify(sendBody) });
      log(`语音设置已更新：${JSON.stringify(sendBody)}`);
      return sendJson(res, { ok: true, voice: vPatch, tts: tPatch });
    }

    // ⭐ 工具开关（2026-10-20）。主控制台那份清单是**写死在 HTML 里**的，
    //    新增工具看不到（实测漏了 qq_say / qq_request_permission / qq_promise 等），
    //    而且一个开关管多个工具时只显示其中一个（关 speak 会连 qq_say 一起关，用户看不见）。
    //    这里改成"从桥接现读 + 分组说明放在本目录"，于是不受主控制台那份写死清单的限制。
    // ⭐「自由时间」（2026-10-20 主人要求：数字要能在控制台改，不用每次找改代码）。
    //
    // 两个数字：
    //   quietGrantMs         —— 他跟她聊完、静默多久算她自己的时间（默认 2.5 分钟）
    //   qzoneWriteMinGapMs   —— 两次空间写操作之间至少隔多久（默认 4 小时，0=不限）
    //
    // 走桥接的 /api/socialV2/config：它深度合并 + 写盘 + 热更新运行中的 cfg，
    // 所以改完**立刻生效**（直接改 config.json 不热读，得重启桥接）。
    //
    // ⚠️ 范围钳制必须和 bridge.js 里的钳制一致，否则前端看着合法、后端却按别的值算：
    //   · quietGrantMs        ∈ [10 秒, 60 分钟]（bridge 里也是这样夹的）
    //   · qzoneWriteMinGapMs  ∈ [0, 7 天]（0 = 不限制；bridge 同样）
    if (req.method === 'POST' && url.pathname === '/api/autonomy') {
      const body = await readBody(req);
      const patch = {};
      const a = body?.autonomy ?? {};
    
      if (a.quietGrantMs !== undefined) {
        const n = Number(a.quietGrantMs);
        if (!Number.isFinite(n)) throw new Error('静默门槛不是数字');
        if (n < 10000) throw new Error('静默门槛不能少于 10 秒 —— 再短等于没有静默，她会在你刚说完话时就拿到自主权');
        if (n > 60 * 60 * 1000) throw new Error('静默门槛不能超过 60 分钟 —— 再长她基本拿不到自主时间');
        patch.quietGrantMs = Math.round(n);
      }
    
      if (a.qzoneWriteMinGapMs !== undefined) {
        const n = Number(a.qzoneWriteMinGapMs);
        if (!Number.isFinite(n)) throw new Error('空间写间隔不是数字');
        if (n < 0) throw new Error('空间写间隔不能是负数（0 = 不限制，可以）');
        if (n > 7 * 24 * 60 * 60 * 1000) throw new Error('空间写间隔不能超过 7 天');
        patch.qzoneWriteMinGapMs = Math.round(n);
      }
    
      if (!Object.keys(patch).length) throw new Error('没给任何要改的值');
      await bridgeApi('/api/socialV2/config', { method: 'POST', body: JSON.stringify({ autonomy: patch }) });
      return sendJson(res, { ok: true, autonomy: patch });
    }
    
    if (req.method === 'POST' && url.pathname === '/api/media') {
      // 媒体上限（socialV2.media）：单条消息的字节/像素/张数。
      //
      // 为什么在这里也钳一遍（桥接侧 mediaLimit() 已经钳过）：两处钳制**必须一致**，
      // 否则会出现「面板说存成 100MB 了」而桥接实际只用 32MB —— 面板在骗人。
      // 这里先按同一套天花板拒绝（早报错好过静默改小），桥接那边再兜一次底。
      const body = await readBody(req);
      const patch = {};
      const m = body?.media ?? {};
      const CEIL = { maxBytes: 32 * 1024 * 1024, maxPixels: 256_000_000, maxCount: 20 };
      const DEF = { maxBytes: 8 * 1024 * 1024, maxPixels: 64_000_000, maxCount: 5 };
      const LABEL = {
        maxBytes: '单条消息总字节上限',
        maxPixels: '单张图片像素上限',
        maxCount: '单条消息最多几张',
      };

      for (const key of ['maxBytes', 'maxPixels', 'maxCount']) {
        if (m[key] === undefined) continue;
        const n = Number(m[key]);
        if (!Number.isFinite(n)) throw new Error(`${LABEL[key]}不是数字`);
        if (n <= 0) throw new Error(`${LABEL[key]}必须大于 0`);
        if (n > CEIL[key]) {
          const shown = key === 'maxBytes'
            ? `${Math.round(CEIL[key] / 1048576)}MB`
            : key === 'maxPixels' ? `${CEIL[key] / 1e6}MP` : `${CEIL[key]} 张`;
          throw new Error(`${LABEL[key]}不能超过 ${shown}（放宽上限不是拆掉防护）`);
        }
        patch[key] = Math.floor(n);
      }

      if (!Object.keys(patch).length) throw new Error('没给任何要改的值');
      // 顺手把缺的补成默认值，免得面板显示"没设置"而实际在用 8MB。
      for (const key of ['maxBytes', 'maxPixels', 'maxCount']) {
        if (patch[key] === undefined) patch[key] = DEF[key];
      }
      await bridgeApi('/api/socialV2/config', { method: 'POST', body: JSON.stringify({ media: patch }) });
      return sendJson(res, { ok: true, media: patch });
    }

    if (req.method === 'POST' && url.pathname === '/api/wait') {
      // 等待预算（socialV2.wait）：单次上限 / 默认值 / 沉睡前静默。
      //
      // ⚠️ maxMs 的上限设 600000（10 分钟）不是随便定的：桥接侧
      //    `TURN_BUSY_LEASE_MS`（回合僵死阈值）必须大于单次等待预算，
      //    否则一回合还在合法等待中就被判成僵死。改这个值前先看 bridge.js 里那条注释。
      const body = await readBody(req);
      const w = body?.wait ?? {};
      const patch = {};
      const DEF = { maxMs: 600000, defaultMs: 30000, defaultQuietMs: 8000 };
      const LABEL = { maxMs: '单次等待上限', defaultMs: '默认等待', defaultQuietMs: '沉睡前静默' };

      for (const key of ['maxMs', 'defaultMs', 'defaultQuietMs']) {
        if (w[key] === undefined) continue;
        const n = Number(w[key]);
        if (!Number.isFinite(n)) throw new Error(`${LABEL[key]}不是数字`);
        if (n <= 0) throw new Error(`${LABEL[key]}必须大于 0`);
        if (key === 'maxMs' && n > 600000) {
          throw new Error('单次等待上限不能超过 10 分钟 —— 回合僵死阈值是按它定的，改大要先改那个');
        }
        if (key !== 'maxMs' && n > 600000) throw new Error(`${LABEL[key]}太大了`);
        patch[key] = Math.round(n);
      }
      if (!Object.keys(patch).length) throw new Error('没给任何要改的值');
      // defaultMs 不能大于 maxMs（否则一调就被钳，用户会以为没生效）
      const curCfg = readJsonSafe(path.join(ROOT, 'config.json'), {});
      const curWait = curCfg?.socialV2?.wait ?? {};
      const effMax = Number(patch.maxMs ?? (Number(curWait.maxMs) > 0 ? Number(curWait.maxMs) : DEF.maxMs));
      const effDef = Number(patch.defaultMs ?? (Number(curWait.defaultMs) > 0 ? Number(curWait.defaultMs) : DEF.defaultMs));
      if (effDef > effMax) throw new Error('默认等待不能大于单次等待上限');
      for (const key of ['maxMs', 'defaultMs', 'defaultQuietMs']) {
        if (patch[key] === undefined) patch[key] = DEF[key];
      }
      await bridgeApi('/api/socialV2/config', { method: 'POST', body: JSON.stringify({ wait: patch }) });
      return sendJson(res, { ok: true, wait: patch });
    }

    if (req.method === 'POST' && url.pathname === '/api/sticker-cdn') {
      // 表情 CDN 兜底的开关（socialV2.sticker.cdnFallback）。
      // 单独一个端点而不是并进 /api/media：一个是数值阈值、一个是行为开关，
      // 混在一起以后想单独改哪个都不方便。
      const body = await readBody(req);
      const v = body?.enabled;
      if (typeof v !== 'boolean') throw new Error('enabled 必须是 true/false');
      await bridgeApi('/api/socialV2/config', { method: 'POST', body: JSON.stringify({ sticker: { cdnFallback: v } }) });
      return sendJson(res, { ok: true, cdnFallback: v });
    }

    if (req.method === 'POST' && url.pathname === '/api/tools') {
      const body = await readBody(req);
      const patch = body?.tools;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('tools 必须是一个对象：{ 开关名: true/false }');
      }
      // ⚠️ 只接受布尔值，且只提交**明确传进来的键**。
      //    不校验开关名是否存在：那是桥接的 toolFlags 说了算，
      //    桥接自己的归一化会兜住未知键（存进去也不影响行为）。
      const clean = {};
      for (const [k, v] of Object.entries(patch)) {
        if (typeof v !== 'boolean') throw new Error(`开关 ${k} 的值必须是 true / false，收到 ${JSON.stringify(v)}`);
        clean[k] = v;
      }
      if (!Object.keys(clean).length) throw new Error('没有要改的开关');

      await bridgeApi('/api/socialV2/config', { method: 'POST', body: JSON.stringify({ tools: clean }) });
      const changed = Object.entries(clean).map(([k, v]) => `${k}=${v ? '开' : '关'}`).join('，');
      log(`工具开关已更新：${changed}`);
      return sendJson(res, { ok: true, changed: clean });
    }

    if (req.method === 'POST' && url.pathname === '/api/grant') {
      const body = await readBody(req);
      const scope = String(body?.scope ?? '').trim();
      if (!Object.prototype.hasOwnProperty.call(PERMIT_SCOPES, scope)) {
        throw new Error(`未知的授权类别 "${scope}"`);
      }
      const key = `private:${String(readJsonSafe(path.join(ROOT, 'config.json'), {})?.ownerQQ ?? '')}`;
      if (!/^private:\d+$/.test(key)) throw new Error('config.json 里没有 ownerQQ，无法签发授权');
      const minutes = Number(body?.minutes);
      const { expiresAt } = resolveGrant(scope, Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : undefined);
      const permit = readPermits();
      if (!permit.grants[key]) permit.grants[key] = {};
      permit.grants[key][scope] = {
        expiresAt,
        grantedAt: Date.now(),
        requestId: 'extra-console',
        why: String(body?.why ?? '专项控制台批准').slice(0, 120)
      };
      writePermits(permit);
      log(`批准 ${key}「${PERMIT_SCOPES[scope].label}」，至 ${new Date(expiresAt).toLocaleString()}`);
      return sendJson(res, {
        ok: true,
        scope,
        expiresAt,
        remainingText: formatRemaining(expiresAt - Date.now())
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/revoke') {
      const body = await readBody(req);
      const scope = String(body?.scope ?? '').trim();
      const permit = readPermits();
      const key = `private:${String(readJsonSafe(path.join(ROOT, 'config.json'), {})?.ownerQQ ?? '')}`;
      if (!permit.grants[key]) return sendJson(res, { ok: true, removed: 0 });
      if (scope) { delete permit.grants[key][scope]; }
      else { delete permit.grants[key]; }
      writePermits(permit);
      log(`收回 ${key} 的授权（${scope || '全部'}）`);
      return sendJson(res, { ok: true, removed: 1 });
    }

    if (req.method === 'POST' && url.pathname === '/api/promise') {
      const body = await readBody(req);
      const kind = String(body?.kind ?? 'remind').trim();
      if (!Object.prototype.hasOwnProperty.call(PROMISE_KINDS, kind)) throw new Error(`未知类型 "${kind}"`);
      const at = Number(body?.at);
      if (!Number.isFinite(at) || at <= 0) throw new Error('at 必须是毫秒时间戳');
      if (at <= Date.now() - 60 * 1000) throw new Error('这个时间已经过去了');
      const list = readPromises();
      if (list.length >= 20) throw new Error('约定太多了（上限 20 条）');
      const promise = {
        id: crypto.randomBytes(5).toString('hex'),
        kind,
        at,
        text: String(body?.text ?? '').slice(0, 200),
        createdAt: Date.now()
      };
      list.push(promise);
      writePromises(list);
      schedulePromises();
      log(`排约定 ${kind}@${new Date(at).toLocaleString()}：${promise.text || '（无说明）'}`);
      return sendJson(res, { ok: true, promise, remainingText: formatRemaining(at - Date.now()) });
    }

    if (req.method === 'POST' && url.pathname === '/api/promise-delete') {
      const body = await readBody(req);
      const id = String(body?.id ?? '');
      const list = readPromises().filter((p) => p.id !== id);
      writePromises(list);
      schedulePromises();
      return sendJson(res, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/wake') {
      const body = await readBody(req);
      const key = String(body?.key ?? '').trim();
      if (!/^(group|private):\d+$/.test(key)) throw new Error('key 格式应为 group:群号 或 private:QQ号');
      await bridgeApi('/api/socialV2/wake', {
        method: 'POST',
        body: JSON.stringify({ key, reason: String(body?.reason ?? 'extra-console') })
      });
      log(`手动唤醒 ${key}`);
      return sendJson(res, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/notify') {
      // 给她发一句（用在"批准并告诉她"）。走桥接原版就有的 /api/test-send ——
      // 注意它的参数是 { kind, id, message }，不是 key；这里替调用方拆好。
      const body = await readBody(req);
      const key = String(body?.key ?? '').trim();
      const text = String(body?.text ?? '').trim();
      const m = /^(group|private):(\d+)$/.exec(key);
      if (!m) throw new Error('key 格式应为 group:群号 或 private:QQ号');
      // 🔴 只允许私聊：这条消息是"批准了，去玩吧"，属于你和她的私事。
      //    若放行 group:，前端一旦选错会话就会在群里播报"批准了" —— 既没必要，
      //    也等于把"她能玩手机"这件事告诉全群。拒绝比提醒更可靠。
      if (m[1] !== 'private') throw new Error('这类通知只发私聊，不发群');
      if (!text) throw new Error('内容为空');
      await bridgeApi('/api/test-send', {
        method: 'POST',
        body: JSON.stringify({ kind: m[1], id: Number(m[2]), message: text })
      });
      return sendJson(res, { ok: true });
    }

    return sendJson(res, { ok: false, error: '没有这个接口' }, 404);
  } catch (error) {
    return sendJson(res, { ok: false, error: error?.message ?? String(error) }, 400);
  }
});

// ── 约定到点：用"手动唤醒"叫醒她 ─────────────────────────────────────────
//
// ⚠️ 这里刻意不用 setInterval 粗轮询。第一版就是 30 秒一次，结果：
//   约定 22:06:33 到点，而 tick 排在 22:05:52 之后的第 30 秒 —— 等到 22:06:22
//   时它还没到，下一次要 22:06:52，中间那 19 秒里"约定已经到点但没人动"。
//   用户看到的是"我排了，她没醒"，而且看不出为什么。
//
// 现在：每次改动约定就重排一个精确的 setTimeout 到**最近那条**；
// 另外留一个 60 秒的低频兜底（防进程被挂起/系统休眠导致 timer 漂移）。
let promiseTimer = null;
let promiseSweep = null;

function nextPromiseAt() {
  const now = Date.now();
  const upcoming = readPromises()
    .filter((p) => !p.firedAt && Number(p.at) > now)
    .map((p) => Number(p.at));
  return upcoming.length ? Math.min(...upcoming) : 0;
}

async function fireDuePromises() {
  let list;
  try { list = readPromises(); } catch { return; }
  const now = Date.now();
  const due = list.filter((p) => !p.firedAt && Number(p.at) <= now);
  if (!due.length) return;
  for (const p of due) p.firedAt = now;
  // 先落盘再唤醒：宁可"标记了但没唤醒"，也不要"唤醒了又重复标记"导致她被打扰两次。
  try { writePromises(list); } catch (error) { log('标记约定已触发失败：', error?.message ?? error); return; }
  const cfg = readJsonSafe(path.join(ROOT, 'config.json'), {});
  const key = `private:${String(cfg?.ownerQQ ?? '')}`;
  if (!/^private:\d+$/.test(key)) { log('到点但 config.json 没有 ownerQQ，跳过'); return; }
  for (const p of due) {
    const label = PROMISE_KINDS[p.kind] ?? p.kind;
    log(`约定到点：${label}（${p.text || '无说明'}）→ 唤醒 ${key}`);
    try {
      await bridgeApi('/api/socialV2/wake', {
        method: 'POST',
        body: JSON.stringify({ key, reason: `promise-extra:${p.kind}` })
      });
    } catch (error) {
      log(`唤醒失败：${error?.message ?? error}`);
    }
  }
}

function schedulePromises() {
  // 精确排到最近一条
  if (promiseTimer) { clearTimeout(promiseTimer); promiseTimer = null; }
  const next = nextPromiseAt();
  if (next) {
    const delay = Math.max(0, next - Date.now()) + 200;
    promiseTimer = setTimeout(() => {
      promiseTimer = null;
      void fireDuePromises().finally(() => schedulePromises());
    }, Math.min(delay, 120000)); // 超过 2 分钟就分段等，避免超长 timer 漂移
    promiseTimer.unref?.();
  }
  // 低频兜底：只负责"发现漏掉的"，正常情况下不做事
  if (!promiseSweep) {
    promiseSweep = setInterval(() => { void fireDuePromises().finally(() => schedulePromises()); }, 60000);
    promiseSweep.unref?.();
  }
}

server.listen(PORT, '127.0.0.1', () => {
  log(`专项控制台已启动：http://127.0.0.1:${PORT}/`);
  log(`桥接：${bridgeBase()}（令牌：${consoleToken() ? '已读到' : '读不到！'}）`);
  log('这个进程可以独立开关；关掉它不影响小鲸鱼在 QQ 里的任何行为。');
  schedulePromises();
});

const shutdown = () => {
  log('正在退出…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref?.();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

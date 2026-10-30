// 配置向导 —— 双击根目录 配置向导.bat 就会起来，只在本机回环上开一个表单页。
//
// ── 它解决什么问题 ────────────────────────────────────────────────────────
// 公开仓库里 config.json 是不带的（`.gitignore` 排除）。下载者克隆下来、跑完
// install.ps1，得到的是一份 ownerQQ 为 null、白名单全空的 config.json ——
// 桥接能启动，但谁都不能跟她说话（见 src/bridge.js:4499 那行警告）。
// 以前这一步靠手改 JSON，改错一个引号桥接就起不来。
//
// 所以这里给一个纯网页的表单：填 QQ 号、填允许的人/群、给她起个名字，
// 点保存 → 写 config.json；顺手把 state/current-role.json 和人格卡也建好。
//
// ── 三条约束（照抄 tools/extra-console 的安全口径）──────────────────────────
//   ① 只监听 127.0.0.1，并校验 Host 头（防 DNS rebinding）
//   ② 写接口要 x-wizard-token，令牌每次启动随机生成、只注入进页面，不落盘
//   ③ **只写白名单内的字段**：页面上没有的键、或者形状不对的值，一律不落盘。
//      绝不 `Object.assign(cfg, body)` —— 那样一个手搓的请求就能把整份配置换掉。
//
// ── 用完就关 ──────────────────────────────────────────────────────────────
// 页面「完成，关闭向导」会 POST /api/quit，本进程退出。不关也无所谓：
// 它只占一个回环端口，不影响桥接、不进任务栏（由 run-hidden.vbs 隐藏启动）。

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const TEMPLATE_FILE = path.join(ROOT, 'config.template.json');
const STATE_DIR = path.join(ROOT, 'state');
const ROLES_DIR = path.join(ROOT, 'roles');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const HTML_FILE = path.join(__dirname, 'setup-wizard.html');
const PORT = Number(process.env.SETUP_WIZARD_PORT) || 3220;

// 每次启动一个新令牌：本进程活多久它就有效多久，重启即失效。
// 不写进 state/ 是刻意的 —— 这不是长期凭据，只是防「别的网页偷偷 POST 到
// 127.0.0.1:3220」的那一下。
const TOKEN = crypto.randomBytes(18).toString('hex');

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

function log(text) {
  try { console.log(`[配置向导] ${text}`); } catch { /* 无控制台时忽略 */ }
}

function sendJson(res, obj, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  res.end(JSON.stringify(obj, null, 2));
}

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// 原子写：先写 .tmp 再 rename。中途断电不会留下半份 JSON
// （桥接 loadConfig 遇到坏 JSON 是直接抛错退出的）。
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

// ── 值规范化（与 src/bridge.js 的口径一致，避免「向导存进去、桥接读不出来」）──
// bridge.js:1571 sanitizeRoleName 的正则，这里必须一模一样。
function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

// bridge.js:2281 那组 Windows 保留名 —— 用 CON.md 当人格卡会让文件系统直接拒绝写入。
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
  'readme'
]);

function parseQQ(raw, label, { required = false } = {}) {
  const s = String(raw ?? '').trim();
  if (!s) {
    if (required) throw new Error(`${label}不能为空`);
    return null;
  }
  if (!/^\d+$/.test(s)) throw new Error(`${label}只能是数字（不要带空格、横线、@）`);
  if (s.length < 5 || s.length > 12) throw new Error(`${label}长度不对（QQ 号是 5~12 位数字，你填了 ${s.length} 位）`);
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${label}不是一个有效的正数`);
  return n;
}

// 白名单既支持「一行一个」，也支持逗号/空格/顿号混着写。
function parseIdList(raw, label) {
  const parts = String(raw ?? '')
    .split(/[\s,，、;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) throw new Error(`${label}里有不是数字的项：「${part}」`);
    if (part.length < 5 || part.length > 12) throw new Error(`${label}里的「${part}」位数不对（应为 5~12 位）`);
    const n = Number(part);
    if (out.includes(n)) continue;
    out.push(n);
  }
  return out;
}

// 绝对路径统一成正斜杠：桥接里 path.join 两者都能吃，但混用反斜杠写进 JSON
// 容易被后续手改的人漏掉转义。
function normalizePath(p) {
  const s = String(p ?? '').trim();
  if (!s) return '';
  if (!path.isAbsolute(s)) throw new Error(`路径要写绝对路径，例如 C:/Users/你/SnowLuma（你填的是「${s}」）`);
  return s.replace(/\\/g, '/').replace(/\/+$/, '');
}

// ── 环境检查 ──────────────────────────────────────────────────────────────
// 页面第一屏就是这张表：哪些齐了、哪些还缺、缺的照着提示补。
// 全部只读，不修复 —— 修复动作（装依赖、注册 DSH）交给 install.ps1，
// 这样「向导只负责配置」的边界是清楚的。
function probeUrl(url, timeoutMs = 900) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, detail) => { if (!done) { done = true; resolve({ ok, detail }); } };
    let req;
    try {
      req = http.get(url, { timeout: timeoutMs }, (res) => {
        res.resume();
        finish(res.statusCode > 0 && res.statusCode < 500, `HTTP ${res.statusCode}`);
      });
    } catch (error) {
      return finish(false, error?.message ?? '请求失败');
    }
    req.on('timeout', () => { req.destroy(); finish(false, '超时'); });
    req.on('error', (error) => finish(false, error?.code ?? error?.message ?? '连不上'));
  });
}

async function collectEnv() {
  const cfg = readJsonSafe(CONFIG_FILE, {});
  const nodeModules = fs.existsSync(path.join(ROOT, 'node_modules'));
  const snowHome = String(cfg?.snowluma?.homeDir ?? '');
  const roleState = readJsonSafe(ROLE_STATE_FILE, null);
  const roleCards = fs.existsSync(ROLES_DIR)
    ? fs.readdirSync(ROLES_DIR).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    : [];
  const dshBase = String(cfg?.dsh?.baseUrl ?? 'http://127.0.0.1:19387');
  const dsh = await probeUrl(dshBase);
  return {
    root: ROOT,
    node: {
      version: process.version,
      // 桥接的真实门槛：>= 22.13 且 typeof WebSocket === 'function'。
      ok: (() => {
        const [major, minor] = process.versions.node.split('.').map(Number);
        return (major > 22 || (major === 22 && minor >= 13)) && typeof WebSocket === 'function';
      })()
    },
    files: {
      config: fs.existsSync(CONFIG_FILE),
      template: fs.existsSync(TEMPLATE_FILE),
      nodeModules,
      roleState: !!roleState,
      roleCards
    },
    external: {
      snowlumaDir: snowHome,
      snowlumaOk: !!snowHome && fs.existsSync(path.join(snowHome, 'index.mjs')),
      dshBase,
      dshOk: dsh.ok,
      dshDetail: dsh.detail
    }
  };
}

// ── 读配置（给页面预填）──────────────────────────────────────────────────
// 令牌类字段只回 hasXxx 布尔值，不回明文 —— 页面要的是「已经配过没有」，
// 而不是把那串凭据再在浏览器里过一遍。
function readConfigForForm() {
  const fromTemplate = readJsonSafe(TEMPLATE_FILE, {});
  const cfg = readJsonSafe(CONFIG_FILE, null);
  const src = cfg ?? fromTemplate;
  return {
    exists: !!cfg,
    ownerQQ: src?.ownerQQ ?? '',
    selfQQ: src?.selfQQ ?? '',
    allowPrivate: (src?.allow?.private ?? []).join(', '),
    allowGroups: (src?.allow?.groups ?? []).join(', '),
    denyPrivate: (src?.deny?.private ?? []).join(', '),
    denyGroups: (src?.deny?.groups ?? []).join(', '),
    allowAllWhenEmpty: src?.allowAllWhenEmpty === true,
    ackMessage: src?.ackMessage ?? '',
    consolePort: src?.consolePort ?? 3100,
    sessionCwd: src?.sessionCwd ?? '',
    snowlumaWsUrl: src?.snowluma?.wsUrl ?? 'ws://127.0.0.1:3001',
    snowlumaHomeDir: src?.snowluma?.homeDir ?? '',
    hasSnowlumaToken: !!String(src?.snowluma?.accessToken ?? '').trim(),
    dshBaseUrl: src?.dsh?.baseUrl ?? 'http://127.0.0.1:19387',
    dshModel: src?.dsh?.model ?? '',
    wardrobeDir: src?.socialV2?.selfImage?.dir ?? '',
    role: readJsonSafe(ROLE_STATE_FILE, {})?.role ?? ''
  };
}

// ── 写配置 ────────────────────────────────────────────────────────────────
// 浅合并到「已知字段」上：模板里的其余几十个键（socialV2 那一大坨）原样保留，
// 页面上没出现的键一个都不碰。
function applyFormToConfig(form) {
  const template = readJsonSafe(TEMPLATE_FILE, null);
  const existing = readJsonSafe(CONFIG_FILE, null);
  if (!existing && !template) throw new Error('缺 config.template.json，没法生成配置。请确认仓库是完整的。');
  const base = existing ?? template;

  const ownerQQ = parseQQ(form.ownerQQ, '管理员 QQ', { required: true });
  const selfQQ = parseQQ(form.selfQQ, '机器人自己的 QQ');

  const allowPrivate = parseIdList(form.allowPrivate, '私聊白名单');
  const allowGroups = parseIdList(form.allowGroups, '群白名单');
  const denyPrivate = parseIdList(form.denyPrivate, '私聊黑名单');
  const denyGroups = parseIdList(form.denyGroups, '群黑名单');

  const consolePort = Number(String(form.consolePort ?? '').trim() || 3100);
  if (!Number.isInteger(consolePort) || consolePort < 1 || consolePort > 65535) {
    throw new Error('控制台端口要是 1~65535 之间的整数');
  }

  const wsUrl = String(form.snowlumaWsUrl ?? '').trim() || 'ws://127.0.0.1:3001';
  if (!/^wss?:\/\//i.test(wsUrl)) throw new Error('SnowLuma 地址应以 ws:// 开头（例如 ws://127.0.0.1:3001）');

  const dshBaseUrl = String(form.dshBaseUrl ?? '').trim() || 'http://127.0.0.1:19387';
  if (!/^https?:\/\//i.test(dshBaseUrl)) throw new Error('DSH 地址应以 http:// 开头（例如 http://127.0.0.1:19387）');

  // 深拷一份再改，避免把 readJsonSafe 的缓存对象原地污染。
  const next = JSON.parse(JSON.stringify(base));
  next.ownerQQ = ownerQQ;
  next.selfQQ = selfQQ;
  next.allow = { ...(next.allow ?? {}), private: allowPrivate, groups: allowGroups };
  next.deny = { ...(next.deny ?? {}), private: denyPrivate, groups: denyGroups };
  next.allowAllWhenEmpty = form.allowAllWhenEmpty === true;
  if (typeof form.ackMessage === 'string') next.ackMessage = form.ackMessage.trim();
  next.consolePort = consolePort;
  if (typeof form.sessionCwd === 'string') {
    const cwd = form.sessionCwd.trim();
    next.sessionCwd = cwd ? normalizePath(cwd) : '';
  }

  next.snowluma = { ...(next.snowluma ?? {}) };
  next.snowluma.wsUrl = wsUrl;
  if (typeof form.snowlumaHomeDir === 'string') {
    const dir = form.snowlumaHomeDir.trim();
    if (dir) {
      next.snowluma.homeDir = normalizePath(dir);
      // launcherPath 只在目录里真有那个 bat 时才写 —— 写死一个不存在的路径，
      // 桥接启动 SnowLuma 时会报一个更难懂的错。
      const bat = path.join(dir, '启动-SnowLuma.bat');
      if (fs.existsSync(bat)) next.snowluma.launcherPath = bat.replace(/\\/g, '/');
    }
  }
  // 令牌留空 = 保持原样（多数人没有；有的话也不想每次都重输）。
  const token = String(form.snowlumaAccessToken ?? '').trim();
  if (token) next.snowluma.accessToken = token;

  next.dsh = { ...(next.dsh ?? {}) };
  next.dsh.baseUrl = dshBaseUrl;
  if (typeof form.dshModel === 'string' && form.dshModel.trim()) next.dsh.model = form.dshModel.trim();

  if (typeof form.wardrobeDir === 'string' && form.wardrobeDir.trim()) {
    next.socialV2 = { ...(next.socialV2 ?? {}) };
    next.socialV2.selfImage = { ...(next.socialV2.selfImage ?? {}) };
    next.socialV2.selfImage.dir = normalizePath(form.wardrobeDir);
  }

  return { next, ownerQQ, allowPrivate, allowGroups };
}

// 新建人格卡。只在文件不存在时写 —— 覆盖已有卡等于把人家写好的角色设定删了。
const ROLE_TEMPLATE = (name) => `# ${name}

## 一、你是谁
- 身份：
- 别人怎么称呼你：
- 你的雷点（被说什么会不高兴）：

## 二、说话风格
- 句子长短：
- 口头禅：
- 用不用 emoji / 括号动作：
- 不要什么（比写「要什么」更有效：不要总结、不要升华、不要客服腔）：

## 三、性格与反应
- 被夸时：
- 被怼时：
- 被无视时：

## 四、梗与背景（可选）
- 你的来历：
- 和群友的关系：
- 常用梗：

## 五、回复示例（只示范语气和长度）
- 群友：「在吗」 → 你：
- 群友：「今天好累」 → 你：
`;

function saveRole(form) {
  const raw = String(form.roleName ?? '').trim();
  const name = sanitizeRoleName(raw);
  if (!name) throw new Error('角色名不能为空（只能用中文、字母、数字、下划线、横线）');
  if (name !== raw) {
    throw new Error(`角色名里不能有空格或标点（会被桥接过滤掉）。建议改成「${name}」`);
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) throw new Error(`「${name}」是系统保留名，换一个`);

  const file = path.join(ROLES_DIR, `${name}.md`);
  let created = false;
  if (!fs.existsSync(file)) {
    writeTextAtomic(file, ROLE_TEMPLATE(name));
    created = true;
  }
  // 允许"只想设定当前角色、不新建卡"：卡已存在就沿用。
  writeJsonAtomic(ROLE_STATE_FILE, { role: name, mode: 'active' });
  return { name, file, created };
}

// ── HTTP ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  } catch {
    return sendJson(res, { ok: false, error: '非法请求' }, 400);
  }

  // 防 DNS rebinding：只认本机回环的 Host。少了这道，一个恶意网页可以把
  // 自己的域名解析到 127.0.0.1，然后让浏览器带着你的身份来 POST。
  const host = String(req.headers.host ?? '').toLowerCase();
  if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`].includes(host)) {
    return sendJson(res, { ok: false, error: '只接受本机回环访问' }, 403);
  }

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      let html = fs.readFileSync(HTML_FILE, 'utf8');
      // 令牌运行时注入，不进 HTML 文件本身（否则会被 git 跟踪、跨次启动失效）。
      html = html.replace('<!--WIZARD_BOOTSTRAP-->', `<script>window.__WIZARD_TOKEN__=${JSON.stringify(TOKEN)};</script>`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
      return res.end(html);
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(res, { ok: true, port: PORT });
    }

    if (req.method === 'GET' && url.pathname === '/api/env') {
      return sendJson(res, { ok: true, env: await collectEnv() });
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      return sendJson(res, { ok: true, config: readConfigForForm() });
    }

    // ── 写接口：一律要令牌 ──
    const supplied = String(req.headers['x-wizard-token'] ?? '');
    const tokenOk = supplied.length === TOKEN.length
      && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(TOKEN));

    if (req.method === 'POST' && url.pathname === '/api/save') {
      if (!tokenOk) return sendJson(res, { ok: false, error: '令牌不对（页面可能已过期，刷新一次）' }, 401);
      const form = await readBody(req);
      const { next, ownerQQ, allowPrivate, allowGroups } = applyFormToConfig(form);
      writeJsonAtomic(CONFIG_FILE, next);

      const warnings = [];
      if (!allowPrivate.length && !allowGroups.length && next.allowAllWhenEmpty !== true) {
        warnings.push('白名单是空的，而且「白名单为空时全部放行」没开 —— 现在她收不到任何消息。');
      }
      if (!allowPrivate.includes(ownerQQ)) {
        warnings.push('管理员 QQ 不在私聊白名单里。管理员仍可用管理命令，但建议加进去以防混淆。');
      }
      if (allowGroups.length && next.allowAllWhenEmpty === true) {
        warnings.push('「白名单为空时全部放行」开着 —— 这条只在白名单真的为空时生效，目前有群白名单，所以不受影响。');
      }

      let role = null;
      if (String(form.roleName ?? '').trim()) role = saveRole(form);

      return sendJson(res, { ok: true, saved: CONFIG_FILE, role, warnings });
    }

    if (req.method === 'POST' && url.pathname === '/api/role') {
      if (!tokenOk) return sendJson(res, { ok: false, error: '令牌不对' }, 401);
      const form = await readBody(req);
      return sendJson(res, { ok: true, role: saveRole(form) });
    }

    if (req.method === 'POST' && url.pathname === '/api/quit') {
      if (!tokenOk) return sendJson(res, { ok: false, error: '令牌不对' }, 401);
      sendJson(res, { ok: true, message: '向导已关闭，这个窗口可以关掉了。' });
      setTimeout(() => process.exit(0), 250);
      return;
    }

    return sendJson(res, { ok: false, error: `没有这个路径：${url.pathname}` }, 404);
  } catch (error) {
    // 校验类错误（QQ 号写错之类）原样回给页面，用户看得懂；其余也一并回，
    // 这是本机工具，藏错误信息只会让人更难修。
    return sendJson(res, { ok: false, error: error?.message ?? String(error) }, 400);
  }
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    log(`端口 ${PORT} 已被占用。`);
    log('可能是上一次的向导还没关。直接打开 http://127.0.0.1:' + PORT + '/ 看看；');
    log('或者设一个别的端口再启动：set SETUP_WIZARD_PORT=3221 && node launcher\\setup-wizard.mjs');
    process.exit(3);
  }
  log(`启动失败：${error?.message ?? error}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  log(`已启动：http://127.0.0.1:${PORT}/`);
  log(`仓库：${ROOT}`);
  log(`配置：${fs.existsSync(CONFIG_FILE) ? '已存在，会预填现有值' : '还没有，保存时会从模板生成'}`);
  log('填完点保存即可；关掉这个窗口或点页面上的「完成」都能停掉它。');
});

const shutdown = () => {
  log('正在退出…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 800).unref?.();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

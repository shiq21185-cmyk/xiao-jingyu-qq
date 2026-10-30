// 「向我申请」闸门的**桥接侧**：
//   · 保存/读取授权（state/permits.json）
//   · 判定一次申请能不能受理、该给多长时间
//
// 与守卫侧（plugins/qq-agent-presets/qq-tool-restrict.mjs）的分工：
//   **守卫是唯一的执行点**。它读同一个 permits.json，自己判断"这个会话此刻有没有
//   有效授权"。本文件只负责"把授权写进去"和"算清楚给多久"，它即使写错，最多是
//   给多/给少时间，**不可能**让一个没被同意的人拿到工具 —— 因为守卫只认文件。
//
// 为什么授权要落文件、而不是桥接内存里一个 Set：
//   守卫跑在 DSH 进程里（preset 的插件行），与桥接是两个进程。内存授权它看不见。
//   落文件 + 短缓存（守卫侧 2 秒）是唯一能跨进程又不用新增 RPC 的做法。
//
// 文件形状（契约，守卫侧按同样形状读）：
//   { "version": 1,
//     "grants": { "private:100000001": { "phone": { "expiresAt": 1792…, "grantedAt": …, "requestId": "…", "why": "…" } } },
//     "requests": { "<requestId>": {...} } }
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PERMIT_FILE_VERSION = 1;

/**
 * 需要申请的「玩的东西」。**新增一类玩具就在这里加一行**，守卫侧按 scope 判定，
 * 不用改守卫逻辑。
 *
 * scope 的两端必须对齐：桥接用它来发授权，守卫用它来判工具。
 * 守卫那边有一份 `PERMIT_TOOL_SCOPES`（工具名 → scope），由 scripts/test-permit-gate.mjs
 * 双向核对，防止两边漂移。
 */
export const PERMIT_SCOPES = Object.freeze({
  // 手机（adb 操作模拟器/备用机）：点按、滑动、截图、消消乐。
  phone: {
    label: '玩手机',
    defaultTtlMs: 30 * 60 * 1000,
    maxTtlMs: 2 * 60 * 60 * 1000,
    hint: '点手机/玩游戏这类会真的动手的事'
  },
  // 刷B站：跑一轮（起会话、花 token、可能发评论）。
  bili: {
    label: '刷B站',
    defaultTtlMs: 60 * 60 * 1000,
    maxTtlMs: 3 * 60 * 60 * 1000,
    hint: '让 B站 刷一轮，会花 token'
  }
});

export function isKnownScope(scope) {
  return Object.prototype.hasOwnProperty.call(PERMIT_SCOPES, String(scope ?? ''));
}

/** 新建一个空授权文件。 */
export function emptyPermitFile() {
  return { version: PERMIT_FILE_VERSION, grants: {}, requests: {} };
}

/** 读授权文件；坏文件/不存在都返回空表（fail-closed 由守卫负责，这里只是"没有授权"）。 */
export function readPermitFile(file, readJsonSafe, now = Date.now()) {
  let raw = null;
  try {
    raw = readJsonSafe(file);
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyPermitFile();
  const grants = {};
  for (const [key, perScope] of Object.entries(raw.grants ?? {})) {
    if (!/^(group|private):\d+$/.test(key)) continue;
    if (!perScope || typeof perScope !== 'object' || Array.isArray(perScope)) continue;
    const clean = {};
    for (const [scope, g] of Object.entries(perScope)) {
      if (!isKnownScope(scope)) continue;
      if (!g || typeof g !== 'object') continue;
      const expiresAt = Number(g.expiresAt);
      // 过期的不带出来：读到的即"现在能用的"，避免调用方忘了再判一次时间。
      // （守卫侧会自己再判一遍 expiresAt，两侧都不依赖对方。）
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
    requests[id] = {
      id,
      key: String(r.key ?? ''),
      scope: String(r.scope ?? ''),
      why: String(r.why ?? '').slice(0, 200),
      createdAt: Number(r.createdAt) || 0,
      status: String(r.status ?? 'pending')
    };
  }
  return { version: PERMIT_FILE_VERSION, grants, requests };
}

/** 清理掉过期授权与陈旧申请记录，返回新对象（不改入参）。 */
export function prunePermits(file, now = Date.now()) {
  const grants = {};
  for (const [key, perScope] of Object.entries(file?.grants ?? {})) {
    const live = {};
    for (const [scope, g] of Object.entries(perScope ?? {})) {
      if (Number(g?.expiresAt) > now) live[scope] = g;
    }
    if (Object.keys(live).length) grants[key] = live;
  }
  const requests = {};
  const keepMs = 24 * 60 * 60 * 1000;
  for (const [id, r] of Object.entries(file?.requests ?? {})) {
    if (now - Number(r?.createdAt ?? 0) < keepMs) requests[id] = r;
  }
  return { version: PERMIT_FILE_VERSION, grants, requests };
}

/** 该会话此刻对某 scope 的有效授权（没有则 null）。 */
export function activeGrant(file, key, scope, now = Date.now()) {
  const g = file?.grants?.[String(key)]?.[String(scope)];
  if (!g) return null;
  return Number(g.expiresAt) > now ? g : null;
}

/**
 * 算这次该批多久。
 * @param {string} scope
 * @param {{requestedMs?:number, now?:number}} [opts]
 * @returns {{ttlMs:number, expiresAt:number}}
 */
export function resolveGrant(scope, opts = {}) {
  const def = PERMIT_SCOPES[String(scope)];
  if (!def) throw new Error(`未知的授权类别：${scope}`);
  const now = Number(opts.now) || Date.now();
  const wanted = Number(opts.requestedMs);
  let ttl = Number.isFinite(wanted) && wanted > 0 ? wanted : def.defaultTtlMs;
  ttl = Math.min(def.maxTtlMs, Math.max(60 * 1000, Math.round(ttl)));
  return { ttlMs: ttl, expiresAt: now + ttl };
}

/** 生成申请单。 */
export function createRequest({ key, scope, why, now = Date.now() }) {
  if (!isKnownScope(scope)) throw new Error(`未知的授权类别：${scope}`);
  return {
    id: crypto.randomBytes(6).toString('hex'),
    key: String(key),
    scope: String(scope),
    why: String(why ?? '').slice(0, 200),
    createdAt: now,
    status: 'pending'
  };
}

/** 人类可读的剩余时间。 */
export function formatRemaining(ms) {
  const n = Math.max(0, Number(ms) || 0);
  const min = Math.ceil(n / 60000);
  if (min <= 1) return '不到 1 分钟';
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

export function permitFilePath(root) {
  return path.join(root, 'state', 'permits.json');
}

/** 原子写。与 bridge.js 的 atomicWriteJson 同款（这里独立一份，避免循环依赖）。 */
export function writePermitFile(file, obj) {
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

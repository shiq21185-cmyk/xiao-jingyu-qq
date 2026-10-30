// 只读 HTTP(S) 安全抓取工具：供 qq-bridge / MCP 共用。
// 设计目标与 mcp-web-search-safe 一致：
// - 仅 http/https
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址
// - 域名先 DNS 解析并检查全部解析结果，避免 DNS rebinding
// - 手动跟随重定向，每一跳重新校验
// - 响应体限量读取，每次请求有包含响应体的总时限
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';

const dnsLookup = dns.promises.lookup;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  // 兼容 ::ffff:0:7f00:1、::ffff:0:c0a8:101、::c0a8:101 等非规范 IPv4-mapped/compatible 写法。
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  // NAT64 前缀（64:ff9b::/96 与 64:ff9b:1::/48）内嵌 IPv4，例如 64:ff9b::c0a8:101 -> 192.168.1.1
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

/**
 * 198.18.0.0/15：RFC 2544 留给网络设备做基准测试的保留段，真实公网服务不会用。
 * 但 FlClash / Clash.Meta 这类 **TUN + fake-ip** 代理会把*所有*域名解析成 198.18.0.x。
 *
 * 一律当内网拦掉的后果（本机实测）：代理一开，QQ 表情包取不到、收别人的图片失败、
 * 网页读不了、qq_send_file 下载远程文件全挂 —— 全是「域名解析到内网/本机地址，已阻止」。
 * 而且 fake-ip 模式下我们拿到的本来就是代理伪造的地址，这一层 DNS 防护此时已经失明，
 * 它拦住的只是功能，不是攻击面。
 *
 * 所以这一段改成可配置：**默认放行**（命中时在 resolveSafeAddresses 里打一条日志）；
 * 想恢复严格拦截就把环境变量 QQ_BRIDGE_ALLOW_FAKE_IP 设成 0/false/off。
 * 其余内网段（10./127./0./169.254./172.16-31./192.168./100.64-127./
 * 192.0.0./>=224 以及各 IPv6 段）一字不动。
 */
const ALLOW_FAKE_IP_RANGE = !/^(0|false|no|off)$/i.test(
  String(process.env.QQ_BRIDGE_ALLOW_FAKE_IP ?? '1').trim(),
);

// 代理常开时每个请求都会命中这个分支；不节流的话守护窗口会被刷满。
// 同一主机 10 分钟只提示一次，够用来判断"是不是它在起作用"，又不会淹掉别的日志。
const FAKE_IP_WARN_INTERVAL_MS = 10 * 60 * 1000;
const fakeIpWarnedAt = new Map();
function warnFakeIpOnce(host, count) {
  const now = Date.now();
  const last = fakeIpWarnedAt.get(host) ?? 0;
  if (now - last < FAKE_IP_WARN_INTERVAL_MS) return;
  fakeIpWarnedAt.set(host, now);
  // 表本身也要有上限，别让它无限长大（正常用不了几十个域名）。
  if (fakeIpWarnedAt.size > 200) {
    for (const [k, t] of fakeIpWarnedAt) if (now - t > FAKE_IP_WARN_INTERVAL_MS) fakeIpWarnedAt.delete(k);
  }
  console.warn(
    `[safe-fetch] ${host} 被解析到代理假地址段 198.18.0.0/15（${count} 个），已按`
    + ` QQ_BRIDGE_ALLOW_FAKE_IP 放行 —— 本机代理开着 TUN + fake-ip；要恢复严格拦截把它设成 0`,
  );
}

export function isFakeIpRange(ip) {
  const parts = String(ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return false;
  return parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19;
}

export function isPrivateIp(ip) {
  let h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const family = net.isIP(h);
  // DNS 返回值也必须是有效 IP；不能把非法地址当成公网地址。
  if (!family || h.includes('%')) return true;
  if (family === 6) h = new URL(`http://[${h}]/`).hostname.slice(1, -1);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (isFakeIpRange(h)) return !ALLOW_FAKE_IP_RANGE;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    // 本地 NAT64 前缀的 IPv4 位布局不等同 /96；整个本地前缀均不可供公网抓取。
    if (h.startsWith('64:ff9b:1:')) return true;
    const embedded = parseEmbeddedIpv4(h);
    if (embedded) return isPrivateIp(embedded);
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }

  return true;
}

/**
 * 按「该先试哪个」排好地址：**IPv4 优先，两族交替**。
 *
 * 为什么不能只取第一个（实测踩过）：`dns.lookup` 的返回顺序是**轮转/不确定**的，
 * 而本机常常只有 IPv4 出口。QQ 的表情 CDN（`gxh.vip.qq.com` / `p.qpic.cn` /
 * `multimedia.nt.qq.com.cn`）和 `raw.githubusercontent.com` 都同时有 AAAA/A 记录 ——
 * 抢到第一个 AAAA 的那次请求会一路连到 20 秒超时，其余请求正常。
 * 于是表现为「**部分**表情包/图片/网页时好时坏」，重试一次往往就好了，极难归因。
 *
 * 交替排布而不是「v4 全放前、v6 全放后」：万一 v4 那一批全坏了，还能马上试 v6；
 * v6-only 的主机也能在第一次就命中。
 */
function orderAddresses(addresses) {
  const v4 = addresses.filter((item) => Number(item?.family) === 4).map((item) => item.address);
  const v6 = addresses.filter((item) => Number(item?.family) === 6).map((item) => item.address);
  const ordered = [];
  const max = Math.max(v4.length, v6.length);
  for (let i = 0; i < max; i += 1) {
    if (v4[i]) ordered.push(v4[i]);
    if (v6[i]) ordered.push(v6[i]);
  }
  return ordered;
}

/**
 * 解析主机名并校验**全部**解析结果，返回可尝试的地址列表（IPv4 优先）。
 *
 * 只校验第一个是漏洞：攻击者可以让 DNS 同时返回一个公网地址和一个内网地址，
 * 我们校验了公网的、实际却连了内网的。所以这里逐个 `isPrivateIp`，一个不合格就整条拒绝。
 * @returns {Promise<string[]>} 已按尝试顺序排列的地址
 */
export async function resolveSafeAddresses(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) throw new Error('主机名为空');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return [h];
  }
  let addresses;
  try {
    addresses = await withTimeout(dnsLookup(h, { all: true, verbatim: true }), 5000, `DNS 解析 ${h}`);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  let fakeIpCount = 0;
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error('域名解析到内网/本机地址，已阻止');
    }
    if (ALLOW_FAKE_IP_RANGE && isFakeIpRange(address)) fakeIpCount += 1;
  }
  if (fakeIpCount > 0) warnFakeIpOnce(h, fakeIpCount);
  const ordered = orderAddresses(addresses);
  return ordered.length ? ordered : [addresses[0].address];
}

/** 解析出「首选」地址（保留给只需要一个地址的老调用方）。 */
export async function resolveSafeHost(hostname) {
  const [first] = await resolveSafeAddresses(hostname);
  return first;
}

export async function validateFetchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const addresses = await resolveSafeAddresses(url.hostname);
  return { url, ip: addresses[0], addresses };
}

const REQUEST_TIMEOUT_MS = 20000;
// 多地址时的单次预算：够连上 + 拿到响应头，又不至于在坏地址上白等太久。
const ATTEMPT_TIMEOUT_MS = 8000;
// 最多试几个地址。别设太大：地址多说明这个域名有一堆出口，试 4 个已经够绕过单个坏地址。
const MAX_ADDRESS_ATTEMPTS = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function validateLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须为正整数`);
}

// 使用已校验的 IP 发起请求，保留原始 Host/SNI，禁止重新解析 DNS。
// 总时限包含 TCP/TLS、响应头和响应体；仅 socket idle timeout 无法阻止慢速滴流。
// budgetMs 由调用方给：单地址时用满 REQUEST_TIMEOUT_MS（慢速滴流要等得住），
// 多地址时用 ATTEMPT_TIMEOUT_MS（坏地址要早点放弃、换下一个）。
function requestOnce(url, ip, limit, binary = false, budgetMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let response;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      const error = new Error(`请求超时：${url.hostname}`);
      error.retryable = true; // 超时是「换地址再试」的典型信号
      finish(error);
      req?.destroy(error);
      response?.destroy();
    }, budgetMs);
    const mod = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    try {
      req = mod.request({
        hostname: ip,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          host: url.host,
          'user-agent': 'Mozilla/5.0',
          accept: binary ? 'image/*,*/*;q=0.8' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9',
          // 明确声明不接受压缩：本模块直接按 UTF-8 StringDecoder 切正文，不解析
          // Content-Encoding。若不声明，Node 的 http 模块不会自动解压，gzip 字节流
          // 会被当作文本解码成乱码（实测 b23.tv / 多数站点默认返回 gzip）。
          'accept-encoding': 'identity',
        },
        servername: url.protocol === 'https:' && !net.isIP(hostname) ? hostname : undefined,
        rejectUnauthorized: url.protocol === 'https:',
        // socket 空闲超时跟总预算走：否则多地址时的单次预算形同虚设（socket 还按 20s 等）。
        timeout: budgetMs,
      }, (res) => {
        response = res;
        res.on('error', (error) => finish(error));
        res.on('aborted', () => finish(new Error('响应体读取中断')));
        res.on('close', () => {
          if (!res.complete) finish(new Error('响应体读取中断'));
        });
        if (settled) { res.destroy(); return; }
        const statusCode = res.statusCode || 0;
        if (REDIRECT_STATUSES.has(statusCode)) {
          finish(null, { statusCode, redirect: String(res.headers.location || '') });
          // 不下载重定向正文：攻击者可以发送无限正文消耗连接和带宽。
          res.destroy();
          return;
        }
        const chunks = [];
        // 站点可能无视 accept-encoding: identity 照样返回 gzip/br/deflate（实测 b23.tv、
        // bilibili 如此）。若不解压，StringDecoder 会把压缩字节按 UTF-8 解成乱码，
        // 于是「能连上但读不出内容」。这里按 Content-Encoding 建解压流，文本走解压后
        // 的字节再交给 StringDecoder。
        const encoding = String(res.headers['content-encoding'] || '').trim().toLowerCase();
        // `Content-Encoding: deflate` 按 RFC 是 zlib 包装流，但现实里大量服务端（实测
        // B 站弹幕接口 api.bilibili.com/x/v1/dm/list.so）发的是 **裸 deflate**（首字节
        // 0x8c 而非 0x78），用 createInflate 会报「incorrect header check」。所以 deflate
        // 先挂起，等第一个数据块到了按 zlib 头校验再决定用 Inflate 还是 InflateRaw。
        let unzip = null;
        let deflatePending = false;
        // 只在 attachUnzip 定义之前记下编码类型，解压流本身在 attachUnzip 之后创建：
        // 直接把 createGunzip() 赋给 unzip 而不挂 data/error 处理器，可读侧永远不会被消费，
        // 写入侧很快触到 highWaterMark 反压，res 随之停止流动 —— 表现为「连得上但 20 秒超时」。
        let zipKind = null;
        if (!binary) {
          if (encoding === 'gzip' || encoding === 'x-gzip') zipKind = 'gzip';
          else if (encoding === 'br') zipKind = 'br';
          else if (encoding === 'deflate') deflatePending = true;
        }
        const decoder = binary ? null : new StringDecoder('utf8');
        let size = 0;
        const appendText = (text) => {
          const points = Array.from(text);
          const remaining = limit - size;
          chunks.push(points.slice(0, remaining).join(''));
          size += Math.min(points.length, remaining);
          if (size >= limit) {
            finish(null, { statusCode, body: chunks.join(''), truncated: true });
            res.destroy();
          }
        };
        // 解压流建立后，解压出的字节统一走这里（res 的原始字节不再直接喂 decoder）。
        const attachUnzip = (stream, label) => {
          unzip = stream;
          unzip.on('data', (chunk) => {
            if (settled) return;
            appendText(decoder.write(chunk));
          });
          unzip.on('error', (error) => {
            finish(new Error(`响应体解压失败（${label}）：${error?.message ?? error}`));
            res.destroy();
          });
        };
        const normalizeDeflate = (chunk) => {
          // zlib 头：CMF 低 4 位为 8(DEFLATE)，且 CMF*256+FLG 能被 31 整除。
          const hasZlibHeader = chunk.length >= 2
            && (chunk[0] & 0x0f) === 8
            && (((chunk[0] << 8) + chunk[1]) % 31) === 0;
          return hasZlibHeader ? 'deflate' : 'deflate-raw';
        };
        if (zipKind === 'gzip') attachUnzip(zlib.createGunzip(), 'gzip');
        else if (zipKind === 'br') attachUnzip(zlib.createBrotliDecompress(), 'br');
        res.on('data', (chunk) => {
          if (settled) return;
          if (binary) {
            size += chunk.length;
            if (size > limit) {
              finish(new Error(`图片超过大小限制（${limit} 字节）`));
              res.destroy();
              return;
            }
            chunks.push(chunk);
            return;
          }
          if (deflatePending) {
            deflatePending = false;
            const kind = normalizeDeflate(chunk);
            attachUnzip(kind === 'deflate-raw' ? zlib.createInflateRaw() : zlib.createInflate(), kind);
          }
          if (unzip) unzip.write(chunk);
          else appendText(decoder.write(chunk));
        });
        res.on('end', () => {
          if (settled) return;
          if (binary) { finish(null, { statusCode, buffer: Buffer.concat(chunks) }); return; }
          if (deflatePending) {
            // 空响应体：没有数据块可用来判定，按 zlib 包装的默认语义收尾即可。
            deflatePending = false;
            attachUnzip(zlib.createInflate(), 'deflate');
          }
          if (unzip) {
            // 解压流可能还没 flush 完；等它的 end 再收尾，否则会截断正文。
            unzip.on('end', () => {
              if (settled) return;
              appendText(decoder.end());
              finish(null, { statusCode, body: chunks.join(''), truncated: false });
            });
            unzip.end();
          } else {
            appendText(decoder.end());
            finish(null, { statusCode, body: chunks.join(''), truncated: false });
          }
        });
      });
      req.on('timeout', () => {
        const error = new Error(`请求超时：${url.hostname}`);
        error.retryable = true; // 同上：超时值得换地址再试
        finish(error);
        req.destroy(error);
        response?.destroy();
      });
      req.on('error', (error) => finish(error));
      req.end();
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

/**
 * 依次尝试已校验的地址（IPv4 优先，见 orderAddresses）。
 *
 * 为什么要有这一层：
 *   · **单地址**时沿用「整个 20 秒总预算」—— 对方慢慢滴流也要等得住，不能提前放弃；
 *   · **多地址**时才启用单次预算 + 失败切换 —— 第一个地址是坏 IPv6 的话不再白等 20 秒。
 * 只换**连接目标**，Host / SNI / path 全不变（同一个站点，同一个证书）。
 * 指向内网/本机的错误**不重试**（那是策略拒绝，换地址也还是拒绝，重试只会拖时间）。
 */
async function requestWithFailover(url, addresses, limit, binary = false) {
  const list = (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean);
  if (!list.length) throw new Error(`没有可用地址：${url.hostname}`);
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const attempts = Math.min(list.length, MAX_ADDRESS_ATTEMPTS);
  let lastError = null;
  let tried = 0;
  for (let i = 0; i < attempts; i += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 250) break; // 总预算见底，别开新的一次
    const budget = list.length === 1 ? REQUEST_TIMEOUT_MS : Math.min(ATTEMPT_TIMEOUT_MS, remaining);
    tried += 1;
    try {
      return await requestOnce(url, list[i], limit, binary, budget);
    } catch (error) {
      lastError = error;
      // 策略类错误（解析到内网、URL 非法）换地址也没用，直接抛。
      if (!error?.retryable && !isRetryableError(error)) throw error;
    }
  }
  if (lastError && tried > 1) {
    lastError.message = `${lastError.message}（已尝试 ${tried} 个地址）`;
  }
  throw lastError ?? new Error(`请求失败：${url.hostname}`);
}

/** 哪些错误值得换地址重试：连接层失败（连不上/被重置/超时），而不是「对方明确拒绝」。 */
function isRetryableError(error) {
  const code = String(error?.code ?? '');
  return [
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH',
    'EAI_AGAIN', 'EPIPE', 'ENETDOWN', 'EHOSTDOWN', 'CERT_HAS_EXPIRED',
  ].includes(code) || /超时|中断|socket hang up|connect/i.test(String(error?.message ?? ''));
}

export async function safeFetch(urlString, maxChars = 50000) {
  validateLimit(maxChars, 'maxChars');
  const MAX_REDIRECTS = 5;
  let { url, addresses } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestWithFailover(url, addresses, maxChars);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, addresses } = await validateFetchUrl(next));
      continue;
    }
    const body = result.body || '';
    return {
      url: url.toString(),
      statusCode: result.statusCode,
      truncated: result.truncated,
      body,
    };
  }
  throw new Error('重定向次数过多，已停止');
}

/** 仅接受 DSH 支持的四种图片格式：PNG/JPEG/GIF/WebP。 */
export function looksLikeImageBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return true;
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────
// 任意文件下载（流式写盘）
//
// 和 safeFetchBuffer 的区别只有一个：**不校验内容是图片**，而且不在内存里
// 攒整份 —— 直接边收边写盘。这是「联网下载一个文件再发到 QQ」用的那条路。
//
// 复用的仍然是通过 SSRF 校验的 IP 直连（validateFetchUrl 已逐个查过解析结果），
// 所以这里看起来「手写了一份 request」并不是重复：requestOnce 是 buffer 版，
// 4 GiB 上限下不能拿它接大文件（内存会炸）。
// ─────────────────────────────────────────────────────────────

function removeQuietly(filePath) {
  try { fs.unlinkSync(filePath); } catch { /* 文件可能还没建出来，忽略 */ }
}

/** 单地址：GET 一个 URL，流式写到 destPath。成功保留文件，其余情况删掉半成品。 */
function streamOnce(url, ip, destPath, limit, budgetMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    // 写文件流**延迟到确认 2xx 之后再建**：重定向和 4xx/5xx 根本不该在磁盘上
    // 留下一个空文件，而 Windows 上"先建后删"很容易撞到文件还开着删不掉。
    let out = null;
    let resRef = null;
    let timer = null;
    const mod = url.protocol === 'https:' ? https : http;

    /**
     * 关掉写文件流，并在它真正 close 之后再删磁盘上的半成品。
     *
     * ⚠️ 必须**等 close 才删**：streamWithFailover 会拿同一个 destPath 再试一次，
     *    如果 unlink 还悬着，可能把下一次刚写出来的文件删掉。
     *    所以这个函数返回 Promise，finish 会等它完成才 reject。
     */
    function dropPartialFile() {
      // 先把响应体掐掉，免得它继续往一个已经销毁的写流里灌数据。
      if (resRef) {
        const incoming = resRef;
        resRef = null;
        try { incoming.unpipe(); } catch { /* 没在 pipe */ }
        try { incoming.destroy(); } catch { /* 已断开 */ }
      }
      const stream = out;
      out = null;
      if (!stream) {
        removeQuietly(destPath);
        return Promise.resolve();
      }
      return new Promise((done) => {
        let closed = false;
        const settle = () => {
          if (closed) return;
          closed = true;
          removeQuietly(destPath);
          done();
        };
        stream.once('close', settle);
        try { stream.destroy(); } catch { settle(); }
        // 兜底：万一 'close' 已经错过（或这版 Node 的行为变了），也不能让整次下载
        // 永远挂在这儿 —— 上层是 HTTP 请求，挂住就等于她把话卡死。2 秒足够 destroy 收尾。
        setTimeout(settle, 2000).unref?.();
      });
    }

    function finish(error, result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        // 等半成品删干净再 reject，避免下一次重试写出来的文件被这次 unlink 掉。
        void dropPartialFile().then(() => reject(error));
        return;
      }
      if (result && (result.statusCode < 200 || result.statusCode >= 300)) {
        void dropPartialFile().then(() => resolve(result));
        return;
      }
      resolve(result);
    }

    timer = setTimeout(() => {
      const error = new Error(`下载超时：${url.hostname}`);
      error.retryable = true;
      try { req.destroy(); } catch { /* 已断开 */ }
      finish(error);
    }, budgetMs);

    let req;
    try {
      req = mod.request({
        hostname: ip,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          host: url.host,
          'user-agent': 'Mozilla/5.0',
          accept: '*/*',
          'accept-language': 'zh-CN,zh;q=0.9',
          'accept-encoding': 'identity',
        },
        servername: url.protocol === 'https:' && !net.isIP(url.hostname) ? url.hostname : undefined,
        rejectUnauthorized: url.protocol === 'https:',
        timeout: budgetMs,
      }, (res) => {
        const statusCode = res.statusCode ?? 0;
        if (REDIRECT_STATUSES.has(statusCode)) {
          const redirect = res.headers.location ? String(res.headers.location) : '';
          res.resume();
          finish(null, { statusCode, redirect });
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          finish(new Error(`下载失败：HTTP ${statusCode}`));
          return;
        }
        // 服务端明说了多大：超限就直接掐，不用白下一遍。
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > limit) {
          res.resume();
          try { req.destroy(); } catch { /* 已断开 */ }
          finish(new Error(`文件超过大小限制（声明 ${declared} 字节，上限 ${limit} 字节）`));
          return;
        }
        out = fs.createWriteStream(destPath);
        resRef = res;
        out.on('error', (error) => finish(error));
        out.on('finish', () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({ statusCode, redirect: '', bytes: size });
        });
        // ⚠️ 先 pipe 再挂 'data' 计数：反过来写会先把响应流切成 flowing 模式，
        //    虽然同一 tick 内立刻 pipe 实测也不会丢字节，但这种"靠时序不出错"的写法
        //    以后谁在中间插一行就真丢数据了。pipe 先 → 流已经在流动，计数只是旁听。
        res.pipe(out);
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > limit) {
            try { req.destroy(); } catch { /* 已断开 */ }
            finish(new Error(`文件超过大小限制（${limit} 字节）`));
          }
        });
        res.on('aborted', () => finish(new Error(`下载中断：${url.hostname}`)));
        res.on('error', (error) => finish(error));
      });
    } catch (error) {
      finish(error);
      return;
    }

    req.on('error', (error) => finish(error));
    req.end();
  });
}

/** 多地址失败切换（只对可重试的连接类错误换地址）。 */
async function streamWithFailover(url, addresses, destPath, limit) {
  const list = (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean);
  if (!list.length) throw new Error(`没有可用地址：${url.hostname}`);
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const attempts = Math.min(list.length, MAX_ADDRESS_ATTEMPTS);
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const budget = list.length === 1 ? REQUEST_TIMEOUT_MS : Math.min(ATTEMPT_TIMEOUT_MS, remaining);
    try {
      return await streamOnce(url, list[i], destPath, limit, budget);
    } catch (error) {
      lastError = error;
      if (!error?.retryable && !isRetryableError(error)) throw error;
    }
  }
  throw lastError ?? new Error(`下载失败：${url.hostname}`);
}

/**
 * 把一个 URL 下载到本地文件（流式）。带 SSRF 防护、限制大小、跟随最多 5 次重定向。
 * 成功返回 { url, statusCode, bytes }，失败抛错并清理半成品文件。
 */
export async function downloadToFile(urlString, destPath, maxBytes = 200 * 1024 * 1024) {
  validateLimit(maxBytes, 'maxBytes');
  if (!destPath || typeof destPath !== 'string') throw new Error('destPath 不能为空');
  const MAX_REDIRECTS = 5;
  let { url, addresses } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await streamWithFailover(url, addresses, destPath, maxBytes);
    if (REDIRECT_STATUSES.has(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      ({ url, addresses } = await validateFetchUrl(new URL(result.redirect, url).toString()));
      continue;
    }
    return { url: url.toString(), statusCode: result.statusCode, bytes: result.bytes };
  }
  throw new Error('重定向次数过多，已停止');
}

/** 抓取图片字节并返回 Buffer（带 SSRF 防护，且校验确实为图片）。 */
export async function safeFetchBuffer(urlString, maxBytes = 4 * 1024 * 1024) {
  validateLimit(maxBytes, 'maxBytes');
  const MAX_REDIRECTS = 5;
  let { url, addresses } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestWithFailover(url, addresses, maxBytes, true);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, addresses } = await validateFetchUrl(next));
      continue;
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`图片抓取失败：HTTP ${result.statusCode}`);
    }
    if (!looksLikeImageBuffer(result.buffer)) {
      throw new Error(`抓取内容不是有效图片（PNG/JPEG/GIF/WebP）`);
    }
    return { url: url.toString(), statusCode: result.statusCode, buffer: result.buffer };
  }
  throw new Error('重定向次数过多，已停止');
}

#!/usr/bin/env node
// qq-memory-rollover —— 针对「私人聊天」的每日记忆整理守护脚本（不修改 bridge.js 核心）。
// 详见部署时同目录说明。工作区暂存版，逻辑与最终版一致。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { NodeApiClient, unwrap, createTurnCollector } from '../../src/dsh-client.js';
import { injectIndexIntoText, selectIndexItems, parseItemLine } from './memory-index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(ROOT, 'state');
const ROLES_DIR = path.join(ROOT, 'roles');
const DAILY_MEMORY_FILE = path.join(STATE_DIR, 'daily-memory.json');
const CONSOLE_TOKEN_FILE = path.join(STATE_DIR, 'console-token');
// 通话逐字稿（每通电话一份 JSON，由 tools/call/call_sidecar.py 在挂断时写入）。
// 为什么要有这一层：QQ 语音通话**不产生任何 QQ 消息**，messages.db 里没有它的影子，
// 所以光读数据库的整理脚本永远记不住电话里说过什么（主人 2026-10-25 明确要求补上）。
// sidecar 只负责落"原材料"，提炼进长期记忆仍然只由本脚本写 —— 两边都写会互相覆盖。
const CALL_LOG_FALLBACK_DIR = path.join(STATE_DIR, 'call-logs');
// 逐字稿目录由 config.json 的 call.transcriptDir 决定 —— sidecar（tools/call/
// call_sidecar.py）读的是同一份配置。2026-10-29 起它从仓库内的 state/call-logs/
// 搬到主人看得见的 `小鲸鱼的语音/通话逐字稿/`（跟通话录音并排）。
// 为什么做成函数而不是常量：配置改了不用重启插件；配置缺了也不会崩，退回老位置。
function callLogDir() {
  try {
    const p = String(readConfig()?.call?.transcriptDir ?? '').trim();
    if (p) return p;
  } catch { /* 读不到配置就用老位置 */ }
  return CALL_LOG_FALLBACK_DIR;
}
// 她亲口说出去的语音原文（一天一个 jsonl，由 bridge.js 的 appendSentVoiceLog 写）。
// 为什么要有它：语音条的消息体只有一段 record，正文是空的 ⇒ messages.db 里那条
// 记录看不到她说了什么，整理出来的逐字稿里她的那一半永远只是 `[语音 5.2s]`。
// 自从她开始大量用语音回话（2026-10-28 身体接上之后尤其明显），这个洞会让记忆里
// 只剩"主人说了什么"，完全没有"她怎么回的"。这里补上她的那一半。
// 与 CALL_LOG_DIR 同一套思路：旁注只落原材料，提炼仍然只由本脚本写。
const SENT_VOICE_DIR = path.join(STATE_DIR, 'sent-voice-logs');

const SLEEP_MS = 30 * 60 * 1000;
// 每会话每天最多几条记忆（2026-10-28 傍晚 3 → 5，同晚又提到 15）。
//
// ⚠️ 提到 15 之所以安全，**完全依赖「双档」**（见下面 MAX_ITEM_DETAIL_CHARS）：
//    每条记忆有两个字段 —— `text`（短要点，进索引）和 `detail`（详细，只进归档）。
//    索引只读 `text`，所以条数变多**不会**多占每轮上下文；归档才是变厚的那个，
//    而归档只在 qq_memory_query 被调用时才进上下文。
//    如果哪天把 detail 也塞进索引行，这个 15 就会立刻把角色卡撑爆（见
//    memory-index.mjs 的 INDEX_MAX_CHARS 注释里那次真实事故）。
// 索引本身不是按条数、是按**字符预算**裁的（INDEX_MAX_CHARS 1500，条目区 1080），
// 多出来的条目会被「从最旧砍」挤掉，被挤掉的仍然留在 daily-memory.json 里、能查到。
// 代价只有一处：索引里能留的天数会变少（条目多了，同样预算装不下之前的那么多天）。
const MAX_DAILY_ITEMS = 15;
// 每条记忆的「详细」部分上限（2026-10-28 主人：「按需检索的如果只是占用我的本地
// 空间，那完全可以弄详细啊」）。
//
// 为什么不干脆把 text 写长：text 会进角色卡的记忆索引，**每一轮对话都重读一遍**。
// 索引条目区预算只有 1080 字符（见 memory-index.mjs），一条 200 字就吃掉五分之一。
// 所以拆两档：text 保持 40 字级（进索引），detail 给 200 字（只进 daily-memory.json，
// 检索时才出来）。同一批记忆，常驻成本不变、可查信息量翻几倍。
//
// 为什么是 200 而不是无上限：归档按需检索时也是整段进上下文的，一条几千字会让
// 「翻一下昨天」变成灌满窗口。200 字足够写清「发生了什么 + 为什么 + 结论/情绪」。
const MAX_ITEM_DETAIL_CHARS = 200;
// 单条上限（2026-10-23 从 50 调到 80）。
// 50 字会正好切在半句上：「…想玩游戏被推掉了，没答应具体时间。」前一句还在后面；
// 索引里留半句比留一句短话更糟 —— 读的人（她自己）要猜后半句是什么。
// 80 字够写完「发生了什么 + 对方的反应/结论」一整句；配合「只留最近 3 天」的移除策略，
// 20 条 × (前缀 14 + 80) ≈ 1900 字符，仍在 2480 预算内。
const MAX_ITEM_CHARS = 80;
// 「软上限」：目标 80 字，但允许为了收成完整一句多占一点，最多到这里。
// 为什么需要：模型对「80 字」的感知天生不准，实测经常写到 90~120 字。
// 只按 80 硬收，就会把它多写的那半句砍掉 —— 2026-10-26 重跑 10-25 时又碰到一次
// （「…要转word/pdf，…」，那次它写的一句是 105 字）。与其砍半句，不如让它说完。
// 代价可控：条目区预算 1080 字符，每条含前缀约 22；80 字时约 10 条，120 字时约 7 条
// —— 记忆索引的既定取舍本来就是「宁可少记几条最近的事，也不要整块被砍掉」
// （见 memory-index.mjs 的 INDEX_MAX_CHARS 注释）。实测条目多落在 60~90 字，
// 只有模型偶尔写长句时才吃到 120，所以平常的条数不会掉到 7。
const MAX_ITEM_CHARS_HARD = 120;

// 截断必须「收在句读上」，不能按字数硬切。
// 2026-10-26 主人发现的那条就是反例：「…想为我加唱歌和打语音功能，后因他电脑配置太低暂时」
// —— 后半句没了。上一次把上限从 50 调到 80，只是把悬崖往后挪，治不了根；
// 根在「只顾字数、不管句子到没到」。所以按标点收：
//   ① 先在「软上限」范围内找句末标点（。！？；）→ 在那儿收，是完整一句，不加省略号；
//   ② 找不到就退回目标字数，在逗号/顿号处收 → 补「…」表示后面还有；
//   ③ 连逗号都没有（超长无标点长串）→ 才硬切 + 「…」。
// 下限 MIN_KEEP = 六成：标点太靠前时收尾会丢信息，宁可多带半句再说。
function clipItem(text, limit = MAX_ITEM_CHARS) {
  const s = String(text ?? '').trim();
  if (s.length <= limit) return s;
  const lastOf = (hay, marks) => marks.reduce((best, m) => Math.max(best, hay.lastIndexOf(m)), -1);
  const MIN_KEEP = Math.floor(limit * 0.6);
  const END_MARKS = ['。', '！', '？', '；'];
  const soft = s.slice(0, MAX_ITEM_CHARS_HARD);
  const end = lastOf(soft, END_MARKS);
  if (end >= MIN_KEEP) return soft.slice(0, end + 1);
  const head = s.slice(0, limit);
  const comma = lastOf(head, ['，', '、', ',', ';']);
  if (comma >= MIN_KEEP) return head.slice(0, comma + 1) + '…';
  return head.slice(0, limit - 1) + '…';
}

/**
 * 截「详细」那一截（2026-10-28 双档改造新增）。
 *
 * 和 clipItem 共用同一套「收在句读上」的逻辑，只是限额不同（默认 200 字）。
 * 为什么不复用 clipItem 直接调：clipItem 的第二道标点回退用的是 head（= limit）
 * 而不是软上限，对 200 字这种长文更容易在逗号处早收、丢掉后半段的结论。
 * 所以这里先试句末标点，再试逗号，最后才硬切 —— 结论落在句末的概率最高。
 */
function clipDetail(text, limit = MAX_ITEM_DETAIL_CHARS) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  if (s.length <= limit) return s;
  const lastOf = (hay, marks) => marks.reduce((best, m) => Math.max(best, hay.lastIndexOf(m)), -1);
  const MIN_KEEP = Math.floor(limit * 0.6);
  const head = s.slice(0, limit);
  const end = lastOf(head, ['。', '！', '？', '；']);
  if (end >= MIN_KEEP) return head.slice(0, end + 1);
  const comma = lastOf(head, ['，', '、', ',', ';']);
  if (comma >= MIN_KEEP) return head.slice(0, comma + 1) + '…';
  return head.slice(0, limit - 1) + '…';
}

// 与 src/bridge.js 的 ROLE_INJECT_MAX_CHARS_DEFAULT 保持一致（那边是权威值）。
// 两处漂移的后果：rollover 按大的填预算、桥接按小的截断，索引最后几条被静默砍掉。
// scripts/test-role-card.mjs 会比对这两个数。
const ROLE_INJECT_MAX_CHARS_FALLBACK = 6000;

const log = (...a) => console.log(`[rollover] ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`, ...a);

function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
}
function readConsoleToken() {
  try { return fs.readFileSync(CONSOLE_TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}
function readDailyMemory() {
  try { return JSON.parse(fs.readFileSync(DAILY_MEMORY_FILE, 'utf8')); }
  catch { return { lastDigestDate: null, items: [] }; }
}
function writeDailyMemory(mem) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = DAILY_MEMORY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(mem, null, 2), 'utf8');
  fs.renameSync(tmp, DAILY_MEMORY_FILE);
}

function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDateStr(d);
}
function dayRangeSeconds(dateStr) {
  const [y, m, dd] = dateStr.split('-').map(Number);
  const start = new Date(y, m - 1, dd, 0, 0, 0).getTime() / 1000;
  const end = new Date(y, m - 1, dd + 1, 0, 0, 0).getTime() / 1000;
  return [Math.floor(start), Math.floor(end)];
}

/**
 * 把 OneBot 的 CQ 码还原成人读的样子。
 *
 * 为什么必须洗：这里读的是 `raw_message`，形如
 *   [CQ:image,file=xxx.jpg,url=https://...rkey=CAES...（几百字符的签名）]
 * 一条图片消息就能占掉大半个 12000 字符的预算，提炼模型却只看到一串乱码 URL。
 * 图片/语音这些"内容"本来也不是文字能表达的，压成 [图片] 就够。
 */
function humanizeCq(text) {
  return String(text ?? '')
    // [CQ:at,qq=123456789] → @QQ号（身份只认号）
    .replace(/\[CQ:at,qq=([^,\]]+)[^\]]*\]/g, (_m, qq) => `@${qq}`)
    .replace(/\[CQ:image,[^\]]*\]/g, '[图片]')
    .replace(/\[CQ:record,[^\]]*\]/g, '[语音]')
    .replace(/\[CQ:video,[^\]]*\]/g, '[视频]')
    .replace(/\[CQ:file,[^\]]*name=([^,\]]*)[^\]]*\]/g, '[文件 $1]')
    .replace(/\[CQ:face,[^\]]*\]/g, '[表情]')
    // 其余 CQ 码统一压掉，别把原始参数喂给模型
    .replace(/\[CQ:[a-z_]+,[^\]]*\]/g, '[媒体]')
    .replace(/&amp;/g, '&')
    .trim();
}

function findMessagesDb(config) {
  // 没配 snowluma.homeDir 时退回「仓库的兄弟目录 SnowLuma」，不写死任何盘符。
  const fallback = path.join(path.dirname(ROOT), 'SnowLuma');
  const homeDir = String(config.snowluma?.homeDir || fallback).replace(/^\/+/, '');
  const dataRoot = path.resolve(homeDir, 'data');
  if (!fs.existsSync(dataRoot)) return null;
  for (const entry of fs.readdirSync(dataRoot)) {
    const p = path.join(dataRoot, entry, 'messages.db');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function readDayMessages(dbPath, dateStr, ownerQQ, selfQQ = '') {
  const [start, end] = dayRangeSeconds(dateStr);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      "SELECT timestamp, data FROM messages WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp ASC"
    ).all(start, end);
    const msgs = [];
    for (const r of rows) {
      let p; try { p = JSON.parse(r.data); } catch { continue; }
      const rawText = String(p.raw_message ?? '').trim();
      const text = humanizeCq(rawText);
      if (!text) continue;
      // ⚠️ 原先这里只取 userId/nickname，**完全不带"这条属于哪个会话"**，
      //    结果群聊、主人的私聊、别人的私聊被拼成同一份「私人聊天」记录
      //    喂给提炼模型 —— 记忆串味就是从这一步开始的。
      //
      // 会话归属必须按「谁跟谁在聊」算，而不是按 `user_id`：
      //   · 收到的消息：user_id = 对方
      //   · 她自己发出的消息：post_type=message_sent，user_id 是**她自己**，
      //     真正的对话对象在 target_id 里。
      // 只看 user_id 的话，她发出的每一句都会落进 private:<selfQQ>，
      // 于是同一段私聊被劈成两半（对方那半 + 她这半），她的回复会被
      // 当成"另一个人的会话"——既丢了她的原话，也造出一个不存在的对话者。
      const isGroup = String(p.message_type ?? '') === 'group';
      const postType = String(p.post_type ?? '');
      const uidRaw = String(p.user_id ?? '');
      const targetRaw = p.target_id != null ? String(p.target_id) : '';
      const isSelfMsg = !!selfQQ && uidRaw === String(selfQQ);
      const sentBySelf = postType === 'message_sent' || isSelfMsg;
      let peerUid;
      if (isGroup) {
        peerUid = String(p.group_id ?? '');
      } else if (sentBySelf) {
        // 她发出的：对话对象是 target_id；真拿不到才退回她自己的号（下面会被丢弃）
        peerUid = targetRaw || uidRaw;
      } else {
        peerUid = uidRaw;
      }
      msgs.push({
        ts: Number(p.time ?? r.timestamp),
        userId: uidRaw,
        nickname: String(p.sender?.nickname ?? ''),
        text,
        isGroup,
        peerUid,
        sentBySelf,
        // 会话身份只认 QQ 号：group:<群号> / private:<对方QQ号>
        scope: isGroup ? `group:${peerUid}` : `private:${peerUid}`,
        selfMsg: sentBySelf,
        // 注意：这里原字段叫 self，含义是"发言人不是主人"（语义正好相反，
        // 极易误读）。改名非主人发言，避免下一个人再踩。
        fromOther: String(p.user_id ?? '') !== String(ownerQQ ?? '')
      });
    }
    return msgs;
  } finally {
    db.close();
  }
}

function normalizeForCompare(s) {
  return String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
function isDuplicate(a, b) {
  const na = normalizeForCompare(a), nb = normalizeForCompare(b);
  if (!na || !nb) return false;
  if (na.length < 4 || nb.length < 4) return na === nb;
  if (na.includes(nb) || nb.includes(na)) return true;
  const grams = (s) => { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
  const ga = grams(na), gb = grams(nb);
  let inter = 0; for (const g of ga) if (gb.has(g)) inter++;
  const uni = ga.size + gb.size - inter;
  return uni > 0 && inter / uni >= 0.75;
}

/**
 * 把某一组消息拼成 transcript。
 *
 * 身份**只按 QQ 号**标注：昵称会改、会重名、会被乱起（"大帅哥"/"栖筠姐姐"是同一人），
 * 拿昵称当身份是记忆串味的源头之一。所以这里一律写 `QQ号`，昵称只作附带说明。
 */
function buildTranscript(scope, messages, ownerQQ, selfQQ, sentVoice = []) {
  const isGroup = scope.startsWith('group:');
  const peerUid = scope.slice(scope.indexOf(':') + 1);
  const header = isGroup
    ? `【会话】群聊 ${peerUid}`
    : `【会话】与 QQ ${peerUid} 的私聊` +
      (String(peerUid) === String(ownerQQ)
        ? '（这是主人本人）'
        : '（这不是主人，是另一个人）');
  // 她的语音条在库里只有 `[语音]`，正文是空的。这里把旁注的原文补回去。
  //
  // ⚠️ 为什么不能只按顺序配：`sendVoiceForV2`（她直接发一个音频文件）也会在库里留下
  //    `[语音]`，但**没有**原文旁注。纯按索引配，只要有一句这样的斜插进来，
  //    后面所有 `[语音]` 就会整体错位一位 —— 记忆里她说的每句话都张冠李戴。
  //    所以按**时间就近**配，窗口只给 ±20 秒（旁注和消息是同一次发送落的，
  //    实际差几秒；窗口给大了，间隔一分钟的两条语音就会互相串）。
  //    时间对不上就保持 `[语音]`：宁可少一句原文，也不能错配。
  const used = new Set();
  const VOICE_MATCH_SEC = 20;
  const pickVoice = (m) => {
    const mts = Number(m?.ts) || 0;
    let best = -1;
    let bestGap = Infinity;
    if (mts > 0) {
      for (let i = 0; i < sentVoice.length; i += 1) {
        if (used.has(i)) continue;
        const vts = Number(sentVoice[i]?.ts) || 0;
        if (!vts) continue;
        const gap = Math.abs(vts / 1000 - mts);
        if (gap <= VOICE_MATCH_SEC && gap < bestGap) { best = i; bestGap = gap; }
      }
    }
    if (best < 0) {
      // 只有拿不到消息时间时才退回顺序（老库里 ts 可能缺失）；
      // 有时间的宁可留白，也不猜。
      if (mts > 0) return '';
      best = sentVoice.findIndex((v, i) => !used.has(i) && v?.text);
    }
    if (best < 0) return '';
    used.add(best);
    return sentVoice[best]?.text ?? '';
  };
  const lines = messages.map((m) => {
    // 她自己的话：她的回复是这段对话的一半，必须保留、并明确标成"她说的"，
    // 否则模型会把她的口气当成对方的口气（这正是记忆串味的一种）。
    if (m.selfMsg || (selfQQ && String(m.userId) === String(selfQQ))) {
      let said = m.text;
      if (/^\[语音\]$/.test(String(said).trim())) {
        const hit = pickVoice(m);
        if (hit) said = hit;
      }
      return `[小鲸鱼自己] ${said}`;
    }
    if (!isGroup && String(m.userId) === String(ownerQQ)) {
      return `[主人 QQ${m.userId}] ${m.text}`;
    }
    // 群聊里其他人（含主人在群里发言）都带 QQ 号；
    // 昵称放在「显示名」里，只是为了让记录读得通，不是身份。
    const shown = m.nickname ? ` 显示名"${m.nickname}"` : '';
    return `[QQ${m.userId}${shown}] ${m.text}`;
  });
  return `${header}\n${lines.join('\n')}`;
}

async function distill(dateStr, messages, config, existingItems = [], scope = '', ownerQQ = '', selfQQ = '', opts = {}) {
  if (!messages.length && !opts.transcript) return [];
  const baseUrl = config.dsh?.baseUrl || 'http://127.0.0.1:19387';
  const api = new NodeApiClient(baseUrl, undefined, { token: config.dsh?.authToken || '', header: config.dsh?.authHeader, prefix: config.dsh?.authPrefix });

  // 通话记录走 opts.transcript（已经拼好），聊天记录现场拼。
  const transcript = opts.transcript ?? buildTranscript(scope, messages, ownerQQ, selfQQ);
  const trimmed = transcript.length > 12000 ? transcript.slice(-12000) : transcript;

  // ⚠️ items 里的元素是 {scope,text,detail} 对象，**必须只取 text 拼成字符串数组**。
  // 直接把对象塞进 existingFlat，normalizeForCompare(String(obj)) 会得到
  // "[objectobject]"，永远不等于任何一条真要点 ⇒ 跨天去重**静默失效**
  // （同一件事每天被重新记一遍，索引里全是重影）。
  // 这是从「条目从纯字符串改成 {scope,text} 对象」那天就埋下的，2026-10-28 双档
  // 改造时才发现 —— 别再把整条对象丢进比较函数。
  const existingFlat = (existingItems || [])
    .flatMap((d) => d?.items || [])
    .map((it) => String((it && typeof it === 'object') ? it.text ?? '' : it ?? '').trim())
    .filter(Boolean);
  const existingSummary = existingFlat.slice(-40).map((s) => `- ${s}`).join('\n');

  const isGroup = scope.startsWith('group:');
  const scopeDesc = opts.call
    ? `与 QQ ${scope.slice(scope.indexOf(':') + 1)} 的**语音通话**逐字记录（一方是小鲸鱼自己，另一方是这个人；ASR 转写，可能有错字）`
    : isGroup
      ? `QQ 群聊 ${scope.slice(scope.indexOf(':') + 1)} 的记录（里面有多个人，发言用 [QQ号 昵称] 标注）`
      : `与 QQ ${scope.slice(scope.indexOf(':') + 1)} 的**一对一私聊**记录`;

  const promptText =
    `以下是 ${dateStr} 的 ${scopeDesc}。请提炼出对「长期记忆」真正有用的重点。\n` +
    `⚠️ 严格要求：这份记录**只来自这一个会话**。不要把它跟别的群、别的私聊混在一起。\n` +
    `⚠️ 身份只认 QQ 号：` +
    `昵称/群名片**可能被本人随便乱起、也可能是别人给的**（同一个人可能同时叫"大帅哥"和"栖筠姐姐"），` +
    `所以不要把昵称当成身份，也不要用昵称判断"是不是同一个人"；判断身份一律看 QQ 号。\n` +
    `要求：\n` +
    `1) 最多 ${MAX_DAILY_ITEMS} 条，每条写成一行的两截，中间用「｜」隔开，格式：\n` +
    `   - 要点｜详细\n` +
    `   前半「要点」≤${MAX_ITEM_CHARS} 字，一句话（它会被放进每轮都要读的记忆索引里，越短越好；` +
    `只写"什么事"，不要复述寒暄）；\n` +
    `   后半「详细」≤${MAX_ITEM_DETAIL_CHARS} 字（它只在事后被检索时才读，所以可以写清楚：` +
    `发生了什么、当时的情形/原因、对方的反应、结论或情绪、后面还欠着什么）；\n` +
    `2) 涉及具体的人时必须写 QQ 号；昵称只在有助于认人时跟在号后面当说明（例如"QQ100000001"），` +
    `不要只写昵称、也不要把昵称写成这个人"是谁"；\n` +
    `3) 与下面「已有要点」完全相同的内容不要再写；但若是同一件事的新进展（跨天发生的），请写成新的进展要点并保留，不要因为之前提过就省略。\n` +
    `3b) 凡是**约定 / 答应 / 还欠着的事**，必须把时间写进去（"约定10月25日"、"说好明天"、"答应下周给他"）。` +
    `没写时间的约定过几天就没人认得出来了；已经兑现的不要写成约定。\n` +
    `4) 详细那截尽可能多写——这是唯一的存储成本，只是硬盘；少写细节才是真的丢东西。\n` +
    // ── 以下两条是 2026-10-29 加的：把「她猜的」和「别人说的」分开，把「旧的」标成旧的 ──
    // 为什么：之前两种情况会让她把话说错得理直气壮 ——
    //   ① 提炼时模型顺手补一句原文没说的（"他大概在忙"），落库后跟"他说他在忙"
    //      长得一模一样，第二天她就拿这个当事实讲；
    //   ② 状态会变（"板子还没做视觉" → "视觉也接上了"），两条并存时她挑顺眼的说。
    `4b) 如果某条要点是**你根据上下文推出来的**，不是对方明确说的、也不是你亲眼见的，` +
    `就在「要点」最前面加一个半角波浪号「~」（例：~主人大概在赶项目｜…）。` +
    `拿不准就别加 —— 这个符号是给"确实是猜的"用的，乱加会让真事也变可疑。\n` +
    `4c) 如果这一条**让更早的某条记忆不再成立**（不是补充，是取代：搬了家、做完了、改主意了），` +
    `就在「要点」最前面写「〔取代:旧要点的开头几个字〕」（例：〔取代:板子还没做视觉〕视觉也接上了｜…）。` +
    `旧要点不要删（历史要留着），只要指出被谁取代；「~」和「〔取代:…〕」可以同时用。\n` +
    `已有要点：\n${existingSummary || '（暂无）'}\n\n` +
    `记录：\n${trimmed}\n\n` +
    `直接输出要点，每条一行，不要多余说明、不要编号。`;

  const cwd = path.join(os.tmpdir(), 'qq-memory-rollover');
  fs.mkdirSync(cwd, { recursive: true });
  const created = unwrap(await api.sessions.create({ cwd }), 'session.create');
  const sessionId = created.sessionId;

  const collector = createTurnCollector();
  let resolveOpened, rejectOpened;
  const opened = new Promise((res, rej) => { resolveOpened = res; rejectOpened = rej; });
  const openTimer = setTimeout(() => rejectOpened(new Error('DSH 事件流打开超时')), 15_000);
  const stream = api.events.mux({}, undefined, () => { clearTimeout(openTimer); resolveOpened(); });
  const done = new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('提炼超时（90s）')), 90_000);
    (async () => {
      for await (const envelope of stream) {
        const frame = envelope.payload;
        if (frame.type === 'session/event' && frame.sessionId === sessionId) {
          const ended = collector.push(frame.event);
          if (ended) { clearTimeout(timer); res(ended); return; }
        } else if (frame.type === 'stream/error') {
          clearTimeout(timer); rej(new Error('事件流错误: ' + JSON.stringify(frame.error))); return;
        }
      }
    })().catch((e) => { clearTimeout(timer); rej(e); });
  });
  await opened;
  stream.follow(sessionId);
  await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
  const ended = await done;
  try { await api.workspace.archiveSession({ sessionId }); } catch {}

  const raw = String(ended.text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter((l) => l.length > 0 && !/^要点|^长期记忆|^以下|^输出/.test(l));

  // 去重兜底：模型即便没完全听话，也在落盘前兜底。
  //
  // 2026-10-28 双档改造：每行可能是「要点｜详细」。**拆分点取第一个「｜」**，
  // 因为「要点」里几乎不会出现全角竖线，而详细里偶尔会（"A｜B 都行"），
  // 取最后一个会把整段详细吞进 text、把索引撑爆。
  // 老数据/模型不守格式时没有「｜」⇒ 整行当 text，行为与改造前完全一致（向后兼容）。
  const seen = [];
  for (const line of raw) {
    // 拆「要点｜详细」+ 剥掉 `~` / `〔取代:…〕` 两个提示词标记。
    // 解析放在 memory-index.mjs 的 parseItemLine 里（纯函数，能单独测）——
    // 埋在 distill 里的话，要验证"标记剥干净了没有"就得连 DSH 跑一次模型。
    const parsed = parseItemLine(line);
    const clean = clipItem(parsed.text);
    if (!clean) continue;
    // 跨天：只有归一化后完全相等才视为重复 —— 保留「同一件事的新进展」。
    if (existingFlat.some((e) => normalizeForCompare(e) === normalizeForCompare(clean))) continue;
    // 当天内：仍用相似度去重，防模型同一天输出多条几乎一样的。
    if (seen.some((s) => isDuplicate(clean, s.text))) continue;
    const entry = { text: clean, detail: clipDetail(parsed.detail) };
    if (parsed.inferred) entry.inferred = true;
    if (parsed.replaces) entry.replaces = parsed.replaces;
    seen.push(entry);
    if (seen.length >= MAX_DAILY_ITEMS) break;
  }
  return seen;
}

function currentRoleName() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'current-role.json'), 'utf8')).role || null; } catch { return null; }
}

// 索引块的纯函数（筛选/拼块/清理/注入）抽到了 memory-index.mjs：
// 那个文件没有副作用，可以被 scripts/test-memory-index.mjs 直接单测；
// 而这个文件顶层 import 了 node:sqlite，直接 import 会连数据库一起初始化。
// ⚠️ 不要在这里再抄一份实现 —— 两份一定会漂移，而漂移的后果就是重复索引。
function injectIndexIntoRole(mem, config = null) {
  const roleName = currentRoleName();
  if (!roleName) { log('未设置角色，跳过索引注入'); return; }
  const roleFile = path.join(ROLES_DIR, roleName + '.md');
  if (!fs.existsSync(roleFile)) { log('角色文件不存在:', roleFile); return; }
  const text = fs.readFileSync(roleFile, 'utf8');
  // 没传 config 时退回到读一次文件（保持旧调用方式也能工作）
  const cfg = config ?? readConfig();

  // ⭐ 容量策略（2026-10-23 主人改成"随时间移除"）：
  //   ① 逐条只留最近 INDEX_RECENT_DAYS 天，更早的整条移出（只留库，可检索）；
  //   ② 未到期的约定额外钉住 INDEX_PIN_MAX_ITEMS 条，不受 ① 限制；
  //   ③ 条数上限 INDEX_MAX_ITEMS；
  //   ④ **字符预算**（下面这段）。
  // 前三条在 memory-index.mjs 里，这里不要重复实现。
  //
  // 为什么必须有字符预算：条数管不住体积（每条 30~50 字符不等）。真实事故：
  // 角色卡 9758 / role.maxInjectChars 10000，只剩 242 字符余量，日增约 175 字符
  // —— 一天就超。而超限截断是**从头砍**的，索引在文件末尾 ⇒ 砍掉的正是最新记忆，
  // 还会切在半条中间，连「读法」和结束标记一起消失（实测确认过）。
  //
  // 预算用**实际正文长度反推**，而不是写死 1500：
  // 以后若有人往角色卡正文里加内容，写死的预算会让总长悄悄超限；
  // 反推的话索引会自动让出空间，永远不会把整块挤掉。
  // 注意这不是删除：daily-memory.json 仍保留全量，索引只是"最近的事"，
  // 更早的条目通过归档指针（含关键词）告诉她用 qq_memory_query 检索。
  // 兜底值必须与 src/bridge.js 的 ROLE_INJECT_MAX_CHARS_DEFAULT 一致（都是 6000）。
  // 曾经这里是 10000 —— 只在 config.json 缺 role 段时才有偏差，而那时桥接按 6000
  // 截断、rollover 按 10000 填预算，结果就是「rollover 说塞得下、桥接一截把索引尾巴砍掉」。
  const injectMax = Number(cfg?.role?.maxInjectChars) || ROLE_INJECT_MAX_CHARS_FALLBACK;
  const bodyLen = text
    .replace(/[\r\n]*<!-- qq-memory-index:start -->[\s\S]*?<!-- qq-memory-index:end -->[\r\n]*/g, '')
    .replace(/\s+$/, '').length;
  // 留 260 字符缓冲：块与正文之间的空行、两个标记、以及将来正文微调。
  const budget = Math.max(600, injectMax - bodyLen - 260);
  const picked = selectIndexItems(mem, { maxChars: budget });
  const result = injectIndexIntoText(text, picked.lines, {
    archivedCount: picked.archivedCount,
    keywords: picked.keywords,
    keptDays: picked.keptDays,
    pinnedCount: picked.pinnedCount
  });

  if (result.text !== text) {
    fs.writeFileSync(roleFile, result.text, 'utf8');
    const extra = result.count > 1 ? `，清理了 ${result.count - 1} 个重复块` : '';
    log('索引已写入角色卡:', roleFile,
      `(正文 ${bodyLen} + 索引 ${result.text.length - bodyLen} = ${result.text.length}，上限 ${injectMax}；` +
      `保留 ${picked.lines.length} 条 / ${picked.keptDays} 天，归档 ${picked.archivedCount} 条${extra}` +
      `${picked.pinnedCount ? `，另有 ${picked.pinnedCount} 条未到期约定` : ''}` +
      `${picked.droppedForBudget ? `，因体积再砍 ${picked.droppedForBudget} 条` : ''}` +
      `${picked.keywords.length ? `，关键词 ${picked.keywords.join('、')}` : ''})`);
    // 兜底告警：写完仍超限说明预算算错了 —— 必须让人知道，别静默截断。
    if (result.text.length > injectMax) {
      log(`⚠️ 角色卡仍超过注入上限 ${injectMax}（实际 ${result.text.length}）：` +
        `超出部分会被从头截断、可能砍掉索引。请精简角色卡正文。`);
    }
  } else {
    log('索引无变化，跳过写入');
  }
}

async function resetSession(config, key) {
  const consoleToken = readConsoleToken();
  const base = `http://127.0.0.1:${config.consolePort || 3100}`;
  let resp;
  try {
    resp = await fetch(`${base}/api/session/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': consoleToken },
      body: JSON.stringify({ key })
    });
  } catch (e) {
    // 桥接没在线（fetch failed）不是致命错误：整理已完成，归档留到下次桥接在线时补。
    log('归档未执行（桥接可能未在线，下次醒来补做）:', e?.message ?? e);
    return false;
  }
  const json = await resp.json();
  if (json?.ok) { log('已归档会话上下文:', key); return true; }
  if (resp.status === 404) { log('会话不存在，跳过归档:', key); return true; }
  log('归档失败:', resp.status, JSON.stringify(json).slice(0, 200));
  return false;
}

/**
 * 按会话分组：**只按 QQ 号认身份**（group:<群号> / private:<对方QQ号>）。
 *
 * 为什么必须分组：原先一天的所有消息被拼成一份、一起送进提炼，提示词还写着
 * 「私人聊天」—— 群聊、主人的私聊、别人的私聊全混成一坨，模型只能看昵称，
 * 于是"群里的梗"变成"私聊里的约定"、"别人的作息"变成"主人的作息"。
 *
 * 关于 `private:<selfQQ>`：**她自己的话不该被丢掉**。绝大多数情况下这些消息
 * 已经从 `target_id` 归回了真正的对话方（见 readDayMessages），所以这个 key
 * 基本不该出现。它只在两种情况下残留：
 *   ① 老的 `message_sent` 记录缺 target_id（无从判断是在对谁说话）；
 *   ② 她自己给自己发的消息。
 * 此时整组丢弃是对的——把它当成"另一个人"混进提炼，比少记一条更糟。
 */
function groupByScope(msgs, selfQQ) {
  const groups = new Map();
  for (const m of msgs) {
    // 归不到任何人的 her 自己的消息：丢弃（不是把它当第三方）
    if (!m.isGroup && selfQQ && String(m.peerUid) === String(selfQQ)) continue;
    if (!groups.has(m.scope)) groups.set(m.scope, []);
    groups.get(m.scope).push(m);
  }
  return groups;
}

/** 统计有多少条因为无法归属被丢弃（用于日志，别静默吞掉）。 */
function countUnattributed(msgs, selfQQ) {
  if (!selfQQ) return 0;
  return msgs.filter((m) => !m.isGroup && String(m.peerUid) === String(selfQQ)).length;
}

/**
 * 读某一天**她亲口说的**语音原文，并按会话 key 分组。
 *
 * 目的不是"多记几条消息"，而是补上逐字稿里缺的那一半：
 * messages.db 里她发的语音条只有 `[语音]`（正文为空），所以整理时永远看不到
 * 「她是怎么回的」。她越是用语音回话，这个洞越大 —— 到头来记忆里全是主人说了什么。
 *
 * 数据源是 bridge.js 的 `appendSentVoiceLog` 写的 `state/sent-voice-logs/YYYY-MM-DD.jsonl`，
 * 一行一条 `{t, key, text}`。日期直接取文件名（和通话逐字稿同一套规矩）。
 *
 * @returns {Map<string, Array<{ts:number, text:string}>>}
 */
function readDaySentVoiceLogs(dateStr) {
  const byKey = new Map();
  const file = path.join(SENT_VOICE_DIR, `${dateStr}.jsonl`);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return byKey; }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let row;
    try { row = JSON.parse(s); } catch { continue; }
    const key = String(row?.key ?? '').trim();
    const text = String(row?.text ?? '').trim();
    if (!key || !text) continue;
    const ts = Date.parse(String(row?.t ?? '')) || 0;
    const list = byKey.get(key) ?? [];
    list.push({ ts, text });
    byKey.set(key, list);
  }
  return byKey;
}

/**
 * 读某一天的通话逐字稿，并按会话 key 分组。
 *
 * 为什么要单独一条路径：QQ 语音通话**一不产生消息、二不进 messages.db**，
 * 所以「只读聊天记录」的整理永远记不住电话内容。主人 2026-10-25 要求
 * 「每通电话记一条摘要」，这里就是那条摘要的原料。
 *
 * 文件名形如 call-20261025-213000.json，日期直接取文件名里的日期段
 * （而不是里面的 startedAt）：文件名是 sidecar 落盘那一刻的本地时间，
 * 跨零点的通话按"开始那天的通话"归档，比按 ISO 串再解析稳。
 *
 * @returns {Map<string, Array<{ts:number, selfMsg:boolean, text:string, callAt:string}>>}
 */
function readDayCallLogs(dateStr) {
  const byScope = new Map();
  const CALL_LOG_DIR = callLogDir();
  let files;
  try { files = fs.readdirSync(CALL_LOG_DIR); } catch { return byScope; }
  const compact = dateStr.replaceAll('-', '');   // 2026-10-25 → 20261025
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    const m = /^call-(\d{8})-(\d{6})\.json$/.exec(name);
    if (!m || m[1] !== compact) continue;
    let payload;
    try { payload = JSON.parse(fs.readFileSync(path.join(CALL_LOG_DIR, name), 'utf8')); } catch { continue; }
    const key = String(payload?.key ?? '').trim();
    const turns = Array.isArray(payload?.turns) ? payload.turns : [];
    if (!key || !turns.length) continue;
    const callAt = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)} ` +
      `${m[2].slice(0, 2)}:${m[2].slice(2, 4)}`;
    const list = byScope.get(key) ?? [];
    for (const t of turns) {
      const text = String(t?.text ?? '').trim();
      if (!text) continue;
      const ts = Date.parse(String(t?.t ?? '')) || 0;
      list.push({ ts, selfMsg: String(t?.who ?? '') === 'self', text, callAt });
    }
    byScope.set(key, list);
  }
  return byScope;
}

/**
 * 把一个会话「当天的电话」拼成 transcript（与聊天的 buildTranscript 同款标注）。
 * 每通电话前面加一行分隔，避免两通电话的对话被模型揉成一段。
 */
function buildCallTranscript(scope, turns, ownerQQ, selfQQ = '') {
  const peerUid = scope.slice(scope.indexOf(':') + 1);
  const isOwner = String(peerUid) === String(ownerQQ);
  const header = `【会话】与 QQ ${peerUid} 的语音通话` +
    (isOwner ? '（这是主人本人）' : '（这不是主人，是另一个人）');
  const lines = [];
  let lastCall = '';
  for (const t of turns) {
    if (t.callAt !== lastCall) {
      lines.push(`—— ${t.callAt} 那通电话 ——`);
      lastCall = t.callAt;
    }
    // 身份只认 QQ 号（和聊天那边同一套规则）：非自己的发言一定是这个会话的对端。
    if (t.selfMsg) lines.push(`[小鲸鱼自己] ${t.text}`);
    else if (isOwner) lines.push(`[主人 QQ${peerUid}] ${t.text}`);
    else lines.push(`[QQ${peerUid}] ${t.text}`);
  }
  return `${header}\n${lines.join('\n')}`;
}

async function runOnce(config, { force = false } = {}) {
  const mem = readDailyMemory();
  // force 模式：处理「今天」的消息（测试 / 手动补整），不设 lastDigestDate 防跳过。
  const targetDate = force ? localDateStr() : daysAgo(1);

  if (!force && mem.lastDigestDate === targetDate) { log('昨日已整理，跳过'); return; }

  const dbPath = findMessagesDb(config);
  if (!dbPath) { log('未找到 SnowLuma messages.db，跳过'); return; }

  const ownerQQ = config.ownerQQ;
  const selfQQ = String(config.selfQQ ?? '');
  if (!selfQQ) log('⚠️ config.json 未配置 selfQQ（机器人自己的 QQ 号），无法排除机器人自身的会话');
  const msgs = readDayMessages(dbPath, targetDate, ownerQQ, selfQQ);
  // 语音通话既不发 QQ 消息、也不进 messages.db，必须单独读逐字稿，
  // 否则「电话里说过的话」永远不会进长期记忆。
  const callLogs = readDayCallLogs(targetDate);
  // 她亲口说的语音原文。库里那条只是 `[语音]`，正文是空的 —— 不读这个，
  // 逐字稿里她的那一半就永远是个时长标记，记忆只能记住"主人说了什么"。
  const sentVoiceLogs = readDaySentVoiceLogs(targetDate);
  if (!msgs.length && !callLogs.size && !sentVoiceLogs.size) {
    if (!force) { mem.lastDigestDate = targetDate; writeDailyMemory(mem); }
    log(`${targetDate} 无消息${force ? '' : '，标记已处理'}`);
    return;
  }

  const byScope = groupByScope(msgs, selfQQ);
  // 只有电话、当天没有任何文字的会话，也要进 byScope —— 否则那通电话白记。
  for (const key of callLogs.keys()) if (!byScope.has(key)) byScope.set(key, []);
  // 只有语音、连一条文字都没有的会话同理（不然那天她说的全是语音就白记）。
  for (const key of sentVoiceLogs.keys()) if (!byScope.has(key)) byScope.set(key, []);
  const dropped = countUnattributed(msgs, selfQQ);
  const voiceCount = [...sentVoiceLogs.values()].reduce((a, v) => a + v.length, 0);
  log(`开始整理 ${targetDate}：${msgs.length} 条消息 + ${voiceCount} 句她的语音 + ${callLogs.size} 个通话会话，分属 ${byScope.size} 个会话` +
    (dropped ? `（另有 ${dropped} 条无法归属到任何对话，已跳过）` : ''));
  for (const [scope, list] of byScope) {
    const sent = list.filter((m) => m.selfMsg).length;
    const calls = callLogs.has(scope) ? `，另有 ${callLogs.get(scope).length} 句电话` : '';
    const voices = sentVoiceLogs.has(scope) ? `，她的语音原文 ${sentVoiceLogs.get(scope).length} 句` : '';
    log(`  · ${scope}：${list.length} 条（她 ${sent} / 对方 ${list.length - sent}）${voices}${calls}`);
  }

  // ⭐ 每个会话单独提炼：绝不把不同会话拼进同一次调用。
  //    条目里带上来源会话，这样索引里也能看出"这条属于谁"。
  //    一个会话当天如果既有打字又有电话，**合并成一次**提炼（而不是分两次）：
  //    分两次会同一个 scope 出现两条几乎一样的记忆，还会挤占 MAX_DAILY_ITEMS。
  const allItems = [];
  const errors = [];
  for (const [scope, list] of byScope) {
    let items;
    try {
      const callTurns = callLogs.get(scope) ?? [];
      const saidVoice = sentVoiceLogs.get(scope) ?? [];
      if (callTurns.length) {
        // 电话和文字合并：先给聊天记录，再给电话记录，模型能看出"同一件事的两个场合"。
        const parts = [];
        if (list.length) parts.push(buildTranscript(scope, list, ownerQQ, selfQQ, saidVoice));
        parts.push(buildCallTranscript(scope, callTurns, ownerQQ, selfQQ));
        items = await distill(targetDate, [], config, mem.items, scope, ownerQQ, selfQQ,
          { transcript: parts.join('\n\n'), call: true });
      } else if (!list.length && saidVoice.length) {
        // 当天只有她的语音、没有任何文字消息（比如主人一直发语音，库里却缺少对方那半）：
        // 直接把原文拼成逐字稿，不能因为 list 为空就跳过整个会话。
        const header = `【会话】与 QQ ${scope.slice(scope.indexOf(':') + 1)} 的私聊（当天只有她的语音）`;
        const body = saidVoice.map((v) => `[小鲸鱼自己] ${v.text}`).join('\n');
        items = await distill(targetDate, [], config, mem.items, scope, ownerQQ, selfQQ,
          { transcript: `${header}\n${body}` });
      } else {
        items = await distill(targetDate, list, config, mem.items, scope, ownerQQ, selfQQ,
          { transcript: buildTranscript(scope, list, ownerQQ, selfQQ, saidVoice) });
      }
    } catch (e) {
      errors.push(`${scope}: ${e?.message ?? e}`);
      log(`  提炼失败 ${scope}:`, e?.message ?? e);
      continue;
    }
    if (!items.length) { log(`  ${scope} 提炼结果为空`); continue; }
    log(`  ${scope} 提炼出 ${items.length} 条`);
    // 双档：text 进索引（每轮重读，必须短），detail 只进 daily-memory.json（检索才读）。
    // 落盘时 detail 与 text 相同就省掉 —— 老条目本来就只有 text，别让库凭空变厚。
    for (const it of items) {
      const entry = { scope, text: it.text };
      if (it.detail && it.detail !== it.text) entry.detail = it.detail;
      // 只写 true / 非空：缺省字段不落盘，老库读进来行为完全不变。
      if (it.inferred) entry.inferred = true;
      if (it.replaces) entry.replaces = it.replaces;
      allItems.push(entry);
    }
  }

  // 全部失败才算失败（部分会话成功就照常落盘，别把已拿到的成果也丢掉）。
  if (!allItems.length) {
    if (errors.length) { log('提炼全部失败（下次醒来重试）:', errors.join(' | ')); return; }
    log('提炼结果为空，跳过');
    return;
  }

  // 同一日期只保留一份：force 重复跑会覆盖当天，避免重复累加。
  // 每条都带 scope（来源会话的 QQ 号），索引行里会显示出来。
  mem.items = mem.items.filter((d) => String(d?.date) !== targetDate);
  mem.items.push({ date: targetDate, items: allItems });
  if (!force) mem.lastDigestDate = targetDate;
  writeDailyMemory(mem);
  log(`索引已更新：累计 ${mem.items.length} 天，本次 ${allItems.length} 条`);

  injectIndexIntoRole(mem, config);

  // 归档：只归档真正参与过整理的会话，别去动不相干的。
  // 主人的私聊总是归档（它是主要对话），其余按分组结果。
  const keys = [...byScope.keys()];
  if (!keys.includes(`private:${ownerQQ}`)) keys.push(`private:${ownerQQ}`);
  for (const k of keys) await resetSession(config, k);
}

async function main() {
  const config = readConfig();
  if (!config.ownerQQ) { log('config.json 未设置 ownerQQ，退出'); return; }
  log('qq-memory-rollover 启动（每 30 分钟检查一次）');
  while (true) {
    try { await runOnce(config); } catch (e) { log('本轮出错:', e?.message ?? e); }
    await new Promise((r) => setTimeout(r, SLEEP_MS));
  }
}

if (process.argv.includes('--once')) {
  const config = readConfig();
  const force = process.argv.includes('--force');
  runOnce(config, { force }).then(() => { log('--once 完成'); process.exit(0); }).catch((e) => { log('--once 失败:', e?.message ?? e); process.exit(1); });
} else if (process.argv.includes('--reindex')) {
  // 只重画角色卡里的那条记忆索引，**不调模型、不碰记忆库**。
  // 为什么需要它：手工修订过 state/daily-memory.json 之后（删掉过时的约定、修一条被截断的），
  // 角色卡上还是旧内容 —— 而让 --once 去刷新会顺带重跑一整轮提炼、把当天记忆重写一遍。
  // 刷新索引和提炼记忆是两件事，不该捆在一起。
  const cfg = readConfig();
  injectIndexIntoRole(readDailyMemory(), cfg);
  log('--reindex 完成（只刷新了角色卡索引）');
  process.exit(0);
} else if (process.argv.includes('--dump-calls')) {
  // 调试用：不调模型、不写记忆，只把「某天会被读到的通话」打出来，
  // 用来确认 sidecar 落的逐字稿真的被这条路径看见了。
  const di = process.argv.indexOf('--dump-calls');
  const day = process.argv[di + 1] || localDateStr();
  const cfg = readConfig();
  const logs = readDayCallLogs(day);
  log(`通话逐字稿目录：${callLogDir()}`);
  log(`${day}：${logs.size} 个会话有电话记录`);
  for (const [scope, turns] of logs) {
    log(`--- ${scope}（${turns.length} 句）---`);
    process.stdout.write(buildCallTranscript(scope, turns, cfg.ownerQQ, String(cfg.selfQQ ?? '')) + '\n');
  }
  process.exit(0);
} else if (process.argv.includes('--dump-voice')) {
  // 调试用：不调模型、不写记忆，只把「某天她亲口说的语音原文」打出来。
  // 用来确认 bridge 落的旁注真的被整理路径看见了（语音条正文为空时，
  // 不查这一下根本发现不了"记忆里她从不说话"）。
  const di = process.argv.indexOf('--dump-voice');
  const day = process.argv[di + 1] || localDateStr();
  const logs = readDaySentVoiceLogs(day);
  log(`语音原文旁注目录：${SENT_VOICE_DIR}`);
  const total = [...logs.values()].reduce((a, v) => a + v.length, 0);
  log(`${day}：${logs.size} 个会话、${total} 句`);
  for (const [scope, rows] of logs) {
    log(`--- ${scope}（${rows.length} 句）---`);
    for (const r of rows) {
      const when = r.ts ? new Date(r.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '?';
      process.stdout.write(`[${when}] [小鲸鱼自己] ${r.text}\n`);
    }
  }
  process.exit(0);
} else {
  main().catch((e) => { log('致命错误:', e?.message ?? e); process.exit(1); });
}

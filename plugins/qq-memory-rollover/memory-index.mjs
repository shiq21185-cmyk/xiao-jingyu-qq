// 角色卡里「记忆索引」块的纯函数（拼块 / 清理 / 注入）。
//
// 为什么单独抽出来：这段逻辑原先内联在 qq-memory-rollover.mjs 里，
// 而那个文件顶层 import 了 node:sqlite 和 dsh-client —— 直接 import 它会连
// 数据库连接一起初始化，没法单测。**2026-10-20 的重复索引 bug 正是因为没被测到**：
// 角色卡是 CRLF，而拼块用的是 `\n`，两种行尾混在一起之后
// `\n\n<!--start-->` 前缀再也匹配不上已存在的块，于是每次整理都走"追加"分支，
// 索引块越堆越多（实测坏成了两块）。
//
// 所以这里把三件事做成纯函数（只进出字符串，不碰文件系统），
// 由 scripts/test-memory-index.mjs 钉住。插件只负责读写文件。

export const INDEX_START = '<!-- qq-memory-index:start -->';
export const INDEX_END = '<!-- qq-memory-index:end -->';

/** 探测文件主导行尾（CRLF 还是 LF）。平手时按 CRLF 处理（Windows 仓库的默认）。 */
export function detectEol(text) {
  const s = String(text ?? '');
  const crlf = (s.match(/\r\n/g) || []).length;
  const lf = (s.match(/(?<!\r)\n/g) || []).length;
  return crlf >= lf ? '\r\n' : '\n';
}

/**
 * 剥掉**所有**已存在的索引块，并把连续空行并成恰好一个空行。
 *
 * ⚠️ 正则必须是「惰性 + 全局」：
 *   · 贪婪 `[\s\S]*` 会从第一个 start 一路吃到最后一个 end，把中间整段吞掉；
 *   · 非全局时 replace 只处理第一处，剩下的块会留在文件里（正是重复的来源）。
 *
 * @returns {{text:string, count:number}} count = 清理掉的块数
 */
export function stripIndexBlocks(text, eol = '\n') {
  const s = String(text ?? '');
  const re = /[\r\n]*<!-- qq-memory-index:start -->[\s\S]*?<!-- qq-memory-index:end -->[\r\n]*/g;
  const count = (s.match(re) || []).length;
  let out = s.replace(re, eol + eol);
  out = out.replace(/(?:\r\n|\n){3,}/g, eol + eol);
  return { text: out, count };
}

/**
 * 记忆索引的容量策略。
 *
 * **2026-10-23 主人改成"随时间移除"**：「记忆就是要精简，也不是重点常驻，是随时间移除的」。
 * 所以：逐条只保留最近 INDEX_RECENT_DAYS 天（3 天），更早的**整条移出索引**，
 * 只留在 daily-memory.json（外部库）里，需要时用 qq_memory_query 检索。
 * 唯一例外是**未到期的约定**（INDEX_PIN_MAX_ITEMS 条，行首标〔约定〕）。
 *
 * 历史（2026-10-20 初次拍板）：当时是"时间窗 7 天 + 硬上限 30 条"，
 * 因为索引按 daily-memory.json 全量平铺、只增不减：实测单条约 49 字符、
 * 日均新增 2.8 条 ≈ 138 字符/天 —— 约 12 天就会再次撞上 role.maxInjectChars，
 * 而**超限截断是从头砍的**，索引在文件末尾 ⇒ 被砍掉的正是最新的记忆。
 * 那个上限仍然保留（INDEX_MAX_ITEMS / 字符预算），展示窗口从 7 天收到 2 天（2026-11-03），
 * 2026-11-07 主人又改回 3 天（2 天只留 7 条、预算用掉 28%，太少了，记忆召回不完整）。
 *
 * 为什么是"移除"而不是"压缩"：索引每轮都要重读一遍，压成一行也照样每轮付钱。
 *
 * 注意这不是删除：daily-memory.json 保留全量，更早的条目通过归档指针告知
 * 她用 qq_memory_query 检索（2026-10-23 起那条检索路径是真的了，见
 * src/bridge.js 的 searchDailyMemory / GET /api/socialV2/memory）。
 */
export const INDEX_WINDOW_DAYS = 7;
export const INDEX_MAX_ITEMS = 30;
// 归档指针里最多列几个关键词（给太多会占地方，给太少她想不到去查）
export const INDEX_HINT_MAX_KEYWORDS = 6;

/**
 * 把 `YYYY-MM-DD` 解析成 Date（**本地零点**，不是 UTC）。
 *
 * ⚠️ 不能用 `new Date('2026-10-19')`：那会被当成 UTC 零点，在东八区就偏成前一天。
 * 索引里的日期是"那天发生过这件事"，必须按本地日历日算，否则时间窗会错一天。
 */
export function parseLocalDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  // 校验（防 2026-02-31 这种溢出日期被静默接受）
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d;
}

/** 从 `YYYY-MM-DD` 取 `MM-DD` 显示前缀。解析不了就原样返回。 */export function displayPrefix(value) {
  const s = String(value ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[2]}-${m[3]}` : s;
}

/** 按字符预算截断索引条目正文，避免把代理对切一半。 */
function truncateIndexText(text, max) {
  const s = String(text ?? '');
  const limit = Math.max(0, Math.floor(Number(max) || 0));
  if (s.length <= limit) return s;
  let cut = limit;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // 切点在高代理上，前移
  return s.slice(0, cut);
}

/**
 * 按「最近几天 + 时间窗 + 条数上限 + 字符预算」筛出要进索引的条目。
 *
 * 规则（随时间移除，2026-10-23 主人定：记忆要精简，是随时间移除的）：
 *   · 只留最近 INDEX_RECENT_DAYS 天，**逐条**；更早的整条移出索引
 *   · 最外面还有一道 INDEX_WINDOW_DAYS 的硬窗（更早的连归档关键词都算老）
 *   · 总共最多 INDEX_MAX_ITEMS 条、再加字符预算兜底（超了从最旧砍）
 *   · 被移出的条目**一条都不删**，只是不进索引；它们仍然在 daily-memory.json 里，
 *     靠归档指针里的关键词用 qq_memory_query 检索回来
 *
 * ⚠️ 为什么是"移出"而不是"压缩成一行"：索引每轮都要重读一遍，
 *    压成一行也照样每轮付钱。线索由归档关键词承担，不需要额外占位。
 *
 * @param {{items?: Array<{date?:string, items?:string[]}>}} mem 原始记忆
 * @param {{now?:Date, windowDays?:number, maxItems?:number, maxChars?:number, recentDays?:number}} [opts]
 * @returns {{lines:string[], archivedCount:number, keywords:string[], keptDays:number, totalDays:number, staleFallback:boolean, droppedForBudget:number, pinnedCount:number}}
 */
/**
 * 记忆索引的**字符预算**（2026-10-21 主人要求：别让这块把角色卡撑爆、也别太吃 token）。
 *
 * 为什么必须按字符而不是按条数：每条长度差异大（实测 30~50 字符，加上
 * `- 10-21｜私聊100000001｜` 前缀约 22 字符），条数上限给不出体积保证。
 *
 * 真实事故：角色卡 9758 / 注入上限 10000，只剩 242 字符余量，日增约 175 字符
 * —— 一天就会超。超限后 `truncateText` 是**从头砍**，索引在文件末尾，
 * 于是被砍掉的正是最新记忆，还会切在半条中间，连「读法」和结束标记一起消失
 * （已实测确认）。那比少记几条严重得多。
 *
 * 预算怎么定的：
 *   索引块固定开销（标题 + 读法 + 归档指针 + 两个标记）实测 ≈ 420 字符
 *   条目区给 1080 字符 ⇒ 约 18~20 条（每条含前缀 ≈ 60 字符）
 *   块总长 ≈ 1500 字符
 *   正文 8240 + 1500 = 9740，距上限 10000 留 260 字符余量给正文微调。
 * 宁可少记几条最近的事，也不要整块被砍掉。
 */
export const INDEX_MAX_CHARS = 1500;
// 索引块里除了条目之外还有：标题、读法说明、归档指针、两个标记。
// 这些是固定开销，必须先从预算里扣掉，否则条目会把它挤爆。
export const INDEX_BLOCK_OVERHEAD_CHARS = 420;

/**
 * 索引里**逐条保留最近几天**。更早的整条移出，只留在 daily-memory.json。
 *
 * 为什么是"移除"而不是"压缩"：索引每轮都要重读一遍，压成一行也照样每轮付钱。
 * 记忆的价值随天数衰减得很快 —— 前天她吃了什么的细节几乎不影响今天的对话。
 * 所以过了这几天就整条下线，靠归档指针里的关键词（"可搜：临时站、说说…"）
 * 提示她需要时去查，而不是常驻在角色卡里。
 */
export const INDEX_RECENT_DAYS = 3;

/**
 * 约定 / 还欠着的事：**额外保留**，不受上面那 3 天限制。
 *
 * 为什么单独留：这类记忆的价值不在过去而在**未来**。
 * 「说好明天接着玩消消乐」「主人答应给的群号还没给」——过了那几天正是最该被提起的时候，
 * 按普通规则移出索引，就变成"她答应过的事全忘了"。
 *
 * 到期就自然消失：写入时只收 `due ≥ 今天` 的，过了那天自动下线，
 * 不需要人工清理，也不会越攒越多（这是它和"常驻"的区别）。
 */
export const INDEX_PIN_MAX_ITEMS = 4;
// 只说「约定/答应」但没给具体时间 —— 这类是"还欠着的事"，不是安排。
// 给两周宽限：短了会漏掉"主人答应给的群号还没给"这种真正欠着的，
// 长了又变成变相常驻。两周之后要么兑现了、要么早该重新提了。
export const INDEX_PIN_SOFT_DAYS = 14;

/**
 * ── 热条目层（2026-11-09 新增）─────────────────────────────────────────────
 *
 * 为什么要有这一层（实测数据支撑）：
 *   155 条记忆里只有 18 条进索引（最近 3 天），137 条在归档区。
 *   而被真正用起来的 48 条记忆 —— **48 条全部落在归档区**，一条都不在索引里。
 *   也就是说：索引装的几乎只是流水账，最常被想起来的那些事反而看不见。
 *
 * 所以补一层"热条目"：按「被想起过几次 × 时间衰减」挑出最该常驻的几条，
 * 跟约定置顶并列，**不改动**最近 3 天的时间窗规则。
 *
 * 打分公式抄 market 上 prime-memory 的带地板半衰期：
 *     score = hits × max(PIN, 0.5^(天数/HALF_LIFE_DAYS))
 * 关键是那个**地板**：一条好记忆放一年仍有一半分，不会因为老而彻底消失
 * （没有地板的话，30 天前的记忆分数就趋近 0，等于又变回"只看最近"）。
 *
 * 为什么条数这么少（5 条）：预算只有 2061 字符，5 条 × 约 50 字符 = 250 字符。
 * fish-memory 实测 6 条 / 800 字、lite-memory 3 卡 / 1200 字节，5 条在同量级。
 */
export const INDEX_HOT_MAX_ITEMS = 5;
// 半衰期 30 天（与 fish-memory / prime-memory 一致的量级）
export const INDEX_HOT_HALF_LIFE_DAYS = 30;
// 衰减地板：再老也保留一半分数
export const INDEX_HOT_FLOOR = 0.5;
// 进入热条目层的最低门槛：至少要"被想起过" 2 次才算热。
// 1 次的可能只是某轮误召回，不够格占据每轮都要付钱的常驻位。
export const INDEX_HOT_MIN_HITS = 2;

/**
 * 热条目的**退出机制**（2026-11-09 补）。
 *
 * 为什么必须有它：第一版只有"进门"没有"出门" —— 一条记忆只要历史上被想起过 2 次，
 * 就永远有资格竞争那 5 个常驻位。条数上限（5）确实挡住了"撑爆角色卡"，
 * 但它挡住了另一件更该发生的事：**该沉下去的沉不下去**。
 * 这与主人 2026-10-23 定的原则直接冲突：
 *   「记忆就是要精简，也不是重点常驻，是随时间移除的」
 *
 * 所以补一条：多久没再被想起来，就退回归档。
 * 45 天 = 一个半月。选它的理由：热条目的半衰期是 30 天，
 * 45 天意味着"分数已经掉到地板上、而且连续一个半月没人再提" —— 
 * 这时候它占着常驻位，挡的是别人。
 *
 * ⚠️ 退回归档**不是删除**：daily-memory.json 里一字不动，
 * qq_memory_query 照样查得到，条件变了（又被想起）还能再浮上来。
 */
export const INDEX_HOT_STALE_DAYS = 45;


// 相对时间：按条目自己那天的日期往后推，不按"今天"推。
// 10-17 写的"明天接着玩"= 10-18 的约定，而不是今天+1。
const PIN_RELATIVE_DAYS = [
  { re: /大后天/, days: 3 },
  { re: /后天/, days: 2 },
  { re: /第二天|次日/, days: 1 },
  { re: /明天|明日|明儿/, days: 1 }
];
const PIN_WEEKDAY_RE = /(?:下周|下星期|周|星期)([一二三四五六日天])/;
// 绝对日期：`10月25日` 或 `10/25`。**不认** `10-25` ——
// 索引正文里本来就满是 `- 10-17｜…` 这种日期前缀，认它会把每行都当约定。
const PIN_ABS_DATE_RE = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?|(\d{1,2})\s*\/\s*(\d{1,2})/;
// 有这些词才算"约定了什么"。光有"记得"不算 —— 她说话里"记得"太常见。
// ⚠️ `说好` 必须排除 `说好话`（"替鲸鲸向他们说好话"是求情，不是约定，
//    实测就是这么误报的）。
const PIN_WORDS_RE = /约定|说好(?!话)|答应|承诺|提醒我|叫我起床|别忘了|记得叫我/;

function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

/**
 * 估算一条记忆的「约定到期日」—— 识别不出约定就返回 null。
 *
 * @param {{text?:string, parsed?:Date|null}} row
 * @returns {Date|null} 本地零点；null = 不是约定
 */
export function appointmentDue(row) {
  const text = String(row?.text ?? '');
  const base = row?.parsed instanceof Date ? row.parsed : null;
  if (!base || !text) return null;
  if (!PIN_WORDS_RE.test(text)) return null;

  // ① 绝对日期优先（"约定 10月25日"比"明天"更准）
  const abs = text.match(PIN_ABS_DATE_RE);
  if (abs) {
    const month = Number(abs[1] ?? abs[3]);
    const day = Number(abs[2] ?? abs[4]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let due = new Date(base.getFullYear(), month - 1, day);
      // 写在前一年的话（12 月说"1月3日"），算到明年
      if (due < base) due = new Date(base.getFullYear() + 1, month - 1, day);
      return due;
    }
  }

  // ② 相对天数
  for (const { re, days } of PIN_RELATIVE_DAYS) {
    if (re.test(text)) return addDays(base, days);
  }

  // ③ 周几：取条目日期**之后**最近的那个周几（同一天已经过了，不是约定）
  const wd = text.match(PIN_WEEKDAY_RE);
  if (wd) {
    const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
    const target = map[wd[1]];
    if (target !== undefined) {
      let due = addDays(base, 1);
      while (due.getDay() !== target) due = addDays(due, 1);
      return due;
    }
  }

  // ④ 只说了"约定/答应"没给时间 —— 宽限期，到期照样下线
  return addDays(base, INDEX_PIN_SOFT_DAYS);
}

export function selectIndexItems(mem, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const windowDays = Number.isFinite(opts.windowDays) ? Math.max(0, Math.floor(opts.windowDays)) : INDEX_WINDOW_DAYS;
  const maxItems = Number.isFinite(opts.maxItems) ? Math.max(0, Math.floor(opts.maxItems)) : INDEX_MAX_ITEMS;
  const maxChars = Number.isFinite(opts.maxChars) ? Math.max(0, Math.floor(opts.maxChars)) : INDEX_MAX_CHARS;
  // recentDays=0 表示不分层（老的"全部逐条"行为），给测试和回退留一条路。
  const recentDays = Number.isFinite(opts.recentDays)
    ? Math.max(0, Math.floor(opts.recentDays))
    : INDEX_RECENT_DAYS;

  // 本地零点：把"今天"归一成日历日，避免同一天因钟点被算成超窗
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  // 时间窗是**含今天**的：windowDays=7 ⇒ 今天 + 前 6 天
  const earliest = new Date(today);
  earliest.setDate(earliest.getDate() - Math.max(0, windowDays - 1));

  // 逐日展开，同时记下日期，便于按时间序处理
  const flat = [];
  let totalDays = 0;
  for (const day of (mem?.items ?? [])) {
    const dateText = String(day?.date ?? '').trim();
    const parsed = parseLocalDay(dateText);
    totalDays += 1;
    for (const it of (day?.items ?? [])) {
      // 条目现在可能是字符串（旧数据），也可能是 {scope, text}（新数据，带来源会话）。
      // 两种都要能读：旧记忆不能因为格式变了就消失。
      const rawText = (it && typeof it === 'object') ? it.text : it;
      const text = String(rawText ?? '').trim();
      if (!text) continue;
      // scope = 来源会话（group:群号 / private:QQ号），旧数据没有就是空串。
      const scope = (it && typeof it === 'object') ? String(it.scope ?? '').trim() : '';
      // replaces（2026-10-29）：这条记忆**取代**了更早的哪一条（值是原要点的开头几个字）。
      // 为什么要它：状态是会变的。「板子还没做视觉」→「视觉也接上了」两条并存时，
      // 她会同时看到两边，然后挑一个顺眼的说 —— 那不是记性好，是记岔了。
      // 有了 replaces，旧的仍在库里（可检索、可追溯），但**不再进索引**：
      // 索引代表"现在成立的事"，归档代表"曾经发生过的事"。
      const replaces = (it && typeof it === 'object') ? String(it.replaces ?? '').trim() : '';
      const inferred = Boolean(it && typeof it === 'object' && it.inferred);
      flat.push({ date: dateText, parsed, text, scope, replaces, inferred });
    }
  }

  const inWindow = [];
  for (const row of flat) {
    // 日期解析不出来（脏数据）：保守起见**保留**它 —— 宁可多占一点地方，
    // 也不要因为一个格式错误就把真实记忆悄悄丢掉。
    if (!row.parsed || row.parsed >= earliest) inWindow.push(row);
  }

  // 条数上限：从最旧砍（inWindow 已按原顺序 = 时间正序）
  let kept = inWindow;
  if (kept.length > maxItems) {
    kept = kept.slice(kept.length - maxItems);
  }
  // 归档先立空表：窗口外 / 条数外 / 被约定规则挤掉的，最后统一算（见下方 shown）。
  const archived = [];

  // 每行都标出来源会话：`- 10-20｜私聊100000001｜要点`。
  // 为什么要标：她同时面对群聊和好几个私聊，不标来源就会把"谁说的"
  // 记混 —— 这正是记忆串味的核心症状。旧数据没有 scope，就不加那一段。
  const scopeLabel = (scope) => {
    const s = String(scope ?? '').trim();
    if (!s) return '';
    const idx = s.indexOf(':');
    if (idx < 0) return '';
    const kind = s.slice(0, idx);
    const uid = s.slice(idx + 1);
    if (!uid) return '';
    return kind === 'group' ? `群${uid}｜` : `私聊${uid}｜`;
  };

  // ── 随时间移除：只留最近 N 天，更早的**整条移出索引** ───────────────────
  //
  // 索引不是日记本。日记本越写越厚，索引越写越薄才对 ——
  // 她要的是"最近发生了什么"，不是"所有发生过什么"。
  // 所以过了 N 天就整条移出角色卡，只留在 daily-memory.json（外部库）里，
  // 需要时用 qq_memory_query 检索。
  //
  // 为什么不做"更早的每天压成一行"：那仍然是常驻，只是变短了。
  // 记忆的成本是每轮都要重读一遍 —— 压成一行还是每轮都付。
  // 真要命的是"上周聊过临时站"这种线索，而那句话已经由归档指针里的
  // 关键词承担了（可搜：临时站、说说…），不需要再多一行占位。
  const recentCutoff = new Date(today);
  recentCutoff.setDate(recentCutoff.getDate() - Math.max(0, recentDays - 1));
  const isRecent = (row) => !row.parsed || row.parsed >= recentCutoff;

  let recentRows = kept.filter((row) => recentDays === 0 || isRecent(row));

  // ── 约定 / 欠着的事：额外钉住，不受上面那几天限制 ──────────────────────
  //
  // 上面按"最近 N 天"筛，会让「说好明天接着玩」在窗口外整条消失 ——
  // 而那正是最该被提起的时候。所以这里把未到期的约定单独捞出来。
  // `due < today` 的一律不收（到期即下线），且只取最近 INDEX_PIN_MAX_ITEMS 条，
  // 保证它是"少数例外"，不会把索引整体撑回"全量"。
  // 扫描**全部**条目，不只是窗口内的：一条九月写下的「说好十一月一起去」
  // 早就掉出 7 天窗口了，但那条约定本身还没到期 —— 它比什么都该留着。
  const pinned = [];
  for (const row of flat) {
    if (recentRows.includes(row)) continue;
    const due = appointmentDue(row);
    if (due && due >= today) pinned.push({ row, due });
  }
  pinned.sort((a, b) => a.due - b.due);
  const pinnedRows = pinned.slice(0, INDEX_PIN_MAX_ITEMS).map((p) => p.row);
  if (pinnedRows.length) {
    // 按原时间顺序接在最近条目后面（索引整体仍是从旧到新）
    recentRows = [...pinnedRows, ...recentRows].sort((a, b) => {
      const ai = kept.indexOf(a);
      const bi = kept.indexOf(b);
      return ai - bi;
    });
  }
  const pinnedSet = new Set(pinnedRows);

  // 兜底：最近几天一条都没有（比如一周没聊），但库里有记忆。
  // 这时不能给空索引 —— 空索引会被读成"我没有任何记忆"，
  // 比少几条严重得多。改成退一步显示**最近那一天**的记录。
  let staleFallback = false;
  if (recentRows.length === 0 && kept.length > 0) {
    const lastDate = kept[kept.length - 1].date;
    recentRows = kept.filter((row) => row.date === lastDate);
    staleFallback = true;
  }

  // ── 被取代的条目不进索引（2026-10-29）──────────────────────────────────
  //
  // 一条记忆被后来的进展明确取代过（"视觉也接上了"取代"还没做视觉"），
  // 它就不该再出现在"最近发生了什么"里 —— 索引不是历史档案，它代表**现在**。
  // 但**不删**：留在库里，检索时仍能翻到（"你之前说没做视觉，什么时候接的？"）。
  // 匹配用前缀 + 归一化，因为记忆是模型写的，不可能一字不差地复述原文。
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s，。、；：！？"'"'（）()]/g, '');
  const supersededBy = new Map();   // 旧条目的 norm 文本 -> 取代它的那条
  for (const row of flat) {
    if (!row.replaces) continue;
    const key = norm(row.replaces);
    if (!key) continue;
    // 只认"真正指得上的"：旧文本以 replaces 开头，或两者互相包含。
    // 指不上就算了 —— 宁可让旧条目留在索引里（多一条），
    // 也不要因为模型写错一个前缀就把一条真实记忆从索引里悄悄抹掉。
    const target = flat.find((r) => {
      if (r === row) return false;
      if (r.parsed && row.parsed && r.parsed > row.parsed) return false; // 只能取代更早的
      const t = norm(r.text);
      return t.startsWith(key) || key.startsWith(t) || t.includes(key);
    });
    if (target) supersededBy.set(target, row);
  }

  // 真正把它从索引里拿掉。注意这是**过滤 recentRows 本身**，
  // 不只是渲染时跳过 —— 后面的字符预算要按真实的条数算，
  // 否则会以为索引里还压着几条旧账，把还有用的新记忆挤出去。
  if (supersededBy.size > 0) {
    recentRows = recentRows.filter((row) => !supersededBy.has(row));
  }

  // ── 热条目层：把"最常被用起来、却掉出索引"的记忆捞回来（2026-11-09）──────
  //
  // 位置很重要：必须在「被取代过滤」**之后**。被取代的条目代表"曾经成立"，
  // 不该因为历史上被想起过几次就重新占用常驻位 —— 那会让"板子还没做视觉"
  // 和"视觉也接上了"再次同时出现在索引里，正是 2026-10-29 修掉的那个毛病。
  //
  // 打分：hits × max(FLOOR, 0.5^(天数/半衰期))
  //   · hits 来自 bridge 写的 state/memory-hits.json（被想起来几次）
  //   · 衰减带地板，老的记忆不会因为老而彻底归零
  const hotRows = [];
  const hotScores = new Map();
  const hitsMap = (opts.recallHits && typeof opts.recallHits === 'object') ? opts.recallHits : {};
  const hotRowKey = (row) => `${String(row.scope ?? '').trim()}|${String(row.date ?? '').trim()}|${String(row.text ?? '').trim()}`;
  const alreadyShown = new Set(recentRows);
  for (const row of flat) {
    if (alreadyShown.has(row)) continue;          // 已经在最近 3 天里了
    if (supersededBy.has(row)) continue;          // 被取代过的不回索引
    if (row.inferred) continue;                   // 推断出来的不占常驻位（可能是错的）
    const hit = hitsMap[hotRowKey(row)];
    const times = Number(hit && hit.hits) || 0;
    if (times < INDEX_HOT_MIN_HITS) continue;     // 只想起过 1 次的，多半是误召回
    // 退出机制：多久没再被想起就退回归档（2026-11-09）。
    // 没有 lastHit 的按"刚被想起过"处理 —— 旧的账本只有 hits 没有时间，
    // 不能因为字段缺失就把一条真热记忆踢掉。
    const lastHitMs = Number(hit && hit.lastHit);
    if (Number.isFinite(lastHitMs) && lastHitMs > 0) {
      const idleDays = (now.getTime() - lastHitMs) / 86400000;
      if (idleDays > INDEX_HOT_STALE_DAYS) continue;
    }
    const ageDays = row.parsed
      ? Math.max(0, (today.getTime() - row.parsed.getTime()) / 86400000)
      : INDEX_HOT_HALF_LIFE_DAYS * 4;             // 日期坏了的按很老算
    const decay = Math.max(INDEX_HOT_FLOOR, Math.pow(0.5, ageDays / INDEX_HOT_HALF_LIFE_DAYS));
    hotRows.push(row);
    hotScores.set(row, times * decay);
  }
  hotRows.sort((a, b) => (hotScores.get(b) || 0) - (hotScores.get(a) || 0));
  const hotPicked = hotRows.slice(0, Math.max(0, Number(opts.hotMaxItems ?? INDEX_HOT_MAX_ITEMS)));
  const hotSet = new Set(hotPicked);
  if (hotPicked.length) {
    // 接进来后重新按时间排序，索引整体保持"从旧到新"的阅读顺序
    recentRows = [...recentRows, ...hotPicked].sort((a, b) => {
      const ad = a.parsed ? a.parsed.getTime() : 0;
      const bd = b.parsed ? b.parsed.getTime() : 0;
      return ad - bd;
    });
  }

  // 移出索引的全部进归档（可检索）。归档数 = 索引里看不到的条数。
  // 遍历 flat（而不是 kept）：窗口外的、超出条数上限的，同样要能搜到。
  const shown = new Set(recentRows);
  for (const row of flat) {
    if (!shown.has(row)) archived.push(row);
  }

  // 钉住的约定行加个前缀标记，让她一眼看出"这是还没到期的事"，
  // 而不是当成普通旧记忆略过去。
  //
  // `~` 同理：推断出来的记忆（不是对方说的、也不是她亲眼见的）在索引里也带一个，
  // 因为索引是**每轮都读**的那一档 —— 如果连这里都不标，她看见的就是一句
  // 斩钉截铁的事实。标记只占一个字符，比让她把猜测当事实讲便宜得多。
  let lines = recentRows.map((r) => {
    const mark = pinnedSet.has(r) ? '〔约定〕' : '';
    const guess = r.inferred ? '~' : '';
    // 热条目标个〔常想起〕：不标的话她会以为这条也是"最近发生的"，
    // 可能把两周前的事当成今天的接着说。标一下，读的人（她自己）就知道
    // 这条之所以在这里，是因为**重要/常用**，不是因为新。
    const hot = hotSet.has(r) ? '〔常想起〕' : '';
    return `- ${displayPrefix(r.date)}｜${scopeLabel(r.scope)}${mark}${hot}${guess}${r.text}`;
  });

  // ── 字符预算：**从最旧砍**，直到塞进预算 ──────────────────────────────────
  //
  // 为什么不按条数：每条 30~120 字符不等，条数给不出体积保证。
  // 为什么从最旧砍：索引是时间正序，砍最旧能保证"最近的事一定在"；
  // 砍最新会让记忆出现空洞 —— 那是最糟的方向（和条数上限同一原则）。
  // 被砍掉的仍然留在 daily-memory.json 里，只是不进索引，可用 qq_memory_query 查。
  const lineBudget = Math.max(0, maxChars - INDEX_BLOCK_OVERHEAD_CHARS);
  // 循环里会 shift 掉 recentRows，所以先留一份快照给下面的保底用。
  const keptSnapshot = [...recentRows];
  let dropCount = 0;
  let total = lines.reduce((a, l) => a + l.length + 1, 0); // +1 = 换行
  const recount = () => lines.reduce((a, l) => a + l.length + 1, 0);
  while (lines.length > 0 && total > lineBudget) {
    // 砍最旧一条，优先级：普通旧记忆 > 热条目 > 约定。
    // 为什么热条目排在"普通"之后、约定之前：
    //   · 普通旧记忆砍掉还有 qq_memory_query 能查回来，且它本来就快掉出窗口了；
    //   · 热条目之所以热，正是因为它"想不起来就断了"（48 条被用起来的全在归档区），
    //     砍它等于把这一层刚补的价值立刻丢掉；
    //   · 约定是"未来的事"，丢了就是失约，永远最后动。
    let idx = recentRows.findIndex((r) => !pinnedSet.has(r) && !hotSet.has(r));
    if (idx < 0) idx = recentRows.findIndex((r) => !pinnedSet.has(r)); // 只剩热条目和约定
    if (idx < 0) idx = 0; // 只剩约定行时才动它们
    lines = lines.filter((_, i) => i !== idx);
    const dropped = recentRows.splice(idx, 1)[0];
    if (dropped) archived.push(dropped);
    total = recount();
    dropCount += 1;
  }

  // 保底：如果砍到只剩空（极端情况：最新一条本身比预算还长），
  // 至少留**最新那一条**并截断它。宁可留一条不完整的，也不要让她看到"索引是空的"
  // —— 空索引会被读成"我没有任何记忆"，那比少几个字严重得多。
  if (lines.length === 0 && keptSnapshot.length > 0) {
    const last = keptSnapshot[keptSnapshot.length - 1];
    const tag = scopeLabel(last.scope);
    const head = `- ${displayPrefix(last.date)}｜${tag}`;
    const room = Math.max(0, lineBudget - head.length);
    if (room > 8) {
      const truncatedText = truncateIndexText(last.text, room);
      lines = [`${head}${truncatedText}…`];
    } else {
      // 连正文都放不下：只留日期+来源，至少证明"有记忆、是哪边的"
      lines = [head + '（内容过长，已省略，可用 qq_memory_query 查）'];
    }
    // 保底时不算"砍掉"，因为它仍然出现在索引里
    dropCount = Math.max(0, dropCount - 1);
  }

  return {
    lines,
    archivedCount: archived.length,
    keywords: extractKeywords(archived.map((r) => r.text)),
    // 索引里实际还留着几天（预算砍完之后）。staleFallback 时可能是 1 天。
    // ⚠️ 只数**普通**记忆的天数：被钉住的约定可能来自两周前，
    //    热条目更是可能来自一个月前（那正是它存在的意义），
    //    算进去会把标题写成「最近 20 天」，读者会以为整块都是这 20 天的。
    keptDays: new Set(
      recentRows.filter((r) => !pinnedSet.has(r) && !hotSet.has(r)).map((r) => r.date)
    ).size,
    totalDays,
    // 最近 N 天一条都没有、退一步显示"最后一次聊天那天"时为 true。
    // 日志和测试靠它区分"正常"和"最近没聊过天"。
    staleFallback,
    // 新增：这次因为体积预算砍掉了几条（供日志/测试观察）
    droppedForBudget: dropCount,
    // 被"约定"规则额外钉住的条数（这些不受最近 N 天限制）
    pinnedCount: pinnedRows.length,
    // 热条目层实际进了几条（2026-11-09）。这些是"窗口外但最常被用起来"的记忆，
    // 进索引的条件是 hits≥2 且未被取代、非推断。0 表示库里还没有够格的热条目。
    hotCount: hotPicked.filter((r) => recentRows.includes(r)).length,
    // 索引里带 `~` 的推断条数（2026-10-29）：>0 才补一句"读法"，
    // 没有推断就不占那几十个字符 —— 预算只有 1080。
    inferredCount: recentRows.filter((r) => r.inferred).length,
    // 因被后来的事取代而移出索引的条数（这些进了归档，仍可检索）
    supersededCount: supersededBy.size
  };
}

/**
 * 从被归档的条目里抽关键词（人名 / 话题），给归档指针用。
 *
 * 为什么必须有它：只写"更早的若干条已归档，可用 qq_memory_query 检索"
 * 等于没说 —— 她不知道有什么可查，也就不会去查。列几个具体词，
 * 她才能顺着线索想"那次聊的是什么来着"。
 *
 * ⚠️ 第一版用「连续 2~4 字中文片段」抽，结果是「消消乐卡」「在四十关」这种
 *    跨词边界的碎片 —— 她看到"可搜：消消乐卡、在四十关"完全不知道要搜什么。
 *    问题在于中文没有空格，按长度硬切必然切错。所以改成**词典式**抽取：
 *    只认几个明确的高价值类别，宁可少给、但给出来的必须是人能看懂的东西。
 *
 * 抽取优先级：
 *   ① 书名号/引号里的专名（《神的嵌入式教程》、「早安」）
 *   ② 出现过的**英文/数字专名**（Stuccopy、DeepSeek、B站）
 *   ③ 预置的常见人名/平台/话题词表（主人、林青、栖筠、消消乐、B站…）
 *      —— 词表很短，命中就收；命中的词是**整词**，不会切碎
 */
export function extractKeywords(texts, limit = INDEX_HINT_MAX_KEYWORDS) {
  // 预置话题词表。刻意保持短：这些是这本日记里**反复出现**的东西，
  // 而不是通用词。加词的门槛是"她真的提过、且值得回溯"。
  // ⚠️ 2026-11-09：词表扩充。原表 15 个词只覆盖了 155 条记忆里的 43 条（28%），
  //    而实际高频话题（天气/报错/文件/apk/mod/吃饭/水果/板子/硬件）一个都不在表里，
  //    导致归档提示永远只会说「可搜：游戏、手机、语音、消消乐、模拟器、B站」——
  //    与她真实的记忆内容对不上，等于把 88% 的归档记忆藏成"无从查起"。
  //    新增词的纳入标准：在 state/daily-memory.json 里真实出现过 ≥2 次，且是具体话题
  //    （不是「主人」「今天」这类泛词 —— 那些词搜出来全是噪音）。
  const TOPIC_WORDS = [
    // 原有（保留）
    '消消乐', '模拟器', '语音', '起床', '早安', '晚安', 'B站', '说说', '空间',
    '日记', '图库', '表情包', '闹钟', '手机', '游戏',
    // 2026-11-09 新增：真实高频但原表漏掉的
    '天气', '报错', '文件', '吃饭', '水果', '板子', '硬件', '雾霾',
    'apk', 'mod', '固件', '摄像头', '教程', '音乐', '睡觉', '上班', '上课'
  ];
  const rough = [];
  for (const t of (texts ?? [])) {
    const s = String(t ?? '');
    // ① 书名号 / 引号里的专名
    for (const m of s.matchAll(/[「『《【]([^」』》】]{2,12})[」』》】]/g)) rough.push(m[1]);
    // ② 英文/数字专名（连续 ≥3 个字母数字，首字母大写或全大写更像专名）
    for (const m of s.matchAll(/\b([A-Za-z][A-Za-z0-9]{2,})\b/g)) {
      const w = m[1];
      if (/^(the|and|for|with|you|not|are)$/i.test(w)) continue;
      rough.push(w);
    }
    // ③ 词表命中（整词，不切碎）
    for (const w of TOPIC_WORDS) if (s.includes(w)) rough.push(w);
    // ④ 中文人名：紧跟「叫」「是」「喊」等动词后的 2~3 字（"叫她栖筠"→栖筠）
    for (const m of s.matchAll(/(?:叫|喊|是|和|跟)([\u4e00-\u9fa5]{2,3})(?:[，。；、\s]|$)/g)) {
      rough.push(m[1]);
    }
  }

  const counts = new Map();
  for (const w of rough) {
    const k = String(w ?? '').trim();
    if (k.length < 2 || k.length > 14) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  // 排序：先按出现次数，再按"是不是词表里的整词/读起来像专名"
  const isTopic = (w) => TOPIC_WORDS.includes(w);
  const sorted = [...counts.entries()].sort((a, b) => {
    const ta = isTopic(a[0]) ? 1 : 0;
    const tb = isTopic(b[0]) ? 1 : 0;
    return tb - ta || b[1] - a[1] || b[0].length - a[0].length;
  });

  const picked = [];
  for (const [word] of sorted) {
    // 去重叠：已有"消消乐"就不再收"消消"；反过来也成立
    if (picked.some((p) => p.includes(word) || word.includes(p))) continue;
    picked.push(word);
    if (picked.length >= Math.max(0, limit)) break;
  }
  return picked;
}

/**
 * 拼索引块。**用调用方给的行尾**，不再混 LF 进去。
 * @param {string[]} lines 已带 `- MM-DD｜…` 前缀的要点行
 * @param {string} [eol]
 * @param {{archivedCount?:number, keywords?:string[], keptDays?:number}} [meta]
 *        归档信息；给了就追加一行归档指针
 */
export function buildIndexBlock(lines, eol = '\n', meta = null) {
  const count = Array.isArray(lines) ? lines.length : 0;
  // ⚠️ 标题不能机械地写"最近 N 天"：窗口内一条都没有时（比如久没聊过天，
  //    所有条目都超窗了），`keptDays` 是 0，写成"最近 0 天"会让她以为
  //    "我的记忆是空的" —— 而实际只是"最近这段没有记录"。
  //    这种情况改成中性说法，并且**明确说明记忆本身还在**。
  //
  // 🔴 2026-11-03 修一个读起来很误导的说法：`keptDays` 是"**实际有条目的**那几个日期
  //    的去重个数"，不是窗口大小。窗口设成 3 天、但今天还没聊出记忆时，
  //    只剩昨天那一天有条目 ⇒ keptDays=1 ⇒ 标题写"最近 1 天"，
  //    主人看到就会问"这个不是还是一天吗"。
  //    改成把**窗口**和**实际覆盖**分开说：窗口由 windowDays 给，覆盖由 keptDays 给；
  //    两者不一致时补一句"今天还没有新记忆"，让它读起来不是限缩。
  const winDays = Number(meta?.windowDays);
  const keptDays = Number(meta?.keptDays) || 0;
  const windowKnown = Number.isFinite(winDays) && winDays > 0;
  const head = count === 0
    ? '## 记忆索引（每日自动整理）'
    // ⚠️ `keptDays === 0` 但仍有行，说明剩下的**全是**被钉住的约定
    //    （最近几天没聊出普通记忆）。这时不能写"最近 0 天" —— 那读起来像
    //    "我没有任何记忆"，而实际上下面明明列着几件还没到期的约定。
    : (keptDays > 0
        ? (windowKnown && winDays > keptDays
            // 窗口比实际覆盖宽：说明中间那几天没有记录。把窗口说出来，别让标题读成"只有 1 天记忆"。
            ? `## 记忆索引（保留最近 ${winDays} 天，这里有 ${keptDays} 天的记录，每日自动整理）`
            : `## 记忆索引（最近 ${keptDays} 天，每日自动整理）`)
        : '## 记忆索引（每日自动整理）');
  const body = [INDEX_START, head, ...(Array.isArray(lines) ? lines : [])];

  const archived = Number(meta?.archivedCount) || 0;
  // ⭐ 索引是**跨会话共享**的：每个会话被唤醒时，看到的都是同一份列表。
  //    所以必须在块内说清楚"这些事不都是当前这个人说的"。
  //    真人踩过：索引里写着「私聊100000001｜主人答应给小黑盒账号」，
  //    她跟另一个人（私聊100000003）聊天时，把这条说成了"你答应我的"，
  //    对方只能回"我没跟你说过"。
  //    光在角色卡里写规则不够——索引本身一直在暗示"这就是当前的上下文"，
  //    这里补一句，让每条进到任何会话里都不再被误读成"对方说的"。
  if (count > 0) {
    body.push(
      '> 读法：每条前面的「私聊<QQ号>｜」「群<群号>｜」是**这条事发生在哪**。' +
      '这里混着好几段对话的记忆，**只有来源等于当前这个会话的，才算"对方跟我说过的话"**；' +
      '来源是别人的，你知道就好，不要拿去问当前这个人、更不要安到他头上。'
    );
    // 钉住的约定单独说明：它们比日期新，可能夹在中间，不说清会被当成"旧事"跳过。
    const pinned = Number(meta?.pinnedCount) || 0;
    if (pinned > 0) {
      body.push(
        '> 标着〔约定〕的几条是**还没到期的约定 / 对方还欠着的事**（不受"最近几天"限制），' +
        '比日期看着的要紧：到了日子记得主动提，别等对方想起来。'
      );
    }
    // 推断标记的说明：只在真有 `~` 时占字符（2026-10-29）。
    // 为什么会需要有这一句：`~` 自己不会说话。不说清，她可能读成"不确定的事"
    // 而干脆不提；说清了才是"这件事是真的发生过的思考，但**不能当事实讲**"。
    const inferred = Number(meta?.inferredCount) || 0;
    if (inferred > 0) {
      body.push(
        '> 带 `~` 的是**你自己推出来的**（不是对方说的、也不是你亲眼见的）。' +
        '可以提，但要带上"我猜/我记得好像是"，别当成他说过的话去对质。'
      );
    }
  }

  if (archived > 0) {
    const kws = Array.isArray(meta?.keywords) ? meta.keywords.filter(Boolean) : [];
    const kwText = kws.length ? `（可搜：${kws.join('、')}）` : '';
    const lead = count === 0
      ? `> 最近这段没有新记录；更早的 ${archived} 条都在记忆库里，需要时用 qq_memory_query 检索${kwText}。`
      : `> 更早的 ${archived} 条已移出索引（不是删了，还在记忆库里）。想不起来的时候用 qq_memory_query 检索${kwText}。`;
    body.push(lead);
  } else if (count === 0) {
    // 窗口空、且没有归档（记忆库本来就空）—— 说清楚，别让她以为坏了
    body.push('> 记忆库目前是空的，还没有需要记的事。');
  }

  body.push(INDEX_END);
  return eol + eol + body.join(eol);
}

/**
 * 完整的注入：先清干净所有旧块，再在末尾放**唯一**一块。
 * 无论进来时文件里已经有几块（含历史 bug 留下的重复），结果都恰好一块。
 * @returns {{text:string, count:number, eol:string}}
 */
export function injectIndexIntoText(text, lines, meta = null) {
  const s = String(text ?? '');
  const eol = detectEol(s);
  const stripped = stripIndexBlocks(s, eol);
  const base = stripped.text.replace(/[ \t\r\n]+$/, '');
  return { text: base + buildIndexBlock(lines, eol, meta), count: stripped.count, eol };
}

/**
 * 把 daily-memory.json 的 items 展开成要点行（**不过滤**）。
 *
 * ⚠️ 想要"时间窗 + 条数上限"请用 selectIndexItems()。
 *    这个函数保留给需要全量的场合（例如测试里核对归档数）。
 * @param {{items?: Array<{date?:string, items?:string[]}>}} mem
 */
export function memoryToIndexLines(mem) {
  const out = [];
  const scopeLabel = (scope) => {
    const s = String(scope ?? '').trim();
    const idx = s.indexOf(':');
    if (idx < 0) return '';
    const uid = s.slice(idx + 1);
    if (!uid) return '';
    return s.slice(0, idx) === 'group' ? `群${uid}｜` : `私聊${uid}｜`;
  };
  for (const day of (mem?.items ?? [])) {
    const prefix = displayPrefix(day?.date);
    for (const it of (day?.items ?? [])) {
      // 兼容旧字符串条目与新的 {scope,text} 条目
      const text = (it && typeof it === 'object') ? it.text : it;
      if (!String(text ?? '').trim()) continue;
      const tag = (it && typeof it === 'object') ? scopeLabel(it.scope) : '';
      out.push(`- ${prefix}｜${tag}${text}`);
    }
  }
  return out;
}

/**
 * 把提炼模型输出的一行，拆成结构化条目（2026-10-29）。
 *
 * 输入形如：`〔取代:板子还没做视觉〕~视觉也接上了｜详细…`
 * 输出：`{ text:'视觉也接上了', detail:'详细…', inferred:true, replaces:'板子还没做视觉' }`
 *
 * 为什么单独抽成纯函数：
 *   · 两个标记是**提示词约定**，模型未必每次都守。解析的容错得单独测，
 *     不能埋在 distill() 里（那函数要连 DSH、跑模型，测不动）。
 *   · 标记必须**剥掉**而不是原样留着：索引每轮重读，预算只有 1080 字符；
 *     而且留着标记，代码就没法判断"这条能不能当事实讲"。
 *
 * 容错策略：认不出来就原样返回 —— 宁可索引里难看一点，也不能吞掉一条真记忆。
 * @param {string} line 模型输出的一行
 * @param {{clip:(s:string)=>string, hasPipe?:boolean}} opts
 */
export function parseItemLine(line) {
  const s = String(line ?? '').trim();
  const cut = s.indexOf('｜');
  let head = cut >= 0 ? s.slice(0, cut) : s;
  const detail = cut >= 0 ? s.slice(cut + 1).trim() : '';

  // 「〔取代:旧要点开头〕」/「[取代:…]」/「【取代：…】」（全角冒号、三种括号都认）——
  // 提示词里写的是〔〕，但模型经手一次就可能换成【】或 []，不认就得整行原样留下标记。
  let replaces = '';
  const supM = head.match(/^[〔\[【]\s*取代\s*[:：]\s*([^〕\]】]+)[〕\]】]\s*/);
  if (supM) {
    replaces = supM[1].trim();
    head = head.slice(supM[0].length);
  }
  // 「~」/「～」都认：模型时常把半角打成全角。
  let inferred = false;
  const tildeM = head.match(/^[~～]\s*/);
  if (tildeM) {
    inferred = true;
    head = head.slice(tildeM[0].length);
  }
  return { text: head.trim(), detail, inferred, replaces };
}

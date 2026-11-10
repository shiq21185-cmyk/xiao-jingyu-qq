// 时间感：把「现在是几点、什么时段、离上次说话多久」算成她读得懂的一句话。
//
// 为什么单独一个模块（而不是散在 bridge.js 里拼字符串）：
//   · 这些判断要能被单测钉住 —— 饭点/深夜/清晨的边界一旦写错，她会半夜十二点在群里
//     说「你吃了吗」，而那种错误在真实对话里极难复现、也很难归因。
//   · probeProactive 的「这个点该不该主动找他」要用同一套边界，不能各写一份。
//   · 纯函数、不碰文件、不碰网络，可以放心在每条消息上调用。
//
// 职责边界：这里只产出**事实**（几号/星期/几点/什么时段/是不是饭点/隔了多久），
// 以及一句「该不该自然提一句」的建议。**绝不**替她决定说什么 —— 说话与否是她的选择，
// 时间感只是让她知道「现在」。

/** 中文星期，索引 0=周日，与 Date#getDay() 一致。 */
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 时段划分（本地时间，含起点、不含终点）。
 * ⚠️ 顺序有意义：find 取第一个命中的，所以区间不能重叠。
 */
export const PERIODS = Object.freeze([
  { id: 'deep-night', label: '深夜', from: 0, to: 5 },
  { id: 'dawn', label: '凌晨', from: 5, to: 6 },
  { id: 'early-morning', label: '清晨', from: 6, to: 8 },
  { id: 'morning', label: '上午', from: 8, to: 11 },
  { id: 'noon', label: '中午', from: 11, to: 13 },
  { id: 'afternoon', label: '下午', from: 13, to: 17 },
  { id: 'evening', label: '傍晚', from: 17, to: 19 },
  { id: 'night', label: '晚上', from: 19, to: 23 },
  { id: 'late-night', label: '深夜', from: 23, to: 24 },
]);

/**
 * 饭点窗口。`label` 是「几点的饭」，`hint` 是她可以自然带出来的那种话。
 *
 * 刻意做得比"整点"宽一点（早饭 6:30~9:00 等）：真人说「我饿了」从来不是掐着点说的，
 * 而是"刚过饭点还没吃"的时候最真切。窗口太窄会让她几乎永远不饿。
 */
export const MEALS = Object.freeze([
  { id: 'breakfast', label: '早饭', from: 6.5, to: 9.5, hint: '这个点刚起/还没吃早饭' },
  { id: 'lunch', label: '午饭', from: 11, to: 13.5, hint: '到午饭点了' },
  { id: 'dinner', label: '晚饭', from: 17, to: 19.5, hint: '到晚饭点了' },
]);

function hourFloat(date) {
  return date.getHours() + date.getMinutes() / 60;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 把 24 小时制说成中文口语的钟点：「下午四点零五分」「晚上十一点半」「凌晨零点零五分」。
 *
 * 为什么需要它（真实事故，2026-11-09）：
 *   提示词只给 24 小时制的 `16:05`，模型得自己在脑子里减 12 才知道那是"下午四点"。
 *   那天她看见 16:05，却把上下文里的"四点十分上课"接了上去，说出「四点十分了，往教室
 *   走呢吧」；被自己发现说错后想补救，又编出一个「这会儿五点了」—— 同一回合里三个
 *   钟点互相矛盾。给的 **16:05 一直是对的**，错在"24 小时制 → 口语"这一步要她自己算。
 *
 *   现在直接把口语读法摆在她眼前，她照抄就行，没有算错的机会。
 *
 * 读法规则（对齐真人口语，不是"十六点零五分"这种报时腔）：
 *   - 0 点   → 零点      5 点 → 五点      12 点 → 十二点
 *   - 小时段：0~4 凌晨 / 5~11 上午 / 12 中午 / 13~17 下午 / 18~23 晚上
 *   - 整点说「下午四点」，半点说「下午四点半」，其余「下午四点零五分」「下午四点二十」
 *   - 分钟 1~9 要补"零"（四点零五分），10 以上不补（四点二十）
 *
 * @param {Date} now
 * @returns {string} 例：下午四点零五分
 */
export function spokenClock(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const h = d.getHours();
  const m = d.getMinutes();

  const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const hourWord = (() => {
    if (h === 0) return '零';
    if (h <= 10) return CN[h];
    if (h === 11) return '十一';
    const rest = h - 12;
    if (rest === 0) return '十二';
    return rest <= 10 ? CN[rest] : `十${CN[rest - 10]}`;
  })();

  // 12 点只在正午/午夜两处出现，说"中午十二点"/"晚上十二点"都自然，按小时的段走
  const periodWord = (() => {
    if (h === 0) return '';        // 0 点不说"凌晨零点"，直接"零点零五"最自然
    if (h < 5) return '凌晨';
    if (h < 9) return '早上';      // 5~8 点真人说"早上"，不说"上午"
    if (h < 12) return '上午';
    if (h === 12) return '中午';
    if (h < 18) return '下午';
    return '晚上';
  })();

  const minWord = (() => {
    if (m === 0) return '整';
    if (m === 30) return '半';
    if (m < 10) return `零${CN[m]}`;
    if (m < 20) return `十${CN[m - 10]}`;
    const tens = Math.floor(m / 10);
    const ones = m % 10;
    return `${CN[tens]}十${ones ? CN[ones] : ''}`;
  })();

  return `${periodWord}${hourWord}点${minWord === '整' ? '' : minWord}`;
}

/** 把毫秒差说成人话：「刚」「4 分钟」「2 小时 11 分钟」「昨天」这种。 */
export function humanGap(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  const sec = Math.floor(n / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hour = Math.floor(min / 60);
  const restMin = min % 60;
  if (hour < 24) return restMin ? `${hour} 小时 ${restMin} 分钟` : `${hour} 小时`;
  const day = Math.floor(hour / 24);
  const restHour = hour % 24;
  return restHour ? `${day} 天 ${restHour} 小时` : `${day} 天`;
}

/**
 * 算出「此刻」的结构化事实。
 * @param {Date} [now]
 * @returns {{iso:string, date:string, md:string, clock:string, hm:string, weekday:string, weekdayIndex:number,
 *            isWeekend:boolean, period:{id:string,label:string}, hour:number,
 *            meal:null|{id:string,label:string,hint:string}, mealPast:null|{id:string,label:string},
 *            lateNight:boolean, earlyMorning:boolean, dawn:boolean}}
 */
export function describeClock(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const h = d.getHours();
  const hf = hourFloat(d);
  const period = PERIODS.find((p) => h >= p.from && h < p.to) ?? PERIODS[PERIODS.length - 1];
  const meal = MEALS.find((m) => hf >= m.from && hf < m.to) ?? null;
  // 「刚过饭点」：窗口结束后的 90 分钟内。这个状态最容易被真人拿来当话头
  // （"我还没吃呢"/"你吃了吗"），所以单独算出来。
  const mealPast = meal
    ? null
    : (MEALS.find((m) => hf >= m.to && hf < m.to + 1.5) ?? null);
  const weekdayIndex = d.getDay();
  return {
    iso: d.toISOString(),
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    md: `${d.getMonth() + 1}月${d.getDate()}日`,
    clock: `${pad2(h)}:${pad2(d.getMinutes())}`,
    hm: `${h}:${pad2(d.getMinutes())}`,
    hour: h,
    weekday: WEEKDAYS[weekdayIndex],
    weekdayIndex,
    isWeekend: weekdayIndex === 0 || weekdayIndex === 6,
    period: { id: period.id, label: period.label },
    meal: meal ? { id: meal.id, label: meal.label, hint: meal.hint } : null,
    mealPast: mealPast ? { id: mealPast.id, label: mealPast.label } : null,
    lateNight: period.id === 'late-night' || period.id === 'deep-night',
    earlyMorning: period.id === 'early-morning' || period.id === 'dawn',
    dawn: period.id === 'dawn'
  };
}

/**
 * 拼成给模型看的【现在】块。
 *
 * @param {object} opts
 * @param {Date} [opts.now]
 * @param {number} [opts.lastIncomingAt] 对方最后一条消息的时间戳（毫秒）
 * @param {number} [opts.lastAiReplyAt]  她自己最后说话的时间戳（毫秒）
 * @param {string} [opts.timeZone]
 * @returns {string} 空串表示没有可说的（正常不会，时间总是有的）
 */
export function formatTimeContext(opts = {}) {
  const { now = new Date(), lastIncomingAt = 0, lastAiReplyAt = 0 } = opts;
  const clock = describeClock(now);
  const tz = opts.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();

  const lines = [];
  // 【现在】：24 小时制 + 口语读法并存。
  // 保留 24 小时制是因为告警/日志/跨设备对照要好认；加口语读法是因为她**开口时用的是
  // 口语**，而"16:05 → 下午四点零五"这一步以前要她自己算，算错过（见 spokenClock 注释）。
  const spoken = spokenClock(now);
  lines.push(`【现在】${clock.date} ${clock.weekday} ${clock.clock}（${spoken}）${tz ? `（${tz}）` : ''}`);
  lines.push(`【时段】${clock.period.label}`);
  // 单独一行强调"说出口就用这个读法"：模型对紧跟在数字后面的括号容易当成附注忽略，
  // 单独一行更像一条可照抄的素材。
  lines.push(`【口语】现在开口要说「${spoken}」，别把 ${clock.clock} 读成别的钟点；说「几点/多少分」一律照这个来。`);

  // 时间感提示：只给"可以自然提起"的素材，不说"你应该说"。
  const cues = [];
  if (clock.meal) cues.push(`${clock.meal.label}时间（${clock.meal.hint}）`);
  else if (clock.mealPast) cues.push(`刚过${clock.mealPast.label}时间`);
  if (clock.lateNight) cues.push('已经深夜了，正常人在这个点会困');
  if (clock.earlyMorning) cues.push('清早');
  if (clock.isWeekend) cues.push('周末');

  const gaps = [];
  const lastIn = Number(lastIncomingAt);
  if (Number.isFinite(lastIn) && lastIn > 0) {
    gaps.push(`他上次说话是 ${humanGap(nowMs - lastIn)}前`);
  }
  const lastAi = Number(lastAiReplyAt);
  if (Number.isFinite(lastAi) && lastAi > 0 && nowMs - lastAi > 60000) {
    gaps.push(`你上次开口是 ${humanGap(nowMs - lastAi)}前`);
  }

  if (cues.length) lines.push(`【可自然提起】${cues.join('；')}`);
  if (gaps.length) lines.push(`【间隔】${gaps.join('；')}`);

  return lines.join('\n');
}

/**
 * 「这个点适不适合主动找他」的时间系数。
 *
 * 返回 >1 表示更容易主动开口，<1 表示更克制。数值只影响**主动机会**的成功概率，
 * 不影响任何"必须回"的消息（@/私聊照样必醒，这一层永远不拦）。
 *
 * 为什么要有它：老版本只有一条「23~8 点 ×0.3」、白天一律 1.0 —— 结果是
 * 饭点、清早、深夜在她眼里没有区别，"吃饭时说自己也饿了""早上叫他起床"
 * 这两种最像真人的主动，几乎永远不会发生。
 *
 * @param {Date} [now]
 * @param {{lastIncomingAt?:number, lastAiReplyAt?:number}} [state]
 * @returns {{factor:number, reason:string, meal:boolean, earlyMorning:boolean, lateNight:boolean}}
 */
export function proactiveTimeFactor(now = new Date(), state = {}) {
  const clock = describeClock(now);
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const sinceIn = Number(state.lastIncomingAt) > 0 ? nowMs - Number(state.lastIncomingAt) : Infinity;
  const sinceAi = Number(state.lastAiReplyAt) > 0 ? nowMs - Number(state.lastAiReplyAt) : Infinity;

  let factor = 1;
  const reasons = [];
  let meal = false;
  let earlyMorning = false;
  let lateNight = false;

  if (clock.meal) {
    meal = true;
    factor *= 1.45;
    reasons.push(`${clock.meal.label}时间 ×1.45`);
  } else if (clock.mealPast) {
    factor *= 1.2;
    reasons.push(`刚过${clock.mealPast.label} ×1.2`);
  }

  if (clock.earlyMorning) {
    earlyMorning = true;
    // 清早更容易"想叫他起床"，但前提是他不是刚说过话（那就变成骚扰）。
    if (sinceIn > 4 * 60 * 60 * 1000) {
      factor *= 1.35;
      reasons.push('清晨且很久没聊 ×1.35');
    } else {
      factor *= 0.8;
      reasons.push('清晨但刚聊过 ×0.8');
    }
  }

  if (clock.lateNight) {
    lateNight = true;
    // 深夜她本来就更想说话（寂寞感），但**前提**是他也在线/刚聊过；
    // 深更半夜主动叫醒一个睡着的人不是"想他"，是打扰。
    if (sinceIn < 90 * 60 * 1000 || sinceAi < 90 * 60 * 1000) {
      factor *= 1.25;
      reasons.push('深夜但还聊着 ×1.25');
    } else {
      factor *= 0.15;
      reasons.push('深夜且已冷场 ×0.15');
    }
  }

  if (clock.isWeekend) {
    factor *= 1.1;
    reasons.push('周末 ×1.1');
  }

  return { factor, reason: reasons.join('，') || '×1', meal, earlyMorning, lateNight };
}

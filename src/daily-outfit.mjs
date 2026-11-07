/**
 * 每日穿搭轮换（2026-10-30 主人口径：
 *   「我需要的只有让她每天换衣服，同一天穿一件衣服而已，完全不需要她再生成一堆事件」）
 *
 * 这份模块的真相源是**桥接自己的** state/daily-outfit.json：
 *   全天固定一套，跨零点换下一套，一轮之内不重复（按距 1970 的天数 % 套数）。
 *
 * 同时会顺手镜像一份到 <DSH_HOME>/daily-schedule/days/<某天>.json ——
 *   那是 dsh-image-studio 的 lib/schedule-link.js 认的位置（它只读文件，不依赖日程插件是否存在）。
 *   有没有这份镜像都不影响出图：桥接出图时会**显式**带上今天这套（见 bridge.js 的 pickDrawArgs），
 *   镜像只是给「在 DSH 窗口里直接点生成」那条路径兜底。
 *
 * 为什么不再依赖 dsh-daily-schedule 插件（2026-10-30 主人已卸载它）：
 *   它每天都会「编一天」写进日程，再把那段当事实注入上下文，导致她把自己没做过的事当记忆；
 *   而且它 tick() 见到当天文件不存在就重新生成，删文件也拦不住。穿搭这件事不需要它。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 我们写的镜像文件的标记。 */
const SOURCE = 'outfit-only';

/** 默认不进轮换的条目：Q 版那套给成女穿会出错（日程/穿搭只能挂一套给所有人物）。 */
const DEFAULT_EXCLUDE = ['深海女仆装·Q版'];

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 桥接根目录（src/ 的上一级）——state 都放这儿，和别的状态文件一致。 */
function bridgeRoot() {
  // 必须用 fileURLToPath：url.pathname 会把「QQ bot」里的空格留成 %20，
  // 结果在桌面旁边建出一个叫「QQ%20bot」的假目录（2026-10-30 踩过）。
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function stateDir() { return path.join(bridgeRoot(), 'state'); }
function statePath() { return path.join(stateDir(), 'daily-outfit.json'); }
function studioConfigPath() { return path.join(dshHome(), 'image-studio', 'config.json'); }
function scheduleRoot() { return path.join(dshHome(), 'daily-schedule'); }
function daysDir() { return path.join(scheduleRoot(), 'days'); }
function dayFile(dateStr) { return path.join(daysDir(), `${dateStr}.json`); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 本地日期 YYYY-MM-DD（刻意不用 toISOString：那是 UTC，凌晨 0~8 点会算到昨天）。 */
export function localDay(at = Date.now()) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shiftDay(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(delta || 0));
  return d.toISOString().slice(0, 10);
}

/** 服饰库目录：跟 image-studio 的 config.json 走（主人改过库位置也认）。 */
export function outfitsDir() {
  const cfg = readJson(studioConfigPath());
  const dir = cfg && cfg.dirs && typeof cfg.dirs.outfits === 'string' ? cfg.dirs.outfits.trim() : '';
  return dir || path.join(dshHome(), 'image-studio', 'library', 'outfits');
}

/**
 * 服饰库里能进轮换的条目：一个子目录一个条目，名字取 entry.json 的 name（没有就用目录名）。
 * @returns {{ id: string, name: string, dir: string }[]}
 */
export function listOutfits() {
  const root = outfitsDir();
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
  names.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const out = [];
  for (const dirName of names) {
    const dir = path.join(root, dirName);
    const meta = readJson(path.join(dir, 'entry.json'));
    const name = meta && typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : dirName;
    out.push({ id: dirName, name, dir });
  }
  return out;
}

/** 当天轮到的索引：按 1970 起的天数取模，保证同一天恒定、一轮之内不重复。 */
export function pickIndexFor(dateStr, count, offset = 0) {
  if (!count) return -1;
  const days = Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 86400000);
  return ((days + Number(offset || 0)) % count + count) % count;
}

function poolOf(outfits, exclude) {
  const ex = exclude || DEFAULT_EXCLUDE;
  return (outfits || listOutfits())
    .filter((o) => !ex.some((x) => String(x).trim() === o.name || String(x).trim() === o.id));
}

/**
 * 镜像文件里这天已经定下的那套。
 * 用来「首次接管时沿用今天已经穿着的衣服」——同一天不该因为换了换衣机制就换一身。
 */
export function outfitInDayFile(dateStr, minute = null) {
  const day = readJson(dayFile(dateStr));
  if (!day || !Array.isArray(day.items)) return '';
  const clock = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
    if (!m) return null;
    const v = Number(m[1]) * 60 + Number(m[2]);
    return v >= 0 && v <= 1440 ? v : null;
  };
  const pick = (it) => (it && typeof it.outfit === 'string' ? it.outfit.trim() : '');
  if (minute !== null) {
    for (const it of day.items) {
      const a = clock(it && it.start);
      const b = clock(it && it.end);
      if (a === null || b === null) continue;
      if (a <= minute && minute < b && pick(it)) return pick(it);
    }
  }
  for (const it of day.items) if (pick(it)) return pick(it);
  return '';
}

/** 读桥接自己的穿搭记录。 */
function readState() {
  const st = readJson(statePath());
  return st && typeof st === 'object' ? st : {};
}

function writeState(st) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(statePath(), `${JSON.stringify(st, null, 2)}\n`);
    return true;
  } catch { return false; }
}

/** 镜像一份「只有 outfit 的单段」到 image-studio 认的位置；失败不影响主流程。 */
function mirrorDay(dateStr, outfit) {
  try {
    const now = new Date().toISOString();
    fs.mkdirSync(daysDir(), { recursive: true });
    fs.writeFileSync(dayFile(dateStr), `${JSON.stringify({
      date: dateStr,
      dayType: { id: 'outfit-only', name: '穿搭' },
      title: '',
      mood: '',
      hint: '',
      items: [{ start: '00:00', end: '24:00', activity: '', location: '', detail: '', outfit, outfitNote: '' }],
      source: SOURCE,
      generatedAt: now,
      dressedAt: now,
    }, null, 2)}\n`);
  } catch { /* 镜像失败无所谓：出图那条路径是显式带 outfits 的 */ }
}

/**
 * 今天穿哪套（唯一入口）。
 * 已有记录且日期是今天 → 原样返回；否则按轮换算出新的一套并落盘。
 * @returns {{ date: string, outfit: string, changed: boolean, count: number, error?: string }}
 */
export function todayOutfitDetail({ cfg, now = Date.now(), persist = true } = {}) {
  const opt = (cfg && cfg.socialV2 && cfg.socialV2.dailyOutfit) || {};
  const exclude = Array.isArray(opt.exclude) && opt.exclude.length ? opt.exclude : DEFAULT_EXCLUDE;
  const offset = Number(opt.offset) || 0;
  const date = localDay(now);
  const pool = poolOf(listOutfits(), exclude);
  const st = readState();

  // 同一个日期就固定那一套（不因为中途改了库而换衣服）。
  if (st.date === date && typeof st.outfit === 'string' && st.outfit.trim()) {
    mirrorDay(date, st.outfit.trim());
    return { date, outfit: st.outfit.trim(), changed: false, count: pool.length };
  }

  if (!pool.length) return { date, outfit: '', changed: false, count: 0, error: `服饰库是空的（${outfitsDir()}）` };

  // 第一次接管（或状态刚被清）时，今天如果已经有镜像写着穿搭，就沿用它 ——
  // 上午已经穿出去的衣服，不该因为换了个记录位置就换掉。
  let outfit = '';
  if (!st.date || !st.outfit) {
    const minute = new Date(now).getHours() * 60 + new Date(now).getMinutes();
    const existing = outfitInDayFile(date, minute);
    if (existing && pool.some((o) => o.name === existing)) outfit = existing;
  }
  if (!outfit) outfit = pool[pickIndexFor(date, pool.length, offset)].name;

  if (persist) {
    const history = Array.isArray(st.history) ? st.history.slice(-60) : [];
    if (st.date && st.outfit) history.push({ date: st.date, outfit: st.outfit });
    writeState({ date, outfit, updatedAt: new Date().toISOString(), history });
    mirrorDay(date, outfit);
  }
  return { date, outfit, changed: true, count: pool.length };
}

/** 现在轮到哪一套（给日志/工具/控制台看；不会写盘以外的东西）。 */
export function todayOutfit({ cfg, now = Date.now() } = {}) {
  try { return todayOutfitDetail({ cfg, now }).outfit || ''; } catch { return ''; }
}

/** 出图用：今天这套的名字；没排上就返回空串（让插件走它自己的兜底，别硬塞）。 */
export function outfitForDraw(now = Date.now()) {
  try {
    const st = readState();
    const date = localDay(now);
    if (st.date === date && typeof st.outfit === 'string' && st.outfit.trim()) return st.outfit.trim();
    // 没排过（刚装/刚清过状态）→ 当场算一套并落盘。
    return todayOutfitDetail({ now }).outfit || '';
  } catch { return ''; }
}

/**
 * 巡检入口：保证今天这套定了、并且镜像文件在。
 * 幂等、便宜（读 1 个目录 + 1 个小 JSON），每分钟调一次也没关系。
 */
export function ensureDailyOutfits({ cfg, now = Date.now() } = {}) {
  const opt = (cfg && cfg.socialV2 && cfg.socialV2.dailyOutfit) || {};
  if (opt.enabled === false) return { skipped: true, today: null };
  const r = todayOutfitDetail({ cfg, now });
  // 昨天也补一个镜像，避免「昨晚跑着的图跨零点」拿不到穿搭。
  if (r.outfit) {
    const y = shiftDay(r.date, -1);
    const prev = readJson(dayFile(y));
    if (!prev) {
      const st = readState();
      const old = (Array.isArray(st.history) ? st.history : []).filter((h) => h && h.date === y && h.outfit);
      if (old.length) mirrorDay(y, old[old.length - 1].outfit);
    }
  }
  return { today: r };
}

// ---- 命令行：node src/daily-outfit.mjs [--write] ----
const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const write = process.argv.includes('--write');
  const pool = poolOf(listOutfits());
  console.log(`服饰库：${outfitsDir()}`);
  console.log(`可轮换：${pool.length} 套（已排除 ${DEFAULT_EXCLUDE.join('、')}）`);
  pool.forEach((o, i) => console.log(`  ${String(i + 1).padStart(2)}. ${o.name}`));
  const st = readState();
  console.log('');
  console.log(`记录文件：${statePath()}`);
  console.log(`昨天：${st.history?.length ? (st.history.slice().reverse().find((h) => h.date === shiftDay(localDay(), -1))?.outfit ?? '（无）') : '（无）'}`);
  console.log(`今天：${st.date === localDay() ? `${st.outfit}（已定）` : '还没排'}`);
  const next = shiftDay(localDay(), 1);
  console.log(`明天：${pool[pickIndexFor(next, pool.length)]?.name ?? '-'}（按轮换）`);
  if (write) {
    const r = todayOutfitDetail({ persist: true });
    console.log(`\n已确认今天 = ${r.outfit || '-'}${r.error ? ` 错误：${r.error}` : ''}`);
  }
}

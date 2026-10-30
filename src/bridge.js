// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { extractPresetPrefix, presetPromptBlockers, presetPromptWarnings, renderPresetPromptYaml } from './preset-prompt.js';
import { GEN1_ROLE_LINE_RE, parseRoleSections, roleCharStats, roleSectionReport, selectRoleText } from './role-card.js';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './dsh-client.js';
import { mdToPlain, splitForQQ, truncateText, truncateTextTail } from './md-to-plain.js';
import { SENSITIVE_RE } from './sensitive.js';
import { looksLikeUnfinished } from './v2-wait.js';
import { compactModelMessage } from './qq-model-view.js';
import { safeFetchBuffer, looksLikeImageBuffer, downloadToFile } from './safe-fetch.js';
import { AUDIO_EXTS, cleanupTemp, describeAudio, formatBytes, formatDuration, inspectAudio, listAudioFiles, parseTargetKey, processAudioVolume, resolveAudioProcessing, resolveAudioSource, safeJoinLibrary } from './send-voice-lib.js';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint, persistToken } from './snowluma-conn.js';
import { hardenDir, manualDirCommand } from './state-acl.mjs';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from './forward.js';
import { resolvePriceTable, normalizeUsage, ratesAt } from './model-prices.js';
import { createTokenLedger, usageOfEvent } from './token-ledger.js';
import { DIARY_NUDGE_FROM_HOUR, diaryBrief, diaryDay, diaryNudgeGate, diaryReadDay, diaryRecent, diaryStats, diaryTodayCount, diaryWrite, formatDiaryEntries } from './diary-lib.js';
import {
  PERMIT_SCOPES,
  activeGrant,
  createRequest,
  formatRemaining,
  isKnownScope,
  permitFilePath,
  prunePermits,
  readPermitFile,
  resolveGrant,
  writePermitFile
} from './permit-lib.js';
import { describeClock, formatTimeContext, humanGap, proactiveTimeFactor } from './time-context.js';
import { createAsr, ASR_DEFAULT_TOOLS_DIR } from './asr-lib.js';
import { cleanupSpeech, createTts, newSpeechPath } from './tts-lib.js';
import {
  loadSlang,
  saveSlang,
  upsertSlangEntry,
  buildSlangContext,
  buildExtractionPrompt,
  buildResearchPrompt,
  parseExtractionJson,
  parseResearchJson,
  createSlangEntry,
  mergeEvidence,
  SLANG_STATUS,
  SLANG_MAX_ENTRIES
} from './slang-learner.js';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed
} from './sticker-lib.js';
// 群图媒体库（src/media-lib.js：感知去重 dHash/fileid + 四层图库，纯 Node 标准库实现）。
// 与上面的「QQ 收藏表情库」是**两套并存**的东西，不要合并：
//   收藏表情：QQ 账号里的、有 emoji_id、可以用 qq_send_sticker 发
//   群图库：  群友发的图片、桥接本地存的、只能用 qq_send_photo 发
import {
  MediaLibrary,
  buildPhotoContext,
  sharpAvailable,
  MEDIA_DEFAULTS
} from './media-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// 日记本目录（她自己的本子）：YYYY-MM-DD.jsonl，一行一条，只增不改不删。
// 默认 data/日记，但可以用 config.json 的 socialV2.diary.dir 指到别处
// （例如放到桌面单独一个文件夹，方便随时翻看，也不跟着仓库走）。
//
// 分两层，各有分工：
//   · resolveDiaryDir(cfg) —— **纯函数**：给一份 config，返回绝对路径。可单测、不看时钟。
//   · DIARY_DIR / diaryDir() —— 进程内的实际值：main() 里 loadConfig() 之后写一次，
//     之后所有读写都走 diaryDir()。**不要**在模块顶层直接读 config：那时还没加载。
const DIARY_DIR_DEFAULT = path.join(ROOT, 'data', '日记');
let DIARY_DIR = DIARY_DIR_DEFAULT;
let diaryDirCache = null;

/**
 * 把 config 里的日记目录解析成绝对路径。**纯函数**，不读文件、不改外部状态。
 *
 * 规则（每条都有回归测试，见 scripts/test-audit-diary-dir.mjs）：
 *   · 没配 / 空串 / 怪值 → 回到默认的仓库内 data/日记（老日记不能因为这次改动"消失"）；
 *   · `~` 展开成用户主目录（配置里写 `~/Desktop/日记` 更顺手）；
 *   · 相对路径按**仓库根（ROOT）**解析，不按 process.cwd()（桥接从哪启动都有可能）；
 *   · 绝对路径原样用（只做 normalize）。
 */
function resolveDiaryDir(cfg) {
  const raw = cfg?.socialV2?.diary?.dir;
  if (raw === undefined || raw === null) return DIARY_DIR_DEFAULT;
  const text = String(raw).trim();
  if (!text) return DIARY_DIR_DEFAULT;
  const expanded = text.replace(
    /^~(?=$|[\\/])/,
    process.env.USERPROFILE || process.env.HOME || ''
  );
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(ROOT, expanded);
}

/**
 * 当前生效的日记目录。main() 已经把 DIARY_DIR 算好了，这里直接返回。
 *
 * 兜底：如果有人在 main() 之前就调用（例如自检脚本），缓存还是空的 —— 那时按需读一次
 * config.json 现算，**不要**让它抛出，日记功能不该因为读不到配置就整个失效。
 */
function diaryDir() {
  if (diaryDirCache) return diaryDirCache;
  let file = null;
  try {
    file = readJsonSafe(path.join(ROOT, 'config.json'), null, true);
  } catch {
    // 读不动就走默认
  }
  diaryDirCache = resolveDiaryDir(file);
  return diaryDirCache;
}

/**
 * 她写完日记后，顺手把 HTML 阅读器重新生成一遍。
 *
 * 阅读器工具放在仓库外（默认 ../AI work/日记工具），不混进日记库——
 * 日记目录只该有 .jsonl 数据。生成器的位置按下列顺序找：
 *   1) config.json 的 socialV2.diary.viewerDir
 *   2) <桌面>/AI work/日记工具
 *   3) <仓库上级>/AI work/日记工具
 * 全程 best-effort：不存在就跳过，绝不因为「没装阅读器」而影响写日记。
 */
let diaryViewerBusy = false;
function diaryViewerDir() {
  let configured = '';
  try {
    const file = readJsonSafe(path.join(ROOT, 'config.json'), null, true);
    configured = file?.socialV2?.diary?.viewerDir ?? '';
  } catch {
    // 读不动就走下面的自动探测
  }
  if (typeof configured === 'string' && configured.trim()) {
    const p = configured.trim();
    return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
  }
  const desktop = path.join(os.homedir(), 'Desktop');
  for (const cand of [
    path.join(desktop, 'AI work', '日记工具'),
    path.join(path.dirname(ROOT), 'AI work', '日记工具')
  ]) {
    if (fs.existsSync(path.join(cand, 'build.mjs'))) return cand;
  }
  return '';
}

function rebuildDiaryViewer() {
  if (diaryViewerBusy) return;         // 防抖：连续写多条时只跑最后一次
  diaryViewerBusy = true;
  setTimeout(() => {
    diaryViewerBusy = false;
    try {
      const viewer = diaryViewerDir();
      if (!viewer) return;             // 没装阅读器 → 静默跳过
      const builder = path.join(viewer, 'build.mjs');
      if (!fs.existsSync(builder)) return;
      // 同步跑（读文件 + 字符串替换，几十毫秒）。timeout 兜底：
      // 万一生成器写挂了，不能让桥接卡死。
      execFileSync(process.execPath, [builder, diaryDir()], {
        cwd: viewer, windowsHide: true, stdio: 'ignore', timeout: 15000
      });
    } catch {
      // 阅读器重建失败不影响日记本身
    }
  }, 800);
}
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
// 每日记忆归档（由 plugins/qq-memory-rollover 写入、并注入角色卡的「记忆索引」块）。
// ⚠️ 这里必须有一条**读取**路径：索引块会告诉她「更早的 N 条已归档，可用
//    qq_memory_query 检索」，如果桥接根本没读过这个文件，那句话就是假的。
//    2026-10-23 实测：daily-memory.json 在 src/ 下出现 0 次，那 8 条归档永远查不到。
const DAILY_MEMORY_FILE = path.join(STATE_DIR, 'daily-memory.json');
// 「被想起」的记账本（2026-10-29）：桥接对 daily-memory.json 只读，写入权归
// plugins/qq-memory-rollover。所以命中次数单独放一个文件，两边不抢同一份。
const RECALL_HITS_FILE = path.join(STATE_DIR, 'memory-hits.json');
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
// 「向我申请」的授权表。**必须落文件**：执行判定在 DSH 进程的守卫里（见
// plugins/qq-agent-presets/qq-tool-restrict.mjs），与桥接是两个进程，内存变量它看不见。
const PERMIT_FILE = permitFilePath(ROOT);
// 群图媒体库：图片字节 + index.json。**刻意放在 state/ 之外**——
// 这里会有成百上千张图片，混进 state/ 会让 ACL 收紧、备份和排查都变难。
// 与「小鲸鱼的图库」（她自己挑着收的相册）也不是一回事：那个是她的纪念册，这个是素材库。
const MEDIA_LIB_DIR_DEFAULT = path.join(ROOT, 'media');
// 联网下载的文件落这里（socialV2.file.dir 的默认值）。和 media/ 分开：
// 那些是"别人发来的图"，这些是"她自己下回来的文件"，混一起清理时会互相踩。
//
// 而且**刻意放在仓库外面**（上一级）：这是主人要"之后自己处理"的东西，
// 跟着 git 走只会被 .gitignore 忽略掉、还得摸到仓库里翻；放在
// `桌面\QQ bot\小鲸鱼下载\` 跟 media/、小鲸鱼的图库 并列，他能直接点开。
// 下面按 `YYYY-MM-DD/` 分袋，一天一个文件夹，过期整袋删。
const DOWNLOAD_DIR_DEFAULT = path.join(ROOT, '..', '小鲸鱼下载');
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
const TOKEN_USAGE_FILE = path.join(STATE_DIR, 'token-usage.jsonl');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
// 她**亲口说出去**的语音原文，一天一个 jsonl。
// 为什么需要它：语音条的消息体只有一段 record（音频文件），正文是空的，
// 所以 messages.db 里那条记录看不到她说了什么；于是记忆整理（读 messages.db）
// 只会看到「主人的话」，她的那一半永远是 `[语音 5.2s]`。
// 这里补的就是她的那一半：整理记忆时按日期读回去，当成「[小鲸鱼自己] …」拼进逐字稿。
// ⚠️ 只记"说了什么"，不记音频路径 —— 音频是临时文件，早删了。
const SENT_VOICE_DIR = path.join(STATE_DIR, 'sent-voice-logs');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');
// 身体的「表现参数」（音量、停顿判定、单句上限…）。
// ⚠️ 这份文件是**跨进程契约**：控制台（本进程）写，`rot/tools/body_config.py`（另开的一个
//    python 进程）读。所以字段名和单位在这里定死，改一边必须改另一边：
//      volume      0~1.5 的增益倍数（1.0 = 原样，>1 会削顶）
//      silenceSec  判断“说完了”的静音时长（秒）
//      maxSec      单句最长录多少秒
//      waitSec     等对方开口的最长秒数
//      cue         是否在开始收录前“叮”一声
//      base        MQTT 主题前缀（要和固件 config.h 的 TOPIC_BASE 一致）
//      broker      MQTT broker 主机名
//    少写一个默认值就会让 python 那边 KeyError，所以 DEFAULTS 与 body_config.py 必须一一对应。
const BODY_CONFIG_FILE = path.join(STATE_DIR, 'body-config.json');
const BODY_CONFIG_DEFAULTS = Object.freeze({
  volume: 0.85,
  silenceSec: 2,
  maxSec: 25,
  waitSec: 120,
  cue: true,
  base: 'whale-1bb62897',
  broker: 'i1e78188.ala.cn-hangzhou.emqxsl.cn',
  // broker 的端口 / 是否 TLS。EMQX Serverless 只开 8883+TLS，
  // 公共 broker 则要改回 1883/false。
  brokerPort: 8883,
  brokerTls: true,
  // MQTT 账号密码。空串 = 匿名（公共 broker）。
  // ⚠️ 只存在本机的 state/body-config.json 里，**绝不**写进仓库源码。
  mqttUser: '',
  mqttPass: '',
  // 板子的工作模式：gate = 室内（本地人声门限，有人说话才上传）
  //               btn  = 随身（只有按键才上传，外面吵也不误传）
  // 这个值不是给 python 用的，是给板子用的 —— 存这里只是为了控制台有个地方记着，
  // 保存时 bridge 会顺手 spawn tools/body_mode.py 把它推给板子（板子自己存 NVS）。
  boardMode: 'gate',
  // 下行音频编码（电脑 → 板子喇叭）：
  //   pcm  = 裸 PCM，32KB/s，板子只搬运不解码
  //   opus = Opus 约 2KB/s，板子现场解码（解码跟不上就会「前面正常后面卡」）
  downCodec: 'pcm'
});

/**
 * 把任意输入夹成合法的身体配置。**越界的值一律钳制而不是报错**：
 * 控制台是个滑杆，网络抖一下传个 85（百分数）进来，钳成 1.5 至少还能用；
 * 直接 400 会让用户以为“保存坏了”。
 */
function normalizeBodyConfig(input, base = BODY_CONFIG_DEFAULTS) {
  const source = input && typeof input === 'object' ? input : {};
  const pick = (key) => (source[key] !== undefined ? source[key] : base[key]);
  const num = (key, min, max) => {
    const n = Number(pick(key));
    if (!Number.isFinite(n)) return base[key];
    return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
  };
  const str = (key) => String(pick(key) ?? '').trim();
  return {
    volume: num('volume', 0, 1.5),
    silenceSec: num('silenceSec', 0.5, 8),
    maxSec: num('maxSec', 3, 120),
    waitSec: num('waitSec', 5, 600),
    cue: pick('cue') !== false && pick('cue') !== 'false',
    // 声音走公网 MQTT 之后的两个定位参数：主题前缀 + broker 地址。
    // 前缀必须和固件 config.h 里的 TOPIC_BASE 一致，否则两边各说各话、永远收不到。
    base: str('base') || BODY_CONFIG_DEFAULTS.base,
    broker: str('broker') || BODY_CONFIG_DEFAULTS.broker,
    // ⚠️ 这四个**必须**列出来。normalizeBodyConfig 是「读出旧值 → 归一化 → 写回」的
    // 中间层，少一个字段就等于控制台每点一次保存就把它清一次默认值。
    // 2026-10-28 的故障就是这么来的：端口/账号被悄悄改回 8883/空，
    // 板子连不上 EMQX，而控制台显示「✅ 已保存」。
    brokerPort: num('brokerPort', 1, 65535),
    brokerTls: pick('brokerTls') !== false && pick('brokerTls') !== 'false',
    mqttUser: str('mqttUser'),
    // 密码不 trim（首尾空格可能是密码的一部分，@ 开头的更要原样保留）
    mqttPass: String(pick('mqttPass') ?? ''),
    // 下行编码：只认 opus，其它一律当 pcm。
    downCodec: str('downCodec') === 'opus' ? 'opus' : 'pcm',
    boardMode: str('boardMode') === 'btn' ? 'btn' : 'gate'
  };
}
/**
 * 板子在不在线 —— 看 broker 上有没有它的心跳。
 *
 * 以前是往板子发 UDP PING（声音还在局域网上跑的那会儿）。改走公网 MQTT 之后，
 * 板子跟这台电脑不在同一个网段，UDP 那条路整个不通，也没法知道它的 IP ——
 * 现在唯一可靠的判据就是「它每 5 秒往 <base>/state 发的那条 JSON」。
 *
 * 探测本身交给 rot/tools/body_probe.py（Python 那边有 paho-mqtt，Node 这边不装依赖）。
 * 最多等 8 秒：板子 5 秒一次心跳，等 8 秒还没等到就是真不在线。
 */
const BODY_PROBE_PYTHON = path.join(ROOT, 'tools', 'asr', '.venv', 'Scripts', 'python.exe');

/**
 * 找身体工作区（那个 `rot` 目录）。
 *
 * 不写死绝对路径（仓库要能公开、能换机器），按顺序猜：
 *   1. 环境变量 QQBRIDGE_BODY（一键启动那边也是这个名字）
 *   2. 仓库上一层的 rot（Desktop\rot，当前的实际情况）
 *   3. 仓库同级的 rot（QQ bot\rot）
 * 找到哪个有 tools/body_probe.py 就用哪个；都找不到就返回 null。
 */
function findBodyTool(name) {
  const candidates = [];
  const envBody = String(process.env.QQBRIDGE_BODY ?? '').trim();
  if (envBody) candidates.push(path.join(envBody, 'tools', name));
  candidates.push(path.join(path.dirname(path.dirname(ROOT)), 'rot', 'tools', name));
  candidates.push(path.join(path.dirname(ROOT), 'rot', 'tools', name));
  candidates.push(path.join(ROOT, 'tools', name));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findBodyProbeScript() {
  return findBodyTool('body_probe.py');
}

/**
 * 把板子的工作模式推过去（室内/随身）。
 *
 * 为什么要 bridge 亲自跑：板子的模式存在它自己的 NVS 里，只有往 MQTT 发一条
 * `MODE 0/1` 才能改。控制台是浏览器，浏览器不会说 MQTT —— 所以在保存配置时
 * 由 bridge spawn 一次性脚本 `tools/body_mode.py` 去发那条消息，并把板子的
 * 确认（它回的 state 里 mode 变了）带回来给页面显示。
 *
 * 失败不影响"参数已保存"：板子可能没上电，等它上电了 body_talk 每轮会自检一次。
 */
function bodySetMode(base, broker, mode, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const script = findBodyTool('body_mode.py');
    if (!script) { resolve({ ok: false, error: '找不到 tools/body_mode.py' }); return; }
    if (!fs.existsSync(BODY_PROBE_PYTHON)) {
      resolve({ ok: false, error: '找不到她 ASR 那个 venv 的 python' });
      return;
    }
    let chunks = [];
    let settled = false;
    const text = () => Buffer.concat(chunks).toString('utf8');
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(BODY_PROBE_PYTHON, [
        script,
        mode,
        '--base', base,
        '--broker', broker,
        '--timeout', String(Math.max(3, Math.round(timeoutMs / 1000)))
      ], {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, error: `${timeoutMs}ms 内板子没确认` });
    }, timeoutMs + 4000);
    child.stdout?.on('data', (b) => { chunks.push(b); });
    child.stderr?.on('data', (b) => { chunks.push(b); });
    child.on('error', (error) => finish({ ok: false, error: String(error?.message ?? error) }));
    child.on('close', (code) => {
      const lines = text().trim().split(/\r?\n/).filter(Boolean);
      const last = lines.slice(-1)[0] || '';
      finish({
        ok: code === 0,
        mode,
        detail: last,
        error: code === 0 ? '' : (last || `退出码 ${code}`)
      });
    });
  });
}

function bodyProbe(base, broker, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!base) { resolve({ ok: false, error: '没配置主题前缀（base）' }); return; }
    const script = findBodyProbeScript();
    if (!script) {
      resolve({ ok: false, error: '找不到身体的 tools/body_probe.py（设 QQBRIDGE_BODY 指过去）' });
      return;
    }
    if (!fs.existsSync(BODY_PROBE_PYTHON)) {
      resolve({ ok: false, error: '找不到她 ASR 那个 venv 的 python（paho-mqtt 装在那儿）' });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(BODY_PROBE_PYTHON, [
        script,
        '--base', base,
        '--broker', broker,
        '--timeout', String(Math.max(2, Math.round(timeoutMs / 1000)))
      ], {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, error: `${timeoutMs}ms 内没看到板子心跳` });
    }, timeoutMs + 4000);
    child.stdout?.on('data', (b) => { out += String(b); });
    child.stderr?.on('data', (b) => { err += String(b); });
    child.on('error', (error) => finish({ ok: false, error: String(error?.message ?? error) }));
    child.on('exit', (code) => {
      if (code === 0) finish({ ok: true, detail: out.trim() });
      else {
        const tail = (err.trim() || out.trim()).split('\n').filter(Boolean).pop() || `退出码 ${code}`;
        finish({ ok: false, error: tail });
      }
    });
  });
}

/**
 * 让她用**屋里的喇叭**说一句话（2026-10-28，主人 m13018）。
 *
 * 方向：她 → 板子。跟 `bodyProbe` / `bodySetMode` 一样是"一次性脚本 + 收尾码"，
 * 但不是探活，而是要跑十几秒（合成 + 按节拍推 + 等板子放完）。
 *
 * 为什么桥接亲自跑、而不是让 MCP 直接连 MQTT：桥接进程里没有 mqtt 库
 * （`package.json` 的依赖里没有），而 `tools/asr/.venv` 里 paho / edge-tts 都装好了。
 * 音色、音量、下行编码热切换、垫底节拍全在 `body_talk.speak()` 里——那些参数是
 * 拿十几轮实机卡顿换来的，绝不能在这里重写一遍。
 *
 * @returns {Promise<{ok:boolean, detail?:string, error?:string, code?:number}>}
 */
function bodySay(config, text, volume = 0, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const say = String(text ?? '').trim();
    if (!say) { resolve({ ok: false, error: '没有要念的话' }); return; }
    const script = findBodyTool('body_say.py');
    if (!script) {
      resolve({ ok: false, error: '找不到身体的 tools/body_say.py（设 QQBRIDGE_BODY 指过去）' });
      return;
    }
    if (!fs.existsSync(BODY_PROBE_PYTHON)) {
      resolve({ ok: false, error: '找不到她 ASR 那个 venv 的 python（edge-tts 装在那儿）' });
      return;
    }
    const args = [script, '--text', say, '--base', config.base, '--broker', config.broker];
    if (Number(volume) > 0) args.push('--volume', String(Number(volume)));
    let out = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(BODY_PROBE_PYTHON, args, {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, error: `${Math.round(timeoutMs / 1000)} 秒还没念完（板子卡了？）`, code: -1 });
    }, timeoutMs);
    child.stdout?.on('data', (b) => { out += String(b); });
    child.stderr?.on('data', (b) => { out += String(b); });
    child.on('error', (error) => finish({ ok: false, error: String(error?.message ?? error) }));
    child.on('close', (code) => {
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      const detail = lines.filter((l) => l.startsWith('✅')).join(' | ') || lines.slice(-1)[0] || '';
      if (code === 0) {
        finish({ ok: true, detail, code: 0 });
        return;
      }
      // 退出码 1 = 参数/板子不在线/合成失败；2 = 板子在线但链路有抖动。
      // 两者都要把脚本最后一行原话带回去 —— 那里写着**为什么**（前缀不对？没上电？）。
      const why = lines.filter((l) => l.startsWith('❌') || l.startsWith('⚠️')).join(' | ')
        || lines.slice(-1)[0] || `退出码 ${code}`;
      finish({ ok: false, error: why, detail, code: code ?? -1 });
    });
  });
}

/**
 * 模式拼写的**唯一**归一入口（输入边界）。
 *
 * `simulation` 是规范名（QSH_PLAN.md §2.1：对用户只暴露 `closed-agent` / `simulation`），
 * `chat` / `reserved` / `reserved2` 是历史拼写 —— 必须继续被**接受**（线上桥接持久化的全局值
 * 就是 `reserved2`），但进程内部一律用历史拼写存储与比较：`currentMode === 'reserved2'` 这类
 * 判断遍布发送闸门、定时器与 preset 解析，把规范名直接塞进 `currentMode` 会让它们全部变成假。
 *
 * 旧写法是 `VALID_MODES = ['chat','closed-agent','reserved','reserved2']`，控制台那处还抄了
 * 一份同样的字面量数组。后果是：在 DSH 设置或 `state/mode.json` 里写 `simulation` 会被**静默
 * 忽略**，`currentMode` 保持上一次的值（进程刚起来时是 `chat`，即一代仿真 —— preset 与工具面
 * 都和二代不同，`v2ToolEnabled` 之类的闸门也不生效）。用户以为切到了仿真，实际跑的是另一套，
 * 而且没有任何日志。规范名与历史名必须在这里收敛成同一个内部值。
 */
const MODE_INPUT_ALIASES = Object.freeze({
  chat: 'chat',
  reserved: 'reserved',
  reserved2: 'reserved2',
  simulation: 'reserved2',
  'closed-agent': 'closed-agent'
});
/** 内部合法模式集合（由别名表派生，避免"两份名单各自漂移"）。 */
const VALID_MODES = Object.freeze([...new Set(Object.values(MODE_INPUT_ALIASES))]);

/** 输入侧归一：返回内部拼写；无法识别返回 null，由调用方 fail-closed。 */
function normalizeModeInput(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return Object.prototype.hasOwnProperty.call(MODE_INPUT_ALIASES, key) ? MODE_INPUT_ALIASES[key] : null;
}

// 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
// required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。
function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

/**
 * 读取每日归档记忆（`state/daily-memory.json`）。永不抛：文件不在/坏了就是空库。
 *
 * 这个文件由 plugins/qq-memory-rollover 维护，条目形如
 * `{date:'2026-10-14', items:[{scope:'private:100000001', text:'…'}]}`。
 * 桥接**只读不写** —— 写入权归整理脚本，避免两边各写一份互相覆盖。
 */
function readDailyMemory() {
  const raw = readJsonSafe(DAILY_MEMORY_FILE, null);
  if (!raw || typeof raw !== 'object') return { lastDigestDate: '', items: [] };
  return {
    lastDigestDate: String(raw.lastDigestDate ?? ''),
    items: Array.isArray(raw.items) ? raw.items.filter((d) => d && typeof d === 'object') : []
  };
}

/** `private:100000001` → `私聊100000001`（与索引块里的写法保持一致）。 */
function dailyMemoryScopeLabel(scope) {
  const s = String(scope ?? '').trim();
  const idx = s.indexOf(':');
  if (idx < 0) return '';
  const kind = s.slice(0, idx);
  const uid = s.slice(idx + 1);
  if (!uid) return '';
  return kind === 'group' ? `群${uid}` : `私聊${uid}`;
}

/**
 * 把主人/她自己说的「日期说法」解析成 `YYYY-MM-DD`（本地日历日）。
 *
 * 为什么要这一段：原来的 `qq_memory_query` 只能按**关键词**搜摘要，没有日期维度。
 * 于是主人问「10月22号我们聊了什么」时，只能拿 "10月22" 当子串去碰运气 ——
 * 而记忆摘要里**只有 10/50 条写了日期**，剩下 80% 永远搜不到（实测确认）。
 *
 * 支持的说法（都能落到某一天）：
 *   · `2026-10-22` / `2026/10/22`       —— 完整日期
 *   · `10-22` / `10/22` / `10月22` / `10月22日`  —— 月日（补当前年）
 *   · `昨天` / `前天` / `今天`          —— 相对日
 *   · `N天前` / `N 天前`                —— 相对偏移
 *   · **星期类**（2026-10-27 补）：`周三` / `这周三` / `上周三` / `上礼拜三` /
 *     `大前天` / `上周` —— 她每轮都看得见【现在】YYYY-MM-DD 周X（见 time-context.js），
 *     所以"上周三"对她是个**完全可推断**的说法，解析器必须接住，
 *     否则她会把"解析失败"误当成"那天没记东西"。
 * 解析不出来返回 null（调用方据此退回纯关键词搜索，不要报错 ——
 * "查不到日期"和"这天没有记忆"是两回事，混在一起会误导她）。
 */
function parseMemoryDay(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const today = new Date();
  /** 相对今天偏移 N 天（负数=过去）。用年月日构造，避开 DST/时区边界。 */
  const offset = (n) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);

  // 完整日期：2026-10-22 / 2026/10/22 / 2026年10月22日
  let m = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!Number.isNaN(d.getTime()) && d.getMonth() === Number(m[2]) - 1) return ymd(d);
  }

  // ── 星期类（必须排在"相对日"之前：'上周三'里不含今天/昨天，但正则要小心）──
  // 中文数字与阿拉伯数字都收：周三 / 星期三 / 礼拜三 / 周3 / 星期3
  const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 七: 7 };
  m = /(上上|上|这|本|下)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天七1-7])/.exec(s);
  if (m) {
    const rel = m[1] ?? '';
    const raw2 = m[2];
    // 目标星期几（周一=1 … 周日=7）
    const target = /[1-7]/.test(raw2) ? Number(raw2) : CN_NUM[raw2];
    if (target >= 1 && target <= 7) {
      // 今天在「周一=1…周日=7」里的位置
      const todayDow = ((today.getDay() + 6) % 7) + 1;
      // 先算出「本周（周一起算）的周 target」相对今天的天数偏移
      const thisWeekTarget = target - todayDow;          // 本周那天：可能是未来（正数）
      if (rel === '上上') {
        // 上上周的周 target = 本周那天 - 14
        return ymd(offset(thisWeekTarget - 14));
      }
      if (rel === '上') {
        // 上周的周 target = 本周那天 - 7
        // ⚠️ 不能用「上一个"最近不晚于今天"的周X」——那会算成同一天（实测踩过：
        //    "上周三"被算成 10-21，而 10-21 其实就是本周三）。必须按自然周减 7。
        return ymd(offset(thisWeekTarget - 7));
      }
      if (rel === '下') {
        return ymd(offset(thisWeekTarget + 7));
      }
      // 「这周三/本周三」= **本周**的那个周X，哪怕它还没到（明天）。
      // 严格按字面语义：本周三就是本周三，不因为"还没到"就退到上周去。
      // 调用方会比对今天，未来日期给「那天还没到」的提示（见 parseDayIsFuture）。
      if (rel === '这' || rel === '本') {
        return ymd(offset(thisWeekTarget));
      }
      // 「周三」不带前缀：取**最近且不晚于今天**的那个（口语里指最近的过去那天；
      // 未来的周三查记忆必然 0 条，等于白查）。
      return ymd(offset(thisWeekTarget > 0 ? thisWeekTarget - 7 : thisWeekTarget));
    }
  }

  // 「上周 / 上礼拜 / 这周」这类只有周、没有具体星期几的，取那一周的周一
  m = /(上上|上|这|本|下)\s*(?:周|星期|礼拜)\s*$/.exec(s);
  if (m) {
    const todayDow = ((today.getDay() + 6) % 7) + 1;   // 周一=1
    const thisMonday = -(todayDow - 1);                // 本周一 = 今天 - (todayDow-1)
    const back = m[1] === '上上' ? -14 : m[1] === '上' ? -7 : m[1] === '下' ? +7 : 0;
    return ymd(offset(thisMonday + back));
  }

  // 相对日（「大前天」要先于「前天」匹配，否则会被前者吃掉一部分）
  if (/今天|今日/.test(s)) return ymd(today);
  if (/大前天/.test(s)) return ymd(offset(-3));
  if (/前天/.test(s)) return ymd(offset(-2));
  if (/昨天|昨日/.test(s)) return ymd(offset(-1));
  if (/明天|明日/.test(s)) return ymd(offset(1));
  m = /(\d{1,2})\s*天前/.exec(s);
  if (m) return ymd(offset(-Number(m[1])));

  // 月日（不带年）：10-22 / 10/22 / 10月22日
  m = /^(\d{1,2})[-/月](\d{1,2})日?$/.exec(s) || /(\d{1,2})月(\d{1,2})日?/.exec(s);
  if (m) {
    const mon = Number(m[1]);
    const day = Number(m[2]);
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      // 先按当前年算；若算出来在未来（跨年场景），退回上一年。
      let d = new Date(today.getFullYear(), mon - 1, day);
      if (d.getTime() > today.getTime() + 86400000) d = new Date(today.getFullYear() - 1, mon - 1, day);
      return ymd(d);
    }
  }
  return null;
}

/**
 * 在归档记忆里检索。**这是角色卡那句「可用 qq_memory_query 检索」的落点**。
 *
 * 设计取舍：
 *   · 按**关键词命中数**排序，而不是只做 includes 过滤 —— 一句话里命中两个词
 *     的记忆，比只命中一个的更可能是她要找的。
 *   · 查询串按空白/逗号切分，**任一**命中即算（OR）。她自然语言提问时不会
 *     按我们的分词写，要求全命中会几乎查不到东西。
 *   · 不给关键词时按时间倒序返回最近的若干条（让她能"翻一翻"整个归档）。
 *   · 结果有字符预算：工具返回值会整段进上下文，翻出 3 万字等于把记忆变成噪音。
 *   · 每条都带来源会话，并附一句归属说明 —— 归档是**跨会话共享**的，
 *     不标注她会把别人的事安到当前这个人头上（2026-10-21 真实事故）。
 *
 * ⭐ 日期维度（2026-10-27 加）：`opts.day` 精确到某天，`opts.dayFrom`/`opts.dayTo`
 *   给一个区间。日期过滤**先于**关键词 —— 主人问"10月22号我们聊了什么"时，
 *   她只需要那天的事，不该被别天的命中挤掉。三者可叠加（区间 + 关键词）。
 */
function searchDailyMemory(keyword, opts = {}) {
  const q = String(keyword ?? '').trim();
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 12));
  // 双档之后每条可能带 200 字详细，4000 字符只装得下 15 条左右。
  // 提到 8000 让默认 limit=12 能带全详细；仍然远小于「把记忆变成噪音」的量级。
  const maxChars = Math.max(200, Math.min(20000, Number(opts.maxChars) || 8000));
  const mem = readDailyMemory();

  // 展开成扁平行（保留原始时间顺序，后面按需倒序）
  // `detail` 是 2026-10-28 加的双档字段：text 是短要点（也进角色卡索引），
  // detail 是详细版（只在归档检索时出来）。老条目没有它，退回 text。
  const all = [];
  for (const day of mem.items) {
    const date = String(day?.date ?? '').trim();
    for (const it of (Array.isArray(day.items) ? day.items : [])) {
      const text = String((it && typeof it === 'object') ? it.text : it ?? '').trim();
      if (!text) continue;
      const scope = (it && typeof it === 'object') ? String(it.scope ?? '').trim() : '';
      const detail = (it && typeof it === 'object') ? String(it.detail ?? '').trim() : '';
      // inferred（2026-10-29）：这条是**她推出来的**，不是对方说的、也不是她亲眼见的。
      // 必须一路带到渲染层 —— 否则检索结果里"他说他在忙"和"我猜他在忙"
      // 长得一模一样，她第二天就会拿猜测当事实讲，而且讲得理直气壮。
      const inferred = Boolean(it && typeof it === 'object' && it.inferred);
      all.push({ date, text, scope, detail, inferred });
    }
  }

  // ── 日期过滤（先于关键词）────────────────────────────────────────────
  // `day` 精确一天；`dayFrom`/`dayTo` 给区间（任一端可省）。
  // 作用在**展开后的行**上，所以日期和关键词能叠加：
  // "10月22号那天关于游戏的" = 先圈出 10-22 的所有行，再按关键词排序。
  const dayExact = parseMemoryDay(opts.day);
  const dayFrom = parseMemoryDay(opts.dayFrom);
  const dayTo = parseMemoryDay(opts.dayTo);
  const dateFiltered = Boolean(dayExact || dayFrom || dayTo);
  const inRange = (d) => {
    if (!d) return false;
    if (dayExact) return d === dayExact;
    if (dayFrom && d < dayFrom) return false;
    if (dayTo && d > dayTo) return false;
    return true;
  };
  const pool = dateFiltered ? all.filter((row) => inRange(row.date)) : all;

  // ── 查询词：`+词` 表示必须命中（AND），其余仍按 OR 计分 ────────────────────
  //
  // 为什么要 AND：原来的多个词**纯 OR**（命中任一即算），于是
  // 「主人 板子」这种"既要又要"的问法在语义上根本表达不出来 —— 只要某条
  // 沾了「主人」两个字就会被翻出来，等于没筛。她自然语言提问时确实这么问。
  // 为什么不禁掉 OR：想不起原话时，宽松查询才查得到东西。两种语义都留着，
  // 由她自己用 `+` 选。
  const terms = [];
  const requiredWords = [];
  if (q) {
    for (const raw of q.split(/[\s,，、;；|/]+/)) {
      const s = raw.trim();
      if (!s) continue;
      const isReq = s.startsWith('+') && s.length > 1;
      const w = isReq ? s.slice(1) : s;
      // 同一个词既当 OR 又当 +词时，**以 + 为准**（她自己加了加号就是想要严格）。
      if (isReq && !requiredWords.includes(w)) requiredWords.push(w);
      if (!terms.includes(w)) terms.push(w);
    }
  }

  // ── 同义词：字面命中不够，因为她不会用我们的词去问 ─────────────────────────
  //
  // 纯子串匹配最真实的失败长这样：库里写「板子上接的扬声器」，她查「硬件」→ 0 条；
  // 库里写「消消乐打到四十关」，查「游戏」→ 0 条。这不只是搜索质量差一点 ——
  // 索引只留最近 3 天，**归档全靠这个检索**，搜不到就等于那 50 条不存在。
  //
  // 为什么手写小表而不是 embedding：
  //   · 这是桌宠闲聊，话题高度集中（硬件/游戏/B站/语音），几十个词够用；
  //   · 改一行就生效，不用引模型、不用建索引、不用处理增量；
  //   · 最要紧的是**可控** —— 同义词扩展天然会引入假阳性，手写表能一眼看出扩到哪。
  // 加词门槛：先问"这两个词在问同一件事吗"。只是"相关"不算（会把结果稀释）。
  // ⚠️ 词表与 plugins/qq-memory-rollover/memory-index.mjs 的 TOPIC_WORDS 是两套
  //    （那边管"归档指针列什么词"，这边管"查询怎么匹配"），改一边时对一下另一边。
  const SYNONYM_GROUPS = [
    ['硬件', '板子', '单片机', '开发板'],
    ['游戏', '消消乐'],
    ['语音', '喇叭', '说话'],
    ['b站', 'bilibili', '刷视频'],
    ['说说', '空间', 'qzone'],
    ['表情包', '表情', '贴图'],
    ['闹钟', '提醒', '叫醒'],
    ['模拟器', 'mumu', '安卓'],
    ['日记', '本子'],
  ];
  // 词 -> 它的全部等价写法（含自身）。只建正向表就够：组内的词互相指向整组。
  const synonymOf = new Map();
  for (const group of SYNONYM_GROUPS) {
    for (const w of group) {
      const key = w.toLowerCase();
      if (!synonymOf.has(key)) synonymOf.set(key, new Set());
      for (const v of group) synonymOf.get(key).add(v.toLowerCase());
    }
  }
  /** 把一个查询词展开成"命中其中任一个都算数"的写法集合。 */
  const expandTerm = (t) => {
    const key = String(t).toLowerCase();
    return synonymOf.get(key) ?? new Set([key]);
  };

  let hits;
  // totalMatched 是「真正命中多少条」，与 limit 无关 —— 头部要报这个数。
  // 报成 limit 之后的数量会让她以为「就这么多」，实际上还有更多没显示。
  let totalMatched;
  if (!terms.length) {
    // 无关键词：最近的若干条（有日期过滤时，就是那天/那段的全部）
    hits = pool.slice().reverse().map((row) => ({ ...row, score: 0 })).slice(0, limit);
    totalMatched = pool.length;
  } else {
    const lower = (s) => s.toLowerCase();
    const scored = [];
    // 必含词统一小写化一次（放在循环外：每条记忆都算一遍是纯浪费）。
    const reqLower = requiredWords.map((w) => w.toLowerCase());
    pool.forEach((row, index) => {
      // 关键词要同时搜详细版 —— 只搜 text 的话，细节里提到的人名/地点永远搜不到，
      // 而「详细」正是主人这次要的那部分（2026-10-28 双档改造）。
      //
      // ⭐ 2026-10-29：**分开搜、分开算权重**。原来拼成一个 hay、命中一律 +1，
      // 后果是「详细里顺手提了一句」和「要点就是这件事」同分 —— 排序完全失去意义，
      // 翻出来一屏都是"顺带提过"的记录。现在要点命中 2 分、详细命中 1 分：
      // 一条记忆的**结论**比它的**展开**更能说明它是不是在讲这件事。
      const headHay = lower(row.text);
      const detailHay = lower(row.detail || '');
      let score = 0;
      // 每个查询词对**同一条**最多贡献一次（要点的 2 分已经包含了"详细也常提到"的情形，
      // 再加上去会让长条目天然占优 —— 那是在按长度排序，不是在按相关性）。
      // 必含词是否命中的记录：同义词组内任一写法命中即算命中。
      const missed = [];
      for (const t of terms) {
        const forms = expandTerm(t);
        let hit = 0;
        for (const f of forms) {
          if (headHay.includes(f)) { hit = 2; break; }
          if (detailHay.includes(f)) hit = 1;   // 不 break：继续看有没有更多写法，但分数只取最高档
        }
        if (hit > 0) score += hit;
        if (hit === 0 && reqLower.includes(String(t).toLowerCase())) missed.push(t);
      }
      // `+词` 语义：**全部**必含词都命中才返回，否则这条不参与排序（= 不返回）。
      // 用 expandTerm 展开过，所以 `+硬件` 也能命中写着「板子」的记忆 ——
      // 严格的是"这件事"，不是"这个字面"。
      if (missed.length > 0) return;
      if (score > 0) scored.push({ ...row, score, index });
    });
    // 命中数优先，其次新近。index 是 all 里的位置（时间正序），所以越大越新。
    // 注意：不能拿展开后的对象去 Map 里查原始下标 —— `{...row}` 是新对象，查不到。
    scored.sort((a, b) => b.score - a.score || b.index - a.index);
    totalMatched = scored.length;
    hits = scored.slice(0, limit);
  }

  // 字符预算：从尾部（评分最低/最旧）往回砍，至少留一条
  //
  // 双档（2026-10-28）：有 detail 就把详细版接在要点下面一行，用 `  ↳ ` 起头。
  // 为什么用两行而不是拼成一句：她要能一眼分清「一句话的结论」和「展开的细节」，
  // 拼起来读着像run-on，而且下次检索时无法只挑要点。
  let used = 0;
  const kept = [];
  for (const row of hits) {
    const head = `- ${row.date.slice(5)}｜${dailyMemoryScopeLabel(row.scope) || '（无来源）'}｜` +
      // 推断出来的记忆打个标记。**不用删除、也不用降权** —— 它是真实发生过的思考，
      // 只是不能当事实讲。所以标记放在最显眼的位置，让她读到时自己带上"这是猜的"。
      `${row.inferred ? '~（推断）' : ''}${row.text}`;
    const line = row.detail && row.detail !== row.text ? `${head}\n  ↳ ${row.detail}` : head;
    if (kept.length > 0 && used + line.length > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }

  return {
    totalItems: all.length,
    totalDays: mem.items.length,
    lastDigestDate: mem.lastDigestDate,
    query: q,
    // 日期过滤的回显（调用方据此写出"10-22 那天有 N 条"这种话，
    // 而不是笼统的"命中 N 条" —— 她拿不到日期回显就分不清"这天没记"和"记了但没搜到"）。
    day: dayExact,
    dayFrom,
    dayTo,
    dateFiltered,
    poolItems: pool.length,
    matched: totalMatched,
    lines: kept,
    truncated: kept.length < totalMatched
  };
}
/**
 * 「每轮撞一下老记忆」—— 2026-10-29 加。
 *
 * 起因：角色卡里的记忆索引只放最近几天（memory-index 的 INDEX_RECENT_DAYS = 3）。
 * 实测 62 条记忆里 50 条（约八成）在索引之外。它们**没丢**，qq_memory_query 查得到，
 * 但那是「她自己想起来要查」才有的路径 —— 而她不知道自己忘了什么，于是永远不查。
 * 结果就是八成记忆等于不存在。
 *
 * 改成：每轮拿对方刚说的这句话去撞一次归档，撞到就把那几条**要点**提一句。
 * 三条纪律都是被坑出来的：
 *   ① 宁可不提，也别拿沾边的凑 —— 要点里一个词都没对上就不提。只在「详细」里
 *      沾边的更不行：那说明这条事讲的是别的，提出来她会把两件事缝在一起。
 *   ② 只提**要点**，不提详细 —— 详细是当时的展开，反复念会慢慢变成"事实"。
 *   ③ 刚提过的不再提 —— 否则同一件事会被每句话勾出来一次，很快就成了噪音。
 */
function recallIdOf(row) {
  const s = (v) => String(v == null ? '' : v).trim();
  return s(row && row.scope) + '|' + s(row && row.date) + '|' + s(row && row.text);
}

/**
 * 纯函数：从 rows 里挑「跟这句话有关、但不在最近索引里」的旧事，最多 top 条。
 * 不读盘、不写盘，单测直接喂数据。
 *
 * rows: [{ date, text, scope, detail, inferred }]
 * opts: { scope, top = 2, recentDays = 3, now = Date.now(), cooldownMs = 6h, hits = {} }
 * 返回: [{ id, date, text, inferred }]
 */
function pickRecallRows(rows, query, opts = {}) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return [];
  const scope = String(opts.scope == null ? '' : opts.scope).trim();
  const top = Math.max(1, Math.min(3, Number(opts.top) || 2));
  const recentDays = Math.max(0, Number(opts.recentDays == null ? 3 : opts.recentDays));
  const now = Number(opts.now == null ? Date.now() : opts.now);
  const cooldownMs = Math.max(0, Number(opts.cooldownMs == null ? 6 * 3600 * 1000 : opts.cooldownMs));
  const hits = (opts.hits && typeof opts.hits === 'object') ? opts.hits : {};

  // 查询词：中文没有空格，「键盘手感怎么样」按标点切出来就是一整句，
  // 整句跟任何一条要点都对不上 —— 所以 CJK 的长词再拆成 2 字组（「键盘」「手感」…）。
  // 拆出来的 2 字组里有一堆虚词，单独过一遍黑名单，不然「怎么」能把不相干的记忆勾出来。
  // 全是承上启下、不带任何话题的虚词：它们能在大半个库上都撞一下，
  // 撞出来的「想起来」跟这句话毫无关系，比不提更糟（她会顺势编）。
  const STOP_GRAMS = new Set([
    '怎么', '什么', '这个', '那个', '我们', '你们', '他们', '自己', '现在', '刚才',
    '就是', '不是', '可以', '然后', '因为', '所以', '但是', '如果', '还是', '还有',
    '一下', '知道', '觉得', '时候', '今天', '昨天', '明天', '真的', '没有', '主人',
    '你说', '我说', '这么', '那么', '一个', '两个', '这样', '那样', '这么', '怎么',
    '别人', '特别', '讨厌', '记得', '上次', '事情', '你的', '我的', '他的', '她的',
    '了吗', '说过', '说的', '要是', '要么', '这种', '那种', '有点', '一些', '不会',
    '不想', '不能', '一直', '已经', '好像', '感觉', '其实', '而已', '那个', '这些',
    '那些', '有什么', '为什么', '是不是', '要不要', '能不能', '对不对', '好不好'
  ]);
  const terms = [];
  const seen = new Set();
  const pushTerm = (raw) => {
    const w = String(raw == null ? '' : raw).trim().toLowerCase();
    if (w.length < 2 || seen.has(w) || STOP_GRAMS.has(w)) return;
    seen.add(w);
    terms.push(w);
  };
  for (const raw of q.split(/[\s,，、;；|/。！？!?：:（）()\[\]【】"'“”‘’]+/)) {
    const t = String(raw == null ? '' : raw).trim();
    if (!t) continue;
    pushTerm(t);
    // 中英混排（「装apk这件事」）时整串既不是纯中文也不是纯英文，
    // 所以把中文段、英文段各自再拆出来 —— 否则一个词都拆不出，永远撞不上。
    for (const run of (t.match(/[\u4e00-\u9fa5]+/g) || [])) {
      if (run.length >= 3) {
        for (let i = 0; i + 2 <= run.length; i += 1) pushTerm(run.slice(i, i + 2));
      } else {
        pushTerm(run);
      }
    }
    for (const run of (t.match(/[a-zA-Z0-9]+/g) || [])) pushTerm(run);
  }
  // 上限：词太多就变成「什么都像命中」，反而分不出主次。
  const capped = terms.slice(0, 24);
  if (!capped.length) return [];

  // 只撞「够老」的：最近 recentDays 天的条目本来就在角色卡索引里，再提一遍是噪音。
  // 来源（scope）必须对得上 —— 2026-10-21 真实事故就是把私聊的事安到了别人头上，
  // 每轮自动注入这条路径更经不起串味，所以这里只认同一个会话。
  const pool = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.text) continue;
    if (scope && String(row.scope == null ? '' : row.scope).trim() !== scope) continue;
    const dayMs = Date.parse(String(row.date == null ? '' : row.date) + 'T00:00:00');
    if (Number.isFinite(dayMs) && (now - dayMs) / 86400000 < recentDays) continue;
    const id = recallIdOf(row);
    const lastHit = Number(hits[id] && hits[id].lastHit);
    if (lastHit && now - lastHit < cooldownMs) continue;
    pool.push({
      row: row,
      id: id,
      head: String(row.text == null ? '' : row.text).toLowerCase(),
      detail: String(row.detail == null ? '' : row.detail).toLowerCase()
    });
  }
  if (!pool.length) return [];

  // 词的稀有度：一个词在池子里越普遍，越说明不了它指哪件事（IDF 的粗糙版）。
  // df > 8 的词直接不算 —— 「今天」「主人」这类词命中五十条，等于没命中。
  const df = new Map();
  for (const t of capped) {
    let n = 0;
    for (const p of pool) if (p.head.includes(t) || p.detail.includes(t)) n++;
    df.set(t, n);
  }
  const weightOf = (n) => (n <= 1 ? 3 : n <= 3 ? 2 : n <= 8 ? 1 : 0);

  const scored = [];
  for (const p of pool) {
    let score = 0;
    let headHit = false;
    for (const t of capped) {
      const w = weightOf(df.get(t) || 0);
      if (!w) continue;
      if (p.head.includes(t)) { score += w * 2; headHit = true; }
      else if (p.detail.includes(t)) { score += w; }
    }
    // 门槛：要点里一个词都没对上 → 空手。只在详细里沾边的不要。
    if (!headHit || score < 2) continue;
    scored.push({ p: p, score: score });
  }
  if (!scored.length) return [];

  // 分数 → 被想起过几次（「被想起又会变重」）→ 新近
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ha = Number((hits[a.p.id] && hits[a.p.id].hits) || 0);
    const hb = Number((hits[b.p.id] && hits[b.p.id].hits) || 0);
    if (hb !== ha) return hb - ha;
    return String(b.p.row.date).localeCompare(String(a.p.row.date));
  });
  return scored.slice(0, top).map((x) => ({
    id: x.p.id,
    date: String(x.p.row.date == null ? '' : x.p.row.date).trim(),
    text: String(x.p.row.text == null ? '' : x.p.row.text).trim(),
    inferred: Boolean(x.p.row.inferred)
  }));
}

/** 把挑出来的旧事渲染成一小段。只给日期 + 要点，不给详细。 */
function renderRecallBlock(picked) {
  const list = Array.isArray(picked) ? picked.filter((r) => r && r.text) : [];
  if (!list.length) return '';
  const lines = list.map((r) => {
    const md = String(r.date == null ? '' : r.date).slice(5) || '更早';
    const raw = String(r.text == null ? '' : r.text);
    const body = raw.length > 60 ? raw.slice(0, 60) + '…' : raw;
    return '- ' + md + ' ' + (r.inferred ? '~' : '') + body;
  });
  return '〔想起〕更早的事（不在这几天的索引里，是顺着对方这句话想起来的）：' + String.fromCharCode(10) + lines.join(String.fromCharCode(10));
}


/**
 * 读取 config.json，并保证拿到一个**可安全改写的普通对象**。
 *
 * 为什么不是 `readJsonSafe(file, null, true) ?? {}`：控制台这些端点都是
 * 「读整份 config → 改一个字段 → 原子写回」。JSON.parse 对字面量 `null` 是**成功**的，
 * 于是 `file` 可能是 null：`file.socialV2` 直接 TypeError（保存接口 500，且错误信息
 * 完全指不出"配置文件顶层是 null"）；而用 `?? {}` 兜底更糟 —— 回写会把整份配置替换成
 * 只含本次提交字段的新对象，用户的白名单、令牌、模式全被抹掉。
 * 所以：不是普通对象就抛错，让调用方的 try/catch 返回 500（与各端点注释里
 * "配置文件损坏时直接 500，绝不回写" 的既有约定一致）。
 */
function readConfigObject(file) {
  const parsed = readJsonSafe(file, null, true);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed;
    throw new Error(`config.json 顶层不是对象（实际是 ${kind}），已拒绝改写以免覆盖整份配置：${file}`);
  }
  return parsed;
}

/**
 * 原子替换：`fs.renameSync` 覆盖一个「正被别人打开」的目标，在 Windows 上会抛 EPERM
 * （Defender / 编辑器 / 资源管理器预览 / 云同步都可能在这个窗口里碰它）。
 * 实测本机可复现。这里退避重试几次；实在不行才抛，让调用方决定怎么提示。
 */
function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
      // 同步忙等一小会儿：调用点大多在启动/收尾路径，不值得为它改成异步。
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch {}
    }
  }
  throw lastError;
}

// 原子写 JSON 文件：先写唯一临时文件再 rename，避免进程中断写坏配置，也避免固定临时名被并发/符号链接攻击利用。
function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    // 失败时别把随机名临时文件留在 state/ 里当垃圾。
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 原子写文本文件。
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 控制台鉴权 token：未配置时自动生成并持久化到 state/console-token，避免默认无鉴权。
function loadOrCreateConsoleToken() {
  const tokenFile = path.join(STATE_DIR, 'console-token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  atomicWriteText(tokenFile, token);
  return token;
}

/**
 * 收紧 state/ 的访问权限。
 *
 * **Windows 上 `mode: 0o600` 是空操作**（实测：chmod 之后 ACL 不变），文件继承父目录 ACL ——
 * 本机 state/console-token 实测为 `NT AUTHORITY\Authenticated Users:(M)`，也就是任何能登录
 * 这台机器的用户都能读走控制台令牌、Snowluma accessToken、各会话 agentToken 和全部 QQ 聊天记录。
 * 这里用 icacls 切断 state/ 的继承链，只保留「当前用户 + SYSTEM + Administrators」。
 *
 * ⚠️ 具体实现已抽到 `src/state-acl.mjs`（与 scripts/harden-state-acl.mjs 共用同一份）。
 * 这里原本自带一份**会破坏数据**的实现：
 *   · `icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /T` —— (OI)(CI) 是目录专用标志，
 *     套到 /T 展开的文件上会失败，而 /inheritance:r 已摘掉文件的继承 ACE，净结果是
 *     **子文件 DACL 被清空、连属主都读不了**（实测 state/ 下 50 个文件变空，桥接读不到
 *     自己的控制台令牌）；启动日志只报「未能收紧」，看不出已经造成破坏。
 *   · 回读自检用 `/\(I\)/` 扫全文，而 DSH 沙箱的 Low 完整性标签行永远带 (I) ——
 *     于是「已收紧」被误判成「未收紧」，**每次启动都重跑一遍那个破坏性命令**。
 * 两处逻辑各写一份正是漂移的根源，故合并。失败时不能只说"可能可读"就完事，
 * 要给出一条**安全**的可复制命令，并把结果回报到控制台（/api/security 的 stateDirHardened）。
 * 宁可明确报"没做成"，也不要假装已经安全。
 */
function hardenStateDirAcl() {
  const result = hardenDir(STATE_DIR);
  if (result.ok) {
    stateDirHardened = true;
    return;
  }
  stateDirHardened = false;
  if (process.platform !== 'win32') {
    log(`⚠️ 收紧 state/ 权限失败（chmod 700）：${result.detail}`);
    return;
  }
  log('⚠️ 未能收紧 state/ 目录权限：本机任何已登录用户都可能读到控制台令牌与 QQ 聊天记录。');
  log(`   原因：${String(result.detail).slice(0, 300)}`);
  log('   改 ACL 需要管理员权限。请用**管理员身份**打开终端后执行下面这几条命令（或在控制台「访问与安全」页点按钮）：');
  log(`   ${manualDirCommand(STATE_DIR)}`);
}

function readActivityTail(n) {
  try {
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

function listRoles() {
  try {
    return fs.readdirSync(path.join(ROOT, 'roles'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}

// ── 人格文件读写 ────────────────────────────────────────────────────────────
// 人格提示词 = roles/<名称>.md，由桥接在每条消息前注入（热生效，无需重启 DSH）。
const ROLES_DIR = path.join(ROOT, 'roles');
const ROLE_NAME_MAX = 40;
const ROLE_CONTENT_MAX_BYTES = 64 * 1024;
// 注入上限：**按模式筛完小节之后**再截断，避免另一模式的专属内容白白占掉预算。
// 默认 6000（沿用历史值，是每条约 4~6k token 的成本护栏），可用 config.json 的
// role.maxInjectChars 调整（1000~20000）；启动时由 applyRoleInjectLimit() 写入。
const ROLE_INJECT_MAX_CHARS_DEFAULT = 6000;
let roleInjectMaxChars = ROLE_INJECT_MAX_CHARS_DEFAULT;
function applyRoleInjectLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ROLE_INJECT_MAX_CHARS_DEFAULT;
  return Math.min(20000, Math.max(1000, Math.round(n)));
}
// 「对群友的印象」：10 条上限是不变的（那是社交记忆，记的是相处方式，不是流水账）；
// 每条长度可配，默认 120 字 —— 原来 50 字会把最关键的关系定位切掉，
// 但 200 字又让每条都变成小作文（10 条 × 200 = 2000 字符 ≈ 770 token，每轮都要付）。
// 120 字 ≈ 460 token，够写完「问了什么 + 我怎么答 + 结论」。
const IMPRESSION_MAX_TRAITS = 20;
const IMPRESSION_TRAIT_CHARS_DEFAULT = 120;
const IMPRESSION_TRAIT_CHARS_MIN = 50;
const IMPRESSION_TRAIT_CHARS_MAX = 300;
let impressionTraitChars = IMPRESSION_TRAIT_CHARS_DEFAULT;
function applyImpressionTraitChars(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return IMPRESSION_TRAIT_CHARS_DEFAULT;
  return Math.min(IMPRESSION_TRAIT_CHARS_MAX, Math.max(IMPRESSION_TRAIT_CHARS_MIN, Math.round(n)));
}
function impressionTraitMaxChars() {
  return impressionTraitChars;
}
const ROLE_RESERVED_NAMES = new Set(['README']);
// Windows 保留设备名：roles/CON.md 这类路径会被系统当成设备而不是文件，
// 写入会失败甚至挂起，因此在人格名层面直接拒绝。
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

function roleFilePath(name) {
  return path.join(ROLES_DIR, name + '.md');
}

function firstMeaningfulLine(content) {
  for (const line of String(content ?? '').split('\n')) {
    const t = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
    if (t) return t.slice(0, 80);
  }
  return '';
}

function roleWarnings(content, mode = 'v2') {
  const text = String(content ?? '');
  const warnings = [];
  const stats = roleCharStats(text);
  const injected = mode === 'v1' ? stats.v1 : stats.v2;
  if (injected > roleInjectMaxChars) {
    warnings.push(`超出注入上限：当前模式实际注入 ${injected} 字符，只有前 ${roleInjectMaxChars} 字符会进入提示词（可在配置里调 role.maxInjectChars）`);
  }
  // 只在「没有用模式标记分开」的小节上提示兜底过滤，避免对已正确标记的卡片误报。
  const untagged = parseRoleSections(text)
    .filter((section) => section.mode === 'all')
    .map((section) => section.lines.join('\n'))
    .join('\n');
  if (GEN1_ROLE_LINE_RE.test(untagged)) {
    warnings.push('未标记的小节里含一代仿真专用指令（[SILENT] / 空格分句 / 自动转发…），二代下这些行会被兜底过滤——建议把它们移到带 〔一代〕 标记的小节里');
  }
  if (/回复示例/.test(untagged) && /[\u4e00-\u9fff]\s+[\u4e00-\u9fff]/.test(untagged)) {
    warnings.push('“回复示例”节里的中文空格会被自动改写成逗号（二代不用空格分条），建议直接写逗号，或把该节标记为 〔一代〕');
  }
  return warnings;
}

function roleSummaries() {
  return listRoles().map((name) => {
    const file = roleFilePath(name);
    try {
      const stat = fs.statSync(file);
      const content = fs.readFileSync(file, 'utf8');
      const stats = roleCharStats(content);
      return {
        name,
        bytes: stat.size,
        chars: content.length,
        lines: content.split('\n').length,
        mtime: stat.mtimeMs,
        excerpt: firstMeaningfulLine(content),
        // 两种模式各自实际会注入多少（已按 〔一代〕/〔二代〕 标记筛过）
        injectedV1: Math.min(stats.v1, roleInjectMaxChars),
        injectedV2: Math.min(stats.v2, roleInjectMaxChars),
        charsV1: stats.v1,
        charsV2: stats.v2,
        hasModeTags: stats.v1Only > 0 || stats.v2Only > 0,
        truncated: stats.v1 > roleInjectMaxChars || stats.v2 > roleInjectMaxChars,
        warnings: roleWarnings(content).length,
      };
    } catch {
      return { name, bytes: 0, chars: 0, lines: 0, mtime: 0, excerpt: '', injectedV1: 0, injectedV2: 0, charsV1: 0, charsV2: 0, hasModeTags: false, truncated: false, warnings: 0 };
    }
  });
}

function validateRoleName(raw) {
  const name = sanitizeRoleName(raw);
  if (!name) throw new Error('人格名不能为空（仅限中文 / 字母 / 数字 / 横线）');
  if (name.length > ROLE_NAME_MAX) throw new Error(`人格名过长（最多 ${ROLE_NAME_MAX} 字）`);
  if (ROLE_RESERVED_NAMES.has(name)) throw new Error(`「${name}」是保留名称`);
  if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) throw new Error(`「${name}」是系统保留名称（Windows 设备名），请换一个`);
  return name;
}

function validateRoleContent(raw) {
  const content = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!content) throw new Error('人格内容不能为空');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > ROLE_CONTENT_MAX_BYTES) {
    throw new Error(`人格内容过长（${(bytes / 1024).toFixed(1)} KB，上限 ${ROLE_CONTENT_MAX_BYTES / 1024} KB）`);
  }
  return content;
}

function readRoleContent(name) {
  return fs.readFileSync(roleFilePath(name), 'utf8');
}

function writeRoleContent(name, content) {
  fs.mkdirSync(ROLES_DIR, { recursive: true });
  atomicWriteText(roleFilePath(name), content + (content.endsWith('\n') ? '' : '\n'));
}

// ── 二代仿真预设提示词（「仿真」层）────────────────────────────────────────
// 与「人格」层的边界：
//   仿真提示词 = 预设内置，规定 AI 怎么调工具、怎么参与群聊（行为与协议）
//   人格提示词 = roles/<名称>.md，规定 AI 是谁、什么性格（人设与语气）
// 仿真层改完需要重启 DSH 才生效（preset 由 DSH 在会话创建时装配）；
// 人格层由桥接每条消息注入，保存即生效。
// 两代仿真各自有独立的预设提示词：一代 qq-chat（空格分条 / [SILENT]），
// 二代 qq-chat-v2（一切皆工具）。控制台可分别查看与修改。
const PRESET_NAMES = { v1: 'qq-chat', v2: 'qq-chat-v2' };
const PRESET_BACKUP_DIR = path.join(STATE_DIR, 'preset-backups');
const PRESET_BACKUP_KEEP = 10;

function presetSourceYaml(name) {
  return path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
}

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function installedPresetYaml(name) {
  return path.join(dshHomeDir(), '.agent-presets', name, 'agent.cordis.yml');
}

// 这里**没有**模块级的 resolvePresetName —— 曾经有一个，但它被 main() 内部同名函数完全遮蔽
// （函数声明提升到 main 作用域，main 里所有调用点都落到内部那个），是纯死代码。
// 而且它的语义是错的：未知名字静默回退到 qq-chat-v2，等于 fail-OPEN —— 一旦哪天有人把它
// "复活"成真正生效的实现，群聊会话就会在 preset 清单校验失败时照样建起来。
// 真正在用的那个（main() 内，带 strict 开关）在名字不可用时返回 '' 让调用方拒绝建会话。
// 同理不再保留 PRESET_NAME_SET：它只服务于那个死函数，留着只会诱惑下一个人去用它。

function readPresetPromptText(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) throw new Error(`找不到预设文件 ${path.relative(ROOT, file)}`);
  const text = fs.readFileSync(file, 'utf8');
  const prefix = extractPresetPrefix(text);
  if (prefix === null) throw new Error('预设里找不到 persona.prefix（结构可能已变化）');
  return { text, prefix };
}

// 备份文件名带上预设名：两个预设的主文件名都叫 agent.cordis.yml，
// 不加前缀会让「还原」列到另一个预设的备份。
function presetBackupPrefix(name) {
  return `${name}.${path.basename(presetSourceYaml(name))}`;
}

function backupPresetFile(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(PRESET_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(PRESET_BACKUP_DIR, `${presetBackupPrefix(name)}.${stamp}`);
  fs.copyFileSync(file, dest);
  const prefix = presetBackupPrefix(name) + '.';
  const backups = fs.readdirSync(PRESET_BACKUP_DIR).filter((f) => f.startsWith(prefix)).sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - PRESET_BACKUP_KEEP))) {
    try { fs.rmSync(path.join(PRESET_BACKUP_DIR, stale)); } catch {}
  }
  return dest;
}

function listPresetBackups(name) {
  try {
    const prefix = presetBackupPrefix(name) + '.';
    return fs.readdirSync(PRESET_BACKUP_DIR)
      .filter((f) => f.startsWith(prefix))
      .sort().reverse()
      .map((f) => ({ file: f, mtime: fs.statSync(path.join(PRESET_BACKUP_DIR, f)).mtimeMs }));
  } catch {
    return [];
  }
}

function presetStatus(name) {
  // 只回传控制台需要的信息：不回传 DSH_HOME / 安装副本的绝对路径，减少无谓的信息暴露
  // （路径已经写在服务端日志里，排查时看日志即可）。
  return {
    preset: name,
    label: name === PRESET_NAMES.v1 ? '一代仿真（reserved）' : '二代仿真（reserved2）',
    sourceFile: path.relative(ROOT, presetSourceYaml(name)),
    installed: fs.existsSync(installedPresetYaml(name)),
    requiresRestart: true,
  };
}

// 回复审计：agent 回复若命中以下特征（本机路径/凭据），硬性拦截不发送。
// 宁可误拦，不可泄露。
// 社交模式“静默标记”：模型输出该标记时，桥接不把内容发到 QQ。
// 用于让 AI 在“不想接话/潜水”时有合法沉默出口，而不是写“（内心戏）”被当成消息发出去。
const SILENT_MARKER = '[SILENT]';
function isSilentMarker(text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}

// DSH MCP 发送类工具：一旦 AI 在回合里调用过这些工具，说明消息已经由工具发出，
// 桥接应跳过该回合的自动转发，避免“工具发一条 + 自动转发一条”的重复。
const SEND_TOOL_RE = /^mcp__snowluma__qq_(send_group_message|send_private_message|reply|send_burst|send_message)$/;
function isSendToolName(name) {
  return SEND_TOOL_RE.test(String(name ?? ''));
}

// 分句规则提示：真人聊天不会主动用空格，因此空格被桥接当作“分条信号”。
// 中英文/数字之间的空格同样会分条，所以不想分条就不要加空格。
const SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
// 群聊指向性提示：引用/回复段表示“这句话是在对被引用的人说”，避免 AI 把群友之间的对话误当成指向自己。
const DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';

// 已知的二代 agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
const KNOWN_AGENT_TOKENS = new Set();

// 会话 → 该会话「当前代 + 上一代」agentToken 的索引（见 rememberAgentToken）。
//
// 为什么必须有这份索引：retireSession() 每次轮换 token 都会把**新** token 塞进
// KNOWN_AGENT_TOKENS，而 reconcileSessionPolicies() 在**任何**策略变化（切模式、改白名单、
// preset 清单变动）时都会退役全部会话 —— 于是每切一次模式，每个会话就在集合里永久多留一个
// token，且只有 /reset、/api/session/reset、/api/socialV2/reset 会删。集合只增不减，而
// redactSensitiveText()（每写一行日志）和 redactKnownTokensOnly()/onebotSend()（每条出站消息）
// 都要先复制整个集合再线性扫，长期运行后这两条热路径会被拖垮。
//
// 选择「按会话替换」而不是硬性 LRU 上限：硬上限在会话多的时候会淘汰掉**仍然有效**的 token，
// 那等于把活令牌漏到 QQ，属于削弱安全边界。按会话记账时集合大小 ≈ 会话数 × 2，且每个会话
// 一定保留当前代（活令牌必然可脱敏）与上一代（模型上下文里最可能残留的那一个）；会话被删除
// 时用 forgetAgentToken() 整体摘除。第三代已经在两次轮换之前，不可能还在上下文里，直接丢弃。
const CONVERSATION_TOKENS = new Map();
const MAX_KNOWN_AGENT_TOKENS = 512;

/**
 * 记录某会话的当前 agentToken：丢掉它两代之前的旧 token，避免集合无界增长。
 * 另加一层上限兜底（防止异常路径下会话 key 无界增多），淘汰顺序是「先扔非活代」。
 */
function rememberAgentToken(key, token) {
  const tk = String(token ?? '');
  if (!tk) return;
  const prev = CONVERSATION_TOKENS.get(key);
  if (prev && prev[0] === tk) return;
  const next = prev ? [tk, prev[0]] : [tk];
  if (prev && prev[1]) KNOWN_AGENT_TOKENS.delete(prev[1]);
  CONVERSATION_TOKENS.set(key, next);
  KNOWN_AGENT_TOKENS.add(tk);
  if (KNOWN_AGENT_TOKENS.size > MAX_KNOWN_AGENT_TOKENS) {
    // 只淘汰已经不属于任何会话**当前代**的 token（即更早的旧代）。
    // 当前代一个都不能丢：脱敏漏掉活令牌就是把令牌发到 QQ，比内存占用严重得多。
    const live = new Set([...CONVERSATION_TOKENS.values()].map((pair) => pair[0]));
    for (const old of [...KNOWN_AGENT_TOKENS]) {
      if (KNOWN_AGENT_TOKENS.size <= MAX_KNOWN_AGENT_TOKENS) break;
      if (!live.has(old)) KNOWN_AGENT_TOKENS.delete(old);
    }
  }
}

/** 会话被彻底移除（重置/清空工作区/退订）时，连同它的 token 一起从脱敏集合摘掉。 */
function forgetAgentToken(key) {
  const prev = CONVERSATION_TOKENS.get(key);
  if (!prev) return;
  for (const tk of prev) KNOWN_AGENT_TOKENS.delete(tk);
  CONVERSATION_TOKENS.delete(key);
}

// 读取 DSH 模型能力的在途 Promise：withTimeout 只做 Promise.race，不会取消底层 RPC，
// 因此并发刷新会各自留下一个不可取消的请求。这里做去重，同一时刻只发一个。
let modelCatalogInFlight = null;
// DSH 思考强度（reasoningEffort）热切换代号。
// 控制台改强度后递增它，让已在运行的会话在下一条消息重新 selectModel；
// 放在模块级是为了不依赖 main() 内部声明的执行顺序（避免 TDZ）。
let modelSelectionEpoch = 0;
// DeepSeek provider 明确支持的取值（见 dsh-llm-deepseek：其它值会抛 UNSUPPORTED_REASONING_EFFORT）。
// 'off' 虽然合法（关闭思考），但 QQ 聊天助手依赖思考，控制台不提供该档。
const REASONING_EFFORT_OPTIONS = ['low', 'high', 'max'];
const REASONING_EFFORT_DEFAULT = 'max';
function normalizeReasoningEffort(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!REASONING_EFFORT_OPTIONS.includes(v)) {
    throw new Error(`思考强度只能是 ${REASONING_EFFORT_OPTIONS.join(' / ')}`);
  }
  return v;
}

// 敏感文本脱敏：把 SENSITIVE_RE 命中的片段替换为 ***，供日志/反馈/活动记录写入前使用。
// SENSITIVE_RE 未带 g 标志，这里动态补 g 以替换所有命中片段。
function redactSensitiveText(text) {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch {}
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// QQ 活动日志：每次收发都追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
const appendActivityLog = createCappedLogger(ACTIVITY_LOG, 500);
function appendActivity(line) {
  // 本地时间：此前用 toISOString() 写的是 UTC，日志时间与本地时间差 8 小时，排查时对不上。
  appendActivityLog(`[${localClock()}] ${redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
}

// 读取角色/模式状态：{"role": "傲娇助手", "mode": "active"|"silent"}
function readRoleState() {
  return readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
}
function writeRoleState(role, mode) {
  atomicWriteJson(ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
}
function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

/**
 * 把子进程的原始输出字节解成文字。
 *
 * 为什么不能直接 `.toString('utf8')`：Windows 中文控制台默认代码页是 936(GBK)，
 * `cmd /c chcp` 之外的一切 `dir`/`type`/python 报错都是 GBK 字节 —— 按 UTF-8 解会得到
 * 一串 U+FFFD，模型看到的是「乱码」而不是命令结果，然后就会以为命令失败了。
 * 判法：先按 UTF-8 解，出现替换字符就改用 gbk（Node 22 自带 full ICU，TextDecoder
 * 支持 'gbk'）。两条都失败才退回 UTF-8 的结果，至少不抛。
 */
function decodeShellOutput(buf) {
  if (buf === undefined || buf === null) return '';
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  if (b.length === 0) return '';
  const utf8 = b.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(b);
  } catch {
    return utf8;
  }
}

/**
 * 本机命令的「不可逆破坏」闸门（2026-10-25，配合 m08727 的本机执行能力）。
 *
 * 口径：**不限制她干活**，只挡「一次手滑就把这台机器弄没」的那几条 ——
 * 分区、引导、全盘清理、把系统盘格式化。正常的 del / rm / 格式化某个目录
 * 仍然放行（主人要的就是"能自己动手做全部"）。
 * ⚠️ 这是**兜底**，不是安全边界；真正的边界是「只有管理员私聊能用」。
 *    主人若觉得碍事，直接删这个数组即可（删掉等于完全放开）。
 */
const HOST_RUN_DENY_RE = [
  /\bformat\s+[a-z]:/i,           // format C:
  /\bdiskpart\b/i,                // 分区表操作
  /\bbcdedit\b/i,                 // 引导配置
  /\bvssadmin\s+delete\s+shadows/i,
  /\bwbadmin\s+delete\b/i,
  /\bcipher\s+\/w/i,              // 整盘擦除
  /\bRemove-Item\b[^\n]*-Recurse[^\n]*-Force[^\n]*\b[a-z]:\\?(\s|$)/i, // 删整个盘
];

// ── 配置 ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      // 多模态模型：DeepSeek-V41-Flash（DSH 模型目录里 inputModalities 含 image）。
      // 旧默认 deepseek-v4-flash-vision-exp 已被取代；config.json 未配置时用此兜底。
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      // 兼容新版 DSH 的 API 鉴权：如果 DSH 升级后要求非浏览器客户端带 token，
      // 在这里配置 token；默认走 Authorization: Bearer <token>。
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      // 是否允许把 DSH launch token 发往非回环地址（默认 false：那是进程启动凭据）
      allowRemote: false,
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'qq-chat',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    // 价目表覆盖项（可选）。留空即用 src/model-prices.js 的官方默认价。
    pricing: file.pricing ?? null,
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    slang: {
      enabled: true,
      extractMinMessages: 10,
      extractCooldownMs: 5 * 60 * 1000,
      inferenceThresholds: [2, 4, 8],
      injectMax: 8,
      learnerPreset: 'qq-chat',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      ...(file.slang ?? {})
    },
    social: {
      enabled: true,
      // 启动阶段（观望）
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
      // 活跃阶段（对话进行中）
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退出（防止活跃群中一直保持活跃）
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
      // 二期：观望阶段主动开话题（第三种触发）
      proactiveEnabled: true,         // 总开关
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默/退让
      skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
      surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
      longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
      longGapMaxMs: 5000,             // 长间隔上限（当前控制台保存值）
      ...(file.social ?? {})
    },
    socialV2: {
      enabled: true,
      autoReplyCheckMs: 30000,
      agentPreset: 'qq-chat-v2',
      provideRecommendations: true,
      tools: {
        getPrompt: true,
        getUnread: true,
        getRecent: true,
        socialState: true,
        sendGroup: true,
        sendPrivate: true,
        reply: true,
        sendBurst: true,
        sendMessage: true,
        waitMessages: true,
        feedback: true,
        getMyRecent: true,
        getMessageDetail: true,
        getActiveMembers: true,
        setWakeConfig: true,
        markRead: true,
        memory: true,
        getImages: true,
        getForwardMsg: true,
        sendPoke: true,
        listStickers: true,
        getStickerImage: true,
        sendSticker: true,
        setStickerRemark: false,
        stickerNote: true,
        collectSticker: true,
        // 群图库工具（桥接自动收录的群友图片；与上面的收藏表情是两套）
        listPhotos: true,
        getPhotoImage: true,
        sendPhoto: true,
        photoNote: true,
        writeDiary: true,
        readDiary: true,
        // 发文件（联网下载 → QQ 文件气泡）。默认关，见下面合并表的说明。
        sendFile: false,
        // 生图（2026-10-29）：把画面描述交给桌面版「生图工作室」插件，画完直接发进会话。
        // 默认开 —— 这是她要「发自拍」的核心能力；关掉这两个键就整个消失。
        drawImage: true,
        sendImage: true
      },
      wake: {
        preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关：防止 AI 聊两句就潜水
        preSleepWaitMs: 300000,          // 默认沉睡前至少等待/观察 5 分钟（后台可调）
        recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0.05,
        recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
        recommendedAtMention: true,
        recommendedNameMention: true,
        recommendedQuestion: true,
        recommendedPoke: true,
        recommendedHint: '如果你要潜水，推荐先调用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话就可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看 newMessages，判断不需要你参与可直接沉睡，若参与了则下次想睡需再等观察窗口。潜水时长推荐 5~120 分钟，普通消息概率 0.05；@/名字/关键词/提问唤醒建议保持开启。需要等特定某人/某几人时，可额外设置 triggers.speakerIds。',
        batchWindowMs: 8000,
        maxWakePerMinute: 1,
        maxWakePerHour: 12,
        noActionLimit: 3,
        maxWakeConfigReminders: 2
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。'
      },
      wait: {
        defaultMs: 120000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久（默认 10 秒），防止抢话
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 8,      // 提示里最多列出的常用表情数
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
      // 群图媒体库（src/media-lib.js）：
      // 桥接**自动**把群里发的图片收下来存本地，去重后她可以挑着发。
      // ⚠️ 与上面的 sticker 是**两套并存**的东西，不要合并：
      //   sticker = QQ 账号的收藏表情（有 emoji_id）；photo = 本地存的群友图片。
      photo: {
        enabled: true,             // 群图体系总开关
        dir: '',                   // 图库目录；空 = 默认 {ROOT}/media
        includeInPrompt: true,     // 是否在提示里附带「群图库」摘要
        promptMaxPhotos: 6,        // 提示里最多列出的常用图数
        maxListCount: 60,          // qq_photo_list 单次最大返回数
        maxCandidates: 400,        // 候选区上限；超限时最久没见的滚进回收站（不物理删）
        trashMaxItems: 200,        // 回收站上限；超限时按进站时间从旧到新**真删**
        collect: {
          enabled: true,           // 自动收录总开关
          maxPerMessage: 3,        // 单条消息最多收录几张
          maxPerMinute: 20,        // 每会话每分钟收录上限
          maxPerHour: 200          // 每会话每小时收录上限
        }
      },
      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3
      },
      // 生图（2026-10-29 主人放开给全体）。范围放全，成本靠日额度管。
      image: {
        enabled: true,
        scope: 'owner-and-groups', // 'owner' = 只管理员私聊；'owner-and-groups' = 管理员私聊 + 群（默认）；'everyone' = 全开
        dailyPerSession: 5       // 非管理员的日额度（张/天）；管理员私聊不限。0 = 不限
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20,
        inlineWakeMessages: true,
        wakeMessageLimit: 12,
        wakeRecentLimit: 4,
        wakeMaxChars: 6000
      },
      ...(file.socialV2 ?? {})
    }
  };

  // socialV2.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  cfg.socialV2.tools = {
    getPrompt: true,
    getUnread: true,
    getRecent: true,
    socialState: true,
    sendGroup: true,
    sendPrivate: true,
    reply: true,
    sendBurst: true,
    sendMessage: true,
    waitMessages: true,
    feedback: true,
    getMyRecent: true,
    getMessageDetail: true,
    getActiveMembers: true,
    setWakeConfig: true,
    markRead: true,
    memory: true,
    slangQuery: true,
    slangSubmit: true,
    getImages: true,
    getForwardMsg: true,
    sendPoke: true,
    listStickers: true,
    getStickerImage: true,
    sendSticker: true,
    setStickerRemark: false,
    stickerNote: true,
    collectSticker: true,
    // 群图库工具（桥接自动收录的群友图片；与上面的收藏表情是两套）
    listPhotos: true,
    getPhotoImage: true,
    sendPhoto: true,
    photoNote: true,
    writeDiary: true,
    readDiary: true,
    sendQzone: true,
    getQzone: true,
    // QQ 空间：读好友动态流 + 四类写操作（2026-10-19 新增）。
    // ⚠️ 这几个开关只决定"工具存不存在"，**不**决定"能不能被命令"：
    //    写操作另有桥接执行期的**自主闸门**（只放行她自己起的回合，见 AUTONOMOUS_WAKE_REASONS），
    //    那个开关落在 state 里（st.turnAutonomous），不在这里。
    qzoneFeeds: true,
    qzoneLike: true,
    qzoneUnlike: true,
    qzoneComment: true,
    qzoneDelete: true,
    qzoneSetRight: true,
    getAccount: true,
    // 「向我申请」：她要玩手机/刷B站，得先问一声，他同意才放行。
    // 这个开关只决定"申请这个工具存不存在"；**能不能真的用**由 state/permits.json
    // 决定的执行期守卫管（见 plugins/qq-agent-presets/qq-tool-restrict.mjs）。
    requestPermission: true,
    // 约定：qq_promise / qq_promise_done（到点主动叫醒她去做约定的事）
    promise: true,
    // 语音通话（档 2）：qq_call_status / qq_call_answer / qq_call_hangup / qq_call_say。
    // 默认 **关**：它要一个已装好的 VB-CABLE 虚拟声卡 + sidecar 进程，
    // 环境没齐时开着只会让她反复调一个必然失败的接口，还当成故障上报。
    // 真正"能不能对外拨号"另有 config.call.allowOutbound 一道闸，和这里无关。
    call: false,
    sendVoice: false,
    // 语音合成发送（she 说一句话 → 本机 TTS → 语音条）。与 sendVoice 分开两个开关：
    // sendVoice 管"能不能发语音"，speak 管"能不能现合成"。默认关，理由同 tts.enabled。
    speak: false,
    // 发文件（把本机一个文件 / 一个 URL 下载到本机再当 QQ 文件发出去）。
    // 和 localExec 同一档：它会在主人这台电脑上真下载真落盘，所以默认**关**，
    // 而且桥接端还有一道「只对管理员私聊开放」的硬闸。
    sendFile: false,
    ...(cfg.socialV2.tools ?? {})
  };

  // socialV2.voice：语音发送（把准备好的音频文件当 QQ 语音发出去）。
  // dir 为相对仓库根目录的语音库路径；AI 的 qq_send_voice 默认只能从这个目录取文件，
  // 绝对路径需要显式开 allowAbsolutePath（默认关，避免 prompt injection 读到任意本地文件）。
  //
  // 默认**关闭**（enabled/sendVoice 均为 false）：语音是"开口说话"的强表达，且需要你先准备好
  // 语音库内容。没放音频就让 AI 发语音只会得到一串错误。把音频放进 audio/ 后，
  // 在控制台「二代仿真 → 语音库与语音发送」里打开开关即可。
  cfg.socialV2.voice = {
    enabled: false,
    dir: 'audio',
    maxSeconds: 300,
    maxBytes: 20 * 1024 * 1024,
    maxPerMinute: 2,
    maxPerHour: 10,
    allowAbsolutePath: false,
    // 音量：默认倍数（1 = 原样）+ 智能音量档位 + ffmpeg 位置（空 = 走 PATH）。
    // SnowLuma 的 record 段没有增益字段，所以音量必须在本地先调好再发。
    defaultVolume: 1,
    loudness: 'normal',
    ffmpegPath: '',
    autoReadback: true,
    ...(cfg.socialV2?.voice ?? {})
  };

  // socialV2.file：发文件（联网下载 → 当 QQ 文件发出去）。
  //
  // 为什么单开一个配置块而不是复用 localExec：localExec 是"跑命令"，它是"传文件"，
  // 两件事的风险面不一样（前者能改机器，后者只读本机 + 外网下载）。各自能单独关。
  //
  // dir              ：下载落盘目录（相对仓库根目录），默认 `../小鲸鱼下载`
  //                    （即 `桌面\QQ bot\小鲸鱼下载\`，跟 media/ 并列，方便主人直接点开）
  //                    里面按 `YYYY-MM-DD/` 一天一个文件夹，好按日期整袋清理
  // maxBytes         ：单个文件上限，默认 200 MB（QQ 私聊文件本身能到 4 GiB，
  //                    但我们不打算让她随手把几个 G 的东西塞到主人手机上）
  // maxPerHour       ：每小时最多发几个
  // allowLocalPath   ：是否允许直接发本机已有文件（默认 true —— 她会先在
  //                    下载目录里找自己下过的，找不到再下载）
  // allowedDirOnly   ：true 时只认 dir 里的文件，不许拿绝对路径去读别处
  cfg.socialV2.file = {
    enabled: true,
    dir: '../小鲸鱼下载',
    maxBytes: 200 * 1024 * 1024,
    maxPerHour: 20,
    allowLocalPath: true,
    allowedDirOnly: false,
    // scope（2026-10-30 主人 m02763）：
    //   'owner'            = 只有管理员私聊
    //   'owner-and-groups' = 管理员私聊 + 群聊（默认）
    //   'everyone'         = 所有会话都行
    // 群聊那一档还会额外强制「只认下载目录」（不管 allowedDirOnly 怎么配）。
    scope: 'owner-and-groups',
    ...(cfg.socialV2?.file ?? {})
  };

  // 入站语音转文字（《进阶篇》进阶 3）：她说的是"她听懂你说的话"，与上面只管**出站**的
  // socialV2.voice 正好是一对。默认**关闭**：它要一个 2.3 GB 的 python venv 和 463 MB 的
  // whisper 模型，没准备好就打开只会每次都白等一次超时。准备好之后在控制台打开即可。
  // 详见 src/asr-lib.js 顶部注释（为什么不自己解 SILK、为什么要常驻 worker）。
  cfg.socialV2.asr = {
    enabled: false,
    toolsDir: ASR_DEFAULT_TOOLS_DIR,
    workerPath: '',
    pythonPath: '',
    model: 'small',
    language: 'zh',
    device: 'auto',
    modelDir: '',
    timeoutMs: 20000,
    loadTimeoutMs: 180000,
    maxChars: 800,
    prewarm: true,
    ...(cfg.socialV2?.asr ?? {})
  };

  // 出站语音合成（TTS）：让她**自己想发语音时**把一段文字念成语音条发出去。
  //
  // 与 socialV2.voice 的分工：voice 管「能不能发语音 + 语音库在哪 + 频率上限」，
  // tts 只管「这段文字用哪个引擎、什么音色念出来」。两者都要开（voice.enabled 控制
  // 通道、tts.enabled 控制合成），因为 tts 是 voice 的一种**内容来源**，不是替代品。
  //
  // 默认**关闭**：它要联网（edge 引擎）或至少一个 python venv。详见 src/tts-lib.js 顶部注释。
  // engine=edge 时文字会发到微软语音服务；engine=sapi 则完全离线（她的话不出这台电脑）。
  cfg.socialV2.tts = {
    enabled: false,
    engine: 'edge',
    voice: 'zh-CN-XiaoyiNeural',
    rate: '',
    volume: '',
    pitch: '',
    toolsDir: ASR_DEFAULT_TOOLS_DIR,
    workerPath: '',
    pythonPath: '',
    spoolDir: '',
    timeoutMs: 30000,
    loadTimeoutMs: 60000,
    maxChars: 300,
    prewarm: true,
    ...(cfg.socialV2?.tts ?? {})
  };

  // 语音通话（档 2）：把「听→想→说」的实时引擎接进桥接。
  //
  // 分工（不要在这里再实现一遍音频）：
  //   · tools/call/call_sidecar.py 负责听和说 —— 环回采集 + VAD + ASR，TTS + 虚拟声卡输出；
  //   · 桥接只负责「想」：把对方说的话当成一次**静默回合**投给 DSH，拿最终文本回给 sidecar。
  //
  // 为什么必须静默：普通回合的回复会被发到 QQ 聊天窗口，而通话时这句话要变成声音进麦克风。
  // 一边打电话一边在聊天框里打字，主人一眼就能看出不对。
  //
  // 默认**关闭**：它依赖 VB-CABLE 虚拟声卡、有头 QQ 客户端的窗口，以及 tools/asr 的 venv。
  // 这些缺一件，打开开关只会得到一串错误 —— 准备好之后再在控制台打开。
  cfg.call = {
    enabled: false,
    // sidecar 服务端口（只监听 127.0.0.1）。
    port: 3210,
    // 虚拟声卡输出设备名（VB-CABLE 装好后是 'CABLE Input'）。空 = 不接虚拟声卡，
    // 回复只会播到默认扬声器（自己能听见，对方听不见）—— 用于链路自检。
    outDevice: 'CABLE Input',
    // 通话绑定到哪个 QQ 会话（group:群号 / private:QQ号）。空 = 没有进行中的通话。
    key: '',
    // 一轮「说 → 想」的最长等待。超过就当前这句放弃，避免通话卡死。
    turnTimeoutMs: 90000,
    // python 解释器：默认用 tools/asr 的 venv（ASR/TTS worker 都在那儿）。
    pythonPath: '',
    // 是否允许 AI 通过 qq_call_* 工具**主动发起**通话。默认关：
    // 打电话是很强的打扰，得它自己判断该不该，而不是能力上"随时能拨"。
    allowOutbound: false,
    // 来电自动接听。默认关 —— 电话一响就有人替你接，这是很强的决定，得主人点头。
    // 打开后：3 秒轮询一次 QQ 窗口，OCR 认出「接听/拒绝」就是来电，自动点接听。
    autoAnswer: false,
    // 自动接听**只对管理员开放**（主人 m03948 定的口径）。
    //   'owner'（默认）= 只接打给管理员的来电，且接起来的对话必须绑在管理员私聊里；
    //                     来电者被认出是别人 → 不接。
    //   'anyone'       = 谁都接（等于放弃这层保护，只有主人明确要求时才该改）。
    autoAnswerFrom: 'owner',
    // 响铃窗口的 OCR 认不出「这通电话是谁打来的」时，要不要接。
    // 默认 true：认名字是**尽力而为**（头像/昵称可能被裁掉、OCR 可能读不全），
    // 认不出就一律不接的话，表现会是「主人打来也不接」，那这个功能就废了。
    // 但这也是这层保护唯一的口子：认不出 = 没法证明是主人。
    // 想更严就设 false（认不出就不接），代价是自己打电话时可能白响。
    autoAnswerUnknownCaller: true,
    // 接起来之后算在哪个会话的对话里。空 = 主人私聊（private:<ownerQQ>）——
    // 人格就住在那里，电话里说话的应该也是同一个她。
    answerKey: '',
    // 多久没说话就自动挂断（毫秒）。0 = 永不自动挂。
    // 给 15 分钟：对面只是沉默一会儿不该被挂，但也不能一直占着线。
    hangupAfterIdleMs: 900000,
    // ⚠️ 必须读 `file.call`，不能写 `cfg.call` —— 这一行执行时 `cfg.call` 还没赋值
    //（右值里读自己），展开结果恒为空对象，config.json 里的设置会被静默丢掉。
    ...(file.call ?? {})
  };

  // socialV2.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 8,
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    },
    ...(cfg.socialV2?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    }
  };

  // DSH 0.1.7 起 launch token 是**每进程现生成的 32 字节随机数，只存在内存里**，
  // 不落盘、不可推导；只有启动器把 `dsh web` 的 stdout 重定向到文件时才能从日志读到。
  // 所以这里发现的 token 只是兜底，主路径是客户端用 ~/.dsh 里持久化的签名密钥
  // 离线铸造会话 Cookie（见 dsh-client 的 mintBrowserSessionCookie）。
  // authTokenExplicit 记录「token 是用户填的还是这里猜的」，客户端据此排优先级。
  cfg.dsh.authTokenExplicit = Boolean(cfg.dsh.authToken);
  if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken();

  // 思考强度可能被手工改成非法值（config.json 是用户可编辑的）。DeepSeek 适配器对非法值
  // 会硬拒绝，若直接透传会让每个会话的 selectModel 每次都失败；这里统一规范化并告警。
  try {
    cfg.dsh.reasoningEffort = normalizeReasoningEffort(cfg.dsh.reasoningEffort ?? REASONING_EFFORT_DEFAULT);
  } catch (error) {
    log(`⚠️ config.json 的 dsh.reasoningEffort「${cfg.dsh.reasoningEffort}」非法，已回退 ${REASONING_EFFORT_DEFAULT}（${error?.message ?? error}）`);
    cfg.dsh.reasoningEffort = REASONING_EFFORT_DEFAULT;
  }

  // 人格卡注入上限（字符）。历史硬编码 6000，现在可配：每条约 4~6k token 的成本护栏。
  cfg.role = { maxInjectChars: ROLE_INJECT_MAX_CHARS_DEFAULT, ...(file.role ?? {}) };
  roleInjectMaxChars = applyRoleInjectLimit(cfg.role.maxInjectChars);
  if (roleInjectMaxChars !== cfg.role.maxInjectChars) {
    log(`人格注入上限已按范围校正为 ${roleInjectMaxChars} 字符（配置值 ${cfg.role.maxInjectChars}，允许 1000~20000）`);
  }

  // 印象每条长度（字符）。历史硬编码 50，会把印象切在最关键的地方；现在默认 120，可配 50~300。
  impressionTraitChars = applyImpressionTraitChars(cfg.social?.memory?.impressionMaxChars);
  if (cfg.social?.memory?.impressionMaxChars !== undefined
      && impressionTraitChars !== Number(cfg.social.memory.impressionMaxChars)) {
    log(`印象长度已按范围校正为 ${impressionTraitChars} 字（配置值 ${cfg.social.memory.impressionMaxChars}，允许 ${IMPRESSION_TRAIT_CHARS_MIN}~${IMPRESSION_TRAIT_CHARS_MAX}）`);
  }

  return cfg;
}

// ── 状态持久化（QQ 会话 ↔ DSH 会话映射） ─────────────────────────────────────
let state = { sessions: {} };
// sessions.json 读不动/读坏时必须**大声失败**，不能静默回落成空映射：
// 那会让每个 QQ 会话都拿到一个全新的 DSH 会话（上下文全丢），而紧接着的
// saveState() 会把这份空映射原子写回磁盘 —— 一次截断/占用/写满就变成永久丢失。
// 与表情库、黑话库一样走「只读不写」降级：保留原文件，等人来处理。
let stateWritable = true;
function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch (error) {
    state = { sessions: {}, sessionPolicies: {} };
    if (error?.code !== 'ENOENT') {
      stateWritable = false;
      log(`⚠️ sessions.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
    }
    return;
  }
  let loaded = null;
  if (raw.trim() !== '') {
    try {
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      loaded = JSON.parse(text);
    } catch (error) {
      state = { sessions: {}, sessionPolicies: {} };
      stateWritable = false;
      log(`⚠️ sessions.json 内容损坏，已降级为「只读不写」（不会覆盖原文件，请先备份再修复）：${error?.message ?? error}`);
      return;
    }
  }
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') state = loaded;
  else state = { sessions: {} };
  if (!state.sessionPolicies || typeof state.sessionPolicies !== 'object' || Array.isArray(state.sessionPolicies)) state.sessionPolicies = {};
}
function saveState() {
  // 统一走原子写：固定 `.tmp` 名 + 无 mode 的手写版本会在外部进程（杀软/备份）
  // 占住 sessions.json.tmp 时抛 EPERM，且写出的文件权限与其它 state 文件不一致。
  if (!stateWritable) return; // 见 loadState：读失败/损坏时绝不回写，避免把丢失变成永久
  atomicWriteJson(STATE_FILE, state);
}

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
// 防止多个桥接进程同时运行（双实例会抢消息、互相覆盖映射）。
// 锁文件存 PID；启动时若该 PID 仍存活则退出（exit 2 = 已有实例），
// 否则接管。进程退出/崩溃后锁自动失效（PID 校验）。
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');

/**
 * 控制台端口是否已被占用 —— 用来判断「是不是真的还有一个桥接在跑」。
 *
 * 为什么需要它：锁文件只存了 PID，而 Windows 会回收 PID。`process.kill(pid, 0)` 成功
 * 只能证明「有进程占着这个号」，EPERM 更是连这一点都证明不了（受保护进程）。
 * 但桥接一定绑定控制台端口（绑不上会自己 exit 2），所以端口占用是一个可靠的判据。
 * 同步探测一次，只在启动期的可疑分支里跑，不影响正常运行。
 */
function consolePortInUse() {
  try {
    const cfg = readJsonSafe(path.join(ROOT, 'config.json'), {});
    const port = Number(cfg?.consolePort) || 3100;
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      return new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, 'i').test(out);
    }
    const out = execFileSync('sh', ['-c', 'ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return new RegExp(`[:.]${port}\\s`).test(out);
  } catch {
    // 探测不出来时保守认为「有人在跑」，宁可让用户手动删锁，也不要冒双实例的风险。
    return true;
  }
}

function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // 原子创建锁文件：把 PID 一次性写入（flag 'wx'），避免“先建空文件再写 PID”的窗口被第二个进程当作过期锁偷走。
  const tryCreate = () => {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return;
  // 锁文件已存在：检查 PID 是否仍存活；内容为空视为过期锁（仅兼容旧版本遗留），删除后重试一次。
  let stale = false;
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (!content) {
      stale = true;
    } else {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0);
          // 没抛异常只说明「存在某个持有该 PID 的进程」，不能证明那就是桥接
          // （PID 被回收给别的程序时会误判），所以再加一道端口探测。
          if (!consolePortInUse()) stale = true;
        } catch (error) {
          if (error.code === 'ESRCH') {
            stale = true;
          } else if (error.code === 'EPERM') {
            // EPERM = 该 PID 属于受保护/系统进程（权限不足，无法发信号）。
            // 这**不能**证明桥接还在跑，但旧逻辑把它当成「已有实例」直接 exit(2)：
            // 一旦锁文件里的 PID 被系统回收给一个受保护进程，桥接就永久起不来，
            // 而且提示信息把人引向「已有实例在运行」这个错误方向。
            // 这里改成按「疑似过期」处理，但要先确认控制台端口没有被占用。
            if (consolePortInUse()) {
              console.error(`[bridge] 控制台端口已被占用，判定已有实例在运行（锁文件 PID ${pid} 无权限探测）。`);
              process.exit(2);
            }
            console.error(`[bridge] 锁文件 PID ${pid} 无权限探测（EPERM）且控制台端口空闲，按过期锁处理。`);
            stale = true;
          } else {
            console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          }
        }
      }
    }
  } catch (readError) {
    console.error(`[bridge] 无法读取锁文件 ${LOCK_FILE}：${readError?.message ?? readError}`);
    process.exit(1);
  }
  if (stale) {
    console.error(`[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…`);
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    if (tryCreate()) return;
  }
  console.error(`[bridge] 已有实例在运行（锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
  process.exit(2);
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ── 工具 ────────────────────────────────────────────────────────────────────
// 日志同时输出到 stdout 与 state/bridge.log（守护窗口不可见时也能排查）

/** 单条日志的最大长度：一条异常巨大的错误对象不能把整个日志文件变成 5MB。 */
const LOG_LINE_MAX = 1000;

/**
 * 带行数上限的追加写日志。
 *
 * 为什么不能「append 之后再读回整个文件数行数」：那样每写一行都要同步读一遍整个文件，
 * 到上限后还要整文件重写一次。实测 bridge.log 到了 2000 行（约 200KB）时，
 * 单次 log() 要 17ms 左右，而每条 QQ 消息会打 2~4 条日志 —— 每条消息白扔几十毫秒的
 * 事件循环。这里改成**内存计数器**：只在启动时数一次，之后 O(1) 追加，
 * 到上限才轮转，轮转用 rename 到 `.1`（不是整文件重写，也不会写坏）。
 */
function createCappedLogger(file, maxLines) {
  let lines = -1; // -1 = 还没数过
  return function append(text) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      if (lines < 0) {
        try {
          lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        } catch {
          lines = 0;
        }
      }
      fs.appendFileSync(file, text, 'utf8');
      lines += 1;
      if (lines > maxLines) {
        // 轮转：当前文件改名为 .1（覆盖上一个备份），新文件从零开始。
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          // 改名失败（被占用等）就退化成截断，保证文件不会无限增长。
          fs.writeFileSync(file, '', 'utf8');
        }
        lines = 0;
      }
    } catch {}
  };
}

/** 本地时间 HH:MM:SS。此前用的是 toISOString()，写进日志的是 UTC，和本地时间差 8 小时。 */
function localClock(atMs = Date.now()) {
  const d = new Date(atMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const appendBridgeLog = createCappedLogger(BRIDGE_LOG, 2000);

function log(...args) {
  let line;
  try {
    const body = args
      .map((a) => redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
      .replace(/[\r\n]+/g, ' ');
    line = `${localClock()} [bridge] ${body.length > LOG_LINE_MAX ? `${body.slice(0, LOG_LINE_MAX)}…[截断]` : body}`;
  } catch {
    line = `${localClock()} [bridge] (日志参数无法序列化)`;
  }
  // console.log 必须自成一个 try：stdout 的读者（守护窗口）消失时会抛 EPIPE，
  // 而 log() 是从 socket 事件回调里被调用的 —— 一旦抛出就会变成未捕获异常把进程带走。
  try { console.log(line); } catch {}
  appendBridgeLog(`${line}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convKey = (kind, id) => `${kind}:${id}`;
const SEND_TIMEOUT_MS = 15000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// QQ 分享卡片（type=json）的真实内容：段里的 `data.data` 是一段 JSON 字符串，
// 里面 `meta.<子对象>` 带标题/摘要/跳转链接、`prompt` 带触发文本、`app` 标识来源。
// 以前所有卡片都被降级成字面量 `[卡片消息]`，于是 AI 只能看到四个字，拿不到链接、
// 标题和来源，也就无法自己去抓取内容（实测 2026-10-13：B 站分享卡片到手只剩占位符）。
// 这里把能读到的字段拼成一行可读文本；解析不出来才回退占位符。
function describeJsonCard(d) {
  const raw = typeof d?.data === 'string' ? d.data : d?.data ? JSON.stringify(d.data) : '';
  if (!raw) return '[卡片消息]';
  let card = null;
  try { card = JSON.parse(raw); } catch { return '[卡片消息]'; }
  if (!card || typeof card !== 'object') return '[卡片消息]';
  const meta = card.meta && typeof card.meta === 'object' ? card.meta : {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  // meta 下的子对象（news / detail_1 / music / article…）字段名基本一致，
  // 逐个取第一个非空值即可覆盖绝大多数分享卡片。
  const nodes = [meta.news, meta.detail_1, meta.detail, meta.music, meta.article,
    meta.invite, meta.location, meta.contact, meta.calendar, meta.qqmusic]
    .filter((n) => n && typeof n === 'object');
  let title = str(card.title);
  let desc = str(card.desc) || str(card.summary);
  let url = str(card.url);
  let tag = str(card.tag);
  for (const n of nodes) {
    if (!title) title = str(n.title) || str(n.summary) || str(n.name);
    if (!desc) desc = str(n.desc) || str(n.description) || str(n.summary);
    if (!url) url = str(n.jumpUrl) || str(n.url) || str(n.qqdocurl) || str(n.newsUrl) || str(n.h5Url);
    if (!tag) tag = str(n.tag);
  }
  const app = str(card.app);
  const source = tag || (app.includes('bilibili') || app.includes('tuwen') ? '分享卡片'
    : app.includes('music') ? '音乐' : app.includes('file') ? '文件' : '卡片');
  const parts = [];
  if (title) parts.push(title);
  if (desc && desc !== title) parts.push(desc);
  if (url) parts.push(url);
  if (!parts.length) {
    const prompt = str(card.prompt);
    return prompt ? `[卡片 ${source}] ${prompt}` : `[卡片消息 ${source}]`;
  }
  return `[卡片 ${source}] ${parts.join(' | ')}`;
}

async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true, voiceMarkers } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      case 'image': out.push('[图片]'); break;
      // record：桥接若已本地转写（《进阶篇》进阶 3），这里直接用文字；否则保持老的 `[语音]`。
      // voiceMarkers 的 key 是**段对象本身**——调用方遍历的就是同一批对象，不必编下标。
      case 'record': out.push(voiceMarkers?.get(seg) || '[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch {}
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': out.push(describeJsonCard(d)); break;
      // markdown：SnowLuma 1.14.9 的线上段落是 `{type:'markdown',data:{content}}`。
      // 上游 1.14.17+（commit 1934e4e7「include text alongside received markdown」）
      // 起还会带上 `data.text`。两个形状都读，这样将来升级 SnowLuma 运行时不会退化成
      // 字面量 `[markdown]` 被喂给模型。SDK 的 KnownMessageSegment 联合里没有 markdown，
      // 所以段类型是运行时多出来的 —— 这正是 default 分支原来会命中的情况。
      case 'markdown': out.push(String(d.text ?? d.content ?? '[Markdown]')); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、二代按需工具、控制台/日志使用。
function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        // 线上段落字段是 snake_case 的 `sub_type`（SnowLuma 运行时源码里就这么发）；
        // 而 SDK 的类型描述的是**内部元素**、拼作 `subType`。两个都读，别只认一个
        // —— 只读 camelCase 的话这里会永远是空串，而且不会有任何报错。
        subType: (d.sub_type ?? d.subType) != null ? String(d.sub_type ?? d.subType) : '',
        summary: String(d.summary ?? '')
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? '')
      });
    }
  }
  return media;
}

function allowed(kind, id, cfg) {
  // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
  // 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}

// 二代会话 key 规范化：只接受 group:正整数 / private:正整数，并去掉前导零，避免同一会话出现多个别名。
function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

/**
 * 解析主人对「申请玩手机/刷B站」的答复。
 *
 * 支持的说法（他打字很随意，这里刻意放宽）：
 *   同意 / 行 / 可以 / 好 / 去吧 / 准了 / 批准     → 允许，默认时长
 *   同意 1 小时 / 行，半小时 / 给你 20 分钟        → 允许，带上请求的时长
 *   不同意 / 不行 / 不用 / 算了 / 别玩了 / 拒绝     → 拒绝
 * 其它（「等一下」「在忙」「你玩啥」）→ null，当成普通对话往下走，
 * 申请继续挂着等他正面回一句。这样不会被一句「等会」误判成拒绝。
 *
 * ⚠️ 只认**短消息**（去掉标点后 ≤ 24 字）：他要是认真聊了段话，
 * 里面碰巧有「可以」两个字，那不该被当成授权。
 *
 * @returns {{allowed:boolean, ttlMs?:number, raw:string}|null}
 */
function parsePermitAnswer(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const compact = raw.replace(/[\s，,。.!！？?、~～…]+/g, '');
  if (compact.length > 24) return null;
  // 先判拒绝：句子里出现否定词时，别被前面的「同意」带偏（「不同意」包含「同意」）。
  const denyHit = /(不同意|不允许|不批准|不行|不可以|不准|别玩|不要|算了|免了|拒绝|驳回|不用了|下次吧|no|nope)/i.test(compact);
  const allowHit = /(同意|可以|行|好|去吧|准了|批准|允许|ok|yes|嗯嗯|对)/i.test(compact);
  if (denyHit && !/^(同意|可以)/.test(compact)) {
    return { allowed: false, raw };
  }
  if (!allowHit) return null;
  // 时长：分钟 / 小时 / 半小时
  let ttlMs;
  const halfHour = /半(个)?小时/.test(compact);
  const hourMatch = /(\d+(?:\.\d+)?)\s*(?:个)?\s*小时/.exec(compact);
  const minMatch = /(\d+)\s*(?:分钟|分)/.exec(compact);
  if (hourMatch) ttlMs = Number(hourMatch[1]) * 60 * 60 * 1000;
  else if (halfHour) ttlMs = 30 * 60 * 1000;
  else if (minMatch) ttlMs = Number(minMatch[1]) * 60 * 1000;
  return { allowed: true, ttlMs, raw };
}

// state/ 的 ACL 是否已收紧（hardenStateDirAcl 的结果；控制台「访问与安全」页会显示，
// 未收紧时给出可复制的提权命令）。null = 还没跑/平台不适用。
let stateDirHardened = null;

// 入站语音转写（《进阶篇》进阶 3）的单例本体。
// 由 main() 里创建、赋到这里，好让下面的 SIGINT/SIGTERM/exit 钩子能关掉那个常驻
// python worker —— 那些钩子在模块顶层，看不到 main() 的局部作用域。
// 关掉它是必要的：worker 是个真进程，不 dispose 就会在桥接退出后变成孤儿。
let asrInstance = null;

// 出站语音合成（TTS）的单例本体，理由同上（退出钩子在模块顶层，看不到 main() 的局部）。
let ttsInstance = null;

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  hardenStateDirAcl();
  acquireLock();
  loadState();

  // 日记目录（config.json → socialV2.diary.dir 可改；默认仓库内 data/日记）。
  // 这里把解析结果落到模块级 DIARY_DIR；之后所有读写都通过 diaryDir() 拿同一份。
  DIARY_DIR = resolveDiaryDir(cfg);
  diaryDirCache = DIARY_DIR;
  if (DIARY_DIR !== DIARY_DIR_DEFAULT) log(`日记目录：${DIARY_DIR}`);

  // ── 入站语音转文字（《进阶篇》进阶 3） ────────────────────────────────────
  // 单例：整个桥接进程共用一个常驻 whisper worker（模型只加载一次）。
  // 关闭时 createAsr 里的 transcribeSegments 直接返回空串，不花任何网络/进程。
  const asr = createAsr({ socialV2: cfg.socialV2, snowluma: cfg.snowluma, log: (m) => log(m) });
  asrInstance = asr;

  // ── 出站语音合成（她说的话变成语音条） ────────────────────────────────────
  // 与 asr 对称的单例：整个桥接进程共用一个常驻 python worker（edge 引擎冷启要 4 秒，
  // 而真正合成就几百毫秒）。关闭时 speakForV2 会直接抛"语音合成已关闭"。
  //
  // ⚠️ liveEnabled 是关键：tts 实例内部那份 cfg 是**启动快照**，
  //    控制台改 socialV2.tts.enabled 之后它不会变。传一个"每轮现读"的回调进去，
  //    开关才能立刻生效（不必重启桥接）。
  const tts = createTts({
    socialV2: cfg.socialV2,
    log: (m) => log(m),
    liveEnabled: () => cfg.socialV2?.tts?.enabled !== false
  });
  ttsInstance = tts;

  /**
   * 把这一条消息里的 record 段批量转写。
   * 返回 Map<段对象, 标记文本>（失败/没开的段不会进这个 Map）。
   *
   * 为什么是"先批量、再拼文本"而不是在 segmentsToText 里边遍历边转写：
   * ① 转写要 await 且慢（首次含模型加载），而 textContent 与 plainContent 是同一批段
   *    拼两遍——放在 segmentsToText 里会把每条语音转两次；
   * ② 这里能一次性把"有语音"这件事变成一条日志，失败也看得出来。
   * 任何异常都在 asr 内部被吞成空串，**不会**让这条消息丢掉或延迟入队。
   */
  async function transcribeVoiceSegments(segments) {
    const markers = new Map();
    if (!asr.enabled) return markers;
    const records = (segments ?? []).filter((s) => s?.type === 'record');
    if (records.length === 0) return markers;
    try {
      const texts = await asr.transcribeSegments(records);
      records.forEach((seg, i) => {
        const marker = texts[i];
        if (marker) markers.set(seg, marker);
      });
    } catch (error) {
      // asr-lib 承诺不抛；真抛了也只是没有转写，消息照旧走
      log(`⚠️ 语音转写异常（这条消息照旧走 [语音]）：${error?.message ?? error}`);
    }
    return markers;
  }

  // ── 群聊黑话/网络用语学习（slang） ──────────────────────────────────────
  let slangEntries = [];
  // 读失败时（被占用 / 权限 / JSON 损坏）必须**暂停写入**：否则内存里的空数组
  // 会在下一次 saveSlangStore() 时覆盖掉磁盘上那份数据，学到的词条全丢。
  let slangStoreWritable = true;
  try {
    slangEntries = loadSlang(SLANG_FILE, { onCorrupt: (message) => log(`⚠️ ${message}`) });
  } catch (error) {
    slangStoreWritable = false;
    log(`⚠️ 黑话库加载失败，已暂停写入以免覆盖磁盘数据（修好后重启即可恢复）：${error?.message ?? error}`);
  }
  const slangWindows = new Map();       // key -> [{sender,text,time}]：待学习消息窗口
  const slangExtractionCooldowns = new Map(); // key -> timestamp
  const slangSubmitTimes = new Map();   // key -> [timestamp]：AI 提交黑话候选限频（内存态）
  const feedbackTimes = new Map();      // key -> [timestamp]：AI 反馈限频（内存态）
  const slangResearchingIds = new Set(); // 正在研究中的候选 id，防止重复排队
  const learnerSessions = new Set();    // sessionId -> 学习会话（不映射 QQ，不发送）
  const learnerCollectors = new Map();  // sessionId -> turn collector
  const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]
  let slangLearnerSessionId = null;
  let slangTaskChain = Promise.resolve();

  // ── 表情包体系（二代仿真）本地知识库 ────────────────────────────────────
  // 库文件损坏/读不动时**不能当成空库继续**：下面任何一次 saveStickerStoreSafe 都会把
  // 「空库」写回去，把 AI 学到的 localNote/tags/usage 永久清零。读失败就显式降级为
  // 「只读不写」，并留下醒目日志（与 loadSlang 的 slangStoreWritable 同一套路）。
  let stickerEntries = [];
  let stickerStoreWritable = true;
  try {
    stickerEntries = loadStickerStore(STICKER_FILE);
  } catch (error) {
    stickerStoreWritable = false;
    log(`⚠️ 表情库读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
  }
  let stickerSyncedAt = 0; // 上次从 SnowLuma 拉取收藏表情的时间戳（毫秒）
  let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护

  function stickerEnabled() {
    return cfg.socialV2?.sticker?.enabled !== false;
  }

  function saveStickerStoreSafe() {
    if (!stickerStoreWritable) return; // 读失败时绝不回写，避免把「损坏」当成「空库」落盘
    try { saveStickerStore(STICKER_FILE, stickerEntries); } catch (error) { log('保存表情库失败:', error?.message ?? error); }
  }

  // ── 群图媒体库（src/media-lib.js）────────────────────────────────────────────
  //
  // 与上面的收藏表情库**并存**，各自管各自的：
  //   收藏表情库解决「QQ 收藏夹里有哪些表情」，群图库解决「群里发过的图我留了哪些」。
  //
  // 为什么值得单独建一个：群友随手发的图在 QQ 侧**没有 emoji_id**，URL 还带一次性签名
  // （rkey 每次都换），所以原来的 md5/URL 判重对它们基本失效 —— 收一张重复一张。
  // 这里用 fileid + dHash 感知哈希解决判重（见 media-lib.js 顶部注释）。
  let mediaLib = null;
  let mediaLibWritable = true;
  const mediaLibDir = (() => {
    const configured = String(cfg.socialV2?.photo?.dir || '').trim();
    return configured ? path.resolve(configured) : MEDIA_LIB_DIR_DEFAULT;
  })();
  function photoEnabled() {
    return cfg.socialV2?.photo?.enabled !== false;
  }
  function photoCollectEnabled() {
    return photoEnabled() && cfg.socialV2?.photo?.collect?.enabled !== false;
  }
  try {
    mediaLib = new MediaLibrary(mediaLibDir, {
      logger: (msg) => log(`[photo] ${msg}`)
    });
    // 启动时顺手做一次卫生：清损坏条目、清超额候选、按上限真删回收站。
    // 顺序有讲究：先清损坏，再滚候选（会往回收站里塞），最后按上限清回收站。
    const broken = mediaLib.cleanupBroken();
    const rolled = mediaLib.cleanupCandidates(Number(cfg.socialV2?.photo?.maxCandidates) || MEDIA_DEFAULTS.maxCandidates);
    const purged = mediaLib.cleanupTrash(Number(cfg.socialV2?.photo?.trashMaxItems) || MEDIA_DEFAULTS.trashMaxItems);
    mediaLib.flush();
    if (broken || rolled || purged) {
      log(`[photo] 图库卫生：清损坏 ${broken}，候选超额滚入回收站 ${rolled}，回收站真删 ${purged}`);
    }
    log(`[photo] 群图库就绪：${mediaLibDir}（共 ${mediaLib.size()} 条，dHash ${sharpAvailable() ? '可用' : '不可用→退化为 sha1 判重'}）`);
  } catch (error) {
    // 与表情库同一套路：索引读不动/坏了**绝不能当空库继续**，
    // 否则下一次落盘就把积累的图全清掉。降级为只读不写并留醒目日志。
    mediaLibWritable = false;
    mediaLib = null;
    log(`⚠️ 群图库加载失败，已降级为「不收录」（不会覆盖原文件）：${error?.message ?? error}`);
  }

  // 群图收录限流（内存态）。默认每群 20/分钟、200/小时 —— 群图是"随手收"，
  // 不能让一个刷图的人把磁盘吃满，也不该让收录逻辑在热路径上无限打接口。
  const photoCollectTimes = new Map(); // key -> number[]
  function photoRateOk(key) {
    const now = Date.now();
    const maxPerMinute = Math.max(0, Number(cfg.socialV2?.photo?.collect?.maxPerMinute) || MEDIA_DEFAULTS.maxPerMinute);
    const maxPerHour = Math.max(0, Number(cfg.socialV2?.photo?.collect?.maxPerHour) || MEDIA_DEFAULTS.maxPerHour);
    const times = (photoCollectTimes.get(key) || []).filter((t) => now - t < 3600000);
    const inMinute = times.filter((t) => now - t < 60000).length;
    if (maxPerMinute > 0 && inMinute >= maxPerMinute) return false;
    if (maxPerHour > 0 && times.length >= maxPerHour) return false;
    times.push(now);
    photoCollectTimes.set(key, times.slice(-500));
    return true;
  }

  function saveMediaLibSafe() {
    if (!mediaLibWritable || !mediaLib) return;
    try { mediaLib.flush(); } catch (error) { log('[photo] 图库落盘失败:', error?.message ?? error); }
  }

  /**
   * 收录一条消息里的图片（去重后落盘）。
   *
   * 关键安全点：**字节由桥接自己抓**，走的是 fetchOneBotImage（内部是 safeFetchBuffer：
   * 仅 https、DNS 固定、逐跳校验、禁内网、限量）。绝不把消息里的原始 URL 交给别处去下载。
   *
   * @returns {Promise<{collected:number,dups:number,skipped:number}>}
   */
  async function captureMessagePhotos(key, mediaList, context = {}) {
    if (!mediaLib || !mediaLibWritable || !photoCollectEnabled()) return { collected: 0, dups: 0, skipped: 0 };
    if (!photoRateOk(key)) return { collected: 0, dups: 0, skipped: 0 };
    const maxPerMessage = Math.max(1, Math.min(9, Number(cfg.socialV2?.photo?.collect?.maxPerMessage) || 3));
    let collected = 0;
    let dups = 0;
    let skipped = 0;
    for (const media of (mediaList || []).slice(0, maxPerMessage)) {
      if (media?.kind !== 'image') { skipped += 1; continue; }
      try {
        const img = await fetchOneBotImage(media);
        if (!img?.buffer) { skipped += 1; continue; }
        // eslint-disable-next-line no-await-in-loop
        const result = await mediaLib.capture(img.buffer, {
          // sourceKey = 来源会话（收集时的 key）。这是"来源信息只在原会话可见"的判据：
          // 别的会话看不到"这图是谁在哪个群发的"。
          sourceKey: context.sourceKey,
          sourceGroup: context.groupId,
          senderId: context.senderId,
          senderName: context.senderName,
          msgText: context.msgText,
          sourceUrl: media.url || '',
          tags: context.tags
        });
        if (result.status === 'new') collected += 1;
        else if (result.status === 'dup') dups += 1;
        else skipped += 1;
      } catch (error) {
        skipped += 1;
        log(`[photo] 收录图片失败: ${error?.message ?? error}`);
      }
    }
    if (collected > 0) {
      saveMediaLibSafe();
      // 收完立刻做一次候选区滚动清理，避免候选区无界增长。
      const rolled = mediaLib.cleanupCandidates(Number(cfg.socialV2?.photo?.maxCandidates) || MEDIA_DEFAULTS.maxCandidates);
      if (rolled > 0) saveMediaLibSafe();
    }
    return { collected, dups, skipped };
  }

  /** 发一张本地图库里的图（走 OneBot 图片段，和发表情同一条 sendChain 保证顺序）。 */
  /**
   * 把一张本地图片当**图片段**发到指定会话（2026-10-21 为"她发自己的造型照"而加）。
   *
   * 为什么不复用 sendPhotoV2：那条路绑死群图库（mediaLib），
   * 而造型图在衣柜目录里，不属于群图库。共用的是同一套：
   * sendChain 串行 → 发送频率闸门 → OneBot send_*_msg → base64 上传。
   *
   * @param {string} key  private:QQ号 / group:群号
   * @param {Buffer} buf  图片字节（调用方已校验过来源与体积）
   * @param {{replyToMessageId?:string, timeoutMs?:number}} [options]
   */
  async function sendLocalImageV2(key, buf, options = {}) {
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('图片字节为空，已拒绝发送');
    // 超时按体积给，别用一个固定值卡死：4K 生图一张 5~10 MB，base64 后 POST 到
    // 网关再上传 QQ，第一发常常 20 秒打不住（2026-10-29 实测：102 秒画完，随后
    // 发图在 20 秒超时被中断，图白画了而聊天里什么都没有）。
    const timeoutMs = Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : Math.min(180000, 30000 + Math.round(buf.length / 1024 / 1024) * 8000);
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = String(key).split(':');
    const segments = [];
    const rid = String(options.replyToMessageId ?? '').trim();
    if (rid && /^-?[1-9]\d*$/.test(rid)) segments.push({ type: 'reply', data: { id: rid } });
    segments.push({ type: 'image', data: { file: 'base64://' + buf.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    let sendResolve, sendReject;
    const sendResult = new Promise((resolve, reject) => { sendResolve = resolve; sendReject = reject; });
    sendChain = sendChain.then(async () => {
      try {
        await sleep(randInt(300, 900));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(timeoutMs)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    return { messageId: data?.message_id ?? null };
  }

  // ── 生图（桌面版「生图工作室」插件，2026-10-29）──────────────────────────────
  //
  // 为什么不给模型开一个 DSH 原生工具：插件的 HTTP 路由本来就在 DSH 的 webServer 上
  // （/api/image-studio/*，和 GUI 同一个 19387 端口），桥接直接调就行；而新增的桥接工具是
  // mcp__snowluma__* 前缀，QQ 工具守卫的 SAFE_PREFIXES 会自动放行，不用去动
  // plugins/qq-agent-presets/qq-tool-restrict.mjs（改那个文件得重启 DSH 才生效）。
  //
  // 插件的产物根写死在 <DSH_HOME>/image-studio/outputs/<年-月>/，但主人可以把 outputs 做成
  // 目录联接指到别处（本机就指到了 QQ bot\小鲸鱼出图），所以这里一律 realpath 解析。

  /** 生图插件的产出根目录。 */
  function studioOutputsRoot() {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    return path.join(home, 'image-studio', 'outputs');
  }

  /**
   * 把一个引用解析成产出目录内真实存在的绝对路径。
   * 认三种写法：绝对路径 / 相对产出根的路径（2026-10/img-xxx.png）/ 纯编号（img-xxx）。
   * 只允许产出根以内的文件 —— 这个工具能往聊天里发图，不能顺手变成任意文件读取。
   */
  function resolveStudioOutput(ref) {
    const raw = String(ref ?? '').trim();
    if (!raw) throw new Error('要发哪张图？给我文件名，或者 img- 开头的编号');
    const root = studioOutputsRoot();
    const candidates = [];
    if (path.isAbsolute(raw)) {
      candidates.push(raw);
    } else {
      candidates.push(path.join(root, raw));
      if (!/\.[A-Za-z0-9]+$/.test(raw)) {
        if (!fs.existsSync(root)) throw new Error(`生图产出目录还不存在：${root}`);
        for (const month of fs.readdirSync(root)) {
          candidates.push(path.join(root, month, `${raw}.png`));
          candidates.push(path.join(root, month, `${raw}.jpg`));
        }
      }
    }
    const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const real = fs.realpathSync(candidate);
      if (real === realRoot || real.startsWith(realRoot + path.sep)) return real;
    }
    throw new Error(`没找到这张图，或者它不在生图产出目录里（只允许发 ${realRoot} 下面的图）`);
  }

  /** 只挑出插件认识的字段，挡住模型顺手多传的东西。 */
  function pickDrawArgs(body) {
    const out = { prompt: String(body.prompt ?? '').trim() };
    for (const field of ['situation', 'expression', 'pose', 'shot', 'light', 'scene', 'props', 'aspect', 'caption']) {
      const value = body[field];
      if (typeof value === 'string' && value.trim()) out[field] = value.trim();
    }
    for (const field of ['characters', 'outfits', 'extra_images']) {
      const value = body[field];
      if (Array.isArray(value) && value.length) out[field] = value.map((item) => String(item));
      else if (typeof value === 'string' && value.trim()) out[field] = [value.trim()];
    }
    if (body.user_requested) out.user_requested = true;
    return out;
  }

  /**
   * 生图的会话范围闸。
   *
   * 2026-10-29 主人的口径（m01927 原话「我的意思只是让群里面也开放生成图，和其他
   * 好友不需要开」）：**管理员私聊 + 群聊**开，**别人的私聊不开**。
   * 一开始按"全体"做过头了，改成这个三档。
   *
   * 为什么群开、别人的私聊不开：群是公开场合，她想发图得能画；别人的私聊是
   * 一对一，一张 ¥0.038，谁都能私聊要图就等于预算对每个陌生人敞开。
   *
   * config.json → socialV2.image.scope：
   *   "owner"           只管理员私聊
   *   "owner-and-groups"（默认）管理员私聊 + 所有群
   *   "everyone"        全都开（含别人的私聊）
   */
  function drawImageAllowed(key) {
    const k = String(key);
    const scope = String(cfg.socialV2?.image?.scope ?? 'owner-and-groups');
    const isOwnerPrivate = k === `private:${cfg.ownerQQ}`;
    const isGroup = k.startsWith('group:');
    if (scope === 'owner') return isOwnerPrivate;
    if (scope === 'everyone') return true;
    return isOwnerPrivate || isGroup;
  }

  /**
   * 一个会话今天还能画几张。返回 { limit, used, left }，limit=0 表示不限。
   *
   * 为什么按"天"而不是"小时"：她的用户是聊天的人，不是跑批的任务 —— 一天 5 张
   * 足够日常「给我画一张」，突发刷屏又会被日额度挡住。跨天用本地日期切，
   * 不用 24 小时滚动窗（否则"昨天下午画了 5 张"会一直压着今天早上）。
   */
  /** 本地日期（YYYY-MM-DD）。不能用 toISOString —— 那是 UTC，中国时区会差 8 小时，
   *  结果凌晨 0~8 点画的图还算在"昨天"，额度和她理解的"今天"对不上。 */
  function localDay(at = Date.now()) {
    const d = new Date(at);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function drawQuotaOf(key) {
    const img = cfg.socialV2?.image ?? {};
    const isOwner = String(key) === `private:${cfg.ownerQQ}`;
    const limit = isOwner
      ? 0
      : Math.max(0, Number(img.dailyPerSession ?? img.dailyPerMember ?? 5) | 0);
    const st = getSocialV2State(key);
    const today = localDay();
    const used = (Array.isArray(st.drawTimes) ? st.drawTimes : [])
      .filter((t) => String(t?.day ?? '') === today).length;
    return { limit, used, left: limit === 0 ? Infinity : Math.max(0, limit - used), today };
  }

  /** 记一次生图成功（按天计数，只留最近 200 条）。
   *  必须立刻落盘：额度只在内存里记的话，桥接一重启非主人就白拿一份新额度。 */
  function noteDrawUsed(key, extra = {}) {
    const { today } = drawQuotaOf(key);
    const st = getSocialV2State(key);
    if (!Array.isArray(st.drawTimes)) st.drawTimes = [];
    st.drawTimes.push({ day: today, at: Date.now(), cost: Number(extra.cost) || 0 });
    if (st.drawTimes.length > 200) st.drawTimes = st.drawTimes.slice(-200);
    saveSocialV2State();
  }

  /** 轮询插件的生图任务，直到 done / failed / 超出预算。 */
  async function pollDraw(base, jobId, budgetMs) {
    const deadline = Date.now() + budgetMs;
    let job = null;
    while (Date.now() < deadline) {
      await sleep(3000);
      job = await fetch(`${base}/api/image-studio/job?id=${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(15000) })
        .then((res) => res.json())
        .catch(() => null);
      if (job && (job.status === 'done' || job.status === 'failed')) break;
    }
    if (job?.status === 'done') return { done: true, job };
    if (job?.status === 'failed') return { failed: job.error || '插件那边说这次没画成', job };
    return { pending: true, job };
  }

  /** 把画好的图发进会话，返回这次生图的结果摘要。 */
  async function deliverDraw(key, job, startedAt, replyToMessageId) {
    const record = job.record ?? {};
    const files = Array.isArray(record.files) ? record.files : [];
    if (!files.length) throw new Error('插件说画好了，但没给出文件名');
    const abs = resolveStudioOutput(files[0]);
    const buf = fs.readFileSync(abs);
    const sent = await sendLocalImageV2(key, buf, { replyToMessageId });
    return {
      id: record.id ?? null,
      image: path.basename(abs),
      bytes: buf.length,
      ms: Date.now() - startedAt,
      model: record.model ?? null,
      cost: record.cost ?? null,
      messageId: sent.messageId ?? null
    };
  }

  /**
   * 触发一次生图，等它画完，把图发进 key 所在的会话。
   *
   * 同步等的预算是 7 分钟（实测一张 4K 要 66~280 秒）。万一还没画完，**不当作失败**：
   * 挂到后台继续等最多 20 分钟，画完直接补发 —— 她那边先回一句"还在画"就行，
   * 这比"等到超时报错、图却白画了"自然得多。
   */
  async function drawImageV2(key, body) {
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) throw new Error('先写一下要画什么（prompt）');
    const base = String(cfg.dsh?.baseUrl || 'http://127.0.0.1:19387').replace(/\/+$/, '');
    const startedAt = Date.now();
    let submitted;
    try {
      submitted = await fetch(`${base}/api/image-studio/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pickDrawArgs(body)),
        signal: AbortSignal.timeout(30000)
      });
    } catch (error) {
      throw new Error(`连不上生图插件（${base}，桌面版 DSH 没开着？）：${error?.message ?? error}`);
    }
    const started = await submitted.json().catch(() => ({}));
    if (!submitted.ok || !started.jobId) {
      const detail = started?.error?.message || started?.error || `HTTP ${submitted.status}`;
      throw new Error(`插件没接下这一单：${detail}`);
    }
    const jobId = started.jobId;
    const budgetMs = Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : 7 * 60 * 1000;
    const outcome = await pollDraw(base, jobId, budgetMs);
    if (outcome.done) return deliverDraw(key, outcome.job, startedAt, body.replyToMessageId);
    if (outcome.failed) throw new Error(outcome.failed);
    void (async () => {
      const more = await pollDraw(base, jobId, 20 * 60 * 1000);
      if (!more.done) { log(`生图：后台也没等到结果（${more.failed || more.job?.status || '未知'}），${key}`); return; }
      try {
        const sent = await deliverDraw(key, more.job, startedAt, body.replyToMessageId);
        log(`生图：超时后补发成功 ${sent.image}（${key}，共 ${Math.round(sent.ms / 1000)} 秒）`);
      } catch (error) {
        log('生图：超时后补发失败', error?.message ?? error);
      }
    })();
    return { pending: true, ms: Date.now() - startedAt, stage: outcome.job?.stage ?? '生成中' };
  }

  async function sendPhotoV2(key, photoRef, options = {}) {
    if (!mediaLib) throw new Error('群图库未就绪');
    const assertSendAllowed = captureSendGuard(key);
    let entry = mediaLib.get(photoRef);
    if (!entry) {
      // 也允许用描述来指：先搜，搜到唯一一条就用它。
      // ⚠️ 必须带 viewerKey —— 否则 B 群可以用 A 群那句聊天原文当"描述"去搜，
      //    搜中与否就能反推出 A 群聊了什么（同一个"看不见内容却能隔空探测"的漏洞，
      //    和 search 里遮蔽搜索词是同一个道理）。
      const hits = mediaLib.search({ q: String(photoRef ?? ''), limit: 2, viewerKey: key });
      if (hits.items.length === 1) entry = mediaLib.get(hits.items[0].id);
    }
    if (!entry) throw new Error(`群图库里找不到 ${photoRef}，请先用 qq_photo_list 查看有效 id`);
    const filePath = mediaLib.pathOf(entry.id);
    if (!filePath) throw new Error(`图 ${entry.id} 的文件已不在磁盘上（可能被清理），请用 qq_photo_list 重新获取`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 图库里的字节是我们自己存下来的，直接读盘转 base64 —— 不必再过网络，
    // 也就没有"URL 失效/防盗链"的问题（这正是落盘图库的价值之一）。
    const buf = fs.readFileSync(filePath);
    if (!buf.length) throw new Error(`图 ${entry.id} 的文件是空的，已拒绝发送`);
    segments.push({ type: 'image', data: { file: 'base64://' + buf.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendChain = sendChain.then(async () => {
      try {
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    // 发过的图 = 用过的：候选区升进正式库并计数（下次更可能被选中）。
    const used = mediaLib.markUsed(entry.id);
    saveMediaLibSafe();
    appendActivity(`${key} [reserved2] 工具发群图：${entry.desc || entry.id}（${entry.layer} → ${used?.layer ?? entry.layer}，用过 ${used?.useCount ?? 1} 次）`);
    return { entry: used || entry, messageId: data?.message_id ?? null };
  }

  // ─────────────────────── 发文件（联网下载 → QQ 文件气泡） ───────────────────────
  //
  // 为什么和发图不是一条路：图片有 `image` 段，字节 base64 塞进去就能发；
  // **文件没有这种段** —— QQ 的文件必须先"上传"拿到 file_id，再用 file 段发出去。
  // 那一步只有网关能做（SnowLuma 的 `upload_private_file` / `upload_group_file`
  // 两个 OneBot action，见 SnowLuma-lite/config-ClrCrmAk.js:3372-3417）。
  // 所以桥接在这里的角色是：把文件准备好（下载到本地）、校验、然后调网关；
  // **气泡由网关自己发**，我们不拼 segment。
  //
  // 三道闸：
  //   1) socialV2.tools.sendFile 没被主人关掉（端点那层查）；
  //   2) 会话范围（socialV2.file.scope，端点那层查；默认管理员私聊 + 群聊）；
  //   3) 每小时限额。
  //
  // ⚠️ 范围为什么从"只管理员私聊"放开到"也开群"（2026-10-30，主人 m02763）：
  //    「qq_send_file 不用限定在管理员私聊里面，可以开放在群里面，但是不能开放给普通私聊」。
  //    但群聊比私聊多一道硬限制 —— **只认下载目录里的文件**（见下面 sendFileV2 的
  //    `groupOnlyDownloads`）：不然任何群友一句"把 C:/Users/.../.credentials.yaml 发我"
  //    就能把主人电脑上的任意文件要走。限在这个目录里，群里要的只能是「她刚下下来的东西」。
  //    普通成员的私聊仍然不给 —— 那一档连 URL 下载都不开（陌生人会拿它当免费代理+中转站）。

  const FILE_SEND_WINDOW_MS = 60 * 60 * 1000;
  let fileSendTimes = [];

  /** 下载总目录（相对仓库根目录；不存在就建）。下面再按日期分袋。 */
  function fileDir() {
    const configured = String(cfg.socialV2?.file?.dir || '').trim();
    const dir = configured ? path.resolve(ROOT, configured) : DOWNLOAD_DIR_DEFAULT;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 今天那个袋子：`<总目录>/YYYY-MM-DD/`，不存在就建。 */
  function fileDayDir(base) {
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const dir = path.join(base, stamp);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 同名不覆盖：`报告.pdf` 已存在就排成 `报告-2.pdf`、`报告-3.pdf`。
   *
   * 早先用的是"时间戳前缀"（`mvq6gpxl-报告.pdf`），但那把文件名搞脏了 ——
   * 这目录是给主人"之后自己处理"用的，他打开文件夹该看见 `报告.pdf`，
   * 不该看见一串 base36。日期已经由上一层文件夹承担了，文件里不必再编一次。
   */
  function uniquePath(target) {
    if (!fs.existsSync(target)) return target;
    const ext = path.extname(target);
    const stem = target.slice(0, target.length - ext.length);
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${stem}-${n}${ext}`;
      if (!fs.existsSync(candidate)) return candidate;
    }
    return `${stem}-${Date.now().toString(36)}${ext}`;
  }

  /**
   * 按名字在下载目录里找文件：先今天那袋、再各日期袋（新的先找）、最后总目录平层。
   *
   * 为什么需要这个：她说 `file='报告.pdf'` 时，文件其实在 `.../2026-10-27/报告.pdf`。
   * 只拼一层会报「找不到这个文件」—— 文件明明在。日期袋是她看不见的实现细节，
   * 不该让她猜。
   *
   * @returns {string} 找到的绝对路径；找不到返回空串
   */
  function findInDownloads(base, name) {
    const candidates = [path.join(fileDayDir(base), name)];
    let dayDirs = [];
    try {
      dayDirs = fs.readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
        .map((d) => d.name)
        .sort()
        .reverse(); // 新的先找
    } catch { /* 列不出来就当没有 */ }
    for (const day of dayDirs) candidates.push(path.join(base, day, name));
    candidates.push(path.join(base, name));
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* 试下一个 */ }
    }
    return '';
  }

  function fileLimitBytes() {
    const raw = Number(cfg.socialV2?.file?.maxBytes);
    return Number.isFinite(raw) && raw > 0 ? raw : 200 * 1024 * 1024;
  }

  /** 只查限额不记账：让「下完了才被告知超限」变成「一开始就拦」。 */
  function checkFileQuota() {
    const now = Date.now();
    const recent = fileSendTimes.filter((t) => now - t < FILE_SEND_WINDOW_MS);
    const cap = Math.max(1, Number(cfg.socialV2?.file?.maxPerHour) || 20);
    if (recent.length >= cap) {
      throw new Error(`这一小时已经发过 ${recent.length} 个文件（上限 ${cap}），过一会儿再说`);
    }
  }

  /** 每小时限额：只在真要发的时候记一笔（下载失败不算）。 */
  function noteFileSend() {
    const now = Date.now();
    fileSendTimes = fileSendTimes.filter((t) => now - t < FILE_SEND_WINDOW_MS);
    fileSendTimes.push(now);
  }

  /** 从 URL 猜一个像样的文件名（去掉 query、解码、砍掉 Windows 不认的字符）。 */
  function guessFileNameFromUrl(urlString, fallback = 'download.bin') {
    try {
      const u = new URL(urlString);
      const raw = decodeURIComponent(String(u.pathname).split('/').filter(Boolean).pop() || '');
      const cleaned = raw.replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/[. ]+$/, '').trim();
      return cleaned.slice(0, 120) || fallback;
    } catch {
      return fallback;
    }
  }

  function sanitizeFileName(name, fallback = 'download.bin') {
    const cleaned = String(name ?? '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/[. ]+$/, '').trim();
    return (cleaned || fallback).slice(0, 120);
  }

  /**
   * 把本地文件交给网关上传并发成文件气泡。
   *
   * @returns {Promise<{fileId:string, action:string}>}
   */
  async function gatewayUploadFile({ kind, id, filePath, name }) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const action = kind === 'private' ? 'upload_private_file' : 'upload_group_file';
    const params = kind === 'private'
      ? { user_id: Number(id), file: filePath, name, upload_file: true }
      : { group_id: Number(id), file: filePath, name, folder_id: '/', upload_file: true };
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      // 大文件上传 + 网关自己再上一次高速通道，给足时间；别用消息发送那种 15 秒。
      signal: AbortSignal.timeout(600000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}`);
    }
    const fileId = body?.data?.file_id ?? null;
    if (!fileId) throw new Error(`OneBot ${action} 没返回 file_id`);
    return { fileId, action };
  }

  /**
   * 发一个文件：`file` 可以是 http(s) URL（先下载）或本机路径（直接用）。
   *
   * @param {string} key   private:QQ号 / group:群号
   * @param {{file:string, name?:string}} params
   *
   * ⚠️ 这里刻意**没有** replyToMessageId / atUserId：文件气泡是网关自己发的，
   *    它拼不出 reply/@ 段。想在文件旁边引用她说的话，就先发文件、再用
   *    qq_send_message / qq_reply 补一句 —— 不要给模型一个"传了也没用"的参数，
   *    那种参数最后一定会被当成"我说过了"的依据。
   */
  async function sendFileV2(key, params = {}) {
    if (cfg.socialV2?.file?.enabled === false) throw new Error('发文件能力已被主人在设置里关掉');
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = String(key).split(':');
    if (!/^\d+$/.test(String(id ?? ''))) throw new Error(`会话 key 不合法：${key}`);

    const raw = String(params.file ?? '').trim();
    if (!raw) throw new Error('file 不能为空');
    // 限额先查：别等几百兆下完了才告诉她超限。
    checkFileQuota();
    const limit = fileLimitBytes();
    const dir = fileDir();

    let filePath = '';
    let bytes = 0;
    let source = '';
    let downloaded = false;
    // 显示名：发给对方时用的名字。磁盘上就用它（重名才加 -2），不再套时间戳前缀。
    let displayName = '';

    if (/^https?:\/\//i.test(raw)) {
      // ── 联网下载 ──
      displayName = sanitizeFileName(params.name || guessFileNameFromUrl(raw));
      // 同名不覆盖，但**不污染文件名**：`报告.pdf` → `报告-2.pdf`。
      // 磁盘上就叫原名，直接扔进「今天」那个日期袋里。
      filePath = uniquePath(path.join(fileDayDir(dir), displayName));
      const result = await downloadToFile(raw, filePath, limit);
      bytes = result.bytes;
      source = result.url;
      downloaded = true;
    } else {
      // ── 本机已有文件 ──
      if (cfg.socialV2?.file?.allowLocalPath === false) {
        throw new Error('主人关掉了「直接发本机文件」，只能给 URL 让我下载');
      }
      // 群聊只管下载目录（2026-10-30 主人 m02763 放开 qq_send_file 时加的硬限制）：
      // 群里任何人都能提要求，不能让她们指名要主人电脑上的任意文件。
      // 管理员私聊不受影响，仍按 socialV2.file.allowedDirOnly 配置走。
      const groupOnlyDownloads = kind === 'group';
      // 相对路径宽容一点，按这个顺序试：
      //   1) 下载总目录里的今天那袋 / 各日期袋 / 平层（见 findInDownloads）
      //   2) 仓库根目录（她跑 qq_run_command 时 cwd 是仓库根，打完包很自然会说
      //      `file='临时打包/xxx.zip'` 或 `file='资料/xxx.zip'`）
      //
      // 为什么要这些兜底：日期袋、仓库根，都是她看不见的实现细节。只认一条路的话，
      // 文件明明在却报「找不到这个文件」，她只能一次次换写法试，最后以为工具坏了。
      // 只对**相对路径**做兜底；绝对路径保持原样（有没有权限由下面 allowedDirOnly 判）。
      if (path.isAbsolute(raw)) {
        filePath = path.resolve(raw);
      } else {
        filePath = findInDownloads(dir, raw)
          || (fs.existsSync(path.resolve(ROOT, raw)) ? path.resolve(ROOT, raw) : path.resolve(dir, raw));
      }
      if (cfg.socialV2?.file?.allowedDirOnly === true || groupOnlyDownloads) {
        // 逃逸判定用「第一段是不是 ..」，不能用 startsWith('..') ——
        // 那会把下载目录里一个名字叫 `..notes.txt` 的正常文件也误判成越界。
        const rel = path.relative(dir, filePath);
        if (rel && (rel.split(path.sep)[0] === '..' || path.isAbsolute(rel))) {
          throw new Error(groupOnlyDownloads && cfg.socialV2?.file?.allowedDirOnly !== true
            ? `群里只能发下载目录里的文件（${dir}）—— 要本机别的文件请直接找主人`
            : `只允许发 ${dir} 里的文件（主人开了「只认下载目录」）`);
        }
      }
      let st;
      try { st = fs.statSync(filePath); } catch (error) {
        throw new Error(`找不到这个文件：${filePath}（${error?.message ?? error}）`);
      }
      if (!st.isFile()) throw new Error(`这不是一个文件：${filePath}`);
      bytes = st.size;
      source = filePath;
    }

    if (!bytes) {
      if (downloaded) { try { fs.unlinkSync(filePath); } catch { /* 忽略 */ } }
      throw new Error('文件是空的（0 字节），QQ 那头也发不出去');
    }
    if (bytes > limit) {
      if (downloaded) { try { fs.unlinkSync(filePath); } catch { /* 忽略 */ } }
      throw new Error(`文件 ${bytes} 字节，超过上限 ${limit} 字节`);
    }

    const name = displayName || sanitizeFileName(params.name || path.basename(filePath), 'file.bin');
    noteFileSend();

    // 上传前再确认一次：会话/模式/白名单没在这几十秒里变过。
    // （下载大文件可能花掉半分钟，期间主人完全可能切了模式。）
    assertSendAllowed();
    const uploaded = await gatewayUploadFile({ kind, id, filePath, name });

    const humanSize = bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    appendActivity(`${key} [reserved2] 工具发文件：${name}（${humanSize}${downloaded ? '，刚下载' : '，本机'}）`);
    return {
      ok: true,
      name,
      bytes,
      size: humanSize,
      fileId: uploaded.fileId,
      action: uploaded.action,
      downloaded,
      source,
      localPath: filePath
    };
  }

  /** 给一张群图写备注/标签（AI 看图后的认知，与收藏表情的 sticker_note 同思路）。 */
  function applyPhotoNoteV2(photoId, note, tags) {
    if (!mediaLib) return null;
    const entry = mediaLib.setDescTags(photoId, tags, note);
    if (!entry) return null;
    saveMediaLibSafe();
    return entry;
  }

  // 从 SnowLuma OneBot 拉取 QQ 账号收藏表情（fetch_custom_face_detail），并合并进本地库。
  // force=true 时忽略 TTL 强制刷新；失败时返回 null（调用方决定是否使用缓存）。
  async function syncStickerLibrary(force = false) {
    if (cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && stickerSyncedAt && now - stickerSyncedAt < ttl) {
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100));
      const response = await bot.request('fetch_custom_face_detail', { count });
      if (!response || response.status !== 'ok' || response.retcode !== 0) {
        throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
      }
      // 只有拿到合法数组才允许合并；data 缺失/异常时不能拿空数组清空本地 QQ 表情库。
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      stickerEntries = mergeStickerLibrary(stickerEntries, fetched, { complete: fetched.length < count });
      stickerSyncedAt = Date.now();
      saveStickerStoreSafe();
      log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${stickerEntries.length} 条）`);
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: false };
    } catch (error) {
      log(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
      return null;
    }
  }

  // 返回给 AI 的表情列表（带本地认知）。
  async function listStickersForV2(query = '', count = 48, force = false) {
    const synced = await syncStickerLibrary(force);
    const entries = synced?.entries ?? stickerEntries;
    return formatStickerList(entries, query, count);
  }

  // 取单个表情的图片字节（多模态用）。
  async function getStickerImageData(stickerId) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) {
      // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
      const forced = await syncStickerLibrary(true);
      const entry2 = findSticker(forced?.entries ?? stickerEntries, stickerId);
      if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
      return entry2;
    }
    return entry;
  }

  // ── 语音发送（把准备好的音频当 QQ 语音条发出） ──────────────────────────────
  //
  // 链路：本地音频文件 → SnowLuma 的 record 段 → 网关自带 SILK 编码 → QQ 语音条。
  // 网关侧事实（v1.14.9 源码确认）：record 段的 file 接受本地路径 / file:// / http(s):// / base64://，
  // 非 SILK 的音频由网关的 native ffmpeg addon 自动转成 NT SILK，所以这里不做预转码。
  //
  // 两条通道，闸门不同（与 /api/send/* 的既有分层一致）：
  //   - agent=true ：QQ 群里的 AI 调用。必须带有效 agent token，且只能发它自己那个会话。
  //   - agent=false：操作者（CLI / 控制台，凭 consoleToken）。跳过会话/模式闸门，
  //                  但仍强制白名单 + 语音限流 + 敏感词审计。
  // 语音发送时间戳（scopeKey → number[]）：与文本发送分开计数，语音额度独立。
  const voiceSendTimes = new Map();

  /**
   * 出站语音的内容审计：与文本一致，凡是「疑似敏感信息 / 含会话令牌」的**文件名**
   * 都不允许外发（语音的音频内容本身无法审计，但文件名同样会泄露路径与项目信息）。
   */
  function assertOutboundAuditOk(key, subject) {
    const text = String(subject ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && text.includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 语音发送被安全策略拦截 (${key})：${hasKnownToken ? '文件名含会话令牌' : '文件名疑似含敏感信息'}`);
      appendActivity(`${key} [voice] 发送被拦截（文件名疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      throw new Error('音频文件名疑似包含敏感信息（路径/凭据/会话令牌），已阻止发送；请重命名后再发');
    }
  }

  function voiceCfg() {
    const v = cfg.socialV2?.voice ?? {};
    return {
      enabled: v.enabled !== false,
      dir: path.resolve(ROOT, String(v.dir ?? 'audio')),
      maxSeconds: Number(v.maxSeconds) > 0 ? Number(v.maxSeconds) : 300,
      maxBytes: Number(v.maxBytes) > 0 ? Number(v.maxBytes) : 20 * 1024 * 1024,
      maxPerMinute: Number(v.maxPerMinute) >= 0 ? Number(v.maxPerMinute) : 2,
      maxPerHour: Number(v.maxPerHour) >= 0 ? Number(v.maxPerHour) : 10,
      allowAbsolutePath: v.allowAbsolutePath === true,
      defaultVolume: Number(v.defaultVolume) > 0 ? Number(v.defaultVolume) : 1,
      loudness: v.loudness || 'normal',
      ffmpegPath: process.env.FFMPEG_PATH || v.ffmpegPath || null,
      autoReadback: v.autoReadback !== false
    };
  }

  function voiceLibrary() {
    const dir = voiceCfg().dir;
    const files = listAudioFiles(dir);
    return files.map((f) => {
      let stat = null;
      try { stat = fs.statSync(f); } catch {}
      return { name: path.relative(dir, f).split(path.sep).join('/'), bytes: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? 0 };
    });
  }

  /**
   * 把「AI 给的语音引用」解析成可发送的本地绝对路径。
   *
   * 安全边界：**AI 只能从语音库目录里取文件**（防 prompt injection 拿任意本地文件当语音外发）。
   *
   * 历史坑（已修）：这里曾经在 `socialV2.voice.allowAbsolutePath: true` 时直接把 AI 给的
   * 绝对路径交给 resolveAudioSource 解析，于是「AI 传 C:\Users\x\Music\任意.mp3」
   * 就能把本机任意音频（< 20 MB）发到群里 —— 而 inspectAudio 对「没有音频流」或
   * ffprobe 不可用的情况是放行的，等于把开关变成了任意文件外发通道。
   * 现在即使开了这个开关，也要求绝对路径**必须落在语音库目录之内**；
   * 真要从库外发文件请走操作者通道（resolveVoicePathForOperator / CLI）。
   */
  function voicePathInsideLibrary(vc, absPath) {
    const rel = path.relative(vc.dir, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
    return safeJoinLibrary(vc.dir, rel);
  }

  function resolveVoicePathForV2(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频：给语音库里的文件名（可用 qq_list_voices 查看）');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受语音库里的本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const isAbs = path.isAbsolute(raw) || /^file:\/\//i.test(raw) || raw.startsWith('~');

    let resolved = null;
    if (isAbs) {
      const r = resolveAudioSource(raw, {});
      const confined = r.path ? voicePathInsideLibrary(vc, r.path) : null;
      if (confined) {
        resolved = { path: confined, via: `${r.via}+library-confined` };
      } else {
        // 只报目录名，不报绝对路径：这条消息会经 MCP 工具错误回给模型，
        // 而模型面对的是不可信的群聊内容（prompt injection 可能诱导它复述本机路径）。
        throw new Error(`语音只能从语音库取文件（语音库目录：${path.basename(vc.dir)}）；即使是绝对路径也必须位于语音库之内（socialV2.voice.allowAbsolutePath 已不再放宽 AI 通道）。请把音频放进语音库，或用操作者通道（CLI / 控制台）发送库外文件。`);
      }
    } else {
      // ⚠️ 安全关键：相对路径**只能**在语音库内解析。
      //
      // 不能直接丢给 resolveAudioSource —— 它会**先用 process.cwd() 解析相对路径**
      // （voice-core.js 的 cwd 分支），于是 AI 传 `..\..\某个\本机文件.mp3` 就能读库外文件，
      // 把 allowAbsolutePath=false 这个闸门整个绕过去（实测可复现）。
      // 相对路径一律先过 safeJoinLibrary（含 realpath 复核，挡 symlink 逃逸）。
      const joined = safeJoinLibrary(vc.dir, raw);
      if (joined && fs.existsSync(joined) && fs.statSync(joined).isFile()) {
        resolved = { path: joined, via: 'voice-dir-safe' };
      } else {
        // 允许省略扩展名：逐个补常见扩展名再在库内试一次（仍然不越出语音库）
        if (!path.extname(raw)) {
          for (const ext of AUDIO_EXTS) {
            const cand = safeJoinLibrary(vc.dir, `${raw}${ext}`);
            if (cand && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
              resolved = { path: cand, via: 'voice-dir-safe+ext' };
              break;
            }
          }
        }
        if (!resolved) {
          // 库内没找到：检查是不是"想读库外文件"（这条错误要说清楚，避免误以为是名字写错）
          const looksLikeEscape = /(^|[\\/])\.\.([\\/]|$)/.test(raw) || path.isAbsolute(raw);
          if (looksLikeEscape) {
            throw new Error('语音只能从语音库取文件：路径里出现了「..」或绝对路径，已拒绝（防止读到库外的本机文件）');
          }
        }
      }
    }

    if (resolved) return { path: resolved.path, via: resolved.via, resolvedFrom: raw };

    // 模糊提示：只列库内文件（绝不回显库外路径）
    const library = voiceLibrary();
    const hint = library.length
      ? `语音库里现有：${library.slice(0, 12).map((x) => x.name).join('、')}${library.length > 12 ? ` 等 ${library.length} 个` : ''}`
      : `语音库（${path.basename(vc.dir)}）目前是空的，先把音频文件放进去`;
    // 按 basename 去扩展名做近似匹配（只用于提示）
    const want = path.basename(raw).toLowerCase();
    const wantNoExt = want.replace(/\.[^.]+$/, '');
    const fuzzyHits = library
      .filter((x) => {
        const base = path.basename(x.name).toLowerCase();
        return base === want || base.replace(/\.[^.]+$/, '') === wantNoExt;
      })
      .map((x) => x.name);
    const fuzzy = fuzzyHits.length ? `；近似匹配：${fuzzyHits.join('、')}` : '';
    throw new Error(`语音库里找不到「${raw}」${fuzzy}。${hint}`);
  }

  /**
   * 操作者通道（CLI）的路径解析：允许绝对路径（操作者本来就能读本机文件），
   * 相对路径先按「语音库」解析，再按当前工作目录解析 —— 这样两种直觉写法都成立。
   * base64/http 来源仍然禁止：语音应来自本地文件，别让 CLI 变成任意 URL 的外发口子。
   */
  function resolveVoicePathForOperator(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频路径');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const r = resolveAudioSource(raw, { voiceDir: vc.dir });
    if (r.path) return { path: r.path, via: r.via, resolvedFrom: raw };
    const fuzzy = r.candidates?.length ? `；语音库近似匹配：${r.candidates.map((c) => path.basename(c.path)).join('、')}` : '';
    throw new Error(`找不到音频「${raw}」${fuzzy}`);
  }

  /**
   * 语音发送限流：与文本发送分开计数，避免语音吃掉聊天额度（也避免聊天把语音额度耗光）。
   *
   * 只**检查**不占额度：额度在真正发出去之后才由 voiceBudgetCommit 记账 ——
   * 这样参数错、被审计拦截、网关失败都不会白白吃掉配额（否则连失败几次就被假 429 卡住）。
   */
  function voiceBudgetCheck(scopeKey, cfgV) {
    const now = Date.now();
    const bucket = voiceSendTimes.get(scopeKey) ?? [];
    const inMinute = bucket.filter((t) => now - t < 60000);
    const inHour = bucket.filter((t) => now - t < 3600000);
    if (cfgV.maxPerMinute > 0 && inMinute.length + 1 > cfgV.maxPerMinute) {
      throw new Error(`语音发送频率超限（每分钟最多 ${cfgV.maxPerMinute} 条），请稍后再试`);
    }
    if (cfgV.maxPerHour > 0 && inHour.length + 1 > cfgV.maxPerHour) {
      throw new Error(`语音发送频率超限（每小时最多 ${cfgV.maxPerHour} 条），请稍后再试`);
    }
  }

  /** 语音真正发出后记账（顺带裁掉超过 1 小时的旧时间戳，避免数组无界增长）。 */
  function voiceBudgetCommit(scopeKey, at = Date.now()) {
    const bucket = (voiceSendTimes.get(scopeKey) ?? []).filter((t) => at - t < 3600000);
    bucket.push(at);
    voiceSendTimes.set(scopeKey, bucket);
  }

  /**
   * 底层发送：把音频作为 record 段交给 SnowLuma。
   * guard=true（agent 通道）时，发送前必须通过 captureSendGuard —— 会话/模式/白名单任一变
   * 就放弃发送；guard=false（操作者通道）时不套会话闸门（操作者可能不在任何会话里）。
   *
   * audio 可传音量设置 { volume, normalize, loudness }：SnowLuma 的 record 段没有增益字段，
   * 所以音量必须在本地用 ffmpeg 调好再发（临时文件发完即删）。
   */
  async function sendVoiceV2(key, filePath, { guard = false, audit = true, audio = null } = {}) {
    const vc = voiceCfg();
    // 注意：这里**不检查** vc.enabled —— 那是「AI 能不能发语音」的开关，判定放在
    // AI 路由（/api/socialV2/send-voice）与 sendVoiceForV2 里。底层只管发，
    // 否则"默认不启用"会连操作者通道（CLI / 控制台面板 / 图形界面）一起封死。
    if (audit) assertOutboundAuditOk(key, `[语音:${path.basename(filePath)}]`);
    let info;
    try {
      info = await inspectAudio(filePath, { maxBytes: vc.maxBytes, maxSeconds: vc.maxSeconds });
    } catch (error) {
      throw new Error(`音频检查失败：${error?.message ?? error}`);
    }
    if (!info.ok) throw new Error(`音频不可发送：${info.error}`);

    // 音量处理（默认原样 → 不产生临时文件）
    let processed;
    try {
      processed = await processAudioVolume(filePath, {
        volume: audio?.volume ?? vc.defaultVolume,
        normalize: audio?.normalize === true,
        loudness: audio?.loudness ?? vc.loudness,
        ffmpegPath: vc.ffmpegPath
      });
    } catch (error) {
      throw new Error(`音量处理失败：${error?.message ?? error}`);
    }
    const sendPath = processed.path;

    const assertSendAllowed = guard ? captureSendGuard(key) : null;
    const [kind, id] = key.split(':');
    const recordSegment = { type: 'record', data: { file: sendPath } };
    let resolveSend;
    let rejectSend;
    const sendPromise = new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; });
    sendChain = sendChain.then(async () => {
      try {
        if (assertSendAllowed) assertSendAllowed();
        // 语音条比图片大、要过一次 SILK 转码，给 60s 预算（文本/图片共用同一 sendChain，
        // 所以这条语音发完之前后面的文本会自然排队，不会插队到语音前面）。
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
        const params = kind === 'private'
          ? { user_id: Number(id), message: [recordSegment] }
          : { group_id: Number(id), message: [recordSegment] };
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(60000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        resolveSend(body.data);
      } catch (error) {
        rejectSend(error);
      }
    });
    try {
      const data = await sendPromise;
      return {
        messageId: data?.message_id ?? null,
        bytes: info.size,
        duration: info.duration ?? null,
        codec: info.codec ?? '',
        warnings: info.warnings ?? [],
        detail: describeAudio(info),
        // 音量处理信息：mode='original' 表示没动过（没产生临时文件）
        audioProcessing: processed.detail,
        volume: processed.volume,
        loudness: processed.loudness,
        audioMode: processed.mode
      };
    } finally {
      // 音量处理产物是一次性的：发完（或失败）就删，别把 temp 撑大
      cleanupTemp(sendPath, processed.converted);
    }
  }

  /**
   * 把她**亲口说的那句话**落到 `state/sent-voice-logs/YYYY-MM-DD.jsonl`。
   *
   * 只做一件事：留一份原文给记忆整理用（见 SENT_VOICE_DIR 的注释）。
   * 任何失败都只记一条日志 —— 落盘笔记绝不能影响已经发出去的语音。
   * 注意这里**不做 truncate**：一句话本来就短，截断会造成"记忆里她说的话是半句"。
   */
  function appendSentVoiceLog(key, text) {
    const spoken = String(text ?? '').trim();
    if (!spoken || !key) return;
    try {
      const now = new Date();
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      fs.mkdirSync(SENT_VOICE_DIR, { recursive: true });
      const line = JSON.stringify({ t: now.toISOString(), key, text: spoken }) + '\n';
      fs.appendFileSync(path.join(SENT_VOICE_DIR, `${day}.jsonl`), line, 'utf8');
    } catch (error) {
      log(`[voice] 语音原文旁注写失败（不影响发送）：${error?.message ?? error}`);
    }
  }

  /** 把「我发了条语音」写进二代会话的 recentMessages，让 AI 自己知道刚发过什么。 */
  function recordVoiceSentV2(key, sent, label) {
    const st = getSocialV2State(key);
    const display = label || `[语音 ${sent.detail}]`;
    const entry = {
      messageId: sent.messageId ? String(sent.messageId) : null,
      sender: '我',
      text: truncateText(display, 200),
      plain: truncateText(display, 200),
      quoteTargetIsSelf: false,
      isOwner: true,
      ownerLabel: '我',
      isSelf: true,
      at: Date.now()
    };
    st.recentMessages.push(entry);
    if (st.recentMessages.length > 200) st.recentMessages = st.recentMessages.slice(-200);
    st.lastAiReplyAt = entry.at;
    st.lastActionAt = entry.at;
    st.wakeConfig.noActionCount = 0;
    saveSocialV2State();
  }

  /**
   * 发完语音后的**落地验证**：把这条消息从网关读回来，确认它真的带着 record 段。
   *
   * 为什么不用 fetch_ptt_text 做这件事：那个动作依赖 QQ 侧的语音转写结果，
   * 而**自己发出去的**语音根本不会产生转写（实测 retcode=100「消息中不包含语音」）。
   * 想让 AI 确认「语音真的发出去了」，唯一可靠的证据是 get_msg 回读到的 record 段。
   * 返回 { confirmed, file, duration } 或 null（读不回来不影响"已发送"这个事实）。
   */
  async function verifyVoiceMessageSent(messageId) {
    if (!messageId) return null;
    try {
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${httpUrl}/get_msg`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify({ message_id: Number(messageId) }),
        signal: AbortSignal.timeout(30000)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok' || body.retcode !== 0) return null;
      const segments = Array.isArray(body.data?.message) ? body.data.message : [];
      const record = segments.find((s) => s?.type === 'record');
      if (!record) return null;
      // 注意：只回报「确认成功 + 时长」，**不回传 file/url**。
      // 私聊消息里 get_msg 会把源文件路径塞进 url（如 D:\...\audio\xxx.mp3），
      // 回给 AI 就等于把本机路径写进模型上下文（也会被敏感信息审计拦）。
      return {
        confirmed: true,
        duration: record.data?.duration != null ? Number(record.data.duration) : null
      };
    } catch (error) {
      log(`[voice] 发送后回读校验失败（不影响已发送）：${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * AI 通道入口：解析引用 → 限流 → 发送 → 记账 → 回读校验。
   * 返回 { messageId, detail, verified, readback }。
   */
  async function sendVoiceForV2(key, voiceRef, { label = '', verify = null, readback = false, audio = null } = {}) {
    const vc = voiceCfg();
    if (!vc.enabled) throw new Error('语音功能已关闭（socialV2.voice.enabled=false）');
    const resolved = resolveVoicePathForV2(voiceRef);
    // 音量参数校验前置（AI 传错时给出可读错误，而不是让 ffmpeg 报奇怪的错）
    if (audio) resolveAudioProcessing({ volume: audio.volume ?? vc.defaultVolume, normalize: audio.normalize === true, loudness: audio.loudness ?? vc.loudness });
    voiceBudgetCheck(key, vc);
    const sent = await sendVoiceV2(key, resolved.path, { guard: true, audit: true, audio });
    voiceBudgetCommit(key);
    recordVoiceSentV2(key, sent, label);
    log(`[voice] ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}, messageId=${sent.messageId ?? '?'})`);
    appendActivity(`${key} [voice] 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
    let readbackText = null;
    const wantReadback = readback === true;
    if (wantReadback && sent.messageId) {
      try {
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify({ message_id: String(sent.messageId) }),
          signal: AbortSignal.timeout(30000)
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.status === 'ok' && body.retcode === 0) readbackText = body.data?.text ?? '';
      } catch (error) {
        log(`[voice] 语音转写回读失败（不影响已发送）：${error?.message ?? error}`);
      }
    }
    // 默认做「回读到 record 段」的落地校验；转写按需（自己发的语音通常没有转写）。
    const wantVerify = verify === true || (verify !== false && vc.autoReadback);
    const verification = wantVerify ? await verifyVoiceMessageSent(sent.messageId) : null;
    return { ...sent, key, file: resolved.path, via: resolved.via, verification, readback: readbackText };
  }

  /**
   * AI 通道入口（语音合成版）：她说一句话 → 本机合成成音频 → 走**与 sendVoiceForV2 完全相同**的发送链路。
   *
   * ★安全边界★ 这里的音频路径**由桥接自己生成**（tts-lib 的 newSpeechPath，落在系统临时目录，
   * 文件名固定 `qq-speak-<毫秒>-<随机>.<ext>`），**故意不经过 resolveVoicePathForV2**。原因：
   * 那条路只认语音库 `audio/` 内的文件，是一道刻意保留的防注入边界 —— 允许模型"指定任意路径去发"
   * 就等于给它开了一条任意文件外发通道。所以工具那侧她永远只能传**文字**，路径由我们给、发完即删，
   * 她拿不到"把某个文件发出去"的能力。详见 src/tts-lib.js 顶部注释。
   *
   * 与 sendVoiceForV2 的差别只有两处：音频来源换成本机合成；返回里 file 只给 basename
   * （合成文件是内部临时产物，把完整临时路径回给模型没有意义，也更容易被敏感信息审计碰到）。
   */
  async function speakForV2(key, text, { label = '', verify = null, voice = '', rate = '', ttsVolume = '', pitch = '' } = {}) {
    const vc = voiceCfg();
    if (!vc.enabled) throw new Error('语音功能已关闭（socialV2.voice.enabled=false）');
    // 走模块级单例而不是 main() 的局部 const：退出钩子和测试 harness 都在 main() 作用域外，
    // 而 vm 里 main() 根本不会被执行（源码在 SIGINT 钩子处被截断），局部 const 会落在 TDZ 里。
    const engine = ttsInstance;
    if (!engine) throw new Error('语音合成未初始化');
    // ⚠️ 这里**不**判 `engine.enabled`：它是进程启动时 createTts 拍下的快照，
    //    控制台把 socialV2.tts.enabled 改成 false 之后它仍是 true —— 于是"开关关了却还在合成"。
    //    （2026-10-20 给控制台加语音开关时踩到。）真正的判定改成**现读热配置**：
    //    只要 config.json 里 tts.enabled 是 false，就立刻当关处理，不必重启桥接。
    if (cfg.socialV2?.tts?.enabled === false) throw new Error('语音合成已关闭（socialV2.tts.enabled=false）');
    const spoken = String(text ?? '').trim();
    if (!spoken) throw new Error('要念的内容是空的');
    // 限流前置：合成要花几秒和一次网络请求，超限时不该先花掉这些
    voiceBudgetCheck(key, vc);
    const made = await engine.synthesize({ text: spoken, voice, rate, volume: ttsVolume, pitch });
    if (!made) throw new Error('语音合成失败（引擎不可用或没联网），这条只能发文字');
    try {
      const sent = await sendVoiceV2(key, made.path, { guard: true, audit: true, audio: null });
      voiceBudgetCommit(key);
      // label 用她实际说的话，这样 recentMessages 里留的是"我说了什么"，而不是一串文件名
      recordVoiceSentV2(key, sent, label || spoken.slice(0, 40));
      // 旁注一份原文：她亲口说的句子在 messages.db 里是看不到的（语音条正文为空），
      // 只有这里留了底，记忆整理才记得住"她是怎么回的"。落盘失败不影响已发出的语音。
      appendSentVoiceLog(key, spoken);
      log(`[tts] ${key} 已发送合成语音 ${made.bytes} 字节 (${sent.detail}, messageId=${sent.messageId ?? '?'}, voice=${made.voice ?? '?'})`);
      appendActivity(`${key} [voice] 发送合成语音 (${sent.detail})`);
      const wantVerify = verify === true || (verify !== false && vc.autoReadback);
      const verification = wantVerify ? await verifyVoiceMessageSent(sent.messageId) : null;
      return {
        ...sent,
        key,
        file: path.basename(made.path),
        bytes: made.bytes,
        chars: made.chars,
        voice: made.voice,
        engine: made.engine,
        text: spoken,
        synthesized: true,
        verification,
        readback: null
      };
    } finally {
      // 无论成功失败都要删：合成文件是内部产物，留在临时目录里只会越堆越多
      cleanupSpeech(made.path);
    }
  }

  /**
   * ⭐ 语音优先发送：先试语音，实在发不出去才退文字。
   *
   * 主人 2026-10-20 的要求：「常驻语音功能，只在用不了语音再发送文字」。
   *
   * 为什么必须在桥接里做这件事，而不是只改提示词：
   *   提示词只能说"尽量用语音"，但她**没法预知**这次会不会失败 ——
   *   没联网、引擎没起、频率超限、音频太长，都是在合成的**那一刻**才知道。
   *   如果让她先 speak 再看返回，一旦失败她要么重试（浪费一轮）、
   *   要么干脆吞掉这句话（用户什么都没收到）。所以由桥接兜底：
   *   合成失败就**当场**把同一段文字用普通消息发出去，用户永远能收到。
   *
   * @returns {{sent:boolean, mode:'voice'|'text', detail?:string, voice?:object}}
   */
  async function speakOrTextV2(key, text, opts = {}) {
    const spoken = String(text ?? '').trim();
    if (!spoken) throw new Error('要发的内容是空的');
    // ⭐ 通话中：这句话该说给电话那头听，不该落进 QQ 聊天窗。
    //    （2026-10-25 主人实测：她在通话里回「能听见」，结果变成一条聊天消息 ——
    //     因为 qq_say 走的是社交发送链路，这条路根本不知道电话正在通话。）
    if (await callRerouteTextIfInCall(key, spoken)) {
      return { rerouted: 'call', key, text: spoken };
    }
    // 兜底发文字：走和 qq_send_message 同一条底层路径（sendMessagesV2），
    // 这样分条间隔、引用、审计、记账都与正常发送一致，不另开一条"影子发送"。
    const fallbackText = async () => {
      const sentMessages = await sendMessagesV2(
        key, [spoken], [0], opts.replyToMessageId ?? undefined, opts.atUserId ?? undefined
      );
      recordSentMessagesV2(key, sentMessages);
      const st = getSocialV2State(key);
      st.lastAiReplyAt = Date.now();
      st.lastActionAt = Date.now();
      st.wakeConfig.noActionCount = 0;
      saveSocialV2State();
      return sentMessages;
    };

    // 1) 先看语音通不通。开关全关时**不必**白试一次合成（那要几百毫秒到几秒）。
    //    ⚠️ 通话中的改道在函数最开头就做掉了（callRerouteTextIfInCall），
    //       走到这里说明没在通话，可以照常走 QQ 语音条。
    //
    // ⚠️ 这里只看 `voice.enabled`（`voiceCfg()` 每次现读 cfg.socialV2 ⇒ **热生效**），
    //    不再看 `ttsInstance.enabled` —— 那个是进程启动时 createTts 拍下的快照，
    //    控制台把开关关掉之后它仍是 true，于是"关了还在发语音"。
    //    （2026-10-20 加控制台开关时踩到的：单靠 tts.enabled 关不掉。）
    //    tts 实例自身仍会在 synthesize 里判它那份 cfg.enabled；两者的差别只影响
    //    "要不要白试一次合成"，不影响最终行为 —— 关了就是关。
    const vc = voiceCfg();
    // ⭐ speak 工具开关（控制台那个）关着 = 主人不要语音这条路（2026-10-23 主人要求：
    //    「我的语音是我自己关闭的就不要被误判是出错」）。
    //    所以**不是报错**，是安静地走文字，并且告诉她这是设置、不是故障。
    //    （以前端点在更前面就 403 了，她拿到 isError 会当成"语音坏了"反复重试。）
    if (!v2ToolEnabled('speak')) {
      await fallbackText();
      return {
        sent: true,
        mode: 'text',
        detail: '语音是主人自己关掉的（socialV2.tools.speak=false），这句已按文字发出去；以后直接打文字就行，不用再试语音、也不用到别处找原因。'
      };
    }
    if (vc.enabled) {
      try {
        const voice = await speakForV2(key, spoken, opts);
        return { sent: true, mode: 'voice', voice, detail: `已发语音（${voice.engine}／${voice.voice}）` };
      } catch (error) {
        // 失败原因要留给模型看，它才好决定要不要跟对方说一句"我这儿发不出声音"
        const why = String(error?.message ?? error);
        // voiceOnly：语音失败就**失败**，不退文字。
        // 这是原先 qq_speak 的行为（「我就是要发语音」）。
        // 为什么要保留它：有些话用文字发出去反而奇怪 —— 比如她本来想说句"晚安"，
        //     退成打字就变味了。让她能选"宁可不发也不打字"是合理的。
        if (opts.voiceOnly === true) {
          log(`[speak-only] ${key} 语音失败（voiceOnly，不退文字）：${why}`);
          throw new Error(`语音发不出去，且这次要求只发语音不退文字：${why}`);
        }
        log(`[speak-first] ${key} 语音失败，改发文字：${why}`);
        appendActivity(`${key} [voice] 语音失败，已改用文字（${why.slice(0, 60)}）`);
        try {
          await fallbackText();
        } catch (sendError) {
          throw new Error(`语音失败（${why}），文字也发不出去（${sendError?.message ?? sendError}）`);
        }
        return { sent: true, mode: 'text', detail: `语音失败已改发文字：${why}` };
      }
    }
    // 2) 语音整条通道都关着 —— 直接发文字，别让这句话丢掉。
    await fallbackText();
    return { sent: true, mode: 'text', detail: '语音功能未开启，已发文字' };
  }

  // 发送一个收藏表情（按 emoji_id/url/md5 解析，发图片段）。
  async function sendStickerV2(key, stickerRef, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerRef);
    if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id`);
    const url = entry.url;
    if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 在桥接内完成带 DNS 固定、逐跳校验和大小限制的下载；不能把 URL 交给网关重新抓取。
    // ⚠️ 必须显式传上限：safeFetchBuffer 的默认参数是 4MB 兜底，不传就等于绕开
    //    socialV2.media.maxBytes（群里动图常超过 4MB，会被这里静默截断）。
    let image;
    try {
      image = await safeFetchBuffer(url, MAX_MEDIA_BYTES());
    } catch (error) {
      throw new Error(`表情 ${entry.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
    }
    segments.push({ type: 'image', data: { file: 'base64://' + image.buffer.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 与文本发送共用 sendChain，保证“先文字后表情”的真人顺序不被并发工具调用打乱。
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendChain = sendChain.then(async () => {
      try {
        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    // 更新本地使用统计
    const updated = markStickerUsed(stickerEntries, entry.id, 'sticker');
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return { entry: updated.entry, messageId: data?.message_id ?? null };
  }

  // 更新本地 AI 认知（含义/标签/用法）。
  function applyStickerNoteV2(stickerId, note, tags, usage) {
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    const updated = applyStickerNote(stickerEntries, stickerId, patch);
    if (!updated.entry) return null;
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return updated.entry;
  }

  // 修改 QQ 账号里的收藏表情备注（modify_custom_face），并同步本地 desc。
  async function setStickerRemarkV2(stickerId, remark) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    const response = await bot.request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = applyStickerNote(stickerEntries, entry.id, {});
    // 直接改 desc（保留本地认知）
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return stickerEntries.find((e) => e.id === entry.id) || null;
  }

  // 收藏聊天里的一张表情（add_custom_face），并按 AI 看到的含义写简短备注（modify_custom_face）。
  async function collectStickerV2(key, messageRef, remark) {
    const assertSendAllowed = captureSendGuard(key);
    const st = getSocialV2State(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    let file = '';
    if (media?.kind === 'image') {
      // 优先取图片字节转 base64，避免 SnowLuma 直接下载聊天图片 URL 失败（带签名/防盗链）。
      // 严禁把消息里的原始 media.url / media.file 直接交给 OneBot 去下载：那会绕过 SSRF/本地文件防护。
      const img = await fetchOneBotImage(media);
      if (img?.buffer) {
        file = 'base64://' + img.buffer.toString('base64');
      } else {
        throw new Error('无法安全获取该图片字节，已拒绝收藏');
      }
    } else if (media?.kind === 'face') {
      const face = await fetchFaceMedia(media);
      if (face?.buffer) file = 'base64://' + face.buffer.toString('base64');
    }
    if (!file) throw new Error('无法获取该表情的图片源');
    assertSendAllowed();
    const addRes = await bot.request('add_custom_face', { file });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      assertSendAllowed();
      const modRes = await bot.request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        log(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    // 强制刷新本地库，让刚收藏的表情立即可用。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, emojiId);
    return { emojiId, entry: entry || null, remark: cleanRemark };
  }

  function saveSlangStore() {
    if (!slangStoreWritable) {
      log('⚠️ 黑话库处于只读降级状态（启动时加载失败），本次改动不落盘');
      return;
    }
    try {
      const result = saveSlang(SLANG_FILE, slangEntries);
      if (result?.dropped > 0) {
        slangEntries = result.entries;
        log(`黑话库超过 ${SLANG_MAX_ENTRIES} 条上限，已按「已确认优先」丢弃 ${result.dropped} 条最不活跃的词条`);
      }
    } catch (error) { log('保存黑话库失败:', error?.message ?? error); }
  }

  function queueSlangTask(fn) {
    slangTaskChain = slangTaskChain.then(fn).catch((error) => log('黑话学习任务异常:', error?.message ?? error));
    return slangTaskChain;
  }

  async function ensureSlangLearnerSession() {
    const preset = resolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('黑话学习缺少已验证的安全 preset，拒绝创建或复用会话');
    const saved = readJsonSafe(SLANG_SESSION_FILE, null);
    // 旧记录没有 preset 元数据，无法证明其权限，必须重新创建。
    if (saved?.preset !== preset) invalidateSlangLearnerSession();
    if (slangLearnerSessionId) {
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    if (saved?.sessionId && saved.preset === preset) {
      slangLearnerSessionId = String(saved.sessionId);
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      await ensureChatModel(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    const dir = path.join(STATE_DIR, 'slang-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'slang workspace.create');
    const workspaceTitle = cfg.slang?.workspaceTitle || 'QQ 黑话学习';
    if (wsValue.created && workspaceTitle) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    params.agentPreset = preset;
    const value = unwrap(await api.sessions.create(params), 'slang session.create');
    slangLearnerSessionId = value.sessionId;
    learnerSessions.add(slangLearnerSessionId);
    api.events.follow(slangLearnerSessionId);
    await ensureChatModel(slangLearnerSessionId);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(SLANG_SESSION_FILE, { sessionId: slangLearnerSessionId, preset });
    log(`黑话学习会话已创建：${slangLearnerSessionId}`);
    return slangLearnerSessionId;
  }

  function invalidateSlangLearnerSession() {
    // 如果在途任务仍在使用旧会话，先保留 learnerSessions 以便事件继续被消费；
    // 没有等待/收集中的旧会话才从集合移除。
    const oldId = slangLearnerSessionId;
    slangLearnerSessionId = null;
    if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
      learnerSessions.delete(oldId);
    }
    try { fs.unlinkSync(SLANG_SESSION_FILE); } catch {}
  }

  function waitLearnerTurn(sessionId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = learnerWaiters.get(sessionId) ?? [];
        const idx = arr.findIndex((w) => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) learnerWaiters.delete(sessionId);
        reject(new Error(`等待学习会话 turn 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = { resolve, reject, timer };
      const arr = learnerWaiters.get(sessionId) ?? [];
      arr.push(waiter);
      learnerWaiters.set(sessionId, arr);
    });
  }

  async function runSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;

    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      log(`黑话学习会话创建失败 (${key}):`, error?.message ?? error);
      return;
    }

    const promptText = buildExtractionPrompt(messages);
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(`黑话提取被拒 (${key}): ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const items = parseExtractionJson(output);
      if (!items.length) {
        log(`黑话提取：${key} 未发现候选`);
        const win = slangWindows.get(key) ?? [];
        slangWindows.set(key, win.slice(messages.length));
        return;
      }
      let added = 0;
      let updated = 0;
      const researchCandidates = [];
      const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
      const seenContents = new Set();
      for (const item of items) {
        if (seenContents.has(item.content)) continue;
        seenContents.add(item.content);
        const idx = Number(item.source_id) - 1;
        const src = Number.isInteger(idx) && idx >= 0 && idx < messages.length ? messages[idx] : null;
        const evidence = src ? [{ key, sender: src.sender, text: src.text, time: src.time }] : [];
        const result = upsertSlangEntry(slangEntries, item.content, { evidence, countIncrement: 1 });
        if (result.created) added += 1; else updated += 1;
        if (result.entry && result.entry.status === SLANG_STATUS.CANDIDATE && thresholds.includes(result.entry.count) && result.entry.count > result.entry.lastInferenceCount) {
          researchCandidates.push(result.entry);
        }
      }
      const win = slangWindows.get(key) ?? [];
      slangWindows.set(key, win.slice(messages.length));
      saveSlangStore();
      log(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条`);
      if (researchCandidates.length && cfg.slang?.autoResearch !== false) {
        queueSlangTask(() => runSlangResearch(researchCandidates));
      }
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      log(`黑话提取失败 (${key}):`, error?.message ?? error);
    }
  }

  async function runSlangResearch(candidates) {
    if (!candidates || !candidates.length) return;
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    // 过滤掉已经在研究队列里的候选，避免同一批被重复排队研究。
    const targets = candidates.filter((e) => e && !slangResearchingIds.has(e.id));
    if (!targets.length) return;
    for (const e of targets) slangResearchingIds.add(e.id);
    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      for (const e of targets) slangResearchingIds.delete(e.id);
      log('黑话研究会话创建失败:', error?.message ?? error);
      return;
    }
    const promptText = buildResearchPrompt(targets);
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(`黑话研究被拒: ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const results = parseResearchJson(output);
      for (const r of results) {
        const entry = slangEntries.find((e) => e.content === r.content);
        if (!entry) continue;
        // 只有明确确认（confirmed: true）的结果才写入解释字段；
        // 不确定/未确认的结果保留原状，允许后续再次研究。
        if (r.confirmed !== true) {
          log(`黑话研究：${r.content} 未确认，保留候选待后续研究`);
          continue;
        }
        if (r.meaning) entry.meaning = r.meaning;
        if (r.usage) entry.usage = r.usage;
        if (r.example) entry.example = r.example;
        if (r.risk) entry.risk = r.risk;
        if (Array.isArray(r.sources) && r.sources.length) entry.sources = r.sources.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 10);
        entry.lastInferenceCount = entry.count;
        entry.updatedAt = new Date().toISOString();
      }
      saveSlangStore();
      log(`黑话研究：已更新 ${results.length} 条候选解释`);
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      log('黑话研究失败:', error?.message ?? error);
    } finally {
      for (const e of targets) slangResearchingIds.delete(e.id);
    }
  }

  function maybeQueueSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const cooldown = Number(cfg.slang?.extractCooldownMs ?? 300000);
    const last = slangExtractionCooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldown) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;
    slangExtractionCooldowns.set(key, Date.now());
    queueSlangTask(() => runSlangExtraction(key));
  }

  // 黑话学习素材入口：群聊普通消息进入滚动窗口（命令/角色控制语不学；
  // 只学当前消息自己的文字，不学引用原文）。一代/二代共用。
  function feedSlangWindow(key, sender, plainContent) {
    if (cfg.slang?.enabled === false) return;
    if (!key || !plainContent || typeof plainContent !== 'string') return;
    const text = plainContent.trim();
    if (!text || text.startsWith('/')) return;
    if (/进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(text)) return;
    if (!slangWindows.has(key)) slangWindows.set(key, []);
    const win = slangWindows.get(key);
    win.push({ sender: String(sender || '未知'), text: truncateText(text, 200), time: Date.now() });
    if (win.length > 80) win.splice(0, win.length - 80);
    maybeQueueSlangExtraction(key);
  }

  // AI 提交黑话候选的限频：防止单个会话在短时间内刷大量候选。
  function allowSlangSubmit(key) {
    const now = Date.now();
    const arr = (slangSubmitTimes.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    const recentMinute = arr.filter((t) => now - t < 60 * 1000).length;
    const MAX_PER_MINUTE = 2;
    const MAX_PER_HOUR = 10;
    if (recentMinute >= MAX_PER_MINUTE || arr.length >= MAX_PER_HOUR) return false;
    arr.push(now);
    slangSubmitTimes.set(key, arr);
    return true;
  }

  // 返回给 AI 的“公开黑话条目”（只含安全展示字段，不泄露内部字段）。
  //
  // 刻意**不含 evidence**：证据行的形状是 `{ key, sender, text, time }`，
  // 其中 text 是提交该词条的那个会话里的消息片段、key 是那个会话的名字。
  // 黑话库是全群共享的，带上 evidence 就等于让 A 群的 AI 读到 B 群的会话名和原话。
  // 控制台要证据走 `GET /api/slang`（原始条目，含 evidence，仅控制台可达）。
  function publicSlangEntry(e) {
    return {
      id: e?.id ?? '',
      content: e?.content ?? '',
      meaning: e?.meaning ?? '',
      usage: e?.usage ?? '',
      example: e?.example ?? '',
      risk: e?.risk ?? '',
      status: e?.status ?? SLANG_STATUS.CANDIDATE,
      source: e?.source ?? 'ai',
      count: Number(e?.count) || 0,
      updatedAt: e?.updatedAt ?? ''
    };
  }

  // 已确认黑话的公开列表（按出现次数排序，最多 injectMax 条）。
  function confirmedSlangListV2() {
    const max = Math.max(1, Math.min(30, Number(cfg.slang?.injectMax) || 8));
    return slangEntries
      .filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning)
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, max)
      .map(publicSlangEntry);
  }

  function withSlangContext(promptText) {
    const now = new Date();
    const timeLine = `【当前时间】${now.toLocaleString('zh-CN', { hour12: false })}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
    const parts = [timeLine];
    if (cfg.slang?.enabled !== false) {
      const block = buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8);
      if (block) parts.push(block);
    }
    return parts.join('\n\n') + '\n\n' + promptText;
  }

  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  } else if (!cfg.allow.private.length && !cfg.allow.groups.length) {
    // 否则这是一个「静默无响应」陷阱：消息全被丢弃，用户只看到 QQ 上毫无反应。
    log(`⚠️  白名单为空且 allowAllWhenEmpty=false：不会响应任何 QQ 消息。请在 config.json 填 allow.private / allow.groups，或在控制台 http://127.0.0.1:${cfg.consolePort} 填写白名单`);
  }
  // 未配置管理员 QQ 时，一串功能会「静默失灵」：审批永远无法被回答（agent 一直等到超时）、
  // 管理命令全部被拒、封闭 agent 模式实际不可达。这里在启动日志里说清楚，避免排查时误判。
  if (!cfg.ownerQQ) {
    log('⚠️  未配置 ownerQQ：审批/管理命令/封闭 agent 模式将全部不可用。请在 config.json 或控制台「访问与安全」页填写管理员 QQ');
  }
  if (cfg.socialV2?.voice?.allowAbsolutePath === true) {
    // 该开关曾经允许 AI 发送语音库之外的任意本机音频文件（prompt injection 可用来外发文件）。
    // 现在无论开关如何，AI 通道都只接受语音库内的文件；这里提示它已经不再放宽边界。
    log('ℹ️  socialV2.voice.allowAbsolutePath=true 已不再放宽 AI 通道：AI 发的语音始终只允许来自语音库（库外文件请用语音工具/CLI 发送）');
  }

  // DSH 侧
  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    // true=用户在 config.json 里显式填的；false=从日志猜的。猜来的不优先于离线铸造。
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    // 默认只允许把 launch token 交给回环地址；远程 DSH 需要显式 opt-in（见 dsh-client.ensureAuth）。
    allowRemote: cfg.dsh.allowRemote === true
  });
  // DSH 的模型目录 RPC：0.1.5 是 `session/modelCatalog`。**不能走基类门面**
  // `api.sessions.modelCatalog` —— 桥接钉住的 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`
  // 的 sessions 门面里根本没有这个方法（只有 `models` → 已下线的 `session/models`），
  // 调用会抛 “api.sessions.modelCatalog is not a function”，让思考强度档位静默退回内置清单。
  // 这里直接用桥接自己覆写的 callUnary（它本来就是为「不依赖旧版客户端域方法」而存在的），
  // 并保留一次 `session/models` 回落以兼容更老的 DSH。
  const modelCatalogErrorLogged = new Set();
  async function fetchModelCatalog() {
    try {
      return await api.callUnary('session.modelCatalog', {});
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/not.?found|unknown|unsupported|404|invalid server-response/i.test(message)) throw error;
      return api.callUnary('session.models', {});
    }
  }
  const collectors = new Map(); // sessionId -> turn collector
  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
  const v2TurnStartAt = new Map(); // sessionId -> timestamp：reserved2 turn 开始时间，用于判断是否“无行动”
  // sessionId -> 该会话最近一次收到 DSH 事件的时刻。仅用于看门狗判断“这个回合是不是已经死了”。
  // 为什么不能只看 v2TurnStartAt：一个健康的回合里 AI 可能正在 qq_wait_for_messages 长轮询，
  // 期间同样没有 turn/end，用开始时间会误杀正常回合；用“最后一次有事件”才区分得开。
  const v2TurnLastEventAt = new Map();
  // 回合僵死阈值：必须大于单次等待的最大预算（maxMs 600000 = 10 分钟），否则会把
  // AI 正在长轮询的正常回合当成僵死回合回收掉。
  const V2_TURN_STALE_MS = 12 * 60 * 1000;
  const V2_WATCHDOG_INTERVAL_MS = 60 * 1000;
  // 重启后从 DSH 快照恢复的回合用更短的僵死窗口。桥接（通常连同 DSH）被 kill 在
  // turn/start 之后、turn/end 之前，快照里留下一个没结束的回合；rebuildInFlightCollector
  // 恢复它并把 v2TurnLastEventAt 设成 now，于是 isConversationBusyV2 在整整 12 分钟里
  // 恒为 true ⇒ 每次唤醒只进队列不投递。用户频繁重启时 12 分钟窗口被反复重置 ⇒ 永久阻塞。
  // 缩短到 90 秒后，看门狗下一 tick 就能回收；若回合真的还活着，live event 会在几秒内
  // 到达并把 v2TurnRestored 删除，恢复正常 12 分钟窗口。
  const V2_RESTORED_TURN_GRACE_MS = 90 * 1000;
  const v2TurnRestored = new Set(); // sessionId：从快照恢复、尚未被 live event 证活的回合
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
  // reserved2 防“忘记设置唤醒条件”：key -> 当前是否等待 AI 处理唤醒回合 / 本回合已更新唤醒配置 / 连续未设置次数
  const pendingWakeKeys = new Set();
  // key -> 开始等待的时间戳（带租约）：正在执行 qq_wait_for_messages 长轮询的会话，防止同一会话并发挂起。
  // 存时间戳而不是单纯放进 Set，是因为 handler 中间任何异常都会跳过 finishWait ——
  // 那样这个 key 会被永远 429 掉（DSH 的 fetch 不会主动断开连接，req 'close' 也不会触发）。
  const activeWaits = new Map();
  /**
   * 单次等待的租约上限：正常等待最长 = timeout 预算 + 静默窗口 + 5s 余量，
   * 这里给足余量；超过就认为上一次是异常退出留下的残留，允许新的等待接管。
   */
  const ACTIVE_WAIT_LEASE_MS = 15 * 60 * 1000;
  const pendingWakeLeaseTimers = new Map(); // key -> timeout：防止 accepted 但无 turn/end 的唤醒把 key 永久标记为 busy
  const wakeConfigUpdatedKeys = new Set();
  const markReadCalledKeys = new Set();
  const wakeConfigMissCount = new Map();
  const reverse = new Map(); // sessionId -> conv key
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, key);
  // 新版 DSH 事件流需要显式 follow；启动时为已持久化的 QQ 会话补上。
  for (const sessionId of Object.values(state.sessions)) api.events.follow(sessionId);
  const sessionPromises = new Map(); // key -> create promise（防并发重复创建）
  const promptQueues = new Map(); // key -> { queue: [], running: false }：每个 QQ 会话串行投递 DSH prompt，保证 turn 顺序

  // ── Token 用量账本（控制台「令牌与花费」） ───────────────────────────────
  // 权威总量取 DSH 的 tokenUsage 投影（整条会话日志累计，含桥接启动前的历史），
  // 逐轮明细由 assistant/message 的 usage 折叠而来；花费在读取时按价目表折算。
  const priceTable = resolvePriceTable(cfg.pricing);
  const tokenLedger = createTokenLedger({
    file: TOKEN_USAGE_FILE,
    log: (...args) => log(...args),
    priceTable,
    // 会话 → QQ 会话归属：学习会话单独记账，其余未知会话归入「未归属」。
    resolveKey: (sessionId) => reverse.get(sessionId)
      ?? (learnerSessions.has(sessionId) || (slangLearnerSessionId && sessionId === slangLearnerSessionId)
        ? 'internal:黑话学习'
        : undefined)
  });

  /** sessionId -> 最近一次已知的实际模型。切换模型会让单价差好几倍，所以按会话记。 */
  const sessionModels = new Map();
  const nominalModel = () => cfg.dsh?.model || 'deepseek-flash';

  function rememberModel(sessionId, selection) {
    const model = selection?.model;
    if (typeof model !== 'string' || !model) return;
    // 合并而不是覆盖：`model/selection` 事件与开场快照的字段完备度不同（快照的
    // `modelSelection.lastUsed` 三样齐全，事件有时只带 model/provider）。整体覆盖会让
    // 一个残缺事件把已知的 reasoningEffort 抹成 undefined，从而让上面的幂等跳过永久失效。
    const prev = sessionModels.get(sessionId) ?? {};
    sessionModels.set(sessionId, {
      model,
      provider: selection?.provider ?? prev.provider,
      reasoningEffort: selection?.reasoningEffort ?? prev.reasoningEffort
    });
  }

  /**
   * 缓存失效归因观测：记录每个会话「上一次真实计费调用」的时间与当时生效的模型配置。
   *
   * 目的：把「命中率突然掉下来」从玄学变成可归因 —— 缓存前缀失效只有两个来源，
   *   · **配置漂移**（模型/思考强度被 GUI 手动改过）→ 请求头不同，整段前缀作废；
   *   · **空闲超 TTL**（30~40 分钟没人说话）→ 服务端缓存自然过期。
   * 两者对「该不该花钱补救」的结论完全相反：前者可控（别手动切），后者不可避免
   * （只能靠更勤的唤醒摊薄）。日志里带上间隔和当前模型配置，读数即可分辨。
   */
  const lastBillingCallAt = new Map(); // sessionId -> 上一次计入 usage 的事件时间
  const lastPrefixTokens = new Map();  // sessionId -> 上一次请求的输入前缀规模（用于估算漂移代价）

  function noteCacheAttribution(sessionId, event) {
    if (event?.type !== 'assistant/message' && event?.type !== 'assistant/attempt') return;
    const usage = usageOfEvent(event);
    if (!usage) return;
    let buckets;
    try {
      buckets = normalizeUsage(usage);
    } catch {
      return;
    }
    const input = buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite;
    if (input <= 0) return;
    lastPrefixTokens.set(sessionId, input);
    const nowMs = Date.now();
    const prev = lastBillingCallAt.get(sessionId);
    lastBillingCallAt.set(sessionId, nowMs);
    if (!prev) return;
    const gapMs = nowMs - prev;
    // 只报「明显异常」的大额未命中，避免每步都刷日志。
    if (buckets.cacheMiss < 20000) return;
    if (buckets.cacheMiss / input < 0.5) return;
    const known = sessionModels.get(sessionId) ?? {};
    const gapMin = (gapMs / 60000).toFixed(1);
    // 粗估：未命中比命中每百万贵 (miss - hit) 元（高峰价 2 - 0.04 = 1.96）。
    const rates = ratesAt(known.model, nowMs, priceTable);
    const extra = (buckets.cacheMiss * ((rates.cacheMiss ?? 2) - (rates.cacheHit ?? 0.04))) / 1e6;
    log(`⚠ 缓存失效归因 session=${sessionId} miss=${buckets.cacheMiss} hit=${buckets.cacheHit} `
      + `miss率=${Math.round((buckets.cacheMiss / input) * 100)}% 距上次调用 ${gapMin} 分钟 `
      + `模型=${known.provider ?? '?'}/${known.model ?? '?'} effort=${known.reasoningEffort ?? '默认'} `
      + `本次未命中额外开销约 ¥${extra.toFixed(4)}`);
  }

  /** 摄入一条会话事件到 token 账本；任何异常都不能影响 QQ 主链路。 */
  function recordSessionUsage(sessionId, event) {
    try {
      if (event?.type === 'model/selection') rememberModel(sessionId, event.data);
      noteCacheAttribution(sessionId, event);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestEvent({
        sessionId,
        event,
        model: event?.data?.usage?.model ?? known?.model,
        provider: event?.data?.provider ?? known?.provider
      });
    } catch (error) {
      log('token 账本：摄入事件失败', error?.message ?? error);
    }
  }

  /**
   * 处理会话开场快照：
   * 1. `projections.tokenUsage` 是**整条会话日志**的权威累计桶（含桥接启动前的历史）；
   * 2. `records` 是最近若干条历史事件，用来回填「逐轮花费」。
   * 重连时该帧会重新下发，账本内部按 (turn, step, retry) + seq 做幂等折叠，不会翻倍。
   */
  function recordSessionSnapshot(sessionId, snapshot) {
    try {
      if (!snapshot) return;
      const selection = snapshot.projections?.values?.modelSelection;
      rememberModel(sessionId, selection?.lastUsed ?? selection?.pending ?? null);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestBaseline({
        sessionId,
        projection: snapshot.projections,
        at: Date.now(),
        model: known?.model ?? nominalModel(),
        provider: known?.provider ?? cfg.dsh?.provider
      });
      tokenLedger.ingestSnapshotRecords({ sessionId, records: snapshot.records });
      rebuildInFlightCollector(sessionId, snapshot.records);
    } catch (error) {
      log('token 账本：处理会话快照失败', error?.message ?? error);
    }
  }

  /**
   * 重连后重建「断线时正在跑的那个回合」的 collector。
   *
   * 为什么必须有这一步：`pumpMux` 的 finally 会在断线时清空 `collectors`（否则重连后
   * 旧状态会让回复重复累加）。而重连时 DSH **只**通过开场快照重放历史 —— 快照被刻意
   * 排除在事件通道之外（否则历史回合会被当成新回合重复发送）。于是断线前发出的
   * `turn/start` 再也补不回来：重连后到达的 live `turn/end` 找不到对应回合，
   * `createTurnCollector.push()` 返回 null ⇒ **这一轮的回复被静默丢弃**（QQ 上没消息、
   * 日志里没记录、token 却照付）。
   *
   * 修法：只把「有 turn/start 但没有 turn/end」的回合重放进 collector ——
   * 这些正是断线那一刻仍在进行的回合。已结束的回合一律不喂，所以不会重复回复。
   */
  function rebuildInFlightCollector(sessionId, records) {
    if (!Array.isArray(records) || !records.length) return;
    const eventOf = (entry) => (entry?.type === 'event' ? entry.event : entry);
    const open = new Set();
    for (const entry of records) {
      const event = eventOf(entry);
      if (event?.type === 'turn/start') open.add(event.data?.turn);
      else if (event?.type === 'turn/end') open.delete(event.data?.turn);
    }
    if (!open.size) return;
    const collector = createTurnCollector();
    let restored = 0;
    for (const entry of records) {
      const event = eventOf(entry);
      // 只回放未结束回合的文本来源：turn/start 建立回合，assistant/message 累积文本。
      if (event?.type !== 'turn/start' && event?.type !== 'assistant/message') continue;
      if (!open.has(event.data?.turn)) continue;
      collector.push(event);
      restored += 1;
    }
    if (!restored) return;
    collectors.set(sessionId, collector);
    // 恢复的回合确实是「正在跑」的，必须连同 v2TurnStartAt 一起立起来 ——
    // isConversationBusyV2 现在只认这个标记。配合下面的 v2TurnRestored，它只会挡
    // 90 秒宽限窗口，之后看门狗就会回收并补排积压的唤醒。
    v2TurnStartAt.set(sessionId, Date.now());
    // 刚恢复的回合从“现在”起算看门狗窗口；否则 v2TurnLastEventAt 缺失会退化成
    // “永远不算僵死”，一旦这个恢复的回合再也没结束，就又是永久繁忙。
    v2TurnLastEventAt.set(sessionId, Date.now());
    v2TurnRestored.add(sessionId);
    log(`重连后恢复了进行中的回合（${sessionId}，turn ${[...open].join(',')}）`);
  }

  // 唤醒“防卡死”租约：正常应在 turn/end 时删除 pendingWakeKeys；若 DSH 接受了但一直没回合结束，
  // 30 分钟后强制解除 busy 标记，避免该会话永久无法被唤醒。
  function armPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      pendingWakeKeys.delete(key);
      pendingWakeLeaseTimers.delete(key);
    }, 30 * 60 * 1000);
    timer.unref?.();
    pendingWakeLeaseTimers.set(key, timer);
  }
  function disarmPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    pendingWakeLeaseTimers.delete(key);
  }
  function clearAllPendingWakeLeases() {
    for (const t of pendingWakeLeaseTimers.values()) clearTimeout(t);
    pendingWakeLeaseTimers.clear();
  }

  // DSH 可用性探活 + 重启容错队列：
  // DSH 重启期间收到的 QQ 消息先入队（不丢），DSH 恢复后按序补投。
  let dshReady = false;
  let dshCheckStarted = false;
  let snowlumaWatchStarted = false; // SnowLuma 上游健康探测只启动一次（见 startSnowlumaWatch）
  let currentMode = 'chat'; // chat | closed-agent | reserved（仿真模式，由 DSH settings / state/mode.json 驱动）
  let lastMode = currentMode;
  // closed-agent 模式使用的 DSH agent preset：留空表示「用 DSH 自己声明的默认 preset」。
  // 旧版本这里硬编码 'router-standard'，但 DSH 0.1.5 已移除该 preset，硬编码会导致
  // 创建出的会话挂不上 preset，进而被 DSH 套上 standard（含本地工具）。
  let closedAgentPreset = '';
  // DSH 侧真实的 preset 清单与默认 preset：旧版本这里是硬编码的 'router-standard'，
  // 但 DSH 0.1.5 已不存在该 preset，硬编码会让 closed-agent 模式永远挂不上 preset。
  let dshPresetIds = [];        // 当前 DSH 可用的 preset id 列表（agentPresets/list）
  let dshDefaultPreset = '';    // DSH settings `agent-presets.default`，取不到时用列表里的 isDefault
  const queued = new Map(); // key -> { promptText }[]
  const queuedHintAt = new Map(); // key -> timestamp（冷却提示）
  const QUEUE_MAX = 50;
  const QUEUE_HINT_COOLDOWN_MS = 30_000;
  const queueRetries = new Map(); // key -> 连续补投失败次数（用于退避/暂停恢复）

  // reset 竞态导致 ensureSession 抛「会话创建期间已重置」时，把消息放回队列稍后重试。
  // 已在队列中的相同文本不重复入队。
  const enqueueForRetry = (key, promptText, opts = {}) => {
    const items = queued.get(key) ?? [];
    if (!items.some((it) => it.promptText === promptText)) {
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
    }
    queueRetries.delete(key); // 新消息入队视为新的机会，重置退避计数
    setTimeout(() => { flushQueue(); }, 3000);
  };

  // 从 DSH settings 读取桥接模式；命名空间未注册时回退本地 state/mode.json
  async function refreshMode() {
    try {
      const s = unwrap(await api.settings.describe({}), 'settings.describe');
      // DSH 的默认 preset（`agent-presets` 命名空间的 default）——closed-agent 的兜底值来源
      const presetNs = s.namespaces.find((n) => n.ns === 'agent-presets');
      if (presetNs?.value && typeof presetNs.value.default === 'string' && presetNs.value.default) {
        dshDefaultPreset = presetNs.value.default;
      }
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      // 规范化后再比较：`simulation` 也走这里（见 MODE_INPUT_ALIASES）。
      const fromDsh = ns?.value ? normalizeModeInput(ns.value.mode) : null;
      if (fromDsh) {
        currentMode = fromDsh;
        // DSH 设置页也可配置管理员 QQ；未设置该字段时不覆盖 config.json。
        if (ns.value.ownerQQ !== undefined) {
          try {
            cfg.ownerQQ = normalizeOwnerQQ(ns.value.ownerQQ);
          } catch (error) {
            log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
          }
        }
        // DSH 的 qq-mode schema 只有 mode / ownerQQ 两个字段，没有 closedAgentPreset；
        // 该值仍以本地 state/mode.json 为准（用 typeof 判断，允许用空串显式清空），
        // 否则这里提前 return 会让控制台的 preset 下拉变成永远不生效的死设置。
        const localPreset = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
        if (typeof localPreset?.closedAgentPreset === 'string') {
          closedAgentPreset = localPreset.closedAgentPreset;
        }
        return;
      }
    } catch {}
    const local = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
    const fromLocal = local ? normalizeModeInput(local.mode) : null;
    if (fromLocal) currentMode = fromLocal;
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      closedAgentPreset = local.closedAgentPreset;
    }
  }

  /** 拉取 DSH 当前可用的 agent preset 清单（供控制台下拉与 closed-agent 兜底使用）。 */
  async function refreshPresetList() {
    try {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
      dshPresetIds = list.map((p) => String(p.id));
      if (!dshDefaultPreset) {
        const marked = list.find((p) => p.isDefault === true);
        if (marked) dshDefaultPreset = String(marked.id);
      }
    } catch (error) {
      log(`获取 DSH preset 列表失败：${error?.message ?? error}（会话将按配置的 preset 尝试创建）`);
    }
  }

  /** 当前模式是否允许该会话进入 */
  function modeAllowed(key, kind, id, cfg, mode) {
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
    // chat / reserved / reserved2（仿真模式，暂同 chat 白名单）
    return allowed(kind, id, cfg);
  }

  /**
   * 解析一个 preset 名。
   *
   * strict=false（closed-agent，仅 owner 私聊）：名字不可用时回退到 DSH 默认 preset ——
   *   那里本来就用完整工具面，回退不构成提权。
   * strict=true（chat / reserved / reserved2，会话可能属于 QQ 群）：名字不可用时返回 ''，
   *   表示「没有可安全使用的 preset」，由调用方拒绝建会话（fail-closed）。
   *   **绝不能回退到 DSH 默认 preset（standard）**：standard 含 bash/文件读写等本地工具，
   *   一旦套在群聊会话上，群友即可驱动一个能操作本机的 agent（见 RULES.md「无本地工具」）。
   */
  function resolvePresetName(name, { strict = false } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return strict ? '' : (dshDefaultPreset || '');
    // DSH 可能接受未知 preset 并套用默认值；清单未知时也必须 fail-closed。
    if (dshPresetIds.length === 0) return strict ? '' : wanted;
    if (dshPresetIds.includes(wanted)) return wanted;
    log(`⚠️ preset "${wanted}" 不在 DSH 可用清单（${dshPresetIds.join(', ')}）中`);
    if (strict) {
      log(`⛔ 群聊/仿真会话缺少 preset "${wanted}"，拒绝回退到 DSH 默认 preset（会把本地工具暴露给 QQ 群）；请运行 node scripts/setup-dsh.mjs 并重启 DSH`);
      return '';
    }
    return dshDefaultPreset || '';
  }

  /** 当前模式下的会话预设；返回 undefined 表示「该模式下没有可安全使用的 preset」 */
  function modePreset(key, mode, cfg) {
    if (mode === 'closed-agent') {
      const chosen = resolvePresetName(closedAgentPreset);
      if (!chosen) log('⚠️ 无法确定 closed-agent 的 preset（DSH preset 清单未知），将按 DSH 默认 preset 建会话');
      return chosen || undefined;
    }
    // 二代仿真模式优先使用 socialV2.agentPreset；未配置时回退到默认聊天预设。
    // 非 closed-agent 一律 strict：宁可建不出会话，也不给群聊套上带本地工具的默认 preset。
    const wanted = mode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
    return resolvePresetName(wanted, { strict: true }) || undefined;
  }

  /** 判断一个会话 key 是否仍被当前模式/白名单允许（供唤醒调度与 HTTP 路由共用）。 */
  function isSessionAllowedInCurrentMode(key) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m) return false;
    return modeAllowed(key, m[1], Number(m[2]), cfg, currentMode);
  }

  function sessionPolicy(key) {
    return JSON.stringify([currentMode, modePreset(key, currentMode, cfg) ?? '', currentMode === 'closed-agent' ? cfg.ownerQQ : null]);
  }

  function isCurrentSession(key, sessionId) {
    return isSessionAllowedInCurrentMode(key) && state.sessions[key] === sessionId
      && state.sessionPolicies[key] === sessionPolicy(key);
  }

  /**
   * 让 DSH 停下一个已经不再属于桥接的会话：先清队列再取消在途 turn，最后归档。
   * 拆出来是因为所有「撤销映射」的路径都必须做同样的事（retireSession / session-reset /
   * workspace-reset / reset，以及控制台的二代状态重置）—— 少一处就会留下
   * 「DSH 还在烧 token、桥接已经收不到也发不出」的静默黑洞。
   */
  function stopRetiredSessionWork(sessionId, key = '') {
    void (async () => {
      try { await api.stopSessionWork(sessionId); }
      catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；本地映射已撤销，请在 DSH 检查旧任务`); }
      try { await api.workspace.archiveSession({ sessionId }); }
      catch (error) { log(`归档失效会话失败 ${key}: ${error?.message ?? error}`); }
    })();
  }

  /**
   * 清掉「按会话 key 记账」的内存态。
   *
   * 为什么单独抽出来：这些 Map/Set 分散在文件各处，退役路径（retireSession）、
   * 手动重置（/api/session/reset、/reset、workspace reset）、二代状态重置
   * 各自只清了其中一部分 —— 于是「哪个 key 清哪个不清」完全靠人记。
   * 结果是有界但真实的慢性泄漏：被移出白名单的会话，其 lastSendFailed、
   * 限流时间戳会一直留在内存里。所有撤销会话映射的路径都必须调用这里。
   */
  function forgetConversationCaches(key) {
    lastSendFailed.delete(key);
    activeWaits.delete(key);
    queuedHintAt.delete(key);
    slangSubmitTimes.delete(key);
    feedbackTimes.delete(key);
    wakeConfigMissCount.delete(key);
    wakeConfigUpdatedKeys.delete(key);
    markReadCalledKeys.delete(key);
  }

  function retireSession(key) {
    const sessionId = state.sessions[key];
    delete state.sessions[key];
    delete state.sessionPolicies[key];
    // 按 key 记账的内存态在**有映射和无映射时都要清**：一条被移出白名单、
    // 但从未成功建过会话的 key 同样会留下限流时间戳与失败标记。
    forgetConversationCaches(key);
    if (!sessionId) return;
    reverse.delete(sessionId);
    collectors.delete(sessionId);
    sessionModels.delete(sessionId);
    modelAppliedSessions.delete(sessionId);
    sendToolSucceededSessions.delete(sessionId);
    pendingSendToolCalls.delete(sessionId);
    v2TurnStartAt.delete(sessionId);
    v2TurnLastEventAt.delete(sessionId);
    toolCallNames.delete(sessionId);
    social.silentTurns.delete(sessionId);
    social.exitingSessions.delete(sessionId);
    // 退役的会话要退订：否则 _desiredFollows 只增不减，每次重连都会为它重开一条
    // follow 流并重发一整份历史快照（内存与重连延迟都随会话数线性增长）。
    api.events.forget?.(sessionId);
    const entry = pending.get(key);
    if (entry) { clearTimeout(entry.timer); void cancelPendingEntry(entry).catch(() => {}); }
    pending.delete(key);
    clearSocialV2Timers(key);
    cancelSocialTimers(key);
    disarmPendingWakeLease(key);
    pendingWakeKeys.delete(key);
    const st = socialV2.conversations.get(key);
    if (st) {
      // 保留旧 token 在脱敏集合中，但撤销它的调用权限。
      st.agentToken = crypto.randomBytes(24).toString('hex');
      rememberAgentToken(key, st.agentToken);
      st.bootstrapSent = false;
      st.modelSeenSeqs = new Set();
    }
    saveState();
    saveSocialV2State();
    stopRetiredSessionWork(sessionId, key);
    log(`会话权限已变化，停用旧映射 ${key} -> ${sessionId}`);
  }

  function reconcileSessionPolicies() {
    // DSH preset 清单未知时**绝不能**做退役判定。
    //
    // 为什么：`sessionPolicy()` 包含 `modePreset()` 的结果，而 `modePreset()` 依赖
    // `dshPresetIds`（来自 DSH 的 `agentPresets/list`）。启动瞬间或一次瞬时失败时
    // 这个清单可能是空的，`resolvePresetName(strict)` 于是返回 ''，算出来的策略就变成
    // `["reserved2","",null]` —— 与已存的 `["reserved2","qq-chat-v2",null]` 不等，
    // 于是**所有** QQ 会话在这一个 tick 里被集体退役：DSH 会话被停掉归档、agentToken 轮换、
    // 映射删除，每个群的上下文全丢，日志里只有一句「会话权限已变化」。
    // 一次网络抖动换来全体失忆，代价完全不成比例。清单为空时宁可不判定，等下一轮。
    if (dshPresetIds.length === 0) return;
    for (const [key, sessionId] of Object.entries(state.sessions)) {
      if (!isCurrentSession(key, sessionId)) retireSession(key);
    }
  }

  let flushingQueue = false;
  let flushQueueAgain = false;
  const flushQueue = async () => {
    // 尾沿重跑：单飞锁只是「别并发跑」，不能把后来的请求直接丢掉。
    // 旧写法在 flush 正在 await 时（一次失败可能卡上 60 秒）把重试定时器的调用直接 return，
    // 于是**再也没有人重新排一次 flush**，队列里的消息会一直躺到下次收到新消息为止。
    if (flushingQueue) { flushQueueAgain = true; return; }
    flushingQueue = true;
    try {
      const entries = [...queued.entries()];
      queued.clear();
      for (const [key, items] of entries) {
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const [kind, idStr] = key.split(':');
            const id = Number(idStr);
            if (!modeAllowed(key, kind, id, cfg, currentMode)) {
              log(`补投跳过未授权会话 ${key}（当前模式 ${currentMode}）`);
              continue;
            }
            const result = await deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [], wakeReason: item.wakeReason });
            if (!result.ok) {
              log(`补投失败 ${key}: ${result.error || '未知错误'}`);
              failed += 1;
              const rest = items.slice(i);
              const existing = queued.get(key) ?? [];
              queued.set(key, rest.concat(existing));
              break;
            }
            queueRetries.delete(key);
            sent += 1;
          } catch (error) {
            log(`补投异常 ${key}: ${error?.message ?? error}`);
            failed += 1;
            // 当前项 + 剩余项整体放回，避免丢失；旧消息优先
            const rest = items.slice(i);
            const existing = queued.get(key) ?? [];
            queued.set(key, rest.concat(existing));
            break;
          }
        }
        log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
        if (failed > 0) {
          const retries = (queueRetries.get(key) ?? 0) + 1;
          queueRetries.set(key, retries);
          if (retries > 5) {
            log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
            setTimeout(() => {
              queueRetries.delete(key);
              flushQueue();
            }, 60000);
          } else {
            const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
            setTimeout(() => { flushQueue(); }, delay);
          }
        }
      }
    } finally {
      flushingQueue = false;
      if (flushQueueAgain) {
        flushQueueAgain = false;
        // 队列里还有东西才继续；用 setTimeout 让出一次事件循环，避免同步递归。
        if (queued.size > 0) setTimeout(() => { flushQueue(); }, 200);
      }
    }
  };
  const checkDsh = async () => {
    let ok = false;
    try {
      await api.settings.describe({});
      ok = true;
    } catch {}
    if (ok) {
      await refreshMode();
      // DSH 起来后拉一次 preset 清单；DSH 重启（dshReady 由 false 变 true）时再拉一次。
      if (!dshReady || dshPresetIds.length === 0) {
        try { await refreshPresetList(); } catch {}
      }
      reconcileSessionPolicies();
      if (!dshReady) {
        dshReady = true;
        lastMode = currentMode;
        log(`DSH 已就绪（模式: ${currentMode}）`);
        if (currentMode === 'reserved2') {
          // 首次确定模式为 reserved2 后再恢复持久化的有限睡眠定时器，
          // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已确定为 reserved2，恢复有限睡眠定时器');
          startV2TurnWatchdog();
          // 重启前因「会话繁忙」被暂存的唤醒原因：现在重新排一次队。
          // 没有这段，暂存后重启的唤醒原因会随内存消失，触发它的消息就被永久晾在 unread 里。
          for (const [key, st] of socialV2.conversations) {
            if (!Array.isArray(st.pendingWakeReasons) || !st.pendingWakeReasons.length) continue;
            const kept = [];
            for (const item of st.pendingWakeReasons) {
              if (!item || typeof item !== 'object') continue;
              const stillRelevant = Array.isArray(st.unread) && st.unread.some((m) => m && Number(m.seq) >= Number(item.seq));
              if (!stillRelevant) {
                log(`[reserved2] ${key} 重启前暂存的唤醒 ${item.reason}@seq${item.seq} 已被处理，跳过`);
                continue;
              }
              kept.push(item);
            }
            st.pendingWakeReasons = kept;
            if (kept.length) {
              const first = kept.shift();
              log(`[reserved2] ${key} 重启后补排暂存的唤醒：${first.reason}@seq${first.seq}（剩余 ${kept.length} 条）`);
              void scheduleWakeV2(key, first.reason).catch(() => {});
            }
          }
        }
        try { await flushQueue(); } catch (error) { log('补投队列异常:', error?.message ?? error); }
        // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
        for (const key of [...slangWindows.keys()]) maybeQueueSlangExtraction(key);
      } else if (currentMode !== lastMode) {
        if (lastMode === 'reserved' && currentMode !== 'reserved') {
          cleanupSocialForModeChange();
          log('桥接模式已离开一代仿真模式，清理社交状态');
        }
        if (lastMode === 'reserved2' && currentMode !== 'reserved2') {
          clearAllSocialV2Timers();
          drainAllPromptQueues('模式切换，已取消排队中的投递');
          log('桥接模式已离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        if (currentMode === 'reserved2' && lastMode !== 'reserved2') {
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已进入二代仿真模式，重建有限睡眠定时器');
        }
        log(`桥接模式已切换为: ${currentMode}`);
        lastMode = currentMode;
      }
    } else if (dshReady) {
      dshReady = false;
      log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
    }
  };
  function startDshWatch() {
    if (dshCheckStarted) return;
    dshCheckStarted = true;
    checkDsh();
    setInterval(checkDsh, 5000);
  }

  // ── SnowLuma 上游健康：**连上了 ≠ 收得到** ──────────────────────────────────
  //
  // 为什么必须有这一段（这是一个真实存在的、被误诊过的失败形态）：
  // SnowLuma 用原生组件（`native/snowluma-win32-x64.{dll,node}`）挂进 QQ 客户端进程
  // 才能拿到消息，它自己的日志里管这层叫 `[Hook]`。这层会退化：
  //     WARN [Hook] receive path stale: ... silentFor=136193ms; reporting good=false
  // 而 **SnowLuma 进程与它的 OneBot WebSocket 都还活着**。于是桥接这边一切正常：
  // WebSocket 是通的、`bot.on('open')` 打过「SnowLuma 已连接」，控制台没有任何异常，
  // 但群里一条消息都不来 —— 运维看到的现象是「接了但没反应」，而**没有任何证据指向
  // SnowLuma 的 hook**，于是被报成「qq-bridge 注入失败」。
  //
  // 桥接本身**不可能**造成这种失败：它没有任何原生/注入面（依赖全纯 JS，源码里
  // 没有 .dll/.node/FFI/进程注入），也不启动、不控制 SnowLuma 与 QQ。它能做、也应该做的
  // 是**把这个失败变得可诊断**。
  //
  // 信号从哪来（**两处都实测核对过 SnowLuma 1.14.9 的运行时源码，别凭直觉改**）：
  //
  //   ① **心跳载荷里的 `status.good`** —— 权威信号，且是免费的。
  //      SnowLuma 每 30s 由**自己的定时器无条件**发一个 heartbeat
  //      （`index.mjs` 的 `HEARTBEAT_INTERVAL = 3e4` / `startHeartbeat()`），
  //      载荷里带 `status: { online, good: online && bridge.receiveHealthy }`。
  //      `receiveHealthy` 是它**对「QQ → hook → 我」这条接收链路**的自评，
  //      静默约 105s 就翻 false。所以：读心跳里的 good 就等于拿到了 hook 的健康度。
  //      ⚠️ 注意它**不经过** QQ 事件流水线 —— 心跳是本地生成的，所以"没有事件包"
  //      **不能**用来判断 hook 死活（见下方 ② 的措辞）。
  //
  //   ② `get_status` 的 `good`/`online` —— 与 ① 同源，用于①长期收不到时的兜底轮询。
  //      ⚠️ **不要用 `get_login_info` 取 good**：它只返回 `{ user_id, nickname }`。
  //      取错字段不会报错（SDK 只校验 status/retcode 信封，不校验 data 载荷），
  //      good 会永远停在 null —— 本文件第一版就是这么写的，等于权威信号整条是死代码。
  //      `src/mcp-snowluma-safe.js` 的 snowluma_status 工具是对的取法（get_login_info
  //      拿昵称 + get_status 拿 online/good），可对照。
  //
  //   ③ `bot_status`（账号会话上下线）—— SnowLuma 1.14.17 起才有，老运行时永不触发，
  //      所以只是加分项，不能作为唯一依据。
  //
  //   ④ 「距最近一个事件包的时长」—— 只能证明**SnowLuma 进程与 WS 链路还活着**，
  //      **不能**证明 hook 收得到 QQ 数据（心跳会一直来）。所以它只作为兜底提示，
  //      阈值取很宽，措辞必须留余地。
  const SNOWLUMA_STATUS_POLL_MS = 60_000;
  const SNOWLUMA_SILENCE_WARN_MS = Math.max(60_000, Number(cfg.snowluma?.silenceWarnMs) || 10 * 60_000);
  const snowlumaHealth = {
    lastPacketAt: 0,      // 最近一个来自 SnowLuma 的事件包（含 meta/心跳）
    lastPacketKind: '',
    accountOnline: null,  // bot_status 的 online/offline（需要较新的 SnowLuma 运行时）
    good: null,           // 接收链路健康度：来自心跳 status.good / get_status.good
    goodSource: '',       // 'heartbeat' | 'get_status' —— 便于诊断"这条判断从哪来"
    goodError: '',
    goodCheckedAt: 0,
    degraded: false,      // 当前是否处于"已告警"状态（边沿触发，避免刷屏）
    reason: '',
  };

  /** 记录一次"上游还活着"的证据。任何来自 SnowLuma 的事件包都算（含心跳）。 */
  function noteUpstreamPacket(kind) {
    snowlumaHealth.lastPacketAt = Date.now();
    snowlumaHealth.lastPacketKind = String(kind ?? '');
  }

  /** 记下一次接收链路健康度。@param good - boolean；非布尔值忽略。 */
  function noteReceiveHealth(good, source) {
    if (typeof good !== 'boolean') return;
    snowlumaHealth.good = good;
    snowlumaHealth.goodSource = source;
    snowlumaHealth.goodError = '';
    snowlumaHealth.goodCheckedAt = Date.now();
  }

  /** 供 /api/status 与控制台使用的只读快照。 */
  function snowlumaHealthSnapshot() {
    const now = Date.now();
    const agoMs = snowlumaHealth.lastPacketAt ? now - snowlumaHealth.lastPacketAt : null;
    const silent = snowlumaHealth.lastPacketAt > 0 && agoMs > SNOWLUMA_SILENCE_WARN_MS;
    // 只有 SnowLuma **明确自报** good=false 才算"确认坏了"（接收链路）。
    // 「静默」只能说明连它的进程/WS 都没动静了 —— 那是**另一个**故障面，措辞必须分开。
    const confirmed = snowlumaHealth.good === false;
    let hint = null;
    if (confirmed) {
      hint = 'SnowLuma 自报接收链路异常（good=false）：它的 [Hook] 收不到 QQ 客户端的数据，'
        + '消息进不来。这不是桥接的问题。请查看 SnowLuma 的 logs/snowluma-*.log 里的 [Hook] 行'
        + '（receive path stale / process enumeration timed out），并考虑升级 SnowLuma。';
    } else if (silent) {
      hint = `已连接但 ${Math.round(agoMs / 60000)} 分钟没有收到任何事件包（连 30 秒一次的心跳都没有）。`
        + '这说明 SnowLuma 的 OneBot 服务/进程本身可能已经卡住或不在了，而不只是收不到 QQ 数据；'
        + '请直接查看 SnowLuma 的 logs/snowluma-*.log。';
    }
    return {
      // 只读 snowlumaHealth.connected（由 bot 的 open/close 维护），**不要**在这里引用
      // `bot`：它在本闭包里声明得晚得多（`const`，TDZ），一旦有人把本函数提前调用就会
      // 抛 "Cannot access 'bot' before initialization"。
      connected: snowlumaHealth.connected,
      accountOnline: snowlumaHealth.accountOnline,
      good: snowlumaHealth.good,
      goodSource: snowlumaHealth.goodSource || null,
      goodError: snowlumaHealth.goodError || null,
      lastPacketAgoMs: agoMs,
      lastPacketKind: snowlumaHealth.lastPacketKind || null,
      silent,
      degraded: confirmed || silent,
      hint,
    };
  }

  /** 边沿触发地告警/恢复，避免每轮探测都刷一行日志。 */
  function reportSnowlumaHealth() {
    const snap = snowlumaHealthSnapshot();
    if (snap.degraded && !snowlumaHealth.degraded) {
      snowlumaHealth.degraded = true;
      snowlumaHealth.reason = snap.hint ?? '';
      log(`⚠️ SnowLuma 上游不健康：${snap.hint}`);
      log('   这不是桥接的问题：桥接没有任何原生/注入面，也不控制 SnowLuma 或 QQ。');
      log('   排查：SnowLuma 的 logs/snowluma-*.log 里搜 [Hook]（看是否有 "receive path stale" 或 "process enumeration timed out"）。');
    } else if (!snap.degraded && snowlumaHealth.degraded) {
      snowlumaHealth.degraded = false;
      snowlumaHealth.reason = '';
      log('✅ SnowLuma 上游已恢复正常（good≠false 且事件包在流动）');
    }
  }

  /**
   * 问一次 SnowLuma 的 `get_status`：账号在不在线、它自评的接收链路是否健康。
   *
   * ⚠️ 必须用 `get_status` —— `get_login_info` 只返回 `{ user_id, nickname }`，
   *    从它身上取 good 会永远拿到 undefined（而且不会报错，见上方长注释）。
   *    这里只是**兜底轮询**：主路径是每 30 秒一次的心跳（免费，见 onEvent）。
   */
  async function pollSnowlumaStatus() {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${httpUrl}/get_status`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok') {
        snowlumaHealth.goodError = `HTTP ${res.status}${body?.wording ? ` ${body.wording}` : ''}`;
      } else {
        noteReceiveHealth(body.data?.good, 'get_status');
        if (typeof body.data?.online === 'boolean') snowlumaHealth.accountOnline = body.data.online;
      }
    } catch (error) {
      snowlumaHealth.goodError = error?.message ?? String(error);
    }
    snowlumaHealth.goodCheckedAt = Date.now();
    reportSnowlumaHealth();
  }

  function startSnowlumaWatch() {
    if (snowlumaWatchStarted) return;
    snowlumaWatchStarted = true;
    // 首次延后一点，避免与启动时的连接/自愈抢时序
    setTimeout(() => { void pollSnowlumaStatus(); }, 5000);
    setInterval(() => { void pollSnowlumaStatus(); }, SNOWLUMA_STATUS_POLL_MS);
    // 边沿告警的兜底心跳：主信号（心跳 status.good）到达时会立刻评估，这里只防"心跳也没了"
    setInterval(reportSnowlumaHealth, 30_000);
  }

  // ── 控制台页面：运行时注入令牌 ──────────────────────────────────────────────
  //
  // 主人 2026-10-19：「让我每次进去不要输密码」。
  //
  // 做法：返回页面时把一段 <script> 插到 <head> 之后，直接写
  // localStorage.consoleToken（console.html 就是从这里读令牌的）。
  //
  // 为什么**不改 console.html 文件本身**：
  //   · 那个文件被 git 跟踪，插件更新时整体替换 —— 手改的注入会被抹掉；
  //   · 把真实令牌写进文件会被提交进仓库，换机器就失效，还可能被误推到公开 remote。
  //   运行时注入两个问题都没有：文件一个字不动，令牌每次由 state/console-token 现读。
  //
  // ⚠️ 令牌变了（/api/console/token 重新生成过）要刷新一次页面：注入发生在页面加载时。
  function injectConsoleToken(html, token) {
    const safe = JSON.stringify(String(token ?? ''));
    const snippet = `<script>try{localStorage.setItem('consoleToken',${safe});}catch(e){}</script>`;
    const text = String(html ?? '');
    const i = text.indexOf('<head>');
    if (i >= 0) return text.slice(0, i + 6) + snippet + text.slice(i + 6);
    // 没有 <head>（不该发生）就退化成插在最前面 —— 总比不注入好。
    return snippet + text;
  }

  // ── 本地控制台（独立 Web 面板，不依赖 DSH WebUI） ───────────────────────────
  // 模式/角色/静默状态都存 state/*.json，桥接即时感知；此服务只读写这些文件。
  function v2ToolEnabled(flag) {
    return cfg.socialV2?.tools?.[flag] !== false;
  }

  /**
   * 「这个工具被主人关掉了」的标准回包。
   *
   * 为什么需要它：全文件有 50 处 `工具未启用：xxx`，模型看到只会理解成
   * "这条路坏了"，于是反复重试、还把这件事当成 bug 报给主人 —— 而真相是
   * 主人在控制台主动关的开关。这种"配置态 vs 故障"的差别**必须写在报错里**，
   * 不能指望记忆去补：开关随时会变，补一条记忆就多一条要维护的真相。
   *
   * 统一带上 kind/retryable/reportable，让模型当场能判断：不重试、不误报。
   * @param {string} toolName 给模型看的工具名，如 qq_say
   * @param {string} flag     config 里的开关名，如 speak
   * @param {string} [howToRecover] 可选的恢复提示
   */
  function disabledByOwner(toolName, flag, howToRecover = '') {
    return {
      ok: false,
      kind: 'disabledByOwner',
      setting: `socialV2.tools.${flag}`,
      retryable: false,
      // 明确告诉上层：这不是需要上报主人的故障。否则她会把"主人自己的设置"当成 bug 报上去。
      reportable: false,
      error: `${toolName} 已被主人在设置里关闭（socialV2.tools.${flag}=false）：这是主人主动的配置，` +
        `不是故障、不是坏了。不用重试，也不用当成问题上报给主人；这轮换别的方式继续就行` +
        `${howToRecover ? `（${howToRecover}）` : ''}。`
    };
  }

  // ── 语音通话（档 2）：把 sidecar 的「听 → 想 → 说」接进桥接 ──────────────────
  //
  // 分工（不要在这里重复实现音频）：
  //   · tools/call/call_sidecar.py 负责**听**和**说**：WASAPI 环回采集 → VAD → ASR，
  //     以及 TTS → 虚拟声卡（VB-CABLE）→ QQ 从虚拟麦克风读到；
  //   · 桥接只负责**想**：把对方说的话当成一次 prompt 投给 DSH，拿这一轮的最终文本回给 sidecar。
  //
  // 为什么必须「静默」：普通回合的回复会被 sendToQQ 发到 QQ 聊天窗口。
  // 通话时这句话该变成声音进麦克风；要是同时在聊天框里出现一条文字，
  // 主人一眼就看出「电话里在说话的同时还在打字」。所以这个回合的文本
  // 只回给 sidecar，一个字都不往外发。
  //
  // 拿到回复文本的办法：复用 `social.silentTurns`（摘要投喂那套静默名额），
  // 额外挂一个 waiter，在 pump 的 `ended` 分支里把 `ended.text` 交给它。
  // 不用另造一套「等回合结束」的轮子 —— 那会和排队/重试逻辑打架。
  const callCfg = () => (cfg.call ?? {});
  const callEnabled = () => callCfg().enabled === true;
  // 当前通话绑定的会话（group:群号 / private:QQ号）。空 = 没有进行中的通话。
  let callKey = '';
  let callStartedAt = 0;
  let callChild = null;              // sidecar 子进程（若由桥接托管）
  const callWaiters = new Map();     // sessionId -> [{ resolve, timer }]：等这一轮的最终文本
  const callLastStats = { turns: 0, lastUtterance: '', lastReply: '', lastAt: 0, lastError: '' };
  // 这一轮里「她用 qq_say 自己说过了」的计数：通话时若她已经单独把话递给引擎念了，
  // 这一轮的最终文本就不能再念一遍（否则电话里会出现同一句话说两次，
  // 更常见的是把「已发送」这种回执念给对方听）。
  // 她自己在通话中把话递给引擎念的次数（按会话 key 记）。通话时若她已经单独
  // 把话递过去了，这一轮的最终文本就不能再念一遍 —— 否则电话里会出现同一句说两次。
  const callSpokenSeq = new Map();   // key -> 次数

  const callPort = () => Number(callCfg().port) || 3210;
  const callPython = () => {
    const configured = String(callCfg().pythonPath ?? '').trim();
    if (configured) return configured;
    // 默认用 tools/asr 的 venv：ASR/TTS 两个 worker 都装在那里，sidecar 也在同一环境里跑。
    return path.join(ROOT, 'tools', 'asr', '.venv', 'Scripts', 'python.exe');
  };

  /** 把 sidecar 的 HTTP 端点包一层，统一超时与错误形状。 */
  async function callSidecarFetch(pathname, { method = 'GET', body, timeoutMs = 15000 } = {}) {
    const url = `http://127.0.0.1:${callPort()}${pathname}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ac.signal
      });
      const text = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* 非 JSON 就原样带回去 */ }
      return { ok: res.ok, status: res.status, data: parsed, text };
    } catch (error) {
      // 连不上 sidecar 是**预期内的状态**（还没启动 / 崩了），别让它变成未捕获异常。
      // ECONNREFUSED 要和超时分开说：前者是"没起"，后者是"起了但卡住"。
      const code = error?.cause?.code ?? error?.code ?? '';
      const why = code === 'ECONNREFUSED'
        ? `通话引擎没在运行（127.0.0.1:${callPort()} 拒绝连接）`
        : (ac.signal.aborted ? `通话引擎响应超时（${timeoutMs}ms）` : String(error?.message ?? error));
      return { ok: false, status: 0, data: null, text: '', error: why };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 解绑当前通话：把这通电话占着的所有状态一起清干净。
   *
   * 为什么必须集中收口：`callKey` 是一个会在 6 个地方被清空的状态（守夜认到 idle、
   * 空闲超时挂断、/api/call/stop、/api/call/hangup、AI 调挂断…）。只清 `callKey` 而
   * 忘了别的，就会留下两类悬空：
   *   1) `callSpokenSeq` 还记着上一通电话里"她说过了"，下一通的第一句会被误吞；
   *   2) `callWaiters` 里还挂着没人消费的回调，那一次 turn 的文本永远没人取。
   */
  function endCall(reason) {
    const was = callKey;
    callKey = '';
    callStartedAt = 0;
    callIdleTicks = 0;
    callSpokenSeq.clear();
    // 还没等到回复的 waiter 全部放掉：通话已经结束了，它们等的文本不会再有意义。
    for (const [sid, arr] of callWaiters) {
      for (const w of arr) { if (w?.timer) clearTimeout(w.timer); try { w?.resolve(''); } catch { /* 忽略 */ } }
      callWaiters.delete(sid);
    }
    if (was && reason) log(`[call] ${was} 通话结束：${reason}`);
    return was;
  }

  /**
   * 通话中的「说出口」闸门：若这通电话正绑在这个会话上，就把话交给 sidecar 念出来，
   * 而不是当成 QQ 消息发出去。返回 null = 不在通话中（照常走原链路）。
   *
   * 返回 { ok, error }：失败也**不**回落到发聊天消息 —— 电话里说的话漏进聊天窗
   * 比"这句没出声"糟得多（对方会看到一条莫名其妙的文字，而且会以为在聊天）。
   */
  async function callRerouteTextIfInCall(key, text) {
    if (!callEnabled() || !callKey || key !== callKey) return null;
    const said = String(text ?? '').trim();
    if (!said) return { ok: false, error: '这句话是空的' };
    // sidecar 自己会切句、排队、按 16k 单声道推给虚拟声卡；
    // 这里只负责「把整段话递过去」，不要在这里再切一遍。
    const r = await callSidecarFetch('/say', {
      method: 'POST',
      body: { text: said },
      timeoutMs: Math.max(30000, said.length * 400)
    });
    if (r.ok && r.data?.ok) {
      callSpokenSeq.set(key, (callSpokenSeq.get(key) ?? 0) + 1);
      log(`[call] 通话中，已把 ${said.length} 字交给通话引擎念出来`);
      return { ok: true };
    }
    const why = r.error || r.data?.why || r.data?.error || `HTTP ${r.status}`;
    log(`[call] ⚠️ 通话中念话失败：${why}（这句话没有发到聊天窗）`);
    return { ok: false, error: why };
  }

  /**
   * 投一句话给 DSH，等这一轮的最终文本（**不发给 QQ**）。
   *
   * 返回 { ok, reply } —— reply 为空表示这一轮没产生可见文本（被中断 / 报错 / 超时）。
   */
  async function callDeliverTurn(key, text, timeoutMs) {
    const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : (Number(callCfg().turnTimeoutMs) || 90000);
    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      return { ok: false, error: `建会话失败：${error?.message ?? error}` };
    }
    let waiterTimer = null;
    const waitReply = new Promise((resolve) => {
      waiterTimer = setTimeout(() => {
        dropCallWaiter(sessionId, waiterTimer);
        resolve(null);   // 超时：这一句放弃，但通话不该因此断掉
      }, limit);
      const arr = callWaiters.get(sessionId) ?? [];
      arr.push({ resolve, timer: waiterTimer });
      callWaiters.set(sessionId, arr);
    });
    // 静默名额：这个回合的回复不会进聊天窗口（真正的门闩在 pump 的 ended 分支）。
    const silentId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    social.silentTurns.set(sessionId, [...(social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
    const popSilent = () => {
      const arr = social.silentTurns.get(sessionId) ?? [];
      const next = arr.filter((x) => x.id !== silentId);
      if (next.length > 0) social.silentTurns.set(sessionId, next);
      else social.silentTurns.delete(sessionId);
    };
    // 通话时不要「她自己冒泡」那套行为：对面在说话，插一条 proactive 消息毫无意义。
    //
    // ⭐ 告诉她「现在是在打电话」：不然她会按聊天习惯回一长段带格式/列表的话，
    //   而那要变成声音从虚拟声卡念给对方听 —— 长段落在电话里就是灾难。
    //   这一句只是**上下文**，不是命令；她愿意怎么说还是她自己定。
    const callContext = [
      '【当前是 QQ 语音通话，不是打字聊天】',
      '对方刚才说的话（ASR 转写，可能有错别字/漏字，按意思理解）：',
      text,
      '—— 你这一轮的最终文本会被直接念成声音送给对方（不会出现在 QQ 聊天窗）。',
      '所以：说人话、短句、别用列表/表情符号/链接；口语一点，一两句就够。',
      // ⭐ 2026-10-25 实测：对方两次问「你能不能主动挂断」，她答「我这边挂不了，
      //   手上没这个按钮」—— 工具一直在（qq_call_hangup），但通话上下文里从没说过，
      //   她只能按「自己是个只会说话的脑子」来回答。能力和"知不知道自己有"是两件事。
      '通话是会结束的：要挂断就调 qq_call_hangup（真的会挂掉这通电话，不是只说话）。',
      '对方说「挂了」「再见」「先这样」时，可以直接挂，也可以在说完最后一句之后再挂；',
      '不必反复问对方要不要挂。'
    ].join('\n');
    try {
      const beforeSeq = callSpokenSeq.get(key) ?? 0;
      const result = await deliverPrompt(key, callContext, { silent: true });
      if (!result?.ok) {
        popSilent();
        dropCallWaiter(sessionId, waiterTimer);
        return { ok: false, error: result?.error || '投递失败' };
      }
      const reply = await waitReply;
      if (reply == null) {
        return { ok: false, error: `等待回复超时（${limit}ms）` };
      }
      const spoken = (callSpokenSeq.get(key) ?? 0) > beforeSeq;
      if (spoken) {
        // 她在这一轮里已经用 qq_say 把要说的话递进引擎念过了（那条路会绕开聊天窗）。
        // 此时这一轮最终文本往往是「已发送」之类的工具回执 —— 不能再念一遍。
        return { ok: true, reply: String(reply).trim(), spoken: true };
      }
      return { ok: true, reply: String(reply).trim() };
    } catch (error) {
      popSilent();
      dropCallWaiter(sessionId, waiterTimer);
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** 按定时器句柄把某个 waiter 摘掉（超时/失败收尾用，避免泄漏一个永不 resolve 的条目）。 */
  function dropCallWaiter(sessionId, timer) {
    const arr = callWaiters.get(sessionId);
    if (!arr) return;
    const target = arr.find((w) => w.timer === timer);
    if (target?.timer) clearTimeout(target.timer);
    const next = arr.filter((w) => w !== target);
    if (next.length > 0) callWaiters.set(sessionId, next);
    else callWaiters.delete(sessionId);
  }

  /**
   * 身体回合（2026-10-26）：把一句话投进**她跟主人那条会话**，等这一轮的最终文本，
   * 交给板子念出来；**不进 QQ 聊天窗**。
   *
   * 跟 callDeliverTurn 的差别只有上下文：通话是"电话那头有人"，身体是"屋里有人"。
   * 机制（静默名额 + waiter）完全复用，所以两边不会互相吞消息。
   */
  async function bodyDeliverTurn(key, text, timeoutMs) {
    const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : 60000;
    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      return { ok: false, error: `建会话失败：${error?.message ?? error}` };
    }
    let waiterTimer = null;
    const waitReply = new Promise((resolve) => {
      waiterTimer = setTimeout(() => {
        dropCallWaiter(sessionId, waiterTimer);
        resolve(null);
      }, limit);
      const arr = callWaiters.get(sessionId) ?? [];
      arr.push({ resolve, timer: waiterTimer });
      callWaiters.set(sessionId, arr);
    });
    // 静默名额：这一轮的回复不会进聊天窗（真正的门闩在 pump 的 ended 分支）。
    const silentId = `body-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    social.silentTurns.set(sessionId, [...(social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
    const popSilent = () => {
      const arr = social.silentTurns.get(sessionId) ?? [];
      const next = arr.filter((x) => x.id !== silentId);
      if (next.length > 0) social.silentTurns.set(sessionId, next);
      else social.silentTurns.delete(sessionId);
    };
    const _n = new Date();
    const _p = (v) => String(v).padStart(2, '0');
    const _stamp = `${_n.getFullYear()}-${_p(_n.getMonth() + 1)}-${_p(_n.getDate())} `
      + `${_p(_n.getHours())}:${_p(_n.getMinutes())} 周${'日一二三四五六'[_n.getDay()]}`;
    const bodyContext = [
      text,
      '',
      `（屋里模式，不是 QQ，现在是 ${_stamp}。上面这句是我用嘴说的，被你的麦克风听见、转成了文字（可能有错字）。`,
      '你这一轮回的话会被直接念出来，从我旁边的喇叭放出来，不会进 QQ 聊天窗。',
      '所以：像当面聊天那样口语、短，一两句就够；不要列表/表情/链接，不要提"发消息""打字"。',
      '默认**不要**调 qq_send_message / qq_reply / qq_say —— 你的文字本身就是声音，再发一遍就是重复。',
      '但如果是我要你"做一件事"（发张图、发个文件、查个东西给我看、提醒我什么），那你就去调对应的工具把它做掉；',
      '做完回一句话告诉我结果就行（那句会被念出来）。判断标准：这件事的结果**我在这里看不见**，就得靠工具发到 QQ；',
      '结果只是说给我听的，就别说两遍。）'
    ].join('\n');
    try {
      const result = await deliverPrompt(key, bodyContext, { silent: true });
      if (!result?.ok) {
        popSilent();
        dropCallWaiter(sessionId, waiterTimer);
        return { ok: false, error: result?.error || '投递失败' };
      }
      const reply = await waitReply;
      if (reply == null) {
        return { ok: false, error: `等待回复超时（${limit}ms）` };
      }
      return { ok: true, reply: String(reply).trim(), sessionId };
    } catch (error) {
      popSilent();
      dropCallWaiter(sessionId, waiterTimer);
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * 回合结束时由 pump 调用：若有通话在等这个会话的文本，就把文本交出去。
   *
   * @returns {boolean} true = 这个回合已被通话消费，调用方必须 **continue**（不再发 QQ）。
   */
  function resolveCallTurn(sessionId, text, reason) {
    const arr = callWaiters.get(sessionId);
    if (!arr || arr.length === 0) return false;
    const waiter = arr.shift();
    if (arr.length > 0) callWaiters.set(sessionId, arr);
    else callWaiters.delete(sessionId);
    if (waiter?.timer) clearTimeout(waiter.timer);
    // 只交出「正常完成」的文本：被中断/报错的回合没有可说的话，
    // 让 sidecar 那边按「这句没听见」处理，比让它念一段错误信息强。
    const usable = reason?.kind === 'completed' && String(text ?? '').trim();
    try {
      waiter?.resolve(usable ? String(text).trim() : '');
    } catch { /* resolve 不会抛，兜一下 */ }
    return true;
  }

  /** 起 sidecar（由桥接托管时）。已经在跑就直接返回状态，不重复起。 */
  function startCallSidecar() {
    if (callChild && !callChild.killed) return { ok: true, already: true, pid: callChild.pid };
    const python = callPython();
    if (!fs.existsSync(python)) {
      return {
        ok: false,
        error: `找不到 Python 环境：${python}。先跑 tools/asr 的安装脚本建 venv，或在 config 里设 call.pythonPath。`
      };
    }
    const script = path.join(ROOT, 'tools', 'call', 'call_sidecar.py');
    const args = [script, '--serve', '--port', String(callPort())];
    const outDevice = String(callCfg().outDevice ?? '').trim();
    if (outDevice) args.push('--out-device', outDevice);
    // 把「想」的地址交给 sidecar：它听完一句就来这儿换一句话。
    // 令牌用控制台令牌（sidecar 是本机进程，天然有权限）。
    args.push('--brain-url', `http://127.0.0.1:${boundPortForCall()}/api/call/turn`);
    const token = consoleTokenRef();
    if (token) args.push('--token', token);
    // 录音存哪：默认由 sidecar 自己决定（QQ bot 根目录下的「小鲸鱼的语音/通话录音」）。
    // 配了 call.recDir 就用配置的，方便以后换目录不用改代码。
    const recDir = String(callCfg().recDir ?? '').trim();
    if (recDir) args.push('--rec-dir', recDir);
    // 逐字稿存哪：sidecar 与整理插件必须落在同一个目录，所以两边都认这份配置
    // （插件那边见 plugins/qq-memory-rollover/qq-memory-rollover.mjs 的 callLogDir）。
    const transcriptDir = String(callCfg().transcriptDir ?? '').trim();
    if (transcriptDir) args.push('--transcript-dir', transcriptDir);
    // 自动清理的两个阈值（主人 2026-10-29 选「30 天 + 总量 1 GB 双闸」）。
    // 只在配置里写了才往下传，没写就用 sidecar 的默认值。
    const keepDays = Number(callCfg().recKeepDays);
    if (Number.isFinite(keepDays) && keepDays > 0) args.push('--keep-days', String(keepDays));
    const keepMB = Number(callCfg().recKeepMB);
    if (Number.isFinite(keepMB) && keepMB > 0) args.push('--keep-mb', String(keepMB));
    const child = spawn(python, args, {
      cwd: ROOT,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    callChild = child;
    const tag = `[call]`;
    child.stdout?.on('data', (b) => { const s = String(b).trim(); if (s) log(`${tag} ${s}`); });
    child.stderr?.on('data', (b) => { const s = String(b).trim(); if (s) log(`${tag} ! ${s}`); });
    child.on('exit', (code, signal) => {
      log(`${tag} sidecar 退出 code=${code} signal=${signal ?? ''}`);
      callChild = null;
    });
    log(`${tag} sidecar 已启动 pid=${child.pid} port=${callPort()} out=${outDevice || '(默认扬声器)'}`);
    return { ok: true, pid: child.pid, port: callPort() };
  }

  function stopCallSidecar() {
    if (!callChild || callChild.killed) return { ok: true, already: true };
    const pid = callChild.pid;
    try { callChild.kill(); } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
    callChild = null;
    return { ok: true, killed: pid };
  }

  // ── 来电守夜：响了就自己接 ──────────────────────────────────────────────────
  //
  // 为什么必须是桥接来做：sidecar 只会「听/说」，它不知道这通电话该记在谁的对话里。
  // 电话一响，谁接、接进哪个会话、什么时候挂断，这些都是**桥接的上下文问题**。
  //
  // 判据只有一条：sidecar `/status` 里的 `qq.state === 'ringing'`
  // （由 tools/call/call_state.py 用窗口截图 + OCR 认「接听/拒绝」得出）。
  // 也就是说：**QQ 的来电窗口必须能被截到、能被 OCR 认出来**，这是整条链路的地基。
  //
  // 默认关闭（call.autoAnswer=false）：自动接通相当于"电话一响就有人替你接"，
  // 得主人明确点头。开了之后它只做三件事：接、绑定会话、没声了挂断。
  let callWatchTimer = null;
  let callAnswerAt = 0;          // 上次接听的时刻（防抖，避免同一通电话被接两次）
  let callWatchLastErr = '';     // 只记最后一次错误，别让日志每 3 秒刷一行
  let callWatchSnapshot = null;  // 最近一帧 QQ 窗口识别结果（给控制台看）
  let callIdleTicks = 0;         // 通话中连续看到 qq=idle 的轮数（≥2 才算真挂断）

  const callAutoAnswer = () => callCfg().autoAnswer === true;
  // 这通电话算在谁的对话里：默认接到主人自己的私聊会话（人格就在那儿）。
  const callAnswerKey = () => {
    const configured = String(callCfg().answerKey ?? '').trim();
    if (configured) return configured;
    return cfg.ownerQQ ? `private:${String(cfg.ownerQQ)}` : '';
  };

  // ── 「这通电话是谁打来的」────────────────────────────────────────────────
  //
  // 自动接听只对管理员开放，所以判定「来电者是不是管理员」这一环必须靠谱：
  //   · sidecar 的 OCR 能读出响铃窗口上的文字（昵称/备注/「邀请你语音通话」），
  //     认得出是谁 → 和我们缓存的好友名做匹配。
  //   · 但 OCR 认名字是**尽力而为**：头像裁掉、备注太长被省略、窗口缩放都会让它读不全。
  //     读完认不出谁 → 视为「未知来电者」，按 call.autoAnswerFrom + autoAnswerUnknownCaller 决定。
  //
  // 名字来源：OneBot 的 get_friend_list（remark 优先，remark 是主人自己给的备注，
  // 比昵称更可能是窗口上显示的那个）。缓存 10 分钟 —— 好友列表很少变，
  // 但也不能永久缓存：主人刚改的备注应该很快生效。
  let callFriendsCache = { at: 0, byName: new Map() };
  const CALL_FRIENDS_TTL_MS = 10 * 60 * 1000;

  async function callOwnerNames() {
    const ownerId = String(cfg.ownerQQ ?? '');
    if (!ownerId) return [];
    const byName = await callFriendNameMap();
    const names = [];
    for (const [name, id] of byName) if (id === ownerId) names.push(name);
    return names;
  }

  async function callFriendNameMap() {
    if (callFriendsCache.byName.size > 0 && Date.now() - callFriendsCache.at < CALL_FRIENDS_TTL_MS) {
      return callFriendsCache.byName;
    }
    const byName = new Map();
    try {
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${httpUrl}/get_friend_list`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: '{}',
        signal: AbortSignal.timeout(8000)
      });
      const body = await res.json().catch(() => ({}));
      const list = Array.isArray(body?.data) ? body.data : [];
      for (const f of list) {
        const id = String(f?.user_id ?? '');
        if (!id) continue;
        // 备注和昵称都登记：窗口上显示哪个都可能（QQ 的来电窗口通常显示备注）。
        for (const raw of [f?.remark, f?.nickname]) {
          const name = String(raw ?? '').trim();
          if (name) byName.set(name, id);
        }
      }
    } catch (error) {
      // 拿不到好友列表不是致命问题：认不出来就按"未知来电者"处理。
      log(`[call] 取好友列表失败，来电者识别退化：${error?.message ?? error}`);
    }
    if (byName.size > 0) callFriendsCache = { at: Date.now(), byName };
    return byName;
  }

  /**
   * 从 OCR 的行里认「来电者是不是主人」。
   *
   * 判据刻意保守：**必须整名字出现**（区分大小写前的 trim 比较，用 includes），
   * 不做模糊匹配 —— 「小」和「小明」都能匹配的话，一个叫「小鲸鱼」的陌生号
   * 就能冒充。返回：
   *   { who: 'owner' | 'other' | 'unknown', name?, matched? }
   * owner  = 命中了主人自己的某个名字
   * other  = 命中了**别人的**名字（明确不是主人）
   * unknown= 谁都没命中（OCR 没读出来 / 名字不在好友列表里）
   */
  async function callIdentifyCaller(lines) {
    const joined = (Array.isArray(lines) ? lines : []).map((s) => String(s ?? '')).join('\n');
    if (!joined.trim()) return { who: 'unknown' };
    const byName = await callFriendNameMap();
    const ownerId = String(cfg.ownerQQ ?? '');
    let ownerHit = '';
    let otherHit = '';
    // 长名字优先比：备注「老王（客户）」和昵称「老王」同时在的话，长的更specific。
    const names = [...byName.keys()].sort((a, b) => b.length - a.length);
    for (const name of names) {
      if (!joined.includes(name)) continue;
      if (byName.get(name) === ownerId) { if (!ownerHit) ownerHit = name; }
      else if (!otherHit) otherHit = name;
    }
    if (ownerHit) return { who: 'owner', name: ownerHit };
    if (otherHit) return { who: 'other', name: otherHit };
    return { who: 'unknown' };
  }

  async function callWatchTick() {
    if (!callEnabled()) return;
    // 已经有一通在进行：不重复接，只看看是不是该挂了。
    if (callKey) {
      // 先确认这通电话还活着：sidecar 在「QQ 窗口回到 idle」时会自己把 active 置 false
      // （对方先挂了 / QQ 自己断了），但桥接这边的 callKey 是另一份状态。
      // 不在这里对齐的话：电话挂断后 callKey 一直非空 → 守夜永远走这一支 → 下一通
      // 电话打进来**不会被接**，且要等 hangupAfterIdleMs 之后才可能被清。
      //
      // ⚠️ 重复 /status 拿到的不是纯只读快照：sidecar 的 GET /status 里带一个副作用，
      //    看到 idle 会把 engine.active 置 false。所以这里**只能靠 qq.state 判断**，
      //    不能拿 active 当判据（否则每轮都先把引擎弄聋，再去问它为什么不说话）。
      const side = await callSidecarFetch('/status', { timeoutMs: 5000 });
      if (side.ok) {
        const stillActive = side.data?.engine?.active === true;
        const qqState = side.data?.qq?.state ?? null;
        // 只有「QQ 窗口明确回到 idle」才算这通电话真的结束了。
        // 不能凭 engine.active=false 就解绑：那个值有一个会自己变 false 的来源 ——
        // sidecar 的 GET /status 只要这一帧截图里认不出通话窗口（窗口最小化、「unknown」），
        // 就会把 active 置 false。拿它当判据，等于"我截不到图就把电话挂了"。
        if (qqState === 'idle') {
          // 一帧 idle 不能立刻判挂：来电/通话窗口是 Chromium 自绘的，抓图+认字
          // 偶尔会有一两帧读不出东西；而 `idle` 这个值现在还会在「QQ 在跑但没有
          // 可见窗口」时出现（待机常态）。真按一帧就 endCall，表现就是
          // 「电话聊着聊着突然被挂掉」。所以要连续两轮（≈6 秒）都是 idle 才算结束。
          callIdleTicks += 1;
          if (callIdleTicks >= 2) {
            log(`[call] ${callKey} 通话已结束（连续 ${callIdleTicks} 轮 qq=idle，engineActive=${stillActive}），解绑`);
            endCall('QQ 窗口回到 idle');
            return;
          }
        } else {
          callIdleTicks = 0;
        }
        if (!stillActive) {
          // 引擎没在听了但窗口还在：不要解绑（对方还在线上），但要让人知道"现在是聋的"。
          if (callWatchLastErr !== 'listening-stopped') {
            callWatchLastErr = 'listening-stopped';
            log(`[call] ${callKey} 仍在通话中（qq=${qqState}）但引擎没在采集，对方说话不会被听见`);
          }
        } else if (callWatchLastErr === 'listening-stopped') {
          callWatchLastErr = '';
        }
      }
      const idleMs = Number(callCfg().hangupAfterIdleMs) || 0;
      const lastAt = Number(callLastStats.lastAt) || 0;
      if (idleMs > 0 && lastAt > 0 && Date.now() - lastAt > idleMs) {
        // 很久没说话了才挂 —— 对面只是沉默一会儿不该被挂断，所以这个阈值给得比较宽。
        const r = await callSidecarFetch('/hangup', { method: 'POST', body: { real: true }, timeoutMs: 20000 });
        // 挂断失败（比如对方已经先挂了）也要解绑，否则这通电话会永远占着 callKey。
        endCall(r.ok ? '长时间无对话自动挂断' : '长时间无对话，挂断请求失败但强制解绑');
      }
      return;
    }
    const side = await callSidecarFetch('/status', { timeoutMs: 5000 });
    if (!side.ok) {
      // sidecar 不在（没启动 / 刚崩）：这是**可恢复的常态**，不要每轮都刷一条错误日志。
      const err = side.error || '通话引擎不可达';
      if (err !== callWatchLastErr) { callWatchLastErr = err; log(`[call] 来电守夜暂停：${err}`); }
      callWatchSnapshot = null;
      return;
    }
    callWatchLastErr = '';
    const qqState = side.data?.qq?.state ?? null;
    // 顺手把这一帧记下来：控制台的 /api/call/status 要显示「现在 QQ 那面到底认没认出来」，
    // 不然排查「为什么不接」的时候只能靠猜。
    callWatchSnapshot = {
      qqState,
      at: Date.now(),
      hits: side.data?.qq?.hits ?? [],
      windows: side.data?.qq?.windows_seen ?? 0,
      ocrOk: side.data?.qq?.ocr_ok === true,
      note: side.data?.qq?.note ?? ''
    };
    if (qqState !== 'ringing') return;
    if (!callAutoAnswer()) return;   // 认出是来电，但主人没让它自己接
    // 同一次响铃只接一次：接失败（按钮点不到）时也不要每 3 秒重试到天荒地老。
    if (callAnswerAt && Date.now() - callAnswerAt < 30000) return;

    // ── 谁打来的？（m03948：自动接听只对管理员开放）────────────────────────
    // 这一步排在「点了接听」之前：接起来之后再发现不是主人，等于已经用主人的
    // 麦克风和声音跟陌生人通了话 —— 那时候挂断也晚了。
    const caller = await callIdentifyCaller(side.data?.qq?.lines);
    callWatchSnapshot = { ...callWatchSnapshot, caller };
    const autoFrom = String(callCfg().autoAnswerFrom ?? 'owner').trim() || 'owner';
    if (autoFrom !== 'anyone') {
      if (caller.who === 'other') {
        // 明确认出是别人（好友列表里对不上 ownerQQ）：不接。
        // 这条日志要写清楚，否则主人看到"电话响了她没接"会以为是功能坏了。
        log(`[call] 来电者是「${caller.name || '?'}」（不是管理员），按 call.autoAnswerFrom=owner 不自动接听`);
        return;
      }
      if (caller.who === 'unknown' && callCfg().autoAnswerUnknownCaller === false) {
        log('[call] 来电者认不出是谁（OCR 没读到可匹配的名字），autoAnswerUnknownCaller=false → 不接');
        return;
      }
    }

    callAnswerAt = Date.now();
    const key = callAnswerKey();
    if (!key) { log('[call] 有来电，但没有可绑定的会话（config.call.answerKey / ownerQQ 都没配）'); return; }
    // 只对管理员开放时，接起来的对话必须就是管理员私聊本身。
    // 否则（有人把 answerKey 配成了群/别人的私聊）自动接听等于把主人的电话
    // 接到一个非管理员会话里 —— 那也是"只给管理员"的口子被绕开。
    if (autoFrom !== 'anyone' && cfg.ownerQQ) {
      const ownerKey = `private:${String(cfg.ownerQQ)}`;
      if (key !== ownerKey) {
        log(`[call] 自动接听只对管理员开放，但 answerKey=${key} 不是管理员私聊（${ownerKey}），不接`);
        return;
      }
    }
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[call] 有来电，但当前模式不允许会话 ${key}，不接`);
      return;
    }
    log(`[call] 检测到来电（caller=${caller.who}${caller.name ? `:${caller.name}` : ''}），尝试接听 → ${key}`);
    const r = await callSidecarFetch('/answer', { method: 'POST', body: { real: true }, timeoutMs: 30000 });
    // ⚠️ 判成功必须看 sidecar 返回体里的 ok，**不能只看 r.ok**（那只是 HTTP 200）。
    // sidecar 现在会在「点完状态没变」时回 {"ok": false, "why": ...} + HTTP 200，
    // 只认 HTTP 的话就会把一次点空记成「已接听」——电话还在响，日志却说接起来了。
    if (r.ok && r.data?.ok) {
      callKey = key;
      callStartedAt = Date.now();
      callLastStats.lastAt = Date.now();
      log(`[call] 已接听，绑定 ${key}（via=${r.data?.via || '?'}，state=${r.data?.state_after || '?'}）`);
    } else {
      // 最常见的原因：来电窗口是纯自绘 / OCR 认不出「接听」，按钮点不到。
      // 这不是"偶发失败"，是**这一档的天花板**，所以要原样把原因写进日志。
      log(`[call] 接听失败：${r.error || r.data?.why || r.data?.error || '未知原因'}`);
    }
  }

  function startCallWatch() {
    if (callWatchTimer) return;
    // 3 秒一轮：够快（QQ 响铃窗口只存在几秒），又不至于把 OCR 跑满 CPU。
    callWatchTimer = setInterval(() => { void callWatchTick().catch(() => {}); }, 3000);
    if (callEnabled()) log(`[call] 来电守夜已启动（自动接听=${callAutoAnswer() ? '开' : '关'}）`);
  }

  // 这两个在 startConsoleServer 内部才有：用闭包变量间接拿，避免把上面几个函数塞进去。
  let boundPortForCall = () => cfg.consolePort ?? 3100;
  let consoleTokenRef = () => '';

  function startConsoleServer() {
    const port = cfg.consolePort ?? 3100;
    // 控制台鉴权：优先用 config.consoleToken，未配置则自动生成并持久化，不再默认无鉴权。
    // 使用 let 以便控制台内手动修改令牌后热更新。
    const configuredToken = String(cfg.consoleToken ?? '').trim();
    const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
    let consoleToken = tokenValid ? configuredToken : loadOrCreateConsoleToken();
    // 令牌必须非空才继续。下面鉴权处原来的写法是「令牌为空 ⇒ return true（放行）」，
    // 注释写着"启动时已自动生成并持久化"—— 等于承认那一行不可达，可它是一条**失败开放**的分支：
    // 一旦真的空了（写盘异常被吞、以后新增"关闭鉴权"之类的配置），控制台上那些
    // 改配置 / 发消息 / 读聊天记录的接口会变成完全免鉴权，而 Host 白名单只挡跨机访问、
    // 挡不住本机进程。这里改成失败关闭：宁可启动时报错，也不要静默开着一个无鉴权的管理 API。
    if (!consoleToken) throw new Error('控制台令牌为空：拒绝以无鉴权方式启动控制台 API');
    // 通话模块要拿这两个：sidecar 的 --brain-url 得指向**实际绑定端口**（consolePort 可能是 0），
    // --token 得是真正的控制台令牌。晚绑定所以放在这里赋值。
    consoleTokenRef = () => consoleToken;
    boundPortForCall = () => server.address()?.port ?? port;
    if (!tokenValid && configuredToken) log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    // 直接打完整令牌：控制台是跑在**本机终端**里的，能看到这段日志的人本来就能读
    // state/console-token（同机同用户权限）。截断成 40baad… 只逼着人去翻文件，没有任何安全收益。
    //
    // ⚠️ 2026-10-19：打印形式改成**「提示行 + 纯令牌行」两行**（主人要求方便整行复制）。
    //    原来是一行 `访问令牌：<token>`，复制时得手工删掉「访问令牌：」四个字。
    //    也不能用 log() 打令牌行 —— log() 会给每行加 `时间戳 [bridge] ` 前缀、还会做脱敏，
    //    那样复制出来仍带前缀、甚至拿不到完整值。所以令牌行走裸 console.log。
    if (!configuredToken) {
      log('控制台未配置 consoleToken，已自动生成；下一行是访问令牌（整行可复制，汉字都在本行）');
      try { console.log(consoleToken); } catch {}
      // bridge.log 里仍留一份可追溯记录（走 appendBridgeLog，避免再经过 log() 的脱敏）
      appendBridgeLog(`${localClock()} [bridge] 访问令牌：${consoleToken}\n`);
    }
    // 二代会话级隔离：MCP 工具调用时若带 x-agent-token，则必须匹配该会话的 agentToken。
    // 控制台/管理端请求不带此头，仍走 consoleToken 管理通道。
    //
    // 定长比较：会话令牌同样是凭据，`===` 会在首个不同字符处短路，本机进程理论上
    // 可用响应时延逐字节试探。与控制台令牌（见下方 timingSafeEqual）保持一致。
    const tokenEq = (a, b) => {
      if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
      const x = Buffer.from(a, 'utf8');
      const y = Buffer.from(b, 'utf8');
      return x.length === y.length && crypto.timingSafeEqual(x, y);
    };
    const agentTokenOk = (key, token) => {
      const canonical = canonicalV2Key(key);
      const st = socialV2.conversations.get(canonical ?? key);
      return !!st && !!st.agentToken && tokenEq(token, st.agentToken);
    };
    /**
     * 令牌是否匹配**任意**一个活跃二代会话。
     *
     * 用途是集中式纵深防御（见下方 x-agent-call 关卡）：各端点自己那套
     * `if (x-agent-token && !agentTokenOk(key, token))` 把关的是「这个令牌能不能动这个
     * 会话」；这里把关的是「这到底是不是一次智能体调用」。两层都需要，因为前者在
     * 端点漏写时会整个失效。
     */
    const isLiveAgentToken = (token) => {
      if (typeof token !== 'string' || !token) return false;
      for (const st of socialV2.conversations.values()) {
        if (st?.agentToken && tokenEq(token, st.agentToken)) return true;
      }
      return false;
    };
    // 二代会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。
    const v2SessionAllowed = isSessionAllowedInCurrentMode;
    const server = http.createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'Connection': 'close' });
        res.end(JSON.stringify({ ok: false, error: '无效的请求地址' }));
        return;
      }
      const SECURITY_HEADERS = {
        'X-Frame-Options': 'DENY',
        // 不写这条的话 `default-src 'self'` 会把跨端口的 iframe 直接拒掉，
        // 控制台里就是一块白板 + 浏览器报 Refused to frame。
        // 只放行本机 3101，不是 `*`；3101 那边同时也收窄成只认 3100。
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';",
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      };
      const sendJson = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
        res.end(JSON.stringify(obj, null, 2));
      };
      const readBody = () => new Promise((resolve, reject) => {
        const MAX_BODY_BYTES = 1_000_000;
        const chunks = [];
        let total = 0;
        let settled = false;
        let bodyTimer = null;
        const fail = (status, message) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          const err = new Error(message);
          err.statusCode = status;
          reject(err);
        };
        const done = (val) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          resolve(val);
        };
        // 提前按 Content-Length 拒绝超限请求体
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          fail(413, '请求体过大（超过 1MB）');
          return;
        }
        bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
        req.on('data', (c) => {
          if (settled) return;
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          total += buf.length;
          if (total > MAX_BODY_BYTES) {
            req.pause();
            fail(413, '请求体过大（超过 1MB）');
            return;
          }
          chunks.push(buf);
        });
        req.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks).toString('utf8');
          if (!data.trim()) { done({}); return; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            fail(400, '请求体必须是 JSON 对象');
            return;
          }
          done(parsed);
        });
        // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
        req.on('error', () => fail(400, '请求体读取失败'));
        req.on('aborted', () => fail(400, '请求体读取中断'));
      });
      // 浏览器会自动请求 /favicon.ico，且**不带控制台令牌**。若让它落到下面的鉴权分支，
      // 每次打开控制台都会在 DevTools 里留一条 401 噪音（离线预览 fixture 早已用 204 处理，
      // 真实服务端此前与自己的 fixture 行为不一致）。这里在任何鉴权之前直接 204 收掉。
      if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/apple-touch-icon.png')) {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }
      // Host 头校验（DNS rebinding 硬化）：控制台只监听 127.0.0.1，因此合法请求的 Host
      // 只可能是 127.0.0.1 / localhost / [::1] 加本端口。攻击者用一个 TTL=0 的域名解析到
      // 127.0.0.1 时，浏览器会把 evil.com:3100 当作同源，Origin 校验随之失效；卡住 Host
      // 这一层后，这类请求在进入任何业务分支之前就被拒掉。
      // 反代/端口转发场景会被一并拒绝——这是有意的（要远程访问请用 SSH 隧道并自行承担）。
      const hostHeader = String(req.headers.host ?? '');
      // 用**实际绑定端口**而不是配置值：测试夹具用 consolePort: 0 让系统分配端口，
      // 配置里那个 0 不是请求里的 Host 端口。请求必然发生在 listen 之后，所以这里拿得到。
      const boundPort = server.address()?.port ?? port;
      const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
      if (!allowedHosts.includes(hostHeader.toLowerCase())) {
        sendJson({ ok: false, error: `Host 头不被允许（${hostHeader || '缺失'}）：控制台只接受本机回环访问` }, 403);
        return;
      }
      // 控制台鉴权：所有请求需带 x-console-token 或 ?token=
      // 定长比较：`!==` 会在第一个不同的字符处短路，理论上可被本机进程用响应时延逐字节试探。
      // 令牌是 192 bit 随机值且只监听回环，所以这是纵深防御而非在野漏洞。
      const suppliedToken = String(url.searchParams.get('token') ?? req.headers['x-console-token'] ?? '');
      const tokenMatches = (() => {
        if (!consoleToken) return false; // 上面已拒绝空令牌；真出现也只许失败关闭，绝不 return true
        const a = Buffer.from(suppliedToken, 'utf8');
        const b = Buffer.from(consoleToken, 'utf8');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
      })();
            if (consoleToken && !tokenMatches) {
        // ⭐ 本机打开控制台页面（GET /）不再弹令牌框（主人 2026-10-19 要求）。
        //
        // 为什么安全：能走到这里的请求**已经过了 Host 头校验**（只接受
        // 127.0.0.1 / localhost / [::1]），必然来自本机浏览器。而能从
        // state/console-token 读到这串令牌的人本来就有本机文件权限 —— 让他
        // 再手抄一遍没有任何安全收益，只有"每次开面板都要粘贴一次"的折磨。
        // 所以：**只有根页面**返回注入了令牌的页面；所有 API 仍然逐个校验令牌
        //（下面的 401 分支是给 API 用的，保持不变）。
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            const html = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');
            res.end(injectConsoleToken(html, consoleToken));
          } catch {
            res.end('控制台页面缺失：qq-bridge/public/console.html');
          }
          return;
        }
        sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
        return;
      }
      // 智能体调用隔离（集中关卡）。
      //
      // 背景：控制台令牌是「管理端全权」，会话令牌是「只能动自己这个会话」。MCP 工具进程
      // 两者都持有，所以「这次请求到底是智能体发的还是管理端发的」必须由请求自己声明。
      // 各端点用 `if (x-agent-token && !agentTokenOk(...))` 做会话绑定校验，但那个写法在
      // **头缺失时整条跳过** —— 而头缺失恰恰是模型没传 token 时的自然结果
      // （旧版 mcp-snowluma-safe.js 用 `...(token ? {...} : {})` 直接省略了这个头）。
      // 于是「漏传令牌」不是被拒绝，而是**升级成控制台全权**：典型的 confused deputy。
      //
      // 现在 MCP 端一律带上 x-agent-call: 1（缺令牌时 x-agent-token 为空串），这里只要看到
      // 这个声明就要求令牌必须命中某个活跃会话，端点自己漏写校验也不会退回管理端。
      if (req.headers['x-agent-call'] !== undefined) {
        if (!isLiveAgentToken(req.headers['x-agent-token'])) {
          sendJson({ ok: false, error: '未授权：智能体调用必须携带有效的会话令牌' }, 403);
          return;
        }
      }
      // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
      // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
      // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
      if (req.method !== 'GET') {
        const ctype = String(req.headers['content-type'] ?? '');
        if (!ctype.toLowerCase().includes('application/json')) {
          sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
          return;
        }
        const origin = req.headers['origin'];
        if (origin) {
          let originHost = '';
          try { originHost = new URL(String(origin)).host; } catch {}
          if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(originHost)) {
            sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
            return;
          }
        }
      }
      try {
        // 空 agent token 一律拒绝，防止 MCP 传入空字符串时被当作“管理端/无 token”绕过校验
        if (req.headers['x-agent-token'] === '') {
          sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
          return;
        }
        // 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝
        if (socialV2.paused && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理）
        if (cfg.socialV2?.enabled === false && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用
        if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/') && currentMode !== 'reserved2') {
          sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
          return;
        }
        // 管理端专用 v2 接口：带 agent token 的请求一律拒绝，防止 MCP 工具越权访问控制台功能
        //   · grant-permit：**她绝不能给自己发牌子**。这是整条闸门里最关键的一条：
        //     若 AI 能调它，"申请-批准"就变成了"自己批准自己"，比没有闸门更糟。
        //   · revoke-permit：同理，否则她可以在"不想被管"的时候把授权全撤掉再自己发。
        //   · states / wake / activity / reset / config：跨会话管理面。

        const adminOnlyV2Paths = ['/api/socialV2/config', '/api/socialV2/activity', '/api/socialV2/reset', '/api/socialV2/states', '/api/socialV2/wake', '/api/socialV2/grant-permit', '/api/socialV2/revoke-permit'];
        if (req.headers['x-agent-token'] && (adminOnlyV2Paths.includes(url.pathname) || (url.pathname === '/api/socialV2/feedback' && req.method === 'GET') || (url.pathname === '/api/socialV2/tool-log' && req.method === 'GET'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库）
        if (req.headers['x-agent-token'] && (url.pathname === '/api/stickers' || url.pathname.startsWith('/api/stickers/'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // 群图库管理接口同理：改备注/提升/回收站/清理只走控制台。
        // AI 只能用 /api/socialV2/photo-*（列图、看图、发图），不能动库本身。
        if (req.headers['x-agent-token'] && (url.pathname === '/api/photos' || url.pathname.startsWith('/api/photos/'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
        // 因此仅靠控制台令牌挡不住 AI。这里改成白名单：只有 AI 真正需要的面放行，
        // 其余（人格/提示词/思考强度/白名单/重启…）一律 403——避免以后新增管理端点时忘记拉黑。
        if (req.headers['x-agent-token']) {
          const agentAllowed = url.pathname === '/api/status'
            || url.pathname.startsWith('/api/socialV2/')
            || url.pathname.startsWith('/api/send/')
            || url.pathname.startsWith('/api/images/')
            // 只有 `/api/body/say`（她 → 屋里喇叭）放给智能体。
            // ⚠️ `/api/body/turn` **绝不能**进来：它能读到一条会话的**全部回复文本**，
            //    放给 AI 等于给自己开一条绕过发送闸门直接产出文本的口子（见下方 turn 处的注释）。
            //    `/api/body/config` / `/api/body/status` 也不放 —— 前者含 broker 账号密码。
            || url.pathname === '/api/body/say'
            || url.pathname === '/api/authorize/read';
          if (!agentAllowed) {
            sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
            return;
          }
        }
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'));
          } catch {
            res.end('控制台页面缺失：qq-bridge/public/console.html');
          }
          return;
        }
        // ── 语音通话（档 2）────────────────────────────────────────────────
        //
        // 这一组里只有 `/api/call/turn` 是**给 sidecar 用的**（本机 python 进程，带控制台令牌）；
        // 其余是给控制台和我（MCP 工具）用的。
        //
        // ⚠️ 为什么 turn 不能被 agent token 调用：它能读到一个会话的**全部回复文本**，
        //    如果 AI 自己能调，就等于给自己开了一条"绕过 send 闸门直接产出文本"的口子。
        //    所以下面的集中白名单里**没有**放行 `/api/call/`，agent 走的是 `/api/socialV2/call-*`。
        // ── 身体回合（本机 python 用，带控制台令牌）────────────────────────────
        // 跟 /api/call/turn 同一族：把一句话投进她跟主人的那条会话，把回复文本交给调用方
        // 念出来，但**不设通话上下文**。所以板子上说话的和 QQ 上说话的是同一个她、同一段记忆。
        if (url.pathname === '/api/body/turn' && req.method === 'POST') {
          const body = await readBody();
          const key = String(body.key || cfg.call?.answerKey || '').trim();
          const text = String(body.text || '').trim();
          if (!key) return sendJson({ ok: false, error: '缺少 key（这次说话绑到哪个会话）' }, 400);
          if (!text) return sendJson({ ok: true, reply: '' });
          if (!isSessionAllowedInCurrentMode(key)) {
            return sendJson({ ok: false, error: `当前模式不允许会话 ${key}` }, 403);
          }
          const r = await bodyDeliverTurn(key, text, Number(body.timeoutMs) || 0);
          return sendJson({ ...r, key });
        }
        // ── 身体的表现参数（控制台「身体」页读写）──────────────────────────────
        // 写的是 state/body-config.json，也就是 rot/tools/body_config.py 读的那份。
        // 不缓存：每次现读磁盘，改完下一轮对话就生效，不用重启任何东西。
        if (url.pathname === '/api/body/config' && req.method === 'GET') {
          const stored = readJsonSafe(BODY_CONFIG_FILE, {});
          const config = normalizeBodyConfig(stored);
          // ⚠️ 密码**绝不回传给浏览器**（控制台是网页，令牌泄露就等于账号泄露）。
          // 只回一个「有没有设」的布尔，前端据此决定 placeholder。
          return sendJson({
            ok: true,
            config: { ...config, mqttPass: '', hasMqttPass: !!config.mqttPass },
            path: BODY_CONFIG_FILE
          });
        }
        if (url.pathname === '/api/body/config' && req.method === 'POST') {
          const body = await readBody();
          const prev = normalizeBodyConfig(readJsonSafe(BODY_CONFIG_FILE, {}));
          const next = normalizeBodyConfig(body, prev);
          if (body.base !== undefined && !/^[A-Za-z0-9._\-/]{1,64}$/.test(String(next.base || ''))) {
            return sendJson({ ok: false, error: '主题前缀只能用字母、数字和 . _ - /（例如 whale-a90c6c）' }, 400);
          }
          if (body.broker !== undefined && !/^[A-Za-z0-9._\-:]{3,120}$/.test(String(next.broker || ''))) {
            return sendJson({ ok: false, error: 'broker 写主机名就行（例如 broker.hivemq.com）' }, 400);
          }
          try {
            atomicWriteJson(BODY_CONFIG_FILE, next);
          } catch (error) {
            return sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
          }
          log(`控制台：身体参数已更新 volume=${next.volume} silence=${next.silenceSec}s max=${next.maxSec}s cue=${next.cue} mode=${next.boardMode}`);
          // 模式是真的要推给板子的（存它自己的 NVS）。没变就不打扰它。
          let modeResult = null;
          if (next.boardMode !== prev.boardMode) {
            modeResult = await bodySetMode(next.base, next.broker, next.boardMode);
            log(`控制台：把板子切到 ${next.boardMode} → ${modeResult.ok ? '已确认' : ('没确认：' + modeResult.error)}`);
          }
          // 回给浏览器的那份同样抹掉密码（见 GET 处的说明）。
          return sendJson({
            ok: true,
            config: { ...next, mqttPass: '', hasMqttPass: !!next.mqttPass },
            modeResult
          });
        }
        // 板子在不在线。慢（最多 8 秒 —— 板子 5 秒一次心跳），所以单独一个接口。
        if (url.pathname === '/api/body/status' && req.method === 'GET') {
          const config = normalizeBodyConfig(readJsonSafe(BODY_CONFIG_FILE, {}));
          const probe = await bodyProbe(config.base, config.broker);
          const exists = fs.existsSync(BODY_CONFIG_FILE);
          return sendJson({
            ok: true,
            // 同样抹掉密码（见 /api/body/config GET）。
            config: { ...config, mqttPass: '', hasMqttPass: !!config.mqttPass },
            board: {
              base: config.base,
              broker: config.broker,
              online: probe.ok,
              detail: probe.ok ? (probe.detail || 'state 心跳正常') : (probe.error || '')
            },
            configFile: { path: BODY_CONFIG_FILE, exists }
          });
        }
        // ── 让她用屋里的喇叭说话（她 → 板子）────────────────────────────────
        // 与 `/api/body/turn` 正好相反：那边是"板子听见什么 → 她回答"，
        // 这边是"她在 QQ 里想说一句 → 从板子喇叭放出来"。
        //
        // 谁调：MCP 的 `mcp__snowluma__qq_body_say`（见 src/mcp-snowluma-safe.js），
        // 也就是**她自己决定**要不要用身体说话 —— 不是每条回复都镜像过去，
        // 那会把喇叭变成 QQ 的复读机（主人 m13018 选的口径）。
        //
        // 两道闸：
        //   ① 会话分档：只有管理员私聊那条会话能用（守卫那一层已经按 HOST_EXEC_TOOLS
        //      的同类口径拦过一道，这里再查一次 key —— 那条私聊才是"她自己的房间"）。
        //   ② 板子在线才合成：脚本自己会先 wait_state，不在就立刻退出码 1。
        //      不要在这里另做探活，否则一次调用要连两遍 broker。
        if (url.pathname === '/api/body/say' && req.method === 'POST') {
          const body = await readBody();
          const key = String(body.key || cfg.call?.answerKey || '').trim();
          const text = String(body.text || '').trim();
          if (!key) return sendJson({ ok: false, error: '缺少 key（这句话属于哪个会话）' }, 400);
          if (!text) return sendJson({ ok: false, error: '没有要念的话' }, 400);
          const ownerKey = cfg.ownerQQ ? `private:${String(cfg.ownerQQ)}` : '';
          if (!ownerKey || key !== ownerKey) {
            return sendJson({
              ok: false,
              error: `身体只在管理员的私聊里出声（这句话绑的是 ${key}，管理员是 ${ownerKey || '没配'}）`
                + ' —— 这不是故障，是"喇叭装在他屋里"'
            }, 403);
          }
          const config = normalizeBodyConfig(readJsonSafe(BODY_CONFIG_FILE, {}));
          log(`身体：她说「${text.slice(0, 40)}${text.length > 40 ? '…' : ''}」→ 板子喇叭（音量 ${config.volume}）`);
          const r = await bodySay(config, text, body.volume ?? config.volume, Number(body.timeoutMs) || 90000);
          if (!r.ok) {
            log(`身体：念失败 —— ${r.error}`);
            return sendJson({ ok: false, error: r.error || '念失败', detail: r.detail ?? '' }, r.code === 0 ? 500 : 502);
          }
          log(`身体：念完了（${r.detail || 'ok'}）`);
          return sendJson({ ok: true, detail: r.detail ?? '', key, volume: config.volume });
        }
        if (url.pathname === '/api/call/turn' && req.method === 'POST') {
          if (!callEnabled()) {
            sendJson({ ok: false, error: '语音通话没开（config.call.enabled=false）' }, 403);
            return;
          }
          const body = await readBody();
          const key = String(body.key || callKey || '').trim();
          const text = String(body.text || '').trim();
          if (!key) return sendJson({ ok: false, error: '缺少 key（这次通话绑定到哪个会话）' }, 400);
          if (!text) return sendJson({ ok: true, reply: '' });   // 没听清就别说，别让 DSH 空转
          if (!isSessionAllowedInCurrentMode(key)) {
            return sendJson({ ok: false, error: `当前模式不允许会话 ${key}` }, 403);
          }
          const r = await callDeliverTurn(key, text);
          callLastStats.turns += 1;
          callLastStats.lastUtterance = text;
          callLastStats.lastAt = Date.now();
          if (r.ok) callLastStats.lastReply = r.reply;
          else callLastStats.lastError = r.error;
          if (r.ok && r.spoken) {
            // 她这一轮里已经直接把话递进引擎念过了（qq_say 在通话中会改道到这里）。
            // 此时 r.reply 只是「已发送」那类工具回执，**不能**再让 sidecar 念一遍。
            return sendJson({ ok: true, reply: '', spoken: true, key });
          }
          // 把这次实际用的 key 回给 sidecar：它启动时还不知道这通电话会绑到哪个会话
          // （key 是接听那一刻才定的），而逐字稿要按 key 归档，否则整理脚本只能跳过。
          return sendJson({ ...r, key });
        }
        if (req.method === 'GET' && url.pathname === '/api/call/status') {
          const side = await callSidecarFetch('/status', { timeoutMs: 4000 });
          sendJson({
            ok: true,
            config: {
              enabled: callEnabled(),
              port: callPort(),
              outDevice: String(callCfg().outDevice ?? ''),
              allowOutbound: callCfg().allowOutbound === true,
              autoAnswer: callAutoAnswer(),
              autoAnswerFrom: String(callCfg().autoAnswerFrom ?? 'owner'),
              autoAnswerUnknownCaller: callCfg().autoAnswerUnknownCaller !== false,
              answerKey: callAnswerKey()
            },
            bridge: {
              key: callKey,
              startedAt: callStartedAt,
              since: callStartedAt ? Math.round((Date.now() - callStartedAt) / 1000) : 0,
              sidecarPid: callChild?.pid ?? null,
              stats: callLastStats,
              waiting: [...callWaiters.values()].reduce((n, a) => n + a.length, 0),
              // 「电话响没响」是靠 OCR 认窗口认出来的 —— 把这帧原样透出来，
              // 否则出了"不接听"只能靠翻日志猜是没响还是没认出。
              watch: callWatchSnapshot
            },
            engine: side.ok ? side.data : { ok: false, error: side.error, raw: side.text }
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/call/start') {
          if (!callEnabled()) return sendJson({ ok: false, error: '语音通话没开（config.call.enabled=false）' }, 403);
          const body = await readBody().catch(() => ({}));
          const key = String(body.key || '').trim();
          if (key && !isSessionAllowedInCurrentMode(key)) {
            return sendJson({ ok: false, error: `当前模式不允许会话 ${key}` }, 403);
          }
          const started = startCallSidecar();
          if (started.ok && key) { callKey = key; callStartedAt = Date.now(); }
          // 起进程是异步的，立刻回「已发起」，真实就绪状态看 /api/call/status。
          sendJson({ ok: started.ok, ...started, key: callKey, hint: '进程刚起，2~3 秒后再查 status 确认引擎就绪' });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/call/stop') {
          const stopped = stopCallSidecar();
          endCall('引擎被手动停掉');
          sendJson({ ok: stopped.ok, ...stopped });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/call/say') {
          const body = await readBody();
          const text = String(body.text || '').trim();
          if (!text) return sendJson({ ok: false, error: '缺少 text' }, 400);
          const r = await callSidecarFetch('/say', { method: 'POST', body: { text }, timeoutMs: 120000 });
          sendJson(r.ok ? { ok: true, ...(r.data ?? {}) } : { ok: false, error: r.error || r.data?.error || 'TTS 失败' });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/call/answer') {
          const body = await readBody().catch(() => ({}));
          const r = await callSidecarFetch('/answer', { method: 'POST', body: { real: body.real === true }, timeoutMs: 30000 });
          sendJson(r.ok ? { ok: true, ...(r.data ?? {}) } : { ok: false, error: r.error || r.data?.error || '接听失败' });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/call/hangup') {
          const body = await readBody().catch(() => ({}));
          const r = await callSidecarFetch('/hangup', { method: 'POST', body: { real: body.real === true }, timeoutMs: 30000 });
          if (r.ok && body.real === true) endCall('挂断成功');
          sendJson(r.ok ? { ok: true, ...(r.data ?? {}) } : { ok: false, error: r.error || r.data?.error || '挂断失败' });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const rs = readRoleState();
          // 带 agent token 的调用来自 QQ 群里的 AI：只能拿到它自己该知道的运行状态。
          // activity 是**全局**收发摘要（含其它群的发言片段与告警），ownerQQ/白名单属于管理信息，
          // 都不能给到会话级主体，否则 A 群的 AI 能读到 B 群的内容。
          // 判定「是不是智能体调用」必须同时看 x-agent-call：无令牌的智能体调用
          // （旧只读工具的模式探测）不带 x-agent-token，但它同样**绝不能**拿到管理端字段
          // —— ownerQQ / 白名单 / activity（含其它群的发言片段）是跨群管理信息。
          // 只认 token 会让这类请求落到下面的完整对象上，等于把 A 群的 AI 变成管理端。
          if (req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined) {
            sendJson({
              mode: currentMode,
              role: rs.role ?? null,
              roleMode: rs.mode ?? 'active',
              dshReady,
              socialV2Paused: socialV2.paused,
            });
            return;
          }
          sendJson({
            mode: currentMode,
            closedAgentPreset,
            role: rs.role ?? null,
            roleMode: rs.mode ?? 'active',
            dshReady,
            ownerQQ: cfg.ownerQQ ?? null,
            allowGroups: cfg.allow?.groups ?? [],
            allowPrivate: cfg.allow?.private ?? [],
            socialV2Paused: socialV2.paused,
            // 上游健康只给操作者看：它包含网关诊断信息（good/hint），
            // 属于管理侧观测，不该进 QQ 会话里那个受限的智能体视图。
            snowluma: snowlumaHealthSnapshot(),
            activity: readActivityTail(100)
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/presets') {
          let presets = [];
          try {
            const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
            presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
          } catch {}
          sendJson({ presets });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/mode') {
          const body = await readBody();
          // 规范名与历史名都接受，落盘的始终是内部拼写（见 MODE_INPUT_ALIASES）。
          const requestedMode = normalizeModeInput(body.mode);
          if (!requestedMode) {
            sendJson({ ok: false, error: `mode 必须是 ${VALID_MODES.join(' / ')}（simulation 为 reserved2 的规范名）` }, 400);
            return;
          }
          const existing = readJsonSafe(path.join(STATE_DIR, 'mode.json'), {});
          const next = {
            mode: requestedMode,
            // 未显式传 preset 时保留原值；原值也没有就留空（= 用 DSH 默认 preset）。
            ...(body.closedAgentPreset !== undefined
              ? { closedAgentPreset: String(body.closedAgentPreset ?? '') }
              : { closedAgentPreset: String(existing.closedAgentPreset ?? '') })
          };
          atomicWriteJson(path.join(STATE_DIR, 'mode.json'), next);
          // 用字符串判断而非真值判断：空串是「显式清空 preset」，也要生效。
          closedAgentPreset = next.closedAgentPreset;
          // 写穿到 DSH 设置。refreshMode() 每 5 秒跑一次且以 DSH 的值为准（插件的 base 保证
          // 该命名空间永远有值），所以只写本地 state/mode.json 会在下一次轮询时被静默回滚。
          // 写穿的是**内部拼写**（`simulation` 会写成 `reserved2`）：DSH 里那份值会被 refreshMode
          // 读回来当 `currentMode` 用，存规范名会让下游那些 `=== 'reserved2'` 判断失效。
          let dshSynced = false;
          try {
            // unwrap() 在 result.ok 为 false 时直接抛错，所以能执行到下一行即代表写穿已成功
            // （不要在这里再判断 updated?.ok —— 解包后的值恒为真，那样的分支是死代码）。
            unwrap(await api.settings.update({ ns: 'qq-mode', patch: { mode: requestedMode } }), 'settings.update');
            dshSynced = true;
          } catch (error) {
            log(`控制台：模式写穿 DSH 设置失败（${error?.message ?? error}）；本次仅写本地，下次 DSH 轮询会覆盖回滚`);
          }
          // 下面这两个判断比较的是「模式真的变了吗」。必须用归一后的值：拿 `body.mode` 比，
          // 把 `simulation` 与 `reserved2` 当成两种模式，会在模式其实没变时清掉二代定时器与排队投递。
          if (currentMode === 'reserved' && requestedMode !== 'reserved') {
            cleanupSocialForModeChange();
            log('控制台：模式离开一代仿真模式，清理社交状态');
          }
          if (currentMode === 'reserved2' && requestedMode !== 'reserved2') {
            clearAllSocialV2Timers();
            drainAllPromptQueues('模式切换，已取消排队中的投递');
            log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
          }
          currentMode = requestedMode;
          lastMode = requestedMode;
          reconcileSessionPolicies();
          if (requestedMode === 'reserved2') {
            for (const key of socialV2.conversations.keys()) {
              setupSleepTimerV2(key);
              scheduleProactiveCheckV2(key);
            }
            log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
          }
          log(`控制台：模式已设置为 ${requestedMode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}${dshSynced ? '' : ' [仅本地，DSH 未同步]'}`);
          sendJson({ ok: true, mode: requestedMode, closedAgentPreset: next.closedAgentPreset, dshSynced });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role') {
          const body = await readBody();
          const rs = readRoleState();
          if (body.role && typeof body.role === 'string') {
            const name = sanitizeRoleName(body.role);
            if (!fs.existsSync(path.join(ROOT, 'roles', name + '.md'))) {
              sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
              return;
            }
            writeRoleState(name, rs.mode);
            log(`控制台：角色已设置为 ${name}`);
            sendJson({ ok: true, role: name });
          } else {
            writeRoleState(null, rs.mode);
            log('控制台：角色已清除');
            sendJson({ ok: true, role: null });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role-mode') {
          const body = await readBody();
          const rs = readRoleState();
          const mode = body.mode === 'silent' ? 'silent' : 'active';
          writeRoleState(rs.role, mode);
          log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
          sendJson({ ok: true, roleMode: mode });
          return;
        }
        // ── 人格管理 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/roles') {
          const rs = readRoleState();
          const summaries = roleSummaries();
          sendJson({
            // roles 保持「人格名字符串数组」的既有契约（scripts/test-console.mjs 等调用方依赖它）；
            // 富信息放在 summaries 里，新老调用方互不影响。
            roles: summaries.map((role) => role.name),
            summaries,
            current: rs.role ?? null,
            limits: { nameMax: ROLE_NAME_MAX, contentMaxBytes: ROLE_CONTENT_MAX_BYTES, injectMaxChars: roleInjectMaxChars },
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/roles/content') {
          let name;
          try { name = validateRoleName(url.searchParams.get('name')); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          const content = readRoleContent(name);
          sendJson({
            ok: true,
            name,
            content,
            chars: content.length,
            bytes: Buffer.byteLength(content, 'utf8'),
            warnings: roleWarnings(content),
            limits: { injectMaxChars: roleInjectMaxChars },
            stats: roleCharStats(content),
            // 每个小节在各模式下是否会被注入，供控制台预览「这条规则到底生不生效」
            sections: { v1: roleSectionReport(content, 'v1'), v2: roleSectionReport(content, 'v2') },
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/limit') {
          const body = await readBody();
          const next = applyRoleInjectLimit(body.maxInjectChars);
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          file.role = { ...(file.role ?? {}), maxInjectChars: next };
          atomicWriteJson(configFile, file);
          cfg.role = { ...(cfg.role ?? {}), maxInjectChars: next };
          roleInjectMaxChars = next;
          log(`控制台：人格注入上限已设为 ${next} 字符（下一条消息生效）`);
          sendJson({ ok: true, maxInjectChars: next, limits: { injectMaxChars: next } });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/create') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」已存在` }, 400); return; }
          writeRoleContent(name, content);
          log(`控制台：创建人格「${name}」（${content.length} 字符）`);
          sendJson({ ok: true, role: name, warnings: roleWarnings(content) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/update') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          writeRoleContent(name, content);
          log(`控制台：更新人格「${name}」（${content.length} 字符）`);
          sendJson({ ok: true, role: name, chars: content.length, warnings: roleWarnings(content) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/rename') {
          const body = await readBody();
          let from; let to;
          try { from = validateRoleName(body.from); to = validateRoleName(body.to); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (from === to) { sendJson({ ok: true, role: to, renamed: false }); return; }
          if (!fs.existsSync(roleFilePath(from))) { sendJson({ ok: false, error: `人格「${from}」不存在` }, 404); return; }
          if (fs.existsSync(roleFilePath(to))) { sendJson({ ok: false, error: `人格「${to}」已存在` }, 400); return; }
          fs.renameSync(roleFilePath(from), roleFilePath(to));
          const rs = readRoleState();
          const switched = rs.role === from;
          if (switched) writeRoleState(to, rs.mode);
          log(`控制台：人格重命名「${from}」→「${to}」${switched ? '（当前启用中，已跟随切换）' : ''}`);
          sendJson({ ok: true, role: to, renamed: true, currentFollowed: switched });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/delete') {
          const body = await readBody();
          let name;
          try { name = validateRoleName(body.name); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          fs.rmSync(roleFilePath(name));
          const rs = readRoleState();
          const cleared = rs.role === name;
          if (cleared) writeRoleState(null, rs.mode);
          log(`控制台：删除人格「${name}」${cleared ? '（该人格正在启用，已同时清除当前人格）' : ''}`);
          sendJson({ ok: true, deleted: name, clearedCurrent: cleared });
          return;
        }

        // ── 仿真提示词（一代 / 二代各自的预设内置提示词）──────────────────────
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt') {
          const preset = resolvePresetName(url.searchParams.get('preset'));
          try {
            const { prefix } = readPresetPromptText(preset);
            sendJson({
              ok: true,
              content: prefix,
              chars: prefix.length,
              bytes: Buffer.byteLength(prefix, 'utf8'),
              warnings: presetPromptWarnings(prefix),
              status: presetStatus(preset),
              presets: Object.values(PRESET_NAMES).map((n) => presetStatus(n)),
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取预设失败', status: presetStatus(preset) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt') {
          const body = await readBody();
          const preset = resolvePresetName(body.preset);
          let nextText;
          try {
            const { text, prefix } = readPresetPromptText(preset);
            // 内容没变就不要写：写回会把折叠块规整成字面量块（值不变但排版变化），
            // 让一次"打开又保存"把整个提示词块变成全删全加的 diff，失去可复审性。
            const normalized = String(body.content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
            if (normalized === prefix) {
              sendJson({ ok: true, unchanged: true, chars: prefix.length, warnings: presetPromptWarnings(prefix), synced: fs.existsSync(installedPresetYaml(preset)), requiresRestart: false, status: presetStatus(preset) });
              return;
            }
            nextText = renderPresetPromptYaml(text, body.content, preset === PRESET_NAMES.v1 ? 'v1' : 'v2');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '校验失败' }, 400);
            return;
          }
          const warnings = presetPromptWarnings(body.content);
          let sourceBackup = null;
          try {
            sourceBackup = backupPresetFile(preset);
            atomicWriteText(presetSourceYaml(preset), nextText);
            // 同步到 DSH 实际读取的安装目录。
            // 注意：安装副本**不做仓库内备份**——它的内容与刚写好的源文件一致，
            // 备份它等于把含本机绝对路径的快照塞进仓库工作区，没有额外价值。
            const installed = installedPresetYaml(preset);
            if (fs.existsSync(installed)) {
              fs.copyFileSync(presetSourceYaml(preset), installed);
            }
          } catch (error) {
            // 尽力回滚源文件，避免留下半截状态
            if (sourceBackup && fs.existsSync(sourceBackup)) {
              try { fs.copyFileSync(sourceBackup, presetSourceYaml(preset)); } catch {}
            }
            sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
            return;
          }
          log(`控制台：${preset} 仿真提示词已更新（${String(body.content ?? '').length} 字符）${warnings.length ? `，${warnings.length} 条警告` : ''}；需重启 DSH 生效`);
          sendJson({
            ok: true,
            chars: String(body.content ?? '').length,
            warnings,
            synced: fs.existsSync(installedPresetYaml(preset)),
            requiresRestart: true,
            status: presetStatus(preset),
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt/backups') {
          try {
            sendJson({ ok: true, backups: listPresetBackups(resolvePresetName(url.searchParams.get('preset'))) });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取备份失败' }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt/restore') {
          const body = await readBody();
          const preset = resolvePresetName(body.preset);
          try {
            const requested = String(body.file ?? '').trim();
            const candidates = listPresetBackups(preset).map((b) => b.file);
            const target = requested || candidates[0];
            // 只允许还原本预设目录下的备份文件，拒绝任何路径穿越
            if (!target || !candidates.includes(target)) { sendJson({ ok: false, error: '没有可用的备份' }, 400); return; }
            const backupPath = path.join(PRESET_BACKUP_DIR, target);
            const restored = fs.readFileSync(backupPath, 'utf8');
            const restoredPrefix = extractPresetPrefix(restored);
            if (restoredPrefix === null) { sendJson({ ok: false, error: '备份内容不是有效的预设文件' }, 400); return; }
            // 还原路径必须与保存路径同样严格：旧备份可能来自安全基线加入之前，
            // 直接还原会把弱化版提示词（缺「你没有本地工具」等不变量）写回去。
            // 不变量清单**按预设取**：一代本来就没有「你没有本地工具」这类工具面表述。
            const blockers = presetPromptBlockers(restoredPrefix, preset === PRESET_NAMES.v1 ? 'v1' : 'v2');
            if (blockers.length) {
              sendJson({ ok: false, error: `该备份不满足当前的安全不变量，拒绝还原：${blockers.join('；')}` }, 400);
              return;
            }
            backupPresetFile(preset);
            atomicWriteText(presetSourceYaml(preset), restored);
            const installed = installedPresetYaml(preset);
            if (fs.existsSync(installed)) fs.copyFileSync(presetSourceYaml(preset), installed);
            log(`控制台：${preset} 仿真提示词已还原自备份 ${target}；需重启 DSH 生效`);
            sendJson({ ok: true, restoredFrom: target, requiresRestart: true });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '还原失败' }, 500);
          }
          return;
        }

        // ── 黑话库管理 ──────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/slang') {
          const status = url.searchParams.get('status') || '';
          const list = status ? slangEntries.filter((e) => e.status === status) : slangEntries;
          sendJson({ entries: list, config: cfg.slang });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang') {
          const body = await readBody();
          const content = String(body.content ?? '').trim();
          if (!content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          if (slangEntries.some((e) => e.content === content)) { sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return; }
          const entry = createSlangEntry({
            content,
            meaning: String(body.meaning ?? '').trim(),
            usage: String(body.usage ?? '').trim(),
            example: String(body.example ?? '').trim(),
            risk: String(body.risk ?? '').trim(),
            sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
            status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
            source: 'manual',
            evidence: Array.isArray(body.evidence) ? body.evidence : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          log(`控制台：新增黑话「${content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/clear') {
          const body = await readBody();
          const status = String(body.status ?? '').trim();
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
            return;
          }
          let removedCount = 0;
          if (status) {
            removedCount = slangEntries.filter((e) => e.status === status).length;
            slangEntries = slangEntries.filter((e) => e.status !== status);
          } else {
            removedCount = slangEntries.length;
            slangEntries = [];
            // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
            slangWindows.clear();
            slangExtractionCooldowns.clear();
            slangSubmitTimes.clear();
            slangResearchingIds.clear();
          }
          saveSlangStore();
          log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-delete') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          const status = String(body.status ?? '').trim();
          if (ids.length) {
            const idSet = new Set(ids);
            const before = slangEntries.length;
            slangEntries = slangEntries.filter((e) => !idSet.has(e.id));
            const removedCount = before - slangEntries.length;
            if (!removedCount) { sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return; }
            saveSlangStore();
            log(`控制台：批量删除黑话 ${removedCount} 条`);
            sendJson({ ok: true, removedCount });
            return;
          }
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
            return;
          }
          if (!status) { sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return; }
          const removedCount = slangEntries.filter((e) => e.status === status).length;
          slangEntries = slangEntries.filter((e) => e.status !== status);
          saveSlangStore();
          log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-confirm') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return; }
          let confirmedCount = 0;
          let skippedCount = 0;
          const skipped = [];
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
            const entry = slangEntries[idx];
            if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
            if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
            entry.status = SLANG_STATUS.CONFIRMED;
            entry.updatedAt = new Date().toISOString();
            confirmedCount++;
          }
          if (confirmedCount) saveSlangStore();
          log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
          sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-reject') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return; }
          let rejectedCount = 0;
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) continue;
            const entry = slangEntries[idx];
            if (entry.status === SLANG_STATUS.REJECTED) continue;
            entry.status = SLANG_STATUS.REJECTED;
            entry.updatedAt = new Date().toISOString();
            rejectedCount++;
          }
          if (rejectedCount) saveSlangStore();
          log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
          sendJson({ ok: true, rejectedCount });
          return;
        }
        const slangMatch = url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
        if (req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = { ...slangEntries[idx] };
          if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
          if (body.content !== undefined && slangEntries.some((e) => e.id !== id && e.content === entry.content)) {
            sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
            return;
          }
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (body.status !== undefined && [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
          if (!entry.content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          entry.updatedAt = new Date().toISOString();
          slangEntries[idx] = entry;
          saveSlangStore();
          log(`控制台：更新黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = slangEntries[idx];
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (!entry.meaning) {
            sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
            return;
          }
          entry.status = SLANG_STATUS.CONFIRMED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：确认黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const entry = slangEntries[idx];
          entry.status = SLANG_STATUS.REJECTED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：拒绝黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const [removed] = slangEntries.splice(idx, 1);
          saveSlangStore();
          log(`控制台：删除黑话「${removed.content}」`);
          sendJson({ ok: true, removed });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/extract') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (key && slangWindows.has(key)) {
            queueSlangTask(() => runSlangExtraction(key));
            sendJson({ ok: true, key });
          } else {
            const firstKey = slangWindows.keys().next().value;
            if (!firstKey) { sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return; }
            queueSlangTask(() => runSlangExtraction(firstKey));
            sendJson({ ok: true, key: firstKey });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/research') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
          const candidates = ids.length
            ? slangEntries.filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
            : slangEntries.filter((e) => e.status === SLANG_STATUS.CANDIDATE);
          if (!candidates.length) { sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return; }
          queueSlangTask(() => runSlangResearch(candidates));
          sendJson({ ok: true, count: candidates.length });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/config') {
          const body = await readBody();
          const oldPreset = cfg.slang?.learnerPreset;
          const oldWorkspaceTitle = cfg.slang?.workspaceTitle;
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          const merged = { ...(file.slang ?? {}), ...body };
          if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
          else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
          if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
          if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
          if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
          if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
          if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
          if (body.inferenceThresholds !== undefined) {
            const raw = Array.isArray(body.inferenceThresholds)
              ? body.inferenceThresholds
              : String(body.inferenceThresholds).split(/[,，\s]+/);
            merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
            if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
          }
          file.slang = merged;
          atomicWriteJson(configFile, file);
          cfg.slang = { ...cfg.slang, ...merged };
          if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习 preset 已变更，已重置学习会话');
          } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习工作区名已变更，已重置学习会话');
          }
          log('控制台：黑话系统配置已更新');
          sendJson({ ok: true, config: cfg.slang });
          return;
        }
        // ── 会话查看 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          const list = [];
          for (const [key, sessionId] of Object.entries(state.sessions)) {
            list.push({ key, sessionId, owner: key === `private:${String(cfg.ownerQQ ?? '')}` });
          }
          sendJson({ sessions: list });
          return;
        }
        // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/pending') {
          const list = [];
          for (const [key, p] of pending.entries()) {
            list.push({
              key,
              kind: p.kind,
              sessionId: p.sessionId,
              ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
              ...(p.kind === 'question' ? { questions: p.questions } : {})
            });
          }
          sendJson({ pending: list });
          return;
        }
        // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
        // ⭐ 「权能矩阵」（2026-10-19 加）：只读，给控制台渲染"三类人 × 每类工具"。
        //
        // ⭐⭐ 关键设计：**表格的每一格都由守卫自己的 verdictFor() 现算**，不是这里另写一份规则 ——
        //    否则界面迟早和实际执行漂移（界面说允许、实际被拒，或更糟：界面说拒绝、实际放行）。
        //    守卫文件是唯一实现；这里只负责"把它的输入喂进去、把结果搬出来"。
        //    ⚠️ 用**仓库内相对路径**解析，不用包名 `qq-agent-presets/...`：
        //       那个包名只在 DSH profile 的 node_modules（junction）里可解析，
        //       桥接进程按自己的仓库目录解析会 ERR_MODULE_NOT_FOUND（实测过）。
        //       而仓库里这份 plugins/qq-agent-presets/qq-tool-restrict.mjs 就是**唯一权威实现**
        //       （profile 里的那份是它的 junction 副本，见该文件头部的说明）。
        if (req.method === 'GET' && url.pathname === '/api/tool-matrix') {
          try {
            const mod = await import('../plugins/qq-agent-presets/qq-tool-restrict.mjs');
            const mx = mod.privilegeMatrix();
            // 逐格求值：允许 / 拒绝（拒绝时带上理由，界面可直接显示"为什么"）
            const table = mx.groups.map((g) => ({
              id: g.id,
              label: g.label,
              note: g.note,
              // 可选：组里显式声明的档位标签。有些组光看三格会读错
              // （最典型：要申请才放行的那组，表里永远是 ✗，
              //  但意思是"此刻没有授权"而不是"永久禁用"）。
              ...(typeof g.tier === 'string' && g.tier !== '' ? { tier: g.tier } : {}),
              rows: g.tools.map((tool) => ({
                tool,
                cells: mx.kinds.map((k) => {
                  const why = mod.verdictFor(tool, k.id);
                  return why === undefined
                    ? { kind: k.id, allowed: true }
                    : { kind: k.id, allowed: false, reason: why };
                }),
              })),
            }));
            sendJson({ ok: true, kinds: mx.kinds, groups: table });
          } catch (error) {
            // 拿不到守卫模块（profile 未装 bundle / 路径解析失败）⇒ 如实报错，不编一份假表格
            sendJson({ ok: false, error: `读权能矩阵失败：${error?.message ?? error}` });
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/whitelist') {
          sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/whitelist') {
          const body = await readBody();
          const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
          const file = readConfigObject(configFile);
          const allow = {
            private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
            groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
          };
          const deny = {
            private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
            groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
          };
          // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
          let ownerQQ = cfg.ownerQQ ?? null;
          if (body.ownerQQ !== undefined) {
            try {
              ownerQQ = normalizeOwnerQQ(body.ownerQQ);
            } catch (error) {
              sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
              return;
            }
          }
          file.allow = allow;
          file.deny = deny;
          file.ownerQQ = ownerQQ;
          atomicWriteJson(configFile, file);
          cfg.allow = { private: allow.private, groups: allow.groups };
          cfg.deny = { private: deny.private, groups: deny.groups };
          cfg.ownerQQ = ownerQQ;
          reconcileSessionPolicies();
          log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
          sendJson({ ok: true, allow, deny, ownerQQ });
          return;
        }

        // ── DSH 模型与思考强度 ───────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/dsh/model') {
          const provider = String(cfg.dsh?.provider || 'deepseek-official');
          const model = String(cfg.dsh?.model || 'deepseek-flash');
          // 档位优先取 DSH 实际公布的能力（DSH 换档位词汇或换 provider 时自动跟随），失败退回内置白名单。
          let options = REASONING_EFFORT_OPTIONS.slice();
          let labels = {};
          let providerDefault = null;
          let catalogSource = 'fallback';
          let catalogForUi = null;   // 目录原样存一份，供 provider/model 下拉导出
          try {
            if (!modelCatalogInFlight) {
              modelCatalogInFlight = withTimeout(fetchModelCatalog(), 3000, 'session/modelCatalog')
                .finally(() => { modelCatalogInFlight = null; });
            }
            const catalog = unwrap(await modelCatalogInFlight, 'session.modelCatalog');
            catalogForUi = catalog;
            const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
            const entry = (group?.models ?? []).find((m) => m?.id === model);
            const efforts = entry?.reasoning?.efforts ?? [];
            const advertised = efforts.map((e) => String(e?.id ?? '')).filter((id) => REASONING_EFFORT_OPTIONS.includes(id));
            if (advertised.length) {
              options = advertised;
              labels = Object.fromEntries(efforts.map((e) => [String(e.id), { name: e.name ?? '', description: e.description ?? '' }]));
              providerDefault = entry.reasoning.defaultEffort ?? null;
              catalogSource = 'dsh';
            }
          } catch (error) {
            // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
            const reason = String(error?.message ?? error);
            if (!modelCatalogErrorLogged.has(reason)) {
              modelCatalogErrorLogged.add(reason);
              log(`读取 DSH 模型能力失败，思考强度暂用内置清单：${reason}`);
            }
          }
          sendJson({
            provider,
            model,
            reasoningEffort: String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT),
            options,
            labels,
            default: REASONING_EFFORT_DEFAULT,
            providerDefault,
            catalogSource,
            // provider / model 下拉列表：由模型目录（catalog）导出，供控制台做"默认新对话模型"编辑。
            // 结构 [{ id, label, models:[{id,label}] }]；目录拉不到时用当前值兜底（至少能显示现用的）。
            providers: (catalogForUi?.groups ?? []).map((g) => ({
              id: g?.id,
              label: g?.name ?? g?.id,
              models: (g?.models ?? []).map((m) => ({ id: m?.id, label: m?.name ?? m?.id }))
            })),
            // selectModel 会同时写会话级与 DSH 全局默认（~/.dsh/settings.yaml 的 agent-default-model），
            // 控制台要把这点明确告诉管理员，避免「只想调 QQ 助手却改了 Web GUI 新会话默认」的意外。
            globalSideEffect: true,
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/dsh/model') {
          const body = await readBody();
          const provider = String(body.provider ?? '').trim();
          const model = String(body.model ?? '').trim();
          if (!provider || !model) {
            sendJson({ ok: false, error: 'provider 和 model 都不能为空' }, 400);
            return;
          }
          // 校验这个 provider/model 组合真实存在（避免再次填成坏模型，重演 CodeBuddy 那次）。
          let valid = false;
          try {
            if (!modelCatalogInFlight) {
              modelCatalogInFlight = withTimeout(fetchModelCatalog(), 3000, 'session/modelCatalog')
                .finally(() => { modelCatalogInFlight = null; });
            }
            const catalog = unwrap(await modelCatalogInFlight, 'session.modelCatalog');
            const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
            const entry = (group?.models ?? []).find((m) => m?.id === model);
            valid = Boolean(entry);
          } catch (error) {
            // 目录拉不到不阻断保存：管理员可能离线配置，信任他填的值（但要记日志）。
            log(`保存模型时校验目录失败（放行）：${error?.message ?? error}`);
            valid = true;
          }
          if (!valid) {
            sendJson({ ok: false, error: `DSH 模型目录里没有 ${provider}/${model}，请确认提供方与模型名拼写` }, 400);
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          file.dsh = { ...(file.dsh ?? {}), provider, model };
          atomicWriteJson(configFile, file);
          cfg.dsh = { ...(cfg.dsh ?? {}), provider, model };
          // 递增代号：新建会话会用新默认；已存在的会话继续跟随它们各自的选择。
          modelSelectionEpoch += 1;
          log(`控制台：DSH 默认模型已设为 ${provider}/${model}（只影响新会话）`);
          sendJson({ ok: true, provider, model });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/dsh/effort') {
          const body = await readBody();
          let effort;
          try { effort = normalizeReasoningEffort(body.reasoningEffort); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return; }
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置损坏时直接 500，绝不回写（与白名单接口同语义）
          const file = readConfigObject(configFile);
          file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
          atomicWriteJson(configFile, file);
          cfg.dsh = { ...(cfg.dsh ?? {}), reasoningEffort: effort };
          // 递增代号：已在运行的会话在下一条消息会重新 selectModel（无需重启桥接或 DSH）
          modelSelectionEpoch += 1;
          log(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
          sendJson({ ok: true, reasoningEffort: effort });
          return;
        }

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/security') {
          sendJson({
            security: cfg.security ?? { interceptNotify: true },
            // state/ 的 ACL 收紧结果：Windows 上改 ACL 需要管理员权限，未提权时会失败。
            // 控制台据此显示警告与可复制的命令（而不是让用户以为已经安全）。
            // 命令必须取自 state-acl 的**安全**版本：把 (OI)(CI) 授权和 /T 混在一句里
            // 会把子文件 DACL 清空，用户照抄就会把自己的 state/ 弄坏。
            stateDir: {
              hardened: stateDirHardened,
              path: STATE_DIR,
              manualCommand: process.platform === 'win32'
                ? manualDirCommand(STATE_DIR)
                : `chmod 700 "${STATE_DIR}"`
            }
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/security') {
          const body = await readBody();
          // 支持从控制台**重试**收紧 state/ 权限（用户在管理员终端里配好了权限/换了启动方式后）。
          if (body.rehardenStateDir === true) {
            stateDirHardened = null;
            hardenStateDirAcl();
            sendJson({ ok: stateDirHardened === true, hardened: stateDirHardened, path: STATE_DIR });
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          const next = { ...(file.security ?? {}), ...body };
          if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
          else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
          file.security = next;
          atomicWriteJson(configFile, file);
          cfg.security = { ...(cfg.security ?? {}), ...next };
          log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
          sendJson({ ok: true, security: cfg.security });
          return;
        }
        // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/token') {
          const body = await readBody();
          let newToken = String(body.token ?? '').trim();
          const generated = !newToken;
          if (generated) {
            newToken = crypto.randomBytes(24).toString('hex');
          }
          if (newToken.length < 16) {
            sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
            return;
          }
          if (newToken.length > 128) {
            sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
            return;
          }
          if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
            sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
          file.consoleToken = generated ? '' : newToken;
          atomicWriteJson(configFile, file);
          cfg.consoleToken = generated ? '' : newToken;
          atomicWriteText(path.join(STATE_DIR, 'console-token'), newToken);
          consoleToken = newToken;
          log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
          sendJson({ ok: true, token: newToken, generated });
          return;
        }
        // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/test-send') {
          const body = await readBody();
          const kind = body.kind === 'private' ? 'private' : 'group';
          const id = Number(body.id);
          const message = String(body.message ?? '').trim();
          if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
          if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return; }
          if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, currentMode)) { sendJson({ ok: false, error: `当前模式（${currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return; }
          try {
            const safeMessage = escapeCqText(redactKnownTokensOnly(message));
            const result = kind === 'private'
              ? await bot.sendPrivateMessage(id, text(safeMessage))
              : await bot.sendGroupMessage(id, text(safeMessage));
            log(`控制台：测试发送 ${kind}:${id} 成功`);
            sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
          } catch (error) {
            sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/state') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const phase = body.phase;
          if (phase === 'active') {
            // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
            enterActive(key);
            log(`控制台：手动将 ${key} 设为活跃`);
            sendJson({ ok: true, key, phase: 'active' });
          } else if (phase === 'idle') {
            leaveActive(key);
            log(`控制台：手动将 ${key} 设为观望`);
            sendJson({ ok: true, key, phase: 'idle' });
          } else {
            sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
          }
          return;
        }
        // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/social') {
          const stats = {};
          for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
          const states = {};
          const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
          for (const k of keys) {
            const st = social.states.get(k);
            states[k] = { phase: st?.phase ?? 'idle' };
          }
          sendJson({ config: cfg.social, pendingSummaries: stats, states });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
          const file = readConfigObject(configFile);
          const merged = { ...(file.social ?? {}), ...body };
          // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
          for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
            delete merged[k];
          }
          for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) {
              const n = Number(merged[k]);
              if (Number.isFinite(n) && n >= 0) merged[k] = n;
            }
          }
          // 分条间隔 clamp 到非负
          for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
          }
          // 概率字段 clamp 到 0~1
          for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
            if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
          }
          // contextWindow 限制 1~100
          if (merged.contextWindow !== undefined) {
            merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
          }
          // 布尔字段
          for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
            if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
          }
          // 范围字段保证 min <= max
          for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
            if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
              [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
            }
          }
          if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
          file.social = merged;
          atomicWriteJson(configFile, file);
          cfg.social = { ...cfg.social, ...merged };
          log('控制台：社交配置已更新');
          sendJson({ ok: true, config: cfg.social });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/flush') {
          const body = await readBody();
          await flushSummaries(body.key || null);
          sendJson({ ok: true });
          return;
        }
        // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const message = String(body.message ?? '').trim();
          if (!key || !message) {
            sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0) {
            sendJson({ ok: false, error: 'id 无效' }, 400);
            return;
          }
          if (!modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: `该会话不在当前模式（${currentMode}）允许范围内` }, 403);
            return;
          }
          if (!state.sessions[key] && !allowed(kind, id, cfg)) {
            sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
            return;
          }
          if (!dshReady) {
            sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
            return;
          }
          const isV2 = currentMode === 'reserved2';
          const roleState = readRoleState();
          const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
          // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
          let tokenLine = '';
          if (isV2) {
            const stV2 = getSocialV2State(key);
            tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
          }
          const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
          let sessionId = null;
          let popSilent = null;
          try {
            sessionId = await ensureSession(key);
            const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            const arr = social.silentTurns.get(sessionId) ?? [];
            social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
            popSilent = () => {
              const list = social.silentTurns.get(sessionId) ?? [];
              const next = list.filter((x) => x.id !== silentId);
              if (next.length > 0) social.silentTurns.set(sessionId, next);
              else social.silentTurns.delete(sessionId);
            };
            const result = await deliverPrompt(key, promptText, { silent: true });
            if (result.ok) {
              log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
              appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
              sendJson({ ok: true, key, sessionId });
            } else {
              popSilent();
              sendJson({ ok: false, error: result.error || '投递失败' }, 500);
            }
          } catch (error) {
            if (popSilent) popSilent();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 二代仿真模式（reserved2）内部 Agent API ─────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {
          sendJson({ ok: true, config: cfg.socialV2 ?? {} });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          // current 必须是「当前**生效**的 socialV2」，而不是文件里恰好写着的那一份。
          //
          // config.json 里没有 socialV2 段（或该段不是普通对象）时，旧写法 current={} 会让下面所有
          // `current.xxx ?? 默认` 的兜底全部落空，并把只剩本次提交字段的段落盘。最危险的一处是工具开关
          // 归一化：`typeof merged.tools[k] !== 'boolean'` 时写的是 `current.tools?.[k] !== false` ——
          // current 为空 → undefined !== false → true，于是**一次控制台保存就把默认关闭的
          // setStickerRemark / sendVoice 静默打开**（它们默认 false 是有意的：一个是风险操作，
          // 一个是需要先准备语音库的强表达）。cfg.socialV2 是「文件 + 默认值」深度合并后的运行时配置，
          // 用它兜底才和真正生效的设置一致（也就不会再出现"文件里没有 → 保存一次就变了"）。
          const fileV2 = (file.socialV2 && typeof file.socialV2 === 'object' && !Array.isArray(file.socialV2))
            ? file.socialV2
            : null;
          const current = fileV2 ?? ((cfg.socialV2 && typeof cfg.socialV2 === 'object') ? cfg.socialV2 : {});
          const merged = { ...current, ...body };
          // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
          // 注意：新增顶层子对象时**必须**加进这个数组（例如 asr），否则控制台保存一次
          // 就能把它覆盖成 null/数组/基本类型，里面的设置静默失效。
          for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context', 'diary', 'asr', 'voice', 'tts', 'media', 'file']) {
            if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
              merged[sub] = current[sub] ?? {};
            }
          }
          if (merged.autoReplyCheckMs !== undefined) {
            const n = Number(merged.autoReplyCheckMs);
            merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
          }
          // tools：只接受布尔开关
          // ⚠️ 这个名单是控制台开关能不能存下来的唯一依据（scripts/test-extra-console.mjs 双向对账：分组表里的开关名必须在这里，这里的每个必须被分组表归类）。
          // 生图（2026-10-29）只登记一个 `drawImage` —— 控制台那张分组表里它一个开关盖住
          // qq_draw_image + qq_send_image 两个工具；`sendImage` 是内部细分键，不上界面。
          const toolFlags = ['getPrompt', 'getUnread', 'getRecent', 'socialState', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers', 'setWakeConfig', 'markRead', 'memory', 'slangQuery', 'slangSubmit', 'getImages', 'getForwardMsg', 'sendPoke', 'listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'sendQzone', 'getQzone', 'qzoneFeeds', 'qzoneLike', 'qzoneUnlike', 'qzoneComment', 'qzoneDelete', 'qzoneSetRight', 'getAccount', 'requestPermission', 'promise', 'call', 'localExec', 'sendVoice', 'speak', 'writeDiary', 'readDiary', 'listPhotos', 'getPhotoImage', 'sendPhoto', 'photoNote', 'sendFile', 'drawImage'];
          if (body.tools && typeof body.tools === 'object') {
            merged.tools = { ...(current.tools ?? {}), ...body.tools };
            for (const k of toolFlags) {
              if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
            }
          }
          // wake：数值与字符串数组归一化
          if (body.wake && typeof body.wake === 'object') {
            merged.wake = { ...(current.wake ?? {}), ...body.wake };
            for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {
              if (merged.wake[k] !== undefined) {
                const n = Number(merged.wake[k]);
                merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
                // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
              }
            }
            if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
            if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
            if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
            if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
            if (merged.wake.recommendedKeywords !== undefined) {
              merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
            }
            if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
            if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
          }
          // send：数值归一化
          if (body.send && typeof body.send === 'object') {
            merged.send = { ...(current.send ?? {}), ...body.send };
            for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
              if (merged.send[k] !== undefined) {
                const n = Number(merged.send[k]);
                merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
                // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
                if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
              }
            }
            if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
            if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
            if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
          }
          // wait：数值归一化
          if (body.wait && typeof body.wait === 'object') {
            merged.wait = { ...(current.wait ?? {}), ...body.wait };
            for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
              if (merged.wait[k] !== undefined) {
                const n = Number(merged.wait[k]);
                merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
              }
            }
          }
          // proactive：主动机会参数
          if (body.proactive && typeof body.proactive === 'object') {
            merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
            for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
              if (merged.proactive[k] !== undefined) {
                const n = Number(merged.proactive[k]);
                merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
                // 毫秒类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
              }
            }
            if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
            if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
          }
          // sticker：表情包体系参数归一化
          if (body.sticker && typeof body.sticker === 'object') {
            merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
            if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
            for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
              if (merged.sticker[k] !== undefined) {
                const n = Number(merged.sticker[k]);
                merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
              }
            }
            if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
            if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
            if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
            if (body.sticker.collect && typeof body.sticker.collect === 'object') {
              merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
              if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
              for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
                if (merged.sticker.collect[k] !== undefined) {
                  const n = Number(merged.sticker.collect[k]);
                  merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
                }
              }
            }
          }
          // photo：群图媒体库参数归一化
          // ⚠️ 不要按顶层 name 浅合并就完事：tools 之类的字段在 body.photo 里是有意不传的，
          //   这里只归一化它自己的那几个数/布尔 + collect 子对象。
          if (body.photo && typeof body.photo === 'object') {
            merged.photo = { ...(current.photo ?? {}), ...body.photo };
            if (merged.photo.enabled !== undefined) merged.photo.enabled = merged.photo.enabled === true;
            if (merged.photo.includeInPrompt !== undefined) merged.photo.includeInPrompt = merged.photo.includeInPrompt === true;
            if (merged.photo.dir !== undefined) merged.photo.dir = String(merged.photo.dir ?? '').trim();
            for (const k of ['promptMaxPhotos', 'maxListCount', 'maxCandidates', 'trashMaxItems']) {
              if (merged.photo[k] !== undefined) {
                const n = Number(merged.photo[k]);
                merged.photo[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.photo?.[k] ?? 0;
              }
            }
            if (merged.photo.maxListCount !== undefined) merged.photo.maxListCount = Math.min(500, Math.max(1, merged.photo.maxListCount));
            if (merged.photo.promptMaxPhotos !== undefined) merged.photo.promptMaxPhotos = Math.min(30, Math.max(1, merged.photo.promptMaxPhotos));
            if (body.photo.collect && typeof body.photo.collect === 'object') {
              merged.photo.collect = { ...(current.photo?.collect ?? {}), ...body.photo.collect };
              if (merged.photo.collect.enabled !== undefined) merged.photo.collect.enabled = merged.photo.collect.enabled === true;
              for (const k of ['maxPerMessage', 'maxPerMinute', 'maxPerHour']) {
                if (merged.photo.collect[k] !== undefined) {
                  const n = Number(merged.photo.collect[k]);
                  merged.photo.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.photo?.collect?.[k] ?? 0;
                }
              }
              if (merged.photo.collect.maxPerMessage !== undefined) {
                merged.photo.collect.maxPerMessage = Math.min(9, Math.max(1, merged.photo.collect.maxPerMessage));
              }
            }
          }
          // voice / tts：语音开关。**必须深度合并**。
          //
          // ⚠️ 2026-10-20 真事故：这两个子对象原先不在归一化名单里，控制台只传
          //    `{ voice: { enabled: false } }` 时，`merged = { ...current, ...body }`
          //    会把整个 voice 段替换成只剩 `enabled` —— dir / maxSeconds /
          //    maxPerMinute / maxPerHour / maxBytes / ffmpegPath 全被写丢，
          //    下一次启动时语音上限退化成代码默认值（2 条/分钟），
          //    而且 `dir` 丢了之后语音库路径也跟着回默认。
          //    这个坏处**不会立刻报错**：功能看起来还在，只是悄悄变差。
          if (body.voice && typeof body.voice === 'object') {
            merged.voice = { ...(current.voice ?? {}), ...body.voice };
            if (merged.voice.enabled !== undefined) merged.voice.enabled = merged.voice.enabled === true;
            if (merged.voice.autoReadback !== undefined) merged.voice.autoReadback = merged.voice.autoReadback === true;
            if (merged.voice.allowAbsolutePath !== undefined) merged.voice.allowAbsolutePath = merged.voice.allowAbsolutePath === true;
            if (merged.voice.dir !== undefined) merged.voice.dir = String(merged.voice.dir ?? '').trim() || 'audio';
            if (merged.voice.loudness !== undefined) {
              merged.voice.loudness = ['off', 'quiet', 'normal', 'loud'].includes(merged.voice.loudness) ? merged.voice.loudness : 'normal';
            }
            if (merged.voice.ffmpegPath !== undefined) merged.voice.ffmpegPath = String(merged.voice.ffmpegPath ?? '').trim();
            for (const k of ['maxSeconds', 'maxBytes', 'maxPerMinute', 'maxPerHour']) {
              if (merged.voice[k] !== undefined) {
                const n = Number(merged.voice[k]);
                merged.voice[k] = Number.isFinite(n) && n >= 0 ? Math.round(n) : (current.voice?.[k] ?? 0);
              }
            }
            if (merged.voice.defaultVolume !== undefined) {
              const v = Number(merged.voice.defaultVolume);
              merged.voice.defaultVolume = Number.isFinite(v) && v > 0 ? v : 1;
            }
          }
          if (body.tts && typeof body.tts === 'object') {
            merged.tts = { ...(current.tts ?? {}), ...body.tts };
            if (merged.tts.enabled !== undefined) merged.tts.enabled = merged.tts.enabled === true;
            if (merged.tts.prewarm !== undefined) merged.tts.prewarm = merged.tts.prewarm === true;
            if (merged.tts.engine !== undefined) {
              merged.tts.engine = String(merged.tts.engine ?? '').toLowerCase() === 'sapi' ? 'sapi' : 'edge';
            }
            for (const k of ['voice', 'rate', 'volume', 'pitch', 'toolsDir', 'workerPath', 'pythonPath', 'spoolDir']) {
              if (merged.tts[k] !== undefined) merged.tts[k] = String(merged.tts[k] ?? '');
            }
            for (const k of ['maxChars', 'timeoutMs', 'loadTimeoutMs']) {
              if (merged.tts[k] !== undefined) {
                const n = Number(merged.tts[k]);
                merged.tts[k] = Number.isFinite(n) && n > 0 ? Math.round(n) : (current.tts?.[k] ?? 0);
              }
            }
          }
          // file：发文件的设置归一化（与 voice/tts 同一套写法 —— 逐字段校验，
          // 因为这一段控制"能不能往本机下载东西、能下多大"，不能被前端塞进非布尔/负数）。
          if (body.file && typeof body.file === 'object') {
            merged.file = { ...(current.file ?? {}), ...body.file };
            if (merged.file.enabled !== undefined) merged.file.enabled = merged.file.enabled === true;
            if (merged.file.allowLocalPath !== undefined) merged.file.allowLocalPath = merged.file.allowLocalPath === true;
            if (merged.file.allowedDirOnly !== undefined) merged.file.allowedDirOnly = merged.file.allowedDirOnly === true;
            if (merged.file.dir !== undefined) merged.file.dir = String(merged.file.dir ?? '').trim() || '../小鲸鱼下载';
            for (const k of ['maxBytes', 'maxPerHour']) {
              if (merged.file[k] !== undefined) {
                const n = Number(merged.file[k]);
                merged.file[k] = Number.isFinite(n) && n > 0 ? Math.round(n) : (current.file?.[k] ?? 0);
              }
            }
          }
          // feedback：数值/布尔归一化
          if (body.feedback && typeof body.feedback === 'object') {
            merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
            if (merged.feedback.maxLength !== undefined) {
              const n = Number(merged.feedback.maxLength);
              merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
            }
            if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
          }
          // context：数值归一化
          if (body.context && typeof body.context === 'object') {
            merged.context = { ...(current.context ?? {}), ...body.context };
            for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
              if (merged.context[k] !== undefined) {
                const n = Number(merged.context[k]);
                merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
              }
            }
            for (const [name, fallback, min, max] of [['wakeMessageLimit', 12, 1, 100], ['wakeRecentLimit', 4, 0, 20], ['wakeMaxChars', 6000, 500, 20000]]) {
              const n = Number(merged.context[name] ?? fallback);
              merged.context[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
            }
            if (merged.context.inlineWakeMessages !== undefined) merged.context.inlineWakeMessages = merged.context.inlineWakeMessages === true;
          }
          if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
          if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
          file.socialV2 = merged;
          atomicWriteJson(configFile, file);
          cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
          // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
          // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
          const WAKE_DEFAULT_KEYS = [
            'defaultMode', 'recommendedDefaultInfinite',
            'recommendedSleepMinMs', 'recommendedSleepMaxMs',
            'recommendedProbability', 'recommendedKeywords',
            'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
            'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
          ];
          const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
            WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
          if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2();
          log('控制台：二代仿真配置已更新');
          sendJson({ ok: true, config: cfg.socialV2 });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/activity') {
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/activity') {
          const body = await readBody();
          const paused = body.paused === true;
          socialV2.paused = paused;
          if (paused) {
            clearAllSocialV2Timers();
            log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
          } else {
            log('控制台：二代 AI 已恢复');
            for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          }
          saveSocialV2State();
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/reset') {
          sessionEpoch++;
          sessionPromises.clear();
          clearAllSocialV2Timers();
          drainAllPromptQueues('二代状态已重置');
          for (const key of [...socialV2.conversations.keys()]) {
            const sid = state.sessions[key];
            if (sid) {
              delete state.sessions[key];
              // 与 retireSession / session-reset / workspace-reset 一致：先让 DSH 停下这个会话的活。
              // 少了这一步，DSH 会继续跑完在途/排队的 turn（token 照烧、副作用照做），
              // 而桥接这边已经把所有映射删掉 —— 输出被静默丢弃，agentToken 也已轮换（它的 MCP 发送全部 403）。
              stopRetiredSessionWork(sid, key);
              sessionModels.delete(sid);
              modelAppliedSessions.delete(sid);
              reverse.delete(sid);
              collectors.delete(sid);
              v2TurnStartAt.delete(sid);
              v2TurnLastEventAt.delete(sid);
              toolCallNames.delete(sid);
              pendingSendToolCalls.delete(sid);
              sendToolSucceededSessions.delete(sid);
              // 订阅也要退掉，否则它会在每次重连时被重新 follow 并重发整份快照。
              api.events.forget?.(sid);
            }
            delete state.sessionPolicies[key];
            forgetAgentToken(key);
            socialV2.conversations.delete(key);
            seenForwardIds.delete(key);
          }
          saveState();
          pendingWakeKeys.clear();
          clearAllPendingWakeLeases();
          wakeConfigUpdatedKeys.clear();
          markReadCalledKeys.clear();
          wakeConfigMissCount.clear();
          socialV2.paused = false;
          try { atomicWriteJson(SOCIAL_V2_FILE, { conversations: {} }); } catch (error) { log('重置二代状态：写空状态文件失败:', error?.message ?? error); }
          log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('socialState')) { sendJson(disabledByOwner('qq_social_state', 'socialState'), 403); return; }
          const st = getSocialV2State(key);
          sendJson({
            ok: true,
            key,
            wakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt,
            // 约定也在状态里给出来：专项控制台要显示"她答应了什么、什么时候"，
            // 而这条信息本来就属于这个会话的状态，再单独开一个端点只会多一处漂移点。
            promises: (st.promises ?? []).filter((p) => p && !p.doneAt).map((p) => ({
              id: p.id,
              kind: p.kind,
              at: p.at,
              text: p.text ?? '',
              createdAt: p.createdAt ?? 0,
              firedAt: p.firedAt ?? 0
            }))
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getPrompt')) { sendJson(disabledByOwner('qq_get_prompt', 'getPrompt'), 403); return; }
          const st = getSocialV2State(key);
          // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
          if (cfg.socialV2?.sticker?.enabled !== false) {
            try { await syncStickerLibrary(false); } catch {}
          }
          const roleState = readRoleState();
          const toolMap = {
            getPrompt: 'qq_get_prompt',
            getUnread: 'qq_get_unread_messages',
            getRecent: 'qq_get_recent_messages',
            socialState: 'qq_social_state',
            sendGroup: 'qq_send_group_message',
            sendPrivate: 'qq_send_private_message',
            reply: 'qq_reply',
            sendBurst: 'qq_send_burst',
            sendMessage: 'qq_send_message',
            waitMessages: 'qq_wait_for_messages',
            feedback: 'qq_report_feedback',
            getMyRecent: 'qq_get_my_recent_messages',
            getMessageDetail: 'qq_get_message_detail',
            getActiveMembers: 'qq_get_active_members',
            setWakeConfig: 'qq_set_wake_config',
            markRead: 'qq_mark_read',
            memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
            slangQuery: 'qq_slang_query',
            slangSubmit: 'qq_slang_submit',
            getImages: 'qq_get_message_images',
            getForwardMsg: 'qq_get_forward_msg',
            sendPoke: 'qq_send_poke',
            listStickers: 'qq_list_stickers',
            getStickerImage: 'qq_get_sticker_image',
            sendSticker: 'qq_send_sticker',
            setStickerRemark: 'qq_set_sticker_remark',
            stickerNote: 'qq_sticker_note',
            collectSticker: 'qq_collect_sticker',
            // 群图库工具（与收藏表情是两套，工具名也不同）
            listPhotos: 'qq_photo_list',
            getPhotoImage: 'qq_get_photo_image',
            sendPhoto: 'qq_send_photo',
            photoNote: 'qq_photo_note',
            sendQzone: 'qq_send_qzone_msg',
            getQzone: 'qq_get_qzone_list',
            qzoneFeeds: 'qq_get_qzone_feeds',
            qzoneLike: 'qq_qzone_like',
            qzoneComment: 'qq_qzone_comment',
            qzoneDelete: 'qq_qzone_delete',
            qzoneSetRight: 'qq_qzone_set_right',
            getAccount: 'qq_get_account_info',
            sendVoice: 'qq_send_voice / qq_list_voices',
            // 语音合成只有一个工具了（2026-10-20 由 qq_say + qq_speak 合并）。
            speak: 'qq_say',
            writeDiary: 'qq_write_diary',
            readDiary: 'qq_read_diary',
            // 发文件（只对管理员私聊开放，见 /api/socialV2/send-file 的三道闸）
            sendFile: 'qq_send_file',
            // 生图（2026-10-29）：走本机「生图工作室」插件，画完直接发进会话。
            // 管理员私聊 + 群聊能用（见 drawImageAllowed）；成本靠 drawQuotaOf 的日额度管。
            drawImage: 'qq_draw_image',
            sendImage: 'qq_send_image'
          };
          const tools = cfg.socialV2?.tools ?? {};
          const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
          const enabledTools = [];
          for (const [flag, name] of Object.entries(toolMap)) {
            if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickerEnabled())) enabledTools.push(name);
          }
          sendJson({
            ok: true,
            key,
            time: new Date().toISOString(),
            role: { name: roleState.role ?? null, hint: currentMode === 'reserved2' ? currentRoleHintV2() : currentRoleHint() },
            recommended: cfg.socialV2?.provideRecommendations === false ? null : {
              wake: cfg.socialV2?.wake ?? {},
              send: cfg.socialV2?.send ?? {},
              wait: cfg.socialV2?.wait ?? {},
              proactive: cfg.socialV2?.proactive ?? {}
            },
            enabledTools,
            replyTiming: replyTimingV2(st),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            currentWakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            memory: formatMemoryV2(st),
            participation: formatParticipationV2(st),
            slang: {
              enabled: cfg.slang?.enabled !== false,
              entries: confirmedSlangListV2(),
              block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8)
            },
            stickers: {
              enabled: cfg.socialV2?.sticker?.enabled !== false,
              total: stickerEntries.length,
              context: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext(stickerEntries, cfg.socialV2?.sticker?.promptMaxStickers ?? 8) : '',
              strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : ''
            },
            // 群图库摘要：与 stickers 分开两块，因为它们用**不同的工具**发
            // （stickers → qq_send_sticker；photos → qq_send_photo）。混在一起描述
            // 会让模型拿错工具，导致"发不出去"这种很难查的失败。
            photos: {
              enabled: photoEnabled(),
              collectEnabled: photoCollectEnabled(),
              total: mediaLib ? mediaLib.size() : 0,
              stats: mediaLib ? mediaLib.stats() : null,
              sharp: sharpAvailable(),
              context: mediaLib && cfg.socialV2?.photo?.includeInPrompt !== false
                ? buildPhotoContext(mediaLib, cfg.socialV2?.photo?.promptMaxPhotos ?? 6, key)
                : ''
            },
            // 语音库摘要：让 AI 一开始就知道有哪些语音可发（真发之前用 qq_list_voices 看详情）。
            voices: cfg.socialV2?.voice?.enabled === false ? { enabled: false } : {
              enabled: true,
              total: voiceLibrary().length,
              names: voiceLibrary().slice(0, 12).map((v) => v.name),
              maxSeconds: voiceCfg().maxSeconds,
              hint: '可用 qq_list_voices 查看语音库，再用 qq_send_voice 把其中一个当语音发出去'
            }
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getUnread')) { sendJson(disabledByOwner('qq_get_unread_messages', 'getUnread'), 403); return; }
          const afterRaw = url.searchParams.get('afterSeq');
          const afterSeq = afterRaw === null ? null : Number(afterRaw);
          if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
            sendJson({ ok: false, error: 'afterSeq 必须是非负安全整数；从最早未读开始请传 0' }, 400);
            return;
          }
          const st = getSocialV2State(key);
          // Preserve the old tail read by default; cursor paging lets a backlog
          // larger than one response be read completely, even outside recent.
          const messages = afterSeq === null ? st.unread.slice(-limit)
            : st.unread.filter((m) => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          sendJson({ ok: true, key, unreadCount: st.unread.length, messages, readThroughSeq });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getRecent')) { sendJson(disabledByOwner('qq_get_recent_messages', 'getRecent'), 403); return; }
          const st = getSocialV2State(key);
          const start = Math.max(0, st.recentMessages.length - offset - limit);
          const end = Math.max(0, st.recentMessages.length - offset);
          const messages = st.recentMessages.slice(start, end);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          sendJson({ ok: true, key, messages, readThroughSeq });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('markRead')) { sendJson(disabledByOwner('qq_mark_read', 'markRead'), 403); return; }
          const st = getSocialV2State(key);
          const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // 如果当前已经是“潜水”唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
          // 必须先等够沉睡前观察窗口，避免“聊两句又去潜水”。
          // ⚠️ 这个声明一度被我搬代码时误删，导致 mark-read 报 "preSleepMs is not defined" → 500。
          //    它必须在这里：下面那段的 remaining / error 文案 / 返回体都用到它。
          const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
          if (isSleepingConfigV2(st.wakeConfig) && preSleepWaitBlockedV2(st)) {
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          const markedCount = acknowledgeMessagesV2(st, throughSeq);
          st.lastActionAt = Date.now();
          st.wakeConfig.noActionCount = 0;
          // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
          if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
            st.wakeConfig.infinite = true;
          }
          ensureWakeableV2(st, { key });
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'mark_read';
          markReadCalledKeys.add(key);
          saveSocialV2State();
          log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeGuaranteed: computeWakeSafetyV2(st.wakeConfig).guaranteed, wakeSafety: computeWakeSafetyV2(st.wakeConfig), wakeConfig: st.wakeConfig });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setWakeConfig')) { sendJson(disabledByOwner('qq_set_wake_config', 'setWakeConfig'), 403); return; }
          const st = getSocialV2State(key);
          const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // Preserve the deployed behavior: with markRead disabled, update wake configuration only.
          const acknowledgeOnClose = throughSeq !== null && v2ToolEnabled('markRead');
          const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
          const current = st.wakeConfig;
          const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
          const normalizeTriggerBool = (name, fallback) => {
            if (name in inputTriggers) return inputTriggers[name] === true;
            return fallback;
          };
          const rawKeywords = inputTriggers.keywords;
          const nextKeywords = rawKeywords !== undefined
            ? (Array.isArray(rawKeywords)
                ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
                : [])
            : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
          const next = {
            ...current,
            mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
            infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
            sleepUntil: current.sleepUntil,
            triggers: {
              ...current.triggers,
              ...inputTriggers,
              atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
              nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
              question: normalizeTriggerBool('question', current.triggers.question === true),
              anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
              poke: normalizeTriggerBool('poke', current.triggers.poke === true),
              keywords: nextKeywords
            },
            batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
              ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
              : current.batchWindowMs
          };
          // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
          if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
            next.triggers.anyMessage = false;
          }
          if (next.mode === 'active') {
            next.infinite = true;
            next.sleepUntil = null;
            next.triggers.anyMessage = true;
          }
          if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
          if (next.infinite) {
            next.sleepUntil = null;
          } else if (input.sleepUntil) {
            const d = new Date(String(input.sleepUntil));
            if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
          } else if (Number.isFinite(Number(input.sleepMs))) {
            let ms = Math.max(0, Math.round(Number(input.sleepMs)));
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            if (ms < minMs) ms = minMs;
            if (maxMs > 0 && ms > maxMs) ms = maxMs;
            next.sleepUntil = new Date(Date.now() + ms).toISOString();
          } else if (!next.sleepUntil && !next.infinite) {
            // 既没有无限也没有时间：使用推荐默认有限时长
            const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
            const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
            const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
            next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
          }
          // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
          if (!next.infinite && next.sleepUntil) {
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            let until = Date.parse(next.sleepUntil);
            if (Number.isFinite(until)) {
              if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
              if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
              next.sleepUntil = new Date(until).toISOString();
            }
          }
          // 归一化概率
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
          }
          // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
          if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
            next.triggers.poke = input.triggers.poke === true;
          }
          // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
          // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
          next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
          // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
          if (key.startsWith('private:')) {
            next.triggers.speakerIds = [];
          }
          // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
          if (next.infinite) {
            const tr = next.triggers ?? {};
            const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
            if (!hasTrigger) {
              sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
              return;
            }
          }
          // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
          if (isSleepingConfigV2(next) && preSleepWaitBlockedV2(st)) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          const markedCount = acknowledgeOnClose ? acknowledgeMessagesV2(st, throughSeq) : 0;
          st.wakeConfig = next;
          st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
          st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
          st.wakeConfig.noActionCount = 0;
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'set_wake_config';
          st.lastActionAt = Date.now();
          // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSocialV2State();
          wakeConfigUpdatedKeys.add(key);
          wakeConfigMissCount.delete(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
          setupSleepTimerV2(key);
          log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeConfig: next, wakeSafety: computeWakeSafetyV2(next) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
          const list = [];
          for (const [key, st] of socialV2.conversations) {
            list.push({
              key,
              wakeConfig: st.wakeConfig,
              unreadCount: st.unread.length,
              recentCount: st.recentMessages.length,
              lastWakeReason: st.lastWakeReason,
              lastAiReplyAt: st.lastAiReplyAt,
              noActionCount: st.wakeConfig.noActionCount || 0
            });
          }
          sendJson({ ok: true, conversations: list });
          return;
        }
        // ── 向我申请（手机 / 刷B站）────────────────────────────────────────────
        //
        // 为什么入口在桥接、判定在守卫：这些工具是 DSH 直接挂的 MCP server，根本不经过
        // 桥接。桥接能做的是「把这个申请变成一条他看得见的 QQ 消息，并在他说同意时
        // 往 state/permits.json 写一条**带到期时间**的授权」；真正卡住执行的是
        // plugins/qq-agent-presets/qq-tool-restrict.mjs —— 它读同一个文件。
        // 所以这里即使被绕过（比如有人手改文件），最坏也只是把工具放开，而那个前提
        // 本身就需要本机文件写权限，已经不在 QQ 攻击面上。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/request-permission') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('requestPermission')) { sendJson(disabledByOwner('qq_request_permission', 'requestPermission'), 403); return; }
          const scope = String(body.scope ?? '').trim();
          if (!isKnownScope(scope)) {
            sendJson({
              ok: false,
              error: `未知的授权类别 "${scope}"；只能申请：${Object.entries(PERMIT_SCOPES).map(([id, s]) => `${id}（${s.label}）`).join('、')}`
            }, 400);
            return;
          }
          // 🔴 只认管理员私聊。群聊/普通成员私聊连"申请"这一步都不该发出去 ——
          //    否则群友可以用「她来问我」当钓鱼：重复弹申请、诱导误点「同意」。
          if (key !== `private:${String(cfg.ownerQQ ?? '')}`) {
            sendJson({
              ok: false,
              error: '这类申请只对管理员私聊有效：群聊和普通成员的私聊都不能动主人的手机/账号，申请了也不会被受理。'
            }, 403);
            return;
          }
          const existing = activeGrant(readPermits(), key, scope);
          if (existing) {
            sendJson({
              ok: true,
              granted: true,
              alreadyGranted: true,
              scope,
              expiresAt: existing.expiresAt,
              remainingText: formatRemaining(existing.expiresAt - Date.now()),
              message: `已经批准过「${PERMIT_SCOPES[scope].label}」，还剩 ${formatRemaining(existing.expiresAt - Date.now())}，直接去用就行，不用再问。`
            });
            return;
          }
          // 同一会话同时只挂一个申请：新的覆盖旧的（并明确告诉它被覆盖了）。
          const prev = pendingPermitRequests.get(key);
          if (prev) {
            prev.resolve({ allowed: false, reason: 'superseded' });
            log(`[permit] ${key} 新的申请覆盖了旧的（${prev.scope} → ${scope}）`);
          }
          const request = createRequest({ key, scope, why: body.why });
          const label = PERMIT_SCOPES[scope].label;
          const maxMin = Math.round(PERMIT_SCOPES[scope].maxTtlMs / 60000);
          const defMin = Math.round(PERMIT_SCOPES[scope].defaultTtlMs / 60000);
          const whyLine = request.why ? `\n理由：${request.why}` : '';
          // 直接发 QQ：她要"来找他"，这条消息就是那个"来"。
          await sendToQQ(
            key,
            `🙋 想跟你说个事：我能${label === '刷B站' ? '去刷会儿 B站' : '玩会儿手机'}吗？${whyLine}\n`
            + `回「同意」就行（默认给 ${defMin} 分钟，可以写「同意 1 小时」调整，最多 ${maxMin} 分钟）；`
            + `回「不同意」或者不理它就当没这回事。`
          );
          const outcome = await new Promise((resolve) => {
            const timer = setTimeout(() => {
              pendingPermitRequests.delete(key);
              resolve({ allowed: false, reason: 'timeout' });
            }, PERMIT_REQUEST_TIMEOUT_MS);
            timer.unref?.();
            pendingPermitRequests.set(key, { request, scope, resolve, timer });
          });
          if (outcome.allowed) {
            const permit = readPermits();
            const { expiresAt } = resolveGrant(scope, { requestedMs: outcome.ttlMs });
            if (!permit.grants[key]) permit.grants[key] = {};
            permit.grants[key][scope] = {
              expiresAt,
              grantedAt: Date.now(),
              requestId: request.id,
              why: request.why
            };
            permit.requests[request.id] = { ...request, status: 'granted', grantedAt: Date.now(), expiresAt };
            // ⭐ 授权生效时把模拟器拉起来（如果是 phone 这一档）。
            //    只记"是不是我们开的"——本来就开着的，到期不会去关它。
            let emulatorNote = '';
            if (scope === 'phone' && emulatorCfg().enabled) {
              const emu = emulatorStartForGrant();
              if (emu.started) {
                permit.grants[key][scope].weStartedEmulator = true;
                emulatorNote = '模拟器我已经替你开好了（玩完授权到期会自己关）。';
                appendActivity(`${key} [emulator] 授权生效，已启动模拟器`);
              } else if (emu.note && emu.note !== '模拟器原本就在运行，到期不关') {
                emulatorNote = `模拟器没拉起来（${emu.note}），你可以先 phone_status 看一眼。`;
              }
            }
            writePermits(prunePermits(permit));
            log(`[permit] ${key} 已授权「${label}」至 ${new Date(expiresAt).toLocaleString()}（${formatRemaining(expiresAt - Date.now())}）`);
            appendActivity(`${key} [permit] 主人同意了「${label}」，有效期 ${formatRemaining(expiresAt - Date.now())}`);
            sendJson({
              ok: true,
              granted: true,
              scope,
              expiresAt,
              remainingText: formatRemaining(expiresAt - Date.now()),
              emulatorStarted: /替你开好了/.test(emulatorNote) || undefined,
              message: `他同意了。现在可以「${label}」，有效期到 ${new Date(expiresAt).toLocaleString()}（约 ${formatRemaining(expiresAt - Date.now())}）。`
                + (emulatorNote ? `\n${emulatorNote}` : '')
                + '到期后要再玩就得重新问他。'
            });
            return;
          }
          const reasonText = outcome.reason === 'timeout'
            ? `他没有回你（等了 ${Math.round(PERMIT_REQUEST_TIMEOUT_MS / 60000)} 分钟）`
            : outcome.reason === 'superseded'
              ? '你后面又发了一个新的申请，这个被顶掉了'
              : '他说不行';
          const deniedFile = readPermits();
          deniedFile.requests[request.id] = { ...request, status: 'denied', deniedAt: Date.now() };
          writePermits(prunePermits(deniedFile));
          log(`[permit] ${key} 申请「${label}」未获同意：${outcome.reason}`);
          sendJson({
            ok: true,
            granted: false,
            scope,
            reason: outcome.reason,
            message: `${reasonText}，这会儿不能「${label}」。不用反复申请 —— 他真忙或者不想就直接说找不了；等下次聊到相关的事再提，或者干脆换个话题。`
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/permits') {
          // 控制台展示用：当前有效授权 + 最近申请记录。不暴露 agent 令牌。
          const key = String(url.searchParams.get('key') ?? '').trim();
          const permit = readPermits();
          const grants = Object.entries(permit.grants).flatMap(([k, perScope]) =>
            Object.entries(perScope).map(([scope, g]) => ({ key: k, scope, label: PERMIT_SCOPES[scope]?.label ?? scope, expiresAt: g.expiresAt, remainingText: formatRemaining(g.expiresAt - Date.now()), why: g.why }))
          ).filter((g) => !key || g.key === key);
          const requests = Object.values(permit.requests).filter((r) => !key || r.key === key).slice(-30);
          sendJson({ ok: true, grants, requests });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/revoke-permit') {
          // 主人可以随时收回（控制台按钮 / 他直接说「不许玩了」）。
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const scope = String(body.scope ?? '').trim();
          if (!key || !/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const permit = readPermits();
          let removed = 0;
          if (scope) {
            if (permit.grants[key]?.[scope]) { delete permit.grants[key][scope]; removed = 1; }
          } else {
            removed = Object.keys(permit.grants[key] ?? {}).length;
            delete permit.grants[key];
          }
          writePermits(prunePermits(permit));
          // 正在等答复的申请也一并作废。
          const p = pendingPermitRequests.get(key);
          if (p && (!scope || p.scope === scope)) {
            p.resolve({ allowed: false, reason: 'revoked' });
            pendingPermitRequests.delete(key);
          }
          log(`[permit] ${key} 授权已收回（${scope || '全部'}，${removed} 条）`);
          sendJson({ ok: true, removed });
          return;
        }
        // 管理员**主动**发一张牌子，不等她来申请。
        // 用途：你此刻就想让她去玩会儿（或她正卡在"要申请"上懒得开口），
        // 与其等一条 QQ 申请，不如直接批。跟"她申请→你同意"走的是同一张授权表、
        // 同一个守卫，所以批出去的程序效果完全一致，只是不必走那一轮问答。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/grant-permit') {
          const body = await readBody();
          const scope = String(body.scope ?? '').trim();
          if (!isKnownScope(scope)) {
            sendJson({ ok: false, error: `未知的授权类别 "${scope}"；只能批准：${Object.keys(PERMIT_SCOPES).join(' / ')}` }, 400);
            return;
          }
          // 🔴 只给管理员私聊发牌。这不是"多此一举的校验"——授权表是按会话 key 存的，
          //    若允许给 group:… 写一条，就等于开了一个"群里也能玩手机"的口子，
          //    而守卫是按 key 查表的，它会认。
          const key = `private:${String(cfg.ownerQQ ?? '')}`;
          if (!cfg.ownerQQ) { sendJson({ ok: false, error: '未配置 ownerQQ，无法签发授权' }, 400); return; }
          const permit = readPermits();
          const { expiresAt } = resolveGrant(scope, { requestedMs: Number(body.minutes) > 0 ? Number(body.minutes) * 60 * 1000 : undefined });
          if (!permit.grants[key]) permit.grants[key] = {};
          permit.grants[key][scope] = {
            expiresAt,
            grantedAt: Date.now(),
            requestId: 'console',
            why: String(body.why ?? '控制台直接批准').slice(0, 120)
          };
          // 控制台发牌同样要拉起模拟器（否则批了她也玩不了）。
          let emulatorNote = '';
          if (scope === 'phone' && emulatorCfg().enabled) {
            const emu = emulatorStartForGrant();
            if (emu.started) {
              permit.grants[key][scope].weStartedEmulator = true;
              emulatorNote = '；模拟器已启动';
            }
          }
          writePermits(prunePermits(permit));
          log(`[permit] 控制台直接批准「${PERMIT_SCOPES[scope].label}」给 ${key}，至 ${new Date(expiresAt).toLocaleString()}${emulatorNote}`);
          appendActivity(`${key} [permit] 控制台批准「${PERMIT_SCOPES[scope].label}」，有效期 ${formatRemaining(expiresAt - Date.now())}`);
          // 如果说好要告诉她一声（"我准了，去玩吧"），就在她私聊里说一句。
          // 她的申请工具此刻没在等（这是主动发牌），所以只能走普通消息。
          if (body.notify === true) {
            const label = PERMIT_SCOPES[scope].label;
            void sendToQQ(key, `✅ 批了，去${label === '刷B站' ? '刷会儿 B站' : '玩会儿手机'}吧，到 ${new Date(expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 前都算数。`).catch(() => {});
          }
          sendJson({
            ok: true,
            key,
            scope,
            expiresAt,
            remainingText: formatRemaining(expiresAt - Date.now()),
            grants: Object.entries(permit.grants[key] ?? {}).map(([s, g]) => ({
              scope: s, label: PERMIT_SCOPES[s]?.label ?? s, expiresAt: g.expiresAt, remainingText: formatRemaining(g.expiresAt - Date.now())
            }))
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const reason = String(body.reason ?? 'admin').trim() || 'admin';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const st = getSocialV2State(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          // 手动唤醒是“救命按钮”，必须能突破僵死回合：否则 20:33 那种被重启腰斩的回合
          // 会让 sendWakePromptV2 再次判定繁忙，表面上回了 200 却什么都没发生。
          // 只回收确实僵死的回合；正在正常跑（有近期事件）的回合不动，避免打断。
          reapStaleTurnV2(key, state.sessions[key]);
          if (!st.bootstrapSent) st.bootstrapSent = true;
          saveSocialV2State();
          // 和其它唤醒入口保持一致：sendWakePromptV2 是异步的，这里不 await（不能让 HTTP 回复
          // 等一个可能卡几十秒的模型回合），但必须挂 catch。裸调用一旦 reject 就是
          // unhandledRejection：Node 会打警告甚至按配置退出进程，而 HTTP 那边已经回了 {ok:true}，
          // 表面上"唤醒成功"，实际上谁也不知道它失败了。
          void sendWakePromptV2(key, reason).catch((error) => log(`[reserved2] 手动唤醒异常 ${key}:`, error?.message ?? error));
          log(`控制台：手动唤醒 ${key}（${reason}）`);
          sendJson({ ok: true, key, reason });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
            return;
          }
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendBurst')) { sendJson(disabledByOwner('qq_send_burst', 'sendBurst'), 403); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          // ⚠️ st / now 必须在 try **外面**：catch 里的「回滚预占额度」要用它们。
          //    曾经写在 try 里，于是任何发送失败都会在 catch 第一句抛 `st is not defined`，
          //    真实错误被遮盖、sendJson 也执行不到（请求挂到超时）。
          const st = getSocialV2State(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            // 先预占发送额度，避免并发绕过限频
            for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
            const sentMessages = await sendMessagesV2(key, messages, delays);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const isRawString = typeof rawMessages === 'string';
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          // 二代不再按空格自动分条：字符串就是一条消息，数组模式原样使用调用方间隔。
          // 旧写法是 `(isRawString && messages.length > 1) ? 'auto' : ...` —— 上面 messages 的构造
          // 保证 isRawString 为真时 length 恒为 1，这个分支永远不可达，留着只会让人以为
          // "字符串多段时有特殊间隔策略"。
          const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
          const gapMs = Number(body.gapMs);
          const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) { sendJson(disabledByOwner('qq_send_message', 'sendMessage'), 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) {
            sendJson({ ok: false, error: '私聊不需要 @' }, 400);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
          const st = getSocialV2State(key);
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          // 先预占发送额度，避免并发绕过限频
          for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              // 引用解析失败：回滚已预占的发送额度
              for (let i = 0; i < messages.length; i++) {
                const idx = st.sendTimes.indexOf(now);
                if (idx >= 0) st.sendTimes.splice(idx, 1);
              }
              saveSocialV2State();
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          try {
            const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendPoke')) { sendJson(disabledByOwner('qq_send_poke', 'sendPoke'), 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return; }
          if (kind === 'group' && !targetUserId) {
            sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
            return;
          }
          if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
            sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
            return;
          }
          // 群聊必须确认目标确实是本群成员（私聊天然只有双方，无需校验）。
          if (kind === 'group') {
            const memberError = await assertGroupMember(id, targetUserId);
            if (memberError) { sendJson({ ok: false, error: memberError }, 403); return; }
          }
          const st = getSocialV2State(key);
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          try {
            if (kind === 'group') {
              await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
            } else {
              // 私聊拍一拍：send_poke 自动路由到当前私聊对象
              await bot.raw('send_poke', { user_id: id });
            }
            st.lastActionAt = now;
            st.lastAiReplyAt = now;
            st.wakeConfig.noActionCount = 0;
            const pokeText = kind === 'group'
              ? `[拍一拍] 我拍了拍 ${targetUserId}`
              : '[拍一拍] 我拍了拍你';
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: pokeText,
              plain: pokeText,
              tail: pokeText,
              kind: 'poke',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
          } catch (error) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            // 回滚必须落盘：只改内存的话，重启后又变回「额度被白占」，假的 429 会回来。
            saveSocialV2State();
            log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── QQ 空间说说（reserved2） ──────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-qzone') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const content = String(body.content ?? '').trim();
          const ugcRight = Number(body.ugcRight ?? body.ugc_right ?? 4);
          const images = Array.isArray(body.images) ? body.images.map(String).filter(Boolean) : [];
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!content) { sendJson({ ok: false, error: 'content（说说正文）不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发说说必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendQzone')) { sendJson(disabledByOwner('qq_send_qzone_msg', 'sendQzone'), 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发说说' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发说说' }, 403); return; }
          const allowedRights = new Set([1, 4, 16, 64, 128]);
          if (!allowedRights.has(ugcRight)) { sendJson({ ok: false, error: 'ugcRight 必须是 1/4/16/64/128（4=好友可见，推荐）' }, 400); return; }
          const targetUins = Array.isArray(body.targetUins) ? body.targetUins.map((u) => String(u)).filter((s) => /^\d+$/.test(s)) : [];
          if ((ugcRight === 16 || ugcRight === 128) && targetUins.length === 0) {
            sendJson({ ok: false, error: 'ugcRight=16/128 时必须传 targetUins（可见/不可见名单）' }, 400);
            return;
          }
          const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && content.includes(t));
          if (SENSITIVE_RE.test(content) || hasKnownToken) {
            sendJson({ ok: false, error: '说说内容含敏感信息（路径/凭据/令牌），已阻止发送' }, 403);
            return;
          }
          if (content.length > 2000) { sendJson({ ok: false, error: '说说内容不能超过 2000 字' }, 400); return; }
          if (images.length > 9) { sendJson({ ok: false, error: '最多 9 张图片' }, 400); return; }
          const st = getSocialV2State(key);
          // 🔴 自主闸门（2026-10-19，主人要求）：发说说属于**写操作**，只允许在
          // **她自己起的回合**里发生。任何人在对话里命令她「发条说说」都不能成立 ——
          // 包括管理员本人（主人明确："谁都不能命令，包括我"）。
          // 判据是 st.turnAutonomous，见 AUTONOMOUS_WAKE_REASONS / sendWakePromptV2。
          // ⚠️ 这一道与守卫名单是**互补**的：守卫管"哪些会话能碰这个工具"，
          //    这里管"这一轮是谁起的头" —— 后者守卫看不到。
          //    2026-10-19 主人把发声类放开给所有会话之后，这道闸门就是唯一的自主约束，
          //    因此它必须在这里（而不是在守卫名单里）承担把关。
          if (!isAutonomousTurnActive(st)) {
            log(`[reserved2] 发说说被拒 ${key}（lastWakeReason=${st.lastWakeReason || '(无)'}，非自主回合或已过期）`);
            sendJson({
              ok: false,
              error: '发说说只能在你自己起的回合里做（主动冒泡/潜水到期/回看回复），'
                + '不能因为别人叫你发就发 —— 包括管理员。现在这一轮是别人触发的，所以拒绝。'
            }, 403);
            return;
          }
          // ⭐ 频率闸门（2026-10-20 主人要求）：静默期只是「允许」，不是「必须」。
          //    主人不希望"每个对话结束她都去发说说" —— 所以两次空间写之间至少隔 4 小时。
          //    ⚠️ 排在自主闸门**之后**：先判"该不该由她做"，再判"频率合不合适"。
          //    搞反了会给"别人命令她发"的请求回一个"太频繁"，误导她以为等会儿就能发。
          {
            const gap = qzoneWriteGapCheck(st);
            if (!gap.ok) {
              const mins = Math.ceil(gap.remainMs / 60000);
              const hrs = Math.floor(mins / 60);
              const left = hrs > 0 ? `${hrs} 小时 ${mins % 60} 分钟` : `${mins} 分钟`;
              log(`[reserved2] 空间写操作被频率闸门挡住 ${key}（还差 ${left}）`);
              sendJson({
                ok: false,
                error: `刚在空间留过痕迹了（还差 ${left} 才能再写）。静默期是"允许你说点什么"，`
                  + `不是"必须每次都说" —— 大部分时候什么都不做才是对的。想去空间看就去看（读不受限）。`
              }, 429);
              return;
            }
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          try {
            const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
            const params = { content, ugc_right: ugcRight };
            if (images.length) params.images = images;
            if (targetUins.length) params.target_uins = targetUins.map(Number);
            const res = await fetch(`${httpUrl}/send_qzone_msg`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
              },
              body: JSON.stringify({ action: 'send_qzone_msg', params }),
              signal: AbortSignal.timeout(20000)
            });
            const qb = await res.json().catch(() => ({}));
            if (!res.ok || qb.status !== 'ok' || qb.retcode !== 0) {
              throw new Error(`OneBot send_qzone_msg 失败: ${qb.wording || qb.retcode || res.status}`);
            }
            st.lastActionAt = now;
            // 记一次空间写：频率闸门（两次之间至少 4 小时）靠这个时间戳判定。
            // 存进 state 而不是内存变量 —— 否则桥接一重启她就又有一次机会，等于绕过约束。
            qzoneWriteMark(st);
            st.lastAiReplyAt = now;
            st.wakeConfig.noActionCount = 0;
            const preview = content.length > 50 ? content.slice(0, 50) + '…' : content;
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: `[QQ空间说说] ${preview}`,
              plain: `[QQ空间说说] ${preview}`,
              tail: `[QQ空间说说] ${preview}`,
              kind: 'qzone',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            saveSocialV2State();
            log(`[reserved2] 工具发说说 ${key}: ${preview}`);
            appendActivity(`${key} [reserved2] 工具发说说：${preview}`);
            sendJson({ ok: true, key, preview, data: qb.data ?? null });
          } catch (error) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            // 回滚必须落盘，否则重启后额度仍被白占（假的 429）。
            saveSocialV2State();
            log(`[reserved2] 工具发说说失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `发说说失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── QQ 空间读取 + 账号自述（reserved2，只读） ─────────────────────
        // 这两个端点只读，不产生任何对外动作：读自己的说说列表 / 读账号与好友信息。
        // 为什么需要：桥接原先只实现了 send_qzone_msg（只出不进），AI 发完说说看不见结果，
        // 也不知道"我是谁、我有几个好友"。SnowLuma 底层支持这些读接口，这里把它接出来。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/qzone-list') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const pos = Math.max(0, Number(url.searchParams.get('pos')) || 0);
          const num = Math.min(100, Math.max(1, Number(url.searchParams.get('num')) || 20));
          const targetUin = String(url.searchParams.get('targetUin') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getQzone')) { sendJson(disabledByOwner('qq_get_qzone_list', 'getQzone'), 403); return; }
          try {
            const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
            const params = { pos, num };
            if (/^\d+$/.test(targetUin)) params.target_uin = Number(targetUin);
            const res = await fetch(`${httpUrl}/get_qzone_msg_list`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
              },
              body: JSON.stringify({ action: 'get_qzone_msg_list', params }),
              signal: AbortSignal.timeout(20000)
            });
            const qb = await res.json().catch(() => ({}));
            if (!res.ok || qb.status !== 'ok' || qb.retcode !== 0) {
              throw new Error(`OneBot get_qzone_msg_list 失败: ${qb.wording || qb.retcode || res.status}`);
            }
            const data = qb.data ?? {};
            const msglist = Array.isArray(data.msglist) ? data.msglist : [];
            sendJson({
              ok: true,
              key,
              total: Number(data.total ?? msglist.length) || 0,
              msglist: msglist.map((m) => ({
                tid: m.tid,
                content: m.content,
                time: m.time,
                timeText: m.time ? new Date(Number(m.time) * 1000).toISOString() : null,
                commentNum: Number(m.comment_num ?? 0) || 0,
                isPrivate: !!m.is_private,
                images: Array.isArray(m.images) ? m.images : []
              }))
            });
          } catch (error) {
            log(`[reserved2] 工具读说说列表失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `读取说说列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── QQ 空间：写操作（点赞/评论/删除/改可见性） + 动态流（只读） ──────────
        //
        // ⭐ 自主闸门（2026-10-19，主人要求）：**空间写操作只允许在"她自己起的回合"里发生**。
        //    任何人在对话里命令她「去发条说说/去点赞」都不能成立 —— 包括主人自己。
        //    判据落在 st.turnAutonomous（见 AUTONOMOUS_WAKE_REASONS 与 sendWakePromptV2）：
        //      · 唤醒时按 reason 置位（只认 proactiveCheck / timeout / replyCheck）
        //      · 回合内只要有新消息或拍一拍进来，立刻撤销（别人一开口就不算她自主了）
        //      · 回合结束复位（不泄漏到下一轮）
        //    为什么放在执行期而不是靠工具白名单：白名单表达不了"这一轮是谁起的头"，
        //    而那恰恰是主人要区分的东西。
        //
        //    ⚠️ 只读的动态流不走这道闸门（主人明确说「你去看看说说」这种命令是可以的）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/qzone-action') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const op = String(body.op ?? '').trim();
          const tid = String(body.tid ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          // 每个 op 对应一个独立的工具开关，沿用既有命名风格（qzoneLike / qzoneComment / ...）。
          const OP_FLAG = {
            like: 'qzoneLike',
            unlike: 'qzoneUnlike',
            comment: 'qzoneComment',
            delete: 'qzoneDelete',
            setRight: 'qzoneSetRight'
          };
          const flag = OP_FLAG[op];
          if (!flag) { sendJson({ ok: false, error: 'op 必须是 like/unlike/comment/delete/setRight' }, 400); return; }
          if (!v2ToolEnabled(flag)) { sendJson(disabledByOwner(`qzone ${op}`, flag), 403); return; }
          // 🔴 自主闸门：不是她自己起的回合 ⇒ 一律拒绝，且理由要说清楚（让她能转述给群友）。
          const stQ = getSocialV2State(key);
          if (!isAutonomousTurnActive(stQ)) {
            log(`[reserved2] 空间写操作被拒 ${key}（op=${op}，lastWakeReason=${stQ.lastWakeReason || '(无)'}，非自主回合或已过期）`);
            sendJson({
              ok: false,
              error: '空间写操作只能在你自己起的回合里做（主动冒泡/潜水到期/回看回复），'
                + '不能因为别人叫你去做就去做 —— 包括管理员。现在这一轮是别人触发的，所以拒绝。'
            }, 403);
            return;
          }
          // ⭐ 频率闸门（2026-10-20 主人要求）：静默期只是「允许」，不是「必须」。
          //    主人不希望"每个对话结束她都去发说说" —— 所以两次空间写之间至少隔 4 小时。
          //    ⚠️ 排在自主闸门**之后**：先判"该不该由她做"，再判"频率合不合适"。
          //    搞反了会给"别人命令她发"的请求回一个"太频繁"，误导她以为等会儿就能发。
          {
            const gap = qzoneWriteGapCheck(stQ);
            if (!gap.ok) {
              const mins = Math.ceil(gap.remainMs / 60000);
              const hrs = Math.floor(mins / 60);
              const left = hrs > 0 ? `${hrs} 小时 ${mins % 60} 分钟` : `${mins} 分钟`;
              log(`[reserved2] 空间写操作被频率闸门挡住 ${key}（还差 ${left}）`);
              sendJson({
                ok: false,
                error: `刚在空间留过痕迹了（还差 ${left} 才能再写）。静默期是"允许你说点什么"，`
                  + `不是"必须每次都说" —— 大部分时候什么都不做才是对的。想去空间看就去看（读不受限）。`
              }, 429);
              return;
            }
          }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能操作空间' }, 403); return; }
          if (op !== 'setRight' && !tid) { sendJson({ ok: false, error: 'tid 不能为空' }, 400); return; }
          const targetUin = /^\d+$/.test(String(body.targetUin ?? '')) ? Number(body.targetUin) : undefined;
          const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
          const callQzone = async (action, params = {}) => {
            const res = await fetch(`${httpUrl}/${action}`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
              },
              body: JSON.stringify({ action, params }),
              signal: AbortSignal.timeout(20000)
            });
            const qb = await res.json().catch(() => ({}));
            if (!res.ok || qb.status !== 'ok' || qb.retcode !== 0) {
              throw new Error(`OneBot ${action} 失败: ${qb.wording || qb.retcode || res.status}`);
            }
            // ⭐ 空间写操作成功 —— 记下时间，频率闸门（两次之间至少 4 小时）靠它判定。
            //    四个分支（点赞/评论/删除/改可见性）都走这里，所以只记一处就够、不会漏。
            //    ⚠️ 必须在**成功**之后记：失败不算"留过痕迹"，不该吃这个冷却。
            try { qzoneWriteMark(stQ); } catch { /* 记不上也不该让请求失败 */ }
            return qb.data ?? null;
          };
          try {
            if (op === 'like' || op === 'unlike') {
              const params = { tid };
              if (targetUin !== undefined) params.target_uin = targetUin;
              const abs = Number(body.abstime);
              if (Number.isFinite(abs) && abs > 0) params.abstime = Math.floor(abs);
              await callQzone(op === 'like' ? 'like_qzone' : 'unlike_qzone', params);
              const preview = `${op === 'like' ? '点赞' : '取消赞'} tid=${tid}`;
              appendActivity(`${key} [reserved2] 空间${preview}`);
              sendJson({ ok: true, key, op, tid });
              return;
            }
            if (op === 'comment') {
              const content = String(body.content ?? '').trim();
              if (!content) { sendJson({ ok: false, error: 'content（评论正文）不能为空' }, 400); return; }
              if (content.length > 500) { sendJson({ ok: false, error: '评论不能超过 500 字' }, 400); return; }
              // 评论是**公开发言**，必须和发说说走同一套内容审计（路径/凭据/令牌）。
              const hasKnownTokenC = [...KNOWN_AGENT_TOKENS].some((t) => t && content.includes(t));
              if (SENSITIVE_RE.test(content) || hasKnownTokenC) {
                sendJson({ ok: false, error: '评论内容含敏感信息（路径/凭据/令牌），已阻止发送' }, 403);
                return;
              }
              const params = { tid, content };
              if (targetUin !== undefined) params.target_uin = targetUin;
              await callQzone('comment_qzone', params);
              appendActivity(`${key} [reserved2] 空间评论 tid=${tid}：${content.slice(0, 40)}`);
              sendJson({ ok: true, key, op, tid, preview: content.slice(0, 50) });
              return;
            }
            if (op === 'delete') {
              await callQzone('delete_qzone_msg', { tid });
              appendActivity(`${key} [reserved2] 空间删除说说 tid=${tid}`);
              sendJson({ ok: true, key, op, tid });
              return;
            }
            if (op === 'setRight') {
              const ugcRight = Number(body.ugcRight);
              if (![1, 4, 16, 64, 128].includes(ugcRight)) {
                sendJson({ ok: false, error: 'ugcRight 必须是 1/4/16/64/128' }, 400);
                return;
              }
              const targetUins = Array.isArray(body.targetUins)
                ? body.targetUins.map((u) => String(u)).filter((s) => /^\d+$/.test(s))
                : [];
              if ((ugcRight === 16 || ugcRight === 128) && targetUins.length === 0) {
                sendJson({ ok: false, error: 'ugcRight=16/128 时必须传 targetUins' }, 400);
                return;
              }
              const params = { tid, ugc_right: ugcRight };
              if (targetUins.length) params.target_uins = targetUins.map(Number);
              await callQzone('set_qzone_msg_right', params);
              appendActivity(`${key} [reserved2] 空间改可见性 tid=${tid} -> ${ugcRight}`);
              sendJson({ ok: true, key, op, tid, ugcRight });
              return;
            }
          } catch (error) {
            log(`[reserved2] 空间写操作失败 ${key}（${op}）:`, error?.message ?? error);
            sendJson({ ok: false, error: `空间操作失败：${error?.message ?? error}` }, 500);
            return;
          }
        }
        // 空间好友动态流（**只读**）：主人明确说「你去看看说说」这种命令是可以的，
        // 所以这一条**不设自主闸门** —— 她随时可以看，只是不能替你写。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/qzone-feeds') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const pageNum = Math.max(1, Number(url.searchParams.get('pageNum')) || 1);
          const count = Math.min(50, Math.max(1, Number(url.searchParams.get('count')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('qzoneFeeds')) { sendJson(disabledByOwner('qq_get_qzone_feeds', 'qzoneFeeds'), 403); return; }
          try {
            const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
            const res = await fetch(`${httpUrl}/get_qzone_feeds`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
              },
              body: JSON.stringify({ action: 'get_qzone_feeds', params: { page_num: pageNum, count } }),
              signal: AbortSignal.timeout(20000)
            });
            const qb = await res.json().catch(() => ({}));
            if (!res.ok || qb.status !== 'ok' || qb.retcode !== 0) {
              throw new Error(`OneBot get_qzone_feeds 失败: ${qb.wording || qb.retcode || res.status}`);
            }
            const data = qb.data ?? {};
            const feeds = Array.isArray(data.feeds) ? data.feeds : [];
            sendJson({
              ok: true,
              key,
              pageNum,
              hasMore: !!data.has_more,
              // ⚠️ html 是服务端预渲染的**原始 HTML**，体积大且带标签；这里只透传前 300 字，
              //    够她判断"这条是谁发的、在聊什么"，不至于一次灌爆上下文。
              feeds: feeds.map((f) => ({
                uin: f.uin,
                nickname: f.nickname,
                time: f.time,
                timeText: f.time ? new Date(Number(f.time) * 1000).toISOString() : null,
                appid: f.appid,
                key: f.key,
                html: typeof f.html === 'string' ? f.html.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
              }))
            });
          } catch (error) {
            log(`[reserved2] 读空间动态失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `读取空间动态失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/account-info') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getAccount')) { sendJson(disabledByOwner('qq_get_account_info', 'getAccount'), 403); return; }
          try {
            const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
            const callOneBot = async (action, params = {}) => {
              const res = await fetch(`${httpUrl}/${action}`, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
                },
                body: JSON.stringify({ action, params }),
                signal: AbortSignal.timeout(15000)
              });
              const qb = await res.json().catch(() => ({}));
              if (!res.ok || qb.status !== 'ok' || qb.retcode !== 0) {
                throw new Error(`OneBot ${action} 失败: ${qb.wording || qb.retcode || res.status}`);
              }
              return qb.data;
            };
            const login = await callOneBot('get_login_info');
            const selfUin = String(login?.user_id ?? '');
            let self = {};
            try { self = await callOneBot('get_stranger_info', { user_id: Number(selfUin) }); } catch { /* 资料拿不到不影响主体 */ }
            // 好友列表：只暴露 QQ 号/昵称/备注，不泄露其它字段
            let friends = [];
            try {
              const raw = await callOneBot('get_friend_list');
              const list = Array.isArray(raw) ? raw : (raw?.data ?? []);
              friends = list.map((f) => ({ userId: String(f.user_id ?? ''), nickname: f.nickname ?? '', remark: f.remark ?? '' }));
            } catch { /* 好友列表失败不阻塞 */ }
            // 把好友里的"主人"标出来，方便 AI 认人
            const ownerUin = String(cfg.socialV2?.ownerQQ ?? cfg.ownerQQ ?? '');
            sendJson({
              ok: true,
              key,
              account: {
                userId: selfUin,
                nickname: login?.nickname ?? '',
                sex: self?.sex ?? null,
                age: self?.age ?? null,
                longNick: self?.long_nick ?? null,
                qqLevel: self?.qq_level ?? self?.level ?? null,
                regTime: self?.reg_time ?? null,
                online: true
              },
              owner: { userId: ownerUin || null, isFriend: friends.some((f) => f.userId === ownerUin) },
              friendCount: friends.length,
              friends: friends.map((f) => ({ ...f, isOwner: !!ownerUin && f.userId === ownerUin }))
            });
          } catch (error) {
            log(`[reserved2] 工具读账号信息失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `读取账号信息失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 表情包体系（reserved2） ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getStickerImage')) { sendJson(disabledByOwner('qq_get_sticker_image', 'getStickerImage'), 403); return; }
          try {
            const entry = await getStickerImageData(stickerId);
            const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES());
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS()) {
              sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
              return;
            }
            const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
            sendJson({
              ok: true,
              key,
              sticker: {
                id: entry.id,
                desc: entry.desc || '',
                localNote: entry.localNote || '',
                tags: entry.tags || [],
                url: entry.url,
                md5: entry.md5
              },
              image: { mimeType, data: fetched.buffer.toString('base64') }
            });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('stickerNote')) { sendJson(disabledByOwner('qq_sticker_note', 'stickerNote'), 403); return; }
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
          sendJson({ ok: true, key, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setStickerRemark')) { sendJson(disabledByOwner('qq_set_sticker_remark', 'setStickerRemark'), 403); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
            sendJson({ ok: true, key, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 语音发送（操作者通道：CLI / 控制台，凭 consoleToken） ──────────────
        //
        // 与 /api/send/* 的 agent 通道分开：操作者可能不在任何 QQ 会话里，
        // 所以不套「会话/模式」闸门，但白名单 + 语音限流 + 文件名审计一个都不少。
        if (req.method === 'POST' && (url.pathname === '/api/voice/send' || url.pathname === '/api/send/voice')) {
          const body = await readBody();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const voice = voiceCfg();
          // 注意：这里是**操作者通道**（CLI / 控制台面板 / 图形界面），由控制台令牌鉴权。
          // socialV2.voice.enabled 是「AI 能不能发语音」的总闸，不该连你手动试发一起关掉——
          // 否则"默认不启用"会变成"谁都发不了"，连放音频试一下都做不到。
          // AI 通道的开关在 /api/socialV2/send-voice 里单独判定。
          // /api/send/voice 是 AI 工具入口：带 agent token 时一律按 agent 规则走，
          // 避免 AI 借用操作者通道绕过「只能发自己会话」的限制。
          if (url.pathname === '/api/send/voice' && agentToken) {
            sendJson({
              ok: false,
              error: 'AI 请改用 /api/socialV2/send-voice（带 key + token）'
            }, 403);
            return;
          }
          const key = String(body.target ?? body.key ?? '').trim();
          const parsedTarget = parseTargetKey(key);
          if (!parsedTarget) { sendJson({ ok: false, error: 'target 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!modeAllowed(key, parsedTarget.kind, Number(parsedTarget.id), cfg, currentMode)) {
            const a = cfg.allow ?? {};
            sendJson({
              ok: false,
              error: `目标 ${key} 不在白名单内（config.json allow.groups / allow.private：群 ${(a.groups ?? []).join(', ') || '空'}；私聊 ${(a.private ?? []).join(', ') || '空'}）`
            }, 403);
            return;
          }
          let resolved;
          try {
            resolved = resolveVoicePathForOperator(body.file ?? body.path ?? '');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          // 音量参数先校验（写错了当场告诉你，不要等到发的时候才炸）
          try {
            resolveAudioProcessing({
              volume: body.volume ?? voice.defaultVolume,
              normalize: body.normalize === true,
              loudness: body.loudness ?? voice.loudness
            });
          } catch (error) {
            sendJson({ ok: false, error: error.message }, 400);
            return;
          }
          const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
          if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
          const preview = {
            key,
            file: resolved.path,
            via: resolved.via,
            bytes: probe.size,
            duration: probe.duration,
            codec: probe.codec,
            detail: describeAudio(probe),
            warnings: probe.warnings ?? [],
            limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour }
          };
          if (body.dryRun === true) { sendJson({ ok: true, dryRun: true, ...preview }); return; }
          const now = Date.now();
          try {
            voiceBudgetCheck('operator:cli', voice);
            const sent = await sendVoiceV2(key, resolved.path, {
              guard: false,
              audit: true,
              audio: {
                volume: body.volume ?? voice.defaultVolume,
                normalize: body.normalize === true,
                loudness: body.loudness ?? voice.loudness
              }
            });
            voiceBudgetCommit('operator:cli', now);
            log(`[voice] (操作者) ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}${sent.audioMode === 'original' ? '' : '，' + sent.audioProcessing}, messageId=${sent.messageId ?? '?'})`);
            appendActivity(`${key} [voice] (操作者) 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
            // CLI 默认要落地校验（--verify 之外也能给出可信证据）；readback 仅在做"收到的语音"实验时用。
            const verification = body.verify === false ? null : await verifyVoiceMessageSent(sent.messageId);
            let readbackText = null;
            if (body.readback === true && sent.messageId) {
              try {
                const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
                const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
                  },
                  body: JSON.stringify({ message_id: String(sent.messageId) }),
                  signal: AbortSignal.timeout(30000)
                });
                const rb = await res.json().catch(() => ({}));
                if (res.ok && rb.status === 'ok' && rb.retcode === 0) readbackText = rb.data?.text ?? '';
              } catch (error) {
                log(`[voice] 转写回读失败：${error?.message ?? error}`);
              }
            }
            sendJson({
              ok: true,
              ...preview,
              messageId: sent.messageId,
              verified: verification?.confirmed === true,
              readback: readbackText,
              audioProcessing: sent.audioProcessing,
              volume: sent.volume,
              loudness: sent.loudness
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 语音发送（AI 通道：reserved2 + agent token，只能发自己那个会话） ────
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-voice') {
          const body = await readBody();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const key = String(body.key ?? body.target ?? '').trim();
          const voice = voiceCfg();
          if (!voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空（格式 group:群号 或 private:QQ号）' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2ToolEnabled('sendVoice')) { sendJson(disabledByOwner('qq_send_voice', 'sendVoice'), 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          // 只要名字（解析）不要内容（预览）：dry-run 也必须经过与真发相同的解析与校验。
          let resolved;
          try {
            resolved = resolveVoicePathForV2(body.voice ?? body.file ?? '');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          try {
            voiceBudgetCheck(key, voice);
            if (body.dryRun === true) {
              const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
              if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
              sendJson({ ok: true, dryRun: true, key, file: resolved.path, detail: describeAudio(probe) });
              return;
            }
            const sent = await sendVoiceForV2(key, body.voice ?? body.file, {
              label: body.label ? String(body.label).slice(0, 100) : '',
              verify: body.verify,
              readback: body.readback === true,
              // AI 也可以调音量（默认走 config 的 defaultVolume）
              audio: (body.volume !== undefined || body.normalize === true || body.loudness !== undefined)
                ? { volume: body.volume, normalize: body.normalize === true, loudness: body.loudness }
                : null
            });
            sendJson({
              ok: true,
              key,
              messageId: sent.messageId,
              file: path.basename(sent.file),
              detail: sent.detail,
              audioProcessing: sent.audioProcessing,
              // verified=true 表示已用 get_msg 回读到这条消息的 record 段（"真的发出去了"的硬证据）
              verified: sent.verification?.confirmed === true,
              readback: sent.readback,
              warnings: sent.warnings
            });
          } catch (error) {
            // 额度只在真正发出后才记账（voiceBudgetCommit），所以失败路径无需回滚。
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 语音合成发送（AI 通道：她说一句话 → 本机 TTS 合成 → 当语音条发出去） ──
        // 与上面 /send-voice 的关系：那个发的是**语音库里已有的文件**，这个发的是**她现说的话**。
        // 闸门顺序刻意保持一致；差别只有 ① 多一道 tts.enabled 检查 ② 没有 dryRun 预览
        // （合成要花几秒和一次网络请求，预览没意义，真要预览就调 /send-voice 用库里文件）。
        // ⚠️ 状态（2026-10-20）：这个端点是 qq_speak 专用的旧入口。
        //    qq_speak 已与 qq_say 合并 ⇒ **当前没有任何 MCP 工具在调它**。
        //    刻意**保留**它：它是 HTTP 接口，可能有外部脚本（自写的调试脚本、
        //    voice-tool 之类）在调；删掉会让那些调用静默坏掉。
        //    新的语音发送请走 /api/socialV2/speak-or-text（qq_say 用它）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/speak') {
          const body = await readBody();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const key = String(body.key ?? body.target ?? '').trim();
          const text = String(body.text ?? body.message ?? '').trim();
          const voiceCfgNow = voiceCfg();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空（格式 group:群号 或 private:QQ号）' }, 400); return; }
          if (!voiceCfgNow.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          // ⚠️ 热读 cfg，不用 tts.enabled —— 那是启动快照，控制台关掉开关后它仍是 true。
          //    （与 speakForV2 里的判定保持一致；这里是同一类 bug 的另一个落点。）
          if (cfg.socialV2?.tts?.enabled === false) { sendJson({ ok: false, error: '语音合成已关闭（socialV2.tts.enabled=false）' }, 403); return; }
          if (!text) { sendJson({ ok: false, error: 'text 不能为空（要念的内容）' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2ToolEnabled('speak')) {
            // 语音是她最常用的功能，这里额外给她一条「怎么继续」的提示。
            // 统一走 disabledByOwner：报错里必须说明"主人主动关的、不是坏了、
            // 不用重试也不用上报" —— 否则她会把配置态当故障，反复试、还报 bug。
            sendJson(disabledByOwner('qq_say', 'speak', '改用文字发送就行'), 403);
            return;
          }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          try {
            const sent = await speakForV2(key, text, {
              label: String(body.label ?? '').trim(),
              verify: body.verify === true ? true : (body.verify === false ? false : null),
              voice: String(body.voice ?? '').trim(),
              rate: String(body.rate ?? '').trim(),
              ttsVolume: String(body.ttsVolume ?? '').trim(),
              pitch: String(body.pitch ?? '').trim()
            });
            sendJson({
              ok: true,
              key,
              messageId: sent.messageId,
              file: sent.file,
              bytes: sent.bytes,
              chars: sent.chars,
              voice: sent.voice,
              engine: sent.engine,
              detail: sent.detail,
              audioProcessing: sent.audioProcessing,
              // verified=true 才是"这条语音真的落地了"的硬证据（get_msg 回读到 record 段）
              verified: sent.verification?.confirmed === true,
              warnings: sent.warnings
            });
          } catch (error) {
            sendJson({ ok: false, error: `发送语音失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // ⭐ 语音优先发送（2026-10-20 主人要求：常驻语音，发不了才退文字）。
        //    与 /speak 的区别：/speak 失败就失败，让模型自己决定怎么办；
        //    这个端点**永远保证这句话发出去**（语音或文字二选一），
        //    并明确告诉模型走的是哪条路，免得它以为语音发了、结果对方只看到文字。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/speak-or-text') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const text = String(body.text ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!text) { sendJson({ ok: false, error: 'text 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          // ⚠️ 这里**不能**在 speak 关着时返回 403（2026-10-23 主人要求：
          //    「我的语音是我自己关闭的就不要被误判是出错」）。
          //    语音开关是他自己关的，那 qq_say 就该安静地改成发文字、照常成功，
          //    而不是甩一条"工具已被关闭"的错误给她 —— 她看到 isError 只会当成故障，
          //    然后重试、或者来问主人"语音坏了"。
          //    真正的降级在 speakOrTextV2 里做（它读 v2ToolEnabled('speak')），
          //    所以这里放行即可。
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          try {
            const out = await speakOrTextV2(key, text, {
              label: String(body.label ?? '').trim(),
              voice: String(body.voice ?? '').trim(),
              rate: String(body.rate ?? '').trim(),
              ttsVolume: String(body.ttsVolume ?? '').trim(),
              pitch: String(body.pitch ?? '').trim(),
              verify: body.verify === true ? true : (body.verify === false ? false : null),
              // voice-only：语音发不出去就失败，**不**退文字。
              // 这吸收了原先 qq_speak 的语义（"我就是要发语音"）——
              // 合并工具时把它的失败合同作为 mode 保留下来，而不是丢掉。
              voiceOnly: String(body.mode ?? '') === 'voice-only'
            });
            if (out?.rerouted === 'call') {
              // 通话中：这句话已经从电话里说出去了，没有 QQ 消息 id 可给。
              sendJson({
                ok: true,
                key,
                mode: 'call',
                detail: '当前正在通话中，这句话已直接说给对方听（没有发到 QQ 聊天窗）',
                rerouted: 'call'
              });
              return;
            }
            sendJson({
              ok: true,
              key,
              mode: out.mode,                 // voice / text —— 她必须看这个才知道实际发了什么
              detail: out.detail,
              messageId: out.voice?.messageId,
              chars: out.voice?.chars,
              engine: out.voice?.engine,
              voice: out.voice?.voice,
              verified: out.voice?.verification?.confirmed === true
            });
          } catch (error) {
            sendJson({ ok: false, error: `发送失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          const caption = String(body.message ?? body.caption ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
          if (caption) {
            sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) { sendJson(disabledByOwner('qq_send_sticker', 'sendSticker'), 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          try {
            const st = getSocialV2State(key);
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sent = await sendStickerV2(key, stickerId, {
              replyToMessageId: actualReplyToMessageId,
              atUserId
            });
            // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
            const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
            const text = `[表情包:${label}]`;
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: truncateText(text, 200),
              plain: truncateText(text, 200),
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            scheduleReplyCheckV2(key);
            log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
            appendActivity(`${key} [sticker] 工具发送表情：${label}`);
            sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            const st = getSocialV2State(key);
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const messageRef = String(body.messageId ?? body.seq ?? '').trim();
          const remark = String(body.remark ?? '').trim();
          if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson(disabledByOwner('qq_collect_sticker', 'collectSticker'), 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const st = getSocialV2State(key);
          const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
          if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
          const now = Date.now();
          const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
          const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
          const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
            return;
          }
          // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
          st.stickerCollectTimes = st.stickerCollectTimes || [];
          st.stickerCollectTimes.push(now);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          try {
            const result = await collectStickerV2(key, messageRef, remark);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
            appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
            sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
          } catch (error) {
            const idx = st.stickerCollectTimes.indexOf(now);
            if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
            if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 语音库列表。两条通道共用：
        //   - 带 agent token（AI 的 qq_list_voices）→ 必须带 key，校验会话白名单/工具开关；
        //   - 不带 agent token（控制台调试面板 / CLI）→ 只需控制台令牌，不需要 key。
        // 返回一律只有文件名/大小/时长，**不含绝对路径**（AI 侧防路径外泄，控制台侧由试发接口解析）。
        if (req.method === 'GET' && (url.pathname === '/api/socialV2/voices' || url.pathname === '/api/voice/list')) {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const voice = voiceCfg();
          const agentCall = Boolean(req.headers['x-agent-token']);
          // 与发送接口同样的分层：voice.enabled 只关 AI 通道；操作者（控制台面板）仍可列语音库。
          if (agentCall && !voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (agentCall && !key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (agentCall && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentCall && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentCall && !v2ToolEnabled('sendVoice')) { sendJson(disabledByOwner('qq_send_voice', 'sendVoice'), 403); return; }
          const wantProbe = url.searchParams.get('probe') !== '0';
          try {
            const files = listAudioFiles(voice.dir);
            const items = [];
            for (const f of files.slice(0, 100)) {
              const entry = { name: path.relative(voice.dir, f).split(path.sep).join('/') };
              if (wantProbe) {
                const info = await inspectAudio(f, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
                entry.ok = info.ok;
                entry.bytes = info.size;
                entry.detail = info.ok ? describeAudio(info) : null;
                entry.seconds = info.duration ?? null;
                if (!info.ok) entry.error = info.error;
              }
              items.push(entry);
            }
            sendJson({
              ok: true,
              key: key || null,
              dir: agentCall ? undefined : voice.dir,
              count: items.length,
              voices: items,
              limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour },
              // ⚠️ 提示语里也不能出现绝对路径：AI 通道下同样要脱敏（dir 字段已经抑制了，
              // 但这里的模板字符串曾无条件插值 voice.dir —— 等于从旁边的字段又漏出去一次）。
              hint: items.length
                ? '用 qq_send_voice 传 name 即可把其中一个当语音发出去'
                : (agentCall ? '语音库为空：请让管理员先把音频放进语音库' : `语音库为空：把音频文件放进 ${voice.dir} 后重试`)
            });
          } catch (error) {
            sendJson({ ok: false, error: `读取语音库失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 上**不再支持** refresh：强制同步是有副作用的写操作（拉 OneBot 收藏表情并落盘），
          // 挂在 GET 上会绕开「非 GET 必须 application/json + 同源 Origin」的 CSRF 防护。
          // 需要强制同步时请用同一路径的 POST，或控制台的 POST /api/stickers/sync。
          const force = false;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson(disabledByOwner('qq_list_stickers', 'listStickers'), 403); return; }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const query = String(body.query ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(body.count) || 48, maxCount)));
          let force = body.refresh === true;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson(disabledByOwner('qq_list_stickers', 'listStickers'), 403); return; }
          // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
          if (req.headers['x-agent-token'] && force) {
            const now = Date.now();
            if (now - lastForcedAgentStickerSync < 10000) force = false;
            else lastForcedAgentStickerSync = now;
          }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 管理端表情库接口（控制台）
        if (req.method === 'GET' && url.pathname === '/api/stickers') {
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 不再触发强制同步（写副作用不能挂在读接口上）：请用 POST /api/stickers/sync。
          try {
            const synced = await syncStickerLibrary(false);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
          try {
            const synced = await syncStickerLibrary(true);
            sendJson({ ok: true, total: synced?.entries?.length ?? stickerEntries.length, syncedAt: synced?.syncedAt ?? stickerSyncedAt });
          } catch (error) {
            sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          sendJson({ ok: true, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            sendJson({ ok: true, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 群图媒体库（本地存的群友图片）────────────────────────────────────
        // 与 /api/stickers* 分开命名，因为它们是两套不同的东西：
        //   stickers = QQ 账号的收藏表情（有 emoji_id，用 add/modify_custom_face 管）
        //   photos   = 桥接本地存的群图（没有 emoji_id，只用本地文件）
        // 权限分层照抄表情库那套：/api/photos* 是**控制台专用**（AI 走 /api/socialV2/photo-*）。
        // AI 列图（只读，无写副作用；带 agent token 时按 v2 工具的会话闸门校验）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/photo-list') {
          if (!mediaLib) { sendJson({ ok: false, error: '群图库未就绪' }, 503); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listPhotos')) { sendJson(disabledByOwner('qq_photo_list', 'listPhotos'), 403); return; }
          const query = String(url.searchParams.get('query') ?? '').trim();
          const tag = String(url.searchParams.get('tag') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.photo?.maxListCount) || 60);
          const count = Math.min(200, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 24, maxCount)));
          try {
            // viewerKey = 当前会话：来源信息只在原会话可见（见 media-lib.search 的说明）。
            // AI 拿到的列表里，"别人发的图"只给图与备注，不告诉它"谁在哪个群发的、说了什么"。
            const result = mediaLib.search({ q: query, tag, limit: count, viewerKey: key });
            sendJson({ ok: true, ...result, stats: mediaLib.stats() });
          } catch (error) {
            sendJson({ ok: false, error: `获取群图失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 把群图的备注写回本地库（AI 看图后的认知，与 sticker-note 同一套路）。
        // 走 /api/socialV2/* 而不是 /api/photos/note —— 后者是控制台专用的管理面，
        // 不能让 AI 借 x-agent-token 去改库结构（提升/回收站/清理同理）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/photo-note') {
          if (!mediaLib) { sendJson({ ok: false, error: '群图库未就绪' }, 503); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const token = String(body.token ?? '').trim();
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (token && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (token && !v2ToolEnabled('photoNote')) { sendJson(disabledByOwner('qq_photo_note', 'photoNote'), 403); return; }
          const photoId = String(body.photoId ?? '').trim();
          if (!photoId) { sendJson({ ok: false, error: 'photoId 不能为空' }, 400); return; }
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null
            ? (Array.isArray(body.tags) ? body.tags.map(String) : String(body.tags).split(/[,，\s]+/))
            : undefined;
          const entry = applyPhotoNoteV2(photoId, note, tags);
          if (!entry) { sendJson({ ok: false, error: `找不到群图 ${photoId}` }, 404); return; }
          sendJson({ ok: true, photo: { id: entry.id, layer: entry.layer, desc: entry.desc, tags: entry.tags } });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/photos') {
          if (!mediaLib) { sendJson({ ok: false, error: '群图库未就绪' }, 503); return; }
          const query = String(url.searchParams.get('query') ?? '').trim();
          const tag = String(url.searchParams.get('tag') ?? '').trim();
          const layer = String(url.searchParams.get('layer') ?? '').trim();
          const includeTrash = url.searchParams.get('trash') === '1';
          const count = Math.min(500, Math.max(1, Number(url.searchParams.get('count')) || 20));
          try {
            // 控制台刻意**不传 viewerKey** = 管理员视图：主人查账时要看得到每张图的来源。
            // 遮蔽只针对"群里说话的她"，不针对主人自己。
            const result = mediaLib.search({ q: query, tag, layer: layer || undefined, limit: count, includeTrash });
            sendJson({ ok: true, ...result, stats: mediaLib.stats() });
          } catch (error) {
            sendJson({ ok: false, error: `获取群图失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/photos/stats') {
          if (!mediaLib) { sendJson({ ok: false, error: '群图库未就绪' }, 503); return; }
          sendJson({ ok: true, dir: mediaLibDir, writable: mediaLibWritable, sharp: sharpAvailable(), stats: mediaLib.stats() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/photos/note') {
          if (!mediaLib) { sendJson({ ok: false, error: '群图库未就绪' }, 503); return; }
          const body = await readBody();
          const photoId = String(body.photoId ?? '').trim();
          if (!photoId) { sendJson({ ok: false, error: 'photoId 不能为空' }, 400); return; }
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null
            ? (Array.isArray(body.tags) ? body.tags.map(String) : String(body.tags).split(/[,，\s]+/))
            : undefined;
          const entry = applyPhotoNoteV2(photoId, note, tags);
          if (!entry) { sendJson({ ok: false, error: `找不到群图 ${photoId}` }, 404); return; }
          sendJson({ ok: true, photo: { id: entry.id, layer: entry.layer, desc: entry.desc, tags: entry.tags } });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/photos/promote') {
          if (!mediaLib) { sendJson({ ok: false, error: '群图库未就绪' }, 503); return; }
          const body = await readBody();
          const photoId = String(body.photoId ?? '').trim();
          if (!photoId) { sendJson({ ok: false, error: 'photoId 不能为空' }, 400); return; }
          const entry = mediaLib.promote(photoId);
          if (!entry) { sendJson({ ok: false, error: `找不到群图 ${photoId}` }, 404); return; }
          saveMediaLibSafe();
          sendJson({ ok: true, photo: { id: entry.id, layer: entry.layer } });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/photos/trash') {
          if (!mediaLib) { sendJson({ ok: false, error: '群图库未就绪' }, 503); return; }
          const body = await readBody();
          const photoId = String(body.photoId ?? '').trim();
          if (!photoId) { sendJson({ ok: false, error: 'photoId 不能为空' }, 400); return; }
          // 还原优先：body.restore=true 时从回收站捞回来
          const entry = body.restore === true ? mediaLib.restore(photoId) : mediaLib.markTrash(photoId);
          if (!entry) { sendJson({ ok: false, error: `找不到群图 ${photoId}` }, 404); return; }
          saveMediaLibSafe();
          sendJson({ ok: true, photo: { id: entry.id, layer: entry.layer } });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/photos/cleanup') {
          if (!mediaLib) { sendJson({ ok: false, error: '群图库未就绪' }, 503); return; }
          const broken = mediaLib.cleanupBroken();
          const rolled = mediaLib.cleanupCandidates(Number(cfg.socialV2?.photo?.maxCandidates) || MEDIA_DEFAULTS.maxCandidates);
          const purged = mediaLib.cleanupTrash(Number(cfg.socialV2?.photo?.trashMaxItems) || MEDIA_DEFAULTS.trashMaxItems);
          saveMediaLibSafe();
          sendJson({ ok: true, broken, rolled, purged, stats: mediaLib.stats() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-photo') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const token = String(body.token ?? '').trim();
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (token && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (token && !v2ToolEnabled('sendPhoto')) { sendJson(disabledByOwner('qq_send_photo', 'sendPhoto'), 403); return; }
          const photoRef = String(body.photoId ?? '').trim();
          if (!photoRef) { sendJson({ ok: false, error: 'photoId 不能为空' }, 400); return; }
          try {
            const sent = await sendPhotoV2(key, photoRef, {
              replyToMessageId: body.replyToMessageId,
              atUserId: body.atUserId
            });
            sendJson({ ok: true, photoId: sent.entry?.id ?? photoRef, messageId: sent.messageId });
          } catch (error) {
            sendJson({ ok: false, error: `发送群图失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 生图：把画面描述交给桌面版「生图工作室」插件，等它画完，把图直接发进当前会话。
        //
        // 三道闸与 send-file 一致，且 token 必填（它能触发计费、还能往聊天里发图）。
        // 范围闸：管理员私聊 + 群聊（默认），scope 可改成 'owner' 或 'everyone'（见 drawImageAllowed）；
        // 成本闸：非管理员按天限流，见 drawQuotaOf()。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/draw-image') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const token = String(body.token ?? '').trim();
          if (!token) {
            sendJson({
              ok: false,
              kind: 'tokenRequired',
              retryable: false,
              error: '生图必须带会话令牌（qq_draw_image 的 token 参数）',
              hint: '这不是故障；把当前会话的令牌填进 token 就行。'
            }, 403);
            return;
          }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!drawImageAllowed(key)) {
            // 默认口径是「管理员私聊 + 群聊」（m01927），所以走到这里通常是
            // 普通成员的私聊；只有当 scope 被设成 'owner' 时群里也会被挡。
            sendJson({
              ok: false,
              kind: 'scopeDenied',
              retryable: false,
              error: '生图没有对这个会话开放（只开管理员私聊和群聊）',
              hint: '这不是故障，是主人的设置（socialV2.image.scope）。'
                + '要图请在群里说，或者直接找主人。'
            }, 403);
            return;
          }
          // 日额度闸：范围放全之后，唯一能防"群里刷屏烧钱"的就是这道。
          // 管理员私聊不限（limit=0），其余会话默认 5 张/天。
          const quota = drawQuotaOf(key);
          if (quota.left <= 0) {
            sendJson({
              ok: false,
              kind: 'quotaExceeded',
              retryable: false,
              error: `今天的生图额度用完了（这个会话 ${quota.limit} 张/天，已用 ${quota.used} 张）`,
              hint: '明天再来吧。这不是故障——每张图都真花钱，主人给每个会话定了日上限；'
                + '要更多可以请主人调 socialV2.image.dailyPerSession。'
            }, 429);
            return;
          }
          if (!v2ToolEnabled('drawImage')) { sendJson(disabledByOwner('qq_draw_image', 'drawImage'), 403); return; }
          try {
            const drawn = await drawImageV2(key, body);
            if (drawn && drawn.ok !== false) noteDrawUsed(key, drawn);
            sendJson({ ok: true, ...drawn, quota: (() => { const q = drawQuotaOf(key); return { limit: q.limit, used: q.used, left: q.limit === 0 ? null : q.left }; })() });
          } catch (error) {
            sendJson({ ok: false, error: `生图失败：${error?.message ?? error}` }, error?.statusCode ?? 500);
          }
          return;
        }
        // 发一张已经画好的图（只允许「生图工作室」产出目录里的文件）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-image') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const token = String(body.token ?? '').trim();
          if (!token) {
            sendJson({
              ok: false,
              kind: 'tokenRequired',
              retryable: false,
              error: '发图必须带会话令牌（qq_send_image 的 token 参数）',
              hint: '这不是故障；把当前会话的令牌填进 token 就行。'
            }, 403);
            return;
          }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!drawImageAllowed(key)) {
            sendJson({ ok: false, kind: 'scopeDenied', retryable: false, error: '发图没有对这个会话开放（只开管理员私聊和群聊）', hint: '这不是故障，是主人的设置（socialV2.image.scope）。' }, 403);
            return;
          }
          if (!v2ToolEnabled('sendImage')) { sendJson(disabledByOwner('qq_send_image', 'sendImage'), 403); return; }
          try {
            const abs = resolveStudioOutput(body.image ?? body.id);
            const buf = fs.readFileSync(abs);
            const sent = await sendLocalImageV2(key, buf, { replyToMessageId: body.replyToMessageId });
            sendJson({ ok: true, image: path.basename(abs), bytes: buf.length, messageId: sent.messageId ?? null });
          } catch (error) {
            sendJson({ ok: false, error: `发图失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 发文件：给一个 http(s) URL（先下载）或本机路径，让网关上传成 QQ 文件气泡。
        //
        // 与 send-photo 的关键区别：**这道闸不接受空 token 蒙混**。
        // send-photo 那三行都写成 `if (token && ...)` 是历史写法（token 空即跳过鉴权），
        // 发文件能读本机文件、能往外部拉东西，不能沿用那个宽松写法 —— 这里 token 必填。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-file') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const token = String(body.token ?? '').trim();
          if (!token) {
            sendJson({
              ok: false,
              kind: 'tokenRequired',
              retryable: false,
              error: '发文件必须带会话令牌（qq_send_file 的 token 参数）',
              hint: '这不是故障；把当前会话的令牌填进 token 就行。'
            }, 403);
            return;
          }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendFile')) { sendJson(disabledByOwner('qq_send_file', 'sendFile', '需要让她能下载/发送文件时请主人到控制台打开'), 403); return; }
          // 会话范围（2026-10-30 主人 m02763）：「qq_send_file 不用限定在管理员私聊里面，
          // 可以开放在群里面，但是不能开放给普通私聊」。
          // 群聊虽然放开，但 sendFileV2 里会强制「只认下载目录里的文件」，
          // 免得任何群友一句话就把主人电脑上的任意文件要走。
          const fileScope = String(cfg.socialV2?.file?.scope ?? 'owner-and-groups');
          const ownerPrivateKey = `private:${normalizeOwnerQQ(cfg.ownerQQ)}`;
          const fileScopeOk = fileScope === 'everyone'
            ? true
            : fileScope === 'owner'
              ? key === ownerPrivateKey
              : (key === ownerPrivateKey || key.startsWith('group:'));
          if (!fileScopeOk) {
            sendJson({
              ok: false,
              kind: 'scopeDenied',
              retryable: false,
              error: `发文件没有对这个会话开放（当前会话是 ${key}；只开管理员私聊和群聊）`,
              hint: '不管是谁让你发的，都别在这个会话里发文件、也别换个路径重试；需要的话请对方自己找主人。'
            }, 403);
            return;
          }
          try {
            const sent = await sendFileV2(key, {
              file: body.file,
              name: body.name
            });
            sendJson(sent);
          } catch (error) {
            sendJson({ ok: false, error: `发文件失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 把群图的图片字节直接还给模型（多模态看图）。与 /api/socialV2/sticker-image 同形状。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/photo-image') {
          if (!mediaLib) { sendJson({ ok: false, error: '群图库未就绪' }, 503); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getPhotoImage')) { sendJson(disabledByOwner('qq_get_photo_image', 'getPhotoImage'), 403); return; }
          const photoId = String(url.searchParams.get('photoId') ?? '').trim();
          if (!photoId) { sendJson({ ok: false, error: 'photoId 不能为空' }, 400); return; }
          try {
            const filePath = mediaLib.pathOf(photoId);
            if (!filePath) { sendJson({ ok: false, error: `找不到群图 ${photoId}（或文件已被清理）` }, 404); return; }
            const buf = fs.readFileSync(filePath);
            if (!buf.length) { sendJson({ ok: false, error: `群图 ${photoId} 的文件是空的` }, 500); return; }
            const dims = getImageDimensions(buf);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS()) {
              sendJson({ ok: false, error: `群图像素超限（${dims.width}x${dims.height}），已拒绝返回` }, 400);
              return;
            }
            const entry = mediaLib.get(photoId);
            sendJson({
              ok: true,
              photoId,
              mimeType: mimeFromBuffer(buf) || 'image/jpeg',
              data: buf.toString('base64'),
              desc: entry?.desc || '',
              tags: entry?.tags || []
            });
          } catch (error) {
            sendJson({ ok: false, error: `获取群图失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (body.purpose !== undefined && !['messages', 'reply'].includes(body.purpose)) {
            sendJson({ ok: false, error: 'purpose 必须是 messages（等后续消息）或 reply（回复前短静默）' }, 400);
            return;
          }
          const replyWait = body.purpose === 'reply';
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) { sendJson(disabledByOwner('qq_wait_for_messages', 'waitMessages'), 403); return; }
          if (socialV2.paused) {
            const st = getSocialV2State(key);
            sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], readThroughSeq: readThroughSeqV2(st), unreadCount: st.unread.length });
            return;
          }
          const waitCfg = cfg.socialV2?.wait ?? {};
          const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
          const defaultMs = Number(waitCfg.defaultMs) || 30000;
          const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
          const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
          const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
          const st = getSocialV2State(key);
          // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
          // 租约过期则视为残留（handler 异常退出没清干净），允许接管而不是永久 429。
          if (activeWaits.has(key) && Date.now() - activeWaits.get(key) < ACTIVE_WAIT_LEASE_MS) {
            sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
            return;
          }
          activeWaits.set(key, Date.now());
          const finishWait = () => activeWaits.delete(key);
          req.on('close', finishWait);
          const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
          const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
          const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
          // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
          // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
          // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
          const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
          const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
          // A reply wait must also include messages received while the model
          // was reading/thinking after its snapshot, before this HTTP request.
          const requestSeq = st.lastUnreadSeq || 0;
          const baseline = replyWait && (v2ToolEnabled('getUnread') || v2ToolEnabled('getRecent')) ? readThroughSeqV2(st) : requestSeq;
          const start = Date.now();
          let arrived = false;
          let lastNewAt = 0;
          let aborted = false;
          req.on('close', () => { aborted = true; });
          if (replyWait) {
            const incomingAt = () => {
              const value = Number(st.lastIncomingAt);
              return Number.isFinite(value) && value > 0 ? Math.min(value, Date.now()) : start;
            };
            lastNewAt = incomingAt();
            let observedSeq = st.lastUnreadSeq || 0;
            // Batch delay and model reading time already count towards quiet.
            // New arrivals restart quiet, but timeoutMs remains a hard budget.
            while (!aborted && Date.now() - start < timeoutMs) {
              if ((st.lastUnreadSeq || 0) !== observedSeq) {
                observedSeq = st.lastUnreadSeq || 0;
                lastNewAt = incomingAt();
              }
              const remaining = quietMs - (Date.now() - lastNewAt);
              if (remaining <= 0) break;
              await sleep(Math.max(1, Math.min(100, remaining, timeoutMs - (Date.now() - start))));
            }
            // A message may arrive during the final sleep, exactly at timeout.
            // Its timestamp must still invalidate the previous quiet window.
            lastNewAt = incomingAt();
            arrived = (st.lastUnreadSeq || 0) > baseline;
          } else while (Date.now() - start < timeoutMs && !aborted) {
            let nowSeq = st.lastUnreadSeq || 0;
            if (nowSeq - baseline >= minNew) {
              arrived = true;
              lastNewAt = Date.now();
              // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
              // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
              while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
                if ((st.lastUnreadSeq || 0) > nowSeq) {
                  nowSeq = st.lastUnreadSeq || 0;
                  lastNewAt = Date.now();
                }
                await sleep(200);
              }
              break;
            }
            await sleep(300);
          }
          const waitedMs = Date.now() - start;
          if (socialV2.conversations.get(canonicalV2Key(key)) !== st ||
              (req.headers['x-agent-token'] && (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false
                || !agentTokenOk(key, req.headers['x-agent-token']) || !v2SessionAllowed(key) || !v2ToolEnabled('waitMessages')))) {
            finishWait();
            sendJson({ ok: false, error: '等待期间会话已重置或权限已变化，请重新读取会话' }, 403);
            return;
          }
          const preSleepWaitMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
          const preSleepRemainingMs = preSleepWaitBlockedV2(st)
            ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
            : 0;
          const quiet = (replyWait || (arrived && quietMs > 0)) && (Date.now() - lastNewAt >= quietMs);
          // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
          // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
          const preSleepAttempt = !replyWait && timeoutMs >= preSleepWaitMs;
          // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
          // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
          const preSleepSatisfiedNow = !replyWait && (!arrived
            ? waitedMs >= preSleepWaitMs
            : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs));
          if (preSleepSatisfiedNow) {
            st.preSleepWaitSatisfiedAt = Date.now();
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait && !arrived) {
            // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait) {
            // 等待期间有新消息：
            // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
            // - 否则只清空累计，不算完成沉睡前观察。
            if (preSleepAttempt) {
              st.preSleepWaitObservedAt = Date.now();
            }
            st.preSleepWaitAccumMs = 0;
          }
          if (!replyWait) saveSocialV2State();
          // Each buffer is governed by its own tool switch: the unread buffer by
          // getUnread, the recent buffer by getRecent. A disabled switch must not leak
          // through either newMessages or the watermark, so the buffer is dropped
          // before arrival is judged -- not filtered afterwards.
          const history = replyWait
            ? [...(v2ToolEnabled('getUnread') ? st.unread : []),
              ...(v2ToolEnabled('getRecent') ? st.recentMessages : [])]
            : (Array.isArray(st.recentMessages) ? st.recentMessages : []);
          const pending = [...new Map(history
            .filter((m) => m && !m.isSelf && (m.seq || 0) > baseline)
            .map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq);
          // `arrived` is recomputed against what this request may actually hand over,
          // so a suppressed buffer cannot report an arrival it is not allowed to show.
          const newMessages = replyWait ? pending : (arrived ? pending : []);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, newMessages) : readThroughSeqV2(st);
          const lastNew = newMessages.length ? newMessages[newMessages.length - 1]
            : replyWait ? [...st.recentMessages].reverse().find((m) => m && !m.isSelf) : null;
          const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
          finishWait();
          sendJson({
            ok: true,
            key,
            purpose: replyWait ? 'reply' : 'messages',
            arrived,
            quiet,
            quietMs,
            suggestedQuietMs,
            speakerLikelyDone: quiet,
            lastMessageUnfinished,
            timeout: replyWait ? !quiet : !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
            waitedMs,
            preSleepWaitSatisfied: preSleepSatisfiedNow,
            preSleepWaitObserved: !replyWait && !!st.preSleepWaitObservedAt,
            // A reply check has no sleep countdown; showing one here suggests
            // the model should complete sleep observation before its first reply.
            ...(!replyWait ? { preSleepWaitMs, preSleepWaitRemainingMs: preSleepRemainingMs } : {}),
            newMessages,
            readThroughSeq,
            unreadCount: st.unread.length
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const tool = String(body.tool ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!key || !tool || !token) {
            sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
            return;
          }
          if (!agentTokenOk(key, token)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          if (!v2SessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
          const flag = flagMap[tool];
          if (!flag) {
            sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
            return;
          }
          if (!v2ToolEnabled(flag)) {
            sendJson(disabledByOwner(`qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}`, flag), 403);
            return;
          }
          sendJson({ ok: true, key, tool });
          return;
        }
        // ── Token 用量 / 花费（控制台专用） ──────────────────────────────────
        // 路径刻意不放在 /api/socialV2/ 下：那一整个前缀对持有 x-agent-token 的
        // QQ 侧 AI 是放行的（见上方 agentAllowed 白名单），而跨群花费属于管理信息，
        // 不应让某个群里的 AI 读到别的群烧了多少钱。这里再显式拒绝一次做双保险。
        if (url.pathname === '/api/tokens/summary' || url.pathname.startsWith('/api/tokens/')) {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          if (req.method === 'GET' && url.pathname === '/api/tokens/summary') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            sendJson({ ...tokenLedger.summary({ limit }), ledger: tokenLedger.stats() });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/series') {
            const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
            const maxBuckets = Math.min(120, Math.max(6, Number(url.searchParams.get('buckets')) || 48));
            sendJson(tokenLedger.series({ hours, maxBuckets }));
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/turns') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            const detail = tokenLedger.conversation(key, { turnLimit: limit });
            if (!detail) { sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404); return; }
            sendJson(detail);
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/recent') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
            sendJson({ ok: true, symbol: priceTable.symbol, entries: tokenLedger.recent(limit) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/tokens/reset') {
            tokenLedger.reset();
            log('控制台：token 用量账本已重置');
            sendJson({ ok: true });
            return;
          }
          sendJson({ ok: false, error: 'not found' }, 404);
          return;
        }
        // ── 工具调用日志 ─────────────────────────────────────────────────────
        // ── 日记本（她自己的本子 · 进阶1）─────────────────────────────────────
        // 只有两个动作：**写一条** 和 **看**。故意不提供删除、不提供改写、也不提供
        // "改成某一天"——日记是发生过的事，不是可以随时编辑的草稿；要改只能用户自己
        // 动手改 <DIARY_DIR>/YYYY-MM-DD.jsonl（目录由 config.json → socialV2.diary.dir 决定，
        // 默认 data/日记；这也正是选纯文本 .jsonl 的原因：
        // 双击能看、能 grep、能手改、备份就是复制）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/diary') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('writeDiary')) { sendJson(disabledByOwner('qq_write_diary', 'writeDiary'), 403); return; }
          const written = diaryWrite(diaryDir(), {
            text: body.text, mood: body.mood, title: body.title,
            tags: body.tags, source: body.source ?? 'qq', day: body.day, time: body.time
          });
          if (!written.ok) { sendJson({ ok: false, error: written.error }, 400); return; }
          log(`[diary] 她写了一条：${String(written.entry.内容).slice(0, 70)}`);
          appendActivity(`${key} [diary] 写日记：${String(written.entry.内容).slice(0, 50)}`);
          rebuildDiaryViewer();
          sendJson({ ok: true, key, entry: written.entry, stats: diaryStats(diaryDir()) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/diary') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('readDiary')) { sendJson(disabledByOwner('qq_read_diary', 'readDiary'), 403); return; }
          const day = String(url.searchParams.get('day') ?? '').trim();
          if (day) {
            const entries = diaryReadDay(diaryDir(), day);
            sendJson({ ok: true, key, day, count: entries.length, entries, text: formatDiaryEntries(entries, { empty: `${day} 那天没有写。` }) });
            return;
          }
          const n = Math.min(100, Math.max(1, Number(url.searchParams.get('n')) || 10));
          const entries = diaryRecent(diaryDir(), n);
          sendJson({ ok: true, key, n, count: entries.length, entries, text: formatDiaryEntries(entries), stats: diaryStats(diaryDir()) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
          sendJson({ ok: true, entries: readToolLog(limit) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch {}
          log('控制台：工具调用日志已清空');
          sendJson({ ok: true });
          return;
        }
        // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
          sendJson({ ok: true, entries: readFeedbackEntries() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          atomicWriteJson(FEEDBACK_FILE, []);
          log('控制台：清空 AI 反馈');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
          const rawMessage = String(body.message ?? '').trim();
          if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('feedback')) { sendJson(disabledByOwner('qq_report_feedback', 'feedback'), 403); return; }
          // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
          const fNow = Date.now();
          const fTimes = feedbackTimes.get(key) || [];
          const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
          const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
          if (fRecentMinute >= 5 || fRecentHour >= 20) {
            sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
            return;
          }
          fTimes.push(fNow);
          feedbackTimes.set(key, fTimes.slice(-100));
          const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
          const message = truncateText(rawMessage, maxLength);
          appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
          log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
          appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
          // ⭐ 真发一条 QQ 私信给主人（2026-10-20 主人要求）。
          //    之前这里只是 log 一句"可通知 owner"，**实际什么都没发** ⇒
          //    她反馈了也没人收到（主人的原话："说说出问题都没找我"）。
          //
          // 口径（主人选定）：
          //   · 由她自己判断该不该报（不是所有失败都推）
          //   · 同一问题反复发生**每次都报**（不去重）—— 她要知道问题还在
          //   · level 决定默认：warning / error 推，info 只记录（info 是"我想到一件事"）
          //   · 支持 body.notify（true/false）覆盖默认 —— 她说"这个一定要告诉他"时用
          const wantNotify = typeof body.notify === 'boolean'
            ? body.notify
            : (level === 'warning' || level === 'error');
          if (wantNotify && cfg.ownerQQ) {
            const ownerKey = `private:${cfg.ownerQQ}`;
            // ⚠️ 不 await：通知失败不该让她的工具调用失败（她那边已经够挫败了）。
            //    但失败必须落日志，否则又变成"悄悄没发出去"。
            const icon = level === 'error' ? '🔴' : level === 'warning' ? '⚠️' : 'ℹ️';
            const notifyText = `${icon} 小鲸鱼报个问题\n` + message.slice(0, 400);
            Promise.resolve()
              .then(() => sendToQQ(ownerKey, notifyText))
              .then(() => log(`[feedback] 已私信通知主人 ${cfg.ownerQQ}（${level}）`))
              .catch((e) => log(`[feedback] ⚠️ 通知主人失败：${e?.message ?? e}`));
            log(`[reserved2] ${level} 级反馈 → 已推给主人 ${cfg.ownerQQ}`);
          }
          sendJson({ ok: true, key, level, message });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMyRecent')) { sendJson(disabledByOwner('qq_get_my_recent_messages', 'getMyRecent'), 403); return; }
          const st = getSocialV2State(key);
          const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
          sendJson({ ok: true, key, messages: mine, readThroughSeq: readThroughSeqV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
          // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
          sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) { sendJson(disabledByOwner('qq_get_message_detail', 'getMessageDetail'), 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          try {
            const st = getSocialV2State(key);
            const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
            const forwardFields = found ? {
              forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
              hasForward: !!found.hasForward
            } : {};
            let info = null;
            // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
            if (found && found.messageId && String(found.messageId) !== messageId) {
              info = {
                sender: String(found.sender || ''),
                text: String(found.text || found.plain || '').slice(0, 200),
                userId: found.userId ? String(found.userId) : null,
                messageId: String(found.messageId),
                seq: found.seq
              };
            } else {
              info = await resolveReplyInfo(kind, id, messageId);
              if (!info && found) {
                info = {
                  sender: String(found.sender || ''),
                  text: String(found.text || found.plain || '').slice(0, 200),
                  userId: found.userId ? String(found.userId) : null,
                  messageId: found.messageId ? String(found.messageId) : null,
                  seq: found.seq
                };
              }
            }
            // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
            if (info && found) Object.assign(info, forwardFields);
            // 正文本就是 200 字符预览；显式告知截断，避免模型把预览当成全文。
            if (info) info.textTruncated = String(info.text ?? '').length >= 200;
            sendJson({ ok: true, key, messageId, info });
          } catch (error) {
            sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const id = String(url.searchParams.get('id') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
            return;
          }
          if (!agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const num = Number(keyMatch[2]);
          if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (!v2ToolEnabled('getForwardMsg')) {
            sendJson(disabledByOwner('qq_get_forward_msg', 'getForwardMsg'), 403);
            return;
          }
          // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
          const st = getSocialV2State(key);
          const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
          if (!seenInRecent && !seenInUnread && !seenInMemory) {
            sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
            return;
          }
          try {
            const data = await bot.raw('get_forward_msg', { id });
            const formatted = formatForwardResponse(data);
            const remember = (fid) => {
              if (!fid) return;
              let set = seenForwardIds.get(key);
              if (!set) {
                set = new Set();
                seenForwardIds.set(key, set);
              }
              set.add(fid);
              if (set.size > 1000) {
                for (const old of set) {
                  set.delete(old);
                  if (set.size <= 1000) break;
                }
              }
            };
            // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) remember(fid);
            }
            // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
            const nestedPreviews = [];
            const nestedIds = [];
            const seenNested = new Set();
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) {
                if (!seenNested.has(fid) && nestedIds.length < 5) {
                  seenNested.add(fid);
                  nestedIds.push(fid);
                }
              }
            }
            for (const fid of nestedIds) {
              try {
                const ndata = await bot.raw('get_forward_msg', { id: fid });
                const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
                for (const nm of nfmt.messages || []) {
                  for (const nfid of nm.nestedForwardIds || []) remember(nfid);
                }
                nestedPreviews.push({ id: fid, ...nfmt });
              } catch (error) {
                log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
                nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
              }
            }
            sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
          } catch (error) {
            log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const media = Array.isArray(body.media) ? body.media : [];
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getForwardMsg')) { sendJson(disabledByOwner('qq_get_forward_msg', 'getForwardMsg'), 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return; }
          if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return; }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, key, media, images });
          } catch (error) {
            log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getActiveMembers')) { sendJson(disabledByOwner('qq_get_active_members', 'getActiveMembers'), 403); return; }
          const st = getSocialV2State(key);
          const map = new Map();
          for (const m of st.recentMessages) {
            if (!m || m.isSelf) continue;
            const uid = m.userId ? String(m.userId) : '';
            const key2 = uid || String(m.sender || '未知');
            const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
            if (!cur.userId && uid) cur.userId = uid;
            cur.count += 1;
            if (m.time > cur.lastTime) cur.lastTime = m.time;
            if (m.isOwner) cur.isOwner = true;
            map.set(key2, cur);
          }
          const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
          sendJson({ ok: true, key, members });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/promise') {
          // 记一条「到点要做的事」。这是她能主动说"明早七点叫你"的**唯一**落点：
          // 说完不记下来，睡一觉就忘了；记下来之后桥接会在到点叫醒她。
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('promise')) { sendJson(disabledByOwner('qq_promise', 'promise'), 403); return; }
          const kind = String(body.kind ?? 'remind').trim();
          if (!Object.prototype.hasOwnProperty.call(PROMISE_KINDS, kind)) {
            sendJson({ ok: false, error: `kind 必须是 ${Object.keys(PROMISE_KINDS).join(' / ')}` }, 400);
            return;
          }
          const at = normalizePromiseAt(body.at ?? body.atMs);
          if (!at) { sendJson({ ok: false, error: 'at 必须是毫秒时间戳（或 ISO 时间字符串）' }, 400); return; }
          const now = Date.now();
          if (at <= now - PROMISE_EXPIRE_MS) {
            sendJson({ ok: false, error: '这个时间已经过去太久了，没法再排；请用未来的时间' }, 400);
            return;
          }
          const st = getSocialV2State(key);
          prunePromises(st, now);
          if ((st.promises ?? []).length >= 20) {
            sendJson({ ok: false, error: '约定太多了（上限 20 条），先做掉或删掉一些' }, 400);
            return;
          }
          const promise = {
            id: crypto.randomBytes(5).toString('hex'),
            kind,
            at,
            text: String(body.text ?? '').slice(0, 200),
            createdAt: now
          };
          if (!Array.isArray(st.promises)) st.promises = [];
          st.promises.push(promise);
          saveSocialV2State();
          schedulePromiseV2(key);
          const atDate = new Date(at);
          log(`[promise] ${key} 记下约定 ${kind}@${atDate.toLocaleString()}：${promise.text.slice(0, 40)}`);
          sendJson({
            ok: true,
            promise,
            atText: `${atDate.getMonth() + 1}/${atDate.getDate()} ${String(atDate.getHours()).padStart(2, '0')}:${String(atDate.getMinutes()).padStart(2, '0')}`,
            inText: humanGap(at - now),
            message: `记下了：${atDate.toLocaleString()}（还有 ${humanGap(at - now)}）${PROMISE_KINDS[kind]}${promise.text ? `：${promise.text}` : ''}。到点我会自己醒来做这件事。`
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/promise-done') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('promise')) { sendJson(disabledByOwner('qq_promise_done', 'promise'), 403); return; }
          const st = getSocialV2State(key);
          const id = String(body.id ?? '').trim();
          const done = [];
          for (const p of st.promises ?? []) {
            if (p.doneAt) continue;
            // 不传 id 就把**已经到点的**全划掉（"叫完起床顺手清掉"最常见）；
            // 传了 id 就只划那一条。
            const due = Number(p.at) <= Date.now() + PROMISE_FIRE_EARLY_MS;
            if (id ? p.id === id : due) {
              p.doneAt = Date.now();
              done.push(p);
            }
          }
          if (done.length) {
            prunePromises(st);
            saveSocialV2State();
            schedulePromiseV2(key);
            log(`[promise] ${key} 完成约定 ${done.length} 条`);
          }
          sendJson({ ok: true, doneCount: done.length, doneIds: done.map((p) => p.id), remaining: (st.promises ?? []).filter((p) => p && !p.doneAt).length });
          return;
        }
        // ── 语音通话（档 2）：AI 侧入口 ─────────────────────────────────────
        //
        // 只暴露「看状态 / 接听 / 挂断 / 说一句」，**不暴露拨号**（除非主人显式打开
        // config.call.allowOutbound）。打电话是很强的打扰：能力上"随时能拨"和
        // "该不该拨"是两件事，闸门必须留在主人这边。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/call-status') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (key && req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (key && req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('call')) { sendJson(disabledByOwner('qq_call_status', 'call'), 403); return; }
          const side = await callSidecarFetch('/status', { timeoutMs: 4000 });
          const qq = side.ok ? (side.data?.qq ?? null) : null;
          sendJson({
            ok: true,
            enabled: callEnabled(),
            allowOutbound: callCfg().allowOutbound === true,
            autoAnswer: callAutoAnswer(),
            // 只对管理员开放时，把这条约束一并回给工具面/控制台，
            // 否则她自己看到 autoAnswer=true 会以为"谁的电话都会接"。
            autoAnswerFrom: String(callCfg().autoAnswerFrom ?? 'owner'),
            activeKey: callKey || null,
            activeSeconds: callStartedAt ? Math.round((Date.now() - callStartedAt) / 1000) : 0,
            engineUp: side.ok,
            engineError: side.ok ? null : side.error,
            // 只给出「现在是不是在通话中」和音频电平这类**当下要用**的信息；
            // history（说过的话）属于对话内容，不通过工具面回传。
            // ⚠️ 状态字面量必须和 tools/call/call_state.py 的 STATE_IN_CALL 一致（'in_call' 下划线）。
            // 之前这里写成 'in-call'，导致通话中 inCall 恒为 false —— 工具面永远以为没在通话。
            //
            // 2026-10-25 再修一层：`qq.state` 是靠截图 + OCR/颜色认窗口得来的，通话窗口
            // 一旦读不出来（最小化、被挡、Chromium 残缓冲）就会回落成 'unknown'/'idle'，
            // 于是「明明在通话、工具面却说不 inCall」—— 她就会以为自己不在电话里。
            // `callKey` 是桥接自己绑的，比截图可信；两者取或。
            inCall: Boolean(callKey) || qq?.state === 'in_call',
            qqState: qq?.state ?? null,
            audio: side.ok ? (side.data?.engine?.audio ?? null) : null,
            stats: side.ok ? (side.data?.engine?.stats ?? null) : null
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/call-answer') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('call')) { sendJson(disabledByOwner('qq_call_answer', 'call'), 403); return; }
          const r = await callSidecarFetch('/answer', { method: 'POST', body: { real: true }, timeoutMs: 30000 });
          if (r.ok) { callKey = key; callStartedAt = Date.now(); log(`[call] ${key} 已接听`); }
          sendJson(r.ok ? { ok: true, key, ...(r.data ?? {}) } : { ok: false, error: r.error || r.data?.error || '接听失败' });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/call-hangup') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('call')) { sendJson(disabledByOwner('qq_call_hangup', 'call'), 403); return; }
          const r = await callSidecarFetch('/hangup', { method: 'POST', body: { real: true }, timeoutMs: 30000 });
          if (r.ok) { endCall('AI 挂断'); log(`[call] ${key} 已挂断`); }
          sendJson(r.ok ? { ok: true, key, ...(r.data ?? {}) } : { ok: false, error: r.error || r.data?.error || '挂断失败' });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/call-say') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const text = String(body.text ?? '').trim();
          if (!key || !text) { sendJson({ ok: false, error: 'key/text 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('call')) { sendJson(disabledByOwner('qq_call_say', 'call'), 403); return; }
          const r = await callSidecarFetch('/say', { method: 'POST', body: { text }, timeoutMs: 120000 });
          sendJson(r.ok ? { ok: true, ...(r.data ?? {}) } : { ok: false, error: r.error || r.data?.error || 'TTS 失败' });
          return;
        }
        // ── 本机执行面：跑命令 / 读文件 / 写文件 ────────────────────────────
        //
        // 主人 2026-10-25（m08727）：「我完全允许小鲸鱼在和我这个管理员聊天的地方
        // 运行一些命令消息」。起因是他发了 `原理图转MD-方法与复刻.md` 让她转成
        // word/pdf，她只能回「你装个 pandoc 就行…我念不了这种」——她连试都试不了。
        //
        // 三道闸，缺一不可：
        //   1) x-agent-token 有效（调用方就是她那个会话）；
        //   2) 会话在当前模式允许范围内（v2SessionAllowed）；
        //   3) **key 必须就是管理员私聊** —— 守卫（plugins/qq-agent-presets/
        //      qq-tool-restrict.mjs 的 HOST_EXEC_TOOLS）已经按会话分档拒过群聊与
        //      普通成员私聊，这里再查一次。这不是信不过守卫，而是：守卫活在 DSH
        //      进程里、（将来）可能被改错或被别的入口绕过，而桥接是最后一道门。
        //      三层里坏任何一层，另外两层还在。
        //   另有 `socialV2.tools.localExec` 开关，主人可在控制台随时关掉。
        //
        // ⚠️ 关于「这台电脑的手」的分量：它比 web_* 那套重得多。所以拒绝文案写清
        //    「只对管理员私聊开放」，而不是含糊的"无权"，免得她以为是故障反复重试。
        if (req.method === 'POST' && url.pathname.startsWith('/api/socialV2/host-')) {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('localExec')) { sendJson(disabledByOwner('qq_run_command', 'localExec', '需要本地命令能力时请主人到控制台打开'), 403); return; }
          const ownerPrivateKey = `private:${normalizeOwnerQQ(cfg.ownerQQ)}`;
          if (key !== ownerPrivateKey) {
            sendJson({
              ok: false,
              kind: 'ownerOnly',
              retryable: false,
              error: `本机执行只对管理员私聊开放（当前会话是 ${key}）`,
              hint: '在群里或别人的私聊里什么都不要做，也不要重试；如果对方确实需要，请他自己找主人。'
            }, 403);
            return;
          }
          const workdir = () => {
            const raw = String(body.cwd ?? '').trim();
            const base = raw || String(cfg.sessionCwd || '').trim() || ROOT;
            return path.resolve(base);
          };

          if (url.pathname === '/api/socialV2/host-run') {
            const command = String(body.command ?? '').trim();
            if (!command) { sendJson({ ok: false, error: 'command 不能为空' }, 400); return; }
            // 只挡「会把这台电脑不可逆地弄坏」的那几条：分区/引导/全盘清理。
            // 这不是能力限制（主人要的是"能干活"），而是防一次手滑把机器搞没 ——
            // 正常的 rm/del/格式化某个目录仍然放行。
            const denied = HOST_RUN_DENY_RE.find((re) => re.test(command));
            if (denied) {
              sendJson({
                ok: false,
                kind: 'deniedByBridge',
                retryable: false,
                error: `这条命令会不可逆地破坏这台电脑，已被桥接挡住：${command.slice(0, 120)}`,
                hint: '如果确实要做这件事，请主人自己在电脑上敲，不要代劳。'
              }, 403);
              return;
            }
            const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 60000, 1000), 600000);
            const kind = String(body.shell ?? 'cmd').toLowerCase() === 'powershell' ? 'powershell' : 'cmd';
            const t0 = Date.now();
            let r;
            try {
              r = kind === 'powershell'
                ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
                  { cwd: workdir(), timeout: timeoutMs, encoding: 'buffer', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
                : spawnSync('cmd.exe', ['/d', '/s', '/c', command],
                  { cwd: workdir(), timeout: timeoutMs, encoding: 'buffer', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
            } catch (error) {
              sendJson({ ok: false, error: `命令没能启动：${error?.message ?? error}` });
              return;
            }
            const clip = (text) => {
              const s = redactKnownTokensOnly(decodeShellOutput(text));
              return s.length > 20000 ? `${s.slice(0, 20000)}\n…（输出被截断，共 ${s.length} 字）` : s;
            };
            const out = clip(r.stdout);
            const err = clip(r.stderr);
            const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
            log(`[host] 跑命令（${kind}）exit=${r.status ?? 'null'} ${Date.now() - t0}ms：${command.slice(0, 160)}`);
            // ⚠️ 这里 **ok 恒为 true**：ok 表达的是「这次 API 调用本身成功」，
            //    不是「命令退出码为 0」。命令跑失败（exit 1、编译报错、找不到文件）
            //    是**正常结果**，必须原样交回给她判断 —— 如果把 ok 绑到退出码上，
            //    MCP 侧的 agentApi 会把 body.ok===false 当成桥接故障抛异常，
            //    于是「命令报错」就变成了「桥接 API 出错」，她会以为工具坏了。
            sendJson({
              ok: true,
              exitCode: r.status,
              signal: r.signal ?? null,
              timedOut,
              cwd: workdir(),
              ms: Date.now() - t0,
              stdout: out,
              stderr: err,
              ...(timedOut ? { note: `命令超过 ${timeoutMs}ms 没结束，已被中止；可以换后台写法或调大 timeoutMs。` } : {}),
              ...(r.error && !timedOut ? { note: `执行出错：${r.error.message}` } : {}),
              ...(r.status === 0 ? {} : { note: `命令退出码是 ${r.status ?? 'null'}（不是 0）——看 stderr 判断哪里不对。` })
            });
            return;
          }

          if (url.pathname === '/api/socialV2/host-read') {
            const target = String(body.path ?? '').trim();
            if (!target) { sendJson({ ok: false, error: 'path 不能为空' }, 400); return; }
            const file = path.resolve(workdir(), target);
            let st;
            try { st = fs.statSync(file); } catch (error) { sendJson({ ok: false, error: `读不到：${error?.message ?? error}`, path: file }); return; }
            if (st.isDirectory()) {
              const entries = fs.readdirSync(file, { withFileTypes: true }).slice(0, 500)
                .map((d) => `${d.isDirectory() ? '[dir] ' : '      '}${d.name}`);
              sendJson({ ok: true, path: file, kind: 'dir', count: entries.length, entries });
              return;
            }
            const maxChars = Math.min(Math.max(Number(body.maxChars) || 20000, 200), 60000);
            const offset = Math.max(Number(body.offset) || 0, 0);
            let text = '';
            try { text = decodeShellOutput(fs.readFileSync(file)); } catch (error) { sendJson({ ok: false, error: `读取失败：${error?.message ?? error}`, path: file }); return; }
            const all = redactKnownTokensOnly(text);
            const slice = all.slice(offset, offset + maxChars);
            sendJson({
              ok: true,
              path: file,
              kind: 'file',
              bytes: st.size,
              totalChars: all.length,
              offset,
              nextOffset: offset + slice.length < all.length ? offset + slice.length : null,
              text: slice
            });
            return;
          }

          if (url.pathname === '/api/socialV2/host-write') {
            const target = String(body.path ?? '').trim();
            if (!target) { sendJson({ ok: false, error: 'path 不能为空' }, 400); return; }
            const content = String(body.content ?? '');
            const file = path.resolve(workdir(), target);
            const append = body.append === true;
            try {
              fs.mkdirSync(path.dirname(file), { recursive: true });
              if (append) fs.appendFileSync(file, content, 'utf8');
              else fs.writeFileSync(file, content, 'utf8');
            } catch (error) {
              sendJson({ ok: false, error: `写入失败：${error?.message ?? error}`, path: file });
              return;
            }
            const st = fs.statSync(file);
            log(`[host] 写文件（${append ? '追加' : '覆盖'}）：${file}（${st.size} 字节）`);
            sendJson({ ok: true, path: file, mode: append ? 'append' : 'overwrite', bytes: st.size, chars: content.length });
            return;
          }

          sendJson({ ok: false, error: `没有这个本机执行端点：${url.pathname}` }, 404);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
          if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson(disabledByOwner('qq_memory_append', 'memory'), 403); return; }
          const st = getSocialV2State(key);
          appendMemoryV2(st, category, content, extra);
          sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const oldContent = String(body.oldContent ?? '').trim();
          const target = redactKnownTokensOnly(String(body.target ?? '').trim());
          const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
          const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
          const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
          const cleanNewExtra = {
            ...newExtra,
            pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
            participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
            motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
            target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
          };
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson(disabledByOwner('qq_memory_*', 'memory'), 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return; }
            if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
            if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return; }
            if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
            if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            // 身份只认 QQ 号：target 必须是 QQ 号；老数据可能还是昵称，允许按老 key 原地编辑
            // （但不新建昵称 key —— 那正是重复印象的来源）。
            const oldTarget = String(target ?? '').trim();
            if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友标识' }, 400); return; }
            const im = st.memberImpressions[oldTarget] || {};
            const newTarget = String(cleanNewExtra.target || oldTarget).trim();
            if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { sendJson({ ok: false, error: '非法的群友标识' }, 400); return; }
            if (newTarget !== oldTarget && !/^\d{5,12}$/.test(newTarget)) {
              sendJson({ ok: false, error: '改名时 target 必须是 QQ 号（昵称只能作为 displayName）' }, 400);
              return;
            }
            if (newContent !== undefined) {
              im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
            }
            if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
            if (cleanNewExtra.displayName !== undefined) im.displayName = String(cleanNewExtra.displayName).slice(0, 30);
            if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
            st.memberImpressions[newTarget] = im;
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const category = String(url.searchParams.get('category') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim();
          const archiveLimit = Number(url.searchParams.get('limit')) || undefined;
          // 日期维度（2026-10-27）：`day` 精确一天，`from`/`to` 给区间。
          // 三个都可以直接写人话，由 parseMemoryDay 解析（"10月22" / "昨天" / "3天前"）。
          const dayRaw = String(url.searchParams.get('day') ?? '').trim();
          const fromRaw = String(url.searchParams.get('from') ?? '').trim();
          const toRaw = String(url.searchParams.get('to') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (category && !['activeTopic', 'pendingThought', 'memberImpression', 'archive'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression / archive' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: disabledByOwner('qq_memory_query', 'memory') }, 403); return; }
          // ── 归档记忆（daily-memory.json）──────────────────────────────
          // 角色卡的索引块写着「更早的 N 条已归档，需要时用 qq_memory_query 检索」，
          // 那就是这里。不给 q 就按时间倒序翻最近的；给了 q 就按关键词命中数排序。
          // 给了日期就**先按日期圈范围**，再在范围内按关键词排序。
          const hasDateQuery = Boolean(dayRaw || fromRaw || toRaw);
          if (category === 'archive' || q || hasDateQuery) {
            const archive = searchDailyMemory(q, {
              limit: archiveLimit, maxChars: 8000,
              day: dayRaw || undefined, dayFrom: fromRaw || undefined, dayTo: toRaw || undefined
            });
            // 日期解析失败要说清楚，否则她会以为「那天没记东西」（两者完全不同）。
            // ⚠️ 解析失败时必须**在进结果分支之前**就返回提示 —— 否则 searchDailyMemory
            //    的 dateFiltered 会是 false，于是"上周三"这种说法会退回成"全部 50 条"，
            //    看起来像"查到了"，实际是**把没解析当成没过滤**（实测踩过）。
            const badDay = (dayRaw && !archive.day) || (fromRaw && !archive.dayFrom) || (toRaw && !archive.dayTo);
            if (badDay) {
              const badInput = [dayRaw, fromRaw, toRaw].filter(Boolean).join(' / ');
              sendJson({
                ok: true, key, category: 'archive', query: q,
                formatted: `【更早的记忆归档】没看懂日期「${badInput}」。`
                  + '可以换成这几种写法：2026-10-22 / 10月22 / 昨天 / 前天 / 3天前 / 上周三 / 这周三。'
                  + `（记忆整理到 ${archive.lastDigestDate || '未知'}，共 ${archive.totalDays} 天）`,
                dayParseFailed: true
              });
              return;
            }
            // ── 未来日期：算出本周三=明天时，别说"那天没记录" ────────────────
            // 「这天还没到」和「这天没记东西」是完全不同的两件事。
            // 前者是"你问得太早了"，后者是"真的没发生"。混在一起她会以为
            // 自己漏记了，或者反过来以为那天很空。
            const todayStr = (() => {
              const d = new Date();
              return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            })();
            const futureDay = archive.day && archive.day > todayStr ? archive.day : null;
            if (futureDay) {
              sendJson({
                ok: true, key, category: 'archive', query: q,
                day: archive.day,
                dayIsFuture: true,
                formatted: `【更早的记忆归档】「${futureDay}」那天**还没到**（今天是 ${todayStr}）—— 未来当然不会有记录。`
                  + (archive.day < todayStr ? '' : '如果你指的是**上一个**同一天，可以加「上」字（例如「上周三」）。'),
                raw: { archive }
              });
              return;
            }
            const dateLabel = archive.day ? `「${archive.day}」那天`
              : (archive.dayFrom || archive.dayTo) ? `「${archive.dayFrom || '(最早)'} ~ ${archive.dayTo || '(最近)'}」这段`
              : '';
            const head = archive.lines.length
              ? [
                  `【更早的记忆归档】（共 ${archive.totalItems} 条 / ${archive.totalDays} 天${archive.lastDigestDate ? `，整理到 ${archive.lastDigestDate}` : ''})`,
                  `> ${dateLabel || '全部'}：${archive.dateFiltered ? `那天/那段共 ${archive.poolItems} 条` : `共 ${archive.totalItems} 条`}${q ? `；检索「${q}」命中 ${archive.matched} 条` : ''}`,
                  '> 读法：每条前面的「私聊<QQ号>｜」「群<群号>｜」是**这条事发生在哪**。只有来源等于当前这个会话的，才算"对方跟我说过的话"；来源是别人的，你知道就好，不要拿去问当前这个人、更不要安到他头上。',
                  ...archive.lines,
                  archive.truncated
                    ? `> ${q ? `命中 ${archive.matched} 条` : `共 ${archive.matched} 条`}，只显示了前 ${archive.lines.length} 条，${q ? '可以换更具体的关键词再查' : '可以带关键词只查关心的那几条'}。`
                    : ''
                ].filter(Boolean).join('\n')
              : (archive.dateFiltered
                    ? `【更早的记忆归档】${dateLabel}没有记录（记忆整理到 ${archive.lastDigestDate || '未知'}，共 ${archive.totalDays} 天）。${q ? `也可能是那天没有「${q}」相关的事。` : ''}`
                    : (q
                        ? `【更早的记忆归档】检索「${q}」没有命中（共 ${archive.totalItems} 条 / ${archive.totalDays} 天）。可以换个词，或者不带关键词翻最近归档。`
                        : `【更早的记忆归档】目前是空的（还没有归档记录）。`));
            sendJson({
              ok: true,
              key,
              category: 'archive',
              query: q,
              day: archive.day,
              from: archive.dayFrom,
              to: archive.dayTo,
              formatted: head,
              raw: { archive }
            });
            return;
          }
          const st = getSocialV2State(key);
          const raw = {
            activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
            pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
            memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
          };
          if (category === 'activeTopic') {
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
          } else if (category === 'pendingThought') {
            raw.activeTopics = [];
            raw.memberImpressions = {};
          } else if (category === 'memberImpression') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
          }
          sendJson({ ok: true, key, category, formatted: formatMemoryV2({ ...st, ...raw }), raw });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const target = String(body.target ?? '').trim();
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return; }
          if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson(disabledByOwner('qq_memory_remove', 'memory'), 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            // target 优先当 QQ 号删；找不到再当"显示名"匹配一次，
            // 这样旧的昵称条目也能删掉，但绝不会新建昵称 key。
            const t = String(target ?? '').trim();
            if (!t || ['__proto__', 'constructor', 'prototype'].includes(t)) { sendJson({ ok: false, error: '非法的群友标识' }, 400); return; }
            if (st.memberImpressions[t]) {
              delete st.memberImpressions[t];
            } else {
              for (const [k, v] of Object.entries(st.memberImpressions)) {
                if (String(v?.displayName ?? '') === t || k === t) { delete st.memberImpressions[k]; break; }
              }
            }
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson(disabledByOwner('qq_memory_clear', 'memory'), 403); return; }
          const st = getSocialV2State(key);
          if (!category || category === 'activeTopic') st.activeTopics = [];
          if (!category || category === 'pendingThought') st.pendingThoughts = [];
          if (!category || category === 'memberImpression') st.memberImpressions = {};
          saveSocialV2State();
          sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st) });
          return;
        }
        // ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ─────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/slang/query') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangQuery')) { sendJson(disabledByOwner('qq_slang_query', 'slangQuery'), 403); return; }
          const list = confirmedSlangListV2().filter((e) => {
            if (!q) return true;
            return e.content.toLowerCase().includes(q)
              || e.meaning.toLowerCase().includes(q)
              || e.usage.toLowerCase().includes(q)
              || e.example.toLowerCase().includes(q);
          });
          sendJson({
            ok: true,
            key,
            total: list.length,
            entries: list,
            block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8)
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const content = redactKnownTokensOnly(String(body.content ?? '')).trim();
          const context = redactKnownTokensOnly(String(body.context ?? '')).trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangSubmit')) { sendJson(disabledByOwner('qq_slang_submit', 'slangSubmit'), 403); return; }
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return; }
          if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return; }
          if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return; }
          if (!allowSlangSubmit(key)) { sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return; }
          const existing = slangEntries.find((e) => e.content === content);
          if (existing) {
            if (existing.status === SLANG_STATUS.CONFIRMED) {
              sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: publicSlangEntry(existing) });
              return;
            }
            if (existing.status === SLANG_STATUS.REJECTED) {
              sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
              return;
            }
            // candidate：累计出现次数并追加语境证据
            existing.count = (Number(existing.count) || 0) + 1;
            if (context) {
              existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
            }
            existing.updatedAt = new Date().toISOString();
            saveSlangStore();
            if (cfg.slang?.autoResearch !== false) {
              const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
              if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
                queueSlangTask(() => runSlangResearch([existing]));
              }
            }
            log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
            sendJson({ ok: true, duplicate: true, status: 'candidate', entry: publicSlangEntry(existing) });
            return;
          }
          const entry = createSlangEntry({
            content,
            source: 'ai',
            status: SLANG_STATUS.CANDIDATE,
            evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          if (cfg.slang?.autoResearch !== false) {
            queueSlangTask(() => runSlangResearch([entry]));
          }
          log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
          appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
          sendJson({ ok: true, entry: publicSlangEntry(entry) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!token || !agentTokenOk(key, token)) {
            // 空 token 一律拒绝：该端点对 agent 流量开放（见 startConsoleServer 里的
            // agent 白名单），而 MCP 的 agentApi 总是带着真实控制台令牌，
            // 所以「不传 token 就跳过校验」等于把它变成免鉴权端点。
            sendJson({ ok: false, error: token ? 'agent token 无效' : '缺少会话令牌；旧只读工具在需要令牌的模式下不可用，请改用带会话令牌的 v2 读工具' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          sendJson({ ok: true, key });
          return;
        }
        // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/images/message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
          if (currentMode === 'reserved2' && !agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
            return;
          }
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' }, 403);
            return;
          }
          if (agentToken && !agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (agentToken && !v2ToolEnabled('getImages')) {
            sendJson(disabledByOwner('qq_get_message_images', 'getImages'), 403);
            return;
          }
          if (!agentToken && currentMode === 'closed-agent' && !v2ToolEnabled('getImages')) {
            sendJson(disabledByOwner('qq_get_message_images', 'getImages'), 403);
            return;
          }
          const media = findMessageMedia(key, messageId);
          if (!media.length) {
            sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
            return;
          }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, messageId, media, images });
          } catch (error) {
            log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
        if (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) {
          const body = await readBody();
          const token = String(body.token ?? '').trim();
          const isPrivate = url.pathname === '/api/send/private';
          const isReply = url.pathname === '/api/send/reply';
          const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
          const message = unquoteJsonString(String(body.message ?? '').trim());
          // 引用 id 与端点无关：/api/send/reply 与另两个端点都允许带（是否真的引用由下游按 id 判断）。
          // 旧写法 `isReply ? body.replyToMessageId : body.replyToMessageId` 两个分支一模一样，
          // 保留 isReply 变量只是为了下面的端点语义判断，别再让人以为这里有过分支逻辑。
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
          // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用；
          // chat/reserved 的自动转发已覆盖正常回复，MCP 发送工具不应成为 prompt injection 的越权出口。
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
            return;
          }
          if (socialV2.paused && token) {
            sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
            return;
          }
          if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return; }
          if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
            sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
            return;
          }
          if (currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
          if (token && !v2ToolEnabled(flag)) { sendJson(disabledByOwner(`qq_${flag}`, flag), 403); return; }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          // ⚠️ st / now 必须在 try **外面**：catch 里的「回滚预占额度」要用它们。
          //    曾经写在 try 里，于是「被移出群 / 网关超时 / 掉线」这类正常失败都会在
          //    catch 第一句抛 `st is not defined` —— 用户看到的是这个而不是真实原因，
          //    而且 sendJson 执行不到，请求一直挂到超时。
          const st = getSocialV2State(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sentMessages = await sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
            appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, 1 - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/session/reset') {
          const body = await readBody();
          const key = String(body.key ?? '');
          if (!key || !state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
          sessionEpoch++;
          const oldSessionId = state.sessions[key];
          delete state.sessions[key];
          modelAppliedSessions.delete(oldSessionId);
          // 权限元数据必须与映射一起删除，否则会永久残留在 sessions.json 里。
          delete state.sessionPolicies[key];
          reverse.delete(oldSessionId);
          collectors.delete(oldSessionId);
          sendToolSucceededSessions.delete(oldSessionId);
          pendingSendToolCalls.delete(oldSessionId);
          v2TurnStartAt.delete(oldSessionId);
          v2TurnLastEventAt.delete(oldSessionId);
          toolCallNames.delete(oldSessionId);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          social.silentTurns.delete(oldSessionId);
          social.exitingSessions.delete(oldSessionId);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          forgetAgentToken(key);
          // 清上下文不删记忆：话题 / 想法 / 印象 / 约定原样留下（2026-10-23 主人要求）。
          deleteConversationKeepingMemory(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 归档只隐藏会话，不终止 DSH 侧排队的工作；先清队列并取消当前回合。
          try { await api.stopSessionWork(oldSessionId); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await api.workspace.archiveSession({ sessionId: oldSessionId }); } catch {}
          log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已停止并归档）`);
          sendJson({ ok: true, key, archived: oldSessionId });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
          sessionEpoch++;
          let archivedCount = 0;
          let stoppedCount = 0;
          try {
            // 新版 DSH 不再提供 workspace.list；改为扫描本桥接创建的会话目录并归档。
            // 只处理 cwd 位于 qq-bridge state/ 下的根会话；子代理会话由父会话管理，不能误归档。
            const list = unwrap(await api.sessions.list({}), 'session.list');
            const stateDir = path.resolve(STATE_DIR);
            const statePrefix = path.normalize(stateDir + path.sep);
            const normPath = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep));
            const isUnderState = (cwd) => process.platform === 'win32'
              ? cwd.toLowerCase().startsWith(statePrefix.toLowerCase())
              : cwd.startsWith(statePrefix);
            for (const item of list.items ?? []) {
              if (item.origin === 'subagent' || item.parentSessionId) continue;
              const cwd = normPath(item.cwd);
              if (isUnderState(cwd)) {
                // 归档只隐藏会话；必须先把 DSH 侧排队的工作清掉并取消当前回合。
                try { await api.stopSessionWork(item.sessionId); stoppedCount += 1; }
                catch (error) { log(`⚠️ 停止旧会话失败 ${item.sessionId}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
                try { await api.workspace.archiveSession({ sessionId: item.sessionId }); archivedCount += 1; } catch {}
              }
            }
          } catch {}
          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            cancelPendingEntry(entry).catch(() => {});
          }
          pending.clear();
          queued.clear();
          queuedHintAt.clear();
          sessionPromises.clear();
          drainAllPromptQueues('工作区已清空');
          social.states.clear();
          social.recentMessages.clear();
          messageMediaStore.clear();
          seenForwardIds.clear();
          social.pendingSummaries.clear();
          social.silentContext.clear();
          social.silentTurns.clear();
          social.exitingSessions.clear();
          slangWindows.clear();
          slangExtractionCooldowns.clear();
          slangSubmitTimes.clear();
          cancelAllSocialTimers();
          clearAllSocialV2Timers();
          // 清空工作区 = 所有会话连同 token 一起作废，两张表整体清掉（比逐会话摘除更不容易漏）。
          socialV2.conversations.clear();
          CONVERSATION_TOKENS.clear();
          KNOWN_AGENT_TOKENS.clear();
          saveSocialV2State();
          state.sessions = {};
          state.sessionPolicies = {};
          reverse.clear();
          collectors.clear();
          sendToolSucceededSessions.clear();
          pendingSendToolCalls.clear();
          v2TurnStartAt.clear();
          v2TurnLastEventAt.clear();
          v2TurnRestored.clear();
          toolCallNames.clear();
          saveState();
          try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch {}
          log(`控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
          sendJson({ ok: true, archivedCount, stoppedCount });
          return;
        }
        // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/restart') {
          sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
          setTimeout(() => {
            log('控制台：重启桥接');
            // 退出前落盘：SIGINT/SIGTERM 的收尾路径会 saveState()/saveSocialV2State()，
            // 而重启这条路径以前直接 process.exit，500ms 窗口内改动的唤醒配置/计数器会丢。
            try { saveState(); } catch (error) { log('重启前保存会话映射失败:', error?.message ?? error); }
            try { saveSocialV2State(); } catch (error) { log('重启前保存二代会话状态失败:', error?.message ?? error); }
            releaseLock();
            process.exit(0);
          }, 500);
          return;
        }
        sendJson({ ok: false, error: 'not found' }, 404);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson({ ok: false, error: error?.message ?? String(error) }, status);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      log(`本地控制台已启动：http://127.0.0.1:${port}`);
      // 通话引擎跟着桥接一起起：否则每次重启桥接都要有人记得手动 /api/call/start，
      // 忘了就是「电话打得进来但没人接」——而那个失败只会在真来电时才发现。
      // 起它是异步的（ASR 模型要几十秒），失败也不该影响桥接本身，所以只记日志不抛。
      if (callEnabled()) {
        try {
          const started = startCallSidecar();
          if (!started.ok) log(`[call] 通话引擎自启失败：${started.error || '未知原因'}`);
        } catch (error) {
          log(`[call] 通话引擎自启异常：${error?.message ?? error}`);
        }
      }
    });
    // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
    server.on('error', (error) => {
      log(`控制台服务错误: ${error?.message ?? error}`);
      if (error?.code === 'EADDRINUSE') {
        console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        process.exit(2);
      }
      process.exit(1);
    });
    return server;
  }

  // 会话代际：reset/清空工作区时递增，防止在途 ensureSession 把旧会话"复活"
  let sessionEpoch = 0;

  // 待应答的提问/审批：convKey -> pending
  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }

  // QQ 发送队列（顺序发送 + 间隔，避免触发频率限制）
  let sendChain = Promise.resolve();
  function redactKnownTokensOnly(text) {
    let s = String(text ?? '');
    for (const token of KNOWN_AGENT_TOKENS) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    return s;
  }

  // 最近一次发送是否全部成功（按 key）。调用方据此决定要不要刷新「我发过言了」的时间戳 ——
  // 旧实现把发送失败吞成一行日志后**照常 resolve**，于是调用方以为发言成功，
  // 更新 lastAiReplyAt / 活跃调度，实际群里什么都没收到，而且只有一行滚动日志能看出问题。
  const lastSendFailed = new Map(); // key -> true（下一次成功即清除）

  function sendToQQ(key, msg) {
    const assertSendAllowed = captureSendGuard(key);
    const safeMsg = redactKnownTokensOnly(msg);
    const [kind, id] = key.split(':');
    const parts = splitForQQ(safeMsg);
    lastSendFailed.delete(key);
    for (const part of parts) {
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        })
        .catch((error) => {
          lastSendFailed.set(key, true);
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
        })
        .then(() => sleep(cfg.sendDelayMs));
    }
    return sendChain;
  }

  /** 上一批发往该会话的消息是否全部成功。 */
  function lastSendSucceeded(key) {
    return lastSendFailed.get(key) !== true;
  }

  // ── 真人式分条发送 ──────────────────────────────────────────────────────
  function singleLineForQQ(s) {
    return String(s ?? '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // 超长段落：先按次要标点拆，再按字符硬拆，保证不丢内容、不退回单条长消息。
  // URL 会被当作不可拆分的原子，避免把 https://... 这种整条网页地址拆断。
  function splitLongSegment(segment, max) {
    const s = String(segment ?? '').trim();
    if (!s) return [];
    const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
    if (s.length <= safeMax) return [s];

    const urlRe = /https?:\/\/[^\s，。；、]+/g;
    const urls = [];
    const masked = s.replace(urlRe, (m) => {
      urls.push(m);
      return `\u0000URL${urls.length - 1}\u0000`;
    });

    const raw = masked.split(/([，、；：,;:])/);
    const tokens = [];
    for (let i = 0; i < raw.length; i += 2) {
      tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
    }
    const out = [];
    let cur = '';
    // ⚠️ 占位符 \u0000URL<n>\u0000 必须是**不可切开的最小单位**。
    // 早先的实现对超长 token 直接按 safeMax 硬切，会把占位符拦腰截断
    // （如 "\u0000UR" + "L0\u0000"），后面的还原正则 \u0000URL(\d+)\u0000 就匹配不上 →
    // **URL 整条丢失 + 裸 NUL + 字面量 "URL0" 被发进 QQ 消息**（实测 13 个偏移里 5 个损坏）。
    // 这里改成按占位符边界切分，宁可某段略超 max 也绝不切碎占位符。
    const PLACEHOLDER_ANY = /\u0000URL\d+\u0000/;
    const PLACEHOLDER_ALL = /\u0000URL\d+\u0000/g;
    /** 把 token 切成 {text, isPlaceholder} 序列（占位符整体一块，绝不拆） */
    const splitByPlaceholder = (tok) => {
      const parts = [];
      let last = 0;
      let m;
      PLACEHOLDER_ALL.lastIndex = 0;
      while ((m = PLACEHOLDER_ALL.exec(tok)) !== null) {
        if (m.index > last) parts.push({ text: tok.slice(last, m.index), isPlaceholder: false });
        parts.push({ text: m[0], isPlaceholder: true });
        last = m.index + m[0].length;
      }
      if (last < tok.length) parts.push({ text: tok.slice(last), isPlaceholder: false });
      return parts;
    };
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok.length > safeMax) {
        if (cur) { out.push(cur); cur = ''; }
        for (const piece of splitByPlaceholder(tok)) {
          // 占位符整块输出；普通文本仍按 safeMax 切
          if (piece.isPlaceholder) { out.push(piece.text); continue; }
          for (let i = 0; i < piece.text.length;) {
            let end = Math.min(i + safeMax, piece.text.length);
            // 绝不在代理对（emoji、部分生僻字）中间下刀：硬切会产生「半个 emoji」，
            // 两个孤立代理各自成为一条 QQ 消息、永远无法再拼回，群友看到的就是乱码方块。
            // 退一格把整个字符让给下一段；若退成空串就不退（safeMax 极小时），
            // 宁可硬切也要保证循环一定前进。逻辑内联在此，函数保持自包含
            // —— test-voice.mjs 会把这个函数的源码单独 eval 出来测。
            if (end < piece.text.length && end - i > 1) {
              const last = piece.text.charCodeAt(end - 1);
              if (last >= 0xd800 && last <= 0xdbff) end -= 1;
            }
            out.push(piece.text.slice(i, end));
            i += end > i ? end - i : safeMax;
          }
        }
      } else if (cur.length + tok.length <= safeMax) {
        cur += tok;
      } else {
        out.push(cur);
        cur = tok;
      }
    }
    if (cur) out.push(cur);

    return out
      .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
      .filter(Boolean);
  }

  // 判断字符是否属于“中文汉字”范围，用于识别空格分句意图。
  // 注意：这里只认汉字，不认中文标点/全角符号，避免“你好， 世界”这种 AI 排版空格被误拆。
  function isCjkChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF)
    );
  }

  // 按“有意的空格”拆分：真人不会主动用空格，因此 AI 回复里的空格视为分条信号。
  // 空格两侧只要有一侧是中文/中文标点，就按分条处理（包括中英文/数字之间的空格）。
  // 注意：该逻辑只用于一代 reserved 的自动转发文本；二代 reserved2 不走这里，二代必须显式用数组分条。
  function splitByCjkSpaces(src) {
    const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length <= 1) return tokens;
    const groups = [];
    let cur = tokens[0];
    for (let i = 1; i < tokens.length; i++) {
      const prevLast = [...cur].pop() || '';
      const currFirst = [...tokens[i]][0] || '';
      // 空格两侧只要有一侧是汉字，就视为分条信号。
      if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
        groups.push(cur);
        cur = tokens[i];
      } else {
        cur = cur + ' ' + tokens[i];
      }
    }
    if (cur) groups.push(cur);
    return groups;
  }

  // 新分句逻辑：分句权交给 AI。
  // AI 用空格表示“这里要分成下一条消息”，桥接按空格拆条；
  // 不想分条时用标点连接、不加空格即可。单条消息只做 maxReplyChars（默认 500 字）安全硬拆。
  function planSocialTimeline(text, socialCfg) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
    const enabled = socialCfg?.burstEnabled !== false;
    if (!src) return { main: [], followUp: null };

    // 关闭分条：整条作为一条消息发送，只做安全硬拆
    if (!enabled) {
      return { main: splitLongSegment(src, maxChars).map(singleLineForQQ), followUp: null };
    }

    // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
    const parts = splitByCjkSpaces(src);
    if (parts.length <= 1) {
      return { main: splitLongSegment(parts[0] || src, maxChars).map(singleLineForQQ), followUp: null };
    }

    const main = [];
    for (const part of parts) {
      main.push(...splitLongSegment(part, maxChars).map(singleLineForQQ));
    }
    return { main: main.filter(Boolean), followUp: null };
  }

  // 分条发送：与 sendToQQ 共用同一 sendChain，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = redactKnownTokensOnly(messages[i]);
      const isLast = i === messages.length - 1;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          // 与 sendToQQ 同样的失败记账。少了这一步，调用方 `lastSendSucceeded(key)`
          // 会把「一条都没发出去」当成「我已经说过话了」：刷新 lastActiveMessageAt /
          // lastAiReplyAt 并抑制后续接话，而群里什么都没收到 —— 静默丢回复。
          lastSendFailed.set(key, true);
        });
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? randInt(longMin, longMax) : randInt(min, max);
        sendChain = sendChain.then(() => sleep(delay));
      }
    }
    return sendChain.then(() => sent);
  }


  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    segments.push({ type: 'text', data: { text: escapeCqText(rawMessage) } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  // ── 图片/表情字节解析（供一代自动内联与二代按需工具） ────────────────────
  function mimeFromBuffer(buf) {
    if (!buf || buf.length < 12) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
  }

  function mimeFromUrl(url, fallback = 'image/jpeg') {
    try {
      const pathname = new URL(String(url)).pathname.toLowerCase();
      if (pathname.endsWith('.png')) return 'image/png';
      if (pathname.endsWith('.webp')) return 'image/webp';
      if (pathname.endsWith('.gif')) return 'image/gif';
      if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    } catch {}
    return fallback;
  }

  // 解析常见图片宽高（PNG/JPEG/GIF；WebP 暂不解析返回 null）。
  // 用于限制“图片炸弹”的解码像素量。
  function getImageDimensions(buf) {
    if (!buf || buf.length < 24) return null;
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) { offset += 1; continue; }
          const marker = buf[offset + 1];
          if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          const len = buf.readUInt16BE(offset + 2);
          if (len < 2) return null;
          // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
          }
          offset += 2 + len;
        }
      }
      // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8X' && buf.length >= 30) {
          const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
          const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
          return { width, height };
        }
        if (fourcc === 'VP8L' && buf.length >= 25) {
          const bits = [buf[21], buf[22], buf[23], buf[24]];
          const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
          const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && buf.length >= 30) {
          const width = buf.readUInt16LE(26) & 0x3fff;
          const height = buf.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    } catch {}
    return null;
  }

  function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }

  // 单条消息的媒体上限。**可配置**（config.json → socialV2.media），默认值见下。
  //
  // 为什么做成函数而不是常量：群里很多原图超过 4 MB（手机直出），原来硬编码 4 MB
  // 会把它们一律判「超限」直接丢掉 —— 而主人明明收到了图，她却说「看不见」。
  // 现在默认抬到 8 MB，并且允许用 config 覆盖；像素上限与张数上限同理。
  //
  // ⚠️ 放宽的是**上限**，不是校验：字节数、像素数、张数仍然逐项检查，
  //   只是阈值可调。读配置失败一律退回默认值，绝不变成「无上限」。
  const MEDIA_LIMIT_DEFAULTS = Object.freeze({
    maxBytes: 8 * 1024 * 1024,   // 单条消息图片总字节上限
    maxPixels: 64_000_000,       // 单张图片像素上限，防止「图片炸弹」解码拖垮 DSH
    maxCount: 5,                 // 单条消息最多内联/返回的图片/表情数
  });
  // 硬天花板：再怎么写配置也不允许超过这些值。防止一句 `maxBytes: 1e12` 就绕过整层防护。
  const MEDIA_LIMIT_CEILINGS = Object.freeze({
    maxBytes: 32 * 1024 * 1024,
    maxPixels: 256_000_000,
    maxCount: 20,
  });
  function mediaLimit(name) {
    const def = MEDIA_LIMIT_DEFAULTS[name];
    const ceil = MEDIA_LIMIT_CEILINGS[name];
    const raw = Number(cfg.socialV2?.media?.[name]);
    if (!Number.isFinite(raw) || raw <= 0) return def;
    return Math.min(Math.max(1, Math.floor(raw)), ceil);
  }
  // 保留常量名以兼容既有调用点，但改成 getter 形式（每次读配置，控制台改完立即生效）。
  const MAX_MEDIA_BYTES = () => mediaLimit('maxBytes');
  const MAX_MEDIA_PIXELS = () => mediaLimit('maxPixels');
  const MAX_MEDIA_COUNT = () => mediaLimit('maxCount');
  const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长

  function isSafeLocalMediaPath(filePath) {
    try {
      const real = fs.realpathSync(String(filePath));
      const homeDir = cfg.snowluma?.homeDir ? String(cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + path.sep);
    } catch {
      return false;
    }
  }

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }

  async function fetchOneBotImage(media) {
    // 优先使用 OneBot get_image 获取网关侧信息；只有 file 是安全缓存文件名时才允许交给网关。
    if (media.kind === 'image' && media.file && isProbablySafeImageFileRef(media.file)) {
      try {
        const info = await bot.getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= MAX_MEDIA_BYTES()) {
            const buf = Buffer.from(base64, 'base64');
            if (buf.length > 0 && looksLikeImageBuffer(buf)) {
              const dims = getImageDimensions(buf);
              if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS()) {
                log(`get_image 返回的图片像素超限，已跳过（${dims.width}x${dims.height}）`);
              } else {
                return { buffer: buf, mimeType: mimeFromBuffer(buf) };
              }
            }
          } else {
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_BYTES());
          const dims = getImageDimensions(fetched.buffer);
          if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS()) {
            log(`get_image URL 图片像素超限，已跳过（${dims.width}x${dims.height}）`);
          } else {
            return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(obj.url) };
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = fs.statSync(obj.file);
          if (stat.size > MAX_MEDIA_BYTES()) {
            log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
          } else {
            const buf = fs.readFileSync(obj.file);
            const dims = getImageDimensions(buf);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS()) {
              log(`本地图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: buf, mimeType: mimeFromBuffer(buf) };
            }
          }
        }
      } catch (error) {
        log(`get_image 解析失败: ${error?.message ?? error}`);
      }
    }
    // 其次直接用消息段里的 URL
    if (media.url) {
      try {
        const fetched = await safeFetchBuffer(String(media.url), MAX_MEDIA_BYTES());
        const dims = getImageDimensions(fetched.buffer);
        if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS()) {
          log(`图片 URL 像素超限，已跳过（${dims.width}x${dims.height}）`);
        } else {
          return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(media.url) };
        }
      } catch (error) {
        log(`图片 URL 抓取失败: ${error?.message ?? error}`);
      }
    }
    return null;
  }

  /**
   * 表情 CDN 兜底是否启用。默认开。
   *
   * 为什么要可关：CDN 地址是靠 emoji_id **推**出来的（不是网关给的），
   * 万一哪天 QQ 改了路径规则，这条兜底会一直发无效请求、刷日志。
   * 有个开关就能先关掉、等规则更新，而不用改代码。
   */
  function emojiCdnFallbackEnabled() {
    return cfg.socialV2?.sticker?.cdnFallback !== false;
  }

  /**
   * QQ 表情包 CDN 的地址可以**只靠 emoji_id 推出来**（实测形态：
   * `https://gxh.vip.qq.com/club/item/parcel/item/<id 前两位>/<id>/raw300.gif`）。
   *
   * 为什么需要它：市场表情不在网关缓存里（`get_image` 返回 `image not found in cache`），
   * 而 `fetchFaceEntity` 有时**根本不带 url**。没有这条兜底时，那类表情只能退化成
   * 一行纯文本 `[表情#123]` —— 她永远看不见那张图。
   *
   * ⚠️ 安全：只接受**纯十六进制 id**（16~64 位）。绝不把任意字符串拼进 URL，
   *    否则这里就是一个开放重定向/SSRF 的出入口。
   */
  function emojiCdnCandidates(emojiId) {
    if (!emojiCdnFallbackEnabled()) return [];
    const id = String(emojiId ?? '').trim();
    if (!/^[0-9a-f]{16,64}$/i.test(id)) return [];
    return [`https://gxh.vip.qq.com/club/item/parcel/item/${id.slice(0, 2)}/${id}/raw300.gif`];
  }

  /**
   * 有些网关不带 emoji_id，但 `file` 名里就嵌着它（实测 `f9-<32 位 hex>.gif`）。
   * 从文件名里把那个 32 位 hex 抠出来，喂给 emojiCdnCandidates。
   */
  function emojiIdFromFileName(file) {
    const match = /(?:^|[^0-9a-f])([0-9a-f]{32})\.(?:gif|png|jpe?g|webp)$/i.exec(String(file ?? '').trim());
    return match ? match[1] : '';
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    if (!Number.isInteger(faceId)) return { text: `[表情#${media.faceId}]` };
    try {
      const face = await bot.fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        // 候选地址按「可信度」排：网关直接给的 url 优先，其次靠 emoji_id / 文件名推出来的 CDN 地址。
        // 市场表情常常没有 url，这条兜底就是它唯一的取图路径。
        const candidates = [];
        if (face.url) candidates.push(String(face.url));
        const emojiId = String(face.emoji_id || face.emojiId || face.resId || '').trim()
          || emojiIdFromFileName(face.file || media.file || '');
        for (const u of emojiCdnCandidates(emojiId)) {
          if (!candidates.includes(u)) candidates.push(u);
        }
        for (const candidate of candidates) {
          try {
            const fetched = await safeFetchBuffer(candidate, MAX_MEDIA_BYTES());
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS()) {
              log(`表情图片像素超限，已跳过（${dims.width}x${dims.height}）`);
              continue;
            }
            return {
              buffer: fetched.buffer,
              mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(candidate),
              text: desc ? `[表情:${desc}]` : ''
            };
          } catch (error) {
            // 单个候选失败不致命：还有下一个地址可试（这正是加兜底的意义）。
            log(`表情图片抓取失败（${candidate.slice(0, 60)}…）: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc}]` : `[表情#${media.faceId}]` };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    // 网关连 face 实体都拿不到时，仍然试一次 CDN 兜底（文件名里可能就嵌着 emoji_id）。
    const fallbackId = emojiIdFromFileName(media.file || '');
    for (const candidate of emojiCdnCandidates(fallbackId)) {
      try {
        const fetched = await safeFetchBuffer(candidate, MAX_MEDIA_BYTES());
        const dims = getImageDimensions(fetched.buffer);
        if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS()) continue;
        return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(candidate), text: '' };
      } catch (error) {
        log(`表情 CDN 兜底抓取失败: ${error?.message ?? error}`);
      }
    }
    return { text: `[表情#${media.faceId}]` };
  }

  async function resolveMediaList(mediaList) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT()) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT()}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES()) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += face.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          parts.push({ type: 'image', mediaType: face.mimeType || 'image/png', data: face.buffer.toString('base64'), name: `face-${media.faceId}.${(face.mimeType || 'png').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES()) {
            parts.push({ type: 'text', text: `[图片${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += img.buffer.length;
          parts.push({ type: 'text', text: `[图片${index}]` });
          parts.push({ type: 'image', mediaType: img.mimeType || 'image/jpeg', data: img.buffer.toString('base64'), name: `qq-image-${index}.${(img.mimeType || 'image/jpeg').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: `[图片${index}（获取失败）]` });
        }
      }
    }
    return parts;
  }

  async function fetchMediaData(mediaList) {
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT()) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : 'image', text: `（超过单条上限 ${MAX_MEDIA_COUNT()}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES()) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += face.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: face.mimeType || 'image/png',
            data: face.buffer.toString('base64'),
            text: face.text || ''
          });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES()) {
            out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += img.buffer.length;
          out.push({
            index,
            kind: 'image',
            file: media.file ? String(media.file) : undefined,
            url: media.url ? String(media.url) : undefined,
            mimeType: img.mimeType || 'image/jpeg',
            data: img.buffer.toString('base64'),
            text: ''
          });
        } else {
          out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（图片获取失败）' });
        }
      }
    }
    return out;
  }

  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    if (currentMode === 'reserved2') {
      return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}", messageId="${messageRef}"。`;
    }
    return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。`;
  }

  function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    // 二代：消息对象上直接带 media（仅在确实存在二代会话状态时读取，避免为 gen1 创建影子状态）
    if (currentMode === 'reserved2' || socialV2.conversations.has(key)) {
      try {
        const st = getSocialV2State(key);
        if (st) {
          // Unread can outlive the recent window. Compact model views retain
          // handles instead of transport URLs, so both buffers must resolve.
          for (const messages of [st.recentMessages, st.unread]) {
            const found = (Array.isArray(messages) ? messages : []).find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
            if (found && Array.isArray(found.media) && found.media.length) return found.media;
          }
        }
      } catch {}
    }
    // 一代/普通模式：messageMediaStore
    const byRef = messageMediaStore.get(key);
    if (byRef) {
      const hit = byRef.get(refStr);
      if (Array.isArray(hit)) return hit;
      // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === refStr && Array.isArray(media)) return media;
      }
    }
    return [];
  }

  function clampGapV2(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    return delays;
  }

  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    // ⭐ 通话中改道：她若在电话里又调 qq_send_message，话要进电话，不要进聊天窗。
    //    只在"纯文本发送"这一层拦 — 发图/发文件/发表情不受影响（那些在电话里本来也没意义，
    //    但也别悄悄吞掉，让它照常发）。
    if (callEnabled() && callKey && key === callKey) {
      const joined = messages.join('\n').trim();
      if (joined) {
        return callRerouteTextIfInCall(key, joined).then((r) => {
          if (r && r.ok) return [joined];
          const err = new Error(`通话中，这句话已改走电话（未发到聊天窗）${r?.error ? `：${r.error}` : ''}`);
          err.rerouted = 'call';
          throw err;
        });
      }
    }
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          await onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        sendChain = sendChain.then(() => sleep(d));
      }
    }
    return sendChain.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      return sent;
    });
  }

  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  function shouldAuditKey(key) {
    if (currentMode === 'closed-agent') {
      return !(key === `private:${String(cfg.ownerQQ ?? '')}`);
    }
    return true;
  }

  // 入队校验无法约束排队等待期间的权限变化，每条消息临近实际发送时再次校验。
  function captureSendGuard(key) {
    const policy = sessionPolicy(key);
    const sessionId = state.sessions[key];
    return () => {
      if (!isSessionAllowedInCurrentMode(key) || policy !== sessionPolicy(key)
          || (sessionId && state.sessions[key] !== sessionId)) {
        throw new Error('发送已取消：会话、模式或白名单已变化');
      }
    };
  }

  // 静默模式：除 owner 私聊外，不发送任何在途 AI 回复。
  function shouldBlockSilentReply(key) {
    const roleState = readRoleState();
    return roleState.mode === 'silent' && key !== `private:${String(cfg.ownerQQ ?? '')}`;
  }

  // 统一出站消息：先完整文本审计，再发送。返回是否真的发出。
  async function auditAndSend(key, text) {
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
      appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      if (cfg.security?.interceptNotify !== false) {
        await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
      }
      return false;
    }
    await sendToQQ(key, text);
    return true;
  }

  // 会话模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次；
  // 控制台热切换思考强度时递增 modelSelectionEpoch，使旧记录失效并在下一条消息重新应用。
  // 四种 QQ 模式共用 DSH 会话。config.json 的 dsh.provider/model/reasoningEffort 是
  // **新会话的默认值**；已存在的会话优先跟随用户在 DSH 界面里选定的模型。
  const modelAppliedSessions = new Map(); // sessionId -> 已应用的 modelSelectionEpoch
  // 本进程内是否已为该会话「播过种」（用 config 默认值真正调过一次 selectModel）。
  //
  // 为什么要这个集合：桥接重启后 modelAppliedSessions 清空，若此时会话里已是用户
  // 在 GUI 选的模型，旧逻辑会把它当成「配置漂移」强行改回 config 默认值 —— 用户看到
  // 的就是「每次重启小鲸鱼，模型都变回之前那个」。
  // 有了它就能区分两种情况：
  //   · 本进程还没为这个会话设过 → 这是重启后的第一次，会话里的模型是用户选的，跟随它；
  //   · 已经设过又发生漂移 → 多半是控制台改了思考强度或用户中途切换，按 config 改回。
  const modelSeededSessions = new Set();
  // 返回 'applied' | 'not-found' | 'failed'。
  // 'not-found' 表示 DSH 侧会话已经不存在（DSH 重启、异常退出、归档竞态），
  // 本地映射已失效，调用方必须退役重建，否则每条消息都会对着一个不存在的会话重试。
  async function ensureChatModel(sessionId) {
    if (modelAppliedSessions.get(sessionId) === modelSelectionEpoch) return 'applied';
    const provider = String(cfg.dsh?.provider || 'deepseek-official');
    const model = String(cfg.dsh?.model || 'deepseek-flash');
    const effort = String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT);
    // 幂等化：先看桥接已知的「会话实际生效值」（来自 model/selection 事件与开场快照投影）。
    const known = sessionModels.get(sessionId);
    if (known?.model && known.provider) {
      const same = String(known.model) === model
        && String(known.provider) === provider
        && String(known.reasoningEffort ?? effort) === effort;
      if (same) {
        modelAppliedSessions.set(sessionId, modelSelectionEpoch);
        return 'applied';
      }
      // 本进程还没为它播过种 ⇒ 桥接重启后第一次见到，尊重界面里的选择，不覆盖。
      if (!modelSeededSessions.has(sessionId)) {
        modelSeededSessions.add(sessionId);
        modelAppliedSessions.set(sessionId, modelSelectionEpoch);
        log(`会话模型跟随界面选择：${sessionId} 使用 ${known.provider}/${known.model}`
          + `(${known.reasoningEffort ?? '默认'})；`
          + `config 里的 ${provider}/${model}(${effort}) 只用于新建会话。`
          + `（想强制统一就改 config.json 的 dsh.model 并重启桥接）`);
        return 'applied';
      }
      const prefix = lastPrefixTokens.get(sessionId) ?? 0;
      const rates = ratesAt(model, Date.now(), priceTable);
      const extra = (prefix * ((rates.cacheMiss ?? 2) - (rates.cacheHit ?? 0.04))) / 1e6;
      log(`⚠ 检测到会话模型配置漂移：${sessionId} 当前 ${known.provider}/${known.model}`
        + `(${known.reasoningEffort ?? '默认'}) → 即将改回 ${provider}/${model}(${effort})。`
        + `这会改写请求前缀，使约 ${prefix} token 的缓存整段失效`
        + (prefix > 0 ? `（约 ¥${extra.toFixed(4)}）` : '')
        + `，下一次调用将按未命中计费。`);
    }
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = unwrap(await api.sessions.selectModel({ sessionId, provider, model, reasoningEffort: effort }), 'session.selectModel');
        modelAppliedSessions.set(sessionId, modelSelectionEpoch);
        modelSeededSessions.add(sessionId);
        log(`已设置会话模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'})`);
        return 'applied';
      } catch (error) {
        lastError = error;
        log(`设置会话模型失败 ${sessionId}（第 ${attempt}/2 次）: ${error?.message ?? error}`);
        if (attempt < 2) await sleep(1000);
      }
    }
    const message = String(lastError?.message ?? lastError ?? '');
    if (/not[- ]?found/i.test(message)) {
      // 终态失败：记下 epoch，避免退役前（或退役失败时）被反复重试刷屏。
      modelAppliedSessions.set(sessionId, modelSelectionEpoch);
      return 'not-found';
    }
    return 'failed';
  }

  async function ensureSession(key) {
    const epoch = sessionEpoch;
    const policy = sessionPolicy(key);
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    const existing = state.sessions[key];
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
      if (!isCurrentSession(key, existing)) {
        retireSession(key);
      } else {
        const applied = await ensureChatModel(existing);
        // DSH 侧会话已不存在（DSH 重启、异常退出、归档竞态）：本地映射已经失效，
        // 必须退役并重建，否则每条消息都会对着一个不存在的会话重试 selectModel。
        if (applied === 'not-found') {
          log(`会话 ${key} 在 DSH 侧已不存在，退役本地映射并在本次调用中重建`);
          retireSession(key);
        } else {
          if (epoch !== sessionEpoch || !isCurrentSession(key, existing)) throw new Error('会话创建期间已重置或权限已变化');
          return existing;
        }
      }
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);
    const promise = (async () => {
      const dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(STATE_DIR, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      let lastError = null;
      const preset = modePreset(key, currentMode, cfg);
      // 非 closed-agent（chat / reserved / reserved2，会话可能属于 QQ 群）必须 fail-closed：
      // 拿不到 qq-chat* 就拒绝建会话，绝不让 DSH 用默认 preset（standard）顶上——那会把
      // bash/文件读写等本地工具暴露给 QQ 群里的任何人（见 RULES.md「无本地工具」）。
      // closed-agent 仅 owner 私聊、本来就用完整工具面，回退不构成提权。
      const strictPreset = currentMode !== 'closed-agent';
      if (strictPreset && !preset) {
        const wanted = currentMode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
        throw new Error(`拒绝为 ${key} 创建会话：模式 ${currentMode} 需要 preset "${wanted}"，但它不在 DSH 可用清单中（${dshPresetIds.join(', ') || '未知'}）。回退到 DSH 默认 preset 会把本地工具暴露给 QQ 群；请先运行 node scripts/setup-dsh.mjs 并重启 DSH。`);
      }
      // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
      // 创建顺序有安全含义：
      //   1) workspace + agentPreset —— 正常路径；
      //   2) workspace 无 preset     —— 仅 closed-agent 允许的降级（那里本就是完整工具面）；
      //      群聊模式绝不走这一步：DSH 会给「无 preset 会话」套上默认 preset（standard）。
      for (const withPreset of strictPreset ? [true] : [true, false]) {
        try {
          const wsValue = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
          if (wsValue.created && cfg.workspaceTitle) {
            await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: cfg.workspaceTitle });
          }
          const params = { workspaceId: wsValue.workspace.workspaceId };
          if (withPreset && preset) params.agentPreset = preset;
          const value = unwrap(await api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          if (withPreset && preset) {
            log(`会话 ${key} 已挂载 preset ${preset}`);
          } else if (preset) {
            log(`⚠️ 会话 ${key} 未能挂载 preset ${preset}（${lastError?.message ?? '未知原因'}），已降级为无 preset 会话；请检查 ~/.dsh/.agent-presets/${preset} 后重启 DSH`);
          }
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sessionId) {
        throw new Error(`无法为 ${key} 创建 DSH 会话（模式 ${currentMode}，preset ${preset ?? '无'}）：${lastError?.message ?? '未知原因'}。已拒绝退化为 DSH 默认 preset 会话——那会把本地工具暴露给 QQ 群。`);
      }
      // 新版 DSH 事件流需要显式 follow 该会话，否则收不到 turn 事件。
      api.events.follow(sessionId);
      // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
      if (epoch !== sessionEpoch || policy !== sessionPolicy(key) || !isSessionAllowedInCurrentMode(key)) {
        log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await api.workspace.archiveSession({ sessionId }); } catch {}
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      state.sessions[key] = sessionId;
      state.sessionPolicies[key] = policy;
      reverse.set(sessionId, key);
      saveState();
      await ensureChatModel(sessionId);
      if (epoch !== sessionEpoch || !isCurrentSession(key, sessionId)) {
        if (state.sessions[key] === sessionId) retireSession(key);
        throw new Error('会话创建期间已重置或权限已变化');
      }
      log(`新会话 ${key} -> ${sessionId}（模式 ${currentMode}，preset: ${modePreset(key, currentMode, cfg) ?? '默认'}）`);
      return sessionId;
    })();
    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      // 只有仍持有该条目的 promise 才删除，避免旧 promise 误删 reset 后新建的 promise。
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  // ── 仿真群友社交引擎（仿真模式，内部标识 reserved） ────────────────────────
  const randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
  let selfNickname = 'deepseek'; // 机器人昵称（启动时从网关获取，识别"被提到"用）
  // 机器人自己的显示昵称与 QQ 号。**为什么单独存一份、而且必须注入提示词**：
  //   桥接自己判断「有没有被 @」用的是 selfNickname（见 nameMention 判定），但那个判断
  //   是桥接**内部**的 —— agent 看到的只是消息文本里的 `@小鲸鱼`，没人告诉它那就是它自己。
  //   于是它会把「@自己」当成「@别人」、已读不回（上游 issue #29 就是这么发现的）。
  //   这两个值专门给 buildWakePromptV2 拼【你的身份】用；拿不到时保持空串 → 不注入空行。
  let selfDisplayName = ''; // 原始大小写的昵称（给提示词看）
  let selfUserId = '';      // 自己的 QQ 号（字符串，at/引用段里带的就是它）
  const SILENT_TURN_TIMEOUT_MS = 300000; // 摘要静默名额 5 分钟未消费则作废，避免吞掉后续正常回复
  const social = {
    states: new Map(),             // key -> { phase: 'idle'|'active'|'probing'|'exiting', lastCheckAt, nextCheckAt, lastActiveMessageAt, activeEnteredAt, activeDeadlineAt, activeExitAt, probeDeadline }
    recentMessages: new Map(),     // key -> [{sender, text, time}]（最近消息窗口，AI 的"持续感知"）
    pendingSummaries: new Map(),   // key -> { items: [{sender, text, time}], since }（观望期未参与消息）
    silentContext: new Map(),      // key -> [{sender, text, time}]：选择性沉默但"已看到未回应"的消息，下次投递时带给模型
    loopTimer: null,
    silentTurns: new Map(),        // sessionId -> { id, ts }[]：待静默的摘要 turn 队列（FIFO + 超时回收）
    pendingTimers: new Map(),      // key -> Set<timerId>：社交排程中尚未触发的定时器
    exitingSessions: new Set()     // sessionId：当前正在等待“活跃超时退场”发言完成的 DSH 会话
  };

  // ── 二代仿真模式（reserved2）运行时状态与唤醒配置 ────────────────────────
  const socialV2 = {
    conversations: new Map(), // key -> state
    paused: false, // 控制台可暂停整个二代 AI 活动（停止唤醒/等待）
  };

  // 一代/普通模式的图片/表情元数据存储：key -> Map<messageId/seq, media[]>
  // 二代模式则直接存在 socialV2 会话的 recentMessages/unread 消息对象上。
  const messageMediaStore = new Map();
  // 二代会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>

  // ── 「向我申请」授权（手机 / 刷B站）─────────────────────────────────────────
  // 同一会话同时只挂一个待答复的申请：key -> { request, scope, resolve, timer }
  const pendingPermitRequests = new Map();
  // 等他回话的上限。给足 10 分钟 —— 他可能在开会/吃饭，不在电脑前；
  // 但也不能无限挂着把她的回合吊死（manifest 里 toolCallTimeoutMs 也是这个量级）。
  const PERMIT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

  // ── 模拟器（MuMu）随授权自动开关 ────────────────────────────────────────────
  //
  // 主人 2026-10-24 的要求：「授权到期时自动关闭模拟器」。
  //
  // 为什么要有这一套：手机工具走 adb，而 adb 连着的是 MuMu 模拟器。
  // 模拟器不开 ⇒ 她拿到授权也什么都做不了（实测：授权成功、一调 phone_status 就说没设备）。
  // 反过来，模拟器一直开着又白占内存，所以「跟授权同生共死」是最自然的生命周期。
  //
  // 🔑 关键取舍：**只关掉自己开的那一个**。
  //    如果模拟器本来就是开着的（主人在用、或上一轮还没关），那她授权到期时**不该**
  //    把主人的东西关掉。所以每次授权"启用"时记一个基线（`weStartedEmulator`），
  //    到期时只有这个标记为 true 才关。这比"到期就关"安全得多。
  //
  // ⚠️ 失败一律不阻塞授权：开关模拟器是**尽力而为**的附加动作。
  //    找不到 MuMuManager / 执行超时 / 没有实例 ⇒ 只写日志，授权照常生效/照常过期。
  //    绝不能因为"关不掉模拟器"就让她的授权卡住（那会把一个辅助功能变成故障源）。

  /** MuMu 的命令行管理工具。可用 config.json 的 socialV2.emulator.managerPath 覆盖。 */
  const EMULATOR_MANAGER_DEFAULT = 'D:\\MuMuPlayer\\nx_main\\MuMuManager.exe';
  /** 权威实例号。默认 1（这台机器上只有一个实例：MuMu安卓设备-1）。 */
  const EMULATOR_VMIDX_DEFAULT = '1';

  function emulatorCfg() {
    const e = cfg.socialV2?.emulator ?? {};
    return {
      enabled: e.enabled !== false,
      managerPath: String(e.managerPath ?? EMULATOR_MANAGER_DEFAULT).trim() || EMULATOR_MANAGER_DEFAULT,
      vmIndex: String(e.vmIndex ?? EMULATOR_VMIDX_DEFAULT).trim() || EMULATOR_VMIDX_DEFAULT,
      // 开机等多久再回报"起来了"（MuMu 冷启动 15~30 秒，给足余量）
      launchTimeoutMs: Math.max(5000, Number(e.launchTimeoutMs) || 60000),
      // 关机和启机命令的超时（单条命令本身很快）
      cmdTimeoutMs: Math.max(5000, Number(e.cmdTimeoutMs) || 30000)
    };
  }

  /** 同步小睡（仅用于等模拟器起来这种短等待；不阻塞事件循环的话请用 setTimeout）。 */
  function sleepMs(ms) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Number(ms) || 0)); } catch {}
  }

  /** 跑一次 MuMuManager，返回 {ok, out, err}。永不抛。 */
  function runEmulatorManager(args, timeoutMs) {
    const ec = emulatorCfg();
    if (!fs.existsSync(ec.managerPath)) {
      return { ok: false, error: `找不到 MuMuManager：${ec.managerPath}（可在 socialV2.emulator.managerPath 配置）` };
    }
    const r = spawnSync(ec.managerPath, args, {
      timeout: timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
      cwd: path.dirname(ec.managerPath)
    });
    if (r.error) return { ok: false, error: r.error.message };
    const out = String(r.stdout ?? '').trim();
    const err = String(r.stderr ?? '').trim();
    // MuMuManager 用 JSON 回执：errcode 0 才算成功（退出码有时是 0 但 errcode 非 0）。
    let code = 0;
    try {
      const j = JSON.parse(out);
      if (j && typeof j.errcode === 'number') code = j.errcode;
    } catch {}
    return { ok: code === 0, out, err, errcode: code };
  }

  /** 查询实例是否已经起来了。返回 true/false；查不到当 false（fail-closed，只会多开一次）。 */
  function emulatorRunning() {
    const ec = emulatorCfg();
    const r = runEmulatorManager(['info', '-v', ec.vmIndex], ec.cmdTimeoutMs);
    if (!r.ok) return false;
    try {
      const j = JSON.parse(r.out);
      const one = j[ec.vmIndex] ?? j;
      return one?.is_android_started === true || one?.is_process_started === true;
    } catch {
      return false;
    }
  }

  /**
   * 授权生效时把模拟器拉起来。返回 {started:boolean, note:string}。
   * `started` 表示"**这一次是我们开的**"，到期时据此决定要不要关。
   */
  function emulatorStartForGrant() {
    const ec = emulatorCfg();
    if (!ec.enabled) return { started: false, note: '模拟器自动开关未启用' };
    if (emulatorRunning()) {
      // 本来就是开着的 ⇒ 不记"我们开的"，到期也不关它。这是最要紧的一条。
      return { started: false, note: '模拟器原本就在运行，到期不关' };
    }
    const r = runEmulatorManager(['control', '-v', ec.vmIndex, 'launch'], ec.cmdTimeoutMs);
    if (!r.ok) {
      log(`[emulator] 启动失败：${r.error || r.err || r.out || `errcode=${r.errcode}`}`);
      return { started: false, note: '启动失败' };
    }
    const deadline = Date.now() + ec.launchTimeoutMs;
    while (Date.now() < deadline) {
      if (emulatorRunning()) {
        log(`[emulator] 已启动实例 ${ec.vmIndex}（授权生效时拉起，到期会自动关）`);
        appendActivity(`[emulator] 已启动模拟器实例 ${ec.vmIndex}`);
        return { started: true, note: '已启动' };
      }
      sleepMs(1500);
    }
    // 起了但没等到 android_started：仍然记为"我们开的"，否则会漏关。
    log(`[emulator] 启动命令已发，但 ${ec.launchTimeoutMs / 1000}s 内没等到就绪（仍会在到期时尝试关闭）`);
    return { started: true, note: '启动超时（仍会在到期时关闭）' };
  }

  /** 授权到期/收回时关掉——**只关我们自己开的那个**。 */
  function emulatorStopIfWeStarted(flagSet, key, scope) {
    const ec = emulatorCfg();
    if (!ec.enabled) return;
    if (!flagSet || !flagSet.weStartedEmulator) {
      // 不是我们开的（原本就在跑 / 没启用）⇒ 不碰。
      return;
    }
    // 只有 phone 这一档才会动模拟器；bili 到期不该关手机。
    if (String(scope ?? '') !== 'phone') return;
    // 同一个私聊还有别的有效授权（比如主人又续了一次）⇒ 别关，等他这次也过期。
    const live = activeGrant(readPermits(), key, 'phone');
    if (live) {
      log(`[emulator] ${key} 还有未到期的 phone 授权（剩 ${formatRemaining(live.expiresAt - Date.now())}），先不关模拟器`);
      return;
    }
    const r = runEmulatorManager(['control', '-v', ec.vmIndex, 'shutdown'], ec.cmdTimeoutMs);
    if (r.ok) {
      log(`[emulator] ${key} 的 phone 授权已结束，已关闭模拟器实例 ${ec.vmIndex}`);
      appendActivity(`[emulator] phone 授权结束，已关闭模拟器 ${ec.vmIndex}`);
    } else {
      log(`[emulator] 关闭失败：${r.error || r.err || r.out || `errcode=${r.errcode}`}`);
    }
  }

  /** 把「这次是不是我们开的」记进授权记录里（跨重启也留着）。 */
  function markGrantEmulatorFlag(key, scope, started) {
    const permit = readPermits();
    const g = permit?.grants?.[key]?.[scope];
    if (!g) return;
    g.weStartedEmulator = !!started;
    try { writePermits(prunePermits(permit)); } catch {}
  }

  /** 授权到期检查：找出已经过期、且当初是我们开的模拟器的 phone 授权，关掉它。 */
  function sweepExpiredEmulatorGrants() {
    const ec = emulatorCfg();
    if (!ec.enabled) return;
    let raw = null;
    try { raw = readJsonSafe(PERMIT_FILE, null); } catch { raw = null; }
    if (!raw || typeof raw !== 'object') return;
    const now = Date.now();
    let changed = false;
    for (const [key, perScope] of Object.entries(raw.grants ?? {})) {
      const g = perScope?.phone;
      if (!g || !g.weStartedEmulator) continue;
      if (Number(g.expiresAt) > now) continue;
      // 已过期且是我们开的 ⇒ 关。
      const live = activeGrant(readPermits(), key, 'phone');
      if (!live) {
        const r = runEmulatorManager(['control', '-v', ec.vmIndex, 'shutdown'], ec.cmdTimeoutMs);
        if (r.ok) {
          log(`[emulator] phone 授权到期（${key}），已自动关闭模拟器实例 ${ec.vmIndex}`);
          appendActivity(`[emulator] phone 授权到期，已自动关闭模拟器 ${ec.vmIndex}`);
        } else {
          log(`[emulator] 到期关闭失败：${r.error || r.err || r.out || `errcode=${r.errcode}`}`);
        }
      }
      delete g.weStartedEmulator;
      changed = true;
    }
    // 顺带清理：过期的整个 grant 由 prunePermits 收走（这里只在有变化时回写）。
    if (changed) {
      try { writePermits(prunePermits(raw)); } catch {}
    }
  }

  function readPermits() {
    // readPermitFile 的第二参是"读并解析"的回调；这里传 readJsonSafe 并把 fallback 固定成 null。
    return readPermitFile(PERMIT_FILE, (f) => readJsonSafe(f, null));
  }

  function writePermits(obj) {
    try {
      writePermitFile(PERMIT_FILE, obj);
    } catch (error) {
      log(`[permit] 写授权文件失败：${error?.message ?? error}`);
      throw error;
    }
  }

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  function normalizeSpeakerIdsV2(value) {
    if (value === undefined || value === null) return [];
    const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
    const seen = new Set();
    const clean = [];
    for (const v of rawList) {
      const s = String(v ?? '').trim();
      if (!/^[1-9]\d*$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20) break;
    }
    return clean;
  }

  function defaultWakeConfigV2() {
    const w = cfg.socialV2?.wake ?? {};
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }

  // 把“仍使用默认唤醒配置”的会话刷新为当前推荐/默认参数。
  // 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
  function refreshDefaultWakeConfigV2(st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfigV2();
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }

  // 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
  function refreshAllDefaultWakeConfigsV2() {
    let changed = false;
    for (const st of socialV2.conversations.values()) {
      if (refreshDefaultWakeConfigV2(st)) changed = true;
    }
    if (changed) saveSocialV2State();
    return changed;
  }

  // 沉睡前强制观察窗口：防止 AI 聊两句就立刻潜水。
  // 新规则：每次设置潜水/下一次唤醒前，AI 必须先进入一次“沉睡前观察”（qq_wait_for_messages(timeoutMs=preSleepWaitMs)）。
  // - 观察期间没人说话 → 可以设置唤醒并沉睡（preSleepWaitSatisfiedAt）。
  // - 观察期间有人发了新消息 → 等待工具会把新消息带回给 AI（preSleepWaitObservedAt）；
  //   AI 看过新消息后若判断没必要参与，可以直接沉睡；若参与了（发送/拍一拍），则下次想睡需重新观察。
  const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

  function hasExplicitEndV2(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    return EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
  }

  function isSleepingConfigV2(wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
  }

  function preSleepWaitBlockedV2(st) {
    if (!st) return false;
    const w = cfg.socialV2?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEndV2(st)) return false;
    const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 300000);
    const now = Date.now();
    // 已经连续安静满观察窗口：可以直接设置潜水。
    if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
    // 已经完整等过观察窗口且之后没有新消息：放行。
    if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
    // 已经做过一次沉睡前观察（可能等到了新消息并已把新消息返回给 AI），只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
    if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
    return true;
  }

  function computeWakeSafetyV2(wc) {
    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIdsV2(tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  function ensureWakeableV2(st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIdsV2(tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        clearTimeout(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfigV2();
      if (!opts.skipSave) saveSocialV2State();
      if (key) setupSleepTimerV2(key);
      log(`[reserved2] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }

  // ⭐ 清除会话上下文时保住"她记得什么"（2026-10-23 主人要求：清上下文 ≠ 清记忆）。
  // 以前清除上下文是直接 `socialV2.conversations.delete(key)`，会把 activeTopics /
  // pendingThoughts / memberImpressions / promises 一起删掉 —— 她记下来的东西，
  // 只要会话被重置一次就凭空消失（2026-10-23 实测两个会话的记忆就是这样丢的）。
  // 上下文该清的照清：消息记录、读水位、未读队列、唤醒计时、agentToken 都换新的；
  // 但"记忆"不属于上下文，必须原样留下来，没到点的约定还要把定时器重新挂上。
  // 返回保留下来的记忆条数（0 表示本来就没有）。
  function deleteConversationKeepingMemory(key) {
    const prev = socialV2.conversations.get(key);
    if (!prev) return 0;
    const snap = {
      activeTopics: Array.isArray(prev.activeTopics) ? prev.activeTopics : [],
      pendingThoughts: Array.isArray(prev.pendingThoughts) ? prev.pendingThoughts : [],
      memberImpressions: prev.memberImpressions && typeof prev.memberImpressions === 'object' ? prev.memberImpressions : {},
      promises: Array.isArray(prev.promises) ? prev.promises : []
    };
    socialV2.conversations.delete(key);
    const memCount = snap.activeTopics.length + snap.pendingThoughts.length
      + Object.keys(snap.memberImpressions).length + snap.promises.length;
    if (memCount === 0) return 0;
    const fresh = getSocialV2State(key);
    fresh.activeTopics = snap.activeTopics;
    fresh.pendingThoughts = snap.pendingThoughts;
    fresh.memberImpressions = snap.memberImpressions;
    fresh.promises = snap.promises;
    if (fresh.promises.length > 0) {
      try { schedulePromiseV2(key); }
      catch (error) { log(`⚠️ 重置后恢复约定定时器失败 ${key}：${error?.message ?? error}`); }
    }
    log(`清除会话上下文 ${key}：保留了 ${memCount} 项记忆（${snap.activeTopics.length} 话题 / ${snap.pendingThoughts.length} 想法 / ${Object.keys(snap.memberImpressions).length} 印象 / ${snap.promises.length} 约定）`);
    return memCount;
  }

  function getSocialV2State(key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfigV2(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        // 「自主回合」：这一轮是不是她自己起的头（见 AUTONOMOUS_WAKE_REASONS）。
        // 空间写操作（发/点赞/评论/删/改权限）只允许在自主回合里发生 —— 目的是让
        // "有人命令她去发一条" 在执行期就无法成立，而不是只靠提示词劝她别听。
        turnAutonomous: false,
        turnStartedAt: 0,
        lastAiReplyAt: 0,
        lastActionAt: 0,
        agentToken: crypto.randomBytes(16).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        // 生图按天计数（2026-10-29 放开给全体后加的日额度闸）：[{day:'2026-10-29',at,cost}]
        drawTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        replyCheckTimer: null,
        proactiveTimer: null,
        promiseTimer: null,
        lastIncomingAt: 0,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        lastReadThroughSeq: 0,
        modelSeenSeqs: new Set(),
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {},
        // 他口头跟她约的、需要"到点做"的事（叫起床/提醒/回来找他）。
        promises: [],
        promiseTimer: null
      };
      rememberAgentToken(key, st.agentToken);
      socialV2.conversations.set(key, st);
      scheduleProactiveCheckV2(key);
      setupSleepTimerV2(key);
    }
    return st;
  }

  function loadSocialV2State() {
    try {
      // 记下读取时刻的文件指纹。加载末尾会统一落盘一次（为了让 ensureWakeableV2
      // 中途的改动不丢），但如果这期间**别的进程**已经写过这个文件，我们手上的
      // 内存态就是旧的 —— 再写回去等于把它那份更新的状态覆盖掉。
      // 这不是假想：日志里出现过两个桥接实例同时启动，第二个实例在加载后立刻回写，
      // 把第一个实例刚更新的读水位/唤醒时间/转发 id 全部退回旧值。
      const fileStamp = (() => {
        try {
          const s = fs.statSync(SOCIAL_V2_FILE);
          return `${s.size}:${s.mtimeMs}`;
        } catch {
          return null;
        }
      })();
      const raw = readJsonSafe(SOCIAL_V2_FILE, null);
      socialV2.paused = raw?.paused === true;
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          const defaultWc = defaultWakeConfigV2();
          let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              triggers: { ...defaultWc.triggers, ...((val.wakeConfig?.triggers) ?? {}) }
            },
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            // ⚠️ fail-closed：重启时**强制清空**自主标记，不沿用文件里的值。
            // 理由：被重启打断的回合已经死了（模型那次 turn 不复存在），若把 true 读回来，
            // 重启后的第一个回合 —— 哪怕是"别人找她"的回合 —— 都会带着写权限，
            // 那正是最该避免的失败方向。宁可让她重建一次自主回合。
            turnAutonomous: false,
            turnStartedAt: 0,
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            drawTimes: Array.isArray(val.drawTimes)
              ? val.drawTimes.filter((t) => t && typeof t === 'object' && typeof t.day === 'string').slice(-200)
              : [],
            pendingWakeTimer: null,
            sleepTimer: null,
            replyCheckTimer: null,
            proactiveTimer: null,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
              ? Math.min(val.lastReadThroughSeq, Number(val.lastUnreadSeq) || 0) : 0,
            // 重启前还来不及补发的唤醒原因：读回来让下面重新排队，别把消息晾死。
            pendingWakeReasons: Array.isArray(val.pendingWakeReasons)
              ? val.pendingWakeReasons.filter((r) => r && typeof r === 'object' && typeof r.reason === 'string').slice(-20)
              : [],
            modelSeenSeqs: new Set(),
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            // 约定：只接住还没完成、还没过期的。过期的带回来只会让她醒来问"该干嘛"
            // 却什么都没发生（旧数据里那些叫不醒的约定就是这么卡住的）。
            promises: (() => {
              const now = Date.now();
              return (Array.isArray(val.promises) ? val.promises : [])
                .filter((p) => p && Number.isFinite(Number(p.at)) && !p.doneAt
                  && now - Number(p.at) < PROMISE_EXPIRE_MS)
                .slice(-20);
            })(),
            promiseTimer: null,
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })()
          };
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);
          rememberAgentToken(key, st.agentToken);
          socialV2.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          ensureWakeableV2(st, { skipSave: true, key });
          scheduleProactiveCheckV2(key);
          // 重启后把「约好的事」重新排上：定时器是内存里的，不重排等于约定消失。
          schedulePromiseV2(key);
        }
        // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途写盘覆盖未加载会话。
        // 但只有在文件仍是「我们读到的那一份」时才写：否则说明有另一个进程写过它，
        // 我们手里的内存态已经过时，回写会静默吞掉对方的新数据。
        const nowStamp = (() => {
          try {
            const s = fs.statSync(SOCIAL_V2_FILE);
            return `${s.size}:${s.mtimeMs}`;
          } catch {
            return null;
          }
        })();
        if (fileStamp !== null && nowStamp !== null && fileStamp !== nowStamp) {
          log('⚠️ state/social-v2.json 在本次加载期间被其它进程改写，跳过回写以免覆盖更新的状态（是否误开了第二个桥接实例？）');
        } else {
          saveSocialV2State();
        }
      }
    } catch (error) {
      log('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function saveSocialV2State() {
    try {
      const obj = { paused: socialV2.paused, conversations: Object.create(null) };
      for (const [key, st] of socialV2.conversations) {
        obj.conversations[key] = {
          wakeConfig: st.wakeConfig,
          recentMessages: st.recentMessages.slice(-200),
          unread: st.unread.slice(-100),
          lastWakeReason: st.lastWakeReason,
          turnAutonomous: st.turnAutonomous === true,
          turnStartedAt: st.turnStartedAt || 0,
          lastAiReplyAt: st.lastAiReplyAt,
          lastActionAt: st.lastActionAt,
          agentToken: st.agentToken,
          bootstrapSent: st.bootstrapSent,
          wakeTimes: st.wakeTimes.slice(-200),
          sendTimes: st.sendTimes.slice(-500),
          stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
          // 生图日额度计数必须落盘：否则桥接一重启，非主人的群就白拿新额度，
          // 「5 张/天」在重启面前形同虚设。
          drawTimes: Array.isArray(st.drawTimes) ? st.drawTimes.slice(-200) : [],
          lastIncomingAt: st.lastIncomingAt || 0,
          preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
          preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
          preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
          lastUnreadSeq: st.lastUnreadSeq || 0,
          lastReadThroughSeq: st.lastReadThroughSeq || 0,
          activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
          pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
          memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
          // 约定必须落盘：桥接半夜被重启（或 DSH 崩了重来）而约定没存下来，
          // 「明早叫我」就静默失效 —— 那是最难解释的一种失败。
          promises: Array.isArray(st.promises) ? st.promises.slice(-20) : [],
          // 繁忙期间被暂存的唤醒原因必须持久化：否则桥接在暂存与 turn/end 之间重启，
          // 这些原因会随内存一起消失，触发它的消息就被永久晾在 unread 里再也没人叫醒。
          pendingWakeReasons: Array.isArray(st.pendingWakeReasons) ? st.pendingWakeReasons.slice(-20) : [],
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)
        };
      }
      atomicWriteJson(SOCIAL_V2_FILE, obj);
    } catch (error) {
      log('保存 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function formatParticipationV2(st) {
    if (!st) return '';
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const fiveMin = 5 * 60 * 1000;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiCount = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < hour).length;
    const otherCount = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < hour).length;
    if (!aiCount && !otherCount) return '';
    const fiveMinOthers = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < fiveMin);
    const activeSenders = new Set(fiveMinOthers.map((m) => m && (m.sender || m.user_id || '?'))).size;
    const directUnread = Array.isArray(st.unread) ? st.unread.filter((m) => m && isDirectedAtAi(String(m.plain || m.text || ''))).length : 0;
    const lastAiGap = now - (Number(st.lastAiReplyAt) || 0);
    const recentAi2m = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 2 * 60 * 1000).length;
    let hint = '';
    if (directUnread > 0) {
      hint = '有人直接找你，优先回应；其余热闹可以挑着参与。';
    } else if (recentAi2m >= 2) {
      hint = '你刚刚已经连回过好几次了，这轮可以少说，但别直接消失；有值得接的仍要自然接一句。';
    } else if (lastAiGap < 120000) {
      hint = '你刚说过话，先听一会儿；有能接住的话再自然接，不用硬等点名。';
    } else if (aiCount >= 5) {
      hint = '你最近发言偏多，这轮可以少说，但遇到真正想说的仍主动说。';
    } else if (fiveMinOthers.length >= 10 || (fiveMinOthers.length >= 6 && activeSenders >= 3)) {
      hint = `群聊正热（近5分钟${fiveMinOthers.length}条${activeSenders ? `/${activeSenders}人` : ''}在聊），不用逐条关注；挑最值得接的一句主动参与，插不上再潜水。`;
    } else if (otherCount >= 10 && aiCount === 0) {
      hint = '群聊很热闹但没叫你，可以插一句有趣的，或只看不说。';
    } else if (otherCount < 3 && aiCount > 0) {
      hint = '群聊有点冷，不要一个人撑场；但有想法时仍可主动抛一句。';
    } else if (aiCount <= 1 && otherCount >= 10) {
      hint = '这轮可以简短接一句，别潜水；挑一个点参与。';
    }
    const burstText = fiveMinOthers.length ? `；近5分钟群聊 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}` : '';
    return `【参与度参考】你最近 1 小时发言 ${aiCount} 次，群友发言 ${otherCount} 条${burstText}。${hint}`;
  }

  function suggestQuietMsV2(st) {
    const defaultMs = Number(cfg.socialV2?.wait?.defaultQuietMs) || 8000;
    if (!st) return defaultMs;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return defaultMs;
    const text = String(last.tail || last.plain || last.text || '').trim();
    if (looksLikeUnfinished(text)) return 12000;
    const burst = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 15000).length;
    if (burst >= 3) return 12000;
    return defaultMs;
  }

  /**
   * 【约好的事】—— 他口头跟她说的、需要"到点做"的约定。
   *
   * 为什么必须有这个（而不是让她自己用 pendingThought 记）：
   *   pendingThought 是"我想说还没说的话"，没有时间概念、也不会到点叫她。
   *   而「明早七点叫我起床」这件事，**正确性完全依赖"现在到点没有"** ——
   *   她算不出来，也不该算。所以约定存在会话状态里，桥接到点主动唤醒她。
   *
   * 数据形状（存在 social-v2.json 的每个 conversation 里）：
   *   promises: [{ id, kind:'wakeup'|'remind'|'checkin', at: epochMs, atText:'7:30',
   *                text:'叫他起床', createdAt, firedAt?, doneAt?, note? }]
   *
   * ⚠️ 只保留未完成且未过太久（24h）的，避免越攒越多。
   */
  const PROMISE_KINDS = Object.freeze({
    wakeup: '叫他起床',
    remind: '提醒他',
    checkin: '回来找他'
  });
  // 约定到点后，最多提前多少毫秒就允许唤醒（给"差两分钟"留余地，但别提前太多）
  const PROMISE_FIRE_EARLY_MS = 30 * 1000;
  // 过了这个时间还没执行，就当错过了（不再半夜补一句"该起床了"）
  const PROMISE_EXPIRE_MS = 3 * 60 * 60 * 1000;

  function normalizePromiseAt(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    // 兼容秒级时间戳
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }

  function prunePromises(st, now = Date.now()) {
    if (!st || !Array.isArray(st.promises)) return;
    st.promises = st.promises.filter((p) => {
      if (!p || !Number.isFinite(Number(p.at))) return false;
      if (p.doneAt) return false;
      // 已经过点超过 EXPRE 的自动作废
      return now - Number(p.at) < PROMISE_EXPIRE_MS;
    }).slice(-20);
  }

  function formatPromisesV2(st) {
    if (!st || !Array.isArray(st.promises) || st.promises.length === 0) return '';
    const now = Date.now();
    const live = st.promises.filter((p) => p && Number.isFinite(Number(p.at)) && !p.doneAt);
    if (!live.length) return '';
    const lines = ['【约好的事】'];
    for (const p of live.slice(0, 10)) {
      const at = new Date(Number(p.at));
      const kindLabel = PROMISE_KINDS[p.kind] ?? '约定';
      const when = Number(p.at) <= now + PROMISE_FIRE_EARLY_MS
        ? '**就是现在**'
        : `还有 ${humanGap(Number(p.at) - now)}`;
      const hm = `${at.getMonth() + 1}/${at.getDate()} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
      lines.push(`- ${hm} ${kindLabel}${p.text ? `：${p.text}` : ''}（${when}）`);
    }
    lines.push('到点的就现在做，没到点的别提前；做了之后用 qq_promise_done 把它划掉，免得重复。');
    return lines.join('\n');
  }

  /**
   * 排一个约定：到点时唤醒她。
   *
   * ⚠️ 到点唤醒用的是 **`promise` 原因**，不是 proactiveCheck ——
   *    这是刻意的：proactiveCheck 属于"自主回合"（AUTONOMOUS_WAKE_REASONS），
   *    会顺手给她 QQ 空间的写权限。叫起床这件事不该带那个权限。
   *    而 `promise` 不在自主集合里 ⇒ fail-closed，她只能说话/记事，不能对外发内容。
   */
  function schedulePromiseV2(key) {
    const st = getSocialV2State(key);
    if (!st) return;
    prunePromises(st);
    if (st.promiseTimer) {
      clearTimeout(st.promiseTimer);
      st.promiseTimer = null;
    }
    const now = Date.now();
    const pending = (st.promises ?? []).filter((p) => p && !p.doneAt && Number(p.at) > now - PROMISE_EXPIRE_MS);
    if (!pending.length) return;
    // 取最近的一条：一次只排一个，醒来后（或划掉后）会重排下一条。
    pending.sort((a, b) => Number(a.at) - Number(b.at));
    const next = pending[0];
    const delay = Math.max(0, Number(next.at) - now) + 500;
    // setTimeout 上限 2^31-1；更远的约定按上限续期。
    const MAX_TIMEOUT_MS = 100009;
    const arm = Math.min(delay, MAX_TIMEOUT_MS);
    st.promiseTimer = setTimeout(() => {
      st.promiseTimer = null;
      if (delay > MAX_TIMEOUT_MS) { schedulePromiseV2(key); return; }
      const due = (st.promises ?? []).filter((p) => p && !p.doneAt && Number(p.at) <= Date.now() + PROMISE_FIRE_EARLY_MS);
      if (!due.length) { schedulePromiseV2(key); return; }
      for (const p of due) p.firedAt = Date.now();
      saveSocialV2State();
      log(`[promise] ${key} 约定到点：${due.map((p) => `${PROMISE_KINDS[p.kind] ?? p.kind}@${new Date(Number(p.at)).toLocaleTimeString()}`).join('，')}`);
      void sendWakePromptV2(key, 'promise').catch((error) => log(`[promise] 到点唤醒失败 ${key}: ${error?.message ?? error}`));
      // 不等这一轮结束，先把下一条排上（sendWakePromptV2 内部会处理"繁忙暂存"）。
      setTimeout(() => schedulePromiseV2(key), 30000).unref?.();
    }, arm);
    st.promiseTimer.unref?.();
    log(`[promise] ${key} 已排约定唤醒：${new Date(Number(next.at)).toLocaleString()}（${Math.round(delay / 1000)}s 后）`);
  }

  function formatMemoryV2(st) {
    if (!st) return '';
    const lines = [];
    const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
    if (topics.length) {
      lines.push('【进行中的话题】');
      for (const t of topics.slice(-10)) {
        const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
        const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
        lines.push(`- ${t.text}${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
      }
    }
    const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)) : [];
    if (thoughts.length) {
      lines.push('【你想说但还没说的】');
      for (const t of thoughts.slice(-10)) {
        lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
      }
    }
    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    const names = Object.keys(impressions);
    if (names.length) {
      lines.push('【对群友的印象】（以 QQ 号为准；后面的昵称只是显示名，可能是本人乱起或别人给的）');
      for (const name of names.slice(-10)) {
        const im = impressions[name] || {};
        const traits = Array.isArray(im.traits) ? im.traits : [];
        // name 现在是 QQ 号；旧数据是昵称（纯数字才加 QQ 前缀，兼容老状态）
        const label = /^\d{5,12}$/.test(name)
          ? `QQ${name}${im.displayName ? `（显示名"${im.displayName}"）` : ''}`
          : `${name}（历史条目，无 QQ 号）`;
        lines.push(`- ${label}：${traits.length ? traits.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
      }
    }
    return lines.join('\n');
  }

  function appendMemoryV2(st, category, content, extra = {}) {
    if (!st) return;
    const text = redactKnownTokensOnly(String(content ?? '')).trim();
    const cat = String(category || '').trim();
    // 轻量清理：过期想法移除；超过 24h 未提起的话题移除（避免无限膨胀）。
    if (Array.isArray(st.pendingThoughts)) {
      st.pendingThoughts = st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
    }
    if (Array.isArray(st.activeTopics)) {
      st.activeTopics = st.activeTopics.filter((t) => t && (!t.lastMentionAt || Date.now() - Number(t.lastMentionAt) < 24 * 60 * 60 * 1000));
    }
    if (cat === 'activeTopic' && text) {
      if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
      const existing = st.activeTopics.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.lastMentionAt = Date.now();
        if (Array.isArray(extra.participants)) {
          const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => redactKnownTokensOnly(String(p)))]);
          existing.participants = [...set].slice(0, 10);
        }
        if (extra.pendingQuestion) existing.pendingQuestion = truncateText(redactKnownTokensOnly(String(extra.pendingQuestion)), 200);
      } else {
        st.activeTopics.push({
          text: truncateText(text, 200),
          lastMentionAt: Date.now(),
          participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redactKnownTokensOnly(String(p))).slice(0, 10) : [],
          pendingQuestion: redactKnownTokensOnly(String(extra.pendingQuestion || '')).slice(0, 200)
        });
      }
      if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
    } else if (cat === 'pendingThought' && text) {
      if (!Array.isArray(st.pendingThoughts)) st.pendingThoughts = [];
      const existing = st.pendingThoughts.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.createdAt = Date.now();
        existing.expiresAt = Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000);
        if (extra.motivation) existing.motivation = redactKnownTokensOnly(String(extra.motivation)).slice(0, 50);
      } else {
        st.pendingThoughts.push({
          text: text.slice(0, 200),
          createdAt: Date.now(),
          expiresAt: Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
          motivation: redactKnownTokensOnly(String(extra.motivation || 'curiosity')).slice(0, 50)
        });
      }
      if (st.pendingThoughts.length > 20) st.pendingThoughts.splice(0, st.pendingThoughts.length - 20);
    } else if (cat === 'memberImpression') {
      // ⭐ 身份只认 QQ 号：key = QQ 号，昵称只作 displayName。
      //
      // 旧写法拿昵称当 key，同一个人先后用 QQ 号、群名片、"大帅哥"、"栖筠"
      // 写进去，就成了**同一个人的多份印象**（实测 private:100000003 里
      // 同时有 "100000003" 和 "栖筠" 两条，其实是同一个人）。她读到两份
      // 互相矛盾的印象，就会把不同会话里的这个人和那个人串起来。
      const targetRaw = String(extra.target || '').trim();
      if (!targetRaw || ['__proto__', 'constructor', 'prototype'].includes(targetRaw)) return;
      // 只有纯数字（QQ 号）才当身份；昵称一律只作显示名，绝不拿来当 key。
      const uid = /^\d{5,12}$/.test(targetRaw) ? targetRaw : '';
      if (!uid) {
        // 没给 QQ 号就没有可靠身份 —— 不落库，免得又造出一份"找不到人"的印象。
        // 调用方（MCP）已提示必须传 QQ 号。
        log(`[memory] memberImpression 缺少 QQ 号（收到 "${targetRaw.slice(0, 20)}"），已拒绝写入`);
        return;
      }
      if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
      const old = st.memberImpressions[uid] || {};
      // 上限 20 条、每条 120 字（可配 social.memory.impressionMaxChars）。
      //
      // 原来是 10 条 / 50 字 —— 50 字把印象切在最关键的地方。真实损失：
      // 她写「今天午休醒了以后问「那我是你的谁呀」…之前说自己要每天被我主动找到。
      // 爱问、不真记仇。」落库只剩前 50 字，「关系定位」和「不真记仇」全丢了，
      // 下次读到就只剩一句没头没尾的转述。
      // 120 字：那句完整话 68 字，留 1.7 倍余量够写完「问了什么 + 我怎么答 + 结论」，
      // 又不至于让每条都变长句（10 条 × 120 = 1200 字符 ≈ 460 token，是每次注入的实数）。
      // 20 条对齐 memory-update 端点（:8848 的 slice(0, 20)），两处不再打架。
      const impressionMaxChars = impressionTraitMaxChars();
      const impressionsMax = IMPRESSION_MAX_TRAITS;
      const traits = Array.isArray(old.traits) ? old.traits.slice(0, impressionsMax) : [];
      const traitText = text.slice(0, impressionMaxChars);
      // 去重按**原文**比：50 字截断时，两条只在后半句不同的印象会被判成同一条而丢掉一条。
      if (traitText && !traits.includes(traitText)) {
        traits.push(traitText);
        if (traits.length > impressionsMax) traits.splice(0, traits.length - impressionsMax);
      }
      // 显示名：调用方可以顺手给一个，只用于展示，不参与身份判断。
      const displayName = String(extra.displayName || old.displayName || '').trim();
      st.memberImpressions[uid] = {
        traits,
        displayName: displayName.slice(0, 30),
        interactionCount: (Number(old.interactionCount) || 0) + 1,
        lastSeenAt: Date.now()
      };
      const impressionEntries = Object.entries(st.memberImpressions);
      if (impressionEntries.length > 50) {
        impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
        for (let i = 0; i < impressionEntries.length - 50; i++) {
          delete st.memberImpressions[impressionEntries[i][0]];
        }
      }
    }
    saveSocialV2State();
  }

  loadSocialV2State();

  function isSocialEnabled() {
    return currentMode === 'reserved' && cfg.social?.enabled !== false;
  }

  function socialState(key) {
    if (!social.states.has(key)) {
      social.states.set(key, { phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0, activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0, lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0 });
    }
    return social.states.get(key);
  }

  // 启动阶段的"明确与 AI 有关"：@ / 提到名字 / 必回关键词 / 管理员私聊
  function isDirectAddress(textContent, event, kind) {
    if (kind !== 'group') return true;
    const lower = String(textContent ?? '').toLowerCase();
    const selfId = String(event?.self_id ?? '');
    if (selfId && lower.includes('@' + selfId)) return true;
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  // 是否"直接针对 AI"的提问/挑战：提到 AI 相关词且带疑问/比较，或对"你"开火，或追问催促
  function isDirectedAtAi(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    const aiMention = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
    const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
    const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
    if (aiMention && (question || challenge)) return true;
    // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
    if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
    if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
    // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
    if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
    // 追问/催促：AI 没回时的真人式催促
    if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
    return false;
  }

  // 活跃期批量检测用的"必须回"判断：不依赖 event，只认昵称/关键词/直接针对 AI 的提问
  function isMustReplyText(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  function appendRecentMessage(key, sender, textContent, plainText, quoteTargetIsSelf = false, isOwner = false, media = [], messageRef = '') {
    if (!social.recentMessages.has(key)) social.recentMessages.set(key, []);
    const arr = social.recentMessages.get(key);
    arr.push({
      sender,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainText ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      media: Array.isArray(media) ? media : [],
      messageId: messageRef ? String(messageRef) : '',
      hasMedia: Array.isArray(media) && media.length > 0,
      time: Date.now()
    });
    const cap = Math.max(50, Number(cfg.social?.contextWindow ?? 15) * 2);
    while (arr.length > cap) arr.shift();
  }

  function appendSummary(key, sender, textContent, plainText, isOwner = false, media = [], messageRef = '') {
    if (!social.pendingSummaries.has(key)) {
      social.pendingSummaries.set(key, { items: [], since: Date.now() });
    }
    const entry = social.pendingSummaries.get(key);
    entry.items.push({ sender, text: truncateText(String(textContent), 200), plain: truncateText(String(plainText ?? textContent), 200), isOwner: !!isOwner, media: Array.isArray(media) ? media : [], messageId: messageRef ? String(messageRef) : '', hasMedia: Array.isArray(media) && media.length > 0, time: Date.now() });
    if (entry.items.length > 60) entry.items.shift();
  }

  function buildContextBlock(key) {
    const ctx = (social.recentMessages.get(key) ?? []).slice(-Number(cfg.social?.contextWindow ?? 15));
    return ctx.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n') || '（无）';
  }

  // 触发进入活跃（启动阶段 → 活跃阶段）
  function enterActive(key) {
    const now = Date.now();
    const st = socialState(key);
    st.phase = 'active';
    st.lastCheckAt = now;
    st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
    st.lastActiveMessageAt = now;
    st.activeEnteredAt = now;
    st.probeDeadline = 0;
    // 从进入活跃那一刻起，随机一个“最长活跃持续时间”；到点后主动收尾退场（当前仅群聊启用）
    if (key.startsWith('group:') && cfg.social?.activeDurationEnabled !== false) {
      st.activeDeadlineAt = now + randInt(
        Number(cfg.social?.activeDurationMinMs ?? 15 * 60 * 1000),
        Number(cfg.social?.activeDurationMaxMs ?? 30 * 60 * 1000)
      );
    } else {
      st.activeDeadlineAt = 0;
    }
    st.activeExitAt = 0;
  }

  function cancelSocialTimers(key) {
    const timers = social.pendingTimers.get(key);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    social.pendingTimers.delete(key);
  }

  function cancelAllSocialTimers() {
    for (const timers of social.pendingTimers.values()) {
      for (const t of timers) clearTimeout(t);
    }
    social.pendingTimers.clear();
  }

  // 离开仿真模式时清理全部社交运行时状态，避免旧定时器/状态残留。
  function cleanupSocialForModeChange() {
    cancelAllSocialTimers();
    social.states.clear();
    social.recentMessages.clear();
    messageMediaStore.clear();
    social.pendingSummaries.clear();
    social.silentContext.clear();
    social.silentTurns.clear();
    social.exitingSessions.clear();
    // 拒绝仍在排队中的 prompt，避免调用方 await 永远挂起
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error('模式切换，已取消排队中的投递'));
    }
    promptQueues.clear();
  }

  function leaveActive(key) {
    cancelSocialTimers(key);
    social.states.delete(key);
    social.silentContext.delete(key);
  }

  // 活跃阶段：只贴"没给过 AI 的新消息"（上下文在会话历史里，不重复贴，不贴人格）
  // allowSilent=false 表示这条必须回（被 @/点名/私聊等），不提供 [SILENT] 出口。
  function buildBatchPrompt(key, newMsgs, allowSilent = true) {
    const lines = newMsgs.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n');
    const directionHint = lines.includes('[引用') ? `${DIRECTION_HINT}\n` : '';
    if (!allowSilent) {
      return `【新消息】\n${lines}\n\n${directionHint}请回复消息。\n${SPACE_SPLIT_HINT}`;
    }
    return `【新消息】\n${lines}\n\n${directionHint}请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${SPACE_SPLIT_HINT}`;
  }

  // 冷场试探：让 AI 基于会话自然说一句（只给状态背景，不注入"试探"意图）
  function buildProbePrompt(key) {
    return `【群聊上下文】\n${buildContextBlock(key)}\n\n群里安静了一会儿，你可以说点什么。如果不想说，请只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
  }

  // 活跃超时退场：让 AI 自然地说一句收尾/潜水话，说完后安静下来。
  // 只给“该收尾了”的暗示，不暴露桥接的计时机制。
  function buildActiveExitPrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n你已经参与群聊有一阵子了，现在该自然地收尾/潜水了。请说一句简短的退场话（例如“我先潜水了”“你们聊，我摸鱼去了”），说完后就安静下来，不再继续接话。`;
    return p;
  }

  // 活跃超时判定：到达进入活跃时随机出的最长时间后，安排一次“收尾退场”投递，
  // 并把状态切到 exiting（退场中），等待 AI 的退场发言完成后再回到观望。
  function triggerActiveDurationExit(key, st, now) {
    if (!st || st.phase !== 'active') return false;
    if (!key.startsWith('group:')) return false; // 仅群聊启用，私聊不自动退场
    if (cfg.social?.activeDurationEnabled === false) return false;
    const deadline = st.activeDeadlineAt || 0;
    if (!deadline || now < deadline) return false;
    if (st.phase === 'exiting') return true;
    st.phase = 'exiting';
    st.activeExitAt = now;
    // 先取消尚未触发的旧回复/补刀定时器，避免退场期间再冒出旧发言
    cancelSocialTimers(key);
    const roleHint = roleHintForCurrentMode();
    const promptText = buildActiveExitPrompt(key, roleHint);
    scheduleSocialReply(
      key, promptText,
      Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
      Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
      '活跃超时退场',
      true
    );
    log(`社交模式：${key} 活跃超过时长上限，提示 AI 收尾退场`);
    return true;
  }

  // 二期：观望阶段主动开话题（第三种触发）
  function buildProactivePrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n群内已经长时间没人说话了，你打算开启一个新话题。优先结合你的人格/角色设定的兴趣，其次结合群里大家的兴趣，挑一个合适的话题。可以联网搜索一些新鲜话题来聊。如果你觉得现在不适合开口，可以只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
    return p;
  }

  // 实际的 DSH prompt 投递（不再直接对外暴露，统一走 promptQueues 串行队列）。
  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    // Recheck queued wakes at dispatch time: no model call while paused/disabled
    // and no reserved2 prompt leaking into an ordinary chat after a mode switch.
    const wakeBlocked = () => opts.wakeReason && (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false);
    const skipWake = () => {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      return { ok: true, skipped: true };
    };
    if (wakeBlocked()) return skipWake();
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
      return { ok: true, queued: true };
    }
    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    let wakeState;
    let wakeToken;
    let wakeSnapshot;
    if (opts.wakeReason) {
      if (wakeBlocked()) return skipWake();
      // Build only after session creation: retries may rotate the token, and an
      // offline queue may have received more messages since this wake was queued.
      wakeState = getSocialV2State(key);
      wakeToken = wakeState.agentToken;
      promptText = buildWakePromptV2(key, opts.wakeReason);
      wakeSnapshot = buildWakeSnapshotV2(key);
      if (wakeSnapshot) {
        promptText += `\n\n【本次消息快照】\n${JSON.stringify(wakeSnapshot)}\n以上消息已提供，无需重复查询；partial=true 时用 qq_get_unread_messages(afterSeq=readThroughSeq) 继续读取。先处理当前消息；回复前如需确认后续补充，用 qq_wait_for_messages(purpose="reply") 补足短静默，已安静够久会立即返回，不要先长等。收尾只确认你已处理的 readThroughSeq（本地 seq，非 QQ messageId），传给 qq_mark_read 或 qq_set_wake_config 的 throughSeq；新到消息留待处理。`;
      }
    }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(opts.media) && opts.media.length > 0) {
      const imageParts = await resolveMediaList(opts.media);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    // ★投递方式：steer 还是 queue（2026-10-22 主人报的问题）★
    //
    // 主人原话：「当她一直玩游戏就不会反应我的新消息了」。
    // 实测根因：桥接一直用 `mode: 'queue'`，而 DSH 的 prompt 有两种投递方式
    // （见 dsh-host-apiproxy 的 sessionPromptRequestSchema）：
    //   · 'queue' → agent.followup(message)：**等当前回合彻底结束后**才作为下一轮处理；
    //   · 'steer' → agent.steer(message)：插进**正在跑的回合**，在下一步就看得见它
    //     （inbox 的 next-step，placement='steering'）。
    // 她玩一局游戏能连续跑 20 多分钟（掷骰子→看回合→再掷），这期间主人发的每一条
    // 都只进 pendingWakeReasons 排队，要等整局结束——体验上就是"不理人"。
    //
    // 所以：没带 wakeReason 的**即时消息投递**（也就是主人当场发来的话）走 steer，
    // 让它在当前回合的下一步就插进去；带 wakeReason 的（定时唤醒/主动机会）
    // 仍走 queue —— 那本来就是"新开一轮"，插进去反而会打乱她正在做的事。
    //
    // ⚠️ 只对"人当场在说话"成立：steer 会让模型在当前回合里被打断去看新消息，
    //    这是主人想要的（"我说话你得听得见"）；自动唤醒不该有这种能力。
    const promptMode = opts.wakeReason ? 'queue' : 'steer';
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    if (opts.farewell) social.exitingSessions.add(sessionId);
    let accepted;
    try {
      accepted = await api.sessions.prompt({ sessionId, mode: promptMode, content });
    } catch (error) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      // steer 被拒（比如 agent 其实已经空闲/正在结束）不是错误 —— 退回 queue 再投一次，
      // 别让主人的一句话因为抢不到插队窗口就丢了。
      if (promptMode === 'steer') {
        try {
          accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
          log(`[投递] ${key} steer 失败（${error?.message ?? error}），已退回 queue`);
        } catch (retryError) {
          if (opts.farewell) social.exitingSessions.delete(sessionId);
          throw retryError;
        }
      } else {
        throw error;
      }
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      if (!opts.silent) await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return { ok: false, error: safeErrText };
    }
    if (wakeSnapshot && isCurrentSession(key, sessionId)
        && socialV2.conversations.get(canonicalV2Key(key)) === wakeState
        && wakeState.agentToken === wakeToken) {
      // Acceptance grants visibility, never acknowledgement. New arrivals and
      // rejected/stale deliveries must not be cleared by an old cursor.
      noteModelMessagesV2(wakeState, [...wakeSnapshot.messages, ...wakeSnapshot.recent]);
    }
    if (accepted.result.value.command?.text && !opts.silent && currentMode !== 'reserved2') {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      social.exitingSessions.delete(sessionId);
    }
    return { ok: true };
  }

  // 每个 QQ 会话串行投递 DSH prompt，保证 turn 完成顺序与提交顺序一致，
  // 从而让 [SILENT]、摘要静默、退场标记都能准确匹配到自己的 turn。
  function deliverPrompt(key, promptText, opts = {}) {
    return new Promise((resolve, reject) => {
      let entry = promptQueues.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        promptQueues.set(key, entry);
      }
      entry.queue.push({ promptText, opts, resolve, reject });
      processPromptQueue(key);
    });
  }

  async function processPromptQueue(key) {
    const entry = promptQueues.get(key);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) promptQueues.delete(key);
      return;
    }
    entry.running = true;
    try {
      const result = await deliverPromptNow(key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      entry.running = false;
      if (promptQueues.get(key) === entry) {
        if (entry.queue.length) processPromptQueue(key);
        else promptQueues.delete(key);
      }
    }
  }

  function scheduleSocialReply(key, promptText, minDelay, maxDelay, label, farewell = false, media = null) {
    const delay = randInt(minDelay, maxDelay);
    log(`社交模式：${label} ${key}，延迟 ${Math.round(delay / 1000)}s 后投递`);
    const timer = setTimeout(() => {
      const timers = social.pendingTimers.get(key);
      if (timers) {
        timers.delete(timer);
        if (timers.size === 0) social.pendingTimers.delete(key);
      }
      deliverPrompt(key, promptText, { farewell, media: media ?? [] }).catch((error) => log(`社交投递异常 ${key}: ${error?.message ?? error}`));
    }, delay);
    const timers = social.pendingTimers.get(key) ?? new Set();
    timers.add(timer);
    social.pendingTimers.set(key, timers);
  }

  // 全局扫描：驱动观望期主动开话题、活跃期检测、冷场处理、试探回退
  function socialLoopTick() {
    if (!isSocialEnabled()) return;
    const now = Date.now();
    // 所有"发过消息或已有状态"的群都参与状态机（观望中的群也做主动判定）
    const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
    for (const key of keys) {
      const st = socialState(key);
      if (st.phase === 'idle') {
        // ── 观望阶段：第三种触发（主动开话题，仅群聊生效） ─────────────────
        if (cfg.social?.proactiveEnabled !== false && key.startsWith('group:')) {
          const arr = social.recentMessages.get(key) ?? [];
          const lastMsgTime = arr.length ? arr[arr.length - 1].time : 0;
          const idleThreshold = Number(cfg.social?.proactiveIdleThresholdMs ?? 1800000);
          if (now - lastMsgTime >= idleThreshold) {
            if (!st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
            }
            if (now >= st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
              if (Math.random() < Number(cfg.social?.proactiveProbability ?? 0.2)) {
                enterActive(key);
                const roleHint = roleHintForCurrentMode();
                const promptText = buildProactivePrompt(key, roleHint);
                scheduleSocialReply(
                  key, promptText,
                  Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                  Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                  '主动开话题'
                );
                log(`社交模式：${key} 观望期主动开话题，进入活跃`);
              }
            }
          }
        }
      } else if (st.phase === 'active') {
        // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
        if (triggerActiveDurationExit(key, st, now)) continue;
        if (now >= st.nextCheckAt) {
          const newMsgs = (social.recentMessages.get(key) ?? []).filter((m) => m.time > st.lastCheckAt);
          st.lastCheckAt = now;
          st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
          if (newMsgs.length) {
            st.lastActiveMessageAt = now;
            const mustReply = key.startsWith('private:') || newMsgs.some((m) => m.quoteTargetIsSelf || isMustReplyText(m.plain ?? m.text));

            // 选择性沉默：只对非必须回的普通闲聊生效；直接提问/点名永远走正常回复
            if (!mustReply) {
              // 基准沉默概率；刚发过言后有人快速接话时不沉默，避免“活跃到一半突然不接”
              let skipProb = Math.min(1, Math.max(0, Number(cfg.social?.skipProbability ?? 0.3)));
              const sinceAiReply = now - (st.lastAiReplyAt || 0);
              if (sinceAiReply < 60000) skipProb = 0;
              const pressure = Math.min(0.5, newMsgs.length * 0.1);
              skipProb = Math.max(0, skipProb - pressure);
              if (Math.random() < skipProb) {
                log(`社交模式：活跃期 ${key} 跳过 ${newMsgs.length} 条普通消息（选择性沉默，skip=${skipProb.toFixed(2)}）`);
                // 真人"看到了但没回"：保留到 silentContext，下次投递时一起带给模型
                const silent = social.silentContext.get(key) ?? [];
                silent.push(...newMsgs);
                social.silentContext.set(key, silent.slice(-30));
                for (const m of newMsgs) appendSummary(key, m.sender, m.text, m.plain ?? m.text, m.isOwner, m.media ?? [], m.messageId ?? '');
                continue;
              }
            }

            // 投递时把之前沉默但"已看到未回应"的消息一并带给模型（真人视角：我看到过，只是当时没接）
            const seenMsgs = social.silentContext.get(key) ?? [];
            const promptMsgs = [...seenMsgs, ...newMsgs];
            social.silentContext.delete(key);
            const promptText = buildBatchPrompt(key, promptMsgs, !mustReply);
            const batchMedia = promptMsgs.flatMap((m) => Array.isArray(m.media) ? m.media : []);
            scheduleSocialReply(
              key, promptText,
              Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
              Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
              '活跃期回应',
              false,
              batchMedia
            );
            log(`社交模式：活跃期 ${key} 检测到 ${newMsgs.length} 条新消息${seenMsgs.length ? `（含 ${seenMsgs.length} 条之前沉默的）` : ''}`);
          } else if (now - st.lastActiveMessageAt >= Number(cfg.social?.idleWindowMs ?? 180000)) {
            // 冷场：大概率回观望；小概率让 AI 说一句（试探群友是否还在）
            if (Math.random() < Number(cfg.social?.idleRetryProbability ?? 0.25)) {
              st.phase = 'probing';
              st.probeDeadline = now + Number(cfg.social?.idleRetryWaitMs ?? 120000);
              const promptText = buildProbePrompt(key);
              scheduleSocialReply(
                key, promptText,
                Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                '冷场试探'
              );
              log(`社交模式：${key} 冷场，AI 试探性说一句`);
            } else {
              leaveActive(key);
              log(`社交模式：${key} 冷场，回到观望`);
            }
          }
        }
      } else if (st.phase === 'exiting') {
        // 退场中：等待 AI 的收尾发言完成后进入观望。
        // 这里不做任何参与/冷场判定，新消息由 handleIncoming 转入摘要。
        // 极端兜底：超过 60 分钟仍未完成（如 DSH 长时间离线），强制回观望，避免状态卡死。
        if (now - st.activeExitAt > 60 * 60 * 1000) {
          log(`社交模式：${key} 退场等待超时（60 分钟），强制回到观望`);
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          const sid = state.sessions[key];
          if (sid) social.exitingSessions.delete(sid);
        }
      } else if (st.phase === 'probing' && now > st.probeDeadline) {
        // 试探后仍无人说话 → 100% 回观望
        leaveActive(key);
        log(`社交模式：${key} 试探无回应，回到观望`);
      }
    }
  }

  function startSocialLoop() {
    if (social.loopTimer) clearInterval(social.loopTimer);
    social.loopTimer = setInterval(socialLoopTick, 5000);
    social.loopTimer.unref?.();
  }

  async function flushSummaries(key = null) {
    const targets = key ? (social.pendingSummaries.has(key) ? [[key, social.pendingSummaries.get(key)]] : []) : [...social.pendingSummaries.entries()];
    for (const [k, entry] of targets) {
      if (!entry.items.length) continue;
      const lines = entry.items.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(k, m.messageId, m.media)}`).join('\n');
      const summaryMedia = entry.items.flatMap((m) => Array.isArray(m.media) ? m.media : []);
      let sessionId;
      try {
        sessionId = await ensureSession(k);
      } catch (error) {
        log(`摘要投喂创建会话失败 (${k}): ${error?.message ?? error}`);
        continue;
      }
      const roleHint = roleHintForCurrentMode();
      const summaryText = `${roleHint ? roleHint + '\n\n' : ''}【群聊摘要】过去一段时间群里发生了这些（你未逐条参与）：\n${lines}\n\n【最近对话】\n${buildContextBlock(k)}\n\n你不需要回复，只需记住这些内容，后续聊天会更自然。`;
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      social.silentTurns.set(sessionId, [...(social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
      const popSilent = () => {
        const arr = social.silentTurns.get(sessionId) ?? [];
        const next = arr.filter((x) => x.id !== silentId);
        if (next.length > 0) social.silentTurns.set(sessionId, next);
        else social.silentTurns.delete(sessionId);
      };
      try {
        const result = await deliverPrompt(k, summaryText, { silent: true, media: summaryMedia });
        if (result.ok) {
          log(`已投喂群聊摘要 (${k}) ${entry.items.length} 条`);
          entry.items = [];
        } else {
          popSilent();
          log(`摘要投喂被拒 (${k}): ${result.error || '未知错误'}`);
        }
      } catch (error) {
        popSilent();
        log(`摘要投喂失败 (${k}): ${error?.message ?? error}`);
      }
    }
    for (const k of [...social.pendingSummaries.keys()]) {
      if (social.pendingSummaries.get(k)?.items?.length === 0) social.pendingSummaries.delete(k);
    }
  }

  // 旧写法是 `isSocialEnabled() || cfg.social?.enabled !== false` —— 恒等于右边那一项
  // （isSocialEnabled() 本身就蕴含 cfg.social?.enabled !== false，左侧永远不可能单独为真），
  // 留着只会让人误以为"reserved 模式下才启动循环"。这里启动的只是一个 5 秒心跳，
  // 每跳自己会用 isSocialEnabled() 判断当前模式（见 socialLoopTick 第一行）；
  // 真正决定启不启动的只有配置里的显式关闭开关。
  if (cfg.social?.enabled !== false) {
    startSocialLoop();
  }

  // 当前角色扮演提示：读 state/current-role.json + roles/<角色>.md，
  // 由桥接注入到 QQ 群消息（群友无法通过对话修改，只能由管理端写该文件）。
  // 缓存 key 为两个文件的 mtime，mtime 未变时直接返回，避免每次同步读文件。
  let roleHintCache = { key: '', raw: '' };
  // 原始人格卡（按 mtime 缓存，不截断）。
  function roleRawContent() {
    try {
      const rs = readRoleState();
      if (!rs.role) return '';
      // 读取点也必须校验人格名：写入点（控制台 /role 命令）都过 sanitizeRoleName，
      // 但 state/current-role.json 是**用户可直接编辑**的文件。没有这道校验时，
      // {"role":"../../../../Users/Public/x"} 会让 roles/ 之外的文件被读进来并注入每一条提示词。
      const safeName = sanitizeRoleName(rs.role);
      if (!safeName || safeName.includes('..')) return '';
      const roleFile = path.join(ROLES_DIR, safeName + '.md');
      const resolved = path.resolve(roleFile);
      if (!resolved.startsWith(path.resolve(ROLES_DIR) + path.sep)) return '';
      if (!fs.existsSync(resolved)) return '';
      const stateStat = fs.statSync(ROLE_STATE_FILE);
      const roleStat = fs.statSync(roleFile);
      // 缓存 key 必须带上**文件名与文件大小**，不能只看 mtime：
      // ① 有些文件系统 mtime 只有秒级粒度（或时钟回拨），同一 tick 内把角色卡重写成新人格，
      //    两个 mtime 完全相同 → 缓存命中 → 注入的还是旧人格，而且是每条提示词都错；
      //    带上名字后，切换角色（例如 a.md → b.md）永远不会误命中。
      // ② 同名的原地重写若长度变了（大多数编辑都会变），size 变化也能击穿缓存。
      // 代价只是多几次 stat，比"热注入路径上一直发旧人格"划算得多。
      const cacheKey = `${safeName}:${stateStat.mtimeMs}:${stateStat.size}:${roleStat.mtimeMs}:${roleStat.size}`;
      if (roleHintCache.key === cacheKey) return roleHintCache.raw;
      const raw = fs.readFileSync(roleFile, 'utf8');
      roleHintCache = { key: cacheKey, raw };
      return raw;
    } catch {
      return '';
    }
  }
  // 按仿真模式取用：先用标题里的 〔一代〕/〔二代〕 标记筛掉另一模式的专属小节，
  // **再**按上限截断——这样另一模式的内容不会白白占掉本次的注入预算。
  function roleHintForMode(mode) {
    const selected = selectRoleText(roleRawContent(), mode);
    if (!selected) return '';
    return selected.length > roleInjectMaxChars ? truncateText(selected, roleInjectMaxChars) : selected;
  }
  function currentRoleHint() {
    return roleHintForMode('v1');
  }
  // 真实注入统一走这一个：按**当前模式**取人格。
  // 二代如果误用 currentRoleHint()，下面三件事会全部不生效：
  //   ① 标题里的 〔一代〕/〔二代〕 标记筛小节；② 「回复示例」里的中文空格改写成逗号；
  //   ③ 逐行滤掉一代状态机指令（[SILENT] / 空格分句）。
  // （:6520 的控制台预览早就按模式取了，但 5 处真实注入点（:12730 / :12941 / :13057 / :15110 / :15178）
  //  以前都调 currentRoleHint()，两条路不一致 —— 二代实际注入的一直是一代取用结果。）
  function roleHintForCurrentMode() {
    return currentMode === 'reserved2' ? currentRoleHintV2() : currentRoleHint();
  }

  // 二代仿真模式专用角色提示：去掉一代的 [SILENT] / 空格分句等状态机指令，避免与工具协议冲突。
  // 为了不削减原角色卡内容，示例节不整体删除，而是把“用空格分条”的示范改写成“用逗号表示停顿”，
  // 让二代 AI 既保留原有人格示例，又不会照抄单条消息里的中文空格。
  function isCjkLikeChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x3000 && code <= 0x303F)
    );
  }

  // 仅用于二代角色卡“回复示例”节：把示例里用于分条的中文空格改写成中文逗号。
  // 空格两侧只要有一侧是中文/中文标点，且另一侧不是 / \ ( ) [ ] { } " ' < > | 等符号，就转成逗号。
  // 这样能保留示例内容，同时避免把英文/URL/斜杠周围的空间改坏。
  function convertExampleSpacesToComma(line) {
    const chars = Array.from(String(line ?? ''));
    const NO_REPLACE = new Set(['/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.', '。', '，', '、']);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === ' ' || ch === '\t') {
        const prev = chars[i - 1];
        const next = chars[i + 1];
        const prevCjk = !!prev && isCjkLikeChar(prev);
        const nextCjk = !!next && isCjkLikeChar(next);
        const prevBlocked = !!prev && NO_REPLACE.has(prev);
        const nextBlocked = !!next && NO_REPLACE.has(next);
        if ((prevCjk || nextCjk) && !prevBlocked && !nextBlocked) {
          out += '，';
          continue;
        }
      }
      out += ch;
    }
    return out;
  }

  // 检测二代发送内容里“中文之间用空格”的不自然写法，用于给 AI 返回软提醒。
  // 只检测空格两侧都是中文/中文标点的情况，避免误伤英文单词间隔（如 DeepSeek V3）。
  function findCjkSpaceWarning(messages) {
    const bad = [];
    for (let i = 0; i < (messages || []).length; i++) {
      const chars = Array.from(String(messages[i] ?? ''));
      for (let j = 0; j < chars.length; j++) {
        const ch = chars[j];
        if (ch !== ' ' && ch !== '\t') continue;
        const prev = chars[j - 1];
        const next = chars[j + 1];
        if (prev && next && isCjkLikeChar(prev) && isCjkLikeChar(next)) {
          bad.push(i + 1);
          break;
        }
      }
    }
    if (!bad.length) return null;
    const list = [...new Set(bad)];
    const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
    return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
  }

  // 检测二代发送内容里“分条断点不自然”的情况：某条消息以逗号/顿号等非终止标点结尾，
  // 或以“的/了/吗/呢/吧/是/在/把/被/让/给”等通常需要接后续成分的词结尾，下一条又紧跟中文内容，
  // 说明 AI 很可能把同一句话拆到了两条消息里。这里只做软提醒，不拦截、不改写。
  function findSplitBoundaryWarning(messages) {
    if (!Array.isArray(messages) || messages.length <= 1) return null;
    const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
    // 这些是常见“短句但完整”的结尾，不应因为以“的/了”等结尾就被当成半句话。
    const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
    const bad = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const prev = String(messages[i] ?? '').trim();
      const next = String(messages[i + 1] ?? '').trim();
      if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
      const nextStartsCjk = isCjkLikeChar(Array.from(next)[0]);
      const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
      const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
      if (nonTerminalPunct || incompleteTail) {
        bad.push(`${i + 1}、${i + 2}`);
      }
    }
    if (!bad.length) return null;
    return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
  }

  function currentRoleHintV2() {
    // 先按 〔二代〕/〔一代〕 标记筛小节；下面的逐行过滤只是给「没标记的老卡片」兜底。
    const raw = roleHintForMode('v2');
    if (!raw) return '';
    // 一代仿真模式专用指令整行过滤，避免污染二代工具协议。
    // 用 role-card.js 导出的那份（文件顶部已 import）：这里原先又抄了一份同源正则，
    // 两份"哪行算一代指令"的安全相关过滤器一旦漂移，就会出现"selectRoleText 认为是二代内容、
    // 这里却把一代指令漏进二代提示词"这种只在特定角色卡上复现的错。
    const lines = raw.split('\n');
    const kept = [];
    let inExampleSection = false;
    for (const line of lines) {
      if (/^##\s*.*回复示例/.test(line)) {
        inExampleSection = true;
        // 保留标题，但把“空格代表分条”的一代语义改写成二代语义
        kept.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中已用逗号表示停顿；想分多条请用数组）'));
        continue;
      }
      if (inExampleSection && /^##\s/.test(line)) {
        inExampleSection = false;
      }
      if (inExampleSection) {
        kept.push(convertExampleSpacesToComma(line));
      } else if (!GEN1_ROLE_LINE_RE.test(line)) {
        kept.push(line);
      }
    }
    return kept.join('\n');
  }

  // QQ 群成员名片/昵称缓存：@ 段解析用，避免每条消息都调一次 OneBot API。
  const groupMemberNameCache = new Map(); // `groupId:userId` -> { name, ts }
  const GROUP_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
  function pruneGroupMemberNameCache() {
    const now = Date.now();
    for (const [k, v] of groupMemberNameCache) {
      if (now - v.ts > GROUP_MEMBER_NAME_TTL_MS) groupMemberNameCache.delete(k);
    }
    if (groupMemberNameCache.size > 2000) {
      const keys = [...groupMemberNameCache.keys()].slice(0, groupMemberNameCache.size - 2000);
      for (const k of keys) groupMemberNameCache.delete(k);
    }
  }
  // 群成员集合缓存：用于「拍一拍目标必须是本群成员」的校验。
  // 不校验的话，群友只要让 AI 传一个任意 QQ 号，桥接就会向网关发 group_poke，
  // 等于把机器人账号变成任意 QQ 号的探测/骚扰工具（工具描述里承诺了白名单约束）。
  const groupMemberIdsCache = new Map(); // groupId -> { ids:Set<string>, ts }
  const GROUP_MEMBER_IDS_TTL_MS = 60 * 1000;
  async function assertGroupMember(groupId, userId) {
    const gid = String(groupId);
    const uid = String(userId);
    let cached = groupMemberIdsCache.get(gid);
    if (!cached || Date.now() - cached.ts > GROUP_MEMBER_IDS_TTL_MS) {
      let list;
      try {
        list = await bot.getGroupMemberList(Number(gid));
      } catch (error) {
        // 失败即拒绝（fail-closed）：宁可拍不出去，也不要绕过校验。
        return `无法获取群 ${gid} 的成员列表：${error?.message ?? error}`;
      }
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const ids = new Set(members.map((m) => String(m?.user_id ?? '')).filter(Boolean));
      if (!ids.size) return `群 ${gid} 的成员列表为空，无法校验拍一拍目标`;
      cached = { ids, ts: Date.now() };
      groupMemberIdsCache.set(gid, cached);
      if (groupMemberIdsCache.size > 50) {
        for (const [k, v] of groupMemberIdsCache) {
          if (Date.now() - v.ts > 10 * 60 * 1000) groupMemberIdsCache.delete(k);
        }
      }
    }
    return cached.ids.has(uid) ? null : `QQ ${uid} 不是群 ${gid} 的成员，已拒绝拍一拍`;
  }

  async function resolveGroupMemberName(groupId, userId) {
    const key = `${String(groupId)}:${String(userId)}`;
    const hit = groupMemberNameCache.get(key);
    if (hit && Date.now() - hit.ts < GROUP_MEMBER_NAME_TTL_MS) return hit.name;
    try {
      // 优先精确查询单个成员（快，适合单条 @）
      let name = null;
      try {
        const info = await bot.getGroupMemberInfo(Number(groupId), Number(userId));
        name = info?.card || info?.nickname || null;
      } catch {}
      if (name) {
        groupMemberNameCache.set(key, { name, ts: Date.now() });
        pruneGroupMemberNameCache();
        return name;
      }
      // 回退：拉一次整群成员列表并建立整组缓存（兼容未实现 get_group_member_info 的网关）
      const list = await bot.getGroupMemberList(Number(groupId));
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const now = Date.now();
      for (const m of members) {
        const n = m?.card || m?.nickname || null;
        if (n) groupMemberNameCache.set(`${String(groupId)}:${String(m.user_id)}`, { name: n, ts: now });
      }
      pruneGroupMemberNameCache();
      name = groupMemberNameCache.get(key)?.name ?? null;
      return name;
    } catch {
      return null;
    }
  }

  // QQ 引用/回复解析缓存：messageId -> { sender, text, ts }，避免每条引用都调一次 OneBot API。
  const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
  const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
  const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败
  function pruneReplyInfoCache() {
    if (replyInfoCache.size <= 1000) return;
    const now = Date.now();
    for (const [k, v] of replyInfoCache) {
      if (now - v.ts > REPLY_INFO_TTL_MS) replyInfoCache.delete(k);
    }
    if (replyInfoCache.size > 1000) {
      const oldestKey = replyInfoCache.keys().next().value;
      if (oldestKey !== undefined) replyInfoCache.delete(oldestKey);
    }
  }
  async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
    pruneReplyInfoCache();
    const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
    const hit = replyInfoCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.info ? REPLY_INFO_TTL_MS : REPLY_NEGATIVE_TTL_MS)) return hit.info;
    try {
      const numericId = Number(messageId);
      if (!Number.isSafeInteger(numericId)) {
        log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const raw = await bot.getMessage(numericId);
      if (!raw) {
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      // 消息归属校验：防止跨会话读取其他群/私聊消息。
      // 若网关返回的 raw 对象连归属字段都缺失，则视为无法确认归属，拒绝返回内容。
      if (kind === 'group') {
        const rawGroup = raw.group_id ?? raw.groupId;
        if (rawGroup == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawGroup) !== String(convId)) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      } else {
        const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
        const rawGroup = raw.group_id ?? raw.groupId;
        // 私聊消息必须同时满足：没有群归属，且发送者匹配。防止用群消息 id 跨会话读取。
        if (rawGroup != null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (rawUser == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawUser) !== String(convId) && !(selfId != null && String(rawUser) === String(selfId))) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      }
      const sender = raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? '未知');
      const text = await segmentsToText(raw.message ?? [], {
        resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
        includeReply: false
      });
      const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
      const info = {
        sender: String(sender ?? ''),
        text: String(text ?? '').slice(0, 200),
        userId: senderUserId != null ? String(senderUserId) : null
      };
      replyInfoCache.set(cacheKey, { info, ts: Date.now() });
      return info;
    } catch (error) {
      log('解析引用消息失败:', error?.message ?? error);
      replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
      return null;
    }
  }

  // 发送引用时解析目标：支持真实 QQ message_id，也支持 recentMessages 里的 seq（自动映射到真实 messageId）。
  async function resolveReplyTargetV2(st, kind, convId, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return null;
    const found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
    // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== refStr) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    let info = await resolveReplyInfo(kind, convId, refStr);
    if (info) return { info, messageId: refStr };
    if (found && found.messageId) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    return null;
  }

  // 判断当前消息是否“引用/回复了机器人自己”：若是，则桥接层也把它当作直接对 AI 说。
  async function isQuoteTargetSelf(message, kind, id, selfId) {
    if (!Array.isArray(message) || selfId == null) return false;
    for (const seg of message) {
      if (seg?.type === 'reply' && seg.data?.id != null) {
        const info = await resolveReplyInfo(kind, id, String(seg.data.id), selfId);
        if (info?.userId && String(info.userId) === String(selfId)) return true;
      }
    }
    return false;
  }

  // ── 二代仿真模式（reserved2）唤醒调度 ──────────────────────────────────
  function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = []) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const safeMedia = Array.isArray(media) ? media.map((m) => ({
      kind: m?.kind === 'face' ? 'face' : 'image',
      file: m?.file ? String(m.file) : undefined,
      url: m?.url ? String(m.url) : undefined,
      faceId: m?.faceId ? String(m.faceId) : undefined
    })).filter((m) => m.kind === 'face' ? !!m.faceId : !!(m.file || m.url)) : [];
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender,
      userId: userId != null ? String(userId) : null,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainContent ?? textContent), 200),
      tail: truncateTextTail(String(plainContent ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    // ⭐ 回合中途有人说话 ⇒ 这一轮不再算"她自己起的头"。
    // 为什么必须有这一条：自主回合可能持续几十秒（她在思考/多次工具调用）。
    // 若只按"唤醒原因"标记，那么她正处在 proactiveCheck 回合里时，任何人插一句
    // 「你去发条说说」都仍然落在自主回合内 ⇒ 命令就能生效，等于绕过了整套约束。
    // 只要有新的人发消息进来，就把标记摘掉：写操作随即被拒。
    // 纯读工具不受影响（看说说/刷动态流本来就允许被命令）。
    if (st.turnAutonomous) {
      st.turnAutonomous = false;
      log(`[reserved2] ${key} 回合内收到新消息，自主标记已撤销（空间写操作本轮不再放行）`);
    }
      // ⭐ 有人开口/动手了，这段静默就不算她自己的 —— 取消待办的盖章
      //    （否则你刚说话她又拿到自主权，等于回到"边聊边发说说"）
      cancelQuietAutonomy(key, '收到新消息');
    st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    const lowerPlain = String(plainContent ?? textContent ?? '');
    for (const t of st.activeTopics || []) {
      if (!t || typeof t !== 'object') continue;
      const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
      const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
      if (topicHit || participantHit) t.lastMentionAt = Date.now();
    }
    saveSocialV2State();
  }

  // 二代拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    // 拍一拍同样是"别人动手"⇒ 撤销自主标记，理由与 appendSocialV2Message 相同。
    if (st.turnAutonomous) {
      st.turnAutonomous = false;
      log(`[reserved2] ${key} 回合内收到拍一拍，自主标记已撤销`);
    }
      // ⭐ 有人开口/动手了，这段静默就不算她自己的 —— 取消待办的盖章
      //    （否则你刚说话她又拿到自主权，等于回到"边聊边发说说"）
      cancelQuietAutonomy(key, '收到拍一拍');
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    saveSocialV2State();
    return msg;
  }

  function recordSentMessagesV2(key, messages) {
    const st = getSocialV2State(key);
    const now = Date.now();
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const text = redactKnownTokensOnly(String(list[i] ?? '')).slice(0, 200);
      st.recentMessages.push({
        sender: '我',
        text,
        plain: text,
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        time: now + i * 1000
      });
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State();
  }

  function readFeedbackEntries() {
    const data = readJsonSafe(FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(FEEDBACK_FILE, list);
  }

  function readToolLog(limit = 200) {
    try {
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }

  const appendToolLogFile = createCappedLogger(TOOL_LOG_FILE, 2000);

  function appendToolLog(entry) {
    try {
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = redactSensitiveText(safeEntry.args);
        }
      }
      // 用内存计数上限的追加器：不再「append 完再读回整个文件数行数」——
      // 那个写法在 2000 行（约 650KB）时单次要 15ms，而每次工具调用要写两条。
      appendToolLogFile(`${JSON.stringify(safeEntry)}\n`);
    } catch (error) {
      log('写入工具调用日志失败:', error?.message ?? error);
    }
  }

  const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
  function redactSensitive(obj) {
    if (Array.isArray(obj)) return obj.map(redactSensitive);
    if (obj && typeof obj === 'object') {
      // 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
      const out = Object.create(null);
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).toLowerCase();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[k] = SENSITIVE_ARG_KEYS.has(key) ? '***' : redactSensitive(v);
      }
      return out;
    }
    if (typeof obj === 'string') return redactSensitiveText(obj);
    return obj;
  }

  function sanitizeToolArgs(args) {
    if (args === undefined || args === null) return null;
    let parsed = args;
    // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
    for (let i = 0; i < 4; i++) {
      if (typeof parsed !== 'string') break;
      try {
        const next = JSON.parse(parsed);
        parsed = next;
        if (typeof next !== 'string') break;
      } catch {
        break;
      }
    }
    const safe = redactSensitive(parsed);
    let text;
    try { text = JSON.stringify(safe); } catch { text = String(safe); }
    if (text.length > 2000) text = truncateText(text, 2000) + '…(truncated)';
    return text;
  }

  function evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {
    if (kind === 'private') return 'private';
    const tr = st.wakeConfig?.triggers ?? {};
    if (tr.anyMessage) return 'anyMessage';
    if (tr.atMention) {
      const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
      if (atSelf || quoteTargetIsSelf) return 'atMention';
    }
    if (tr.nameMention && selfNickname) {
      const lower = String(textContent ?? '').toLowerCase();
      if (lower.includes('@' + selfNickname.toLowerCase()) || lower.includes(selfNickname.toLowerCase())) return 'nameMention';
    }
    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      const lower = String(plainContent ?? '').toLowerCase();
      for (const kw of tr.keywords) {
        const kwStr = String(kw ?? '').toLowerCase();
        if (!kwStr) continue;
        // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
        if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
          if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
        } else if (lower.includes(kwStr)) {
          return `keyword:${kw}`;
        }
      }
    }
    if (tr.question && isDirectedAtAi(plainContent)) return 'question';
    if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
      const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
      if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
        const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
        return `speaker:${senderLabel}`;
      }
    }
    if (Number(tr.probability) > 0 && Math.random() < Number(tr.probability)) return 'probability';
    return null;
  }

  // Only messages actually offered to the model authorize cursor-based acknowledgement.
  // Keep this receipt in memory: after a restart the model must fetch unread again.
  function readThroughSeqV2(st, additional = []) {
    const seen = new Set(st.modelSeenSeqs || []);
    for (const msg of additional) if (Number.isSafeInteger(msg?.seq) && msg.seq > 0) seen.add(msg.seq);
    const seqs = st.unread.map((m) => m.seq).filter((seq) => Number.isSafeInteger(seq) && seq > 0);
    const lowestBuffered = seqs.length ? Math.min(...seqs) : Infinity;
    const lastUnread = Number.isSafeInteger(st.lastUnreadSeq) ? st.lastUnreadSeq : 0;
    let through = Number.isSafeInteger(st.lastReadThroughSeq) ? st.lastReadThroughSeq : 0;
    // A seq may be reached only when it was offered to the model, or when the buffer
    // no longer holds it at all (evicted by unreadLimit, so it can never be displayed
    // again). Scoping the skip to the real buffer range is what keeps this from ever
    // stepping over a still-pending message.
    const reachable = (seq) => seen.has(seq) || (seq < lowestBuffered && seq <= lastUnread);
    while (through < lastUnread && reachable(through + 1)) through += 1;
    return through;
  }

  function noteModelMessagesV2(st, messages) {
    // Bound receipts by the actual unread buffer; historical/self messages need no receipt.
    const unread = new Set(st.unread.map((m) => m.seq));
    st.modelSeenSeqs = new Set([...st.modelSeenSeqs || []].filter((seq) => unread.has(seq)));
    for (const msg of messages) {
      if (Number.isSafeInteger(msg?.seq) && msg.seq > 0 && unread.has(msg.seq)) st.modelSeenSeqs.add(msg.seq);
    }
    return readThroughSeqV2(st);
  }

  function requestedReadThroughSeqV2(st, body, isAgent) {
    if (!Object.prototype.hasOwnProperty.call(body, 'throughSeq')) return null;
    const seq = body.throughSeq;
    const max = isAgent ? readThroughSeqV2(st) : st.lastUnreadSeq;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > max || seq > st.lastUnreadSeq) {
      const error = new Error('throughSeq 必须是不超过已展示连续消息水位的非负安全整数；请先读取未读消息并使用返回的 readThroughSeq');
      error.statusCode = 400;
      throw error;
    }
    return seq;
  }

  function acknowledgeMessagesV2(st, throughSeq) {
    const before = st.unread.length;
    if (throughSeq === null) {
      // Compatibility for console actions and old presets; new agents pass a cursor.
      st.unread = [];
      st.lastReadThroughSeq = st.lastUnreadSeq;
    } else {
      st.unread = st.unread.filter((m) => !Number.isSafeInteger(m.seq) || m.seq > throughSeq);
      st.lastReadThroughSeq = Math.max(st.lastReadThroughSeq || 0, throughSeq);
    }
    noteModelMessagesV2(st, []);
    return before - st.unread.length;
  }

  function buildWakeSnapshotV2(key) {
    const context = cfg.socialV2?.context ?? {};
    if (context.inlineWakeMessages === false || (!v2ToolEnabled('getUnread') && !v2ToolEnabled('getRecent'))) return null;
    const st = getSocialV2State(key);
    const bounded = (name, fallback, min, max) => {
      const value = Number(context[name] ?? fallback);
      return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
    };
    const maxChars = bounded('wakeMaxChars', 6000, 500, 20000);
    const maxUnread = bounded('wakeMessageLimit', 12, 1, 100);
    const maxRecent = bounded('wakeRecentLimit', 4, 0, 20);
    const packet = { messages: [], recent: [], unreadCount: st.unread.length, includedUnreadCount: 0, readThroughSeq: readThroughSeqV2(st), partial: st.unread.length > 0 };
    const tryAdd = (field, msg) => {
      const previousThrough = packet.readThroughSeq;
      packet[field].push(compactModelMessage(msg));
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = readThroughSeqV2(st, [...packet.messages, ...packet.recent]);
      packet.partial = packet.messages.length < st.unread.length;
      if (JSON.stringify(packet).length <= maxChars) return true;
      packet[field].pop();
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = previousThrough;
      packet.partial = packet.messages.length < st.unread.length;
      return false;
    };
    if (v2ToolEnabled('getUnread')) {
      // Oldest unread first: a budget cutoff must not silently acknowledge unseen messages.
      for (const msg of st.unread.slice(0, maxUnread)) if (!tryAdd('messages', msg)) break;
    }
    if (v2ToolEnabled('getRecent') && maxRecent > 0) {
      const unread = new Set(st.unread.map((m) => m.seq));
      const recent = st.recentMessages.filter((m) => !Number.isSafeInteger(m.seq) || !unread.has(m.seq)).slice(-maxRecent);
      for (const msg of recent.reverse()) if (!tryAdd('recent', msg)) break;
      packet.recent.reverse();
    }
    return packet;
  }

  function replyTimingV2(st) {
    const minimum = Number(cfg.socialV2?.wait?.minQuietAfterNewMs);
    const minQuietMs = Number.isFinite(minimum) ? Math.max(0, minimum) : 10000;
    const maxQuietMs = Math.max(minQuietMs, Math.min(120000, Number(cfg.socialV2?.wait?.maxMs) || 600000));
    const quietMs = Math.min(maxQuietMs, Math.max(minQuietMs, Math.round(suggestQuietMsV2(st)) || 0));
    const value = Number(st.lastIncomingAt);
    const elapsedMs = Number.isFinite(value) && value > 0 ? Math.max(0, Date.now() - value) : 0;
    return { purpose: 'reply', quietMs, remainingQuietMs: Math.max(0, quietMs - elapsedMs) };
  }

  /**
   * 【你的身份】—— 机器人自己的昵称 + QQ 号，写进每一次唤醒的提示词。
   *
   * 为什么必须有这一行（上游 issue #29「被 @ 了不理人」）：
   *   agent 能看到的消息里只有 `@小鲸鱼` 这串**文本**。桥接内部知道那是自己（nameMention
   *   判定用的就是 selfNickname），但 agent **不知道** —— 没人告诉它「小鲸鱼」= 它自己。
   *   于是它把「@自己」当成「@别人」，已读不回或者答非所问。
   *   群名片可能与昵称不同，但 at/引用段里带的是 QQ 号，所以两条都给出。
   *
   * 拿不到身份时返回空串（**不注入空行**）—— 否则提示词里会出现「你的昵称是（）」这种，
   * 比不注入更糟：它会以为自己的名字真的叫「（）」。
   */
  function selfIdentityTextV2() {
    const name = String(selfDisplayName || '').trim();
    const id = String(selfUserId || '').trim();
    if (!name && !id) return '';
    const label = name ? `「${name}」` : '（昵称还没取到）';
    const idText = id ? `（QQ ${id}）` : '';
    const callBits = name
      ? `消息里出现「@${name}」、有人叫「${name}」、或者引用你的消息，指的都是你 —— 别当成别人`
      : '被 @、被叫到你的昵称、或引用你的消息，指的都是你 —— 别当成别人';
    return `【你的身份】你在 QQ 上的昵称是${label}${idText}。${callBits}；群名片可能和昵称不一样，at/引用段里带${id ? ` ${id} ` : '你的 QQ 号'}就是在叫你。\n\n`;
  }

  /**
   * 每轮唤醒前，拿「对方刚说的这句话」去撞一次归档里的旧事。
   * 命中就把那几条**要点**提一句（默认最多 2 条），并给它们记一笔「被想起」。
   *
   * 为什么要有这一步（2026-10-29，照 xiaoman-memory 的思路补的）：
   *   角色卡里的记忆索引只放最近 3 天（plugins/qq-memory-rollover/memory-index.mjs
   *   的 INDEX_RECENT_DAYS）。实测她 62 条记忆里 50 条在索引之外 —— 没丢，但只有
   *   「她自己想起来去 qq_memory_query」才看得见。她不知道自己忘了什么，所以永远不查。
   *   这一步补的就是那条「顺嘴被勾起来」的路：不占索引预算，只在真撞上时才出现。
   *
   * 只认当前会话（scope 对不上的一律不撞）—— 私聊的事被塞进群聊，比忘了更糟。
   * 任何失败都返回空串：唤醒 prompt 拼不出来是整个机器人停摆，不能因为一条旧事。
   */
  function recallForPrompt(key, text) {
    try {
      const q = String(text == null ? '' : text).trim();
      if (q.length < 2) return '';
      const scope = String(key == null ? '' : key).trim();
      const mem = readDailyMemory();
      const rows = [];
      // readDailyMemory() 返回 { lastDigestDate, items: [{ date, items: [...] }] }，
      // 不是数组 —— 照 searchDailyMemory 的展开方式走，日期在 day.date 上。
      for (const day of (mem && Array.isArray(mem.items)) ? mem.items : []) {
        for (const it of Array.isArray(day && day.items) ? day.items : []) {
          if (!it || !it.text) continue;
          rows.push({
            date: String((day && day.date) || it.date || '').trim(),
            text: it.text,
            scope: it.scope,
            detail: it.detail,
            inferred: it.inferred
          });
        }
      }
      if (!rows.length) return '';
      const rc = cfg.socialV2?.recall ?? {};
      const rawHits = readJsonSafe(RECALL_HITS_FILE, {});
      const hits = (rawHits && typeof rawHits === 'object' && !Array.isArray(rawHits)) ? rawHits : {};
      const picked = pickRecallRows(rows, q, {
        scope: scope,
        top: Number(rc.top ?? 2),
        recentDays: Number(rc.recentDays ?? 3),
        cooldownMs: Number(rc.cooldownHours ?? 6) * 3600 * 1000,
        hits: hits
      });
      if (!picked.length) return '';
      const block = renderRecallBlock(picked);
      if (!block) return '';
      // 记账：被想起一次 +1，并记下时间（cooldown 内不再重复提同一件）。
      const now = Date.now();
      const next = { ...hits };
      for (const item of picked) {
        const prev = (next[item.id] && typeof next[item.id] === 'object') ? next[item.id] : {};
        next[item.id] = { hits: (Number(prev.hits) || 0) + 1, lastHit: now };
      }
      // 顺手清掉已经不在库里的 id，别让这个文件越长越长。
      const alive = new Set(rows.map((r) => recallIdOf(r)));
      for (const id of Object.keys(next)) if (!alive.has(id)) delete next[id];
      atomicWriteJson(RECALL_HITS_FILE, next);
      return block;
    } catch (error) {
      log('[recall] 撞旧事失败（这一轮不提，不影响唤醒）：' + (error?.message ?? error));
      return '';
    }
  }

  function buildWakePromptV2(key, reason) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    const identityLine = selfIdentityTextV2();
    const st = getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const memoryText = formatMemoryV2(st);
    const memoryLine = memoryText ? `${memoryText}\n\n` : '';
    // 注意：黑话表不在这里注入，deliverPromptNow 的 withSlangContext 会统一注入，
    // 避免唤醒 prompt 出现两份黑话表。
    const participationText = formatParticipationV2(st);
    const participationLine = participationText ? `${participationText}\n\n` : '';
    const antiAiLine = '【反AI味】你不是客服：不用有求必应，可以装傻、已读乱回、拒绝推荐；少用“一绝/真管用/保证/绝对”这类词。\n\n';
    const stickerCfg = cfg.socialV2?.sticker ?? {};
    const stickerLine = stickerCfg.enabled !== false && stickerCfg.includeInPrompt !== false
      ? `${buildStickerStrategyHint()}\n${buildStickerContext(stickerEntries, stickerCfg.promptMaxStickers ?? 8)}\n\n`
      : '';
    // 群图库单独一段（用它自己的工具 qq_send_photo）。只在真收了图之后才产出内容，
    // 空库返回空串 → 不占 token。
    const photoCfg = cfg.socialV2?.photo ?? {};
    const photoLine = mediaLib && photoCfg.enabled !== false && photoCfg.includeInPrompt !== false
      ? (() => {
          const block = buildPhotoContext(mediaLib, photoCfg.promptMaxPhotos ?? 6, key);
          return block ? `${block}\n\n` : '';
        })()
      : '';
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            // ⭐「自由时间」的实际值：必须**动态注入**，不能在 preset 里写死。
            //    为什么（2026-10-20 主人实测踩到）：他在控制台把间隔改成 5 小时，
            //    而 preset 里写着"至少隔 4 小时" ⇒ 她按 4 小时规划、白撞一次 429。
            //    这里按当前 cfg 现算：buildWakePromptV2 每轮都跑 ⇒ 改完立刻跟着变。
            const _aut = cfg.socialV2?.autonomy ?? {};
            const _qGrantMs = (Number.isFinite(Number(_aut.quietGrantMs)) && Number(_aut.quietGrantMs) > 0)
              ? Number(_aut.quietGrantMs) : 2.5 * 60 * 1000;   // 同 bridge 的 AUTONOMOUS_QUIET_GRANT_MS_DEFAULT
            const _gGapMs = (Number.isFinite(Number(_aut.qzoneWriteMinGapMs)) && Number(_aut.qzoneWriteMinGapMs) >= 0)
              ? Number(_aut.qzoneWriteMinGapMs) : 4 * 60 * 60 * 1000;  // 同 QZONE_WRITE_MIN_GAP_MS_DEFAULT
            const _qGrantTxt = (() => {
              const m = _qGrantMs / 60000;
              // 分钟同理：1.5 分钟显示 "1.5"，不留尾零
              const mTxt = Number.isInteger(m) ? String(m) : String(Number(m.toFixed(1)));
              return mTxt + ' 分钟';
            })();
            const _gGapTxt = _gGapMs === 0 ? '不限制' : (() => {
              const h = _gGapMs / 3600000;
              // 去掉尾零：6.5 小时显示 "6.5"、不显示 "6.50"（toFixed(2) 会留尾零，读着别扭）
              const hTxt = Number.isInteger(h) ? String(h) : String(Number(h.toFixed(2)));
              return hTxt + ' 小时';
            })();
            // 这一行注入进 base（所有唤醒分支共用）—— 数值永远与控制台一致
            const autonomyLine = '【自由时间（当前实际设置）】'
              + `你跟他聊完、他接着沉默 ${_qGrantTxt}，这一小段就算"你自己起的头"`
              + '（可以用它做空间写操作，也可以什么都不做）。'
              + `同一个私聊里，两次空间写操作之间至少隔 ${_gGapTxt}`
              + '（桥接在执行期挡，超了返回 429 并告诉你还差多久）。\n'
              + '⚠️「允许」不等于「必须」：大部分时候什么都不做才是对的，别把它当打卡任务。\n'
              + '⚠️ 只限制「写」：看空间、翻说说列表、刷动态随时都可以，不受限制。\n\n';
    // 【现在】放在最前面：她得先知道"几点、周几、是不是饭点"，才谈得上
    // "吃饭的时候说自己也饿了""早上叫他起床"。老版本只在 withSlangContext 里
    // 塞一行 `【当前时间】2026/10/19 21:15:25`，她看得见钟点，但看不出
    // "这是晚饭时间""他已经三个小时没说话了"这类能被说出口的东西。
    const nowLine = `${formatTimeContext({
      lastIncomingAt: st.lastIncomingAt || 0,
      lastAiReplyAt: st.lastAiReplyAt || 0
    })}\n\n`;
    const proactiveLine = '【积极性】不要习惯性潜水：群里有你能接的话题就主动参与，偶尔插一句别人的话题也很正常；只有确实没话可说、对方已明确结束、或长时间没人说话时才潜水。\n\n';
    const replyTiming = replyTimingV2(st);
    const replyLine = `【首回复节奏】先处理已有消息，完整的问题及时回答。需要确认对方是否继续补充时，用 qq_wait_for_messages(purpose="reply", quietMs=${replyTiming.quietMs})；从最后来信计时，合批和读提示词的耗时也算，目前还差约 ${Math.ceil(replyTiming.remainingQuietMs / 1000)} 秒静默。已安静够久可直接回，工具也会立即返回并补上思考期间的新消息。只有明确没说完、你确实要等下文时，才用普通 messages 长等待。\n\n`;
    const preSleepLine = `【沉睡前强制等待】这是决定潜水收尾时的步骤，不是首回复的前置条件。除非对方明确说“不聊了/晚安/下了/拜拜”等结束语，否则每次设置潜水/下一次唤醒前，必须先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察；回复前 purpose="reply" 的短静默不能代替这次完整观察。若 ${Math.round(preSleepMs / 60000)} 分钟内没人说话，返回 preSleepWaitSatisfied=true，可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看返回的 newMessages——判断不需要你参与就可以直接沉睡，若你选择参与回复，则下次想睡时需要重新等待观察窗口。如果返回里带 preSleepWaitRemainingMs，就按剩余时间继续等待。\n\n`;
    const lastMsg = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
    // 顺着对方这句话想一下更早的事（只在真撞上时才出现，占不了几个字）
    const recallV2 = recallForPrompt(key, lastMsg ? (lastMsg.plain || lastMsg.text || '') : '');
    const recallBit = recallV2 ? recallV2 + String.fromCharCode(10, 10) : '';
    const lastAiMin = st.lastAiReplyAt ? Math.max(0, Math.round((Date.now() - Number(st.lastAiReplyAt)) / 60000)) : null;
    const statusBits = [`未读 ${(st.unread || []).length} 条`];
    if (lastMsg) statusBits.push(`最近一条来自 ${String(lastMsg.sender || '未知')}：${String(lastMsg.text || lastMsg.plain || '').slice(0, 30)}`);
    if (lastMsg && looksLikeUnfinished(String(lastMsg.tail || lastMsg.plain || lastMsg.text || ''))) statusBits.push('对方可能没说完');
    if (lastAiMin != null) statusBits.push(`你上次发言 ${lastAiMin} 分钟前`);
    const statusLine = `【此刻状态】${statusBits.join('；')}\n\n`;
    const wc = st.wakeConfig || {};
    const wcTr = wc.triggers || {};
    const wcMode = wc.mode === 'active' ? '活跃' : '潜水';
    const wcTime = wc.infinite ? '无限' : (wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) ? `有限至 ${new Date(wc.sleepUntil).toLocaleString()}` : '未设时间');
    const wcTriggers = [];
    if (wcTr.atMention) wcTriggers.push('@');
    if (wcTr.nameMention) wcTriggers.push('名字');
    if (Array.isArray(wcTr.keywords) && wcTr.keywords.length) wcTriggers.push('关键词');
    if (wcTr.question) wcTriggers.push('提问');
    if (wcTr.poke) wcTriggers.push('拍一拍');
    if (Array.isArray(wcTr.speakerIds) && wcTr.speakerIds.length) wcTriggers.push(`指定成员(${wcTr.speakerIds.length}:${wcTr.speakerIds.join(',')})`);
    if (wcTr.anyMessage) wcTriggers.push('任意消息');
    if (Number(wcTr.probability) > 0) wcTriggers.push(`概率${wcTr.probability}`);
    const wakeLine = `【当前唤醒】${wcMode}，${wcTime}${wcTriggers.length ? `；触发：${wcTriggers.join('/')}` : ''}\n\n`;
    // 【约好的事】：他让她几点叫他起床、几点回来聊、哪天提醒他 —— 这类"约定"必须
    // 出现在**每一次**唤醒里，否则她记不住，而且这类事的正确性依赖"现在到点没有"，
    // 不能靠她自己算。到点的条目会额外标出来，没到点的也会在，好让她知道"还没到"。
    let promiseLine = '';
    try {
      const promiseText = formatPromisesV2(st);
      if (promiseText) promiseLine = `${promiseText}\n\n`;
    } catch (error) {
      log(`[promise] 读约定失败：${error?.message ?? error}`);
    }
    // 日记本：把最近 3 条她自己写的日记放进提示词，让她"记得自己写过什么"。
    // 读失败（文件被手改坏等）不能拖垮唤醒，所以整体 try 掉。
    let diaryLine = '';
    try {
      const diaryText = diaryBrief(diaryDir(), 3);
      if (diaryText) diaryLine = `${diaryText}\n\n`;
    } catch (error) {
      log(`[diary] 读日记失败：${error?.message ?? error}`);
    }
        // identityLine 紧跟 roleLine：先知道「我是谁」，再看「我这个会话里的角色是什么」。
        const base = roleLine + identityLine + tokenLine + nowLine + antiAiLine + proactiveLine + stickerLine + photoLine + diaryLine + replyLine + statusLine + wakeLine + promiseLine + memoryLine + recallBit + participationLine + preSleepLine + autonomyLine;
    if (reason === 'bootstrap') {
      return `${base}【引导唤醒】你已接入 QQ 会话 ${key}。\n当前是二代仿真模式：你的文本输出不会自动发送到 QQ，所有发言必须通过工具完成。\n请先调用 qq_get_prompt 查看角色、推荐值、可用工具和状态；有待回应的消息先按首回复节奏处理，最后才用 qq_set_wake_config 设置你希望如何被唤醒。`;
    }
    if (reason === 'timeout') {
      return `${base}【唤醒】${key}\n原因：你设置的有限潜水时间已到；在你规定的时间内没有任何一项条件被触发，只是因为时间到了所以你被唤醒。\n你可以查看消息，或继续设置新的唤醒条件。`;
    }
    if (reason === 'replyCheck') {
      return `${base}【回复检查】${key}\n原因：你刚刚发送过消息，现在回来检查是否有人回复。\n已有回复时先看消息，需要短静默就用 qq_wait_for_messages(purpose="reply") 判断对方是否说完；如果没人回你，不用硬补一句，但也不要立刻潜水——先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察：没人说话可收尾；有人说话则查看 newMessages，不需要你参与也可直接收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'proactiveCheck') {
      return `${base}【主动机会】${key}\n原因：这个会话已经安静了一段时间，这是一次你可以主动冒泡的机会。\n优先主动开个话题、追问上次没聊完的事、分享一个刚想到的想法；如果一时想不到，可以用 mcp__web-search-safe__web_search 搜一下当前热点/时事/网络热梗，再结合记忆里的群友兴趣挑一个自然角度。\n【不只是说话】这一轮是你自己的，也可以做点自己的事：\n· **想玩就当场开口问**：mcp__snowluma__qq_request_permission(key, token, scope="phone", why="想玩会儿…") 会以你的口吻发一条消息给他；他同意就放开玩（消消乐、截图都行）。不用等"有话可说"才找他——**想玩本身就是理由**。\n· **空间里有话想说就说**：发说说、给谁点个赞、评论一句都行（这一轮是你自己起的头，允许写；注意频率上限）。\n⭐ 别把"他没回我"当成"我不该开口"。想找他、想玩、看到有意思的东西，都可以是主动的理由。\n只要内容自然，就大胆开口；实在没话想说、也不想玩，再安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'poke') {
      return `${base}【唤醒】${key}\n原因：有人拍了一拍（可能拍了你，也可能拍了别人）。\n先看未读/最近消息里的 [拍一拍] 事件：如果是拍你，可以自然回应一句，也可以用 qq_send_poke 回一个拍一拍；如果是拍别人，觉得有趣也可以接梗。除了回应，偶尔也可以主动戳一下正在聊的人/熟人，像真人手贱/提醒/逗一下，但别频繁。不想接就安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'promise') {
      return `${base}【约定的时间到了】${key}\n`
        + '原因：不是有人找你，也不是群里有动静 —— 是你之前跟他约好的事到点了（看上面【约好的事】）。\n'
        + '现在该做的是那件事本身：他让你叫他起床，就叫他（可以短一点、带点起床气都行，别像闹钟播报）；'
        + '让你提醒他的事，就提醒；让你回来找他，就找他。\n'
        + '做完用 qq_promise_done 把这条约定划掉，别让它下次又响一遍。\n'
        + '如果他明显还在睡/没回，就只发一句，别再追第二条；也不要因为到点了就硬聊别的。';
    }
    return `${base}【唤醒】${key}\n原因：${reason}\n【行动前】先判断：群里在聊什么？热闹还是冷清？有没有人直接找你？对方说完了吗？你有没有真正想说的？\n如果群聊正热但没人叫你，可以插一句有趣的/相关的，插不上再看情况潜水；不要一上来就划走。\n【引用：只在必要时用】只有你这条消息指向的人或消息并非最新一条别人的消息，或者你连续的几句话中不同消息指代的是不同的消息或人时，才用 qq_reply 或 qq_send_message 的 replyToMessageId 指向具体那条；其他情况不要引用，别让对方猜。\n你可以调用工具查看未读消息、人设、状态，自行决定是否发言；决定潜水前必须按上面的【沉睡前强制等待】先等够观察窗口。`;
  }

  // ── 日记提醒（进阶1）──────────────────────────────────────────────────────
  // 帖子里点名的第一个坑就是 **别固定时间写**：每天 23:00 准时提醒，那不是日记，是打卡。
  // 所以这里不是定时任务，而是"晚上还醒着、今天又还没写"的时候，隔一阵子轻轻提一句：
  //   · 每 30 分钟才看一次，一天最多提 2 次，两次之间至少隔 3 小时；
  //   · 20:00 之前完全不提；
  //   · 今天已经写过了，就只在深夜（22:00~02:00）允许再补一句——那时多写一条
  //     "今天就这样吧"本来就是日记该有的样子。
  // 提醒只投递 prompt（silent），**不会往 QQ 发任何消息**，也不占用唤醒配额。
  const DIARY_NUDGE_INTERVAL_MS = 30 * 60 * 1000;
  const DIARY_NUDGE_MAX_PER_DAY = 2;
  const DIARY_NUDGE_MIN_GAP_MS = 3 * 60 * 60 * 1000;
  let diaryNudgeStarted = false;
  const diaryNudgeState = { day: '', count: 0, lastAt: 0 };

  function diaryNudgeTargetKey() {
    const owner = String(cfg.ownerQQ ?? '').trim();
    if (owner) {
      const ownerKey = `private:${owner}`;
      if (isSessionAllowedInCurrentMode(ownerKey)) return ownerKey;
    }
    // 没配 ownerQQ，或主人会话不在当前模式允许范围内时，退到第一个可用会话。
    for (const key of Object.keys(state.sessions ?? {})) {
      if (isSessionAllowedInCurrentMode(key)) return key;
    }
    return '';
  }

  function diaryNudgeTick() {
    try {
      if (cfg.socialV2?.diary?.nudge === false) return;
      if (!v2ToolEnabled('writeDiary')) return;
      if (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false) return;

      const now = new Date();
      const today = diaryDay(now);
      if (diaryNudgeState.day !== today) {
        diaryNudgeState.day = today;
        diaryNudgeState.count = 0;
      }
      // 「一天的尾巴」从**傍晚**算起，不是从 20 点。
      // 原因：主人白天用电脑、不用就把桥接关掉，20 点这个门槛等于永远来不及触发。
      // 默认 17 点起（DIARY_NUDGE_FROM_HOUR），可用 config.json → socialV2.diary.nudgeFromHour 调（0~23）。
      // 判定本身在 diary-lib.js 的 diaryNudgeGate()，那里是纯函数、有单测覆盖。
      const rawFrom = Number(cfg.socialV2?.diary?.nudgeFromHour);
      const nudgeFromHour = Number.isFinite(rawFrom) ? Math.min(23, Math.max(0, rawFrom)) : DIARY_NUDGE_FROM_HOUR;
      const todayCount = diaryTodayCount(diaryDir(), today);
      const gate = diaryNudgeGate({
        now,
        fromHour: nudgeFromHour,
        count: diaryNudgeState.count,
        lastAt: diaryNudgeState.lastAt,
        todayCount,
        maxPerDay: DIARY_NUDGE_MAX_PER_DAY,
        minGapMs: DIARY_NUDGE_MIN_GAP_MS
      });
      if (!gate.ok) return;

      const key = diaryNudgeTargetKey();
      if (!key) return;

      const st = getSocialV2State(key);
      const roleState = readRoleState();
      const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
      const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
      let diaryText = '';
      try { diaryText = diaryBrief(diaryDir(), 3); } catch { /* 读不动就不带，别影响提醒本身 */ }
      const diaryBlock = diaryText ? `${diaryText}\n\n` : '';
      const clock = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
      const progress = todayCount > 0 ? `今天你已经写了 ${todayCount} 条。` : '今天你还什么都没写。';
      const prompt = `${roleLine}${tokenLine}${diaryBlock}【日记提醒】现在是 ${clock}，${progress}\n这只是提一句，不是任务：想写就写，一天可以写多条，不想写也完全可以，明天想起来再补也没关系。\n这是你自己的本子，没人检查，不用给别人看，也不用写得完整——一两句就够。\n想写就用 qq_write_diary；只是想起以前写过什么，可以用 qq_read_diary 翻一翻。\n如果这会儿更想安安静静待着，那就什么都不做：这条提醒不需要回复，也不是让你去群里发言的信号。`;

      diaryNudgeState.count += 1;
      diaryNudgeState.lastAt = Date.now();
      log(`[diary] 提醒 ${key} 写日记（今天 ${todayCount} 条，这是今天第 ${diaryNudgeState.count} 次）`);
      void deliverPrompt(key, prompt, { silent: true }).catch((error) => {
        log(`[diary] 提醒投递失败 ${key}：${error?.message ?? error}`);
      });
    } catch (error) {
      log(`[diary] 提醒异常：${error?.message ?? error}`);
    }
  }

  function startDiaryNudge() {
    if (diaryNudgeStarted) return;
    diaryNudgeStarted = true;
    const timer = setInterval(diaryNudgeTick, DIARY_NUDGE_INTERVAL_MS);
    timer.unref?.();
  }

  /**
   * 模拟器到期巡检（主人 2026-10-24：「授权到期时自动关闭模拟器」）。
   *
   * 为什么用轮询而不是 setTimeout(expiresAt)：
   *   · 授权可能在运行中被延长/收回/覆盖，一次性定时器要处理一堆重排；
   *   · 桥接重启后内存里的定时器全丢，而过期授权仍在文件里 —— 轮询能自己补上；
   *   · 30 秒一次的成本可以忽略（没有过期条目时只读一个 JSON）。
   */
  const EMULATOR_SWEEP_MS = 30 * 1000;
  let emulatorSweepStarted = false;
  function startEmulatorSweep() {
    if (emulatorSweepStarted) return;
    emulatorSweepStarted = true;
    const timer = setInterval(() => {
      try { sweepExpiredEmulatorGrants(); } catch (error) { log(`[emulator] 巡检异常：${error?.message ?? error}`); }
    }, EMULATOR_SWEEP_MS);
    timer.unref?.();
  }

  function buildWakeReminderPromptV2(key) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    // 身份也带上：收尾这一轮她照样要看新消息，同样需要知道「@谁」是在叫她。
    const identityLine = selfIdentityTextV2();
    const st = getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    return `${roleLine}${identityLine}${tokenLine}【提醒】你还没有完成回合收尾。请调用 qq_set_wake_config 设置下一次唤醒条件（例如继续潜水多久、@/名字/关键词/提问/概率/指定成员等），或者调用 qq_mark_read 表示你看过且决定不接。这是为了防止你忘记收尾后进入“永眠”。注意：设置潜水前先用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察；等待期间有人说话时查看 newMessages，判断不需要你参与即可收尾。`;
  }

  async function sendWakePromptV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (currentMode !== 'reserved2' || socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
    // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免“思维链进行中又塞入一个 question 唤醒”。
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      // ★2026-10-22：主人在她长回合里说话，不再只排队★（同 scheduleWakeV2 那一处）
      if (canSteerV2(key, reason)) {
        const steered = await steerIntoRunningTurnV2(key, reason, seq);
        if (steered.ok) {
          log(`[reserved2] 会话繁忙，但已插入正在跑的回合 ${key}（${reason}@seq${seq}）`);
          return;
        }
        log(`[reserved2] steer 未成功（${steered.error}），退回排队 ${key}（${reason}@seq${seq}）`);
      }
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      return;
    }
    // 唤醒频率硬限制：超限则跳过本次唤醒，避免成本失控
    const now = Date.now();
    const maxPerMinute = Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0;
    const maxPerHour = Number(cfg.socialV2?.wake?.maxWakePerHour) || 0;
    const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour)) {
      log(`[reserved2] 唤醒频率超限，跳过 ${key}（${reason}）`);
      return;
    }
    // Only a real new wake resets observation; skipped/busy candidates must
    // preserve the current turn's progress through its required wait window.
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    cancelReplyCheckV2(key); // 本次唤醒已接管，清理仍在排队的回复检查
    const wakeTime = now;
    st.wakeTimes.push(wakeTime);
    if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    // ⭐ 记录这一轮是不是"她自己起的头"（判据见 AUTONOMOUS_WAKE_REASONS）：
    // 空间写操作在执行期只认这个标记，所以必须在投递提示词**之前**写定并落盘 ——
    // deliverPrompt 返回得很快而模型回合是异步跑的，标记若晚写就会出现
    // "她已经开始思考了、状态还是上一轮的" 这种窗口。
    st.turnAutonomous = isAutonomousWakeReason(reason);
    st.turnStartedAt = now;
    saveSocialV2State();
    const promptText = buildWakePromptV2(key, reason);
    log(`[reserved2] 唤醒 ${key}（${reason}）`);
    const rollbackWakeTime = () => {
      const idx = st.wakeTimes.lastIndexOf(wakeTime);
      if (idx >= 0) st.wakeTimes.splice(idx, 1);
      saveSocialV2State();
    };
    try {
      pendingWakeKeys.add(key);
      armPendingWakeLease(key);
      const result = await deliverPrompt(key, promptText, { wakeReason: reason });
      const restoreFiniteSleep = () => {
        if (hadFiniteSleep) {
          st.wakeConfig.sleepUntil = prevSleepUntil;
          st.wakeConfig.infinite = false;
          saveSocialV2State();
          setupSleepTimerV2(key);
        }
      };
      if (result && result.ok === false) {
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        rollbackWakeTime();
        restoreFiniteSleep();
        log(`[reserved2] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
      } else if (result && result.queued === true) {
        // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递的 turn/end 再触发收尾保护；
        // 不能在这里删除，否则补投的唤醒回合会丢失“未设置唤醒配置”的安全兜底。
        log(`[reserved2] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      }
    } catch (error) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      rollbackWakeTime();
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        saveSocialV2State();
        setupSleepTimerV2(key);
      }
      log(`[reserved2] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
    }
  }

  function cancelReplyCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    clearTimeout(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

  function scheduleReplyCheckV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    const st = getSocialV2State(key);
    // 已有真实唤醒/有限睡眠/回复检查在排队时不再重复安排，避免 AI 被连环唤醒。
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
    let delay = Math.max(1000, Number(cfg.socialV2?.autoReplyCheckMs) || 30000);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
    st.replyCheckTimer = setTimeout(() => {
      st.replyCheckTimer = null;
      void sendWakePromptV2(key, 'replyCheck').catch((error) => log(`[reserved2] replyCheck 唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.replyCheckTimer.unref?.();
    log(`[reserved2] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }

  // 回合僵死判定：距离该会话最后一次收到 DSH 事件超过 V2_TURN_STALE_MS 就当作死回合。
  // 为什么必须有它：v2TurnStartAt / collectors 是纯内存标记，正常由 turn/end 清除。
  // 一旦桥接（或 DSH）在 turn/start 之后、turn/end 之前重启，标记就永远留着，
  // isConversationBusyV2 恒为 true ⇒ 之后所有唤醒只进 pendingWakeReasons 队列；
  // 而队列唯一的消费点在 turn/end 分支里 —— 没有 turn/end ⇒ 没人消费 ⇒ 该会话永久死锁。
  // 实测发生过：2026-10-13 20:33 重启腰斩回合后，直到手动干预才恢复。
  function isTurnStaleV2(sessionId) {
    if (!sessionId) return false;
    if (!v2TurnStartAt.has(sessionId) && !collectors.has(sessionId)) return false;
    const last = v2TurnLastEventAt.get(sessionId) ?? v2TurnStartAt.get(sessionId) ?? 0;
    const grace = v2TurnRestored.has(sessionId) ? V2_RESTORED_TURN_GRACE_MS : V2_TURN_STALE_MS;
    return last > 0 && Date.now() - last > grace;
  }

  // 回收僵死回合：清掉内存标记，并把因此卡住的积压唤醒重新排队。
  // 返回 true 表示确实回收了一个僵死回合（调用方据此打日志）。
  function reapStaleTurnV2(key, sessionId) {
    if (!sessionId || !isTurnStaleV2(sessionId)) return false;
    const idleMs = Date.now() - (v2TurnLastEventAt.get(sessionId) ?? v2TurnStartAt.get(sessionId) ?? Date.now());
    v2TurnStartAt.delete(sessionId);
    v2TurnLastEventAt.delete(sessionId);
    v2TurnRestored.delete(sessionId);
    collectors.delete(sessionId);
    sendToolSucceededSessions.delete(sessionId);
    pendingSendToolCalls.delete(sessionId);
    toolCallNames.delete(sessionId);
    disarmPendingWakeLease(key);
    pendingWakeKeys.delete(key);
    log(`[reserved2] ${key} 回合僵死回收（${Math.round(idleMs / 1000)}s 无事件），已解除繁忙标记`);
    // 队列里积压的唤醒没人消费过，这里补排一条，其余留在队列里等正常 turn/end 继续消费。
    const st = getSocialV2State(key);
    if (Array.isArray(st.pendingWakeReasons) && st.pendingWakeReasons.length) {
      const item = st.pendingWakeReasons.shift();
      const stillRelevant = Array.isArray(st.unread)
        && st.unread.some((m) => m && Number(m.seq) >= Number(item?.seq));
      if (stillRelevant) {
        log(`[reserved2] ${key} 僵死回收后补排积压唤醒：${item.reason}@seq${item.seq}（剩余 ${st.pendingWakeReasons.length} 条）`);
        void scheduleWakeV2(key, item.reason).catch(() => {});
      } else {
        log(`[reserved2] ${key} 僵死回收后跳过过期唤醒：${item?.reason}@seq${item?.seq}`);
      }
      saveSocialV2State();
    }
    return true;
  }

  // 看门狗：定期扫描所有会话，回收僵死回合。只依赖内存，不产生任何模型调用。
  let v2WatchdogStarted = false;
  function startV2TurnWatchdog() {
    if (v2WatchdogStarted) return;
    v2WatchdogStarted = true;
    const timer = setInterval(() => {
      for (const [key, sessionId] of Object.entries(state.sessions ?? {})) {
        try {
          reapStaleTurnV2(key, sessionId);
        } catch (error) {
          log(`[reserved2] 回合看门狗异常 ${key}:`, error?.message ?? error);
        }
      }
    }, V2_WATCHDOG_INTERVAL_MS);
    timer.unref?.();
  }

  function isConversationBusyV2(key, st) {
    if (st && st.pendingWakeTimer) return true;
    if (pendingWakeKeys.has(key)) return true;
    const q = promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) return true;
    const sid = state.sessions[key];
    // 僵死回合不算忙：否则看门狗还没来得及跑，这一次唤醒就又被塞进队列了。
    // 这里只认 v2TurnStartAt（真正见过 turn/start），**不能用 collectors.has()**：
    // 任何一条会话事件（例如启动时的 session/end-seed）都会在事件处理里无条件登记一个
    // collector，于是空闲会话被判成「AI 正在思考」，唤醒全被塞进 pendingWakeReasons；
    // 更糟的是那条事件同时刷新了 v2TurnLastEventAt，要等满 12 分钟看门狗窗口才会解除。
    // 这正是「每次重启后卡十几分钟」的直接原因（21:35:48 启动 → 21:48:48 才恢复）。
    if (sid && v2TurnStartAt.has(sid) && !isTurnStaleV2(sid)) return true;
    return false;
  }

  /**
   * ⭐ 自主回合的判据（2026-10-19，主人要求）：「凡是不是别人触发的回合都算她自己起的头」。
   *
   * 用途：QQ 空间的**写操作**（发说说/点赞/评论/删除/改可见性）只允许在自主回合里发生。
   * 为什么不能靠工具白名单实现：白名单只能表达"谁可以调用"，表达不了"这一轮是谁起的头" ——
   * 而主人要的恰恰是后者：任何人在对话里说一句「你去发条说说」都不能成立，
   * 包括主人自己。因此判据必须落在**唤醒原因**上，且在执行期由桥接检查。
   *
   * 三类算自主（都是"没人找她、她自己醒过来"）：
   *   proactiveCheck —— 主动机会：冷场久了，桥接按概率给她一次自己冒泡的机会（最典型的"自己想的"）
   *   timeout        —— 她自己设的有限潜水到期，回来看看
   *   replyCheck     —— 她刚说完话，回来看有没有人接（仍是她自己的节奏，不是被点名）
   *
   * 不算自主（**只要别人开口/动手就算**，fail-closed）：
   *   private / atMention / question / speaker / nameMention / keyword / anyMessage /
   *   probability / poke / bootstrap / admin 等
   *   —— 尤其 `probability`：哪怕只是"随机唤醒"，触发它的是**别人的消息**，所以不算自主。
   *
   * 代价（已知且有意的）：群聊里她永远拿不到自主回合 —— 因为 scheduleProactiveCheckV2
   * 明确跳过所有 group: 会话（"群里只被动唤醒，不要自己醒来"）。所以群里空间写操作
   * 等于永久禁用，这与主人的要求一致。
   *
   * ⚠️ 定义位置必须在所有使用者之前：`const` 有暂时性死区(TDZ)，而 sendWakePromptV2
   *    会在同一次调用里先用到它 —— 放在后面会让每次唤醒都抛 ReferenceError
   *    （本次实现时踩过，故提到 WAKE_PRIORITY 之前）。
   */
  const AUTONOMOUS_WAKE_REASONS = new Set(['proactiveCheck', 'timeout', 'replyCheck']);

  function isAutonomousWakeReason(reason) {
    return AUTONOMOUS_WAKE_REASONS.has(String(reason ?? '').split(':')[0]);
  }

  /**
   * 自主标记的有效期上限（TTL）。
   *
   * 为什么需要一个 TTL，而不是只靠"回合结束时复位"：
   *   复位挂在 turn/end 分支里，但那条路径上有若干 `continue`（静默回合、空文本回合等），
   *   而且桥接并不保证一定收得到 turn/end（DSH 重启、回合被腰斩、事件丢失）。
   *   实测就撞上过：18:04 触发的一次 proactiveCheck 之后，标记一直挂着 5 分钟没人清，
   *   期间任何写操作都会被放行 —— 那正是"被命令也能发声"的窗口。
   *
   * 取 15 分钟的依据：它的作用是"覆盖一个回合的正常长度"，正常回合是几十秒到几分钟。
   * 真跑得比 15 分钟还长的回合，本身已经该被 isTurnStaleV2 当成僵死回合看待了；
   * 此时让自主资格过期（而不是继续放行）是**失败关闭**的方向。
   */
  const AUTONOMOUS_TURN_TTL_MS = 15 * 60 * 1000;

  /**
   * ⭐ 「聊完之后的静默期 = 她的自由时间」（2026-10-20 主人要求）。
   *
   * 主人原话："希望她现在判断结束对话后的短暂时间也算她的自由时间"，门槛 3 分钟，
   * 空间三件事（发说说 / 点赞 / 评论）全部放行。
   *
   * 为什么需要它：她原本只有"自己冒泡"（proactiveCheck / timeout / replyCheck）算自主回合，
   * 而"跟你聊完、确认没下文"这段明明是她的时间，却因为**这一轮是你发的消息触发的**而不算 ⇒
   * 想发个说说也发不出去（实测：日志里一串「非自主回合」拒绝，10-13 之后 6 天没发说说）。
   *
   * ⚠️ 关键取舍：**不动 AUTONOMOUS_WAKE_REASONS**。
   *    把 private/admin 直接并进去，会让"你一边跟她聊天、她一边去空间发东西"成立
   *    —— 那正是当初设计这套闸门时要防的。这里改成**延迟盖章**：
   *    回合正常结束后等 3 分钟，期间没有新消息，才把这一段补记成自主回合。
   *    静默本身就证明"这段对话结束了"，比任何猜测都可靠。
   */
  // 默认 2.5 分钟（2026-10-20 主人定）；可在控制台「自由时间」栏改，config.json 的
  // socialV2.autonomy.quietGrantMs 覆盖它。**每次现读 cfg** ⇒ 改完立刻生效，不用重启。
  const AUTONOMOUS_QUIET_GRANT_MS_DEFAULT = 2.5 * 60 * 1000;
  /**
   * 静默多久算"聊完了"。范围钳制在 [10 秒, 60 分钟]：
   *   · 下限 10 秒 —— 防止设成 0（那等于一直在盖章，闸门形同拆除）
   *   · 上限 60 分钟 —— 再长就不叫"短暂时间"了，那样她基本拿不到自主权
   */
  function quietGrantMs() {
    const v = Number(cfg.socialV2?.autonomy?.quietGrantMs);
    if (!Number.isFinite(v) || v <= 0) return AUTONOMOUS_QUIET_GRANT_MS_DEFAULT;
    return Math.max(10000, Math.min(v, 60 * 60 * 1000));
  }

  /**
   * ⭐「静默期只是允许，不是必须」（2026-10-20 主人要求）。
   *
   * 主人原话："自由时间不是一定要发说说，我不希望每个对话结束她都去发说说"。
   *
   * 为什么必须有这道约束：静默盖章会让**每次聊完**都产生一次空间写权限，
   * 而她拿到权限就会去用 —— 结果是你每和她聊完一次，空间里就多一条说说。
   * 提示词里只说"只能是你真想说的"，**管不住频率**，所以这里在执行期再加一道。
   *
   * 口径：同一个会话**两次空间写操作之间**至少隔这么久（默认 4 小时）。
   * ⚠️ 它只限制「写」，不限制「读」（看空间、翻说说列表照旧随便）。
   * ⚠️ 记忆存在会话状态里（st.qzoneWriteAt），所以**重启不清零** ——
   *    只在内存里记的话，桥接重启一次她就又有一次机会，等于绕过了约束。
   */
  // 默认 4 小时；可在控制台改，config.json 的 socialV2.autonomy.qzoneWriteMinGapMs 覆盖。
  // 范围钳制在 [0, 7 天]：0 = 不限制（主人想让她随便发时可以这样设）。
  const QZONE_WRITE_MIN_GAP_MS_DEFAULT = 4 * 60 * 60 * 1000;
  function qzoneWriteMinGapMs() {
    const v = Number(cfg.socialV2?.autonomy?.qzoneWriteMinGapMs);
    if (!Number.isFinite(v) || v < 0) return QZONE_WRITE_MIN_GAP_MS_DEFAULT;
    return Math.min(v, 7 * 24 * 60 * 60 * 1000);
  }

  /**
   * 空间写操作是否被"太频繁"挡住（读 st.qzoneWriteAt）。
   * @returns {{ok:true}|{ok:false, remainMs:number}}
   */
  function qzoneWriteGapCheck(st) {
    const last = Number(st?.qzoneWriteAt || 0);
    if (!last) return { ok: true };
    // ⚠️ 只取一次门槛：它是现读 cfg 的函数，调两次可能因中途改配置而拿到不同值，
    //    那会让"判断是否放行"和"算剩余时间"用两个不同门槛 ⇒ 剩余时间算错。
    const gapMs = qzoneWriteMinGapMs();
    if (elapsed >= gapMs) return { ok: true };
    return { ok: false, remainMs: gapMs - elapsed };
  }

  /** 记一次空间写操作（成功落库后调用）。存进 state，所以重启不清零。 */
  function qzoneWriteMark(st) {
    if (!st) return;
    st.qzoneWriteAt = Date.now();
  }

  // key -> timeout：回合结束后等待静默的定时器。收到新消息要能取消它。
  const quietAutonomyTimers = new Map();

  /**
   * 回合结束后安排"静默 3 分钟就给自主权"。
   * 已有待办会先取消再重排：连续几轮对话时，以**最后一次**发言为起点算静默。
   */
  function scheduleQuietAutonomy(key) {
    if (!key) return false;
    const old = quietAutonomyTimers.get(key);
    if (old) { clearTimeout(old); quietAutonomyTimers.delete(key); }
    try {
      const t = setTimeout(() => {
        quietAutonomyTimers.delete(key);
        try {
          const st = getSocialV2State(key);
          // 到点了再确认一次真的没新消息：定时器可能与被延迟处理的入站消息交错。
          const lastIn = Number(st.lastIncomingAt || 0);
          if (lastIn && Date.now() - lastIn < quietGrantMs()) {
            log(`[quiet-autonomy] ${key} 静默期被新消息打断，本次不给自主权`);
            return;
          }
          st.turnAutonomous = true;
          // ⚠️ turnStartedAt 必须给"现在"而不是上一轮的起点：
          //    isAutonomousTurnActive 用它算 TTL，给旧值会让这次盖章**当场过期**
          //    （原回合可能已经跑了十几分钟，15 分钟的盖子一盖就没了）。
          st.turnStartedAt = Date.now();
          saveSocialV2State();
          // 门槛的人类可读说法（别硬编码"3 分钟"：那样调了门槛日志会骗人）
          const quietMin = Math.round(quietGrantMs() / 60000);
          log(`[quiet-autonomy] ${key} 聊完静默 ${quietMin} 分钟，这一小段算她自己的（空间写操作已放行）`);
          appendActivity(`${key} [autonomy] 聊完静默 ${quietMin} 分钟，给了一次自主机会`);
        } catch (e) {
          log(`[quiet-autonomy] ${key} 盖章失败：${e?.message ?? e}`);
        }
      }, quietGrantMs());
      if (typeof t.unref === 'function') t.unref();
      quietAutonomyTimers.set(key, t);
      return true;
    } catch (e) {
      log(`[quiet-autonomy] ${key} 安排失败：${e?.message ?? e}`);
      return false;
    }
  }

  /** 取消待办的静默盖章（收到新消息 / 拍一拍时调用）。 */
  function cancelQuietAutonomy(key, why = '') {
    const t = quietAutonomyTimers.get(key);
    if (!t) return false;
    clearTimeout(t);
    quietAutonomyTimers.delete(key);
    log(`[quiet-autonomy] ${key} 静默盖章已取消${why ? '（' + why + '）' : ''}`);
    return true;
  }

  /**
   * ⭐ 写操作闸门的**唯一判据入口**：当前是否处在有效的自主回合里。
   *
   * 三个条件必须同时成立（任何一个不成立都判 false）：
   *   ① turnAutonomous === true      —— 唤醒原因属于 AUTONOMOUS_WAKE_REASONS
   *   ② 有 turnStartedAt             —— 没有起点时间就无法判断新旧，fail-closed
   *   ③ 未超过 TTL                   —— 见上；防回合结束事件丢失导致的标记泄漏
   *
   * 两个写入口（/api/socialV2/qzone-action 与 /api/socialV2/send-qzone）都必须走这里，
   * 不要再各自写 `st.turnAutonomous !== true` —— 那样 TTL 就会被漏掉一处。
   */
  function isAutonomousTurnActive(st) {
    if (!st || st.turnAutonomous !== true) return false;
    const startedAt = Number(st.turnStartedAt);
    if (!Number.isFinite(startedAt) || startedAt <= 0) return false;
    return Date.now() - startedAt <= AUTONOMOUS_TURN_TTL_MS;
  }

  const WAKE_PRIORITY = {
    private: 100,
    atMention: 90,
    question: 80,
    speaker: 75,
    nameMention: 70,
    keyword: 60,
    anyMessage: 50,
    replyCheck: 40,
    timeout: 30,
    proactiveCheck: 20
  };

  // 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
  function wakePriorityV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    return WAKE_PRIORITY[base] ?? 0;
  }

  /**
   * ⭐ 自主回合的判据（2026-10-19，主人要求）：「凡是不是别人触发的回合都算她自己起的头」。
   *
   * 用途：QQ 空间的**写操作**（发说说/点赞/评论/删除/改可见性）只允许在自主回合里发生。
   * 为什么不能靠工具白名单实现：白名单只能表达"谁可以调用"，表达不了"这一轮是谁起的头" ——
   * 而主人要的恰恰是后者：任何人在对话里说一句「你去发条说说」都不能成立，
   * 包括主人自己。因此判据必须落在**唤醒原因**上，且在执行期由桥接检查。
   *
   * 三类算自主（都是"没人找她、她自己醒过来"）：
   *   proactiveCheck —— 主动机会：冷场久了，桥接按概率给她一次自己冒泡的机会（最典型的"自己想的"）
   *   timeout        —— 她自己设的有限潜水到期，回来看看
   *   replyCheck     —— 她刚说完话，回来看有没有人接（仍是她自己的节奏，不是被点名）
   *
   * 不算自主（**只要别人开口/动手就算**，fail-closed）：
   *   private / atMention / question / speaker / nameMention / keyword / anyMessage /
   *   probability / poke / bootstrap / admin 等
   *   —— 尤其 `probability`：哪怕只是"随机唤醒"，触发它的是**别人的消息**，所以不算自主。
   *
   * 代价（已知且有意的）：群聊里她永远拿不到自主回合 —— 因为 scheduleProactiveCheckV2
   * 明确跳过所有 group: 会话（"群里只被动唤醒，不要自己醒来"）。所以群里空间写操作
   * 等于永久禁用，这与主人的要求一致。
   *
   * ⚠️ 定义位置必须在所有使用者之前（见上方同名常量的说明）。
   */

  async function scheduleWakeV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      // ★2026-10-22：主人在她长回合里说话，不再只排队★
      // 主人原话：「当她一直玩游戏就不会反应我的新消息了」。她玩一局能连跑二十多分钟，
      // 这期间的每条消息都被塞进 pendingWakeReasons 等回合结束 —— 体感就是"不理人"。
      // 所以这里对**主人本人发来的即时消息**（private_admin）改走 steer：
      // 直接把消息插进正在跑的回合，她下一步就看得见。
      // 其余情况（群里、普通成员、定时唤醒）仍然排队 —— 那些打断她的代价大于收益，
      // 而且群消息洪峰下插队会把她的注意力撕碎。
      if (canSteerV2(key, reason)) {
        const steered = await steerIntoRunningTurnV2(key, reason, seq);
        if (steered.ok) {
          log(`[reserved2] 会话繁忙，但已插入正在跑的回合 ${key}（${reason}@seq${seq}）`);
          return;
        }
        log(`[reserved2] steer 未成功（${steered.error}），退回排队 ${key}（${reason}@seq${seq}）`);
      }
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      return;
    }
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    const batchMs = Math.max(1000, Number(st.wakeConfig?.batchWindowMs) || 8000);
    st.pendingWakeTimer = setTimeout(() => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      void sendWakePromptV2(key, finalReason).catch((error) => log(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error));
    }, batchMs);
    // 与其它 per-conversation 定时器保持一致：别让一个待唤醒定时器把进程钉住不退出。
    st.pendingWakeTimer.unref?.();
    log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送`);
  }

  /**
   * ⭐ 这个唤醒能不能"插进正在跑的回合"（2026-10-22，主人报「她玩游戏就不理我」）。
   *
   * 判据两条，缺一不可：
   *   ① **是主人私聊**：`private:<ownerQQ>`。群里/普通成员私聊不给这个能力 ——
   *      打断她正在做的事代价太大，而那些人本来也不该有"立刻到她面前"的权限。
   *   ② **是有人当场说了话**：private / admin / atMention / question / poke 这类。
   *      `proactiveCheck` / `timeout` / `replyCheck` / `bootstrap` 这些是**她自己的节奏**，
   *      插进去只会打断她 → 一律走排队（它们本来也不急）。
   */
  const STEERABLE_WAKE_REASONS = new Set([
    'private', 'admin', 'atMention', 'question', 'speakerIds', 'nameMention', 'keyword', 'poke',
  ]);

  function canSteerV2(key, reason) {
    if (currentMode !== 'reserved2') return false;
    if (!cfg.ownerQQ) return false;
    if (key !== `private:${String(cfg.ownerQQ)}`) return false;
    const base = String(reason ?? '').split(':')[0];
    return STEERABLE_WAKE_REASONS.has(base);
  }

  /**
   * 把"有人刚说了话"这件事插进她正在跑的回合（DSH 的 `mode: 'steer'`）。
   *
   * 为什么值得单独一条路：她玩游戏时一个回合能连跑二十多分钟（掷骰子 → 看回合 → 再掷），
   * 这期间 `mode:'queue'` 的消息要等整局结束才被她看见。steer 会把它放进 inbox 的
   * `next-step`（placement='steering'），她在下一步就能读到。
   *
   * 返回 {ok:true} 表示**插进去了**；{ok:false, error} 表示没插成（上层退回排队）。
   * ⚠️ 这里用一条**轻量**提示词，不是完整的 wake prompt：目的是"让她知道你说话了"，
   *    不是让她现在就换话题。完整的上下文她收尾时仍会照常读。
   */
  async function steerIntoRunningTurnV2(key, reason, seq) {
    try {
      const sessionId = await ensureSession(key);
      if (!sessionId) return { ok: false, error: '没有会话' };
      const st = getSocialV2State(key);
      // 带上"新说了什么"本身 —— 只报一句"有人说话"她还得再去查一遍，白花一轮。
      const fresh = Array.isArray(st.unread) ? st.unread.slice(-3) : [];
      const lines = fresh
        .filter((m) => m && Number(m.seq) >= Number(seq) - 2)
        .map((m) => `· ${m.isOwner ? '主人' : (m.sender || '对方')}：${String(m.plain ?? m.text ?? '').slice(0, 200)}`)
        .join('\n');
      const text = [
        '【插话·主人在你正忙的时候说了话】',
        '你手上那件事（比如正在玩的游戏）可以继续，但**先把他说的话听进去**。',
        lines ? `他刚说的：\n${lines}` : '他刚发了消息，具体内容用 qq_get_unread_messages 看。',
        '处理原则：',
        '1. 他说的是**新问题/新指令** → 先回应他，再决定要不要继续手上那件事；',
        '2. 他只是**评论/闲聊**（比如吐槽你玩得菜）→ 可以一句话接住，别丢掉手上那件事；',
        '3. 无论哪种，**别装没看见**。回完继续你的事就行。',
      ].join('\n');
      await api.sessions.prompt({ sessionId, mode: 'steer', content: [{ type: 'text', text }] });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error).slice(0, 120) };
    }
  }

  function setupSleepTimerV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    cancelReplyCheckV2(key); // 有限睡眠配置已接管，取消回复检查
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) {
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；远未来定时器先等满上限后重新续期，而不是提前唤醒。
    const MAX_TIMEOUT_MS = 100009;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimeout(() => {
        st.sleepTimer = null;
        setupSleepTimerV2(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 86400000)} 天后续期`);
      return;
    }
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

  function cancelProactiveCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    clearTimeout(st.proactiveTimer);
    st.proactiveTimer = null;
  }

  function scheduleProactiveCheckV2(key) {
    if (cfg.socialV2?.proactive?.enabled === false) return;
    // ⭐ 群聊不排「主动冒泡」：这是主人 2026-10-18 明确要求的「群里只被动唤醒，
    //    不要自己醒来」。主动机会是**无人搭话时自己起话头**，是"自己醒来"里
    //    最主动的一档（比概率唤醒更主动），所以必须挡住。
    //    ⚠️ 只挡群：私聊（private:）继续保留主动机会 —— 主人要的是"私聊还有这个功能"。
    //    ⚠️ 用 key 前缀判断（和上面 9475 行一代那段的 `key.startsWith('group:')` 同一口径），
    //       而不是关全局 `socialV2.proactive.enabled` —— 那个是全局开关，会把私聊一起关掉。
    if (key.startsWith('group:')) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    if (st.proactiveTimer) return;
    const p = cfg.socialV2?.proactive ?? {};
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      ensureWakeableV2(st, { key });
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
      if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
      // 有一句「想跟他说但还没说」的话（pendingThought）时，主动机会更像"真的好想找他"，
      // 而不是"掷骰子决定要不要说话"。
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
      // ⭐ 时间感系数：原来的 `23~8 点 ×0.3` 一刀切，把"饭点""清早""深夜但还聊着"
      //    全压成同一个数，于是"吃饭时说自己也饿了""早上叫他起床"这两种最像真人的主动
      //    几乎永远排不上。现在由 time-context.proactiveTimeFactor 按饭点/清晨/深夜/周末
      //    分别给系数（详见那个函数上方的注释）。
      const tf = proactiveTimeFactor(new Date(), {
        lastIncomingAt: st.lastIncomingAt || 0,
        lastAiReplyAt: st.lastAiReplyAt || 0
      });
      prob *= tf.factor;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      // 没完成的约定也算"她想做的事"：到点前她本该更常出现，而不是睡过去。
      const livePromises = Array.isArray(st.promises) ? st.promises.filter((x) => x && !x.doneAt).length : 0;
      if (livePromises > 0) prob = Math.min(1, prob * 1.15);
      prob = Math.min(1, prob);
      log(`[reserved2] 主动机会判定 ${key}：p=${prob.toFixed(3)}（时间系数 ${tf.reason}；冷场 ${humanGap(idle)}）`);
      if (idle >= idleThreshold && Math.random() < prob && !isConversationBusyV2(key, st)) {
        void sendWakePromptV2(key, 'proactiveCheck').catch((error) => log(`[reserved2] proactive 唤醒异常 ${key}:`, error?.message ?? error));
      }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    log(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

  function clearSocialV2Timers(key) {
    const st = socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    st.pendingWakeReason = null;
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (st.replyCheckTimer) {
      clearTimeout(st.replyCheckTimer);
      st.replyCheckTimer = null;
    }
    if (st.proactiveTimer) {
      clearTimeout(st.proactiveTimer);
      st.proactiveTimer = null;
    }
    if (st.promiseTimer) {
      clearTimeout(st.promiseTimer);
      st.promiseTimer = null;
    }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }

  function clearAllSocialV2Timers() {
    for (const key of socialV2.conversations.keys()) clearSocialV2Timers(key);
    pendingWakeKeys.clear();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    messageMediaStore.clear();
  }

  function drainPromptQueue(key, errorMsg) {
    const entry = promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    promptQueues.delete(key);
  }

  function drainAllPromptQueues(errorMsg) {
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    promptQueues.clear();
  }

  // QQ 消息 → DSH prompt
  async function handleIncoming(kind, id, event, cfg) {
    const key = convKey(kind, id);
    if (!modeAllowed(key, kind, id, cfg, currentMode)) {
      log(`忽略未授权会话 ${key}（当前模式 ${currentMode}，来自 ${event.user_id}）`);
      return;
    }
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = (messageId) => resolveReplyInfo(kind, id, messageId, event.self_id);
    // 入站语音先转写（进阶 3）。放在这里、拼文本之前，是为了让下面两个 segmentsToText
    // 复用同一份结果（只转一次），也让"这条是语音"进活动日志。
    const voiceMarkers = await transcribeVoiceSegments(event.message ?? []);
    if (voiceMarkers.size > 0) {
      appendActivity(`${key} [voice] 语音已转成文字：${[...voiceMarkers.values()][0].slice(0, 80)}`);
    }
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    const textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply, voiceMarkers });
    const plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false, voiceMarkers });
    const mediaList = extractMediaFromSegments(event.message ?? []);
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    if (!isSessionAllowedInCurrentMode(key)) return;
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    const roleState = readRoleState();

    // ── 群图自动收录（在静默/暂停之前，且 fire-and-forget）────────────────────
    // 三个刻意的选择：
    // ① 放在这里（而不是投递 prompt 时）：这样她潜水/静默/暂停时，群友发的好图**照样存得下来**。
    //    图库是"素材积累"，不该受"此刻要不要说话"影响。
    // ② 只收群图**和私聊图**都收，但排除机器人自己发的（isSelf 在这里由 event 侧判定不了，
    //    所以靠 captureMessagePhotos 内部不校验、改由下方 isOwner/自身消息判断）。
    // ③ 不 await：下载+哈希要几百毫秒，绝不能拖慢入站热路径。
    //    失败只在日志里说一声（captureMessagePhotos 内部已 try/catch），不影响消息投递。
    if (photoCollectEnabled() && mediaList.some((m) => m?.kind === 'image')) {
      let senderName = '群友';
      if (kind === 'group') {
        senderName = event.sender?.card || event.sender?.nickname || String(event.user_id);
      } else if (isOwner) {
        senderName = '主人';
      } else {
        senderName = '私聊';
      }
      void captureMessagePhotos(key, mediaList, {
        sourceKey: key,
        groupId: kind === 'group' ? String(id) : '',
        senderId: String(event.user_id ?? ''),
        senderName,
        msgText: plainContent.slice(0, 200)
      }).then((r) => {
        if (r.collected > 0) {
          appendActivity(`${key} [photo] 收录群图 ${r.collected} 张（重复 ${r.dups}）`);
          log(`[photo] ${key} 收录 ${r.collected} 张新图（重复 ${r.dups}，跳过 ${r.skipped}）`);
        }
      }).catch((error) => log(`[photo] 收录异常 ${key}: ${error?.message ?? error}`));
    }

    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    const p = pending.get(key);
    if (p && (p.kind === 'question' || isOwner)) {
      await handlePendingAnswer(p, plainContent, key, isOwner);
      return;
    }

    // 「向我申请」的答复：他在等她开口问的那件事上回了个「同意 / 不同意」。
    // ⚠️ 必须在**投递给 agent 之前**拦截：这条消息是给他的申请的回执，
    //    不是要她去回复的新话题 —— 若继续往下走，她会对着一句「同意」猜"同意什么"，
    //    然后要么重复申请、要么答非所问。
    if (isOwner && pendingPermitRequests.has(key)) {
      const verdict = parsePermitAnswer(plainContent);
      if (verdict) {
        await answerPermitRequest(key, verdict, plainContent);
        return;
      }
    }

    // 静默模式：群友消息不投递给 agent（只记录）；管理员消息照常
    if (roleState.mode === 'silent' && !isOwner) {
      appendActivity(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
      log(`静默模式，忽略群友消息 ${key}`);
      return;
    }

    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        await sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }
      if (plainContent === '/reset' || plainContent === '/new') {
        const old = state.sessions[key];
        if (old) {
          sessionEpoch++;
          delete state.sessions[key];
          modelAppliedSessions.delete(old);
          delete state.sessionPolicies[key];
          reverse.delete(old);
          collectors.delete(old);
          sendToolSucceededSessions.delete(old);
          pendingSendToolCalls.delete(old);
          v2TurnStartAt.delete(old);
          v2TurnLastEventAt.delete(old);
          toolCallNames.delete(old);
          social.silentTurns.delete(old);
          social.exitingSessions.delete(old);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          forgetAgentToken(key);
          // 同上：清上下文不删记忆。
          deleteConversationKeepingMemory(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 与 retireSession 一致：先终止 DSH 侧排队的工作，再归档（归档只隐藏会话）。
          try { await api.stopSessionWork(old); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await api.workspace.archiveSession({ sessionId: old }); } catch {}
          await sendToQQ(key, '已重置会话，下次消息将开新上下文');
        }
        return;
      }
      if (plainContent === '/status') {
        const rs = readRoleState();
        await sendToQQ(key, `会话 ${state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
        return;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          writeRoleState(null, roleState.mode);
          await sendToQQ(key, '已清除角色，恢复正常人格。');
        } else {
          const roleFile = path.join(ROOT, 'roles', name + '.md');
          if (!fs.existsSync(roleFile)) {
            await sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
          } else {
            writeRoleState(name, roleState.mode);
            await sendToQQ(key, `已切换角色：${name}。`);
          }
        }
        return;
      }
      if (plainContent === '/silent' || plainContent === '/quiet') {
        writeRoleState(roleState.role, 'silent');
        await sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
        return;
      }
      if (plainContent === '/active' || plainContent === '/speak') {
        writeRoleState(roleState.role, 'active');
        await sendToQQ(key, '已退出静默模式，恢复正常回复。');
        return;
      }
      // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
    }

    // 二代仿真模式（reserved2）：唤醒调度
    if (currentMode === 'reserved2') {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []));
      // 二代同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
      if (kind === 'group') feedSlangWindow(key, sender, plainContent);
      if (socialV2.paused) {
        appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      const st = getSocialV2State(key);
      if (!st.bootstrapSent) {
        st.bootstrapSent = true;
        saveSocialV2State();
        void scheduleWakeV2(key, 'bootstrap').catch(() => {});
      } else {
        const reason = evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        if (reason) {
          void scheduleWakeV2(key, reason).catch(() => {});
        }
      }
      appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
      return;
    }

    // 黑话学习素材：只从群聊普通消息进入滚动窗口（命令/角色控制语不学；只学当前消息自己的文字，不学引用原文）
    if (kind === 'group') {
      feedSlangWindow(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
    }

    // 角色扮演提示注入（仅注入给 agent，不影响群友之间的正常对话语义）
    // 顺手带上一句「顺着这句话想起来的更早的事」。v1 没有记忆索引注入，这条更要紧。
    const recallV1 = recallForPrompt(key, textContent);
    const roleHint = roleHintForCurrentMode() + (recallV1 ? String.fromCharCode(10, 10) + recallV1 : '');

    // 群聊里带发送者信息，私聊不用；角色提示注入到消息开头（agent 可见）；
    // 管理员消息带身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    const promptText = (roleHint ? roleHint + '\n\n' : '')
      + (isOwner ? '【管理员】' : '')
      + (kind === 'group'
        ? `${event.sender?.card || event.sender?.nickname || String(event.user_id)}：${textContent}`
        : textContent)
      + mediaHintFor(key, messageRef, mediaList);

    appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);

    // 仿真群友模式：reserved 走状态机（观望/活跃/试探/退场）
    if (isSocialEnabled()) {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef); // AI 始终感知
      const st = socialState(key);

      // 退场中：收尾发言发出前不再接话，新消息进入摘要
      if (st.phase === 'exiting') {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 退场中，新消息转入摘要`);
        return;
      }

      // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
      if (st.phase === 'active' && triggerActiveDurationExit(key, st, Date.now())) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return;
      }

      // 活跃 / 试探中：有新消息 → 保持活跃（或从试探回到活跃）
      if (st.phase === 'active' || st.phase === 'probing') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊：发给你就是叫你，直接即时投递，不等轮询、不参与沉默
        if (kind === 'private') {
          const promptText = `${roleHint ? roleHint + '\n\n' : ''}${isOwner ? '【管理员】' : ''}${textContent}${mediaHintFor(key, messageRef, mediaList)}`;
          scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList
          );
          log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return;
        }
        log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return;
      }

      // 启动阶段（观望）：触发条件 ① 明确对 AI 说（含引用机器人自己） ② 普通消息小概率
      // 指向性判断只基于当前消息自己的文字，不把引用原文算作“在叫 AI”
      const direct = isDirectAddress(plainContent, event, kind) || quoteTargetIsSelf;
      const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
      if (!direct && !randomTrigger) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return;
      }

      // 触发成功：进入活跃，贴最近上下文 + 当前消息 + 人格（仅此一次），让 AI 回复
      enterActive(key);
      const roleHint = roleHintForCurrentMode();
      const currentLine = (isOwner && kind === 'private') ? `【管理员】${sender}：${textContent}` : `${sender}：${textContent}`;
      const directionHint = textContent.includes('[引用') ? DIRECTION_HINT + '\n' : '';
      const replyInstruction = direct
        ? `请回复消息。\n${directionHint}${SPACE_SPLIT_HINT}`
        : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${directionHint}${SPACE_SPLIT_HINT}`;
      const promptText = `${roleHint ? roleHint + '\n\n' : ''}【群聊上下文】\n${buildContextBlock(key)}\n【当前消息】${currentLine}${mediaHintFor(key, messageRef, mediaList)}\n\n${replyInstruction}`;
      if (isOwner && kind === 'private') {
        log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await deliverPrompt(key, promptText, { media: mediaList });
      } else {
        scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList
        );
      }
      return;
    }

    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, media: mediaList });
      queued.set(key, items);
      const now = Date.now();
      if ((queuedHintAt.get(key) ?? 0) + QUEUE_HINT_COOLDOWN_MS < now) {
        queuedHintAt.set(key, now);
        await sendToQQ(key, '⏳ 系统服务重启中，消息已排队，恢复后自动处理。');
      }
      log(`DSH 不可用，消息入队 (${key})`);
      return;
    }

    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, { media: mediaList });
        return;
      }
      throw error;
    }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(mediaList) && mediaList.length > 0) {
      const imageParts = await resolveMediaList(mediaList);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    const accepted = await api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content
    });
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
      return;
    }
    if (cfg.ackMessage && currentMode !== 'reserved2') await sendToQQ(key, cfg.ackMessage);
    log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }

  // 取消/拒绝一个挂起的提问或审批，并给 DSH 回执（超时、被新请求覆盖时使用）
  async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      if (entry.kind === 'approval') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: 'rejected' }
        }), 5000, '取消挂起回执');
        log(`已取消挂起审批（拒绝回执）: ${entry.eventId ?? entry.rpcId}`);
      } else if (entry.kind === 'question') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: { answers: [] } }
        }), 5000, '取消挂起回执');
        log(`已取消挂起提问（空答案回执）: ${entry.eventId ?? entry.rpcId}`);
      }
    } catch (error) {
      log('取消挂起请求回执失败:', error?.message ?? error);
    }
  }

  // 回答挂起的提问/审批
  /**
   * 他回话之后，把「同意/不同意」交给正在等的那一次申请。
   *
   * 这里**不发 QQ**：她的申请工具调用还挂着，端点那边会拿到结果并把它写进
   * 她那轮的工具返回里 —— 她读到的就是"他同意了，现在可以玩到几点"。
   * 再由她自己决定说一句什么（比如「那我玩会儿，等会儿回来」）。
   * 桥接在她背后再补一句"已批准"，反而像系统播报，不像她。
   */
  async function answerPermitRequest(key, verdict, rawText) {
    const entry = pendingPermitRequests.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingPermitRequests.delete(key);
    log(`[permit] ${key} 收到主人答复「${String(rawText).slice(0, 40)}」→ ${verdict.allowed ? `同意(${verdict.ttlMs ?? '默认'})` : '拒绝'}`);
    entry.resolve({ allowed: verdict.allowed === true, ttlMs: verdict.ttlMs, raw: verdict.raw });
  }

  async function handlePendingAnswer(p, answerText, key, isOwner = false) {
    if (p.kind === 'question') {
      const answers = [];
      for (const q of p.questions) {
        const opts = q.options ?? [];
        const hit = opts.find((o) => o.label.trim().toLowerCase() === answerText.trim().toLowerCase());
        if (hit) answers.push({ id: q.id, selected: [hit.label] });
        else answers.push({ id: q.id, selected: [], custom: answerText });
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: { answers } }
        });
        log(`已回答提问 (${key}):`, receipt);
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('回答问题失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 回答提交失败，请再回复一次。');
      }
      return;
    }
    if (p.kind === 'approval') {
      if (!isOwner) {
        await sendToQQ(key, '审批仅管理员可操作');
        return;
      }
      const t = answerText.trim().toLowerCase();
      let outcome = null;
      for (const w of APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
      for (const w of REJECT_WORDS) if (t === w) outcome = 'rejected';
      if (!outcome) {
        await sendToQQ(key, '请回复「通过」或「拒绝」来决定这个审批');
        return;
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: outcome }
        });
        log(`已处理审批 (${key}): ${outcome}`, receipt);
        await sendToQQ(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('处理审批失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 审批回执提交失败，请再回复一次「通过」或「拒绝」。');
      }
      return;
    }
  }

  // 二代拍一拍（notify/poke）事件处理：写入消息流并按需唤醒。
  async function handlePokeNotice(event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = convKey('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = convKey('private', id);
    }
    if (!modeAllowed(key, kind, id, cfg, currentMode)) return;
    if (currentMode !== 'reserved2') {
      appendActivity(`${key} 收到拍一拍事件（非 reserved2，仅记录）：${senderId} -> ${targetId}`);
      return;
    }
    let sender = senderId;
    if (kind === 'group' && senderId) {
      try {
        sender = await resolveGroupMemberName(Number(id), senderId) || senderId;
      } catch {}
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    const isOwner = String(senderId) === String(cfg.ownerQQ ?? '');
    const msg = appendSocialV2Poke(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (currentMode !== 'reserved2') return;
    if (socialV2.paused) return;
    const st = getSocialV2State(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      saveSocialV2State();
      void scheduleWakeV2(key, 'bootstrap').catch(() => {});
    } else if (st.wakeConfig?.triggers?.poke) {
      void scheduleWakeV2(key, 'poke').catch(() => {});
    }
  }

  async function registerPending(key, entry) {    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
      log(`新挂起请求覆盖旧请求 (${key})`);
      cancelPendingEntry(existing).catch(() => {});
    }
    const timer = setTimeout(() => {
      if (pending.get(key) === entry) {
        pending.delete(key);
        log(`挂起请求超时 (${key})`);
        cancelPendingEntry(entry).catch(() => {});
        sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, cfg.questionTimeoutMs);
    entry.timer = timer;
    pending.set(key, entry);
  }

  // DSH 事件流 → QQ
  async function pumpMux() {
    for (;;) {
      try {
        log('连接 DSH 事件流…');
        for await (const envelope of api.events.mux({})) {
          const frame = envelope.payload;
          // 会话开场快照：只喂 token 账本。它含**历史** turn/end，绝不能让它们走
          // session/event 通道 —— 否则桥接会把早已结束的回合当成新回合去发 QQ 回复。
          if (frame.type === 'session/snapshot') {
            recordSessionSnapshot(frame.sessionId, frame.snapshot);
            continue;
          }
          if (frame.type === 'session/event') {
            // Token 记账放在最前面：无论会话是否仍属当前模式/是否学习会话，
            // 花掉的钱都是真的，都必须入账（归属由 resolveKey 决定）。
            recordSessionUsage(frame.sessionId, frame.event);
            // 看门狗心跳：任何事件都算“这个回合还活着”。AI 长轮询等待期间没有 turn/end，
            // 只有这个时间戳能证明它没死，否则会被误当僵死回合回收。
            v2TurnLastEventAt.set(frame.sessionId, Date.now());
            v2TurnRestored.delete(frame.sessionId); // live event 证明回合还活着，恢复正常 12 分钟窗口
            const key = reverse.get(frame.sessionId);
            if (!key) {
              // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
              if (learnerSessions.has(frame.sessionId)) {
                const learnerCollector = learnerCollectors.get(frame.sessionId) ?? createTurnCollector();
                learnerCollectors.set(frame.sessionId, learnerCollector);
                const learnerEnded = learnerCollector.push(frame.event);
                if (learnerEnded) {
                  learnerCollectors.delete(frame.sessionId);
                  const waiters = learnerWaiters.get(frame.sessionId) ?? [];
                  const waiter = waiters.shift();
                  if (waiters.length === 0) learnerWaiters.delete(frame.sessionId);
                  if (waiter) {
                    clearTimeout(waiter.timer);
                    if (learnerEnded.reason.kind === 'completed' && learnerEnded.text.trim()) {
                      waiter.resolve(learnerEnded.text);
                    } else {
                      waiter.reject(new Error(`学习会话 turn 未正常完成：${learnerEnded.reason.kind}`));
                    }
                  }
                  // 旧学习会话 turn 结束后从集合移除，避免残留
                  if (frame.sessionId !== slangLearnerSessionId) learnerSessions.delete(frame.sessionId);
                }
              }
              continue;
            }
            // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
            if (!isCurrentSession(key, frame.sessionId)) continue;
            // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
            if (frame.event.type === 'turn/start') {
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              v2TurnStartAt.set(frame.sessionId, Date.now());
            }
            if (frame.event.type === 'tool/call') {
              const toolName = String(frame.event.data?.name ?? '');
              const callId = frame.event.data?.callId;
              const args = sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
              appendToolLog({ type: 'call', time: new Date().toISOString(), key, sessionId: frame.sessionId, tool: toolName, args });
              if (callId != null) {
                if (isSendToolName(toolName)) {
                  let pending = pendingSendToolCalls.get(frame.sessionId);
                  if (!pending) {
                    pending = new Set();
                    pendingSendToolCalls.set(frame.sessionId, pending);
                  }
                  pending.add(callId);
                }
                let nameMap = toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
              }
            }
            if (frame.event.type === 'tool/result') {
              const callId = frame.event.data?.message?.source?.callId;
              const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              const resultBlock = frame.event.data?.message?.content?.[0];
              const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
              const errorText = resultError ? String(resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error ?? '') : '';
              appendToolLog({
                type: 'result',
                time: new Date().toISOString(),
                key,
                sessionId: frame.sessionId,
                tool: toolName,
                ok: !resultError,
                error: errorText ? sanitizeToolArgs(errorText) : null
              });
              if (callId != null) {
                toolCallNames.get(frame.sessionId)?.delete(String(callId));
                const pending = pendingSendToolCalls.get(frame.sessionId);
                if (pending?.has(callId)) {
                  pending.delete(callId);
                  if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
                  if (!resultError) {
                    sendToolSucceededSessions.add(frame.sessionId);
                  }
                }
              }
            }
            const collector = collectors.get(frame.sessionId) ?? createTurnCollector();
            collectors.set(frame.sessionId, collector);
            const ended = collector.push(frame.event);
            if (ended) {
              // ⭐ 通话回合优先消费：如果有 sidecar 正在等这个会话的文本，先把 `ended.text`
              //    交给它，然后**立刻 continue** —— 这个回合的回复绝不能再走下面的发送路径。
              //    放在这里（而不是复用下面的静默名额分支）是因为那个分支只管"吞掉"，
              //    吞掉之后 sidecar 就永远等不到这句话了。
              if (resolveCallTurn(frame.sessionId, ended.text, ended.reason)) {
                v2TurnStartAt.delete(frame.sessionId);
                v2TurnLastEventAt.delete(frame.sessionId);
                v2TurnRestored.delete(frame.sessionId);
                collectors.delete(frame.sessionId);
                sendToolSucceededSessions.delete(frame.sessionId);
                pendingSendToolCalls.delete(frame.sessionId);
                toolCallNames.delete(frame.sessionId);
                // 静默名额是我这边压进去的，这里要自己摘掉，否则会吞掉下一轮正常回复。
                const silQ = social.silentTurns.get(frame.sessionId) ?? [];
                if (silQ.length > 0) {
                  silQ.shift();
                  if (silQ.length > 0) social.silentTurns.set(frame.sessionId, silQ);
                  else social.silentTurns.delete(frame.sessionId);
                }
                log(`[call] 通话回合结束（${key ?? '?'}），回复已交给通话引擎`);
                continue;
              }
              // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
              // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
              const silentQueueNow = social.silentTurns.get(frame.sessionId) ?? [];
              const isSilentTurn = silentQueueNow.length > 0;
              if (currentMode === 'reserved2' && key && !isSilentTurn) {
                const st = getSocialV2State(key);
                const turnStart = v2TurnStartAt.get(frame.sessionId) ?? 0;
                const actionTaken = sendToolSucceededSessions.has(frame.sessionId) || (turnStart > 0 && st.lastActionAt >= turnStart);
                if (actionTaken) {
                  st.wakeConfig.noActionCount = 0;
                } else {
                  st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                  const limit = Number(cfg.socialV2?.wake?.noActionLimit) || 3;
                  if (st.wakeConfig.noActionCount >= limit) {
                    log(`[reserved2] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
                    st.wakeConfig = defaultWakeConfigV2();
                    st.bootstrapSent = true;
                    st.wakeConfig.noActionCount = 0;
                  }
                }
                saveSocialV2State();
              }
              v2TurnStartAt.delete(frame.sessionId);
              v2TurnLastEventAt.delete(frame.sessionId);
              v2TurnRestored.delete(frame.sessionId);
              collectors.delete(frame.sessionId);
              // ⭐ 回合结束必须清掉自主标记：否则它会一直留到下一轮（可能是"别人找她"的
              // 回合），那等于把写权限泄漏出去 —— 这正是最该避免的失败方向。
              if (currentMode === 'reserved2' && key) {
                const stEndTurn = getSocialV2State(key);
                // ⭐「聊完静默期算她的自由时间」（2026-10-20）：先记下这一轮**是否本来就是自主回合**。
                //    判据直接用 turnAutonomous（它在唤醒时按 AUTONOMOUS_WAKE_REASONS 写定），
                //    比读 lastWakeReason 更稳 —— 那个字段可能被下一次唤醒提前改写。
                const wasAutonomous = stEndTurn.turnAutonomous === true;
                if (stEndTurn.turnAutonomous || stEndTurn.turnStartedAt) {
                  stEndTurn.turnAutonomous = false;
                  stEndTurn.turnStartedAt = 0;
                  saveSocialV2State();
                }
                // 只在**非自主**回合之后盖章：她自己冒泡那种（proactiveCheck 等）本来就能写空间，
                // 而且结束后会另走一条路安排下次醒来，不需要这里多给一次。
                // ⚠️ 静默回合（无声回合）不盖章：那种回合本就不该产生对外动作。
                if (!wasAutonomous && !isSilentTurn) {
                  scheduleQuietAutonomy(key);
                }
              }
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              toolCallNames.delete(frame.sessionId);
              // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
              const isFarewell = social.exitingSessions.has(frame.sessionId);
              if (isFarewell) social.exitingSessions.delete(frame.sessionId);
              // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
              // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
              const silentQueue = social.silentTurns.get(frame.sessionId) ?? [];
              const silentNow = Date.now();
              while (silentQueue.length && silentNow - silentQueue[0].ts > SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
              if (silentQueue.length > 0) {
                silentQueue.shift();
                if (silentQueue.length > 0) social.silentTurns.set(frame.sessionId, silentQueue);
                else social.silentTurns.delete(frame.sessionId);
                log(`摘要投喂 turn 结束，静默 (${key})`);
                continue;
              }
              // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
              // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
              if (pendingWakeKeys.has(key)) {
                pendingWakeKeys.delete(key);
                disarmPendingWakeLease(key);
                if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                  ensureWakeableV2(getSocialV2State(key), { key });
                  wakeConfigUpdatedKeys.delete(key);
                  markReadCalledKeys.delete(key);
                  wakeConfigMissCount.delete(key);
                } else {
                  const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    wakeConfigMissCount.set(key, currentMiss);
                    pendingWakeKeys.add(key);
                    armPendingWakeLease(key);
                    deliverPrompt(key, buildWakeReminderPromptV2(key)).then((result) => {
                      if (result && result.ok === false) {
                        pendingWakeKeys.delete(key);
                        disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      pendingWakeKeys.delete(key);
                      disarmPendingWakeLease(key);
                      log(`[reserved2] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
                    });
                    log(`[reserved2] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
                  } else {
                    const st = getSocialV2State(key);
                    st.wakeConfig = defaultWakeConfigV2();
                    saveSocialV2State();
                    log(`[reserved2] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
                  }
                }
              }
              // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次，避免关键 @/提问被漏掉。
              // 但如果触发它的消息已经被 AI 在当前回合处理（unread 中已不存在该 seq），则不再补发。
              {
                const stEnd = getSocialV2State(key);
                if (Array.isArray(stEnd.pendingWakeReasons) && stEnd.pendingWakeReasons.length) {
                  const item = stEnd.pendingWakeReasons.shift();
                  if (!item || typeof item !== 'object') {
                    // 兼容旧字符串残留
                  } else {
                    const stillRelevant = Array.isArray(stEnd.unread) && stEnd.unread.some((m) => m && Number(m.seq) >= Number(item.seq));
                    if (stillRelevant) {
                      log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}@seq${item.seq}`);
                      void scheduleWakeV2(key, item.reason).catch(() => {});
                    } else {
                      log(`[reserved2] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} 已被当前回合处理，跳过补发`);
                    }
                  }
                }
              }
              if (ended.reason.kind === 'completed' && ended.text.trim()) {
                const plain = mdToPlain(ended.text);
                // 纯 Markdown/空白输出按“无文本”处理，避免后续 planSocialTimeline 拿空串崩溃。
                if (!plain.trim()) {
                  log(`agent 回复为空（仅格式/空白）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 空退场回合，回到观望`);
                    }
                  }
                  continue;
                }
                // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
                if (isSilentMarker(plain)) {
                  log(`社交模式：AI 选择静默（${SILENT_MARKER}）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场选择静默，回到观望`);
                    }
                  }
                  continue;
                }
                // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
                if (sendToolSucceeded) {
                  log(`工具已发送消息，跳过自动转发 (${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 工具发送后退场完成，回到观望`);
                    }
                  }
                  continue;
                }
                // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
                const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && plain.includes(t));
                if (shouldAuditKey(key) && (SENSITIVE_RE.test(plain) || hasKnownToken)) {
                  log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
                  appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
                  if (cfg.security?.interceptNotify !== false) {
                    await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
                  }
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场发言被拦截，回到观望`);
                    }
                  }
                  continue;
                }
                // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
                if (isSocialEnabled()) {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    if (isFarewell) {
                      const st = socialState(key);
                      if (st.phase === 'exiting') {
                        st.phase = 'idle';
                        st.activeDeadlineAt = 0;
                        st.activeExitAt = 0;
                        log(`社交模式：${key} 静默模式下退场回合被拦截，回到观望`);
                      }
                    }
                    continue;
                  }
                  const timeline = planSocialTimeline(plain, cfg.social);
                  const messages = timeline.main;
                  log(`agent 回复 (${key}) ${plain.length} 字 → ${messages.length} 条`);
                  appendActivity(`${key} agent 回复：${messages[0].slice(0, 80)}${messages.length > 1 ? '（分' + messages.length + '条）' : ''}${messages[0].length > 80 ? '…' : ''}`);
                  if (messages.length > 1) {
                    await sendBurstToQQ(key, messages, cfg.social);
                  } else {
                    await sendToQQ(key, messages[0]);
                  }
                  // 发言后刷新活跃时间，并调度可能的二次补刀
                  const st = socialState(key);
                  if (isFarewell) {
                    // 确认为退场发言：不再刷新活跃时间、不调度补刀，直接进入观望
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言完成，进入观望`);
                  } else if (st.phase === 'exiting') {
                    // 退场期间有旧回复恰好完成：照常发出，但不把它当作退场，也不调度补刀
                    log(`社交模式：${key} 退场期间旧回复完成，保持退场状态`);
                  } else {
                    if (lastSendSucceeded(key)) {
                      st.lastActiveMessageAt = Date.now();
                      st.lastAiReplyAt = Date.now();
                      log(`社交模式：发言完成，刷新活跃时间 (${key})`);
                    } else {
                      // 发送其实失败了（网关报错/超时/被限流）。旧代码照样刷新时间戳，
                      // 于是「我说过话了」这个判断被写进状态：主动发言概率被压低、
                      // 活跃调度往前走，而群里根本没收到消息。这里不刷新，让下一轮照常补上。
                      log(`社交模式：${key} 本轮发言未送达（QQ 发送失败），不刷新活跃时间`);
                    }
                  }
                } else if (currentMode === 'reserved2') {
                  log(`[reserved2] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
                  appendActivity(`${key} [reserved2] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                } else {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    continue;
                  }
                  log(`agent 回复 (${key}) ${plain.length} 字`);
                  appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                  await sendToQQ(key, plain);
                }
              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                const safeMsg = shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                await sendToQQ(key, `⚠️ agent 处理出错：${safeMsg}`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言出错，回到观望`);
                  }
                }
              } else if (ended.reason.kind === 'aborted') {
                await sendToQQ(key, '⏹️ 已停止');
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言中止，回到观望`);
                  }
                }
              } else if (!ended.text.trim()) {
                // completed 但没文本（纯工具调用回合）
                log(`回合完成但无文本 (${key})`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场回合无文本，回到观望`);
                  }
                }
              }
            }
          } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && learnerSessions.has(frame.sessionId)) {
            // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
            try {
              if (frame.type === 'question/requested') {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } }
                });
              } else {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: 'rejected' }
                });
              }
              log('黑话学习会话自动跳过提问/审批');
            } catch (error) {
              log('自动响应学习会话提问/审批失败:', error?.message ?? error);
            }
          } else if (frame.type === 'question/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'question' }); continue; }
            const lines = frame.questions.map((q, i) => {
              const qText = String(q.question ?? '');
              const sensitive = shouldAuditKey(key) && SENSITIVE_RE.test(qText);
              if (sensitive) log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
              const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
              let s = `${i + 1}. ${safeQuestion}`;
              if (q.options?.length) {
                const opts = q.options.map((o) => {
                  const label = String(o.label ?? '');
                  const optSensitive = shouldAuditKey(key) && SENSITIVE_RE.test(label);
                  if (optSensitive) log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
                  return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
                });
                s += '\n   ' + opts.join(' ');
              }
              return s;
            });
            await sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
            await registerPending(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, questions: frame.questions });
          } else if (frame.type === 'approval/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'approval' }); continue; }
            const rawReason = frame.reason ?? '';
            const sensitiveReason = shouldAuditKey(key) && SENSITIVE_RE.test(rawReason);
            if (sensitiveReason) log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
            const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
            const reason = safeReason ? `\n理由：${safeReason}` : '';
            const rawToolName = frame.toolName ?? '';
            const sensitiveTool = shouldAuditKey(key) && SENSITIVE_RE.test(rawToolName);
            if (sensitiveTool) log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
            const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
            await sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
            await registerPending(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, toolName: frame.toolName });
          } else if (frame.type === 'stream/error') {
            log('事件流错误:', frame.error);
          }
        }
      } catch (error) {
        log('事件流中断:', error?.message ?? error);
      } finally {
        // WebSocket 正常关闭和异常中断都会走到这里；必须清掉旧 turn 相关状态，
        // 否则重连后旧 collector/标记残留会导致回复重复累加或误判。
        collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
        social.silentTurns.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
        sendToolSucceededSessions.clear();
        pendingSendToolCalls.clear();
        v2TurnStartAt.clear();
        v2TurnLastEventAt.clear();
        v2TurnRestored.clear(); // 恢复宽限标记也必须清：残留会让断线后新回合被误按 90 秒宽限回收
        toolCallNames.clear();
        pendingWakeKeys.clear();
        clearAllPendingWakeLeases();
        social.exitingSessions.clear();
        wakeConfigUpdatedKeys.clear();
        markReadCalledKeys.clear();
        wakeConfigMissCount.clear();
        // 长轮询（qq_wait_for_messages）的租约也要清：它的 req.on('close') 在事件流
        // 断开时不一定触发，残留租约会用 429 卡住该会话最长 15 分钟的等待工具。
        activeWaits.clear();
      }
      await sleep(3000);
    }
  }

  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  bot.onPrivateMessage(async (event) => {
    if (event.user_id === event.self_id) return;
    try { await handleIncoming('private', event.user_id, event, cfg); } catch (error) { log('处理私聊消息出错:', error?.message ?? error); }
  });
  bot.onGroupMessage(async (event) => {
    if (event.sender?.user_id === event.self_id || event.user_id === event.self_id) return;
    try { await handleIncoming('group', event.group_id, event, cfg); } catch (error) { log('处理群消息出错:', error?.message ?? error); }
  });
  bot.onNotice('notify', async (event) => {
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
  });

  // ── 上游健康：任何事件包都算「SnowLuma 还活着」，心跳还额外带接收链路健康度 ──
  // 用 onEvent 挂一个**旁路**订阅（不影响主链路）：
  //   · 任意事件包 → 记账（证明 SnowLuma 进程 + WS 链路还在）；
  //   · `meta_event/heartbeat` → 读载荷里的 `status.good`。**这是主信号**：
  //     SnowLuma 每 30 秒无条件发一次心跳，而 good = online && receiveHealthy 是它对
  //     「QQ → hook → 我」这条接收链路的自评（实测核对过 1.14.9 运行时源码）。
  //     免费、及时，且**不依赖较新的运行时**。
  // 注册失败不影响主链路（不同 SDK 版本的订阅方法可能不同），所以整体包在 try 里。
  try {
    bot.onEvent((event) => {
      const post = event?.post_type;
      noteUpstreamPacket(post
        ? `${post}${event.notice_type ? `/${event.notice_type}` : ''}${event.meta_event_type ? `/${event.meta_event_type}` : ''}${event.message_type ? `/${event.message_type}` : ''}`
        : 'event');
      if (post === 'meta_event' && event?.meta_event_type === 'heartbeat') {
        // status 未在 SDK 类型里声明（OneBotMetaEvent 只声明 meta_event_type），
        // 但 OneBotBaseEvent 是 JsonObject，读取合法。
        noteReceiveHealth(event.status?.good, 'heartbeat');
        if (typeof event.status?.online === 'boolean') snowlumaHealth.accountOnline = event.status.online;
        reportSnowlumaHealth();
      }
    });
  } catch (error) {
    log(`（上游事件旁路订阅不可用，健康检测退化：${error?.message ?? error}）`);
  }

  // SnowLuma 1.14.17 起新增 bot_status（账号会话边沿）。老运行时不会发这个事件，
  // 所以它只是加分项：收到就记下来，收不到不影响其它判断。
  try {
    bot.onBotStatus((event) => {
      noteUpstreamPacket('notice/bot_status');
      const sub = String(event?.sub_type ?? '');
      snowlumaHealth.accountOnline = sub === 'online';
      if (sub === 'offline') {
        log('⚠️ SnowLuma 报告 QQ 账号会话已离线（bot_status: offline）—— QQ 侧掉线或被顶号，'
          + '在重新登录之前群里不会有任何消息进来。');
      } else if (sub === 'online') {
        log('SnowLuma 报告 QQ 账号会话已上线（bot_status: online）');
      }
    });
  } catch (error) {
    log(`（bot_status 订阅不可用（SnowLuma 运行时较旧？）：${error?.message ?? error}）`);
  }

  bot.on('open', () => {
    // 用实际连接地址（自愈后可能与 config 里的初值不同，别打印过期的那个）
    const connectedUrl = bot.url ?? cfg.snowluma.wsUrl;
    snowlumaHealth.connected = true;
    log(`SnowLuma 已连接：${connectedUrl}`);
    // 「已连接」只说明与 SnowLuma 的 WebSocket 通了，**不说明 QQ 侧收得到消息** ——
    // 这个区别见 startSnowlumaWatch 的说明。这里顺手把上游健康快照刷一次。
    void pollSnowlumaStatus();
    // 读取机器人昵称（用于社交模式"被提到"识别）；重连后也会刷新
    bot.getLoginInfo().then((login) => {
      if (login?.nickname) {
        selfNickname = String(login.nickname).toLowerCase();
        // 提示词要给原始大小写（`@小鲸鱼` 里是正常写法，全小写会让人对不上号）。
        selfDisplayName = String(login.nickname).trim();
        log(`机器人昵称: ${login.nickname}`);
      }
      // 自己的 QQ 号：`user_id` / `self_id` / `qq` 三种字段名都见过，取第一个能用的。
      const rawId = login?.user_id ?? login?.self_id ?? login?.qq ?? '';
      const idText = String(rawId ?? '').trim();
      if (/^\d{5,12}$/.test(idText)) {
        selfUserId = idText;
        log(`机器人 QQ 号: ${selfUserId}`);
      }
    }).catch(() => {});
    // 连接成功后顺手确认一下 token 是否已跟当前账号对齐；不一致就写回 config.json，
    // 让 MCP 工具（另一个进程）也能拿到正确的 token。
    void syncTokenToFile();
  });

  /**
   * SnowLuma 恢复连接时自愈 accessToken。
   *
   * 为什么需要：SnowLuma 的 OneBot 配置按账号分文件（config/onebot_<QQ号>.json），
   * 每个账号 token 不同。换账号登录后，config.json 里的旧 token 会 401/连不上，
   * 而 SDK 的重连会一直用**构造时**那个 token 无限重试 —— 表现为"桥接活着但收发全废"。
   * 这里在每次重连失败时重新发现当前账号的 token 并热更新，随后自愈。
   */
  /**
   * 应用自愈结果：**HTTP token 与 WS token 是两个不同的值**。
   *   - cfg.snowluma.accessToken → HTTP 调用（发语音、fetch_ptt_text、get_msg 等）与写回 config.json
   *   - bot.accessToken          → WebSocket 连接（桥接的主链路，端口 3001）
   * 只修其中一个的话，桥接仍会以 1006 反复重连（实测踩过）。
   */
  async function applyHealedTokens(r) {
    const httpToken = r.token;
    const wsToken = r.wsToken || r.token;
    // ⚠️ 端点跟随是可关的（`snowluma.followDiscoveredEndpoint: false`），默认保持原行为。
    //
    // 为什么需要这个开关：自愈会拿 `discoverSnowLumaConnection()` **发现到的** wsUrl
    // 覆盖掉配置里的值，并写回 config.json。这在"换了 QQ 账号所以端口变了"的主场景下
    // 是对的（端口确实是 per-account 的），但它**不区分**「用户写的是一个过期值」和
    // 「用户就是要指向别处」。后果：
    //   · 想跑第二个实例/指向另一份 SnowLuma 安装（多账号、测试、灰度）时，
    //     它会静默把端点改回去、连到发现到的那一份 —— 表现为"消息发到了另一个账号/群"，
    //     或者"我明明指向了 B 却一直在收 A 的消息"，很难归因；
    //   · 实测踩过：把 wsUrl 指向一个死端口想让它"别连"，启动后仍被改回真实端点并连上。
    // 关掉之后**只自愈 token**（换账号仍然能恢复），但绝不动 URL、也不写回 URL。
    const followEndpoint = cfg.snowluma?.followDiscoveredEndpoint !== false;
    const wsUrl = followEndpoint ? (r.wsUrl || cfg.snowluma.wsUrl) : cfg.snowluma.wsUrl;
    const wsChanged = bot.accessToken !== wsToken || bot.url !== wsUrl;
    bot.accessToken = wsToken || undefined;
    // 端口也是 per-account 的（实测：换账号后 WS 从 3001 之类变到别的端口），
    // 只换 token 不换 URL 会一直 1006 重连。
    bot.url = wsUrl;
    if (wsChanged) log(`🔄 SnowLuma WS 连接已更新：${wsUrl}（token ${String(wsToken).slice(0, 4)}…）`);
    if (cfg.snowluma.accessToken !== httpToken) {
      log(`🔄 SnowLuma HTTP token 已更新（来源 ${r.source}）：${String(cfg.snowluma.accessToken).slice(0, 4)}… → ${String(httpToken).slice(0, 4)}…`);
      cfg.snowluma.accessToken = httpToken;
    }
    if (!followEndpoint && r.wsUrl && r.wsUrl !== cfg.snowluma.wsUrl) {
      log(`   （已按 snowluma.followDiscoveredEndpoint=false 忽略发现到的端点 ${r.wsUrl}，继续用配置值 ${cfg.snowluma.wsUrl}）`);
    }
    // 把确认可用的端点写回 config.json：下次启动直接就对了，不用再自愈一遍。
    // ⚠️ 必须在**改 cfg 之前**算出要写什么，但写文件时对照的是**文件里**的旧值 ——
    //    这里显式传 wsUrl，且不依赖 cfg 的内存值来判断"是否需要写"。
    // 关掉端点跟随时不写 URL：否则"我设了别处"这件事会被自愈持久化地抹掉。
    const previousWsUrl = cfg.snowluma.wsUrl;
    cfg.snowluma.wsUrl = wsUrl;
    try {
      const w = persistSnowLumaEndpoint(path.join(ROOT, 'config.json'), {
        accessToken: httpToken,
        ...(followEndpoint ? { wsUrl, httpUrl: r.baseUrl } : {})
      });
      if (w.updated) log(`   已写回 config.json：${Object.keys(w.changed).join(' / ')}`);
      else log('   config.json 端点已是最新，无需改写');
      if (!followEndpoint && previousWsUrl !== wsUrl) cfg.snowluma.wsUrl = previousWsUrl;
    } catch (error) {
      log(`   ⚠️ 写回 config.json 失败：${error?.message ?? error}`);
    }
    // 更新了就让 SDK 立刻用新参数重连（否则要等下一轮退避，最长要好几秒）
    if (wsChanged) {
      try { bot.close(1000, 'token-refresh'); } catch {}
      try { bot.connect(); } catch {}
    }
    return wsChanged;
  }

  /** 只写文件、不动物件（连接已成功时用）。 */
  async function syncTokenToFile() {
    try {
      const r = persistToken(path.join(ROOT, 'config.json'), cfg.snowluma.accessToken ?? '');
      if (r.updated) log(`🔄 已把当前 token 写回 config.json（${String(r.from).slice(0, 4)}… → ${String(r.to).slice(0, 4)}…）`);
    } catch {}
  }

  let tokenHealAt = 0;
  async function healTokenIfStale(reason) {
    const now = Date.now();
    if (now - tokenHealAt < 10000) return;   // 节流：close 事件会连续触发
    tokenHealAt = now;
    try {
      const r = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 });
      if (!r.ok) {
        log(`⚠️ token 自愈失败（${reason}）：${r.error}`);
        return;
      }
      await applyHealedTokens(r);
      log(`   自愈完成：账号 ${r.self?.user_id ?? '?'}（${reason}）`);
    } catch (error) {
      log(`⚠️ token 自愈异常：${error?.message ?? error}`);
    }
  }

  bot.on('close', (info) => {
    snowlumaHealth.connected = false;
    log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`);
    // 连不上时最常见的原因就是换了 QQ 账号 → token 变了；顺手自愈。
    // 注意 1006 在**每次启动**都可能出现一次：HTTP token 与 WS token 是两个不同的值，
    // config.json 里存的是前者，WS 需要用自愈发现的那个（详见 bot.connect() 处的说明）。
    void healTokenIfStale(`close code=${info?.code ?? '?'}`);
  });
  bot.on('error', (error) => log('SnowLuma 错误:', error));

  // SnowLuma 尚未就绪时不阻塞桥接启动：SDK 自带后台重连，DSH 侧照常连接。
  bot.connect().catch((error) => {
    // 说明为什么"第一次连不上"在这里几乎是**必然**的，避免用户把它当成故障：
    // SnowLuma 的 **HTTP token（默认 3000）与 WS token（默认 3001）是两个不同的值**
    // （实测：同一个账号，两者不同；config.json 只能存一个，存的是 HTTP 那个）。
    // 所以 WS 首次连接通常会被拒 → close(1006) → 触发 token 自愈（重新发现 WS token）
    // → 重连成功后才是「SnowLuma 已连接」。若 homeDir 没配/被移动/读不到 SnowLuma 的
    // config/onebot_<QQ>.json，自愈就无从下手，这时才会一直连不上 —— 那种情况请查
    // 日志里的「token 自愈失败」与 config.json 的 snowluma.homeDir。
    log(`SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）: ${error?.message ?? error}`);
  });
  log('桥接已启动。按 Ctrl+C 退出。');
  // 预热表情库：启动时同步一次 QQ 收藏表情，失败不阻塞（AI 首次调用工具时还会再试）。
  if (cfg.socialV2?.sticker?.enabled !== false) {
    syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', error?.message ?? error));
  }
  startDshWatch();
  startSnowlumaWatch();
  startCallWatch();
  startConsoleServer();
  startDiaryNudge();
  // 模拟器到期巡检：phone 授权到期时把"我们自己开的"模拟器关掉。
  startEmulatorSweep();
  // 语音转写预热：模型加载要 2.5~3.5 秒，提前到"刚启动还没人说话"时做完，
  // 免得到时候他发的第一条语音要等加载。没开转写时这里是空操作。
  if (asr.prewarm()) log('语音转写：正在后台预热模型（首次约几十秒，之后每条语音约 0.6 秒）。');
  // 语音合成预热同理：edge 引擎每次冷启一个 python 进程要 4 秒左右，提前起好，
  // 她第一次想发语音时就不用等。没开合成时这里是空操作。
  if (tts.prewarm()) log('语音合成：正在后台预热引擎（首次约几秒，之后每次合成约几百毫秒）。');

  await pumpMux();
}

process.on('SIGINT', () => {
  log('退出中…');
  try { asrInstance?.dispose(); } catch {}
  try { ttsInstance?.dispose(); } catch {}
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  try { asrInstance?.dispose(); } catch {}
  try { ttsInstance?.dispose(); } catch {}
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => {
  // 打出 stack：只记 message 的话，「偶发一次」和「已经坏了六小时」看起来一模一样。
  log('未处理异常:', error?.stack ?? error?.message ?? error);
});
/**
 * 未捕获异常兜底。
 *
 * 为什么必须有：`log()` 是从 SnowLuma SDK 的 socket 事件回调里被调用的，而 SDK 的
 * emitter 逐个调用监听器、不做任何保护。stdout 的读者（守护 cmd 窗口）一旦消失，
 * `console.log` 会抛 EPIPE —— 这个异常会一路穿过 log() → 监听器 → emit → socket 回调，
 * 变成 uncaughtException。没有兜底的话整个 24/7 进程直接死掉且不留堆栈，
 * 在 start.bat 的重启循环里就变成「每 5 秒崩一次」。
 */
process.on('uncaughtException', (error) => {
  try { log('致命异常（进程即将退出）:', error?.stack ?? error?.message ?? error); } catch {}
  try { asrInstance?.dispose(); } catch {}
  try { ttsInstance?.dispose(); } catch {}
  try { saveState(); } catch {}
  releaseLock();
  process.exit(1);
});
// dispose 的同步部分（关 stdin）在这里仍然有效，能让那个 python worker 自己退出；
// 它内部那个 1.5 秒后硬杀的定时器不会跑，所以别指望这条路能收尸 —— SIGINT/SIGTERM 才是正路。
process.on('exit', () => {
  try { asrInstance?.dispose(); } catch {}
  try { ttsInstance?.dispose(); } catch {}
  releaseLock();
});

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});

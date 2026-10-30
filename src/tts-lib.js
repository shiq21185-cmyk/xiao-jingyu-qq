// 本机语音合成（TTS）：让她**自己开口说话**——把一段文字念成语音条发出去。
//
// 与 asr-lib.js 的分工：那个是"她听"（收到语音 → 文字），这个是"她说"
// （文字 → 语音）。两者共用同一个 venv（<tools>\asr\.venv）与同一个
// toolsDir，但引擎、依赖、失败面完全不同，所以代码分开、互不影响。
//
// 两个引擎（tts.py 里实现，可用 socialV2.tts.engine 选）：
//   edge  微软 Edge 的在线神经网络语音。自然、像真人，但**要联网**，而且要念的
//         文字会发到微软的语音服务。
//   sapi  Windows 自带的离线语音。零联网、零额外依赖，机器味重、中文音色少，
//         但**她的话一个字都不出这台电脑**。
//
// 为什么要常驻进程：edge 引擎每次冷启 python 要 ~4 秒（实测 4624/4097/4176 ms），
// 而真正的合成本身只有几百毫秒。说话是"发出去就要被听到"的东西，4 秒太钝。
//
// ★ 安全边界（为什么合成结果**不**走 resolveVoicePathForV2）：
//   那条路只认语音库（audio/）里的文件，是一道刻意保留的防线——防的是
//   prompt injection 诱导她把本机任意音频外发。TTS 产物在库外，所以**绝不放宽那道检查**：
//   她只能把「一段文字」交给本模块，路径由桥接自己生成、自己用完就删，
//   她永远拿不到"指定任意路径去发"的能力。
//
// ★ 硬约束：合成失败**永远不能**让她卡住或把消息吃掉。任何一步失败（没配好、
//   worker 起不来、没网、超时）一律返回 null，调用方照旧报错/走文字，
//   所有异常都在本模块内吞掉，只写日志。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// tools 目录是可移植的：默认「本仓库的兄弟目录 qq-bridge-tools/asr」（与 asr-lib.js 同一处）。
// 换电脑后若放在别处，用 config.json 的 socialV2.tts.toolsDir 指过去。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TTS_DEFAULT_TOOLS_DIR = path.join(path.dirname(REPO_ROOT), 'qq-bridge-tools', 'asr').replace(/\\/g, '/');
export const TTS_DEFAULT_ENGINE = 'edge';
export const TTS_DEFAULT_VOICE = 'zh-CN-XiaoyiNeural';
export const TTS_DEFAULT_MAX_CHARS = 300;
export const TTS_DEFAULT_TIMEOUT_MS = 30000;
export const TTS_DEFAULT_LOAD_TIMEOUT_MS = 60000;
// QQ 语音条的时长上限默认 300 秒（voice.maxSeconds），但一条语音太长没人听完，
// 而且合成失败面更大；所以默认只念 300 字（≈1 分钟以内），要更长自己调。
export const TTS_EXT_BY_ENGINE = { edge: '.mp3', sapi: '.wav' };

const MAX_STDERR_LINES = 40;
const RESPAWN_COOLDOWN_MS = 30000;
const GIVE_UP_AFTER = 3;
const GIVE_UP_MS = 5 * 60 * 1000;
const SPEECH_PREFIX = 'qq-speak-';

/** 归一化 socialV2.tts 配置；缺项全部给默认值。 */
export function ttsCfg(socialV2 = {}) {
  const v = socialV2?.tts ?? {};
  const toolsDir = String(v.toolsDir || TTS_DEFAULT_TOOLS_DIR).replace(/\\/g, '/').replace(/\/+$/, '');
  const engine = String(v.engine || TTS_DEFAULT_ENGINE).toLowerCase();
  return {
    enabled: v.enabled === true,
    engine,
    voice: String(v.voice || (engine === 'sapi' ? '' : TTS_DEFAULT_VOICE)),
    rate: String(v.rate || ''),
    volume: String(v.volume || ''),
    pitch: String(v.pitch || ''),
    toolsDir,
    workerPath: String(v.workerPath || `${toolsDir}/tts_worker.py`),
    pythonPath: String(v.pythonPath || `${toolsDir}/.venv/Scripts/python.exe`),
    // 合成产物落在这里（默认系统临时目录），发完即删
    spoolDir: String(v.spoolDir || ''),
    timeoutMs: Number(v.timeoutMs) > 0 ? Number(v.timeoutMs) : TTS_DEFAULT_TIMEOUT_MS,
    loadTimeoutMs: Number(v.loadTimeoutMs) > 0 ? Number(v.loadTimeoutMs) : TTS_DEFAULT_LOAD_TIMEOUT_MS,
    maxChars: Number(v.maxChars) > 0 ? Number(v.maxChars) : TTS_DEFAULT_MAX_CHARS,
    prewarm: v.prewarm !== false,
  };
}

/**
 * 把要念的文字收拾干净：去控制字符、**剥 Markdown 记号**、压空白、限长。
 *
 * 为什么必须剥 Markdown：她说话带着 `**重点**`、`# 标题`、`|表格|` 这类记号，
 * 直接念出来会变成"星号星号重点星号星号"。念给人听的东西必须是纯口语。
 */
export function cleanSpeechText(text, maxChars = TTS_DEFAULT_MAX_CHARS) {
  let s = String(text ?? '');
  s = s.replace(/\r\n?/g, '\n');
  // 行首的列表记号（`- `、`+ `、`* `、`1. `、`1、`）念出来是"减号"或一段奇怪的停顿，
  // 先去干净；正文里正常的破折号（`——`）不受影响，因为只认行首一个记号。
  // `-`/`+`/`*` 后面**必须有空格**才算记号（否则 `-5 度` 里的负号会被误吃），
  // 而 `1.`/`1、` 这种本身就是分隔符，空格可有可无。
  s = s.replace(/(^|\n)[ \t]*(?:[-+*][ \t]+|\d+[.、)][ \t]*)/g, '$1');
  s = s.replace(/\n+/g, ' ');
  s = s.replace(/[`*_~#>|]+/g, '');
  s = s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  const cap = Number(maxChars) > 0 ? Number(maxChars) : TTS_DEFAULT_MAX_CHARS;
  if (s.length > cap) s = `${s.slice(0, cap).trim().replace(/[\s，。、；：]+$/, '')}…`;
  return s;
}

/** 这个引擎合成出来的扩展名（喂给 SnowLuma 的 record 段）。 */
export function speechExt(engine = TTS_DEFAULT_ENGINE) {
  return TTS_EXT_BY_ENGINE[String(engine).toLowerCase()] || '.mp3';
}

/** 生成一个一次性的语音产物路径（目录可配，默认系统临时目录）。 */
export function newSpeechPath(engine = TTS_DEFAULT_ENGINE, spoolDir = '') {
  const dir = spoolDir ? String(spoolDir) : os.tmpdir();
  const name = `${SPEECH_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}${speechExt(engine)}`;
  return path.join(dir, name);
}

/** 删掉合成产物。只删我们自己命名的那种文件，避免误删。 */
export function cleanupSpeech(file) {
  try {
    if (!file) return;
    if (!path.basename(file).startsWith(SPEECH_PREFIX)) return;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* 删不掉就算了，临时目录里的东西不致命 */
  }
}

/** 常驻 TTS worker：与 AsrWorker 同构的行分隔 JSON 协议。 */
export class TtsWorker {
  constructor(options, log = () => {}) {
    this.options = options;
    this.log = log;
    this.child = null;
    this.pending = new Map();
    this.seq = 0;
    this.ready = false;
    this.dead = false;
    this.stderr = [];
    this.cooldownUntil = 0;
    this.fastDeaths = 0;
    this.gaveUpUntil = 0;
    this.spawnedAt = 0;
    this.warnedUnavailable = false;
    this.engine = null;
    this.voice = null;
  }

  available() {
    if (this.dead) return false;
    if (Date.now() < this.gaveUpUntil) return false;
    try {
      return fs.existsSync(this.options.pythonPath) && fs.existsSync(this.options.workerPath);
    } catch {
      return false;
    }
  }

  ensure() {
    if (this.dead) throw new Error('TTS worker 已关闭');
    if (this.child && !this.child.killed && this.ready) return this.child;
    if (this.child && !this.child.killed && this.child.exitCode === null) return this.child;
    if (Date.now() < this.cooldownUntil) throw new Error('TTS worker 刚异常退出，冷却中');
    if (Date.now() < this.gaveUpUntil) throw new Error('TTS worker 连续启动失败，已暂停');
    if (!this.available()) throw new Error(`TTS worker 不可用（缺 python 或 tts_worker.py）：${this.options.pythonPath}`);

    const env = {
      ...process.env,
      TTS_ENGINE: this.options.engine,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    };
    const child = spawn(this.options.pythonPath, [this.options.workerPath], {
      cwd: path.dirname(this.options.workerPath),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.ready = false;
    this.spawnedAt = Date.now();

    const out = readline.createInterface({ input: child.stdout });
    out.on('line', (line) => this.onLine(line));
    const err = readline.createInterface({ input: child.stderr });
    err.on('line', (line) => {
      this.stderr.push(String(line).slice(0, 400));
      if (this.stderr.length > MAX_STDERR_LINES) this.stderr.shift();
      this.log(`[tts] ${line}`);
    });

    child.on('error', (error) => {
      this.log(`⚠️ [tts] worker 启动失败：${error?.message ?? error}`);
      this.failAll(`worker 启动失败：${error?.message ?? error}`);
      this.onExit(null);
    });
    child.on('exit', (code, signal) => this.onExit(code ?? signal ?? '?'));
    return child;
  }

  onExit(code) {
    const lived = Date.now() - this.spawnedAt;
    this.child = null;
    this.ready = false;
    this.failAll(`worker 已退出（code=${code}）`);
    if (this.dead) return;
    if (lived < 5000) this.fastDeaths += 1;
    else this.fastDeaths = 0;
    this.cooldownUntil = Date.now() + RESPAWN_COOLDOWN_MS;
    if (this.fastDeaths >= GIVE_UP_AFTER) {
      this.gaveUpUntil = Date.now() + GIVE_UP_MS;
      this.fastDeaths = 0;
      this.log(`⚠️ [tts] worker 连续 ${GIVE_UP_AFTER} 次快速退出，暂停 5 分钟（她这段时间只能用文字说话）`);
    }
    if (code !== 0 && code !== '0') {
      const tail = this.stderr.slice(-3).join(' / ');
      if (tail) this.log(`⚠️ [tts] worker 退出前最后几行：${tail}`);
    }
  }

  failAll(reason) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  onLine(line) {
    let msg = null;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg && msg.id === 0) {
      if (msg.ready) {
        this.ready = true;
        this.fastDeaths = 0;
        this.engine = msg.engine ?? null;
        this.voice = msg.voice ?? null;
        this.log(`[tts] 就绪：engine=${this.engine ?? '?'} voice=${this.voice ?? '?'}`);
      } else {
        this.log(`⚠️ [tts] worker 启动失败：${msg.error ?? '未知'}（她这段时间只能用文字说话）`);
      }
      return;
    }
    const entry = this.pending.get(msg?.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg);
    else entry.reject(new Error(msg.error ?? '合成失败'));
  }

  /** 发一条请求；等回复或超时。超时不杀进程。 */
  send(payload, timeoutMs) {
    const child = this.ensure();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`等待合成超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  prewarm() {
    if (!this.available()) return false;
    try {
      this.ensure();
      return true;
    } catch (error) {
      this.log(`⚠️ [tts] 预热失败：${error?.message ?? error}`);
      return false;
    }
  }

  dispose() {
    this.dead = true;
    this.failAll('TTS worker 正在关闭');
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.stdin.write(`${JSON.stringify({ id: ++this.seq, shutdown: true })}\n`); } catch {}
    try { child.stdin.end(); } catch {}
    setTimeout(() => { try { child.kill(); } catch {} }, 1500).unref?.();
  }
}

/**
 * 桥接用的外观：一个实例管一个 worker，`synthesize()` 把文字变成一段音频文件。
 * **从不抛错**；失败返回 null（并把半截文件删掉，别让 0 字节喂给网关）。
 */
export function createTts({ socialV2, log = () => {}, liveEnabled = null } = {}) {
  const cfg = ttsCfg(socialV2);
  const worker = new TtsWorker({
    workerPath: cfg.workerPath,
    pythonPath: cfg.pythonPath,
    engine: cfg.engine,
    timeoutMs: cfg.timeoutMs,
    loadTimeoutMs: cfg.loadTimeoutMs,
  }, log);

  return {
    cfg,
    worker,
    /**
     * ⚠️ 这是**启动快照**，不反映运行期改动。
     *
     * 控制台可以改 socialV2.tts.enabled，但本实例的 cfg 是 createTts 那一刻复制的；
     * 靠它判断"要不要合成"会出现"开关关了却还在发语音"。
     * 需要热判定时请用 isEnabled()（读注入的实时值，见下）。
     */
    get enabled() { return cfg.enabled; },
    /**
     * 实时是否启用。`liveEnabled` 是桥接注入的回调（每轮现读 cfg.socialV2），
     * 没注入时退回启动快照 —— 单测/独立使用时行为不变。
     */
    isEnabled() {
      try {
        if (typeof liveEnabled === 'function') return liveEnabled() === true;
      } catch { /* 回调炸了就当快照 */ }
      return cfg.enabled;
    },
    /** 返回 { path, bytes, voice, engine } 或 null。 */
    async synthesize({ text, voice, rate, volume, pitch, outPath, budgetMs } = {}) {
      // 用 isEnabled() 而不是 cfg.enabled：后者是启动快照，控制台关掉开关后它还是 true。
      if (!this.isEnabled()) return null;
      const spoken = cleanSpeechText(text, cfg.maxChars);
      if (!spoken) return null;
      if (!worker.available()) {
        if (!worker.warnedUnavailable) {
          worker.warnedUnavailable = true;
          log('⚠️ [tts] 语音合成已开启，但 worker 不可用（检查 socialV2.tts.pythonPath / workerPath）');
        }
        return null;
      }
      const out = outPath || newSpeechPath(cfg.engine, cfg.spoolDir);
      const budget = Number(budgetMs) > 0
        ? Number(budgetMs)
        : (worker.ready ? cfg.timeoutMs : cfg.loadTimeoutMs);
      try {
        const res = await worker.send({
          text: spoken,
          out,
          engine: cfg.engine,
          voice: voice || cfg.voice || undefined,
          rate: rate || cfg.rate || undefined,
          volume: volume || cfg.volume || undefined,
          pitch: pitch || cfg.pitch || undefined,
          maxChars: cfg.maxChars,
        }, budget);
        const file = String(res?.path || out);
        const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
        if (!bytes) {
          cleanupSpeech(file);
          log('⚠️ [tts] 合成结果是空文件，已丢弃');
          return null;
        }
        return { path: file, bytes, voice: res?.voice ?? null, engine: res?.engine ?? cfg.engine, chars: spoken.length };
      } catch (error) {
        cleanupSpeech(out);
        log(`⚠️ [tts] 合成失败（她这条只能发文字）：${error?.message ?? error}`);
        return null;
      }
    },
    prewarm() { return cfg.enabled && cfg.prewarm ? worker.prewarm() : false; },
    dispose() { worker.dispose(); },
  };
}

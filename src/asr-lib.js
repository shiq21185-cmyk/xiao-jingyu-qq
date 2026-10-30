// 入站语音转文字（ASR）：把她**收到的**QQ 语音变成文字给她看。
//
// 为什么不能自己解码：QQ 语音是 NT SILK，仓库里没有 ffmpeg.exe，唯一会解的地方是
// SnowLuma 的 native ffmpeg addon。所以音频字节这样拿：
//   收到 record 段 → POST <snowluma>/get_record { file, out_format:'wav' } → 回 base64 wav
// 桥接既不用下载、也不用转码（SnowLuma 侧零安装）。
//
// 为什么要常驻进程：识别用 faster-whisper（本机 GPU，模型 463 MB）。模型加载要
// 2.5~3.5 秒，而 QQ 语音常常只有几秒——每条都现起进程等于每条语音白等一次加载。
// 所以模型只加载一次的常驻 worker（asr/worker.py，行分隔 JSON 协议）才是正解，
// 热转写实测 0.6~1.2 秒。
//
// ★ 硬约束（与"浏览器没开就别卡住"同一类要求）：转写**永远不能**让收消息这条链路
//   卡住或抛错。任何一步失败——没配好、worker 起不来、SnowLuma 转码失败、超时——
//   一律返回 null，消息照旧带 `[语音]` 继续走。所有异常都在本模块内吞掉，只写日志。
//
// 本机事实（实测）：
// - venv：<tools>\asr\.venv\Scripts\python.exe（faster-whisper 1.2.1 + av 13.1.0）
// - 模型缓存：<tools>\asr\models（faster-whisper small，463.7 MB）
// - GPU：RTX 4060 Laptop 8 GB；cuda/float16 vs cpu/int8 ≈ 0.6s vs 7.0s（11.46s 音频）
// - CUDA 的 DLL 不在 PATH，靠 worker.py 里的 _add_cuda_dll_dirs() 才能加载

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

// tools 目录是可移植的：默认「本仓库的兄弟目录 qq-bridge-tools/asr」。
// 换电脑后若放在别处，用 config.json 的 socialV2.asr.toolsDir / socialV2.tts.toolsDir 指过去
// （bridge.js 会把配置里的值原样传给 asrCfg/ttsCfg，这里只是没人配置时的兜底）。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ASR_DEFAULT_MAX_CHARS = 800;
export const ASR_DEFAULT_TIMEOUT_MS = 20000;
export const ASR_DEFAULT_LOAD_TIMEOUT_MS = 180000;
// 消息路径专用的两个上限。为什么必须**比**上面的宽松值小得多：
// handleIncoming 是串行 await 的，转写期间这条消息还没入队，后面来的消息也跟着排队。
// 冷启动等模型加载（180s）放在离线 CLI 里合理，放在收消息的链路上就是"她卡住了"。
// 所以inline 这一路最多等这么久，超了就放弃这次转写、照旧走 `[语音]`（预热仍在后台继续）。
export const ASR_DEFAULT_INLINE_LOAD_TIMEOUT_MS = 15000;
export const ASR_DEFAULT_FETCH_TIMEOUT_MS = 8000;
export const ASR_DEFAULT_TOOLS_DIR = path.join(path.dirname(REPO_ROOT), 'qq-bridge-tools', 'asr').replace(/\\/g, '/');

const MAX_STDERR_LINES = 40;
const RESPAWN_COOLDOWN_MS = 30000;   // 刚死过就别立刻再起，避免崩溃循环刷屏
const GIVE_UP_AFTER = 3;             // 连续这么多次快速死掉就暂时停手
const GIVE_UP_MS = 5 * 60 * 1000;

/** 归一化 socialV2.asr 配置；缺项全部给默认值。 */
export function asrCfg(socialV2 = {}) {
  const v = socialV2?.asr ?? {};
  const toolsDir = String(v.toolsDir || ASR_DEFAULT_TOOLS_DIR).replace(/\\/g, '/').replace(/\/+$/, '');
  return {
    enabled: v.enabled === true,
    toolsDir,
    workerPath: String(v.workerPath || `${toolsDir}/worker.py`),
    pythonPath: String(v.pythonPath || `${toolsDir}/.venv/Scripts/python.exe`),
    model: String(v.model || 'small'),
    language: String(v.language || 'zh'),
    device: String(v.device || 'auto'),
    modelDir: String(v.modelDir || `${toolsDir}/models`),
    timeoutMs: Number(v.timeoutMs) > 0 ? Number(v.timeoutMs) : ASR_DEFAULT_TIMEOUT_MS,
    loadTimeoutMs: Number(v.loadTimeoutMs) > 0 ? Number(v.loadTimeoutMs) : ASR_DEFAULT_LOAD_TIMEOUT_MS,
    // 收消息这条路上能等的上限（见文件头注释：不能把 180 秒的模型加载挂在消息链路上）
    inlineLoadTimeoutMs: Number(v.inlineLoadTimeoutMs) > 0 ? Number(v.inlineLoadTimeoutMs) : ASR_DEFAULT_INLINE_LOAD_TIMEOUT_MS,
    fetchTimeoutMs: Number(v.fetchTimeoutMs) > 0 ? Number(v.fetchTimeoutMs) : ASR_DEFAULT_FETCH_TIMEOUT_MS,
    maxChars: Number(v.maxChars) > 0 ? Number(v.maxChars) : ASR_DEFAULT_MAX_CHARS,
    prewarm: v.prewarm !== false,
  };
}

/**
 * 从一个 record 段里取出"能拿去问 SnowLuma 的键"。
 * 返回 { ref, duration }；取不到返回 null。
 *
 * 线上字段（SnowLuma 1.14.22 实测）：data = { file: fileName, url: 带 rkey 的下载地址 }。
 * `file` 其实是**文件名**不是路径，但它同时也是 mediaStore 的查询别名之一
 * （rememberRecord 用 [file, fileName, fileId, url] 四个别名），所以两个都能当键用。
 * url 更可靠（get_record 里 cached.url 直接可用），file 兜底。
 */
export function recordRefOf(segment) {
  const d = segment?.data ?? {};
  const ref = String(d.url || d.file || d.file_id || '').trim();
  if (!ref) return null;
  const duration = Number(d.duration ?? d.time ?? 0);
  return { ref, duration: Number.isFinite(duration) && duration > 0 ? duration : null };
}

/** 转写文本的清洗：压空白、去控制字符、按 maxChars 截断（带省略号）。 */
export function cleanTranscript(text, maxChars = ASR_DEFAULT_MAX_CHARS) {
  const cleaned = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cap = Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : ASR_DEFAULT_MAX_CHARS;
  if (cleaned.length <= cap) return cleaned;
  return `${cleaned.slice(0, Math.max(1, cap - 1))}…`;
}

/**
 * 注入消息文本的语音标记。
 *
 * 为什么带时长：她自己看得见"这句话有多长"，5 秒的一声「嗯」和 40 秒的一段话
 * 不该长得一样。拿不到时长就省略。
 */
export function formatVoiceMarker({ text, durationSeconds, maxChars = ASR_DEFAULT_MAX_CHARS } = {}) {
  const said = cleanTranscript(text, maxChars);
  if (!said) return '[语音]';
  const secs = Number(durationSeconds);
  const head = Number.isFinite(secs) && secs >= 1 ? `[语音 ${Math.round(secs)}秒：` : '[语音：';
  return `${head}${said}]`;
}

/**
 * 常驻转写进程的封装。
 *
 * 协议（见 asr/worker.py）：
 *   发 {"id":N,"b64":"<wav base64>"} / {"id":N,"wav":"路径"} / {"id":N,"ping":true}
 *   收 {"id":N,"ok":true,"text":...,"duration_seconds":...,"device":...}
 *      {"id":0,"ready":true,"model":"small","device":"cuda"}  ← 启动完成
 */
export class AsrWorker {
  constructor(options = {}, log = () => {}) {
    this.options = options;
    this.log = log;
    this.child = null;
    this.pending = new Map();
    this.seq = 0;
    this.ready = false;
    this.dead = false;          // dispose() 之后不再重启
    this.stderr = [];
    this.cooldownUntil = 0;
    this.fastDeaths = 0;
    this.gaveUpUntil = 0;
    this.spawnedAt = 0;
    this.warnedUnavailable = false;
  }

  /** 现在是不是可用（起得来、没被判死）。只看状态，不启动进程。 */
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
    if (this.dead) throw new Error('ASR worker 已关闭');
    if (this.child && !this.child.killed && this.ready) return this.child;
    if (this.child && !this.child.killed && this.child.exitCode === null) return this.child;
    if (Date.now() < this.cooldownUntil) throw new Error('ASR worker 刚异常退出，冷却中');
    if (Date.now() < this.gaveUpUntil) throw new Error('ASR worker 连续启动失败，已暂停');
    if (!this.available()) throw new Error(`ASR worker 不可用（缺 python 或 worker.py）：${this.options.pythonPath}`);

    const env = {
      ...process.env,
      ASR_MODEL: this.options.model,
      ASR_LANGUAGE: this.options.language,
      ASR_DEVICE: this.options.device,
      ASR_MODEL_DIR: this.options.modelDir,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      // 模型已经下好了；万一要重下，也走镜像，别去碰不通的 huggingface.co
      HF_HUB_DISABLE_XET: '1',
      HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
      HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
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
      this.log(`[asr] ${line}`);
    });

    child.on('error', (error) => {
      this.log(`⚠️ [asr] worker 启动失败：${error?.message ?? error}`);
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
    // 只在"起得很快又死"时累计，正常 shutdown 后不会走到这里
    if (lived < 5000) this.fastDeaths += 1;
    else this.fastDeaths = 0;
    this.cooldownUntil = Date.now() + RESPAWN_COOLDOWN_MS;
    if (this.fastDeaths >= GIVE_UP_AFTER) {
      this.gaveUpUntil = Date.now() + GIVE_UP_MS;
      this.fastDeaths = 0;
      this.log(`⚠️ [asr] worker 连续 ${GIVE_UP_AFTER} 次快速退出，暂停 5 分钟（语音仍以 [语音] 形式照常入队）`);
    }
    if (code !== 0 && code !== '0') {
      const tail = this.stderr.slice(-3).join(' / ');
      if (tail) this.log(`⚠️ [asr] worker 退出前最后几行：${tail}`);
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
        this.log(`[asr] 模型就绪：${msg.model ?? '?'} / ${msg.device ?? '?'}`);
      } else {
        this.log(`⚠️ [asr] worker 加载模型失败：${msg.error ?? '未知'}`);
      }
      return;
    }
    const entry = this.pending.get(msg?.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg);
    else entry.reject(new Error(msg.error ?? '转写失败'));
  }

  /** 发一条请求；等回复或超时。超时**不会**杀进程（可能只是模型还在加载）。 */
  send(payload, timeoutMs) {
    const child = this.ensure();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`等待转写超时（${timeoutMs}ms）`));
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

  /** 永远不抛：失败返回 null。
   *
   * budgetMs 可显式指定超时预算（收消息那条路要短得多，见 createAsr）；
   * 不指定时按"就绪 / 还在加载模型"自动选。
   */
  async transcribeBase64(base64, budgetMs) {
    if (!base64) return null;
    const budget = Number(budgetMs) > 0
      ? Number(budgetMs)
      : (this.ready ? this.options.timeoutMs : this.options.loadTimeoutMs);
    try {
      const res = await this.send({ b64: String(base64) }, budget);
      const text = cleanTranscript(res?.text, this.options.maxChars);
      if (!text) return null;
      return { text, durationSeconds: Number(res?.duration_seconds ?? 0) || null, device: res?.device ?? null };
    } catch (error) {
      // 超时不杀进程：模型多半还在加载，加载完下一条就能用。
      this.log(`⚠️ [asr] 转写失败（消息照旧走 [语音]）：${error?.message ?? error}`);
      return null;
    }
  }

  /** 预热：把模型加载的 2.5~3.5 秒从"第一条语音"挪到启动时。失败不影响启动。 */
  prewarm() {
    if (!this.available()) return false;
    try {
      this.ensure();
      return true;
    } catch (error) {
      this.log(`⚠️ [asr] 预热失败：${error?.message ?? error}`);
      return false;
    }
  }

  dispose() {
    this.dead = true;
    this.failAll('ASR worker 正在关闭');
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.stdin.write(`${JSON.stringify({ id: ++this.seq, shutdown: true })}\n`); } catch {}
    try { child.stdin.end(); } catch {}
    // 给 worker 一点时间自己退（它会 return 0）；到点还在就硬杀。
    // stdin 关闭本身也会让 `for line in sys.stdin` 结束，所以这里只是保险。
    setTimeout(() => { try { child.kill(); } catch {} }, 1500).unref?.();
  }
}

/**
 * 向 SnowLuma 要一段可识别的 wav（base64）。
 * 失败一律返回 null —— 调用方不需要区分"转码失败"和"没有这段语音"。
 */
export async function fetchRecordWavBase64({ httpUrl, accessToken, ref, timeoutMs = 15000, fetchImpl = fetch, log = () => {} } = {}) {
  const base = String(httpUrl || 'http://127.0.0.1:3004').replace(/\/+$/, '');
  try {
    const res = await fetchImpl(`${base}/get_record`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ file: String(ref), out_format: 'wav' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      log(`⚠️ [asr] get_record 失败：HTTP ${res.status} ${body?.wording ?? ''}`.trim());
      return null;
    }
    const b64 = body.data?.base64;
    if (!b64) {
      log('⚠️ [asr] get_record 没回 base64（这段语音可能已经过期）');
      return null;
    }
    return String(b64);
  } catch (error) {
    log(`⚠️ [asr] get_record 异常：${error?.message ?? error}`);
    return null;
  }
}

/**
 * 桥接用的外观：一个实例管一个 worker，`transcribeSegments()` 把 record 段数组
 * 变成"逐个对应的文本数组"（失败的位置是空串）。**从不抛错。**
 */
export function createAsr({ socialV2, snowluma, log = () => {}, fetchImpl = fetch } = {}) {
  const cfg = asrCfg(socialV2);
  const worker = new AsrWorker({
    workerPath: cfg.workerPath,
    pythonPath: cfg.pythonPath,
    model: cfg.model,
    language: cfg.language,
    device: cfg.device,
    modelDir: cfg.modelDir,
    timeoutMs: cfg.timeoutMs,
    loadTimeoutMs: cfg.loadTimeoutMs,
    maxChars: cfg.maxChars,
  }, log);

  async function transcribeOne(segment) {
    const info = recordRefOf(segment);
    if (!info) return '';
    const b64 = await fetchRecordWavBase64({
      httpUrl: snowluma?.httpUrl,
      accessToken: snowluma?.accessToken,
      ref: info.ref,
      timeoutMs: cfg.fetchTimeoutMs,
      fetchImpl,
      log,
    });
    if (!b64) return '';
    // 收消息这条路上的预算要短：还没就绪（模型在加载）时最多等 inlineLoadTimeoutMs，
    // 就绪后就是正常的热转写预算。超了这次放弃，下一条还能用。
    const budget = worker.ready ? cfg.timeoutMs : cfg.inlineLoadTimeoutMs;
    const res = await worker.transcribeBase64(b64, budget);
    if (!res?.text) return '';
    return formatVoiceMarker({
      text: res.text,
      durationSeconds: res.durationSeconds ?? info.duration,
      maxChars: cfg.maxChars,
    });
  }

  return {
    cfg,
    worker,
    get enabled() { return cfg.enabled; },
    /** 返回与 segments 等长的数组；转写不出来的位置是空串。 */
    async transcribeSegments(segments) {
      const list = Array.isArray(segments) ? segments : [];
      if (!cfg.enabled || list.length === 0) return list.map(() => '');
      if (!worker.available()) {
        if (!worker.warnedUnavailable) {
          worker.warnedUnavailable = true;
          log('⚠️ [asr] 转写已开启，但 worker 不可用（检查 socialV2.asr.pythonPath / workerPath）');
        }
        return list.map(() => '');
      }
      const out = [];
      for (const seg of list) {
        let text = '';
        try { text = await transcribeOne(seg); } catch (error) {
          log(`⚠️ [asr] 转写异常（消息照旧走 [语音]）：${error?.message ?? error}`);
        }
        out.push(text);
      }
      return out;
    },
    /** 预热：把模型加载提前到"没人说话"的时候，别在收消息时等。 */
    prewarm() { return cfg.enabled && cfg.prewarm ? worker.prewarm() : false; },
    dispose() { worker.dispose(); },
  };
}

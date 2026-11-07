/**
 * screen-watch.js — 「看一段时间我的屏幕」，而不是拍一张照片。
 *
 * 为什么不是简单截个屏：`qq_screenshot` 已经能截屏了（桥接 `/api/socialV2/host-screenshot`），
 * 但它给的是**一个瞬间**。真人问「我刚才在干嘛」「这个视频在讲什么」时，要的是
 * **这段时间里画面变了几次、每次都变成了什么**。一秒一张塞 30 张图既贵又重复，
 * 因为大部分帧根本没变。
 *
 * 这里的做法抄 dsh-see-now（Apache-2.0，核心模块 vendored 在 ./see-now/）：
 *   1. ffmpeg 持续抓屏 → 12fps 的 800x450 rawvideo 管道（一根管道，不切片、不 seek）；
 *   2. 每帧跟上一帧算一个 0~255 的「变了多少」，只留「整体换了画面」或「持续运动攒够了」的帧；
 *   3. 留下的帧按变化幅度决定各占多大格子，拼成一张 PNG。
 *
 * 一张 800x450 的图按 42px patch 网格计费 ≈ 233 token —— **放 4 帧还是 8 帧同价**，
 * 所以「多留几帧」在这条路上几乎不要钱，真正贵的是「多拍几次」。
 *
 * 与 `qq_screenshot` 的分工：
 *   · 想知道**此刻**屏幕长什么样、要精确坐标点东西 → `qq_screenshot`（原图、原分辨率）；
 *   · 想知道**这几秒/几十秒发生了什么** → 这里（只传变化帧、便宜、有过程）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pickScreenEngine, spawnFrames } from './see-now/capture.js';
import { createPipeline, DEFAULTS } from './see-now/pipeline.js';
import { resolveFfmpeg } from './see-now/binaries.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 四档质量：只影响抓屏分辨率，不影响帧数（帧数是画面自己决定的）。
 *
 * 尺寸抄上游 0.1.1 的 `runner.js::SIZES`（2026-11-05）。要点两条：
 *  · **宽度向下对齐到 42**（patch 格）：800 会被 pad 成 812 = 19.3 格，白付一整列；
 *    798 正好 19 列，面积只少 0.25%，每张省 11~24 token。这是零代价的降本点。
 *  · **音轨条不额外收费**：条高取"这一档画面本来就没占满的那点行余量"
 *    （450 高只占 11 行、上界 462，白空 12px），所以下面标的 token 是带条之后的实价。
 *
 * 我原来自己拍的是 640×360 / 800×450 / 1120×630 / 1440×810 —— 四个都不是 42 的倍数，
 * 每张白付一到两列的钱，而且 standard 那档在 11 行里塞 800 宽，比 798 还贵。
 */
const QUALITY = {
  low: { width: 798, height: 450 },       // 222 token/张 · 4 帧时每格 399×225
  standard: { width: 1050, height: 600 }, // 392 token/张 · 屏幕上中号字能认
  high: { width: 1260, height: 720 },     // 560 token/张 · 文件名/小字能认
  ultra: { width: 1596, height: 900 },    // 860 token/张 · 单帧时几乎等于原屏
};

/**
 * 快慢档：决定「多大的变化才算一次」。数字越大越不敏感。
 *
 * ## 2026-11-05 重写：改回上游口径，删掉我那套自己拍的数
 *
 * 0.0.7 那版只有两个判据（`cutAbs` 绝对分 + `cutSpike` 尖峰比），拿视频素材标定，
 * 搬到桌面上**一帧都留不下**：实测 11 秒抓 130 帧、`kept: 1`。我当时把门槛硬压到
 * `cutAbs: 4`、`cutSpike: 0` 硬扳过来 —— 那是**绕过缺陷**，不是修它。
 *
 * 0.1.1 上游补了三个真正的机制，我的土办法可以退休了：
 *  · **运动补偿切点**（`cutMcAbs: 60`）：整屏平移能被邻域吸收、换镜头不能 ——
 *    直接区分"运镜"和"切机位"，不靠绝对分台阶。
 *  · **弱切点**（`cutIsolatedAbs: 6`）：整屏平均分只有 7~8、但前后邻居接近 0 的
 *    "孤立的一下子"。这才是桌面上"开/关一个窗口"的真身。
 *  · **自适应兜底**（`floorGapK`）：兜底间隔 = k × 近期出帧间隔，夹在 [floorMin, floorMax]。
 *    旧版固定 `silentFloorSec`，静止画面要么不出帧、要么按死间隔出。
 *
 * 实测（同一剧本：开画图 → 关 → 开计算器 → 关，12 秒）：
 *   上游 normal → `kept=5 cuts=4`
 *   我那套 hack → `kept=5 cuts=4`
 * 结论：**上游现在自己能看见桌面变化了**，再压门槛只会让它对光标和时钟更敏感。
 * 所以数字全部回到上游，`cutSpike` 也不再归零（有 mc 覆盖就不需要靠归零绕过）。
 *
 * 各档 `pipeline` 里的键会原样覆盖 `pipeline.js::DEFAULTS` 的同名项。
 */
const PACE = {
  // 慢：只想知道"大场面变了没"，适合挂着看直播/讲座
  calm: {
    cutAbs: 20,
    maxWaitSec: 30,
    pipeline: { cutIsolatedAbs: 0, cutMcAbs: 0, floorGapK: 3, floorMin: 3, floorMax: 30 },
  },
  // 默认：滚网页/切窗口不会每一下都留帧
  normal: {
    cutAbs: 12,
    maxWaitSec: 15,
    pipeline: { floorGapK: 2, floorMin: 2, floorMax: 20 },
  },
  // 密：幻灯片、逐帧播报这种"每一刀都要"
  dense: {
    cutAbs: 7,
    maxWaitSec: 8,
    pipeline: { floorGapK: 1.2, floorMin: 2, floorMax: 20 },
  },
  // 全屏游戏/高速运动：每一帧都在动，正常门槛等于"全是切点"，积分阈值也要一起抬
  game: {
    cutAbs: 80,
    maxWaitSec: 60,
    pipeline: {
      integralSeconds: 30,
      maxFrames: 8,
      silentFloorSec: 40,
      cutSpike: 1.5,
      cutSpikeAbs: 30,
      cutIsolatedAbs: 0,
      cutJumpAbs: 0,
      cutMcAbs: 0,
      floorGapK: 2,
      floorMin: 2,
      floorMax: 20,
    },
  },
};

export const SCREEN_LIMITS = Object.freeze({
  minSeconds: 2,
  maxSeconds: 120,
  defaultSeconds: 10,
});

/**
 * 找 ffmpeg。默认走 DSH 自己那份（`~/.dsh/tools/ffmpeg/bin`），
 * 但它可能是 2018 年的老版本 —— 没有 `ddagrab`，会退回 `gdigrab`
 * （每帧先把整屏 2560x1600 BGRA 拷出来再缩，约 0.45 核）。
 * 想省 CPU 就配 `socialV2.screen.ffmpegPath` 指向一个带 ddagrab 的新版 ffmpeg。
 */
export function resolveScreenFfmpeg({ override = '' } = {}) {
  const explicit = String(override ?? '').trim();
  if (explicit) return { path: explicit, source: 'config' };
  return resolveFfmpeg();
}

/**
 * 看 N 秒屏幕，返回一张（或多张）宫格图。
 *
 * **从不抛异常** —— 调用方是 HTTP handler，抛一下就是 500 traceback，
 * 模型只会看到「请求失败」，分不清是没权限、ffmpeg 不在、还是这台机器没有桌面。
 *
 * @returns {Promise<{
 *   ok: true,
 *   sheets: Array<{ png: Buffer, at: number, from: number, to: number, frames: Array<{t:number}> }>,
 *   stats: object, engine: string, seconds: number, ffmpeg: string, ms: number
 * } | { ok: false, error: string, log?: string }>}
 */
export async function watchScreen({
  seconds = SCREEN_LIMITS.defaultSeconds,
  quality = 'standard',
  pace = 'normal',
  ffmpegPath = '',
  mouse = true,
  maxSheets = 1,
  timeoutMs = 120000,
} = {}) {
  const t0 = Date.now();
  const want = Math.min(
    SCREEN_LIMITS.maxSeconds,
    Math.max(SCREEN_LIMITS.minSeconds, Number(seconds) || SCREEN_LIMITS.defaultSeconds)
  );
  const q = QUALITY[String(quality)] ?? QUALITY.standard;
  const p = PACE[String(pace)] ?? PACE.normal;

  const bin = resolveScreenFfmpeg({ override: ffmpegPath });
  let engine;
  try {
    engine = await pickScreenEngine({ ffmpegPath: bin.path, fps: DEFAULTS.fps });
  } catch (error) {
    return { ok: false, error: `找不到能抓屏的 ffmpeg：${error?.message ?? error}` };
  }

  const pipeline = createPipeline({
    width: q.width,
    height: q.height,
    fps: DEFAULTS.fps,
    // 档位自带的那一组覆盖项（floorGapK / cutMcAbs / cutIsolatedAbs …）原样铺进去，
    // 只有 `cutAbs` 与 `maxWaitSec` 是"档位级"的，单独放。
    ...p.pipeline,
    cutAbs: p.cutAbs,
    maxWaitSec: p.maxWaitSec,
    // **队列深度 0 = 一张都不丢**：这不是常驻陪看，而是一次性问"这段时间里发生了什么"。
    // 翻车现场（2026-11-05）：9 秒里变了 7 次，queueDepth=1 只留下最后一张，
    // 覆盖 0:04.4–0:08.6 —— 前半段发生的事**直接没了**，而 `kept` 还写着 7，
    // 她读到的却是"只变了 3 次"。丢老画面是给实时循环用的取舍，一次性看片不该有。
    queueDepth: 0,
  });

  let stderrTail = '';
  let run;
  try {
    run = spawnFrames({
      source: { kind: 'screen', mouse },
      width: q.width,
      height: q.height,
      fps: DEFAULTS.fps,
      ffmpegPath: bin.path,
      engine,
      onFrame: (f) => pipeline.push({ t: f.t, buf: f.buf }),
      onStderr: (s) => { stderrTail = `${stderrTail}${s}`.slice(-2000); },
    });
  } catch (error) {
    return { ok: false, error: `起采集失败：${error?.message ?? error}`, log: stderrTail };
  }

  // 到点收手：先 stop（关 ffmpeg），再 finish（把攒着的帧判完、出最后一张）。
  const done = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { run.stop(); } catch { /* 已经没了 */ }
      resolve('timeout');
    }, Math.min(want * 1000, Math.max(3000, timeoutMs)));
    run.done.then((r) => { clearTimeout(timer); resolve(r); }).catch(() => { clearTimeout(timer); resolve('error'); });
  });

  const out = pipeline.finish();
  const ms = Date.now() - t0;

  if (!out.sheets.length) {
    return {
      ok: false,
      error: `这 ${want} 秒里没有抓到任何画面（ffmpeg ${engine} 没出帧）。`
        + '可能是：这台机器没有可交互的桌面、屏幕被锁了、或者 ffmpeg 抓不了屏。',
      log: stderrTail.slice(-400),
    };
  }

  return {
    ok: true,
    sheets: out.sheets.map((s) => ({
      png: s.png,
      at: s.at,
      from: s.from,
      to: s.to,
      w: s.w,
      h: s.h,
      frames: (s.frames ?? []).map((f) => ({ t: f.t, tier: f.tier })),
    })),
    stats: out.stats,
    engine,
    seconds: want,
    ffmpeg: bin.path,
    ms,
    done,
  };
}

/**
 * 把结果说成人话 —— 这是模型真正读到的那段文本。
 *
 * 为什么要单独一个函数：直接丢 JSON 她得自己从 stats 里推「留了几帧、覆盖多久」，
 * 而那些数是给人看的诊断信息。这里只说她需要知道的：看了多久、变了多少次、
 * 每格对应哪一秒。
 */
export function describeWatch(result) {
  if (!result?.ok) return `看屏幕失败：${result?.error ?? '未知原因'}`;
  const sheets = result.sheets ?? [];
  const sheet = sheets[0];
  const s = result.stats;
  const lines = [
    `看了一段屏幕：${result.seconds} 秒，抓了 ${s.frames} 帧，画面真正变了 ${Math.max(0, s.kept)} 次。`,
    `采集引擎 ${result.engine}，分辨率 ${sheet ? `${sheet.w ?? '?'}x${sheet.h ?? '?'}` : '?'}，` +
      `用了 ${(result.ms / 1000).toFixed(1)} 秒。`,
  ];
  // 多张图时要把"这是第二张、它覆盖的是后半段"说出来，否则模型会以为只有
  // 开头那一下有变化（实测：9 秒里变了 6 次，两张图，第一张只覆盖 0:00–0:04.7）。
  if (sheets.length > 1) lines.push(`一共 ${sheets.length} 张图，按时间先后排。`);
  sheets.forEach((sh, idx) => {
    const n = sh.frames?.length ?? 0;
    const who = sheets.length > 1 ? `第 ${idx + 1} 张：` : '图上';
    lines.push(`${who} ${n} 格，覆盖 ${fmt(sh.from)} – ${fmt(sh.to)}。`);
    if (n > 1) {
      lines.push(`格子编号按时间先后排；每格对应的时刻：${sh.frames.map((f, i) => `${i + 1}=${fmt(f.t)}`).join('，')}`);
    }
  });
  if (s.kept <= 1) {
    lines.push('⚠ 这一段时间里画面基本没动（只有一帧被留下）—— 屏幕是静态的，或者没有窗口在变化。');
  }
  // 还有帧没装下：要说出来，否则她会以为"就变了这么几次"。
  if (Number(s.overflow) > 0) {
    lines.push(`⚠ 还有 ${s.overflow} 帧因为张数上限没画进来（想看全就调大 maxSheets 或缩短秒数）。`);
  }
  return lines.join('\n');
}

const fmt = (sec) => {
  const n = Number(sec);
  if (!Number.isFinite(n)) return '?';
  const m = Math.floor(n / 60);
  const rest = (n - m * 60).toFixed(1).padStart(4, '0');
  return m > 0 ? `${m}:${rest}` : `0:${rest}`;
};

export const __paths = { HERE };

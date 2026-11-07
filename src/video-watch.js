// 视频 storyboard —— 让 QQ 里的她真的「看一眼」视频。
//
// 谁在用：`src/bridge.js` 的 `POST /api/video/watch`，由 MCP 工具
// `qq_watch_video`（`src/mcp-snowluma-safe.js`）发起。
//
// 为什么走 CLI 而不是直接引插件源码：
//   · 插件是 DSH profile 的 bundle（`~/.dsh/src/dsh-video-storyboard`），
//     它的模块图依赖 `@deepseek-ai/dsh-tools`，在桥接进程里 import 会挂；
//   · `bin/storyboard.mjs` 是官方薄壳，和 DSH 工具**同一份实现**
//     （见它头注释），所以调 CLI 等价于调工具，还免了版本耦合。
//
// 输出契约：CLI 的 stdout 前半是 `[probe] / [scan] / [plan] / [sheet]` 这些
// 人看的日志，后半才是给模型看的清单（以 `<storyboard` 开头）。这里把两段
// 切开：清单原样交给模型，日志只留最后一行进度给日志文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 清单正文的起点。CLI 与 DSH 工具共用 `formatManifest()`，所以标记稳定。 */
const MANIFEST_MARK = '<storyboard';

/**
 * 找到插件的 CLI。
 *
 * 顺序：
 *   1. `config.video.cliPath`（主人显式指定，换目录/换分支时不用改代码）
 *   2. `<DSH_HOME>/src/dsh-video-storyboard/bin/storyboard.mjs`（仓库外的稳定副本）
 *   3. `<DSH_HOME>/profiles/desktop/node_modules/dsh-video-storyboard/...`（装进 profile 的那份）
 *
 * 都找不到就返回 null —— 由调用方给出「怎么装」的提示，绝不猜。
 */
export function resolveStoryboardCli({ dshHome, override } = {}) {
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const candidates = [];
  if (override) candidates.push(String(override));
  candidates.push(path.join(home, 'src', 'dsh-video-storyboard', 'bin', 'storyboard.mjs'));
  candidates.push(path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-video-storyboard', 'bin', 'storyboard.mjs'));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* 忽略：继续找下一个 */ }
  }
  return null;
}

/** 把整段 stdout 切成 `{ log, manifest }`：`<storyboard` 之后归模型，之前归人。 */
export function splitCliOutput(stdout) {
  const text = String(stdout ?? '');
  const at = text.indexOf(MANIFEST_MARK);
  if (at < 0) return { log: text.trim(), manifest: '' };
  return { log: text.slice(0, at).trim(), manifest: text.slice(at).trim() };
}

/**
 * 跑一次 storyboard。
 *
 * 返回 `{ ok, text, imagePath, bytes, log, ms }` 或 `{ ok:false, error, log }`。
 * **不抛异常**：调用方是 HTTP handler，抛一下就是 500 + traceback，
 * 而模型那边只会看到「请求失败」，分不清是链接坏了、时长太长还是没装插件。
 */
export function runVideoStoryboard({
  cliPath,
  input,
  from,
  to,
  frames,
  strategy,
  maxSheets,
  detail = 'med',
  timeoutMs = 300000,
  nodePath = process.execPath,
  extraArgs = []
} = {}) {
  return new Promise((resolve) => {
    if (!cliPath) {
      resolve({ ok: false, error: '没找到 dsh-video-storyboard 的 CLI（bin/storyboard.mjs）' });
      return;
    }
    if (!input) {
      resolve({ ok: false, error: '没有给要看的视频（链接或本地路径）' });
      return;
    }
    let outPath = null;
    try {
      outPath = path.join(os.tmpdir(), `qq-video-${process.pid}-${Date.now().toString(36)}.png`);
    } catch (error) {
      resolve({ ok: false, error: `准备临时文件失败：${error?.message ?? error}` });
      return;
    }
    // 0.6 起 CLI 没有 `--cells`（旧写法会被当成未识别参数静默忽略，效果是"格子数还是自动挑的"），
    // 改叫 `--frames`；张数不再是输入，是排布的结果，想多要图只能靠 --strategy 或 ---max-sheets。
    const args = [cliPath, String(input), '--out', outPath, '--text', '--detail', String(detail)];
    if (Number.isFinite(Number(from)) && Number(from) > 0) args.push('--from', String(Number(from)));
    if (Number.isFinite(Number(to)) && Number(to) > 0) args.push('--to', String(Number(to)));
    const frameCap = Number(frames);
    if (Number.isFinite(frameCap) && frameCap > 0) args.push('--frames', String(Math.floor(frameCap)));
    if (strategy) args.push('--strategy', String(strategy));
    // 张数必须限死：0.6 里张数不是输入而是排布结果，auto 按时长给（240s/张），
    // 一条 10 分钟片能排 3 张、2 小时能排 37 张。我们只回一张图，多出来的会被丢掉，
    // 但 CLI 会写成 out-1.png / out-2.png…… 于是 `--out` 那个路径根本不存在
    // → 2026-11-02 实测报过「宫格图没生成：ENOENT …qq-video-….png」。
    // 所以这里默认 --max-sheets 1：宁可每格小一点，也要保证一张图能整条讲完。
    const sheetCap = Number(maxSheets);
    args.push('--max-sheets', String(Number.isFinite(sheetCap) && sheetCap > 0 ? Math.floor(sheetCap) : 1));
    for (const a of extraArgs) args.push(String(a));

    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { if (outPath && fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* 临时文件删不掉不影响结果 */ }
      resolve(value);
    };
    try {
      child = spawn(nodePath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      });
    } catch (error) {
      finish({ ok: false, error: `启动 CLI 失败：${error?.message ?? error}` });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退了 */ }
      const { log } = splitCliOutput(stdout);
      finish({
        ok: false,
        error: `超过 ${Math.round(timeoutMs / 1000)} 秒还没看完（视频太长？可以用 from/to 只看一段）`,
        log
      });
    }, timeoutMs);

    child.stdout?.on('data', (b) => { stdout += String(b); });
    child.stderr?.on('data', (b) => { stderr += String(b); });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, error: `CLI 起不来：${error?.message ?? error}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const { log, manifest } = splitCliOutput(stdout);
      const tailLog = `${log}\n${String(stderr).trim()}`.trim();
      if (code !== 0) {
        finish({ ok: false, error: `CLI 退出码 ${code}：${lastLines(tailLog, 3) || '没有输出'}`, log: tailLog });
        return;
      }
      if (!manifest) {
        finish({ ok: false, error: 'CLI 跑完了但没吐出清单', log: tailLog });
        return;
      }
      let bytes = 0;
      try {
        const stat = fs.statSync(outPath);
        bytes = stat.size;
      } catch (error) {
        finish({ ok: false, error: `宫格图没生成：${error?.message ?? error}`, log: tailLog });
        return;
      }
      // 先把文件读进内存，再让 finish() 删临时文件 —— 顺序反了就读到空文件。
      let buffer;
      try {
        buffer = fs.readFileSync(outPath);
      } catch (error) {
        finish({ ok: false, error: `读宫格图失败：${error?.message ?? error}`, log: tailLog });
        return;
      }
      settled = true;
      try { fs.unlinkSync(outPath); } catch { /* 同上 */ }
      resolve({ ok: true, manifest, log: tailLog, buffer, bytes, ms: Date.now() - started });
    });
  });
}

function lastLines(text, n) {
  const lines = String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.slice(-n).join(' | ');
}

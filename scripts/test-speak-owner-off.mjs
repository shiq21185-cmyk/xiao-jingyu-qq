// 「语音是主人自己关的」不能被当成出错 —— 2026-10-23 真实踩坑。
//
// 现场：主人早在设置里关掉了 socialV2.tools.speak，但预设第 17 条写着
// 「默认开口说，语音发不出去才打字」，她于是每轮都先调 qq_say，
// 而 /api/socialV2/speak-or-text 在更前面就 `disabledByOwner(..., 403)` 早退，
// 她拿到 isError 就当成「语音坏了」反复重试（3 天里 qq_say 29 次调用、11 次失败）。
//
// 正确语义：关掉的是**这个渠道**，不是让她别说话。应该安静地改发文字、照常成功，
// 并在返回里说清「这是主人自己关的，不是故障」。
//
// 这组测试钉住四件事：
//   ① 端点不再因为 speak 关着就 403
//   ② speakOrTextV2 里有「speak 关 → fallbackText + mode:text」的分支
//   ③ MCP 工具描述里讲了这件事（否则她只看到 mode=text 会继续试）
//   ④ 预设第 17 条讲了这件事，并且标题不再是「常驻语音」那种绝对说法
//
// 跑：node scripts/test-speak-owner-off.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
const MCP = fs.readFileSync(path.join(ROOT, 'src/mcp-snowluma-safe.js'), 'utf8');
const PRESET = fs.readFileSync(path.join(ROOT, 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf(`async function ${name}(`) >= 0
    ? src.indexOf(`async function ${name}(`)
    : src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `bridge.js 里找不到 ${name}()`);
  const lineStart = src.lastIndexOf('\n', start) + 1;
  const indent = src.slice(lineStart, start);
  const re = new RegExp(`\\r?\\n${indent}\\}\\r?\\n`, 'g');
  re.lastIndex = start;
  const hit = re.exec(src);
  assert.ok(hit, `${name}() 找不到同缩进的结尾`);
  return src.slice(start, hit.index + hit[0].indexOf('}') + 1);
}

test('speak-or-text 端点不再因为 speak 关着就 403', () => {
  const at = SRC.indexOf("url.pathname === '/api/socialV2/speak-or-text'");
  assert.ok(at > 0, '找不到 speak-or-text 端点');
  // 取这个端点之后到下一个路由之前的一段
  const seg = SRC.slice(at, at + 1400);
  assert.doesNotMatch(
    seg,
    /disabledByOwner\(\s*'qq_say'\s*,\s*'speak'/,
    '端点里不能再有 disabledByOwner(\'qq_say\', \'speak\') 的早退 —— 那会让她把设置当故障'
  );
});

test('speakOrTextV2 里 speak 关掉时走文字、并说明是主人关的', () => {
  const fn = extractFn(SRC, 'speakOrTextV2');
  assert.match(fn, /if \(!v2ToolEnabled\('speak'\)\)/, '取 shuo「speak 关着」的分支');
  assert.match(fn, /await fallbackText\(\);/, '关着时必须真的把文字发出去');
  assert.match(fn, /mode: 'text'/, '返回 mode 要是 text');
  assert.match(fn, /主人自己关掉的/, 'detail 要说清是主人自己关的，不是故障');
  // 顺序：必须在语音合成之前就分流，否则会白合成一遍
  const branch = fn.indexOf("if (!v2ToolEnabled('speak'))");
  const speak = fn.indexOf('speakForV2');
  assert.ok(branch > 0 && speak > branch, 'speak 开关的判断要在 speakForV2 之前');
});

test('MCP 的 qq_say 描述里讲清「语音被关掉不是故障」', () => {
  assert.match(MCP, /【语音被主人关掉的时候】/, '工具描述要单独讲这一段');
  assert.match(MCP, /不是故障、不是坏了/, '要明说不是故障');
  assert.match(MCP, /之后直接打文字就行/, '要给下一步怎么办');
});

test('预设第 17 条：有语音就用语音，但被关掉时安静退回文字', () => {
  assert.match(PRESET, /【说话方式：有语音就用语音】/, '标题不该再是「常驻语音」那种绝对说法');
  assert.match(PRESET, /语音可能是主人自己关掉的/, '要提前告诉她这件事会发生');
  assert.match(PRESET, /不是故障、不是坏了、不用重试、不用换工具、也不用报给主人/, '要把「别当故障」说全');
  assert.match(PRESET, /这一轮之后\*\*直接用 qq_send_message 打字\*\*/, '要给出后续做法，别每轮白绕一次');
});

test('预设里不再声称「他发文字你都回语音」是无条件的', () => {
  // 旧文案把语音写成绝对默认，与实际配置冲突；新文案保留「默认」，但紧跟关掉时的处置。
  assert.doesNotMatch(PRESET, /\*\*默认开口说，语音发不出去才打字\*\*。\r?\n\s+· 日常回话用 \*\*qq_say\*\*（不是 qq_send_message）：它先把你说的话合成成语音条，实在发不出去时\*\*桥接会自动改发同一段文字\*\*，所以对方一定会收到，你不必自己兜底。\r?\n\s+· 他发文字、他发语音、群里跟你说话 —— 你都回语音。/,
    '不能退回到「无条件都回语音」的旧说法');
});

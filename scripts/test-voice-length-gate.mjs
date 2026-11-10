// 语音条长度闸门 —— 2026-11-10 主人要求。
//
// 现场：预设第 16 条原来写「他发文字、他发语音，你都回语音，这是默认，不需要理由，
// 也不用每次先问自己'这算不算值得用语音'」，她执行得很彻底 ——
// 11-09 起语音占比从 6~13% 涨到 80%/100%，文字完全消失。而她的句子中位数才 24 字，
// 为了 24 个字，对方每次都要点开听 5~10 秒的语音条。
//
// 改法两层：① 提示词翻成「默认打字、语音留给有温度的时刻」；
//          ② 桥接加一道**长度闸门**：超过 maxTextChars 的 qq_say 直接改发文字。
//
// 这一层是硬的 —— 提示词她可能不听话，闸门她绕不过去。
// 这组测试钉住四件事：
//   ① voiceCfg() 读得到 maxTextChars（默认 80，0 = 不限）
//   ② speakOrTextV2 里有长度判定，且走 fallbackText + mode:text（安静降级，不报错）
//   ③ voiceOnly 显式要求的绕过闸门（否则「我就是要发语音」会导致那句直接失败）
//   ④ 控制台保存白名单里有 maxTextChars（否则界面改了存不下来）
//
// 跑：node scripts/test-voice-length-gate.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');

function extractFn(src, name) {
  const idxAsync = src.indexOf(`async function ${name}(`);
  const idxSync = src.indexOf(`function ${name}(`);
  const start = idxAsync >= 0 ? idxAsync : idxSync;
  assert.ok(start >= 0, `bridge.js 里找不到 ${name}()`);
  const lineStart = src.lastIndexOf('\n', start) + 1;
  const indent = src.slice(lineStart, start);
  const re = new RegExp(`\\r?\\n${indent}\\}\\r?\\n`, 'g');
  re.lastIndex = start;
  const hit = re.exec(src);
  assert.ok(hit, `${name}() 找不到同缩进的结尾`);
  return src.slice(start, hit.index + hit[0].indexOf('}') + 1);
}

const voiceCfgSrc = extractFn(SRC, 'voiceCfg');
const speakOrTextSrc = extractFn(SRC, 'speakOrTextV2');

test('voiceCfg 读得到 maxTextChars，默认 80', () => {
  assert.match(voiceCfgSrc, /maxTextChars/, 'voiceCfg() 里没有 maxTextChars');
  // 默认值必须在：Number(v.maxTextChars) >= 0 ? ... : 80
  assert.match(
    voiceCfgSrc,
    /maxTextChars:\s*Number\(v\.maxTextChars\)\s*>=\s*0\s*\?\s*Number\(v\.maxTextChars\)\s*:\s*80/,
    'maxTextChars 的默认值不是 80（或写法变了）'
  );
});

test('语音配置默认块里也有 maxTextChars: 80', () => {
  // 默认块：cfg.socialV2.voice = { ... maxTextChars: 80, ...(cfg.socialV2?.voice ?? {}) }
  assert.match(
    SRC,
    /cfg\.socialV2\.voice\s*=\s*\{[\s\S]{0,1200}?maxTextChars:\s*80/,
    'cfg.socialV2.voice 的默认块里没有 maxTextChars: 80'
  );
});

test('speakOrTextV2 有长度闸门，且是安静降级不是报错', () => {
  assert.match(speakOrTextSrc, /maxTextChars|maxChars/, 'speakOrTextV2 里没有长度判定');
  assert.match(speakOrTextSrc, /spoken\.length\s*>\s*maxChars/, '没有 spoken.length > maxChars 的判定');

  // 闸门那一支必须走 fallbackText 并返回 mode:'text'
  const gateAt = speakOrTextSrc.indexOf('spoken.length > maxChars');
  assert.ok(gateAt > 0, '找不到闸门');
  const after = speakOrTextSrc.slice(gateAt, gateAt + 600);
  assert.match(after, /fallbackText\(\)/, '闸门没有调用 fallbackText()');
  assert.match(after, /mode:\s*'text'/, "闸门没有返回 mode: 'text'");
  assert.doesNotMatch(after, /throw new Error/, '闸门不该抛错（她会当成语音坏了）');
});

test('闸门排在 vc.enabled 判定之前（关了语音就不必再判长度）', () => {
  // 先判 speak 开关 → 再判长度 → 再进 vc.enabled
  const lenAt = speakOrTextSrc.indexOf('spoken.length > maxChars');
  const enabledAt = speakOrTextSrc.indexOf('if (vc.enabled)');
  assert.ok(lenAt > 0 && enabledAt > 0, '找不到锚点');
  assert.ok(lenAt < enabledAt, '长度闸门必须在 vc.enabled 之前（先便宜后昂贵）');
});

test('voiceOnly 显式要求绕过长度闸门', () => {
  assert.match(
    speakOrTextSrc,
    /if\s*\(\s*opts\.voiceOnly\s*!==\s*true\s*\)/,
    '长度闸门没有排除 voiceOnly —— 显式要求只发语音的会被误降级'
  );
});

test('控制台保存白名单里有 maxTextChars', () => {
  assert.match(
    SRC,
    /\['maxSeconds',\s*'maxBytes',\s*'maxPerMinute',\s*'maxPerHour',\s*'maxTextChars'\]/,
    '保存归一化的数字字段名单里没有 maxTextChars —— 界面改了存不下来'
  );
});

test('提示词说了「默认打字」，且不再有「你都回语音」', () => {
  const presets = [
    'dsh/agent-presets/qq-chat-v2/agent.cordis.yml',
    'dsh/agent-presets/qq-owner-dsh/agent.cordis.yml',
    'plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml'
  ];
  for (const rel of presets) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(text, /默认打字/, `${rel}: 没有「默认打字」`);
    assert.doesNotMatch(
      text,
      /他都回语音|你都回语音/,
      `${rel}: 还留着「你都回语音」这种绝对说法`
    );
    assert.match(text, /80 字/, `${rel}: 没提 80 字上限`);
  }
});

test('qq_say 工具描述也翻成默认打字', () => {
  const mcp = fs.readFileSync(path.join(ROOT, 'src/mcp-snowluma-safe.js'), 'utf8');
  // ⚠️ 文件里有个 ALWAYS_REGISTER 名单也含 'qq_say'，必须锚到 server.tool( 那个定义
  const at = mcp.indexOf("server.tool(\n    'qq_say'");
  assert.ok(at > 0, '找不到 qq_say 的 server.tool 定义');
  const desc = mcp.slice(at, at + 2200);
  assert.match(desc, /留给特定时刻|默认通道/, 'qq_say 描述没改成「语音不是默认通道」');
  assert.match(desc, /80 字/, 'qq_say 描述没提 80 字上限');
  assert.doesNotMatch(desc, /默认说话方式：先把话\*\*念出来\*\*/, 'qq_say 描述还留着旧的「默认念出来」');
});

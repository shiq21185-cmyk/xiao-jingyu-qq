// 表情包 CDN 兜底的回归（2026-10-21，来源：上游 r4「表情包/动图链路」）。
//
// ── 修的是什么 ────────────────────────────────────────────────────────────
// `fetchFaceMedia` 原来只看 `face.url`：网关不返回 url 时直接退化成一行纯文本
// `[表情#123]` —— 她永远看不见那张图。
// 而市场表情（从表情商店下载的）往往**不在网关缓存里**（`get_image` 返回
// `image not found in cache`）且**没有 url**，所以这类表情对她等于不存在。
//
// 但 QQ 表情包的 CDN 地址可以只靠 emoji_id 推出来：
//   https://gxh.vip.qq.com/club/item/parcel/item/<id 前两位>/<id>/raw300.gif
//
// ── 这个文件钉住什么 ──────────────────────────────────────────────────────
//   ① 地址拼法正确（前两位 + 完整 id + raw300.gif）
//   ② **只接受纯十六进制 id** —— 这是防 SSRF/开放重定向的关键，必须死守
//   ③ 文件名里嵌的 32 位 hex 能被抠出来
//   ④ 候选地址按「网关给的 url 优先、CDN 兜底」排序，且去重
//   ⑤ 单个候选失败不致命（继续试下一个）
//
// 跑：node scripts/test-sticker-cdn.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

// 从源码里抽出两个函数来单测。
// ⚠️ emojiCdnCandidates 现在会读 cfg.socialV2.sticker.cdnFallback（可开关），
//    所以 eval 时必须注入一个 cfg 桩 —— 否则 ReferenceError。
function loadHelpers(config = {}) {
  // ⚠️ 抽取范围必须从 emojiCdnFallbackEnabled **之前**开始 ——
  //    emojiCdnCandidates 依赖它，漏掉就会 ReferenceError。
  const start = SRC.indexOf('function emojiCdnFallbackEnabled');
  const end = SRC.indexOf('async function fetchFaceMedia');
  assert.ok(start > 0 && end > start, '找不到 emojiCdnFallbackEnabled / emojiCdnCandidates / emojiIdFromFileName');
  const block = SRC.slice(start, end);
  const fn = new Function('cfg', `${block}; return { emojiCdnCandidates, emojiIdFromFileName };`);
  return fn({ socialV2: { sticker: config } });
}
const { emojiCdnCandidates, emojiIdFromFileName } = loadHelpers();

const HEX32 = 'dd6eb37089eb01c4a68cc52fb4999e21';

test('地址拼法：前两位 / 完整 id / raw300.gif', () => {
  const out = emojiCdnCandidates(HEX32);
  assert.equal(out.length, 1);
  assert.equal(out[0], `https://gxh.vip.qq.com/club/item/parcel/item/${HEX32.slice(0, 2)}/${HEX32}/raw300.gif`);
  assert.match(out[0], /^https:\/\/gxh\.vip\.qq\.com\//, '必须是 https 的 gxh 域名');
  assert.ok(out[0].includes('/parcel/item/dd/'), '前两位必须用在路径里');
});

test('只接受纯十六进制 —— 这是防 SSRF/开放重定向的关键', () => {
  const bad = [
    '',
    '   ',
    'abc',                                   // 太短
    'zz' + HEX32.slice(2),                   // 非 hex 字符
    '../../etc/passwd',                      // 路径穿越
    'http://evil.com/x',                      // 整条 URL
    HEX32 + '/../x',                         // 带路径
    HEX32 + '?a=1',                          // 带 query
    'a'.repeat(15),                          // 15 位（下限外）
    'a'.repeat(65),                          // 65 位（上限外）
  ];
  for (const b of bad) {
    assert.deepEqual(emojiCdnCandidates(b), [], `绝不能把 ${JSON.stringify(b)} 拼进 URL`);
  }
});

test('合法长度边界：16 位与 64 位都接受，大小写都行', () => {
  assert.equal(emojiCdnCandidates('a'.repeat(16)).length, 1);
  assert.equal(emojiCdnCandidates('a'.repeat(64)).length, 1);
  const upper = emojiCdnCandidates(HEX32.toUpperCase())[0];
  assert.ok(upper.includes(HEX32.toUpperCase()), '大写 hex 要原样保留（CDN 大小写不敏感，但别篡改）');
});

test('从文件名里抠 emoji_id（实测形态 f9-<32位hex>.gif）', () => {
  assert.equal(emojiIdFromFileName(`f9-${HEX32}.gif`), HEX32);
  assert.equal(emojiIdFromFileName(`${HEX32}.gif`), HEX32);
  assert.equal(emojiIdFromFileName(`x-${HEX32}.PNG`), HEX32, '扩展名大小写都要认');
  assert.equal(emojiIdFromFileName(`${HEX32}.webp`), HEX32);
  assert.equal(emojiIdFromFileName('f9-nothex.gif'), '');
  assert.equal(emojiIdFromFileName(''), '');
  assert.equal(emojiIdFromFileName(null), '');
  assert.equal(emojiIdFromFileName(`${HEX32}.mp4`), '', '非图片扩展名不认');
});

test('候选顺序：网关 url 优先，CDN 在后', () => {
  // 找 fetchFaceMedia 里构造 candidates 的那段
  const start = SRC.indexOf('async function fetchFaceMedia');
  const body = SRC.slice(start, start + 1400);
  const iUrl = body.indexOf('if (face.url) candidates.push');
  const iCdn = body.indexOf('for (const u of emojiCdnCandidates(emojiId))');
  assert.ok(iUrl > 0, '必须先收网关给的 url');
  assert.ok(iCdn > 0, '必须再收 CDN 兜底');
  assert.ok(iUrl < iCdn, '网关 url 要排在 CDN 前面（可信度更高）');
  assert.match(body, /if \(!candidates\.includes\(u\)\)/, '候选要去重');
});

test('单个候选失败要继续试下一个（不能一失败就放弃）', () => {
  const start = SRC.indexOf('async function fetchFaceMedia');
  const body = SRC.slice(start, start + 2600);
  assert.match(body, /for \(const candidate of candidates\)/, '要遍历所有候选');
  // try 里失败后必须是 continue / 接着下一轮，而不是直接 return 纯文本
  const loop = body.slice(body.indexOf('for (const candidate of candidates)'));
  assert.match(loop.slice(0, 900), /catch \(error\)/, '每个候选单独 try');
  assert.match(loop.slice(0, 1200), /单个候选失败不致命/, '注释要说明为什么继续');
});

test('网关连 face 实体都拿不到时，仍试一次 CDN 兜底', () => {
  const start = SRC.indexOf('async function fetchFaceMedia');
  const body = SRC.slice(start, start + 3400);
  assert.match(body, /const fallbackId = emojiIdFromFileName\(media\.file/, '要有「从 media.file 抠 id」的最后兜底');
});

test('下载仍然走 safeFetchBuffer（带 SSRF 防护与上限）', () => {
  const start = SRC.indexOf('async function fetchFaceMedia');
  const body = SRC.slice(start, start + 3400);
  const calls = body.match(/safeFetchBuffer\(/g) || [];
  assert.ok(calls.length >= 2, '每个抓取点都必须走 safeFetchBuffer，不能裸 fetch');
  assert.doesNotMatch(body, /await fetch\(/, '不能出现裸 fetch —— 那会绕过 DNS 校验');
});

// ── 可开关（2026-10-21 加进控制台）────────────────────────────────────────
test('cdnFallback: false 时完全不产生候选地址', () => {
  const off = loadHelpers({ cdnFallback: false });
  assert.deepEqual(off.emojiCdnCandidates(HEX32), [], '关掉之后不该再推 CDN 地址');
  // 但文件名解析仍然可用（它只是字符串处理，不发起请求）
  assert.equal(off.emojiIdFromFileName(`f9-${HEX32}.gif`), HEX32);
});

test('默认（没配）时是开的 —— 不能因为漏配就静默失效', () => {
  assert.equal(loadHelpers({}).emojiCdnCandidates(HEX32).length, 1, '没配 cdnFallback 应当按「开」处理');
  assert.equal(loadHelpers({ cdnFallback: true }).emojiCdnCandidates(HEX32).length, 1);
  // 只有显式 false 才关
  assert.equal(loadHelpers({ cdnFallback: false }).emojiCdnCandidates(HEX32).length, 0);
});

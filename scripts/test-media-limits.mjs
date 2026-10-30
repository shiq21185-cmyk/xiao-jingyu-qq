// 媒体上限可配置的回归（2026-10-21，来源：上游 r4 对照）。
//
// ── 为什么改这个 ──────────────────────────────────────────────────────────
// 原来 `MAX_MEDIA_BYTES = 4 * 1024 * 1024` 是**硬编码**的。手机直出的原图经常 5~10 MB，
// 于是群里明明发了图，桥接一律判「图片总大小超限，已跳过」—— 她那边就是「看不见图」。
// 上游把默认抬到 8 MB，并做成 `socialV2.media` 可配。
//
// ── 这个文件钉住什么（每一条都对应一个具体的失败形态）─────────────────────
//   ① 默认值真的是 8MB / 64MP / 5 张（不是文档写了、代码没改）
//   ② 配了就能生效（三个上限各自独立）
//   ③ **硬天花板**：配置写 `maxBytes: 1e12` 也只给 32MB
//      —— 放宽上限不是拆掉防护，一句配置不能绕过整层
//   ④ 怪值（0 / 负数 / NaN / 字符串）一律退回默认，绝不变成「无上限」
//   ⑤ 控制台的配置白名单里有 `media`
//      —— 不加就会被 `merged[sub] = current[sub] ?? {}` 冲成 null，里面的设置静默失效
//
// 跑：node scripts/test-media-limits.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

// 把 mediaLimit + 默认值/天花板抽出来单测：它们都是纯算术，不需要起桥接。
// 用正则把三个常量块截出来再 eval，比 import 整个 bridge.js（需要 DSH）现实得多。
function loadMediaLimit() {
  const start = SRC.indexOf('const MEDIA_LIMIT_DEFAULTS');
  const end = SRC.indexOf('// 保留常量名以兼容既有调用点');
  assert.ok(start > 0 && end > start, '找不到 MEDIA_LIMIT_DEFAULTS / CEILINGS 定义');
  const block = SRC.slice(start, end);
  // mediaLimit 引用了 cfg，这里换成可注入的桩
  const fn = new Function('cfg', `
    ${block}
    return mediaLimit;
  `);
  return (limits) => fn({ socialV2: { media: limits } });
}

const mediaLimit = loadMediaLimit();

console.log('— 1. 默认值 —');
test('不配 → 8MB / 6400 万像素 / 5 张', () => {
  assert.equal(mediaLimit(undefined)('maxBytes'), 8 * 1024 * 1024, '默认字节上限应为 8MB（手机原图常超 4MB）');
  assert.equal(mediaLimit(undefined)('maxPixels'), 64_000_000);
  assert.equal(mediaLimit(undefined)('maxCount'), 5);
});

test('空对象 / 缺字段 → 各自回默认', () => {
  assert.equal(mediaLimit({})('maxBytes'), 8 * 1024 * 1024);
  assert.equal(mediaLimit({ maxCount: 3 })('maxBytes'), 8 * 1024 * 1024, '只配了张数，字节上限仍回默认');
  assert.equal(mediaLimit({ maxCount: 3 })('maxCount'), 3, '配了的那个要生效');
});

console.log('— 2. 配了要生效 —');
test('三个上限各自独立生效', () => {
  const f = mediaLimit({ maxBytes: 16 * 1024 * 1024, maxPixels: 100_000_000, maxCount: 10 });
  assert.equal(f('maxBytes'), 16 * 1024 * 1024);
  assert.equal(f('maxPixels'), 100_000_000);
  assert.equal(f('maxCount'), 10);
});

test('调小也要生效（不是只允许调大）', () => {
  assert.equal(mediaLimit({ maxBytes: 1024 * 1024 })('maxBytes'), 1024 * 1024);
});

console.log('— 3. 硬天花板：放宽不等于拆防护 —');
test('maxBytes 写 1e12 → 钳到 32MB', () => {
  assert.equal(mediaLimit({ maxBytes: 1e12 })('maxBytes'), 32 * 1024 * 1024, '一句配置不能绕过整层防护');
});

test('maxPixels 写 1e12 → 钳到 2.56 亿', () => {
  assert.equal(mediaLimit({ maxPixels: 1e12 })('maxPixels'), 256_000_000);
});

test('maxCount 写 9999 → 钳到 20', () => {
  assert.equal(mediaLimit({ maxCount: 9999 })('maxCount'), 20);
});

console.log('— 4. 怪值不许变成「无上限」 —');
test('0 / 负数 / NaN / 字符串 / null 一律回默认', () => {
  for (const bad of [0, -1, NaN, '8MB', null, undefined, {}, []]) {
    const got = mediaLimit({ maxBytes: bad })('maxBytes');
    assert.equal(got, 8 * 1024 * 1024, `maxBytes=${String(bad)} 时应当回默认，实际 ${got}`);
  }
});

test('小数会被向下取整（不产生半个字节的阈值）', () => {
  assert.equal(mediaLimit({ maxBytes: 1024.9 })('maxBytes'), 1024);
});

console.log('— 5. 结构约束 —');
test('三个上限都改成调用（不是裸常量），否则改了配置不生效', () => {
  for (const name of ['MAX_MEDIA_BYTES', 'MAX_MEDIA_PIXELS', 'MAX_MEDIA_COUNT']) {
    const bare = new RegExp(`(?<!\\()\\b${name}\\b(?!\\s*\\()`, 'g');
    // 允许出现在定义与注释里；不允许出现在实际判断中（那说明还有地方读的是旧常量）
    const uses = (SRC.match(bare) || []).filter((m) => m);
    assert.ok(uses.length <= 3, `${name} 仍有 ${uses.length} 处疑似裸用（改配置不会生效）`);
    assert.match(SRC, new RegExp(`const ${name} = \\(\\) => mediaLimit\\('`), `${name} 必须是 getter`);
  }
});

test('控制台的配置白名单里有 media（否则保存一次就冲成 null）', () => {
  const m = SRC.match(/for \(const sub of \[([^\]]+)\]\)/);
  assert.ok(m, '找不到配置子对象白名单');
  assert.match(m[1], /'media'/, "白名单必须含 'media'，否则控制台保存会把它覆盖成 null");
});

test('所有 safeFetchBuffer 调用都必须显式传上限（否则用 4MB 兜底，绕开配置）', () => {
  const sf = fs.readFileSync(path.join(ROOT, 'src', 'safe-fetch.js'), 'utf8');
  assert.match(sf, /export async function safeFetchBuffer\(urlString, maxBytes = /, 'safeFetchBuffer 应有兜底默认参数');
  // safeFetchBuffer 的兜底是 4MB，为的是给「不知道上下文」的调用方一个安全默认。
  // 但桥接内部的每一处都知道上下文，必须显式传 MAX_MEDIA_BYTES()，否则
  // socialV2.media.maxBytes 对那一处**完全不生效** —— 改了配置还以为生效了。
  //
  // ⚠️ 别用 `/safeFetchBuffer\([^)]*\)/` 抓调用：参数里有 `String(obj.url)` 这种嵌套括号，
  //    正则会停在第一个 `)`，把「传了上限」误判成「没传」（第一版就这么翻车过）。
  //    按**行**检查更可靠：调用写在一行里，且同一行必须出现 MAX_MEDIA_BYTES()。
  const callLines = (SRC.match(/.*safeFetchBuffer\(.*/g) || []).filter((l) => !/^\s*\/\//.test(l.trim()));
  assert.ok(callLines.length >= 4, `期望至少 4 处调用，实际 ${callLines.length}`);
  const noArg = callLines.filter((l) => !/MAX_MEDIA_BYTES\(\)/.test(l));
  assert.equal(noArg.length, 0, `这些调用没传上限，会走 4MB 兜底：${noArg.map((l) => l.trim()).join(' | ')}`);
});

test('配置示例里公开了这三个字段', () => {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  const media = example.socialV2?.media;
  assert.ok(media, 'config.example.json 应有 socialV2.media');
  assert.equal(media.maxBytes, 8 * 1024 * 1024, '示例里的默认值要和代码一致');
  assert.equal(media.maxPixels, 64_000_000);
  assert.equal(media.maxCount, 5);
});

// ── 控制台接入（2026-10-21 主人要求「这个可配置做到我的控制台里面」）─────────
const CONSOLE_DIR = path.join(ROOT, 'tools', 'extra-console');
const SERVER = fs.readFileSync(path.join(CONSOLE_DIR, 'server.mjs'), 'utf8');
const PAGE = fs.readFileSync(path.join(CONSOLE_DIR, 'index.html'), 'utf8');

test('控制台有独立一页「媒体上限」，导航/页面/按钮齐全', () => {
  assert.match(PAGE, /data-nav="media"/, '侧边栏要有 media 按钮');
  assert.match(PAGE, /data-page="media"/, '要有对应的页面卡片');
  assert.match(PAGE, /id="saveMedia"/, '要有保存按钮');
  assert.match(PAGE, /id="mediaReset"/, '要有恢复默认按钮');
  for (const id of ['mediaMaxBytesMB', 'mediaMaxPixelsMP', 'mediaMaxCount']) {
    assert.match(PAGE, new RegExp(`id="${id}"`), `缺输入框 ${id}`);
  }
});

test('页面标题是页面卡片的直属 h2（breadcrumb 靠 :scope > h2 取）', () => {
  const start = PAGE.indexOf('data-page="media"');
  const chunk = PAGE.slice(start, start + 500);
  assert.match(chunk, /<h2>/, '媒体页要有自己的 h2，否则面包屑显示成 data-page 名');
});

test('服务端有 POST /api/media，并按同一套天花板拒绝', () => {
  assert.match(SERVER, /url\.pathname === '\/api\/media'/, '要有 /api/media 路由');
  // 天花板必须与 bridge.js 的 MEDIA_LIMIT_CEILINGS 一致
  assert.match(SERVER, /maxBytes: 32 \* 1024 \* 1024/, '服务端天花板 32MB 要和 bridge 一致');
  assert.match(SERVER, /maxPixels: 256_000_000/, '像素天花板要和 bridge 一致');
  assert.match(SERVER, /maxCount: 20/, '张数天花板要和 bridge 一致');
});

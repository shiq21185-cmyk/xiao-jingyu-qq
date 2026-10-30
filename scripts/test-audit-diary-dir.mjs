// 日记目录可配置（config.json → socialV2.diary.dir）的回归。
//
// 为什么要这条：日记本来是写死在 src/bridge.js 里的 `path.join(ROOT, 'data', '日记')`，
// 而主人想直接打开看（m06124：「日记专门放一个地方吧，方便我去找，最好在 qqbot 里面」），
// 于是改成可配置。这个开关有两个容易写错的地方，正好一人一条：
//   ① 相对路径必须按**仓库根（ROOT）**解析，不能按 process.cwd()（桥接从哪启动都有可能）；
//   ② 没配 / 空串时必须回到原来的默认目录 —— 老的日记不能因为这次改动就"消失"。
// 同时钉住：config 里塞了怪值也不能抛。
//
// 注意 ROOT 在 harness 里是**临时目录**（它把 src/bridge.js 拷过去、并把 import.meta.url
// 一起改写了），所以期望值用 h.temp 拼，而不是 D:\qq-bridge —— 这本身就是"相对路径按
// ROOT 解析"最好的证明：换一个 ROOT，结果就跟着换。
import assert from 'node:assert/strict';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
let passes = 0;

async function test(name, config, run) {
  const h = await bridgeHarness({ config });
  h.setMode('reserved2');
  try {
    run(h);
    passes++;
    console.log('PASS', name);
  } catch (error) {
    failures++;
    console.error('FAIL', name, '→', error.message);
  } finally {
    await h.close();
  }
}

const defaultDir = (h) => path.join(h.temp, 'data', '日记');

console.log('— 1. 默认值（老行为不变）—');
await test('没配 dir → 回到仓库内的 data/日记', {}, (h) => {
  assert.equal(h.getDiaryDir(), defaultDir(h));
});

await test('dir 是空串 → 也算没配，回默认', { socialV2: { diary: { dir: '' } } }, (h) => {
  assert.equal(h.getDiaryDir(), defaultDir(h));
});

await test('diary 整块缺失 → 默认', { socialV2: { enabled: true } }, (h) => {
  assert.equal(h.getDiaryDir(), defaultDir(h));
});

console.log('— 2. 相对路径按 ROOT 解析，不是 cwd —');
await test('my-diary → <ROOT>/my-diary', { socialV2: { diary: { dir: 'my-diary' } } }, (h) => {
  assert.equal(h.getDiaryDir(), path.join(h.temp, 'my-diary'));
});

await test('data/本子 → <ROOT>/data/本子（允许再分层）', { socialV2: { diary: { dir: 'data/本子' } } }, (h) => {
  assert.equal(h.getDiaryDir(), path.join(h.temp, 'data', '本子'));
});

await test('正斜杠与反斜杠都收', { socialV2: { diary: { dir: 'a\\b' } } }, (h) => {
  assert.equal(h.getDiaryDir(), path.join(h.temp, 'a', 'b'));
});

console.log('— 3. 绝对路径原样用 —');
{
  const target = path.join(path.parse(process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp').root, 'qq-diary-abs', '日记');
  await test(`绝对路径不被拼到 ROOT 后面（${target}）`, { socialV2: { diary: { dir: target } } }, (h) => {
    assert.equal(h.getDiaryDir(), path.normalize(target));
  });
}

console.log('— 4. 怪值不许抛 —');
await test('dir 是数字 → 当字符串处理，不抛，仍是 ROOT 下的绝对路径', { socialV2: { diary: { dir: 12345 } } }, (h) => {
  const got = h.getDiaryDir();
  assert.equal(typeof got, 'string');
  assert.ok(path.isAbsolute(got));
  assert.ok(got.startsWith(h.temp), got);
});

console.log('— 5. 纯函数可直接调（不依赖 main() 跑过）—');
await test('resolveDiaryDir 的几种输入', { socialV2: { diary: { dir: 'ignored-by-this-case' } } }, (h) => {
  assert.equal(h.resolveDiaryDir({}), defaultDir(h));
  assert.equal(h.resolveDiaryDir(null), defaultDir(h));
  assert.equal(h.resolveDiaryDir({ socialV2: { diary: { dir: 'x' } } }), path.join(h.temp, 'x'));
  // harness 的 config 里配的那个值确实生效了（说明 main() 那条路真的调过它）
  assert.equal(h.getDiaryDir(), path.join(h.temp, 'ignored-by-this-case'));
});

console.log(`\n结果: ${passes} 通过 / ${failures} 失败`);
process.exit(failures ? 1 : 0);

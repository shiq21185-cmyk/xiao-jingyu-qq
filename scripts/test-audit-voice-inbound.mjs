// 入站语音转文字（《进阶篇》进阶 3）的桥接层回归。
// 用真实的 handleIncoming + segmentsToText，只把 createAsr 换成一个可控的桩：
// 转写引擎本身已在 _ref/asr-lib-test.mjs 与 _ref/asr-live-test.mjs 里验过（真跑 whisper）。
// 这里要钉住的是**接线契约**：
//   ① 关着的时候行为必须和以前一模一样（`[语音]`）；
//   ② 开着的时候文字要进 textContent/plainContent（也就是 AI 真正读到的那个字段）；
//   ③ 转写失败/抛异常**绝不能**让这条消息丢掉，也不能让 handleIncoming 抛；
//   ④ 一条消息里的语音只转一次（textContent 与 plainContent 是同一批段拼两遍）。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;

/** 默认桩：把每段"转"成用它 duration 编出来的标记，模拟成功。 */
const okStub = (segments) => segments.map((s) => `[语音 ${s?.data?.duration ?? '?'}秒：你在干嘛呀]`);

async function test(name, run, { asrOn = true, stub = okStub } = {}) {
  const calls = { transcribe: 0, batches: [], prewarm: 0 };
  const asrStub = {
    cfg: { enabled: asrOn },
    worker: { available: () => true, warnedUnavailable: false },
    get enabled() { return asrOn; },
    async transcribeSegments(segments) {
      calls.transcribe++;
      calls.batches.push(segments);
      return stub(segments, calls);
    },
    prewarm() { calls.prewarm++; return asrOn; },
    dispose() {},
  };
  const h = await bridgeHarness({
    config: {
      socialV2: {
        enabled: true, proactive: { enabled: false }, sticker: { enabled: false },
        wake: { preSleepWaitEnabled: false },
        asr: { enabled: asrOn },
      },
    },
    // createAsr 在 main() 里就被调用，所以桩必须一开始就摆好。
    globals: { createAsr: () => asrStub },
  });
  h.setMode('reserved2');
  try { await run(h, calls); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await h.close(); }
}

const ownerEvent = (message) => ({
  self_id: 999, message_id: 'msg-1', message_seq: 77,
  user_id: 123, group_id: 456, sender: { card: '主人', nickname: '主人' },
  message,
});
const recordSeg = (data = {}) => ({
  type: 'record',
  data: { file: 'voice.silk', url: 'https://cdn.invalid/voice.silk', duration: 5, ...data },
});
const lastMsg = (h) => h.getSocialV2State('group:456').recentMessages.at(-1);

await test('转写关着时行为和以前完全一样（[语音]，不碰转写引擎）', async (h, calls) => {
  await h.handleIncoming('group', 456, ownerEvent([recordSeg()]), h.cfg);
  assert.equal(calls.transcribe, 0, '关着就不该调转写');
  const msg = lastMsg(h);
  assert.equal(msg.text, '[语音]');
  assert.equal(msg.plain, '[语音]');
}, { asrOn: false });

await test('转写开着时文字进 textContent 与 plainContent', async (h, calls) => {
  await h.handleIncoming('group', 456, ownerEvent([recordSeg()]), h.cfg);
  assert.equal(calls.transcribe, 1);
  const msg = lastMsg(h);
  assert.equal(msg.text, '[语音 5秒：你在干嘛呀]');
  assert.equal(msg.plain, '[语音 5秒：你在干嘛呀]');
});

await test('同一条消息里的两条语音只走一次批量转写', async (h, calls) => {
  await h.handleIncoming('group', 456, ownerEvent([
    recordSeg(),
    recordSeg({ url: 'https://cdn.invalid/b.silk', duration: 2 }),
  ]), h.cfg);
  assert.equal(calls.transcribe, 1, '两个段应当合并成一次批量调用');
  assert.equal(calls.batches.at(-1).length, 2, '一次批量里应当有两条语音');
  assert.equal(lastMsg(h).plain, '[语音 5秒：你在干嘛呀][语音 2秒：你在干嘛呀]');
});

await test('语音和文字混在一起时，两部分都在', async (h) => {
  await h.handleIncoming('group', 456, ownerEvent([
    { type: 'text', data: { text: '听听这个 ' } },
    recordSeg(),
  ]), h.cfg);
  assert.equal(lastMsg(h).plain, '听听这个 [语音 5秒：你在干嘛呀]');
});

await test('转写给不出文字（引擎没起来 / SnowLuma 转码失败）时消息照样入库', async (h) => {
  await h.handleIncoming('group', 456, ownerEvent([recordSeg()]), h.cfg);
  const msg = lastMsg(h);
  assert.ok(msg, '消息必须还在');
  assert.equal(msg.text, '[语音]');
  assert.equal(msg.plain, '[语音]');
}, { stub: (segments) => segments.map(() => '') });

await test('转写抛异常不会让这条消息丢掉，也不会让 handleIncoming 抛', async (h) => {
  await assert.doesNotReject(() => h.handleIncoming('group', 456, ownerEvent([recordSeg()]), h.cfg));
  const msg = lastMsg(h);
  assert.ok(msg, '消息必须还在');
  assert.equal(msg.text, '[语音]');
}, { stub: () => { throw new Error('fixture-asr-boom'); } });

await test('没有语音的消息完全不走转写', async (h, calls) => {
  await h.handleIncoming('group', 456, ownerEvent([{ type: 'text', data: { text: '纯文字' } }]), h.cfg);
  assert.equal(calls.transcribe, 0);
  assert.equal(lastMsg(h).plain, '纯文字');
});

// 注意：清换行/控制字符是 asr-lib 的 cleanTranscript + formatVoiceMarker 的职责
// （_ref/asr-lib-test.mjs 里已钉），桥接这一层**原样使用**标记、不再二次加工。
// 这里钉的就是"原样"——如果哪天有人在桥接里又格式化一遍，这条会红。
await test('桥接原样使用 asr-lib 给的标记，不二次加工', async (h) => {
  const marker = '[语音 5秒：你在干嘛呀]';
  await h.handleIncoming('group', 456, ownerEvent([recordSeg()]), h.cfg);
  assert.equal(lastMsg(h).plain, marker);
}, { stub: (segments) => segments.map(() => '[语音 5秒：你在干嘛呀]') });

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exitCode = failures ? 1 : 0;

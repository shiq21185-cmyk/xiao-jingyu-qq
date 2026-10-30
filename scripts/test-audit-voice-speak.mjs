// 出站语音合成（她说的话 → 本机 TTS → 语音条）的桥接层回归。
//
// 与 test-audit-voice-inbound.mjs 是一对：那个管"她听懂你说的话"，这个管"她想说话时能开口"。
// 合成引擎本身已在 _ref/tts-lib-test.mjs（假 worker 验协议）与 _ref/tts-live-test.mjs（真 python
// 真 edge 引擎）里验过；这里要钉住的是**接线契约**：
//   ① 两个开关（voice.enabled / tts.enabled）都必须真的挡得住，且报错可读；
//   ② 合成成功的音频必须真的作为 record 段发出去，且 verified 只有回读到 record 才算 true；
//   ③ 合成失败的路径上**一条 QQ 消息都不许发**（宁可只发文字，也不能发个空语音）；
//   ④ 合成产物是内部临时文件，发完必须删 —— 它有 30 天的临时目录也不能越堆越多；
//   ⑤ 限流在**合成之前**判定（超限时不该先花掉几秒和一次网络请求）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;

/**
 * 可控的 TTS 桩：像真的 createTts 一样只回 { path, bytes, voice, engine, chars } 或 null。
 * 文件必须**真的写到磁盘上**——下游 sendVoiceV2 会 inspectAudio(path)，那是真的 statSync。
 */
function makeTts({ enabled = true, size = 2048, fail = false } = {}) {
  const calls = { synthesize: 0, requests: [], produced: [] };
  return {
    calls,
    stub: {
      cfg: { enabled, engine: 'edge', voice: 'zh-CN-XiaoyiNeural' },
      get enabled() { return enabled; },
      async synthesize(req = {}) {
        calls.synthesize++;
        calls.requests.push(req);
        if (fail) return null;
        // 名字必须带 qq-speak- 前缀：cleanupSpeech 只删这一族，正是要验的不变量
        const file = path.join(req.dir || os.tmpdir(), `qq-speak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);
        fs.writeFileSync(file, Buffer.alloc(size, 7));
        calls.produced.push(file);
        return { path: file, bytes: size, voice: 'zh-CN-XiaoyiNeural', engine: 'edge', chars: String(req.text ?? '').length };
      },
      prewarm() { return enabled; },
      dispose() {},
    },
  };
}

async function test(name, run, { voiceOn = true, ttsOn = true, ttsFail = false, config = {} } = {}) {
  const t = makeTts({ enabled: ttsOn, fail: ttsFail });
  const h = await bridgeHarness({
    config: {
      socialV2: {
        enabled: true, proactive: { enabled: false }, sticker: { enabled: false },
        wake: { preSleepWaitEnabled: false },
        voice: { enabled: voiceOn, maxPerMinute: 20, maxPerHour: 100, ...(config.voice ?? {}) },
        tts: { enabled: ttsOn },
        tools: { speak: config.speakTool !== false },
        ...(config.rest ?? {}),
      },
    },
    // createTts 在 main() 里就被调用（在 return 之前），所以这一步是真的会跑；
    // 但我们要的是完全可控的桩，所以再用 setTts 覆盖掉它。
    globals: {
      createTts: () => t.stub,
      // 让桩把文件写到本次 harness 的临时目录里，close() 时一起清掉
    },
  });
  h.setTts(t.stub);
  h.setMode('reserved2');
  try { await run(h, t.calls); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await h.close(); }
}

const recordBodies = (h) => h.calls.http.filter((c) => /send_(group|private)_msg$/.test(c.url));

await test('语音合成关着时明确拒绝，且不合成也不发', async (h, calls) => {
  await assert.rejects(
    () => h.speakForV2('group:456', '晚安'),
    /语音合成已关闭/,
  );
  assert.equal(calls.synthesize, 0, '关着就不该碰合成');
  assert.equal(recordBodies(h).length, 0, '更不该发消息');
}, { ttsOn: false });

await test('出站语音通道关着时明确拒绝（两个开关都得开）', async (h, calls) => {
  await assert.rejects(
    () => h.speakForV2('group:456', '晚安'),
    /语音功能已关闭/,
  );
  assert.equal(calls.synthesize, 0);
  assert.equal(recordBodies(h).length, 0);
}, { voiceOn: false });

await test('空文本直接拒绝，连合成都不过去', async (h, calls) => {
  await assert.rejects(() => h.speakForV2('group:456', '   '), /要念的内容是空的/);
  assert.equal(calls.synthesize, 0);
});

await test('合成成功 → 作为 record 段发出去，且标记 synthesized', async (h, calls) => {
  const sent = await h.speakForV2('group:456', '晚安，早点睡');
  assert.equal(calls.synthesize, 1);
  assert.equal(calls.requests.at(-1).text, '晚安，早点睡', '要把她的原话交给合成引擎');
  const bodies = recordBodies(h);
  assert.equal(bodies.length, 1, '应当正好发出一条语音');
  const seg = bodies[0].body.message[0];
  assert.equal(seg.type, 'record');
  assert.ok(typeof seg.data.file === 'string' && seg.data.file.length > 0, 'record 段要带文件路径');
  assert.equal(sent.synthesized, true);
  assert.equal(sent.bytes, 2048);
  assert.equal(sent.engine, 'edge');
  // 返回给模型的 file 只给 basename：完整临时路径回给模型没有意义，也更容易撞敏感信息审计
  assert.ok(!sent.file.includes('\\') && !sent.file.includes('/'), `file 应当是纯文件名，实际 ${sent.file}`);
});

await test('verified 只在回读到 record 段时为 true（get_msg 桩会回 record）', async (h) => {
  const sent = await h.speakForV2('group:456', '晚安', { verify: true });
  assert.equal(sent.verification?.confirmed, true);
});

await test('合成失败时一条 QQ 消息都不发，并且报的是可读的话', async (h, calls) => {
  await assert.rejects(
    () => h.speakForV2('group:456', '晚安'),
    /语音合成失败/,
  );
  assert.equal(recordBodies(h).length, 0, '合成没成功就绝不能发语音（宁可只发文字）');
  assert.equal(calls.synthesize, 1, '确实试过合成，只是它失败了');
}, { ttsFail: true });

await test('合成产物发完就删（临时目录不许越堆越多）', async (h, calls) => {
  const sent = await h.speakForV2('group:456', '晚安');
  const file = calls.produced.at(-1);
  assert.ok(file, '合成确实写出过文件');
  // 这是设计上的不变量：cleanupSpeech 只删 qq-speak- 前缀这一族，
  // 所以文件名必须在这一族里，否则临时目录会一直堆下去。
  assert.ok(path.basename(sent.file).startsWith('qq-speak-'), `产物名应当以 qq-speak- 开头，实际 ${sent.file}`);
  assert.equal(fs.existsSync(file), false, `发完应当删掉合成产物：${file}`);
});

await test('会话记录里留的是她说的那句话，不是一串文件名', async (h) => {
  await h.speakForV2('group:456', '晚安，早点睡');
  const st = h.getSocialV2State('group:456');
  const last = st.recentMessages.at(-1);
  assert.equal(last.isSelf, true);
  assert.equal(last.text, '晚安，早点睡');
  assert.equal(last.plain, '晚安，早点睡');
});

await test('显式传 label 时用 label 记账', async (h) => {
  await h.speakForV2('group:456', '晚安，早点睡', { label: '说了句晚安' });
  assert.equal(h.getSocialV2State('group:456').recentMessages.at(-1).text, '说了句晚安');
});

// 限流必须在合成之前：合成要花几秒 + 一次网络请求，超限时先花掉这些是纯浪费。
await test('频率超限时不再合成（限流判在合成之前）', async (h, calls) => {
  await h.speakForV2('group:456', '第一条');
  assert.equal(calls.synthesize, 1);
  await assert.rejects(() => h.speakForV2('group:456', '第二条'), /频率超限|超限/);
  assert.equal(calls.synthesize, 1, '被限流的那条不该再合成');
  assert.equal(recordBodies(h).length, 1, '也不该多发出语音');
}, { config: { voice: { maxPerMinute: 1, maxPerHour: 1 } } });

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exitCode = failures ? 1 : 0;

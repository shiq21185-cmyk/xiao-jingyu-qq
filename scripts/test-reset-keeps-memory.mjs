// 「清除上下文」不能连记忆一起删 —— 2026-10-23 主人踩到的坑。
//
// 背景：2026-10-23 19:36 在控制台点了两次「清除上下文」，之后 state/social-v2.json
// 变成 {"paused":false,"conversations":{}}，四个会话里她记的话题 / 想法 / 印象 / 约定
// 全没了。原因是 /api/session/reset 和聊天里的 /reset 都在清会话时直接做了
// `socialV2.conversations.delete(key)` —— 删掉的是整个会话对象，记忆是它的字段。
//
// 会话上下文该清（消息记录、读水位、未读队列、唤醒计时、agentToken 都换新的），
// 但「她记得什么」不属于上下文。这组测试钉住：
//   ① 清上下文的路径调的是 deleteConversationKeepingMemory()，不是裸 delete
//   ② 那个函数确实把四个记忆字段搬到了新状态上
//   ③ 没到点的约定会把定时器重新挂上（否则约定永远不会触发）
//   ④ 没有记忆时不硬造一个空会话对象（免得每个被重置的会话都留一条垃圾）
//
// 跑：node scripts/test-reset-keeps-memory.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');

// bridge.js 是 CRLF，按「与 function 关键字同缩进的 }」收尾，缩进从源码现读。
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `bridge.js 里找不到 ${name}()`);
  const lineStart = src.lastIndexOf('\n', start) + 1;
  const indent = src.slice(lineStart, start);
  assert.match(indent, /^[ \t]*$/, `${name}() 前面不该有别的代码`);
  const re = new RegExp(`\\r?\\n${indent}\\}\\r?\\n`, 'g');
  re.lastIndex = start;
  const hit = re.exec(src);
  assert.ok(hit, `${name}() 找不到同缩进的结尾`);
  const closeAt = hit[0].indexOf('}');
  return src.slice(start, hit.index + closeAt + 1);
}

const MEMORY_FIELDS = ['activeTopics', 'pendingThoughts', 'memberImpressions', 'promises'];

const FN = extractFn(SRC, 'deleteConversationKeepingMemory');

// 在一个最小沙箱里跑那个函数：conversations 用真的 Map，getSocialV2State 用桩。
function makeRunner({ memoryCount = 0, promises = [] } = {}) {
  const calls = { getState: 0, schedulePromise: [] };
  const conversations = new Map();
  const seed = { activeTopics: [], pendingThoughts: [], memberImpressions: {}, promises: [] };
  if (memoryCount > 0) {
    seed.activeTopics = [{ text: '聊到临时站', at: 1 }];
    seed.memberImpressions = { 100000001: { traits: ['爱问关系定位'] } };
  }
  if (promises.length) seed.promises = promises;
  conversations.set('private:100000001', seed);

  const factory = new Function(
    'socialV2', 'getSocialV2State', 'schedulePromiseV2', 'log',
    `${FN}\nreturn deleteConversationKeepingMemory;`
  );
  const fn = factory(
    { conversations },
    (key) => {
      calls.getState++;
      const fresh = { activeTopics: [], pendingThoughts: [], memberImpressions: {}, promises: [], agentToken: 'new', unread: [] };
      conversations.set(key, fresh);
      return fresh;
    },
    (key) => { calls.schedulePromise.push(key); },
    () => {}
  );
  return { fn, conversations, calls };
}

test('清上下文走的是"保留记忆"的那个函数，不是裸 delete', () => {
  // 两处真正会清上下文：/api/session/reset 与聊天里的 /reset。
  const hits = [...SRC.matchAll(/deleteConversationKeepingMemory\(key\)/g)];
  assert.ok(hits.length >= 2, `deleteConversationKeepingMemory(key) 至少要出现 2 次（实际 ${hits.length}）`);
  // 这两个位置不能再有裸 delete（/api/socialV2/reset 的"全部重置"那条是故意的，不算）。
  const resetBlock = SRC.slice(SRC.indexOf("url.pathname === '/api/session/reset'"), SRC.indexOf("url.pathname === '/api/workspace/reset'"));
  assert.ok(!/socialV2\.conversations\.delete\(key\)/.test(resetBlock), '/api/session/reset 里不能再直接删会话对象');
  assert.ok(resetBlock.includes('deleteConversationKeepingMemory(key)'), '/api/session/reset 必须调用 deleteConversationKeepingMemory');
});

test('四个记忆字段都被搬到新状态上', () => {
  for (const f of MEMORY_FIELDS) {
    assert.ok(new RegExp(`fresh\\.${f} = snap\\.${f}`).test(FN), `没把 ${f} 搬到新状态`);
  }
});

test('有记忆时：会话对象换了新的，但记忆还在', () => {
  const { fn, conversations } = makeRunner({ memoryCount: 1 });
  const kept = fn('private:100000001');
  const st = conversations.get('private:100000001');
  assert.ok(st, '重设后应该有会话对象');
  assert.equal(st.agentToken, 'new', '上下文该是新的（agentToken 要换）');
  assert.ok(Array.isArray(st.unread) && st.unread.length === 0, '未读队列该清空');
  assert.equal(st.activeTopics.length, 1, '话题必须留下来');
  assert.equal(st.activeTopics[0].text, '聊到临时站');
  assert.deepEqual(st.memberImpressions, { 100000001: { traits: ['爱问关系定位'] } }, '印象必须留下来');
  assert.ok(kept >= 1, '返回值是保留下来的条数');
});

test('没到点的约定要重新挂定时器', () => {
  const { fn, calls } = makeRunner({ memoryCount: 1, promises: [{ id: 'p1', text: '叫他起床', at: Date.now() + 3600e3 }] });
  fn('private:100000001');
  assert.deepEqual(calls.schedulePromise, ['private:100000001'], '有约定就必须重新 schedulePromiseV2，否则约定永远不会到点');
});

test('本来就没记忆时，不硬造一个空会话对象', () => {
  const { fn, conversations, calls } = makeRunner({ memoryCount: 0 });
  const kept = fn('private:100000001');
  assert.equal(kept, 0);
  assert.equal(conversations.has('private:100000001'), false, '没记忆就不该留空壳');
  assert.equal(calls.schedulePromise.length, 0);
  assert.equal(calls.getState, 0, '没记忆时不该调用 getSocialV2State');
});

test('控制台两处按钮的提示文案要分清「清上下文」和「全部重置」', () => {
  const HTML = fs.readFileSync(path.join(ROOT, 'public/console.html'), 'utf8');
  assert.ok(HTML.includes('她记着的话题、想法、印象、约定会保留'), '会话列表的「清除上下文」提示要说明记忆会保留');
  assert.ok(HTML.includes('会连她记的话题、想法、印象、约定一起清掉'), '「全部重置」提示要警告记忆会被清掉');
});

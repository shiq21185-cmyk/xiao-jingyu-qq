// 「记忆跨会话串味」回归测试（2026-10-21 真实事故）。
//
// 事故现象：主人在自己私聊里说"给你弄个小黑盒账号"，她转头去问另一个好友
// "你说的小黑盒账号什么时候搞"，对方回"我没跟你说过"。
//
// 根因不是记忆存错了（那条确实标了 private:100000001），而是：
//   ① 记忆索引是**跨会话共享**的，每个会话唤醒都看到同一份列表；
//   ② 早期条目没有来源标签，读起来像"通用上下文"；
//   ③ 块内与角色卡都没有说明"只有来源=当前会话的才算对方说过的"。
// 于是模型把 A 私聊里的事当成了当前这个人的事。
//
// 这组测试钉住：索引必须每条都有来源、必须带"来源决定归属"的读法说明。
//
// 跑：node scripts/test-memory-isolation.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildIndexBlock, selectIndexItems } from '../plugins/qq-memory-rollover/memory-index.mjs';
import { ensureAll } from './_fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 公开仓库不带私人记忆/人格卡，缺了就现造一份夹具。
const FX = ensureAll();
const MEMORY = JSON.parse(fs.readFileSync(FX.memoryFile, 'utf8'));
const ROLE_FILE = FX.roleFile;
const ROLE = fs.readFileSync(ROLE_FILE, 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'plugins/qq-memory-rollover/memory-index.mjs'), 'utf8');

test('索引里每一条都必须带来源会话，不许有"无主"条目', () => {
  const r = selectIndexItems(MEMORY);
  for (const line of r.lines) {
    assert.match(
      line,
      /^- \d{2}-\d{2}｜(私聊\d{5,12}|群\d{5,12})｜/,
      `条目缺来源标签：${line}`
    );
  }
});

test('daily-memory 里不许再有裸字符串条目（无法判定归属）', () => {
  const bare = [];
  for (const day of MEMORY.items || []) {
    for (const it of day.items || []) {
      const isObj = it && typeof it === 'object' && String(it.scope || '').trim();
      if (!isObj) bare.push(`${day.date}: ${typeof it === 'object' ? it.text : it}`);
    }
  }
  assert.equal(bare.length, 0, `发现无来源条目 ${bare.length} 条：\n${bare.slice(0, 5).join('\n')}`);
});

test('索引块必须写明「来源决定归属，别人的事不能安到当前人头上」', () => {
  const block = buildIndexBlock(['- 10-21｜私聊100000001｜测试'], '\n', { keptDays: 1 });
  assert.ok(
    block.includes('只有来源等于当前这个会话的'),
    '索引块内部必须自带读法说明；只写在角色卡里不够'
  );
  assert.ok(block.includes('不要拿去问当前这个人'), '必须明确禁止把别人的事问当前这个人');
});

test('小黑盒这条必须归属主人私聊，不能无来源', () => {
  // 归属是**数据属性**，跟"今天还能不能挤进索引预算"无关 —— 先直接查数据层，
  // 这一层永远不会因为记忆变多而失效。
  const entries = [];
  for (const day of MEMORY.items || []) {
    for (const it of day.items || []) {
      if (String(it?.text || '').includes('小黑盒')) entries.push(it);
    }
  }
  assert.ok(entries.length > 0, 'daily-memory 里应当还留着这条小黑盒记忆');
  for (const it of entries) {
    assert.equal(
      String(it.scope || '').trim(),
      'private:100000001',
      `小黑盒是主人在自己私聊里说的，归属必须是他；实际：${it.scope}`
    );
  }
  // 再钉住"进索引时标签也得对"。
  //
  // ⚠️ 2026-10-26 改成**固定夹具**：原版拿真实记忆 + 把 now 钉在记录当天，赌"那天必然进索引"。
  //    这个赌注随记忆增长必然输，而且已经输了两次：
  //      · 10-24 第一次红 —— 10-21 滑出了 recentDays，补丁是把 now 钉到记录当天；
  //      · 10-26 第二次红 —— 钉了日期也没用，因为**同一天里**稍长的条目先把 2480 字的
  //        预算挤满，10-21 的第三条（小黑盒）被"超预算从最旧砍"正常砍掉了。
  //    两次红的断言信息都写着"记录当天必然进索引"，真正的变量却是**总量与预算**。
  //    这里要钉的是"归属渲染对不对"，不是"今天能不能挤进去" —— 所以用夹具把总量与预算
  //    固定下来，断言才真的在测它自称要测的东西。（数据层的归属检查留在上面那一段，
  //    那一段读真实记忆，但只断言数据属性，永远不会因为记忆变多而失效。）
  const fixture = {
    lastDigestDate: '2026-10-21',
    items: [
      {
        date: '2026-10-21',
        items: [
          { scope: 'private:100000001', text: 'QQ100000001 计划给我一个小黑盒账号全权管理，让我先找教程发他链接' },
          { scope: 'private:100000003', text: 'QQ100000003 同一天问了些别的事' },
        ],
      },
    ],
  };
  const r = selectIndexItems(fixture, {
    now: new Date('2026-10-21T12:00:00+08:00'),
    maxChars: 2480,
  });
  const hit = r.lines.find((l) => l.includes('小黑盒'));
  assert.ok(hit, '夹具只有两条、预算 2480 字，必然进索引；不进才说明预算/分层逻辑坏了');
  assert.ok(
    hit.includes('私聊100000001'),
    `小黑盒是主人在自己私聊里说的，归属必须是他；实际：${hit}`
  );
  assert.ok(
    !r.lines.some((l) => l.includes('小黑盒') && !l.includes('私聊100000001')),
    '同一件事绝不能同时又挂到别人名下'
  );
});

test('角色卡必须有一条明确的跨会话隔离规则', () => {
  // 2026-10-21 角色卡重写：该节标题改为「记忆怎么用」，意思不变
  assert.ok(ROLE.includes('记忆怎么用') || ROLE.includes('谁说的话'), '角色卡需要专门一节讲跨会话归属');
  assert.ok(/不要拿去问当前这个人|绝不能把别人的事安到当前这个人头上/.test(ROLE), '必须给出明确禁止');
});

test('角色卡索引只有一个块（防止重复块把旧归属盖回来）', () => {
  const starts = (ROLE.match(/qq-memory-index:start/g) || []).length;
  const ends = (ROLE.match(/qq-memory-index:end/g) || []).length;
  assert.equal(starts, 1);
  assert.equal(ends, 1);
});

test('来源标签只认 group:/private:，昵称不会被当来源', () => {
  assert.ok(INDEX_SRC.includes("kind === 'group'"), '来源前缀只按 group/private 判断');
});

// 「记忆索引体积预算」回归测试（2026-10-21 主人要求）。
//
// 问题：角色卡 9758 / role.maxInjectChars 10000，只剩 242 字符余量，日增约 175 字符。
// 一天后就会超限；而超限截断是**从头砍**的，索引在文件末尾 ⇒
// 最新的记忆被砍掉、还会切在半条中间，连「读法」和结束标记一起消失。
//
// 这组测试钉住：无论喂多少数据，索引块都必须装进字符预算，且**保留的永远是最新的**。
//
// 跑：node scripts/test-index-budget.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  INDEX_BLOCK_OVERHEAD_CHARS,
  INDEX_MAX_CHARS,
  buildIndexBlock,
  selectIndexItems,
} from '../plugins/qq-memory-rollover/memory-index.mjs';
import { ensureAll, ensureConfig } from './_fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 公开仓库不带私人的 config.json / state/ / 人格卡，缺什么就在这里现造一份夹具。
const FX = ensureAll();
const CONFIG = ensureConfig();
const ROLE_FILE = FX.roleFile;
const ROLE = fs.readFileSync(FX.roleFile, 'utf8');
const MEMORY = JSON.parse(fs.readFileSync(FX.memoryFile, 'utf8'));

const dayAgo = (n, items) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return { date: d.toISOString().slice(0, 10), items };
};
const blockOf = (r) => buildIndexBlock(r.lines, '\n', {
  archivedCount: r.archivedCount, keywords: r.keywords, keptDays: r.keptDays,
});

test('常量自洽：条目区预算是总预算减去固定开销', () => {
  assert.ok(INDEX_MAX_CHARS > INDEX_BLOCK_OVERHEAD_CHARS, '预算必须大于固定开销');
  assert.ok(INDEX_BLOCK_OVERHEAD_CHARS >= 200, '固定开销估计太低会导致条目挤爆块');
});

test('真实 daily-memory 渲染后必须装进预算', () => {
  const r = selectIndexItems(MEMORY);
  const block = blockOf(r);
  assert.ok(
    block.length <= INDEX_MAX_CHARS,
    `索引块 ${block.length} 超过预算 ${INDEX_MAX_CHARS}`
  );
});

test('喂 70 条（一天 10 条 × 7 天）也必须装进预算', () => {
  const items = [];
  for (let i = 6; i >= 0; i--) {
    for (let j = 0; j < 10; j++) {
      items.push({ scope: 'private:100000001', text: '第' + i + '天第' + j + '条测试记忆，故意写长一点来撑体积，验证预算是否生效' });
    }
  }
  const r = selectIndexItems({ items: [dayAgo(0, items)] });
  const block = blockOf(r);
  assert.ok(block.length <= INDEX_MAX_CHARS, `70 条时索引块 ${block.length} 超预算`);
});

test('预算先砍最旧：最新那天的记忆必须还在', () => {
  const items = [];
  for (let i = 6; i >= 0; i--) {
    for (let j = 0; j < 10; j++) {
      items.push({ scope: 'private:100000001', text: 'D' + i + 'X' + j + ' ' + '内容'.repeat(20) });
    }
  }
  const r = selectIndexItems({ items: [dayAgo(0, items)] });
  assert.ok(r.lines.some((l) => l.includes('D0X')), '最新的第 0 天必须保留');
  assert.ok(!r.lines.some((l) => l.includes('D6X')), '最旧的第 6 天应被砍掉');
});

test('单条超长时不能返回空索引（会被读成"我没有记忆"）', () => {
  const r = selectIndexItems({
    items: [dayAgo(0, [{ scope: 'private:100000001', text: '超长'.repeat(900) }])],
  });
  assert.ok(r.lines.length >= 1, '极端情况下也要至少留一条');
  assert.ok(blockOf(r).length <= INDEX_MAX_CHARS, '保底截断后仍须达标');
});

test('砍掉的条目仍然留在 archived 里（可用 qq_memory_query 检索）', () => {
  const items = [];
  for (let j = 0; j < 40; j++) {
    items.push({ scope: 'private:100000001', text: '条目' + j + ' ' + '填充'.repeat(15) });
  }
  const r = selectIndexItems({ items: [dayAgo(0, items)] });
  assert.ok(r.droppedForBudget > 0, '这个数据量应当触发体积裁剪');
  assert.equal(r.archivedCount >= r.droppedForBudget, true, '被砍的必须计入归档数');
});

test('资讯：真角色卡「正文 + 索引」不得超过 maxInjectChars', () => {
  const body = ROLE
    .replace(/[\r\n]*<!-- qq-memory-index:start -->[\s\S]*?<!-- qq-memory-index:end -->[\r\n]*/g, '')
    .replace(/\s+$/, '')
    .length;
  const r = selectIndexItems(MEMORY);
  const total = body + blockOf(r).length;
  assert.ok(
    total <= CONFIG.role.maxInjectChars,
    `角色卡总长 ${total} 超过注入上限 ${CONFIG.role.maxInjectChars}（正文 ${body} + 索引 ${total - body}）`
  );
});

test('角色卡里索引块结构完整（标记成对、读法说明还在）', () => {
  const starts = (ROLE.match(/qq-memory-index:start/g) || []).length;
  const ends = (ROLE.match(/qq-memory-index:end/g) || []).length;
  assert.equal(starts, 1, '必须恰好一个索引块');
  assert.equal(ends, 1, '结束标记必须存在（超限被砍就会丢）');
  assert.ok(ROLE.includes('读法'), '读法说明不能被截断掉');
});

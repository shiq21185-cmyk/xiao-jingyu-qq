// 日记「日期归属」回归测试（2026-10-19）。
//
// 为什么必须有这个文件
// --------------------
// 一次真实事故：她对群友说「没刷视频，打了一下午消消乐」，而她**当天一次都没碰过游戏**
// （当天 phone_* 调用数为 0，最后一次真玩是前一天）。素材逐字来自前一天的日记：
// 「下午摸进消消乐，一口气从27关推到38关」。
//
// 根因不是她"故意撒谎"，而是**注入提示词的日记行没说清这是哪一天写的**：
// 原格式只有 "- 2026-10-18 19:04 下午摸进消消乐…"，正文里的「下午」不带日期，
// 模型得自己把日期换算成"这是昨天"才不会讲错 —— 它没换算，于是把前一天的
// 经历当成今天的讲了出去。而提示词里**同时**给了「当前时间」，两行一凑就成了
// 「今天下午我在打消消乐」。
//
// 修复方式就是让日期归属**不再依赖模型做减法**：行首显式标出
// 【今天】/【昨天】/【具体日期】，并在摘要末尾写死"不能把以前某天的日记当成今天说"。
//
// 这个文件钉住的正是这两件事，以及几个容易翻车的边界：
//   · map 直接传函数会把**数组下标**当成第二参数（today），首行会被标成具体日期。
//     这个坑我第一版就踩了，必须有测试拦住它再犯。
//   · 时间字段被手改坏时不能崩、也不能乱标一个日期。
//
// 跑：node --test scripts/test-diary-recall.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diaryBrief, diaryDay, diaryDayLabel, diaryWrite, formatDiaryEntries } from '../src/diary-lib.js';

const TODAY = diaryDay();
const YESTERDAY = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return diaryDay(d);
})();

/** 建一个临时日记目录，跑完删掉（测试绝不碰真实日记本）。 */
function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('今天的日记标【今天】，昨天标【昨天】，更早标具体日期', () => {
  const out = formatDiaryEntries([
    { 时间: `${TODAY} 15:42`, 内容: '今天的事' },
    { 时间: `${YESTERDAY} 19:04`, 内容: '昨天的事' },
    { 时间: '2026-01-02 10:00', 内容: '很久以前的事' },
  ]);
  const lines = out.split('\n');
  assert.match(lines[0], /^- 【今天】 15:42 /, `今天的行应以【今天】开头，实际：${lines[0]}`);
  assert.match(lines[1], /^- 【昨天】 19:04 /, `昨天的行应以【昨天】开头，实际：${lines[1]}`);
  assert.match(lines[2], /^- 【2026-01-02】 10:00 /, `更早的行应标具体日期，实际：${lines[2]}`);
});

test('★ 标签每天现算、会随时间滚动：同一条日记今天是【今天】，隔天变【昨天】', () => {
  // 这是「【今天】前缀会不会每天更新」这个问题的回归。
  // 设计要点：日记文件里存的是**绝对日期**（"2026-10-19 15:42"），
  // 标签是**每次渲染时现算**的（diaryBrief / formatDiaryEntries 各自在调用时取 diaryDay()），
  // 不落盘、不缓存。所以同一条记录隔天会自然从【今天】变成【昨天】，再往后变具体日期。
  //
  // ⚠️ 这里直接调用生产代码导出的 diaryDayLabel，**不在测试里重写一份算法**：
  //    副本会随生产实现漂移，那种测试看着绿、其实没测到线上那段代码。
  const rec = `${'2030-06-15'}`;
  assert.equal(diaryDayLabel(rec, '2030-06-15'), '【今天】', '当天应标今天');
  assert.equal(diaryDayLabel(rec, '2030-06-16'), '【昨天】', '隔天应自动变昨天（这就是"每天更新"）');
  assert.equal(diaryDayLabel(rec, '2030-06-17'), '【2030-06-15】', '第三天应变具体日期');
  assert.equal(diaryDayLabel(rec, '2031-01-01'), '【2030-06-15】', '很久以后仍是具体日期');
});

test('★ 「昨天」必须由传入的 today 反推，不能另读真实时钟', () => {
  // 一次真实的自查缺陷：diaryDayLabel(day, today) 起初对【今天】用了 today，
  // 对【昨天】却另读真实时钟 —— 同一个 today 下标签不自洽，跨午夜还可能给出
  // 互相矛盾的结果（两次时钟读取分别落在两天）。
  // 这里拿一个**远离真实今天**的日期来暴露它：若昨天是拿真实时钟算的，
  // 2030-01-01 就永远不会被判成 2030-01-02 的昨天。
  assert.equal(
    diaryDayLabel('2030-01-01', '2030-01-02'),
    '【昨天】',
    '昨天必须从传入的 today 反推（若返回具体日期，说明又读了真实时钟）',
  );
  // 跨月/跨年边界
  assert.equal(diaryDayLabel('2029-12-31', '2030-01-01'), '【昨天】', '跨年边界');
  assert.equal(diaryDayLabel('2030-02-28', '2030-03-01'), '【昨天】', '跨月边界（非闰年）');
  assert.equal(diaryDayLabel('2032-02-29', '2032-03-01'), '【昨天】', '闰年 2/29 边界');
});

test('跨午夜：23:59 写的日记，第二天应整条变【昨天】（日期按天算，不按时间）', () => {
  assert.equal(diaryDayLabel('2030-06-15', '2030-06-16'), '【昨天】', '跨午夜后应整条变昨天');
  // 反过来：当天最早的一刻仍算今天（不因时间早而错标）
  assert.equal(diaryDayLabel('2030-06-16', '2030-06-16'), '【今天】', '当天 00:00 也算今天');
});


test('★ 首行必须是【今天】：map 传下标当 today 的坑不能再犯', () => {
  // 这条是专门为一次真实回归写的：formatDiaryEntries 里若写成
  // `entries.map(entryLine)`，entryLine 的第二参数会收到**下标**（0），
  // 于是第一行被标成具体日期而不是【今天】。
  const out = formatDiaryEntries([
    { 时间: `${TODAY} 09:00`, 内容: '第一条' },
    { 时间: `${TODAY} 20:00`, 内容: '第二条' },
  ]);
  const first = out.split('\n')[0];
  assert.ok(
    first.includes('【今天】'),
    `第一条今天的日记必须标【今天】（map 传入下标会导致标成日期）：${first}`,
  );
});

test('时间字段坏掉时不崩、也不乱标日期', () => {
  for (const bad of ['', '坏掉了', '2026-13-99 99:99', '不是时间']) {
    const out = formatDiaryEntries([{ 时间: bad, 内容: '内容还在' }]);
    assert.ok(out.includes('内容还在'), `内容不该丢：${out}`);
    assert.ok(!out.includes('【今天】') && !out.includes('【昨天】'), `坏时间不该被标成今天/昨天：${out}`);
  }
});

test('diaryBrief 的末尾必须写明「不能把以前的日记当成今天说」', () => {
  withTempDir((dir) => {
    diaryWrite(dir, { text: '昨天摸进消消乐，一口气推到38关', day: YESTERDAY, time: '19:04' });
    const brief = diaryBrief(dir, 3);
    assert.ok(brief.includes('【昨天】'), `注入的日记行应标出昨天：${brief}`);
    // 这是修复的**语义落点**：只标日期不够，还得明确禁止把过去当今天用。
    assert.match(
      brief,
      /不能把以前某天的日记当成今天说/,
      'diaryBrief 末尾丢失了「不能把以前某天的日记当成今天说」这条约束',
    );
  });
});

test('没有日记时不注入（返回空串，避免出现空标题）', () => {
  withTempDir((dir) => {
    assert.equal(diaryBrief(dir, 3), '', '没有日记时 diaryBrief 必须返回空串');
  });
});

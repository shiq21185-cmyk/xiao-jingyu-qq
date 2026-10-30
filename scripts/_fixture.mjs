// 公开仓库的测试夹具：仓库里不带 config.json / state/ / roles/小鲸鱼.md 这些
// 「装一台就有一份」的私人数据，测试需要它们时在这里现造。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SAMPLE_ROLE = `# 角色卡：示例

## 一、你是谁
- 你是「示例角色」。去掉 AI 味，像真人说话。

## 二、分条方式 〔一代〕
- 想分条就用空格分隔；想沉默就输出 [SILENT]。

## 三、发言方式 〔二代〕
- 用 qq_send_message 的数组分条，潜水走 qq_mark_read。

## 四、记忆怎么用（谁说的话是谁的）
- 记忆索引是跨会话共享的，只有来源等于当前会话的才算"对方跟我说过的话"。
- 绝不能把别人的事安到当前这个人头上。

<!-- qq-memory-index:start -->
## 记忆索引
- 10-21｜私聊100000001｜主人说想弄个小黑盒账号
- 10-21｜私聊100000001｜主人提到养了条大肥鱼
> 读法：每条前面的「私聊<QQ号>｜」标出这件事发生在哪。只有来源等于当前会话的，才算"对方跟我说过的话"。
<!-- qq-memory-index:end -->
`;

const SAMPLE_MEMORY = {
  lastDigestDate: '2026-10-21',
  items: [{
    date: '2026-10-21',
    items: [
      { scope: 'private:100000001', text: '主人说想弄个小黑盒账号，等她弄好' },
      { scope: 'group:100000002', text: '群里有人聊到养的大肥鱼' },
    ],
  }],
};

export function ensureConfig() {
  const p = path.join(ROOT, 'config.json');
  if (!fs.existsSync(p)) {
    fs.copyFileSync(path.join(ROOT, 'config.template.json'), p);
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    cfg.ownerQQ = 100000001;
    cfg.selfQQ = 100000002;
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function ensureState() {
  const role = path.join(ROOT, 'state', 'current-role.json');
  const mem = path.join(ROOT, 'state', 'daily-memory.json');
  fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true });
  if (!fs.existsSync(role)) {
    fs.writeFileSync(role, JSON.stringify({ role: '示例', mode: 'active' }, null, 2));
  }
  if (!fs.existsSync(mem)) fs.writeFileSync(mem, JSON.stringify(SAMPLE_MEMORY, null, 2));
  const name = JSON.parse(fs.readFileSync(role, 'utf8')).role;
  const card = path.join(ROOT, 'roles', name + '.md');
  if (!fs.existsSync(card)) {
    fs.mkdirSync(path.join(ROOT, 'roles'), { recursive: true });
    fs.writeFileSync(card, SAMPLE_ROLE);
  }
  return { roleName: name, roleFile: card, memoryFile: mem };
}

export function ensureAll() {
  ensureConfig();
  return ensureState();
}

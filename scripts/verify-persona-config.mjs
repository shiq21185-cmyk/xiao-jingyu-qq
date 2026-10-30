// 用 DSH 自身的 dsh-persona 配置 schema 校验修复后的 preset persona 配置。
// 说明：直接加载 DSH 安装目录里的模块做 schema 校验，不依赖 YAML 解析器版本，
// 也不需要 DSH 进程在跑。DSH 安装位置可用 DSH_INSTALL_MODULES 覆盖，未设置时自动探测。
import path from 'node:path';
import fs from 'node:fs';
import { dshModulesDir, importFromDsh, cleanupAsarTemp } from './dsh-modules.mjs';

const DSH_MODULES = dshModulesDir();

// ⚠️ 不能直接 import(DSH_MODULES + 包路径)：Electron 桌面包的模块打在
//    `resources/app.asar` 里，Node 的 ESM loader 不认这个容器格式。
//    importFromDsh 会把用到的包抽到临时目录再 import（磁盘布局则原样 import）。
const persona = await importFromDsh(DSH_MODULES, '@deepseek-ai/dsh-persona/lib/index.js');

/**
 * DSH 已注册的提示词变量（`ctx.systemPrompt.variable(...)` 注册的那些）。
 *
 * 为什么要在这里写死：`dsh-system-prompt` 的 `interpolate()` 对未知变量是
 * **fail loud** —— 直接 `throw new Error('unknown prompt variable ...')`，
 * 不是渲染成空串。所以 preset 里多写一个变量，等于**每一次**回合都在系统提示词
 * 装配阶段直接 error（`turn/start` 后立刻 `turn/end reason=error`，
 * 没有 `assistant/message`、没有 `tool/call`，模型一次都不跑）。
 * QQ 侧看到的现象就是"发消息完全不回"。
 *
 * 0.1.x～0.2.0 曾注册 `cwd`，**0.2.1 起删掉了**，本机 0.2.1-rc.2 实测只剩
 * provider / model / response_language（从 app.asar 里扫 `systemPrompt.variable(` 得到）。
 * 这里取交集里最保守的一组：写起来只会少不会多，未知变量一律报红。
 */
const REGISTERED_PROMPT_VARS = new Set(['provider', 'model', 'response_language']);

let failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (e) { console.log(`  ❌ ${label}: ${e?.message ?? e}`); failed += 1; }
}

console.log('persona Config schema 校验：\n');

// 旧写法（DSH 0.1.2 时代的 text 字段）—— 期望被拒绝
check('旧配置 {text} 被拒绝（复现原故障）', () => {
  let threw = false;
  try { persona.Config({ text: 'hello' }); } catch { threw = true; }
  if (!threw) throw new Error('旧配置竟然通过了校验，说明本次改动前提不成立');
});

// 新写法 —— 期望通过
check('新配置 {prefix} 通过（个人前缀）', () => {
  const v = persona.Config({ prefix: 'You are a coding agent powered by the {{model}} model.' });
  if (v.prefix.length === 0) throw new Error('prefix 为空');
});

check('新配置 {prefix, suffix} 通过（含已注册的 {{model}} 模板）', () => {
  const v = persona.Config({
    prefix: 'You are a coding agent powered by the {{model}} model.',
    suffix: 'Write concisely.',
  });
  if (v.suffix !== 'Write concisely.') throw new Error('suffix 未保留');
  if (v.complete !== false) throw new Error('complete 默认值异常');
  if (v.includeRuntimeContext !== true) throw new Error('includeRuntimeContext 默认值异常');
});

// 校验仓库里两个 preset 的 persona 配置块
const YAML = await importFromDsh(DSH_MODULES, 'js-yaml/index.js');
const yaml = YAML.default ?? YAML;

for (const preset of ['qq-chat', 'qq-chat-v2']) {
  const file = path.resolve(process.cwd(), 'dsh/agent-presets', preset, 'agent.cordis.yml');
  console.log(`\n${preset} (${path.relative(process.cwd(), file)}):`);
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  const row = doc.find((r) => r.id === 'persona');
  check('存在 persona 行', () => { if (!row) throw new Error('缺少 persona 行'); });
  check('persona 行名正确', () => {
    if (row.name !== '@deepseek-ai/dsh-persona') throw new Error(`name=${row.name}`);
  });
  check('persona.config 通过 DSH schema', () => { persona.Config(row.config); });
  check('保留了 {{model}} 变量', () => {
    if (!/\{\{model\}\}/.test(row.config.prefix)) throw new Error('prefix 缺少 {{model}}');
  });
  // ⚠️ 断言方向：**只允许** DSH 已注册的提示词变量，而不是"必须出现 {{cwd}}"。
  //    DSH 0.2.1 起 agent loop 只注册 provider / model（0.2.0 还有 cwd），
  //    `dsh-system-prompt` 对未知变量是 **fail loud**（直接 throw），
  //    所以 preset 里只要出现 `{{cwd}}`，**每一次**回合都会在装配阶段 error、
  //    模型一次都不跑（QQ 侧表现就是"完全不回"）。旧断言恰好要求它必须存在，
  //    方向是反的 —— 它会把能跑的状态判成红，把炸掉的状态判成绿。
  check('只引用 DSH 已注册的提示词变量（不得出现 {{cwd}}）', () => {
    const vars = new Set();
    for (const m of String(row.config.prefix ?? '').matchAll(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g)) vars.add(m[1]);
    for (const m of String(row.config.suffix ?? '').matchAll(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g)) vars.add(m[1]);
    const unknown = [...vars].filter((v) => !REGISTERED_PROMPT_VARS.has(v));
    if (unknown.length > 0) {
      throw new Error(`出现未注册的提示词变量：${unknown.map((v) => `{{${v}}}`).join(', ')}`
        + `（DSH 0.2.1 只注册 ${[...REGISTERED_PROMPT_VARS].join(' / ')}；未知变量会让整条回合直接 error）`);
    }
  });
  check('不再包含已废弃的 text 字段', () => {
    if (Object.hasOwn(row.config, 'text')) throw new Error('仍有 text 字段');
  });
  check('persona 正文（除头句）完整保留', () => {
    const body = row.config.prefix.split('\n').slice(1).join('\n');
    if (body.length < 500) throw new Error(`正文疑似丢失，仅 ${body.length} 字符`);
  });
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
cleanupAsarTemp();   // 清掉 asar 布局下抽出来的临时目录
process.exit(failed === 0 ? 0 : 1);

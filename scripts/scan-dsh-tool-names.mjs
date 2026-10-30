// DSH 工具名清单扫描器：从**已安装的 DSH 包/插件**里抽取真实注册的工具名，
// 与 QQ 守卫的 restrict 名单对账。
//
// 为什么要有这个脚本（而不是把清单抄死在注释里）
// ----------------------------------------------
// `tools.restrict({ deny: [name] })` 对**不存在的工具名会抛错**，而守卫是逐个
// try/catch 的 ⇒ 拼错/过期的名字 = 静默 no-op，安全边界无声地少一层。
// 反过来，DSH 每个版本都会新增工具，守卫漏掉新名字 = 该隐藏的能力留在
// 仿真会话的 schema 里。两类漂移都只能靠「拿安装包重新对账」发现。
//
// 抽取逻辑在 scripts/dsh-tool-names.mjs（唯一实现，测试与扫描器共用）；
// 本文件只是 CLI：打印、分类、给退出码。
//
// 本脚本是**只读**的：不改任何文件。
//
// 用法：
//   node scripts/scan-dsh-tool-names.mjs            # 对账并打印全部候选
//   node scripts/scan-dsh-tool-names.mjs --missing  # 只打印值得补进守卫的名字
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  collectDshToolNames, dshPackagesDir, DANGER_TOOL_RE, SAFE_MODEL_TOOLS, TOOL_NAME_RE,
} from './dsh-tool-names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { names, packages } = collectDshToolNames();
const guardPath = path.join(ROOT, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
const guard = await import(pathToFileURL(guardPath).href);
const guarded = new Set(guard.RESTRICTED_TOOL_NAMES);

const sorted = [...names.keys()].sort();
const onlyFlag = process.argv.includes('--missing');

console.log(`DSH 包目录：${dshPackagesDir()}`);
console.log(`扫描包数：${packages.length}；抽到工具名候选：${sorted.length}\n`);

/**
 * ① 守卫名单里的名字必须真实存在，否则 restrict 抛错被吞、限制静默失效。
 *
 * ⚠️ 但**不能一律叫「假名」** —— 要分档，否则误判方向危害极大
 *    （会逼人把真名字从守卫名单里删掉，等于自己拆安全边界）：
 *
 *  a. `dev_*`：运行时注入器才会注册，源码里本来就没有字面量 ⇒ 预期的"尽力而为"，
 *     守卫的**执行期白名单**才是真边界。不算悬空。
 *  b. **可选组**（`subagent_codex` / `subagent_claude_code`）：0.2.1 起改成按需安装，
 *     默认安装里确实不存在；装上就该挡，所以保留在名单里。不算悬空。
 *  c. **已知来源、本机未装的插件**（`dsh_snapshot` / `dsh_rollback` /
 *     `incident_resolved` ← `dsh-plugin-guard`）：本机没装 ⇒ 现在 restrict 会抛错被吞
 *     （无害但没意义）；一旦装上那个插件，它们就会真的进全局层 —— 那时它们**必须**
 *     已经在名单里。所以处置是「保留 + 标注来源」，不是删。
 *     判据不是"扫不到就删"，而是"这个名字有没有**已知的真实来源**"。
 *  d. 真正的假名（无来源、也没装）才是要报的。
 */
const EXPECTED_RUNTIME_ONLY = new Map([
  // 0.2.1 起按需安装，默认安装里扫不到；装上就挡（见守卫注释）
  ['subagent_codex', '可选组'],
  ['subagent_claude_code', '可选组'],
  // 来自 dsh-plugin-guard（本机未装；历史上确有进过仿真会话 schema 的硬证据）
  ['dsh_snapshot', 'dsh-plugin-guard'],
  ['dsh_rollback', 'dsh-plugin-guard'],
  ['incident_resolved', 'dsh-plugin-guard'],
]);

const unverified = [...guarded]
  .filter((n) => TOOL_NAME_RE.test(n) && !n.startsWith('dev_') && !EXPECTED_RUNTIME_ONLY.has(n) && !names.has(n));
console.log('=== ① 守卫名单里、但本机安装包中找不到的名字 ===');
const byReason = new Map();
for (const n of guarded) {
  const r = EXPECTED_RUNTIME_ONLY.get(n);
  if (!r) continue;
  if (!byReason.has(r)) byReason.set(r, []);
  byReason.get(r).push(n);
}
for (const [reason, list] of byReason) {
  console.log(`  已知来源（本机未装 ⇒ 预期扫不到，保留）：[${reason}] ${list.join(', ')}`);
}
console.log(unverified.length
  ? unverified.map((n) => `  ⚠️ ${n}  ← 无已知来源、本机也没有 ⇒ 疑似假名，确认后从守卫名单删掉`).join('\n')
  : '  (无真正的假名)');

/** ② 安装包里有、守卫没覆盖的危险语义名字（可能是新版本新增的能力）。 */
const missing = sorted.filter((n) => DANGER_TOOL_RE.test(n) && !guarded.has(n) && !SAFE_MODEL_TOOLS.has(n));
console.log('\n=== ② 安装包里有、守卫名单里没有的「危险语义」名字（可能漏隐藏） ===');
console.log(missing.length ? missing.map((n) => `  ${n}  ← ${[...names.get(n)].join(', ')}`).join('\n') : '  (无)');

if (!onlyFlag) {
  console.log('\n=== ③ 全部候选名字（含来源包） ===');
  for (const n of sorted) {
    console.log(`  ${guarded.has(n) ? '[在名单]' : '[      ]'} ${n}  ← ${[...names.get(n)].join(', ')}`);
  }
}

console.log(`\n守卫名单 ${guarded.size} 个名字；本机对不上 ${unverified.length} 个；候选里未覆盖的危险名 ${missing.length} 个。`);
process.exitCode = (unverified.length === 0 && missing.length === 0) ? 0 : 1;

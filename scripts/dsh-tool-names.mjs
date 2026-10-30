// DSH 工具名抽取：**唯一实现**，供
//   · `scripts/scan-dsh-tool-names.mjs`（人工/升级时对账，打印清单）
//   · `scripts/test-preset-local-tools.mjs`（登记期断言，防拼错假名）
// 共同使用。
//
// 为什么要抽成模块：这两处过去各有一份实现，而测试那份是**模糊**的
// （`\bname:\s*['"]x['"]` 全文件乱扫 + 只认少数包名前缀 + 只读包根目录的
// cordis.patch.yml）。结果 0.2.0 对账时把 10 个**真实存在**的工具名误判成
// 「假名」——`dsh-mcp-resources` 与 `dsh-experimental-tool-agent-team` 不匹配它
// 的包名白名单，`subagent_codex` 写在 `dsh-web-app/presets/*.patch.yml` 而不是
// 包根。误判方向是危险的：它会逼人把真名字从守卫名单里删掉。
//
// 抽取规则（都要求**就近锚定**，不把 `systemPrompt.section({ name: 'tool:read' })`
// 这类非工具名当工具）：
//   ① `.register(defineTool({ … name: "X" … }))` —— DSH 所有工具包的注册形状
//   ② `toolName: "X"` / `toolName: z.string().default("X")` —— 配置化工具名
//      （dsh-tool-subagent 的 subagent / subagent_fork 就是这样声明的）
//   ③ YAML patch 里的 `toolName: X` 行（任意层级 *.patch.yml，含 presets/ 子目录）
import fs from 'node:fs';
import path from 'node:path';
import { dshModulesDir, isAsarPath, listDshDir, readDshFile } from './dsh-modules.mjs';

/** 名字形态：小写字母开头，允许下划线与连字符，长度合理。 */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_-]{1,40}$/;

/** DSH 自带包所在目录（`<node_modules>/@deepseek-ai`；Electron 下是 asar 伪目录）。 */
export function dshPackagesDir() {
  return process.env.DSH_TOOL_PACKAGES || path.join(dshModulesDir(), '@deepseek-ai');
}

/**
 * 用户安装的第三方插件目录（也会注册工具：plugin-guard / 超级注入器 / dsh-ops 等）。
 *
 * ⚠️ 必须扫**两个**位置，只扫 `$DSH_HOME/plugins` 会漏：
 *   ① `$DSH_HOME/plugins/` —— 本仓库自己的插件以 junction 挂在这里；
 *   ② `$DSH_HOME/profiles/<profile>/node_modules/` —— pnpm 实际安装第三方包的**真实**位置
 *       （`dsh-ops` / `billion-context` / `cc-safety-net` 都在这里，`plugins/` 下没有）。
 *    只扫 ① 的后果：`ops_read_files` 这种真实存在的全局工具被判成「假名」，
 *    而那种误判会逼人把真名字从守卫名单里删掉 —— 等于自己拆掉安全边界。
 */
export function dshPluginDirs() {
  const home = process.env.DSH_HOME
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.dsh') : null);
  if (!home) return [];
  const out = [];
  const legacy = path.join(home, 'plugins');
  if (fs.existsSync(legacy)) out.push(legacy);
  const profiles = path.join(home, 'profiles');
  let names = [];
  try {
    names = fs.readdirSync(profiles, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { /* profiles 目录不存在 */ }
  for (const p of names) {
    const nm = path.join(profiles, p, 'node_modules');
    if (fs.existsSync(nm)) out.push(nm);
  }
  return out;
}

function walkFiles(dir, out = [], depth = 0, maxDepth = 5) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < maxDepth) walkFiles(full, out, depth + 1, maxDepth); }
    else out.push(full);
  }
  return out;
}

/**
 * 从一个 JS/TS 源文件里抽取工具名。
 *
 * ⚠️ 第 5 条正则（`name: toolName` 形态）是为 Electron 桌面包补的：
 *    `dsh-tool-subagent` / `dsh-tool-workflow` 的工具名来自配置的
 *    `toolName: z.string().default("subagent")`，注册处写的是 `name: toolName`
 *    （变量，不是字面量）。少了这条，`subagent` / `workflow` / `ralph`
 *    会被当成"假名"，方向危险 —— 会逼人把真名字从守卫名单里删掉。
 *
 * ⚠️ 前缀拼装（`TOOL_PREFIX = 'ops_'` + `name: 'read_files'` ⇒ `ops_read_files`）
 *    在**同一个包里但不同文件**（`dsh-ops` 的常量在 `lib/policy.js`，名字在
 *    `lib/capabilities/*.js`），所以前缀扫描是**包级**的，见 {@link collectDshToolNames}。
 */
function extractFromSource(text, source, add) {
  for (const m of text.matchAll(/\.register\(\s*defineTool\(\{[\s\S]{0,400}?\bname:\s*["']([^"']+)["']/g)) {
    add(m[1], source);
  }
  for (const m of text.matchAll(/\btoolName:\s*["']([^"']+)["']/g)) add(m[1], source);
  for (const m of text.matchAll(/\btoolName:\s*[^;\n]*?\.default\(\s*["']([^"']+)["']/g)) add(m[1], source);
  // 独立的一次性工具文件（defineTool 不挂在 .register( 上时的兜底）
  for (const m of text.matchAll(/defineTool\(\{[\s\S]{0,200}?\bname:\s*["']([^"']+)["']/g)) {
    add(m[1], source);
  }
}

/** 包级前缀：`TOOL_PREFIX = 'ops_'` 这类常量的值。 */
function extractPrefixes(text) {
  return [...text.matchAll(/\bTOOL_PREFIX\s*=\s*["']([a-z][a-z0-9_]{0,20})["']/g)].map((m) => m[1]);
}

/**
 * 一个包里所有可能的「原始工具名」字面量，供前缀拼装使用。
 *
 * 按**权威来源**依次收集，不认"长得像名字的对象键"：
 *   ① `name:` / `rawName:` 字面量 —— 绝大多数工具包的直接注册形态；
 *   ② **工具顺序数组**：`const fileOrder = ['read_files', 'glob', ...]`
 *      （`dsh-ops` 的 `registry.js` 就是靠这个数组决定发布哪些能力，
 *      名字随后经 `publicToolName()` 拼上 `ops_`）。少了这一条，
 *      `ops_read_files` 会被判成假名 —— 而它**确实在全局层**。
 *
 * ⚠️ 教训：先前试过「对象键里带下划线的都当候选」，结果把 `job_id` / `read_only` /
 *    `write_roots` 这些**参数名**也当成工具名，凭空造出 16 个假候选。
 *    宁可按权威来源收得少一点，也不要制造假名。
 */
function extractLiteralNames(text) {
  const out = new Set();
  for (const m of text.matchAll(/\b(?:rawName|name):\s*["']([a-z][a-z0-9_-]{1,40})["']/g)) out.add(m[1]);
  // 工具顺序数组：`const fileOrder = [ 'a', 'b' ]` / `TOOL_ORDER = [...]`
  for (const m of text.matchAll(/\b(?:const|let)\s+[A-Za-z_$][\w$]*[Oo]rder\s*=\s*\[([^\]]{0,2000})\]/g)) {
    for (const s of m[1].matchAll(/["']([a-z][a-z0-9_-]{1,40})["']/g)) out.add(s[1]);
  }
  return [...out];
}

/** 从 YAML patch 里抽取配置化的工具名。 */
function extractFromPatch(text, source, add) {
  for (const m of text.matchAll(/^\s*(?:-\s*)?toolName:\s*([^\s#]+)\s*$/gm)) {
    add(m[1].replace(/^['"]|['"]$/g, ''), source);
  }
}

/**
 * 抽取已安装 DSH（及其插件）里出现的全部工具名。
 *
 * @param options.packagesDir - `@deepseek-ai` 目录；缺省按 {@link dshPackagesDir} 解析。
 * @param options.pluginDirs - 第三方插件目录列表；缺省按 {@link dshPluginDirs} 解析。
 * @returns `{ names: Map<name, Set<source>>, packages: string[] }`。
 *          `packages` 是实际扫过的包/插件名，便于诊断「一个都没扫到」。
 */
export function collectDshToolNames({ packagesDir, pluginDirs } = {}) {
  const names = new Map();
  const packages = [];
  const add = (name, source) => {
    if (!TOOL_NAME_RE.test(name)) return;
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(source);
  };

  const roots = [];
  const pkgRoot = packagesDir ?? dshPackagesDir();
  if (isAsarPath(pkgRoot)) {
    // Electron 桌面包：包全在 app.asar 里，走 asar 分支（磁盘上没有同名目录）。
    roots.push({ dir: pkgRoot, filter: /^dsh-/, asar: true });
  } else if (fs.existsSync(pkgRoot)) {
    roots.push({ dir: pkgRoot, filter: /^dsh-/ });
  }
  for (const dir of pluginDirs ?? dshPluginDirs()) {
    // 用户的插件目录里全是插件包（含 .bak-* 备份，也一起扫：备份里的旧名字
    // 仍然说明这个名字曾经真实存在）。
    roots.push({ dir, filter: null });
  }

  for (const { dir, filter, asar } of roots) {
    if (asar) {
      // Electron 桌面包：`dir` 形如 `<asar>/node_modules/@deepseek-ai`。
      // 先用 asarListPackages 列出包名，再逐个包用 listDshDir / readDshFile 读文件
      // （两者都来自 dsh-modules，磁盘与 asar 通用）。
      for (const pkg of asarListPackages(dir)) {
        if (filter && !filter.test(pkg)) continue;
        packages.push(pkg);
        const texts = [];
        for (const f of listDshDir(dir, pkg)) {
          let text = '';
          try { text = readDshFile(dir, `${pkg}/${f}`); } catch { continue; }
          if (/\.(js|mjs|cjs)$/.test(f) || f.endsWith('.d.ts')) { texts.push(text); extractFromSource(text, pkg, add); }
          else if (/\.patch\.ya?ml$/.test(f)) extractFromPatch(text, pkg, add);
        }
        addPrefixedNames(texts, pkg, add);
      }
      continue;
    }
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (filter && !filter.test(e.name)) continue;
      const pkgDir = path.join(dir, e.name);
      packages.push(e.name);
      const texts = [];
      for (const f of walkFiles(pkgDir)) {
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        if (/\.(js|mjs|cjs)$/.test(f) || f.endsWith('.d.ts')) { texts.push(text); extractFromSource(text, e.name, add); }
        else if (/\.patch\.ya?ml$/.test(f)) extractFromPatch(text, e.name, add);
      }
      addPrefixedNames(texts, e.name, add);
    }
  }
  return { names, packages };
}

/**
 * 包级前缀拼装：把一个包内**任一**文件里声明的 `TOOL_PREFIX` 常量，
 * 应用到**同一个包内所有**文件的 `name: 'literal'`。
 *
 * 为什么必须包级：`dsh-ops` 把 `TOOL_PREFIX = 'ops_'` 写在 `lib/policy.js`，
 * 而真正注册工具的地方在 `lib/capabilities/*.js`（写的是 `read_files` / `glob`）。
 * 按文件配对的话一个也拼不出来（实测：`ops_` 名字 0 个），
 * 于是 `ops_read_files` 这种确凿存在的全局工具被误判成「假名」。
 */
function addPrefixedNames(texts, source, add) {
  const prefixes = new Set();
  for (const t of texts) for (const p of extractPrefixes(t)) prefixes.add(p);
  if (prefixes.size === 0) return;
  for (const t of texts) {
    for (const name of extractLiteralNames(t)) {
      for (const pre of prefixes) {
        if (name.startsWith(pre)) continue;   // 已经带前缀的别叠两层
        add(pre + name, source);
      }
    }
  }
}

/**
 * 列出 asar 伪目录（`<asar>/<inner>`）下的**第一层子目录名**（= 包名）。
 * 与 {@link listDshDir} 互补：那个返回文件、这个返回目录。
 */
function asarListPackages(dir) {
  const files = listDshDir(dir, '');
  const pkgs = new Set();
  for (const f of files) {
    const first = f.split('/')[0];
    if (first) pkgs.add(first);
  }
  return [...pkgs].sort();
}

/** 便利包装：只要名字集合。 */
export function dshToolNameSet(options) {
  return new Set(collectDshToolNames(options).names.keys());
}

/**
 * 「危险语义」判定：与本地执行 / 文件 / 进程 / 派生 agent / 宿主运行期相关的名字。
 * 守卫**必须**覆盖它们。纯模型侧无害工具由 {@link SAFE_MODEL_TOOLS} 显式排除。
 *
 * 这是**发现用**的启发式（宁可多报，人工再判），不是安全边界本身；
 * 边界是守卫的 restrict 名单 + 执行期白名单。
 */
export const DANGER_TOOL_RE = /(pwsh|bash|shell|exec|spawn|process|terminal|pty|read|write|edit|file|fs_|glob|grep|patch|str_replace|subagent|agent_|teammate|workflow|ralph|job|skill|present|goal|plan|todo|memory|snapshot|rollback|incident|plugin|cordis|dsh_|dev_|import|install|reload|inject|stage|config|workspace|session|export|office|slash|command|schedule|voice|speech|team|mcp_resource)/;

/** 明确无害、允许出现在仿真会话 schema 里的模型侧工具。 */
export const SAFE_MODEL_TOOLS = new Set(['ask_user_question', 'todo_write']);

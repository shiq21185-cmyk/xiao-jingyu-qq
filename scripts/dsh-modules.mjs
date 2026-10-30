// 定位「DSH 安装目录下的 node_modules」—— 供仓库脚本加载 DSH 自身的模块做校验。
//
// 解析顺序：
//   1. 环境变量 DSH_INSTALL_MODULES / DSH_MODULES（应指向 <DSH>/node_modules）
//   2. 从 $DSH_HOME/profiles/<profile>/package.json 用 Node 模块解析反查真实安装位置
//      （profile 依次尝试 DSH_PROFILE、web、default，再兜底扫 profiles 下的其它目录）
//   3. **Electron 桌面包**：DSH 的 `@deepseek-ai/*` 全打在 `<DSH>/resources/app.asar`
//      里，磁盘上没有对应的 node_modules 目录 —— 这时返回 asar 的**伪目录**，
//      由同文件的 asar 读取函数按「包内路径」取文件（见 {@link dshFile}）。
// 全部失败时抛出带指引的错误，不做任何写死路径的回退 —— 宁可显式报错，也不要静默用错版本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

// 这些脚本需要加载的包，任意一个能解析成功即可反推出 node_modules 位置。
const PROBE_SPECIFIERS = ['@deepseek-ai/dsh-persona', 'js-yaml'];

function findNodeModules(resolvedFile) {
  let dir = path.dirname(resolvedFile);
  for (;;) {
    if (path.basename(dir) === 'node_modules') return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function candidateProfiles(home) {
  const names = [];
  const add = (n) => { if (n && !names.includes(n)) names.push(n); };
  add(process.env.DSH_PROFILE);
  add('web');
  add('default');
  try {
    for (const e of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
      if (e.isDirectory()) add(e.name);
    }
  } catch { /* profiles 目录不存在时忽略 */ }
  return names;
}

export function dshModulesDir() {
  const override = process.env.DSH_INSTALL_MODULES || process.env.DSH_MODULES;
  if (override) return override;

  const home = dshHome();
  for (const profile of candidateProfiles(home)) {
    const anchor = path.join(home, 'profiles', profile, 'package.json');
    if (!fs.existsSync(anchor)) continue;
    const req = createRequire(anchor);
    for (const spec of PROBE_SPECIFIERS) {
      try {
        const dir = findNodeModules(req.resolve(spec));
        // ⚠️ 必须验证**目标包真的在**，不能只看「解析成功」。
        //    Electron 桌面版下 `@deepseek-ai/dsh-persona` 会**错误地**解析到
        //    `~/.dsh/profiles/<p>/node_modules/@deepseek-ai/`——那个目录确实存在
        //    （里面有 schemastery / cosmokit 等被提升的依赖），但没有 dsh-persona。
        //    旧实现只看 findNodeModules 的返回值就收工，于是把「找不到」当成「找到了」，
        //    后续 readFileSync 才炸 ENOENT —— 报错点离真正原因很远。
        if (dir && fs.existsSync(path.join(dir, '@deepseek-ai', 'dsh-persona', 'package.json'))) return dir;
      } catch { /* 换下一个 specifier，再换下一个 profile */ }
    }
  }

  // ── Electron 桌面包：包全在 app.asar 里 ──────────────────────────────────
  // 桌面版把 `@deepseek-ai/*` 打进 `<安装目录>/resources/app.asar`，磁盘上
  // **没有**可解析的 node_modules 目录（profile 的 node_modules 里只有用户插件）。
  // 这里返回一个 asar **伪目录**（路径里带 `.asar/`），交给 {@link isAsarPath} /
  // {@link dshFile} 按包内路径取文件。找不到就继续往下抛错，不硬编某台机器的盘符。
  for (const asar of candidateAsars(home)) return `${asar}/node_modules`;

  throw new Error(
    '无法定位 DSH 安装目录下的 node_modules。\n'
    + '  请设置 DSH_INSTALL_MODULES=<DSH 安装目录>/node_modules 后重试；\n'
    + '  或设置 DSH_INSTALL_ASAR=<DSH 安装目录>/resources/app.asar（Electron 桌面包）；\n'
    + `  或设置 DSH_HOME 指向 DSH 根目录（当前解析为 ${home}）。`
  );
}

// ── Electron asar 支持 ────────────────────────────────────────────────────────
//
// 为什么需要：DSH 桌面版把 `@deepseek-ai/*` 打进 `resources/app.asar`，磁盘上
// 没有可解析的 `node_modules/@deepseek-ai/dsh-persona`。旧实现只认磁盘目录，
// 于是**所有对账脚本**在这类安装上全废：
//   · `verify:adaptation` / `verify-persona-config` 直接 `ERR_MODULE_NOT_FOUND`；
//   · `scan-dsh-tool-names.mjs` 扫到 0 个工具名 ⇒ 把 46 个**真实存在**的名字报成
//     「假名」，方向危险（会逼人把真名字从守卫名单里删掉）。
//
// asar 格式（Chromium pickle，小端）：
//   [0..3]   uint32 = 4（本块长度前缀的固定值）
//   [4..7]   uint32 = header pickle 总长
//   [8..11]  uint32 = header pickle 载荷长
//   [12..15] uint32 = JSON 长
//   [16..]   JSON（文件树；每个 file 节点带 size 与 offset，offset **不含** 16+jsonLen+4 的对齐）
//   末尾 4 字节对齐补 0，然后才是文件数据区。

const ASAR_ALIGN = 4;

/** 从某个目录往上找 `<dir>/resources/app.asar`（Electron 的标准布局）。 */
function findAsarFrom(dir) {
  let cur = path.resolve(dir);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(cur, 'resources', 'app.asar');
    if (fs.existsSync(candidate)) return candidate;
    const asarDirect = path.join(cur, 'app.asar');
    if (fs.existsSync(asarDirect)) return asarDirect;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

/**
 * 候选 asar 列表：环境变量 → DSH 自己的日志 → 常见安装位置。
 * 不硬编任何盘符；找不到返回空数组，由调用方决定怎么报错。
 */
export function candidateAsars(home = dshHome()) {
  const env = process.env.DSH_INSTALL_ASAR;
  if (env && fs.existsSync(env)) return [path.resolve(env)];
  const found = [];
  const push = (p) => {
    if (!p) return;
    const norm = path.resolve(p);
    if (fs.existsSync(norm) && !found.includes(norm)) found.push(norm);
  };

  // ① DSH 自己的日志：stack trace 里写的是**真实**安装位置
  //    （形如 `file:///D:/DSH/DSH%20NEXT/resources/app.asar/node_modules/...`）。
  //    这是最可靠的自动发现 —— 比猜盘符稳，而且天然随安装位置变化。
  for (const p of asarsFromDshLogs(home)) push(p);

  // ② 常规布局兜底：从 exe 所在目录 / DSH_HOME 往上找 resources/app.asar
  for (const seed of [
    process.env.DSH_INSTALL_DIR,
    process.execPath ? path.dirname(process.execPath) : null,
    home,
  ].filter(Boolean)) {
    push(findAsarFrom(seed));
  }
  return found;
}

/**
 * 从 `$DSH_HOME/logs/*.jsonl` 里抽 `resources/app.asar` 的绝对路径。
 *
 * 为什么读日志：Electron 桌面包把路径写进异常 stack，
 * 形如 `file:///D:/DSH/DSH%20NEXT/resources/app.asar/node_modules/@deepseek-ai/...`。
 *
 * ⚠️ 实现上**不用正则**：日志是几 MB 的单行 JSON，`[^\s]*?…` 这类表达式在长文本上
 *    会回溯爆炸（实测直接把脚本挂死 >120s）。改成 `indexOf` 逐段切开的前缀扫描 ——
 *    线性、无回溯、可预期。
 */
function asarsFromDshLogs(home, { maxFiles = 3, maxBytes = 8 * 1024 * 1024 } = {}) {
  const dir = path.join(home, 'logs');
  let entries = [];
  try {
    entries = fs.readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, maxFiles);
  } catch { return []; }

  const MARK = 'resources/app.asar';
  const MARK_ALT = 'resources\\app.asar';
  const out = [];
  for (const { n } of entries) {
    let text = '';
    try {
      const fd = fs.openSync(path.join(dir, n), 'r');
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const len = size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch { continue; }

    for (const mark of [MARK, MARK_ALT]) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(mark, from);
        if (at === -1) break;
        from = at + mark.length;
        // 往回找这个路径的起点：最近的 `file:///` 或空白的下一个字符
        let start = at;
        while (start > 0) {
          const ch = text[start - 1];
          if (ch === '"' || ch === "'" || ch === ' ' || ch === '(' || ch === '\n') break;
          start -= 1;
        }
        let raw = text.slice(start, at + mark.length);
        // 去掉 `file:///` 前缀（Electron stack 里的形式）
        raw = raw.replace(/^file:\/\/\/?/, '');
        // 必须像个盘符路径才收
        if (!/^[A-Za-z]:[\\/]/.test(raw)) continue;
        const decoded = (() => {
          try { return decodeURIComponent(raw); } catch { return raw; }
        })();
        const norm = decoded.replace(/\//g, path.sep);
        if (fs.existsSync(norm) && !out.includes(norm)) out.push(norm);
      }
    }
  }
  return out;
}

/** `dshModulesDir()` 返回的是否为 asar 伪目录。 */
export function isAsarPath(p) {
  return typeof p === 'string' && p.includes('.asar');
}

/** 拆出 `<asar 文件路径>` 与 `<asar 内的 posix 路径>`。 */
function splitAsarPath(p) {
  const norm = String(p).replace(/\\/g, '/');
  const idx = norm.indexOf('.asar/');
  if (idx === -1) return null;
  return { asar: norm.slice(0, idx + 5), inner: norm.slice(idx + 6) };
}

const asarCache = new Map();

/**
 * 读 asar 的**头部**（文件树），不缓存数据区。
 *
 * ⚠️ 为什么不能把整个 asar 读进内存：本机 `app.asar` 有 **180 MB**，
 *    缓存整个 buffer 后，抽取 700+ 个文件时的临时 buffer 峰值会直接把进程压崩
 *    （症状是**静默退出**——连 exit 钩子都不跑，看起来像"什么都没发生"）。
 *    所以这里只缓存 JSON 文件树（几 MB），文件内容按 offset 单独读盘。
 */
function loadAsarHeader(asarPath) {
  if (asarCache.has(asarPath)) return asarCache.get(asarPath);
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const jsonSize = head.readUInt32LE(12);
    const headerPickleLen = head.readUInt32LE(4);
    const jsonBuf = Buffer.alloc(jsonSize);
    fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
    const json = JSON.parse(jsonBuf.toString('utf8'));
    const dataStart = Math.ceil((8 + headerPickleLen) / ASAR_ALIGN) * ASAR_ALIGN;
    const entry = { json, dataStart, path: asarPath };
    asarCache.set(asarPath, entry);
    return entry;
  } finally {
    fs.closeSync(fd);
  }
}

/** 按 asar 内路径拿 node（目录或文件）；不存在返回 null。 */
function asarNode(asarPath, inner) {
  const { json } = loadAsarHeader(asarPath);
  let node = json;
  for (const seg of inner.split('/').filter(Boolean)) {
    if (!node.files || !Object.hasOwn(node.files, seg)) return null;
    node = node.files[seg];
  }
  return node;
}

/** 把 `<asar>/<inner>` 路径读成文本（按 offset 单次读盘，不整包加载）。 */
export function readAsarText(asarPath, inner) {
  const node = asarNode(asarPath, inner);
  if (!node || node.files) throw new Error(`asar 里没有这个文件：${inner}`);
  // ⚠️ asar 里的**空文件**（size 0）常常没有 offset 字段，直接 Number(undefined) 会是 NaN，
  //    readSync(position=NaN) 抛 ERR_OUT_OF_RANGE。空文件直接返回空串。
  const size = Number(node.size ?? 0);
  if (!Number.isFinite(size) || size === 0) return '';
  const offset = Number(node.offset);
  if (!Number.isFinite(offset)) return '';
  const { dataStart } = loadAsarHeader(asarPath);
  const position = dataStart + offset;
  if (!Number.isFinite(position)) return '';
  const buf = Buffer.alloc(size);
  const fd = fs.openSync(asarPath, 'r');
  try {
    fs.readSync(fd, buf, 0, size, position);
  } finally {
    fs.closeSync(fd);
  }
  return buf.toString('utf8');
}

/**
 * 读 DSH 模块目录里的一个文件（**磁盘与 asar 两种布局都支持**）。
 * @param modulesDir `dshModulesDir()` 的返回值
 * @param rel        相对 modulesDir 的 posix 路径，如 `@deepseek-ai/dsh-persona/lib/index.js`
 */
export function readDshFile(modulesDir, rel) {
  if (isAsarPath(modulesDir)) {
    const split = splitAsarPath(path.join(modulesDir, rel));
    if (!split) throw new Error(`无法解析 asar 路径：${modulesDir} + ${rel}`);
    return readAsarText(split.asar, split.inner);
  }
  return fs.readFileSync(path.join(modulesDir, rel), 'utf8');
}

/** 列出 modulesDir 下某个包目录里的全部相对路径（磁盘 / asar 通用）。 */
export function listDshDir(modulesDir, rel) {
  const dir = path.join(modulesDir, rel);
  if (isAsarPath(modulesDir)) {
    const split = splitAsarPath(dir);
    if (!split) return [];
    const node = asarNode(split.asar, split.inner);
    if (!node || !node.files) return [];
    const out = [];
    const walk = (n, prefix) => {
      for (const k in n.files) {
        const c = n.files[k];
        if (c.files) walk(c, `${prefix}${k}/`);
        else out.push(`${prefix}${k}`);
      }
    };
    walk(node, '');
    return out;
  }
  const out = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(...listDshDir(modulesDir, `${rel}/${e.name}`));
      else out.push(e.name);
    }
  } catch { /* 目录不存在 */ }
  return out;
}

// ── 从 asar 里“加载模块” ─────────────────────────────────────────────────────
//
// 为什么不能直接 `import('file:///…/app.asar/…js')`：Node 的 ESM loader 不认识 asar
// 这个容器格式（只有 Electron 打了补丁的 loader 认识），会直接 ERR_MODULE_NOT_FOUND。
// 而当 `require()` 却常常**能**成功 —— 因为 asar 里的文件在 Node 看来是一个巨大的
// 扁平 buffer，`fs` 系 API 拿不到它，但 Electron 的 `fs` 补丁才认得；
// 纯 Node 下两条路都不通。所以这里采取**唯一可靠**的做法：
//   把目标文件（以及它 import 的 DSH 包文件）抽到临时目录，再按真实路径 import。
// 只抽**用得到的包**（persona / system-prompt / schemastery / js-yaml 等），
// 不整包展开 180MB 的 asar。

/**
 * 抽取时要**跳过**的依赖：带 `.node` 原生二进制的包。
 *
 * ⚠️ 为什么：`@deepseek-ai/*` 的包把 `node-addon-require-builtin` 之类放进
 *    `peerDependencies`（用来加载原生 addon）。把它们抽出来并 import 时，
 *    原生模块的加载会让**整个 Node 进程硬崩**（症状极隐蔽：没有异常、没有 stack、
 *    连 `process.on('exit')` 都不触发，调用方只看到"什么都没发生"）。
 *    而这两个包对本用途（拿 `dsh-persona` 的 zod schema 做校验）**完全不需要** ——
 *    它们只在 Electron 里真正被用到。
 *    判据用**包名**（`node-addon-*` / `*-native`），不靠扫文件，
 *    因为依赖闭包里可能还没抽到就崩了。
 */
const SKIP_NATIVE_PACKAGES = /^node-addon-|^@?(?:.*-native(?:-|$))|(?:^|\/)native-|-(?:win32|linux|darwin)-(?:x64|arm64)$/;

/** 这个依赖名要不要跳过（原生 / 平台专用包）。 */
function shouldSkipDependency(name) {
  return SKIP_NATIVE_PACKAGES.test(name);
}

/** 抽到临时目录的产物（脚本退出时由 {@link cleanupAsarTemp} 清掉）。 */
const tmpRoots = [];

/**
 * 把 asar 里的一个包（含它在 `node_modules` 里的依赖）抽到临时目录。
 *
 * @param modulesDir `dshModulesDir()` 的返回值（asar 伪目录）
 * @param pkgRel     相对 `node_modules` 的包路径，如 `@deepseek-ai/dsh-persona`
 * @returns 抽出来的真实目录
 */
export function materializeAsarPackage(modulesDir, pkgRel) {
  if (!isAsarPath(modulesDir)) return path.join(modulesDir, pkgRel);
  const split = splitAsarPath(path.join(modulesDir, pkgRel));
  if (!split) throw new Error(`无法解析 asar 包路径：${modulesDir} + ${pkgRel}`);
  // 统一成 posix 路径：asar 内的目录名一律用 `/` 分隔（Windows 上 path.join 会给 `\`，
  // 而 splitAsarPath / asarNode 都按 `/` 切段）。
  const { asar, inner } = split;
  void inner;
  const nodeModulesInAsar = `${asar}/node_modules`;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-asar-'));
  tmpRoots.push(root);
  const nodeModulesRoot = path.join(root, 'node_modules');

  const copied = new Set();
  const copyPackage = (rel) => {
    if (copied.has(rel)) return;
    copied.add(rel);
    const dest = path.join(nodeModulesRoot, rel);
    for (const f of listDshDir(nodeModulesInAsar, rel)) {
      const out = path.join(dest, f);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, readDshFile(nodeModulesInAsar, `${rel}/${f}`));
    }
  };

  // 递归抽依赖：读 package.json 的 dependencies / peerDependencies / 可选依赖。
  //
  // ⚠️ `queued` 必须**独立于 `copied`**，并且要在**入队时**就去重：
  //    `copied` 是在出队后（copyPackage 里）才标记的，一个包如果被多个依赖方
  //    重复引用（依赖图有环时几乎必然），它会被反复推回队列 —— 每轮都要对
  //    180MB 的 asar 重走一次 listDshDir（那是遍历整棵子树，不是 O(1)），
  //    于是表现为**进程挂死**（不是崩溃、没有异常，就是永远跑不完）。
  const queued = new Set([pkgRel]);
  const queue = [pkgRel];
  while (queue.length > 0) {
    const rel = queue.shift();
    let pkgJson;
    try {
      pkgJson = JSON.parse(readDshFile(nodeModulesInAsar, `${rel}/package.json`));
    } catch { continue; }
    copyPackage(rel);
    const deps = {
      ...(pkgJson.dependencies ?? {}),
      ...(pkgJson.peerDependencies ?? {}),
      ...(pkgJson.optionalDependencies ?? {}),
    };
    for (const dep of Object.keys(deps)) {
      // 原生 / 平台专用包一律跳过：抽出来再 import 会把进程硬崩（见上方注释）。
      if (shouldSkipDependency(dep)) continue;
      if (queued.has(dep)) continue;          // 已排过队：不要重复入队（防环 + 防重扫）
      if (listDshDir(nodeModulesInAsar, dep).length === 0) continue;
      queued.add(dep);
      queue.push(dep);
    }
  }
  return path.join(nodeModulesRoot, pkgRel);
}

/**
 * 带 asar 支持的动态 import：磁盘布局直接 import；
 * asar 布局先把包抽到临时目录再 import。
 *
 * @param modulesDir `dshModulesDir()` 的返回值
 * @param rel        相对 modulesDir 的模块文件路径（如 `@deepseek-ai/dsh-persona/lib/index.js`）
 */
export async function importFromDsh(modulesDir, rel) {
  if (!isAsarPath(modulesDir)) {
    return import(pathToFileURL(path.join(modulesDir, rel)).href);
  }
  const pkgRel = rel.split('/').slice(0, rel.startsWith('@') ? 2 : 1).join('/');
  const real = materializeAsarPackage(modulesDir, pkgRel);
  const rest = rel.slice(pkgRel.length + 1);
  return import(pathToFileURL(path.join(real, rest)).href);
}
export function cleanupAsarTemp() {
  for (const root of tmpRoots.splice(0)) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

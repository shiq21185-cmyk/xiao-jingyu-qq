// 专项控制台的隔离性测试 —— 只验证"它不依赖那些会被更新覆盖的东西"。
//
// 为什么这个测试比"能不能点开页面"重要得多：
//   主人要这个独立控制台的**唯一理由**就是"插件更新时别把我的东西弄没"。
//   如果本控制台悄悄 import 了 bridge.js 里的模块、或调了这次新加的端点，
//   那么一次上游更新就会同时打断它 —— 那正是要避免的失败模式。
//   所以这里用静态扫描把它钉死：它只许 import node 内置、只许调白名单里的老端点。
//
// 跑：node scripts/test-extra-console.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'tools', 'extra-console');
const SERVER = path.join(DIR, 'server.mjs');
const PAGE = path.join(DIR, 'index.html');

assert.ok(fs.existsSync(SERVER), '缺少 tools/extra-console/server.mjs');
assert.ok(fs.existsSync(PAGE), '缺少 tools/extra-console/index.html');
const serverSrc = fs.readFileSync(SERVER, 'utf8');
const pageSrc = fs.readFileSync(PAGE, 'utf8');

// ── 1. 只 import node 内置模块 + **同目录内**的文件 ───────────────────────
//
// 这条约束的本意是：**不许依赖会被插件更新覆盖的东西**（src/、plugins/、public/…）。
// 而 3101 自己目录下的文件（./tool-groups.mjs）是跟着它一起走的，
// 更新不会单独替换它们 —— 那种 import 是允许的，也是必要的。
{
  const imports = [...serverSrc.matchAll(/^import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0, '没找到任何 import');
  for (const spec of imports) {
    const isNodeBuiltin = spec.startsWith('node:');
    // 同目录（./ 或 ../ 但仍在 tools/extra-console 里）
    const isSameDir = /^\.\.?\//.test(spec) && !spec.includes('tools/extra-console/../..');
    assert.ok(isNodeBuiltin || isSameDir,
      `禁止 import 仓库内模块或第三方包：${spec}（只许 node: 内置与 3101 自己目录下的文件）`);
    if (isSameDir) {
      // 同目录 import 必须真实存在，且**不许指到仓库的 src/ 或 plugins/**
      const target = path.resolve(DIR, spec);
      assert.ok(fs.existsSync(target), `同目录 import 的文件不存在：${spec}`);
      assert.ok(target.startsWith(DIR), `同目录 import 不许跑到 3101 目录之外：${spec}`);
    }
  }
  console.log('✔ 只依赖 node 内置 + 3101 自己目录的文件（更新不会打断它）');
}

// ── 2. 不引用 console.html，也不被它引用 ───────────────────────────────────
{
  // 只看**真正的依赖形式**：href / src / fetch / import / readFile。
  // 说明文字里提到"与 public/console.html 无关"是给人看的，不是依赖 ——
  // 用 includes() 一刀切会把解释也判成违规，那种测试只会逼人删掉注释。
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const REF = /(?:href|src|action)\s*=\s*["'][^"']*console\.html|fetch\(\s*[`'"][^`'"]*console\.html|readFileSync\([^)]*console\.html|import[^;]*console\.html/i;

  assert.ok(!REF.test(stripComments(serverSrc)), 'server.mjs 不该以任何形式加载 public/console.html');
  assert.ok(!REF.test(stripComments(pageSrc)), '页面不该以任何形式加载主控制台');
  // 反向：主控制台不该知道这个页面的存在（否则更新时容易一起被改）
  const mainConsole = path.join(ROOT, 'public', 'console.html');
  if (fs.existsSync(mainConsole)) {
    const mainSrc = fs.readFileSync(mainConsole, 'utf8');
    // 与上面同样的道理：主控制台里有三处**说明文字**提到 tools/extra-console
    // （告诉看的人"那个面板跑在 3101 的独立进程里"、"为什么用 iframe"），
    // 那不是依赖。用 includes() 一刀切会把它判成违规，只能靠删注释变绿 ——
    // 所以这里也先剥注释，再匹配真正的依赖形式。
    assert.ok(!REF.test(stripComments(mainSrc)), '主控制台不该引用专项控制台目录');
  }
  console.log('✔ 与主控制台双向解耦');
}

// ── 3. 只调用桥接**原版就有**的端点 ────────────────────────────────────────
//
// 白名单的依据：这些端点在 2026-10-19 本次改动之前的 bridge.js 里就已经存在
//（已用 _backup-proactive-* 备份逐个核对）。新增的 /api/socialV2/grant-permit 等
// **不在**白名单里 —— 本控制台刻意不用它们，全部自己落盘。
{
  const ALLOWED = new Set([
    '/api/socialV2/config',
    '/api/socialV2/states',
    '/api/socialV2/state',
    '/api/socialV2/wake',
    '/api/test-send'
  ]);
  const called = [...serverSrc.matchAll(/bridgeApi\(\s*[`'"]([^`'"]+)[`'"]/g)].map((m) => m[1]);
  assert.ok(called.length > 0, '没找到任何对桥接的调用');
  for (const p of called) {
    assert.ok(ALLOWED.has(p), `调用了不在白名单里的桥接端点：${p}（它可能是本次新增的，更新后会消失）`);
  }
  // 反向确认：确实没有用本次新增的端点
  for (const forbidden of ['/api/socialV2/grant-permit', '/api/socialV2/promise', '/api/socialV2/promise-done', '/api/socialV2/revoke-permit', '/api/socialV2/permits', '/api/socialV2/request-permission']) {
    assert.ok(!serverSrc.includes(forbidden), `不该依赖本次新增的端点：${forbidden}`);
  }
  console.log(`✔ 只调用 ${called.length} 个原版就有的桥接端点`);
}

// ── 3b. 逐个核对：这些端点在 bridge.js 里真的存在 ─────────────────────────
//
// 上面那张白名单是"我以为原版就有"，这里去 bridge.js 里**实际找一遍**。
// 为什么值得多花这一步：白名单写错一个名字（比如 /api/socialV2/state 写成
// /api/socialV2/states），控制台会在某个具体操作上静默 404 —— 而那种错误
// 只有真点到那一步才暴露。静态对账能在提交前就发现。
{
  const bridgePath = path.join(ROOT, 'src', 'bridge.js');
  if (fs.existsSync(bridgePath)) {
    const bridgeSrc = fs.readFileSync(bridgePath, 'utf8');
    const CALLED = ['/api/socialV2/config', '/api/socialV2/states', '/api/socialV2/state', '/api/socialV2/wake', '/api/test-send'];
    for (const ep of CALLED) {
      const needle = `url.pathname === '${ep}'`;
      assert.ok(bridgeSrc.includes(needle), `bridge.js 里找不到 ${ep}（专项控制台会拿到 404）`);
    }
    console.log(`✔ ${CALLED.length} 个端点都在 bridge.js 里实际存在`);
  }
}

// ── 4. 自己的数据落在 state/（gitignore 里，永不被更新碰）──────────────────
{
  assert.ok(serverSrc.includes("'state'"), '应当把数据写进 state/');
  assert.ok(serverSrc.includes('extra-promises.json'), '约定应当写进 state/extra-promises.json');
  assert.ok(serverSrc.includes('permits.json'), '授权应当写进 state/permits.json（与守卫共用）');

  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.ok(/^state\/$/m.test(gitignore) || /^state\/\s*$/m.test(gitignore),
    '.gitignore 必须忽略 state/（否则更新会碰你的数据）');
  console.log('✔ 数据落在 state/（gitignore 保护）');
}

// ── 5. 页面里没有任何外部资源（离线可用、不泄漏）───────────────────────────
{
  // 允许出现的只有本机地址；不允许 CDN / 外链脚本 / 外链样式
  assert.ok(!/<script[^>]+src=/i.test(pageSrc), '页面不该加载外部脚本');
  assert.ok(!/<link[^>]+href=["']https?:/i.test(pageSrc), '页面不该加载外部样式');
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(pageSrc.replace(/https?:\/\/127\.0\.0\.1[^\s"'`<]*/g, '')),
    '页面里不该出现外部 URL（除 127.0.0.1）');
  console.log('✔ 页面纯离线，无外部资源');
}

// ── 6. 令牌：运行时注入页面（主人要求"别让我每次手填"）──────────────────
//
// ⭐ 2026-10-19 主人要求：「把令牌自动填进控制台，不要让我每次都做」。
//    现在是服务端在返回页面时把令牌注进去。这不降低安全性：
//      · 本进程只监听 127.0.0.1 且校验 Host 头，能读到页面的只有本机浏览器；
//      · 能读 state/console-token 的人本来就有本机文件权限 —— 注入不增加暴露面；
//      · 令牌**只**在运行时注入，绝不写进 index.html 本身（那会进 git、换机器就废）。
{
  assert.ok(serverSrc.includes("'x-console-token': token"), '后端应当代签控制台令牌');
  assert.ok(serverSrc.includes('__EXTRA_TOKEN__'), '服务端应当把令牌注入页面');
  assert.ok(pageSrc.includes('EXTRA_CONSOLE_BOOTSTRAP'), '页面里应当有注入占位符');
  assert.ok(pageSrc.includes('window.__EXTRA_TOKEN__'), '前端应当优先使用注入的令牌');
  // 🔴 令牌绝不能被写死进静态文件
  assert.ok(!/[a-f0-9]{40,}/.test(pageSrc), 'index.html 里不该出现长十六进制串（疑似写死令牌）');
  assert.ok(!/[a-f0-9]{40,}/.test(serverSrc), 'server.mjs 里不该写死令牌');
  console.log('✔ 令牌运行时注入（不落静态文件、不进 git）');
}

// ── 7. 关键防护：读放行、写要令牌 ──────────────────────────────────────────
{
  assert.ok(serverSrc.includes("url.pathname === '/api/overview'"), '应当有 overview 读接口');
  assert.ok(/if \(!tokenOk\)[\s\S]{0,120}401/.test(serverSrc), '写接口必须有令牌校验并返回 401');
  assert.ok(serverSrc.includes('timingSafeEqual'), '令牌比较应当用定长比较');
  console.log('✔ 读放行 / 写要令牌 / 定长比较');
}

// ── 8. 权限收口：只签给 owner 私聊 ────────────────────────────────────────
{
  assert.ok(/private:\$\{String\(readJsonSafe[^)]*ownerQQ/.test(serverSrc)
    || serverSrc.includes('ownerQQ'),
    '签发授权必须绑定 config.json 的 ownerQQ');
  // 不允许页面传任意 key 让后端签发
  assert.ok(!/body\?\.key[\s\S]{0,80}grants\[/.test(serverSrc),
    '批准接口不该接受调用方指定的 key');
  console.log('✔ 授权只签给 owner 私聊');
}

// ── 9. 通知只发私聊（不能因为选错会话就在群里播报"批准了"）───────────────
{
  assert.ok(serverSrc.includes("这类通知只发私聊，不发群"), 'notify 必须拒绝群聊目标');
  console.log('✔ 通知只发私聊');
}

// ── 10. 约定必须精确到秒，不能靠 30 秒粗轮询 ──────────────────────────────
//
// 第一版用 setInterval(30s) 轮询，结果：约定 22:06:33 到点，tick 却排在
// 22:06:52 —— 中间 19 秒是"到点了但没人动"，用户看不出为什么她没醒。
// 现在改成"按最近一条精确 setTimeout + 60 秒低频兜底"，这里把它钉住。
{
  assert.ok(serverSrc.includes('function schedulePromises'), '应当有 schedulePromises');
  assert.ok(serverSrc.includes('function fireDuePromises'), '应当有 fireDuePromises');
  assert.ok(!/setInterval\(\(\)\s*=>\s*\{\s*void\s+tickPromises/.test(serverSrc),
    '不该再用 30 秒轮询当主路径');
  assert.ok(serverSrc.includes('nextPromiseAt'), '应当按"最近一条约定"精确排期');
  assert.ok(/setTimeout\(\(\)\s*=>\s*\{[\s\S]{0,200}fireDuePromises/.test(serverSrc),
    '应当用 setTimeout 精确触发');
  // 兜底仍在（进程被挂起/系统休眠后还能补上）
  assert.ok(serverSrc.includes('promiseSweep'), '应当保留低频兜底扫描');
  console.log('✔ 约定精确到秒 + 低频兜底');
}

// ── 11. 语音开关：必须存在、必须热切换 ─────────────────────────────────────
//
// 主人 2026-10-20：「开关语音功能的接口加入 3101」。
// 这条链上有三个容易写错、而且**错了很难发现**的点：
//   ① 只改 config.json 不更新运行中的 cfg.socialV2 ⇒ 点了开关没反应（要重启才行）；
//   ② tts 实例内部那份 cfg 是启动快照，光改桥接的 cfg 关不掉它 ⇒ "关了还在发语音"；
//   ③ 关了之后 speakOrTextV2 仍去试合成 ⇒ 每条都白等一两秒才退回文字。
// 所以这里同时钉住 3101 的接口、桥接的热读、以及 tts 的 liveEnabled 注入。
{
  // 3101 要有一条改语音的接口
  assert.ok(serverSrc.includes("url.pathname === '/api/voice'"), '专项控制台缺少 /api/voice 接口');
  // 它必须走桥接的 config 接口（而不是自己直接写 config.json —— 那样不热生效）
  assert.ok(/bridgeApi\('\/api\/socialV2\/config'/.test(serverSrc),
    '语音开关应当走桥接 /api/socialV2/config（直写文件不会热生效）');
  // overview 要回传语音状态，前端才能显示
  assert.ok(serverSrc.includes('speaking:'), 'overview 应当回传 speaking 状态');
  // 前端三个开关 + 保存按钮
  for (const id of ['voiceEnabled', 'ttsEnabled', 'autoReadback', 'saveVoice', 'voiceOn', 'voiceOff']) {
    assert.ok(pageSrc.includes(`id="${id}"`), `前端缺少控件 #${id}`);
  }

  // 桥接侧：speakForV2 不许再判 engine 那份启动快照
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  assert.ok(bridgeSrc.includes("cfg.socialV2?.tts?.enabled === false"),
    'speakForV2 应当热读 tts.enabled，而不是只看启动快照');
  assert.ok(!/if \(!engine\?\.enabled\) throw/.test(bridgeSrc),
    '不该再用 engine.enabled（启动快照）当判定 —— 那样控制台关不掉语音');
  assert.ok(bridgeSrc.includes('liveEnabled:'),
    'createTts 应当注入 liveEnabled 回调，让开关热生效');

  // tts-lib 侧：synthesize 不许直接读 cfg.enabled
  const ttsSrc = fs.readFileSync(path.join(ROOT, 'src', 'tts-lib.js'), 'utf8');
  assert.ok(ttsSrc.includes('isEnabled()'), 'tts 应当提供 isEnabled() 做实时判定');
  assert.ok(/if \(!this\.isEnabled\(\)\) return null/.test(ttsSrc),
    'synthesize 应当用 isEnabled() 而不是快照 cfg.enabled');
  console.log('✔ 语音开关可以热切换（接口 + 桥接热读 + tts liveEnabled）');
}

// ── 12. config 端点必须对 voice/tts 深度合并（2026-10-20 真事故）─────────────
//
// 事故经过：控制台只传 { voice: { enabled: false } }，而 config 端点用的是
// `merged = { ...current, ...body }` 的浅合并 ⇒ 整个 voice 段被替换成只剩 enabled，
// dir / maxSeconds / maxPerMinute / maxPerHour / maxBytes / ffmpegPath 全丢。
// 后果**不会立刻报错**：功能看起来还在，只是下次启动时语音上限悄悄退回默认
// （2 条/分钟），语音库路径也回默认 —— 属于"悄悄变差"的典型。
//
// 这个断言只查源码里有没有那两段合并逻辑；真正的行为回归见上面的实测步骤。
{
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  assert.ok(/merged\.voice = \{ \.\.\.\(current\.voice \?\? \{\}\), \.\.\.body\.voice \}/.test(bridgeSrc),
    'voice 必须与 current.voice 深度合并，不能整体替换');
  assert.ok(/merged\.tts = \{ \.\.\.\(current\.tts \?\? \{\}\), \.\.\.body\.tts \}/.test(bridgeSrc),
    'tts 必须与 current.tts 深度合并，不能整体替换');
  // 白名单里必须同时有这两个键，否则外层会先把它们重置
  assert.ok(/for \(const sub of \[[^\]]*'voice'[^\]]*'tts'/.test(bridgeSrc),
    '子对象白名单必须包含 voice 与 tts');
  console.log('✔ voice/tts 必须深度合并（不再冲掉兄弟字段）');
}

// ── 13. 工具开关（2026-10-20）────────────────────────────────────────────
//
// 背景：主控制台 public/console.html 的工具清单是**写死在 HTML 里的一串 <label>**
// （第 2064-2069 行），不是动态读的。两个后果：
//   ① 后加的工具它看不到 —— 实测漏了 qq_say / qq_request_permission /
//      qq_promise / qq_promise_done 四个；
//   ② 一个开关管多个工具时界面只显示其中一个 —— 关 speak 会把 qq_say 一起关掉，
//      而 qq_say 根本没显示，用户看不到自己关了什么。
// 所以专项控制台改成"现值从桥接现读 + 分组说明放本目录"。
//
// 另：本次还修了一个既有 bug —— bridge 的 toolFlags 名单漏了群图库 4 个 flag，
// 导致它们**存不进去**（控制台保存 tools 时归一化跳过 ⇒ 关掉又被静默改回 true）。
{
  const serverSrc2 = fs.readFileSync(SERVER, 'utf8');
  assert.ok(serverSrc2.includes("url.pathname === '/api/tools'"), '缺少 /api/tools 接口');
  assert.ok(serverSrc2.includes("bridgeApi('/api/socialV2/config'"),
    '工具开关应当走桥接 config 接口（不直写 config.json，那样不热生效）');
  assert.ok(serverSrc2.includes('TOOL_GROUPS'), '应当用 tool-groups.mjs 的分组表');

  // 分组表必须存在，且是 3101 自己目录里的（抗更新）
  const groupsFile = path.join(DIR, 'tool-groups.mjs');
  assert.ok(fs.existsSync(groupsFile), '缺少 tool-groups.mjs');

  // 前端要有保存按钮与容器
  for (const id of ['toolsBox', 'saveTools', 'toolsReset', 'toolsStatus', 'toolsDirty']) {
    assert.ok(pageSrc.includes(`id="${id}"`), `前端缺少控件 #${id}`);
  }
  // 占位符必须有人清掉（加这块时踩到的：写了"读取中…"却忘了更新它）
  assert.ok(/if \(st\) \{[\s\S]{0,400}st\.innerHTML/.test(pageSrc),
    'renderTools 必须更新状态行，否则占位符"读取中…"会一直挂着');
  // 分组要能显示"一个开关管几个工具"
  assert.ok(pageSrc.includes('一个开关管'), '界面要标出多工具开关');
  assert.ok(pageSrc.includes('桥接不认识'), '界面要标出 unknown 的开关');

  // 🔴 最关键：分组表里的工具名/开关名必须与真实代码对账
  const { TOOL_GROUPS, flatToolFlags } = await import(pathToFileURL(groupsFile).href);
  const mcpSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  const bridgeSrc2 = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

  const realTools = new Set([...mcpSrc.matchAll(/server\.tool\(\s*'([a-z_0-9]+)'/g)].map((m) => m[1]));
  const fm = /const toolFlags = \[([\s\S]*?)\];/.exec(bridgeSrc2);
  const realFlags = new Set(fm ? [...fm[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []);
  assert.ok(realFlags.size > 40, '读不到 bridge 的 toolFlags 名单');

  const flat = flatToolFlags();
  for (const g of TOOL_GROUPS) {
    for (const it of g.items) {
      assert.ok(realFlags.has(it.flag),
        `分组表里的开关名不在 bridge toolFlags 里：${it.flag}（界面会显示一个存不进去的开关）`);
      for (const t of (it.tools ?? [])) {
        assert.ok(realTools.has(t),
          `分组表里的工具名不存在：${t}（flag=${it.flag}）`);
      }
    }
  }

  // 反向：toolFlags 里的每个开关都必须被归类 —— 否则界面会漏掉它
  const unclassified = [...realFlags].filter((f) => !flat[f]);
  assert.deepEqual(unclassified, [],
    `这些开关没被归类，界面上会漏掉：${unclassified.join(', ')}`);

  // 群图库 4 个 flag 必须在 toolFlags 里（本次修的既有 bug）
  for (const f of ['listPhotos', 'getPhotoImage', 'sendPhoto', 'photoNote']) {
    assert.ok(realFlags.has(f), `群图库开关 ${f} 不在 toolFlags 里 —— 它会存不进去（既有 bug）`);
  }

  // 多工具开关必须如实标出（否则用户以为只关了一个）
  const multi = Object.entries(flat).filter(([, v]) => (v.tools ?? []).length > 1).map(([k]) => k);
  // ⚠️ `speak` **不在**这个名单里了：2026-10-20 把 qq_speak 合并进 qq_say 之后，
  //    它只对应一个工具。合并前它同时管 qq_say 和 qq_speak，而界面上只显示
  //    qq_speak —— 用户取消勾选会连 qq_say 一起关掉却看不见，那正是要修的问题。
  for (const f of ['memory', 'sendVoice', 'promise']) {
    assert.ok(multi.includes(f), `${f} 管多个工具，必须列出全部`);
  }
  assert.ok(!multi.includes('speak'),
    'speak 合并后只对应一个工具，不该再被标成多工具开关');

  // 合并后的形状：speak 只对应 qq_say，且 qq_speak 必须已从注册表里消失
  assert.deepEqual(flat.speak?.tools, ['qq_say'], 'speak 应当只对应 qq_say');
  assert.ok(!realTools.has('qq_speak'), 'qq_speak 应当已从 MCP 注册表删除（已合并进 qq_say）');
  assert.ok(realTools.has('qq_say'), 'qq_say 必须还在（它是合并后的唯一入口）');

  console.log('✔ 工具开关：接口 + 分组对账 + 多工具标注 + 群图库 flag 修复 + speak 已合并');
}

// ── 14. 侧边栏多页布局（2026-10-20 主人要求：像 3100 一样左边多页）────────
//
// 这组断言守的是"重构时容易静默坏掉"的几处：
//   · 某个页面忘了加 data-page ⇒ 它永远不显示（点了没反应，但代码看着"在"）
//   · 侧边栏按钮与页面数不一致 ⇒ 有的按钮点不动
//   · breadcrumb 取错了 h2 ⇒ 顶栏显示成别的卡片标题
//     （实测踩到：tokenSection 嵌在调试页里时，顶栏显示成"需要一次令牌"）
//   · 智能体日志/JS 依赖的 element id 被删
{
  const pages = [...pageSrc.matchAll(/data-page="([^"]+)"/g)].map((m) => m[1]);
  const navs = [...pageSrc.matchAll(/data-nav="([^"]+)"/g)].map((m) => m[1]);

  // 页面与侧边栏按钮必须一一对应
  assert.ok(pages.length >= 6, `页面数应当 ≥6，实际 ${pages.length}`);
  assert.deepEqual([...pages].sort(), [...navs].sort(),
    `data-page 与 data-nav 必须一一对应（页面 ${pages.join(',')} / 按钮 ${navs.join(',')}）`);

  // 必须真的有侧边栏与顶栏
  assert.ok(pageSrc.includes('class="sidebar"'), '缺少侧边栏');
  assert.ok(pageSrc.includes('class="topbar"'), '缺少顶栏');
  assert.ok(pageSrc.includes("data-crumb"), '缺少 breadcrumb 容器');

  // 切页逻辑必须在，且 breadcrumb 只取**直属** h2
  assert.ok(pageSrc.includes('function showPage'), '缺少切页函数 showPage');
  assert.ok(pageSrc.includes(':scope > h2'),
    'breadcrumb 必须用 :scope > h2 —— 用 querySelector("h2") 会命中外层卡片里嵌套的卡片标题');

  // 默认必须有一页是 active（否则打开是空白）
  assert.ok(/data-page="[^"]+"[^>]*class="[^"]*active|class="[^"]*active[^"]*"[^>]*data-page=/.test(pageSrc)
    || pageSrc.includes("classList.toggle('active'"),
    '必须有一个页面默认 active');

  // JS 依赖的 element id 一个都不能少（这次重构最容易丢的就是它们）
  const REQUIRED_IDS = [
    'toast', 'connBadge', 'refreshBtn', 'tokenSection', 'tokenInput', 'tokenSave',
    'prob', 'intMin', 'intMax', 'idle', 'saveProactive', 'resetProactive',
    'timeline', 'axis', 'nowFactor',
    'voiceEnabled', 'ttsEnabled', 'autoReadback', 'saveVoice', 'voiceOn', 'voiceOff',
    'voiceStatus', 'maxPerMinute', 'maxPerHour',
    'toolsBox', 'saveTools', 'toolsReset', 'toolsStatus', 'toolsDirty',
    'grantsBox', 'requestsBox', 'grantScope', 'grantMinutes', 'grantBtn', 'grantNotifyBtn',
    'promisesBox', 'promiseKind', 'promiseAt', 'promiseText', 'promiseBtn', 'quickWake', 'quickHour',
    'keySelect', 'wakeBtn',
  ];
  const missing = REQUIRED_IDS.filter((id) => !pageSrc.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `这些 element id 丢了（JS 会报 null 错）：${missing.join(', ')}`);

  console.log(`✔ 侧边栏多页布局：${pages.length} 页与按钮一一对应 / breadcrumb 取直属 h2 / ${REQUIRED_IDS.length} 个 id 齐全`);
}

// ── 15. 工具开关用顶部横向标签切换（2026-10-20 主人要求）──────────────────
//
// 主人原话：「这里面的展开放到上面成为横向的小格子」。
// 旧的折叠条（.tool-group + .tg-head + 展开才看到内容）一屏看不全 7 组，
// 改成顶部一排标签、点一个看一组。
//
// 这组断言守的几处：
//   · 标签式结构必须在（tool-tab / tool-panel），旧的折叠结构不该回来
//   · 勾选后要刷新标签角标（否则「关着 N」不跟着变 —— 用户以为没生效）
//   · 切标签不能重置勾选（工具开关是"先改、后保存"，中途切走不能丢改动）
{
  assert.ok(pageSrc.includes('class="tool-tabs"') || pageSrc.includes("class=\"tool-tabs\""),
    '工具开关应当用顶部标签容器 .tool-tabs');
  assert.ok(pageSrc.includes('class="tool-tab'), '缺少标签 .tool-tab');
  assert.ok(pageSrc.includes('tool-panel'), '缺少面板 .tool-panel');
  assert.ok(pageSrc.includes('data-tab='), '缺少标签的 data-tab');

  // 旧折叠结构不该再出现（回来了说明被改回旧版）
  assert.ok(!pageSrc.includes('tg-head') && !pageSrc.includes('tg-caret'),
    '旧的折叠结构（tg-head/tg-caret）不该再出现 —— 已被顶部标签取代');
  assert.ok(!pageSrc.includes('tool-group'), '旧的 .tool-group 不该再出现');

  // 勾选后刷新角标：否则「关着 N」在保存前看不到变化
  assert.ok(pageSrc.includes('refreshToolTabBadges'),
    '勾选后必须刷新标签角标（refreshToolTabBadges）');

  // 切标签时只重渲染面板，不该清空 toolsDirty（待保存的改动）
  assert.ok(/activeToolGroup = tab\.dataset\.tab;[\s\S]{0,120}renderTools/.test(pageSrc),
    '切标签应当只改 activeToolGroup 并重渲染');
  assert.ok(!/activeToolGroup = tab\.dataset\.tab;[\s\S]{0,160}toolsDirty\.clear\(\)/.test(pageSrc),
    '切标签不能清空 toolsDirty（会丢掉用户还没保存的改动）');

  // 角标文案必须能区分「共 N 个」与「关着 M 个」
  // （曾写成「2 关1」，被读成"关了 2 个"，而实际是"共 2 个、关 1 个"）
  assert.ok(pageSrc.includes('关着 ${offCount}'), '角标文案应当是「关着 N」');
  assert.ok(pageSrc.includes('tt-sep') || pageSrc.includes('tt-sep'),
    '数量与角标之间要有分隔（tt-sep），否则「2 关1」有歧义');

  console.log('✔ 工具开关用顶部横向标签切换 / 角标会跟着刷新 / 文案无歧义');
}

// ── 16. 开关清单里的工具名 vs 真实注册情况（2026-10-20 纠错）───────────────
//
// 教训（当时踩过）：判断"某开关对应的工具在不在"要看**权威清单**（真的起一次
// MCP server 问 tools/list），别用格式敏感的正则 —— 那次写死缩进的正则没匹配到
// 两个工具的注册写法，于是把它们误标成"工具未注册、她用不到"。
//
// 这组断言用**权威清单**来对账，并区分两种"查不到"：
//   ① 开关是关的 ⇒ 该工具按设计不注册（正常，不算错）
//   ② 开关是开的、工具却查不到 ⇒ 名字写错或工具被删（**必须报警**）
{
  // 静态可判的部分：开关关着的工具名是"已知不注册"的白名单
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const tools_ = cfg.socialV2?.tools ?? {};
  const OFF_FLAGS = ['sendVoice', 'setStickerRemark', 'speak'];
  const offNow = new Set(OFF_FLAGS.filter((f) => tools_[f] === false));

  const groupsFile = path.join(DIR, 'tool-groups.mjs');
  const { flatToolFlags } = await import(pathToFileURL(groupsFile).href);
  const flat = flatToolFlags();

  // 「没有对应工具」的开关必须显式区分原因：operation=true 是操作开关（正常），
  // 否则才是"名字可能写错"（要报警）。这个字段必须传到前端（曾经漏传）。
  const serverSrc3 = fs.readFileSync(SERVER, 'utf8');
  assert.ok(serverSrc3.includes('operation: it.operation === true'),
    'server 必须把 operation 字段传给前端（漏了会让操作开关显示成"⚠️ 未注册"）');
  assert.ok(pageSrc.includes('操作开关（不是独立工具）'),
    '前端应当为操作开关显示专门的文案，而不是"工具未注册"');

  // 检查：开关开着、但工具名为空 ⇒ 那一定是错的（除了 operation 类）
  const suspicious = Object.entries(flat)
    .filter(([flag, v]) => !(v.tools ?? []).length && !v.operation && !offNow.has(flag));
  assert.deepEqual(suspicious.map(([f]) => f), [],
    `这些开关开着却没有对应工具名（名字漏写/写错）：${suspicious.map(([f, v]) => f + ':' + v.note).join('; ')}`);

  // qzoneUnlike 是操作开关，不是工具
  assert.equal(flat.qzoneUnlike?.operation, true, 'qzoneUnlike 应标记为 operation（取消赞是 like 的参数）');

  console.log('✔ 工具名与真实注册情况一致 / 操作开关与"名字写错"已区分');
}

// ── 17. 约定的时间用原生日历控件（2026-10-20 主人要求）────────────────────
//
// 主人原话：「你这时间给我整一个日历选项啊，不方便」。
// 原来是一个 text 输入框，要手打 "2026-10-20 07:30"。
//
// 改用原生 input[type=date] + input[type=time]：
//   · 天然带日历弹窗、键盘可用、零依赖（本控制台不许引第三方库）
//
// 这组断言守三处：
//   ① 控件类型是 date/time（别被改回 text）
//   ② 解析必须**手动拆数字**再 new Date(y,m,d,h,mi) ——
//      new Date('2026-10-20T07:30') 在部分浏览器按 UTC 解释，东八区会偏 8 小时
//   ③ 打开页面要有合理默认值（否则又是"从空白开始填"）
{
  assert.ok(pageSrc.includes('type="date" id="promiseAt"'),
    '日期必须用原生 input[type=date]（别改回 text —— 那样又得手打）');
  assert.ok(pageSrc.includes('id="promiseTime"'),
    '需要独立的 input[type=time] 选几点');
  assert.ok(pageSrc.includes('function readPromiseAt'),
    '缺少 readPromiseAt（双控件解析）');
  assert.ok(pageSrc.includes('function setPromiseInputs'),
    '缺少 setPromiseInputs（回填控件）');
  assert.ok(pageSrc.includes('defaultPromiseAt'),
    '缺少默认值逻辑（打开就该有个合理初值）');

  // 关键：本地时区解析，不能依赖 ISO 串的时区解释
  assert.ok(/new Date\(\+dm\[1\], \+dm\[2\] - 1, \+dm\[3\], hh, mi, 0, 0\)/.test(pageSrc),
    '必须手动拆数字再 new Date(y,m-1,d,h,mi) —— 用 ISO 串会在部分浏览器按 UTC 解释');

  // 旧的手打解析不该再被调用
  assert.ok(!pageSrc.includes('parseLocalTime('),
    '不该再调用 parseLocalTime（已换成 readPromiseAt）');

  // 过去的时刻要有前端拦截（服务端也会拒，但前端提示更直接）
  assert.ok(pageSrc.includes('这个时间已经过去了'),
    '过去的时间应当在前端就被拦住并给出提示');

  console.log('✔ 约定的时间用原生日历控件 / 本地时区解析 / 有默认值 / 拦过去时间');
}

// ── 18. 「自由时间」的数字能在控制台改（2026-10-20）────────────────────────
//
// 主人原话："我觉得设置数字这些东西都可以做进控制台里面让我方便改，不然每次让你改很久"。
//
// 所以把两个原本硬编码的数字搬到面板上：
//   · quietGrantMs       —— 聊完静默多久算她的（默认 2.5 分钟）
//   · qzoneWriteMinGapMs —— 两次空间写之间至少隔多久（默认 4 小时）
//
// 这组断言守的几处（都是容易静默坏掉的）：
//   ① 面板端点存在，且走桥接的 config 端点（直写 config.json 不热生效）
//   ② 前后端范围钳制**必须一致** —— 否则前端看着合法、后端却按别的值算
//   ③ overview 要带上现值 + "是不是默认值"标记（否则用户不知道自己改过没有）
//   ④ bridge.js 里的默认值必须和面板显示的一致（不然改之前看到的就不是真值）
{
  const serverSrc4 = fs.readFileSync(SERVER, 'utf8');
  const bridgeSrc3 = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

  // ① 端点存在 + 走桥接 config
  assert.ok(serverSrc4.includes("url.pathname === '/api/autonomy'"), '缺少 /api/autonomy 端点');
  // ⚠️ 距离放到 1200：端点距 bridgeApi 调用有 952 字符（中间是那些校验分支）。
  //    写太窄会误报"没走桥接接口" —— 我第一版写 400 就踩了这个坑。
  assert.ok(/url\.pathname === '\/api\/autonomy'[\s\S]{0,1200}bridgeApi\('\/api\/socialV2\/config'/.test(serverSrc4),
    '面板端点必须走桥接的 config 接口（直写 config.json 不热生效，得重启桥接）');

  // ② 前后端钳制一致：bridge 夹在 [10 秒, 60 分钟] / [0, 7 天]
  assert.ok(bridgeSrc3.includes('AUTONOMOUS_QUIET_GRANT_MS_DEFAULT'), 'bridge 该有静默门槛的默认值常量');
  assert.ok(bridgeSrc3.includes('QZONE_WRITE_MIN_GAP_MS_DEFAULT'), 'bridge 该有空间写间隔的默认值常量');
  assert.match(bridgeSrc3, /Math\.max\(10000, Math\.min\(v, 60 \* 60 \* 1000\)\)/,
    'bridge 的静默门槛钳制应当是 [10 秒, 60 分钟]');
  assert.match(bridgeSrc3, /Math\.min\(v, 7 \* 24 \* 60 \* 60 \* 1000\)/,
    'bridge 的空间写间隔钳制应当是 [0, 7 天]');
  // 面板侧也要夹同样的范围（提示文案里能看出来）
  assert.ok(serverSrc4.includes('不能少于 10 秒') && serverSrc4.includes('不能超过 60 分钟'),
    '面板侧必须夹和 bridge 一样的范围，否则两边算法不一致');
  assert.ok(serverSrc4.includes('不能超过 7 天'), '面板侧的空间写间隔上限要和 bridge 一致');

  // ③ overview 要带现值和默认标记
  assert.match(serverSrc4, /autonomy:\s*\(\(\)\s*=>/, 'overview 应当带上 autonomy 现值');
  assert.ok(serverSrc4.includes('quietGrantIsDefault'), '要标出"是不是默认值"，否则用户不知道自己改过没有');
  assert.ok(serverSrc4.includes('gapIsDefault'), '同上');

  // ④ 默认值必须两边一致（面板显示 2.5 分钟 / 4 小时，bridge 也得是）
  assert.ok(serverSrc4.includes('2.5 * 60 * 1000'), '面板的静默默认值应当是 2.5 分钟（与 bridge 一致）');
  assert.ok(serverSrc4.includes('4 * 60 * 60 * 1000'), '面板的空间写间隔默认值应当是 4 小时（与 bridge 一致）');

  // ⑤ 前端控件齐全 + 有保存逻辑
  for (const id of ['quietGrantMin', 'qzoneGapHour', 'saveAutonomy', 'resetAutonomy', 'autonomyStatus']) {
    assert.ok(pageSrc.includes(`id="${id}"`), `前端缺少控件 #${id}`);
  }
  assert.ok(pageSrc.includes('fillAutonomy'), '缺少 fillAutonomy（回填现值）');
  assert.ok(pageSrc.includes("api('/api/autonomy'"), '保存按钮应当调 /api/autonomy');
  // 「恢复默认」只填值不保存（防误点改掉配置）
  assert.ok(/resetAutonomy[\s\S]{0,300}点「保存」才生效/.test(pageSrc),
    '「恢复默认」应当只填值、不直接保存（防误点就改配置）');

  console.log('✔ 自由时间的两个数字能在控制台改 / 前后端钳制一致 / 标出默认值');
}

console.log('\nextra console: all isolation checks passed');

// 网页那只「手」的回归（2026-10-22，主人原话：「现在的小鲸鱼只能看网页，不能操作，
// 我想让她可以操作网页，给她加一个手」）。
//
// ── 这个测试在守什么 ─────────────────────────────────────────────────────
// 「手」= 点 / 填 / 滚 / 按 / 选下拉。它是**改外部世界**的能力，也是这个仓库里
// 唯一一条"能让小鲸鱼替主人动他账号"的路。所以要钉住四件事：
//
//   ① **只在管理员私聊**。群里、普通成员私聊调用必须被守卫拒，而且拒绝理由要说人话
//      （她要能听懂"这是权限，不是故障"，否则会反复重试）。
//   ② **上传永远关死**。/setFiles 必须留在补丁的禁用名单里，且**不随只读开关消失** ——
//      主人挑的是「点填滚按选」这一档，不含把本机文件塞进网页。
//   ③ **没有任意 JS**。MCP 层不能出现 eval / 执行脚本这类工具（那等于把整只手换成
//      一条任意代码通道）。
//   ④ **密码框不碰**。这条写在 cdp-browser.js 里（clickElement / typeInto），
//      这里做静态核对 —— 它不在正常聊天路径上，手动试发现不了。
//
// 跑：node --test scripts/test-web-hand.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verdictFor, WEB_HAND_TOOLS } from '../plugins/qq-agent-presets/qq-tool-restrict.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const OWNER = 'owner-private';
const GROUP = 'group';
const MEMBER = 'member-private';
const ALL = [OWNER, GROUP, MEMBER];
const HANDS = [...WEB_HAND_TOOLS].sort();

console.log('— 1. 手的六个工具：只给管理员私聊 —');
test('手一共六个，名字都挂在 web-search-safe 命名空间下', () => {
  assert.equal(HANDS.length, 6, `手应该是六个（点/填/按/滚/选/列），实际 ${HANDS.length}：${HANDS.join(', ')}`);
  for (const name of HANDS) {
    assert.match(name, /^mcp__web-search-safe__web_/, `${name} 应该挂在 web-search-safe 包里`);
  }
});

test('管理员私聊：六个全放行', () => {
  for (const name of HANDS) {
    assert.equal(verdictFor(name, OWNER), undefined, `${name} 在主人私聊里必须能用`);
  }
});

test('群聊 / 普通成员私聊：六个全拒，且理由说清是权限不是故障', () => {
  for (const name of HANDS) {
    for (const kind of [GROUP, MEMBER]) {
      const r = verdictFor(name, kind);
      assert.ok(typeof r === 'string' && r.length > 0, `${name} 在 ${kind} 必须被拒`);
      assert.match(r, /只允许管理员私聊/, '要明说是权限问题，否则她会以为是坏了');
      assert.doesNotMatch(r, /不在.*白名单|未知工具/, '不能退化成"这工具不存在"——她会以为工具名写错了');
    }
  }
});

test('手比「读」严一档：web_read_link 三类全放，web_click 只有主人私聊', () => {
  for (const kind of ALL) {
    assert.equal(verdictFor('mcp__web-search-safe__web_read_link', kind), undefined, '读网页仍然三类全放');
  }
  assert.equal(verdictFor('mcp__web-search-safe__web_click', GROUP) !== undefined, true, '点按钮绝不能放给群聊');
});

test('手没被顺手塞进 SAFE_EXACT（那等于三类会话全放）', () => {
  const src = read('plugins/qq-agent-presets/qq-tool-restrict.mjs');
  const start = src.indexOf('const SAFE_EXACT = new Set([');
  const block = src.slice(start, src.indexOf('])', start));
  assert.doesNotMatch(block, /web_click|web_type|web_key|web_scroll|web_select|web_whats_there/,
    '手绝不能进 SAFE_EXACT —— 那等于群里任何人都能借她的号点按钮');
});

test('手的判定排在 SAFE_PREFIXES 之前（否则前缀会把它整包放行）', () => {
  const src = read('plugins/qq-agent-presets/qq-tool-restrict.mjs');
  const handAt = src.indexOf('if (WEB_HAND_TOOLS.has(name))');
  const prefixAt = src.indexOf('if (SAFE_PREFIXES.some(');
  assert.ok(handAt > 0, 'verdictFor 里应该有 WEB_HAND_TOOLS 分支');
  assert.ok(prefixAt > 0, 'verdictFor 里应该有 SAFE_PREFIXES 分支');
  assert.ok(handAt < prefixAt, '手的判定必须排在 SAFE_PREFIXES 之前，否则 mcp__web-search-safe__ 前缀会先把它放过去');
});

console.log('— 2. 上传文件：永远关死，不随只读开关消失 —');
test('cdp-proxy 的 /setFiles 在 UPLOAD_BLOCKED 里，且 BLOCKED_ROUTES 永远包含它', () => {
  const src = read('tools/web-access/scripts/cdp-proxy.mjs');
  assert.match(src, /const UPLOAD_BLOCKED = new Set\(\['\/setFiles'\]\)/, '/setFiles 必须单独归到 UPLOAD_BLOCKED');
  assert.match(src, /BLOCKED_ROUTES = READONLY \? new Set\(\[\.\.\.UPLOAD_BLOCKED, \.\.\.HANDS_BLOCKED\]\) : UPLOAD_BLOCKED/,
    '只读开关只能**增加**拦截项（HANDS_BLOCKED），不能把 UPLOAD_BLOCKED 去掉');
  assert.doesNotMatch(src, /READONLY \? new Set\(\[\.\.\.HANDS_BLOCKED\]\) : new Set\(\)/,
    '绝不能让"非只读"时完全不拦');
});

test('MCP 层没有暴露上传工具（找文件/塞文件那条路不存在）', () => {
  const src = read('src/mcp-web-search-safe.js');
  // 只钉"路由名 / 调用点"，不钉注释：注释里提到 /setFiles 是在解释**为什么不做**它，
  // 用宽正则会把那句说明也算成"暴露了上传"，是把测试写成自我误伤。
  assert.doesNotMatch(src, /proxyFetch\(\s*['"`]\/setFiles/, 'MCP 层不能自己去调 /setFiles');
  assert.doesNotMatch(src, /DOM\.setFileInputFiles/, 'MCP 层不能碰 CDP 的 setFileInputFiles');
  const tools = [...src.matchAll(/^server\.tool\(\s*\n?\s*'([a-zA-Z0-9_]+)'/gm)].map((m) => m[1]).sort();
  for (const name of ['web_click', 'web_type', 'web_key', 'web_scroll', 'web_select', 'web_whats_there']) {
    assert.ok(tools.includes(name), `MCP 应该注册 ${name}（实际：${tools.join(', ')}）`);
  }
  for (const name of tools) {
    assert.doesNotMatch(name, /upload|file/i, `${name} 看着像上传/文件类工具`);
  }
});

console.log('— 3. 没有任意 JS 的入口 —');
test('MCP 层不注册任何"执行脚本/求值"的工具', () => {
  const src = read('src/mcp-web-search-safe.js');
  const tools = [...src.matchAll(/^server\.tool\(\s*\n?\s*'([a-zA-Z0-9_]+)'/gm)].map((m) => m[1]);
  for (const name of tools) {
    assert.doesNotMatch(name, /eval|exec|script|js|run/i,
      `工具名 ${name} 看着像任意执行入口 —— 手只能是受控动作，不能是 eval`);
  }
});

test('cdp-browser 里手的那一节没有对外导出 eval 包装', () => {
  const src = read('src/cdp-browser.js');
  const exported = [...src.matchAll(/^export (?:async )?function ([a-zA-Z0-9_]+)/gm)].map((m) => m[1]);
  for (const name of ['clickElement', 'typeInto', 'pressKey', 'scrollPage', 'selectOption', 'listClickables', 'findElement']) {
    assert.ok(exported.includes(name), `cdp-browser 应该导出 ${name}`);
  }
  assert.ok(!exported.includes('evalRaw'), '不该有"随便跑一段 JS"的导出');
});

console.log('— 3.5 静默优先：平时绝不抢窗口（2026-10-22 主人要求）—');
test('三个动作都是"先静默做，失败才切前台"（focusForAction 只出现在失败退路里）', () => {
  const src = read('src/cdp-browser.js');
  // clickElement / typeInto / pressKey / scrollPage 四个函数体里，
  // focusForAction 只能出现在"没成功之后"的分支里。
  const pick = (name, nextName) => {
    const a = src.indexOf(`export async function ${name}`);
    assert.ok(a > 0, `${name} 应该存在`);
    // 边界用"下一个 export"来切，而不是猜某个函数名 —— 函数顺序变过好几次。
    const nextExport = src.indexOf('\nexport ', a + 10);
    const named = nextName ? src.indexOf(`export async function ${nextName}`) : -1;
    const b = named > a ? named : nextExport;
    assert.ok(b > a, `${name} 之后应该能切出边界`);
    return src.slice(a, b);
  };
  const clickBody = pick('clickElement');
  // clickElement：静默点击必须在升级真实鼠标之前
  const jsClickAt = clickBody.indexOf("body: hit.css");
  const realAt = clickBody.indexOf("proxyFetch('/clickXY'");
  assert.ok(jsClickAt > 0, 'clickElement 里应该有静默 JS 点击');
  assert.ok(realAt > jsClickAt, '真实鼠标必须在静默点击之后（先试静默）');

  const typeBody = pick('typeInto', 'pressKey');
  const typeFocus = typeBody.indexOf('focusForAction');
  const firstType = typeBody.indexOf('doType()');
  assert.ok(firstType > 0, 'typeInto 应该先静默填一次');
  assert.ok(typeFocus === -1 || typeFocus > firstType, '填字的 focusForAction 只能在静默失败之后');

  const keyBody = pick('pressKey', 'scrollPage');
  const keyFocus = keyBody.indexOf('focusForAction');
  const firstKey = keyBody.indexOf('doKey()');
  assert.ok(firstKey > 0, 'pressKey 应该先静默按一次');
  assert.ok(keyFocus === -1 || keyFocus > firstKey, '按键的 focusForAction 只能在静默失败之后');

  const scrollBody = src.slice(src.indexOf('export async function scrollPage'), src.indexOf('/** 选下拉框'));
  const scrollFocus = scrollBody.indexOf('focusForAction');
  const silentScroll = scrollBody.indexOf("proxyFetch('/scroll'");
  assert.ok(silentScroll > 0, 'scrollPage 应该先静默滚一次');
  assert.ok(scrollFocus > silentScroll, '滚动的切前台只能在静默滚动没生效之后');
});

test('返回结果里会如实告诉她"这次打扰到主人了"', () => {
  const src = read('src/cdp-browser.js');
  // 四个动作都要带回 broughtToFront（她靠它判断"这次是不是把窗口顶出来了"）
  const hits = src.match(/broughtToFront/g) ?? [];
  assert.ok(hits.length >= 5, `broughtToFront 至少出现在四个动作的返回里，实际 ${hits.length} 处`);
  // ★关键：broughtToFront 必须是**回读出来的可见性**，不是"调过 activate 就算"★
  // 2026-10-22 踩过：Target.activateTarget 只给标签页焦点，没法把窗口从 DSH 后面提出来，
  // 所以调完 hasFocus 会是 true 而 visibilityState 仍是 hidden。谎报这一点，
  // 她就会跟主人说"窗口给你弹出来了"，而屏幕上什么都没有。
  assert.match(src, /broughtToFront: focusState\.visible/, '要取回读的 visible，不是"尝试过"');
  assert.match(src, /focusAttempted: focusState\.attempted/, '把"尝试过"单独报出去（两者不是一回事）');
  const ffa = src.slice(src.indexOf('async function focusForAction'), src.indexOf('async function focusForAction') + 1400);
  assert.match(ffa, /visibilityState/, 'focusForAction 必须回读 visibilityState');
  assert.match(ffa, /visible: state\.visible/, '要如实返回 visible');
  const yml = read('dsh/agent-presets/qq-chat-v2/agent.cordis.yml');
  assert.match(yml, /静默/, '提示词要说明手默认是静默的');
  assert.match(yml, /broughtToFront/, '要让她认得这个字段（知道哪次打扰了他）');
});

test('静默 JS 点击用的是真实元素的 CSS 路径（不是她口述的那几个字）', () => {
  const src = read('src/cdp-browser.js');
  assert.match(src, /css: path/, 'findElement 要算出 CSS 路径');
  assert.match(src, /body: hit\.css \|\| selector/, '静默点击要用那个路径 —— 按文字找到的元素，文字本身不是合法选择器');
});

console.log('— 3.8 截图：后台页也要快（2026-10-22 真机事故）—');
test('截图前会对 target 真的 activate 一次（否则后台页每次都卡满超时）', () => {
  const src = read('tools/web-access/scripts/cdp-proxy.mjs');
  const i = src.indexOf("else if (pathname === '/screenshot')");
  const block = src.slice(i, i + 3200);
  // 事故：后台标签页不会自己合成新帧 ⇒ Page.captureScreenshot 等一帧永远不来，
  // 每次都卡满超时（实测 8200ms × 10）。焦点模拟（Emulation.setFocusEmulationEnabled）
  // 没用 —— 实测模拟后照样 8 秒。只有真 activate 一次才让合成器恢复产帧（降到 300ms）。
  assert.match(block, /nudgeRender/, '截图前要先唤一帧');
  assert.match(block, /Target\.activateTarget/, '唤醒要用真的 activateTarget');
  // 注释里提到它是在解释"为什么不用它"，所以只排查**代码**，不排查注释。
  const codeOnly = block.split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  assert.doesNotMatch(codeOnly, /setFocusEmulationEnabled\(/,
    '焦点模拟解决不了这个问题（实测无效）—— 别再把它当解法塞回代码里');
});

test('截图有单次超时 + 重试一次，绝不让她等半分钟', () => {
  const src = read('tools/web-access/scripts/cdp-proxy.mjs');
  const i = src.indexOf("else if (pathname === '/screenshot')");
  const block = src.slice(i, i + 4000);
  assert.match(block, /SHOT_TIMEOUT/, '单次要有独立超时');
  assert.match(block, /captureOnce\(2\)/, '失败要重试一次');
  assert.match(block, /detachFromTarget/, '重试前要 detach 掉卡住的 session（否则新命令排在它后面，越重试越慢）');
  assert.match(block, /SCREENSHOT_FAILED/, '两次都失败要如实回 504，别假装成功');
  const client = read('src/cdp-browser.js');
  assert.match(client, /timeoutMs: 20000/,
    '客户端兜底超时也要收紧 —— 原来是 30000，她截图一挂就干等半分钟');
});

console.log('— 4. 密码框不点不填 —');test('clickElement / typeInto 都会挡掉密码框', () => {
  const src = read('src/cdp-browser.js');
  // 两个函数各自的密码框判断
  const clickAt = src.indexOf('export async function clickElement');
  const typeAt = src.indexOf('export async function typeInto');
  assert.ok(clickAt > 0 && typeAt > 0);
  const clickBody = src.slice(clickAt, typeAt);
  const typeEnd = src.indexOf('const SUPPORTED_KEYS', typeAt);
  const typeBody = src.slice(typeAt, typeEnd > 0 ? typeEnd : typeAt + 3000);
  assert.match(clickBody, /hit\.password/, 'clickElement 必须先看是不是密码框');
  assert.match(clickBody, /密码框/, 'clickElement 的拒绝理由要讲明白');
  assert.match(typeBody, /hit\.password/, 'typeInto 必须先看是不是密码框');
  assert.match(typeBody, /密码框/, 'typeInto 的拒绝理由要讲明白');
});

test('找元素找不到时会把"页面上能点的"列出来（别让她瞎猜第二次）', () => {
  const src = read('src/cdp-browser.js');
  assert.match(src, /notFound: true, visible: shown/, '找不到元素要带回 visible 列表');
  const mcp = read('src/mcp-web-search-safe.js');
  assert.match(mcp, /FIND_MISS|找不到要点的那个东西/, 'MCP 层要把那个列表转述给她');
});

console.log('— 5. 她自己的提示词里真的知道有这只手 —');
test('preset 提示词写清了六个工具、只在主人私聊、以及不可撤销动作要先说', () => {
  const yml = read('dsh/agent-presets/qq-chat-v2/agent.cordis.yml');
  for (const name of HANDS.map((n) => n.split('__').pop())) {
    assert.ok(yml.includes(name), `提示词里要提到 ${name}，否则她根本不会用`);
  }
  assert.match(yml, /只在主人私聊里存在/, '要讲清会话边界');
  assert.match(yml, /不可撤销|付款|删除/, '要讲清不可撤销动作的规矩');
  assert.match(yml, /密码框/, '要讲清密码框不碰');
  // 旧的那句"你只能看，不能点"必须删掉，否则她照旧会跟主人说"我点不了"
  assert.doesNotMatch(yml, /你只能看，不能点、不能填表/, '旧的"只能看"那句必须删掉，否则会自相矛盾');
});

test('生成出来的 patch 也同步了（DSH 读的是它，不是源文件）', () => {
  const patch = read('plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml');
  assert.match(patch, /web_click/, 'patch 里要有 web_click');
  assert.match(patch, /只在主人私聊里存在/, 'patch 里要同步会话边界那句');
});

console.log('— 6. 原有边界没被放松 —');
test('手机工具仍然要申请，本地执行面仍然全拒', () => {
  for (const kind of ALL) {
    assert.ok(typeof verdictFor('mcp__phone__phone_tap', kind) === 'string', '手机工具必须仍然需要授权');
    assert.ok(typeof verdictFor('pwsh', kind) === 'string', '本地执行面必须仍然全拒');
  }
});

test('前缀白名单的纪律还钉在守卫里（以后往包里加动作类工具必须同步进 WEB_HAND_TOOLS）', () => {
  // 前缀放行的代价就在这里：mcp__web-search-safe__ 是"整包放行"，
  // 以后谁往包里加一个新工具，默认就是三类会话全放。所以那条纪律必须写在
  // 判定逻辑旁边，而不是只写在文档里 —— 改代码的人第一眼就能看到。
  const src = read('plugins/qq-agent-presets/qq-tool-restrict.mjs');
  assert.match(src, /以后往这个包里加\*\*任何\*\*会改外部世界的工具/, '前缀纪律那条注释必须在 SAFE_PREFIXES 旁边');
  assert.match(src, /都必须同时加进 WEB_HAND_TOOLS/, '要指明白该加到哪里');
  // 只读的仍然三类全放（别把整个包一起锁死，那会让她连网页都读不了）
  assert.equal(verdictFor('mcp__web-search-safe__web_read_more', MEMBER), undefined, '只读的仍然放行');
});

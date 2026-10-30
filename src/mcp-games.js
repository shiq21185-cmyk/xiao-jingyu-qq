// 网页游戏 MCP server（stdio）—— 让小鲸鱼能"看懂并操作"放在本机的网页游戏。
//
// 主人 2026-10-22：「我在 小鲸鱼的游戏 里面放入了第一个游戏，能不能让小鲸鱼直接接入
// 这里去玩游戏」，要的是**接口**而不是给某个游戏写死一套；后来又补了一句
// 「我放在这里的是整个网页游戏的源码，所以你的操作空间会很大」——
// 于是执行层改成**直接在 Node 里跑游戏引擎**（见 src/games/engine-host.js），
// 页面只负责显示。
//
// 这一层只做三件事：
//   ① 把"现在有哪些游戏"告诉她；
//   ② 把"当前局面 + 能做哪些动作"压缩成一小段文字；
//   ③ 执行她选的动作，并把**做完之后的局面**一起还给她。
//
// 能力边界（与"网页上的手"同一档）：
//   · 四个工具只给**主人私聊**（守卫的 GAME_TOOLS）。
//   · 她能传的只有 `游戏名 + 动作 id + 可选参数`，**没有**任意 JS / 文件 / 网络。
//   · 游戏目录被限定在 `小鲸鱼的游戏/` 下面（src/games/index.js 的 resolveInsideRoot）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { gamesRoot, listGames, readAdapterMeta, loadAdapter } from './games/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * 她现在的角色名 —— 游戏里就用这个名字当玩家名。
 *
 * 为什么不写死「小鲸鱼」：主人 2026-10-22 明确说「这个逻辑该为小鲸鱼进入游戏后
 * 作为玩家有个玩家名，不能写死，之后还会有其他游戏的」。
 * 也就是说：**她的名字来自"当前角色"，不是来自某个游戏的某个字段**。
 * 角色卡可以换（roles/ 目录里还有别的），所以每次现读、不缓存。
 *
 * 读不到就退回「小鲸鱼」—— 那是她的默认角色，不是硬编码的假设。
 */
function currentPlayerName() {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'current-role.json'), 'utf8'));
    const role = String(st?.role ?? '').trim();
    if (role) return role;
  } catch { /* 读不到就用默认 */ }
  return '小鲸鱼';
}

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch { return {}; }
}

/** 当前游戏清单（每次都现读目录 —— 主人往目录里丢新游戏就会自动出现）。 */
function games() {
  const root = gamesRoot(process.env, loadConfig());
  return listGames(root).map((g) => ({ ...readAdapterMeta(g), _game: g }));
}

/** 按名字挑一个；挑不到就把现有的列出来（别让她瞎猜）。 */
function pickGame(name) {
  const all = games();
  if (!all.length) {
    throw new Error(`本机还没有接入任何游戏（目录：${gamesRoot(process.env, loadConfig())}）。`
      + '接入一个游戏 = 在那个目录里放一个 adapter.js（模板见 qq-bridge-deploy/src/games/README.md）。');
  }
  if (!name) return all[0];
  const hit = all.find((g) => g.id === name)
    || all.find((g) => g.id.endsWith(name) || g.id.replace(/^\d+\./, '') === name)
    || all.find((g) => g.id.includes(name));
  if (!hit) throw new Error(`没有这个游戏：${name}。现在有：${all.map((g) => g.id).join('、')}`);
  return hit;
}

/** 局面摘要 → 一小段人话。她的上下文很贵，别把整个 state 倒进去。 */
function formatBoard(board) {
  if (!board) return '（没有局面）';
  const lines = [];
  lines.push(`现在是 **${board.turnName ?? '?'}** 的回合`
    + `${board.dice ? `（刚掷出 ${board.dice} 点）` : ''}`
    + `${board.survivorOnly ? ' · 已进入淘汰赛' : ''}`
    + `${board.winner != null ? ` · 赢家：${board.players?.[board.winner]?.name ?? board.winner}` : ''}`);
  for (const p of board.players ?? []) {
    const tags = [];
    if (p.isAI) tags.push('AI');
    if (p.bankrupt) tags.push('已破产');
    if (p.id === board.turn) tags.push('← 当前');
    lines.push(`· ${p.name}（${p.cellName}）现金 ${p.cash}｜地契 ${p.deeds}｜古董 ${p.antiques}｜伙计 ${p.helpers}`
      + `${tags.length ? ` [${tags.join('/')}]` : ''}`);
  }
  if (board.pending) lines.push(`待决定：${board.pending.kind}（玩家 ${board.pending.playerId}）`);
  if (board.lastLog?.length) {
    lines.push('最近的经过：');
    for (const l of board.lastLog) lines.push(`  ${l}`);
  }
  return lines.join('\n');
}

function formatActions(list) {
  if (!list?.actions?.length) return '（现在没有可做的动作）';
  return list.actions.map((a, i) => `${i + 1}. ${a.label} —— 动作 id: \`${a.id}\``).join('\n')
    + (list.note ? `\n\n（${list.note}）` : '');
}

/** 同步到页面这件事的结果，用一句话说清（不夸大、不隐瞒）。 */
function syncNote(synced) {
  if (!synced) return '';
  if (synced.ok) {
    return '（局面已经写到网页上了——我开的是**后台标签页**，你自己那页没被动过）';
  }
  const why = {
    'page-not-open': '网页没开着（开局时我会自己去开一个后台标签页，但浏览器可能没在跑）',
    'open-failed': '想开个页面出来，但没成',
    'no-state': '没有局面可同步',
    'hook-installed-need-retry': '刚给网页装上接口钩子（已重新加载），下一次动作就能同步了',
  }[synced.reason] || String(synced.reason ?? '未知原因');
  return `（这次没能同步到网页：${why}。不影响继续玩。）`;
}

const server = new McpServer({ name: 'games', version: '0.2.0' });

server.tool(
  'game_list',
  '看看本机现在接了哪些网页游戏（名字、类型、一句话说明）。'
  + '她是通过"通用游戏接口"接的，所以这里列出来的都能玩；以后主人往游戏目录里加新游戏，也会自动出现在这张表里。',
  {},
  async () => {
    try {
      const all = games();
      if (!all.length) {
        return {
          content: [{
            type: 'text',
            text: `现在一个游戏都还没接上（目录：${gamesRoot(process.env, loadConfig())}）。\n`
              + '接入一个游戏 = 在那个目录里放一个 adapter.js（模板见 qq-bridge-deploy/src/games/README.md）。',
          }],
        };
      }
      const lines = all.map((g, i) => {
        const kind = g.kind === 'browser-play'
          ? '浏览器里玩·你看得到她每一步'
          : g.kind === 'node-engine'
          ? '引擎型·在 Node 里跑（快，不用点浏览器）'
          : g.kind === 'engine' ? '引擎型·借浏览器'
            : g.kind === 'ui' ? '界面型（靠点按钮推进）' : '未知';
        return `${i + 1}. **${g.name}** —— 游戏名: \`${g.id}\`\n   ${kind}｜${g.about || '（没写说明）'}`;
      });
      return {
        content: [{
          type: 'text',
          text: `本机接了 ${all.length} 个网页游戏：\n\n${lines.join('\n\n')}\n\n`
            + '要开一局用 game_reset（可以指定玩哪个）；要看局面用 game_look；要做决定用 game_act。',
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `列游戏时出错：${String(error?.message ?? error).slice(0, 300)}` }], isError: true };
    }
  }
);

server.tool(
  'game_reset',
  '开一局新游戏（会重置当前对局）。可以指定 `game`（游戏名，见 game_list）、'
  + '以及这一局里有几个 AI 对手、她的角色名。不传 game 时，只有一个游戏就直接用它。'
  + '★这一步会真的开新局，正在进行的对局会被清掉★ 主人在玩的时候别随手调。',
  {
    game: z.string().optional().describe('游戏名（见 game_list）；只有一个游戏时可以省略'),
    aiCount: z.number().optional().describe('几个 AI 对手（0~3，默认 3）'),
    playerName: z.string().optional().describe('她的玩家名；不传就用她**当前的角色名**（state/current-role.json）'),
  },
  async ({ game, aiCount, playerName }) => {
    try {
      const meta = pickGame(game);
      const { adapter, io } = loadAdapter(meta._game);
      if (typeof adapter.reset !== 'function') throw new Error(`游戏 ${meta.id} 的适配器不支持开局（没有 reset）`);

      // 至少 1 个 AI 对手：游戏规则要求至少 2 名玩家（`if (players.length < 2)` 会拒绝开局）。
      // 主人传 aiCount=0 时，如实按 1 处理，并把这件事告诉她（别让她以为参数没生效）。
      const wanted = Number.isFinite(Number(aiCount)) ? Number(aiCount) : 3;
      const n = Math.max(1, Math.min(3, wanted));
      const aiAdjusted = n !== wanted;
      // 玩家名来自"她此刻是谁"，不是写死的常量 —— 换角色后自动跟着变。
      const me = String(playerName ?? currentPlayerName());
      const players = [{ name: me, color: '#4aa3ff', isAI: false }];
      const names = ['玩家2', '玩家3', '玩家4'];
      const colors = ['#ff9f43', '#7bd88f', '#e06fc0'];
      for (let i = 0; i < n; i += 1) {
        players.push({ name: names[i], color: colors[i], isAI: true, aiLevel: 'normal' });
      }
      // fresh：让浏览器型适配器先回到设置页、按这次的玩家配置重开一局
      const res = await adapter.reset(io, { players, fresh: true, aiCount: n, playerName: me });
      return {
        content: [{
          type: 'text',
          text: `开好了一局「${meta.name}」，你是 ${me}，对手 ${n} 个 AI。`
            + `${aiAdjusted ? `\n（你要的是 ${wanted} 个 AI 对手，但这个游戏至少要 2 名玩家，所以按 1 个开了。）` : ''}`
            + `${syncNote(res.synced)}\n\n${formatBoard(res.after)}`,
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `开局失败：${String(error?.message ?? error).slice(0, 300)}` }], isError: true };
    }
  }
);

server.tool(
  'game_look',
  '看一眼现在游戏里是什么局面（轮到谁、各家现金/地契/古董、最近发生了什么），'
  + '以及**现在能做哪些动作**（每个动作都带一个可以传回 game_act 的 id）。'
  + '动之前先看一眼，别凭记忆瞎动。',
  {
    game: z.string().optional().describe('游戏名（见 game_list）；只有一个游戏时可以省略'),
    withActions: z.boolean().optional().describe('是否一并列出可选动作，默认 true'),
  },
  async ({ game, withActions }) => {
    try {
      const meta = pickGame(game);
      const { adapter, io } = loadAdapter(meta._game);
      // browser-play 型：第一次调用时页面还没开/没开局 —— 替她开一局，
      // 否则她看到的永远是"还没有对局"，还得自己先调一次 game_reset。
      if (meta.kind === 'browser-play' && (!io.tab || !io.tab.targetId)) {
        io.tab = await io.play.open({});
        await new Promise((r) => setTimeout(r, 800));
      }
      const board = await adapter.observe(io);
      const acts = withActions === false ? null : await adapter.actions(io);
      return {
        content: [{
          type: 'text',
          text: `【${meta.name}】\n${formatBoard(board)}\n${acts ? `\n现在能做的：\n${formatActions(acts)}` : ''}`,
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `看不了局面：${String(error?.message ?? error).slice(0, 300)}` }], isError: true };
    }
  }
);

server.tool(
  'game_act',
  '做一个决定（掷骰子、买地、选方向、盗墓掷骰……）。`action` 用 game_look 列出来的那个 id。'
  + '做完它会**把之后的局面一起还给你** —— 所以别连着盲目调，看完结果再决定下一步。'
  + '如果要执行的动作现在不合法，它会告诉你合法的有哪些。',
  {
    game: z.string().optional().describe('游戏名；只有一个游戏时可以省略'),
    action: z.string().describe('动作 id（来自 game_look 的列表，比如 "roll" / "buy" / "skip"）'),
    args: z.record(z.string(), z.unknown()).optional().describe('可选参数（少数游戏需要，比如传送到哪一格）'),
  },
  async ({ game, action, args }) => {
    try {
      const meta = pickGame(game);
      const { adapter, io } = loadAdapter(meta._game);
      // browser-play 型：第一次调用时页面还没开/没开局 —— 替她开一局，
      // 否则她看到的永远是"还没有对局"，还得自己先调一次 game_reset。
      if (meta.kind === 'browser-play' && (!io.tab || !io.tab.targetId)) {
        io.tab = await io.play.open({});
        await new Promise((r) => setTimeout(r, 800));
      }
      const res = await adapter.act(io, action, args ?? {});
      if (res.ok === false) {
        return {
          content: [{
            type: 'text',
            text: `没做成：${res.error}`
              + `${res.legal?.length ? `\n现在合法的是：${res.legal.map((x) => `\`${x}\``).join('、')}` : ''}`,
          }],
          isError: true,
        };
      }
      return {
        content: [{
          type: 'text',
          text: `做完了${res.choice ? `（\`${res.choice}\`）` : ''}。${res.note ? `\n${res.note}` : ''}`
            + `${syncNote(res.synced)}\n\n**现在：**\n${formatBoard(res.after)}`,
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `没能做这个动作：${String(error?.message ?? error).slice(0, 300)}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());

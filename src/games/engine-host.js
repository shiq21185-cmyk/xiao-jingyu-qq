// 「引擎在 Node 里跑，页面负责显示」—— 2026-10-22 主人选的方案。
//
// 主人原话：「引擎算 + 同步到页面显示」「我偶尔想看看局面」。
//
// ── 为什么不走浏览器操作 ──────────────────────────────────────────────────
// 这个游戏的规则引擎（`js/engine.js`）和全部数据（`js/data.js`）**没有任何 DOM 依赖**，
// 实测在纯 Node 的 vm 里就能完整跑一局（开局→掷骰子→盗墓→买卖地契）。
// 走浏览器点按钮的代价是：
//   · 每步 200ms~8s（要等渲染）、可能卡死、可能把主人的窗口顶到前台；
//   · 每次代理重启还要主人点一次「允许远程调试」。
// 直接跑引擎：**一步几毫秒、不抢窗口、不需要授权**。
//
// 页面仍然有用 —— 主人偶尔想看看局面。所以引擎算完之后，把 state 写回页面
// （`window.__GAME_IO__.set(state)` + `rerender()`）。
//
// ⚠️ 页面那头是**尽力而为**：连不上/没授权/没钩子都不影响她继续玩，
//    只在结果里如实说"这次没同步到屏幕"。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/**
 * 在 Node 里加载一个游戏的引擎与数据。
 *
 * 这个游戏的文件是 `(function(global){...})(globalThis)` 的 UMD 风格，
 * 所以用一个 vm context 当 `global` 就能拿到 `GameData` / `Engine` / `AI`。
 *
 * @param {string} gameDir 游戏目录
 * @param {string[]} files 相对 gameDir 的脚本，按顺序执行（通常是 data.js, engine.js）
 */
export function loadEngine(gameDir, files) {
  const ctx = vm.createContext({
    console, Math, JSON, Date, Number, String, Array, Object, Set, Map,
    isNaN, parseInt, parseFloat, Infinity, NaN,
  });
  for (const rel of files) {
    const abs = path.join(gameDir, rel);
    const src = fs.readFileSync(abs, 'utf8');
    vm.runInContext(src, ctx, { filename: abs });
  }
  return ctx;
}

/**
 * 一个"引擎会话"：持有 state，提供 observe / actions / act。
 *
 * 与浏览器方案的差别只在**执行在哪**：这边是纯内存对象，
 * 所以"读局面"和"做决定"都是同步的、几毫秒。
 */
export class EngineSession {
  constructor({ ctx, state, gameDir }) {
    this.ctx = ctx;
    this.state = state;
    this.gameDir = gameDir;
  }

  get Engine() { return this.ctx.Engine; }
  get Data() { return this.ctx.GameData; }

  /** 把 state 压成给她看的摘要（和浏览器版保持同样的字段，免得两套说法）。 */
  observe() {
    const E = this.Engine;
    const D = this.Data;
    const s = this.state;
    const cur = E.currentPlayer(s);
    const pd = s.pending;
    return {
      turn: cur ? cur.id : null,
      turnName: cur ? cur.name : null,
      phase: s.phase,
      dice: s.dice || 0,
      survivorOnly: !!s.survivorOnly,
      winner: (s.winner != null) ? s.winner : null,
      winPending: (s.winPending != null) ? s.winPending : null,
      players: (s.players || []).map((p) => ({
        id: p.id,
        name: p.name,
        isAI: !!p.isAI,
        cash: p.cash,
        cell: p.cellId,
        cellName: (D.cells[p.cellId] && D.cells[p.cellId].name) || p.cellId,
        antiques: (p.antiques || []).length,
        deeds: (p.deeds || []).length,
        helpers: (p.helpers || []).length,
        bankrupt: !!p.bankrupt,
      })),
      pending: pd ? { kind: pd.kind, playerId: pd.playerId, options: pd.options || [], meta: pd.meta || {} } : null,
      lastLog: (s.log || []).slice(-8),
    };
  }

  /** 现在能做什么（**由引擎的 pending 决定**，不凭想象列）。 */
  actions(describe) {
    const pd = this.state.pending;
    if (!pd) return { actions: [{ id: 'auto', label: '继续（让游戏往下走一步）', kind: 'none' }], note: '现在没有待你决定的事' };
    return {
      actions: (pd.options || []).map((o) => ({
        id: String(o), label: describe ? describe(pd.kind, o, this.Data) : String(o), kind: pd.kind,
      })),
      kind: pd.kind,
      playerId: pd.playerId,
      meta: pd.meta || {},
    };
  }

  /**
   * 执行一个动作。
   *
   * 真实游戏里，"轮到 AI"和"回合该结束了"都不是 pending —— 所以这里要
   * **自动把该走的流程走掉**（startTurn / endTurn），直到又停下来等她决定，
   * 或者游戏结束。否则她看到的就是"做完了但没有任何变化"。
   */
  act(actionId) {
    const E = this.Engine;
    const s = this.state;
    const before = this.observe();
    const want = String(actionId ?? '');

    if (!s.pending) {
      // 没待决事项：把流程往前推
      this.advanceUntilChoiceOrEnd();
      return { ok: true, note: '当时没有待决事项，已让游戏继续', before, after: this.observe() };
    }
    const legal = (s.pending.options || []).map(String);
    if (legal.length && !legal.includes(want)) {
      return { ok: false, error: `这个动作现在不合法：${want}`, legal, before };
    }
    try {
      E.choose(s, want);
    } catch (e) {
      return { ok: false, error: `引擎报错：${e?.message || e}`, before };
    }
    this.advanceUntilChoiceOrEnd();
    return { ok: true, choice: want, before, after: this.observe() };
  }

  /**
   * 把"不需要她决定"的部分自动走掉。
   *
   * 规则：只要没有 pending、没有赢家，就轮到谁就让谁动 ——
   *   · 轮到她 → startTurn 会给出 pending（roll），停下等她；
   *   · 轮到 AI → 引擎没有内置"AI 自动决策"，这里给一个**最小合法策略**
   *     （永远选第一个选项），保证对局能继续。
   *
   * ⚠️ 这是有意的最小实现：她玩她自己的回合，AI 对手只需要"能走"。
   *    以后要更像样，可以把 js/ai.js 也载进来（它也大概率是纯逻辑）。
   */
  advanceUntilChoiceOrEnd(maxSteps = 200) {
    const E = this.Engine;
    const s = this.state;
    for (let i = 0; i < maxSteps; i += 1) {
      if (s.winner != null) return;
      if (s.pending) return;              // 停：等她决定
      const cur = E.currentPlayer(s);
      if (!cur || cur.bankrupt) { E.endTurn(s); continue; }
      // 回合开始（会设置 pending，通常是 roll）
      try { E.startTurn(s); } catch { /* 有的状态不需要 */ }
      if (s.pending) return;
      // 还在没有 pending ⇒ 这一位走完该换人了
      E.endTurn(s);
    }
  }

  /** 开一局新的。 */
  reset(options) {
    const E = this.Engine;
    this.state = E.newGame({ players: options.players });
    // 开局后先把第一位玩家的回合开起来，好让她一进来就有事可做
    this.advanceUntilChoiceOrEnd();
    return this.observe();
  }
}

/** 这个游戏"动作 id → 人话"的翻译（Node 版和浏览器版共用同一套说法）。 */
export function describeAction(kind, option, D) {
  switch (kind) {
    case 'roll': return '掷骰子';
    case 'buy-deed': return option === 'buy' ? '买下这块地' : '不买';
    case 'station-action': return option === 'teleport' ? '花 1000 元传送到别处' : '直接掷骰子';
    case 'hire': return `雇一个【${(D.helpersById[option] && D.helpersById[option].name) || option}】`;
    case 'direction': return option === 'cw' ? '往右走（古墓环线）' : (option === 'ccw' ? '往上走（环线逆行）' : '往下走（直达上海）');
    case 'tomb-roll': return '掷骰子（盗墓）';
    case 'tomb-reroll': return '用卦师重掷一次';
    case 'tomb-skip': return '放弃盗墓（不付村长费）';
    case 'tomb-choose': return `拿【${(D.antiquesById[option] && D.antiquesById[option].name) || option}】`;
    case 'teleport-dest': return `传送到【${(D.cells[option] && D.cells[option].name) || option}】`;
    case 'wenwuju-sell': return `把【${(D.antiquesById[option] && D.antiquesById[option].name) || option}】卖给文物局`;
    case 'raid-target': return `抢玩家 ${option} 的古董`;
    case 'raid-card': return `抢【${(D.antiquesById[option] && D.antiquesById[option].name) || option}】`;
    case 'sell-own': return option === 'skip' ? '不卖' : `把【${(D.antiquesById[option] && D.antiquesById[option].name) || option}】卖给来访者`;
    case 'owner-sell': return option === 'skip' ? '不卖给他' : `把【${(D.antiquesById[option] && D.antiquesById[option].name) || option}】卖给他`;
    case 'market-buy': return option === 'skip' ? '不买' : `买下【${(D.antiquesById[option] && D.antiquesById[option].name) || option}】`;
    case 'zhangdao': return `牺牲【${(D.helpersById[option] && D.helpersById[option].name) || option}】（栈道）`;
    case 'mortgage': return `抵押【${(D.antiquesById[option] && D.antiquesById[option].name) || (D.deeds[option] && D.deeds[option].name) || option}】抵债`;
    case 'sell-mode': return `第 ${option} 种卖法`;
    default: return String(option);
  }
}

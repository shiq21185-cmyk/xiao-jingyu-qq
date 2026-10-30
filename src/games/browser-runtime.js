// 「网页持有那一局，Node 替她做决定」—— 2026-10-22 定稿的执行层。
//
// ══ 为什么不沿用"Node 里跑引擎" ═════════════════════════════════════════════
// 主人的最终目的：「小鲸鱼可以自己打开网页自己玩，同时我可以看到她的行动」。
//
// "Node 里跑引擎"那版能算，但**界面不跟着动**：ui.js 的界面只认闭包里那份 state，
// `renderAll` 又是私有的，从外面塞一份 state 进去，页面还停在开局设置界面（实测过）。
//
// 真正的解法藏在 ui.js 里：它在启动时**包装了 Engine.choose**，每次 choose 之后都会
// `renderAll() + maybeAuto()`。所以只要让外部通过 `Engine.choose(state, choice)` 提交：
//   · 界面自动重画 —— 主人就能看见她的每一步；
//   · AI 对手由页面自己驱动（maybeAuto）—— 不需要两边各跑一份，也不会打架。
//
// ⇒ 职责这样分：
//    · **页面**：持有 state、渲染、驱动 AI（唯一执行者）
//    · **Node**：读局面（observe）、列合法动作（actions）、替她提交选择（act）
//
// 这样一来"我看得到她的行动"是**天然的**，不是事后同步。
//
// ⚠️ 代价：每步要一次 CDP 往返（~几十毫秒），比纯 Node 慢，但换来"真的看得见"。
//    这和主人选的那一档一致。
import fs from 'node:fs';
import path from 'node:path';
import { evalInPage, findOpenGameTab, openGamePage } from './io.js';
import { describeAction } from './engine-host.js';

const HOOK_VERSION = 4;

export function createBrowserIO(game, meta) {
  return {
    gameDir: game.dir,
    entry: meta.entry || 'index.html',
    describe: describeAction,

    /**
     * 打开游戏页并确保接口钩子就位，同时**开一局**。
     *
     * 每一步都尽量靠页面自己的流程（点它自己的「开始游戏」按钮），
     * 因为 ui.js 的开局还牵涉设置面板、遮罩、渲染、AI 调度一整套。
     */
    async open({ players, aiCount = 3, playerName = '小鲸鱼', fresh = false } = {}) {
      let tab = await findOpenGameTab(game);
      let opened = false;
      if (!tab?.targetId) {
        const page = await openGamePage(game);
        if (!page?.targetId) throw new Error('打不开游戏页（浏览器没在跑？）');
        tab = { targetId: page.targetId };
        opened = true;
        await new Promise((r) => setTimeout(r, 1800));
      }
      const targetId = tab.targetId;

      // 接口在不在？**这个游戏的接口就在它自己的 js/ui.js 里**（v4），
      // 由游戏自己暴露，不需要注入脚本。
      // ⚠️ 换别的游戏、它没暴露接口时，这里会停下并如实报 ——
      //    不要偷偷装钩子假装能用（那条路实测走不通，见 game_io_hook.js 文件头）。
      const has = await evalInPage(
        targetId,
        `String(typeof window.__GAME_IO__ === 'object' && window.__GAME_IO__ && Number(window.__GAME_IO__.__version) >= ${HOOK_VERSION})`,
      ).catch(() => 'false');
      if (has !== 'true') {
        throw new Error(`这个游戏页没有暴露 __GAME_IO__ 接口（需要版本 ≥ ${HOOK_VERSION}）。`
          + '接入方式见 qq-bridge-deploy/src/games/README.md：'
          + '在游戏自己的 ui/js 里暴露 get / pending / act / startViaUi 四件事。');
      }

      // 如果页面已经在一局里、而这次要开**新局**：先点它自己的「重新开始」回设置页。
      // （startGame 只在设置面板可见时有效；在游戏中点 btn-start 什么也不会发生。）
      if (fresh) {
        const inGame = await evalInPage(targetId,
          `String(!!(window.__GAME_IO__ && window.__GAME_IO__.get && window.__GAME_IO__.get()))`).catch(() => 'false');
        if (inGame === 'true') {
          // ★不能用点「重新开始」按钮★ 那个处理函数里有原生 `confirm()`，
          // 它会把页面 JS 线程彻底锁死 —— 连 CDP 的 eval 都进不来，
          // 表现为"游戏页假死 + 代理里挂一条 pending 命令"（2026-10-22 实测踩过）。
          // 所以走接口里的 restartToSetup()，它直接调内部的 showSetup()。
          const r = await evalInPage(targetId, `(function(){
            try {
              var io = window.__GAME_IO__;
              if (!io || typeof io.restartToSetup !== 'function') return JSON.stringify({ ok: false, error: '接口没有 restartToSetup' });
              return JSON.stringify(io.restartToSetup());
            } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
          })()`).catch((e) => JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
          let rr = { ok: false };
          try { rr = JSON.parse(r); } catch { rr = { ok: false }; }
          if (rr.ok === false) throw new Error(`回设置页失败：${rr.error}`);
          await new Promise((r2) => setTimeout(r2, 700));
        }
      }

      // 开局：点页面自己的「开始游戏」按钮（会用设置面板里勾的那些玩家）。
      const startOpts = JSON.stringify({ me: playerName || '小鲸鱼', aiCount });
      const start = await evalInPage(targetId, `(function(){ try { return JSON.stringify(window.__GAME_IO__.startViaUi(${startOpts})); } catch(e){ return JSON.stringify({ok:false,error:e.message}); } })()`)
        .catch((e) => JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
      let started = null;
      try { started = JSON.parse(start); } catch { started = { ok: false }; }
      if (started?.ok === false) throw new Error(started.error || '开局失败');

      // 点按钮之后页面要跑一轮 init/渲染/AI 调度，等它稳定下来
      await new Promise((r) => setTimeout(r, 1200));
      return { targetId, opened, started };
    },

    /** 读页面里那一局的摘要（和 Node 版字段保持一致，免得两套说法）。 */
    async observe(tab) {
      const raw = await evalInPage(tab.targetId, `(function(){
        try {
          var io = window.__GAME_IO__;
          if (!io) return JSON.stringify({ error: '接口没装好' });
          var s = io.get();
          if (!s) return JSON.stringify({ error: '还没有对局' });
          var E = window.Engine, D = window.GameData;
          var cur = E.currentPlayer(s), pd = s.pending;
          return JSON.stringify({
            turn: cur ? cur.id : null,
            turnName: cur ? cur.name : null,
            phase: s.phase,
            dice: s.dice || 0,
            survivorOnly: !!s.survivorOnly,
            winner: (s.winner != null) ? s.winner : null,
            winPending: (s.winPending != null) ? s.winPending : null,
            players: (s.players || []).map(function (p) {
              return {
                id: p.id, name: p.name, isAI: !!p.isAI, cash: p.cash,
                cell: p.cellId,
                cellName: (D.cells[p.cellId] && D.cells[p.cellId].name) || p.cellId,
                antiques: (p.antiques || []).length,
                deeds: (p.deeds || []).length,
                helpers: (p.helpers || []).length,
                bankrupt: !!p.bankrupt
              };
            }),
            pending: pd ? { kind: pd.kind, playerId: pd.playerId, options: pd.options || [], meta: pd.meta || {} } : null,
            lastLog: (s.log || []).slice(-8)
          });
        } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
      })()`);
      const data = JSON.parse(raw);
      if (data.error) throw new Error(data.error);
      return data;
    },

    /** 现在能做什么（由引擎的 pending 决定）。 */
    async actions(tab, board) {
      const b = board || await this.observe(tab);
      const pd = b.pending;
      if (!pd) {
        return { actions: [{ id: 'auto', label: '继续（让游戏往下走一步）', kind: 'none' }], note: '现在没有待你决定的事' };
      }
      // 动作描述在 Node 侧翻译（describeAction 需要 GameData，这里从页面取一份小表）
      const names = await evalInPage(tab.targetId, `(function(){
        var D = window.GameData;
        return JSON.stringify({
          cells: Object.fromEntries(Object.keys(D.cells).map(function(k){return [k, D.cells[k].name];})),
          antiques: Object.fromEntries(Object.keys(D.antiquesById).map(function(k){return [k, D.antiquesById[k].name];})),
          helpers: Object.fromEntries(Object.keys(D.helpersById).map(function(k){return [k, D.helpersById[k].name];})),
          deeds: Object.fromEntries(Object.keys(D.deeds).map(function(k){return [k, D.deeds[k].name];}))
        });
      })()`).catch(() => '{}');
      let n = {};
      try { n = JSON.parse(names); } catch { n = {}; }
      // 造一个"够 describeAction 用"的小 D（只要三张表）
      const dict = {
        cells: Object.fromEntries(Object.entries(n.cells || {}).map(([k, v]) => [k, { name: v }])),
        antiquesById: Object.fromEntries(Object.entries(n.antiques || {}).map(([k, v]) => [k, { name: v }])),
        helpersById: Object.fromEntries(Object.entries(n.helpers || {}).map(([k, v]) => [k, { name: v }])),
        deeds: Object.fromEntries(Object.entries(n.deeds || {}).map(([k, v]) => [k, { name: v }])),
      };
      return {
        actions: (pd.options || []).map((o) => ({
          id: String(o), label: describeAction(pd.kind, o, dict), kind: pd.kind,
        })),
        kind: pd.kind,
        playerId: pd.playerId,
        meta: pd.meta || {},
      };
    },

    /**
     * 替她做决定。
     *
     * 一次提交可能**只推进她这一步**：页面自己的 maybeAuto() 会接着驱动 AI，
     * 但那是异步的（有 1 秒左右的"AI 思考"停顿）。所以提交完要**等页面稳定**，
     * 再读局面 —— 否则她看到的还是"刚提交完、AI 还没动"的中间态。
     */
    async act(tab, actionId, { waitMs = 6000 } = {}) {
      // 提交前先记一份局面指纹 —— waitUntilIdle 靠"指纹变了"判断页面真的处理了这次提交。
      // （不能只看"待决的人是不是她"：提交那一瞬间 pending 还是旧的，会把旧快照当结果。）
      const beforeBoard = await this.observe(tab).catch(() => null);
      const res = await evalInPage(tab.targetId, `(function(){
        try { return JSON.stringify(window.__GAME_IO__.act(${JSON.stringify(String(actionId))})); }
        catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
      })()`);
      let out;
      try { out = JSON.parse(res); } catch { out = { ok: false, error: '页面返回无法解析' }; }
      if (out.ok === false) return out;

      // 等页面把 AI 回合走完、停下来等她决定（或分出胜负）
      const settled = await this.waitUntilIdle(tab, beforeBoard, waitMs);
      const after = await this.observe(tab);
      return { ok: true, choice: out.choice, after, waitedMs: settled.waitedMs, settled: settled.settled };
    },

    /**
     * 等页面把 AI 回合走完、重新停下来等她决定。
     *
     * ★判据必须是"状态真的变了"，不能只看"待决的人是不是她"★
     *
     * 踩过两个坑（2026-10-22，两次都是同一个根因：拿**提交前**的快照当结果）：
     *
     *   ① 只判断"待决的人是她" → 提交完那一瞬间 pending 还没更新、待决仍是她，
     *      于是在旧快照上立刻返回，看起来像"掷了骰子还要再掷"。
     *
     *   ② 改成"先观察到她离开、再等她回来" → 又踩了**采样盲区**：
     *      页面把回合从她切到 AI 是**一次同步跳变**（在同一帧里 pending 直接换人），
     *      我 250ms 才采一次样，很容易一次都没采到"离开"那一刻；
     *      于是 leftHerTurn 永远是 false，一直等满 5 秒超时。
     *      实测代价：每步稳定 5190ms（正好是 waitMs），而读一次只要 4-7ms。
     *
     * ⇒ 正确做法：**提交前先记一份局面指纹**，提交后等"指纹变了、且又停在她"
     *   （或者赢了 / 超时）。这样既不依赖"能采到中间态"，也不会把旧快照当结果。
     *
     * @param {object} before 提交前的局面（observe 的返回值）
     */
    async waitUntilIdle(tab, before, waitMs = 6000) {
      const t0 = Date.now();
      const sig = (b) => b && `${b.turn}|${b.dice}|${b.pending?.kind ?? '-'}|${b.pending?.playerId ?? '-'}|${b.winner ?? '-'}`;
      const beforeSig = sig(before);
      let last = null;
      while (Date.now() - t0 < waitMs) {
        await new Promise((r) => setTimeout(r, 200));
        try {
          const b = await this.observe(tab);
          last = b;
          if (b.winner != null) return { settled: true, waitedMs: Date.now() - t0, why: 'winner' };
          // 状态没变 ⇒ 页面还没处理完这次提交（或者它根本没生效）
          if (sig(b) === beforeSig) continue;
          const pd = b.pending;
          if (!pd) continue;                    // 过渡态（结算/动画中）
          const who = b.players?.[pd.playerId];
          if (who && !who.isAI) {
            // 状态已变、且又停在她 ⇒ 真的是她的新回合
            return { settled: true, waitedMs: Date.now() - t0, why: 'her-turn' };
          }
          // 状态变了，但停在 AI 回合 ⇒ 页面正在自动推进（AI 有约 1 秒"思考"停顿）。
          // 这时**不等它走完**：AI 之间可能连走好几步，硬等会把单步拖到 6 秒以上。
          // 她关心的是"我这一步生效了吗"，不是"AI 走完了吗" ——
          // 只要局面已经变了、且待决者不是她，就把当前局面交回去；
          // 下一次 game_look / game_act 自然会看到最新的（AI 走完后的）状态。
          return { settled: true, waitedMs: Date.now() - t0, why: 'ai-turn', aiStillPlaying: true };
        } catch { /* 页面在重排，继续等 */ }
      }
      return { settled: false, waitedMs: Date.now() - t0, why: 'timeout', last };
    },
  };
}

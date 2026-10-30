// 「引擎在 Node 里跑」这条路的总装：把适配器需要的东西拼成一个 `io`。
//
// 适配器只跟 `io` 打交道，所以它不需要知道：
//   · 引擎载入的是哪几个文件（meta.scripts 说的）
//   · 当前 state 存在哪儿（host 里）
//   · 页面同步是怎么做的（这里兜住所有失败）
//
// 这个文件的存在意义就一句：**把"能坏的地方"全部收在这里**，
// 让适配器保持简短、让换游戏只改适配器。
import fs from 'node:fs';
import path from 'node:path';
import { loadEngine, EngineSession, describeAction } from './engine-host.js';
import { installHook, evalInPage, findOpenGameTab, openGamePage } from './io.js';

/**
 * 建一个"引擎型"游戏的 io。
 *
 * @param {object} game 游戏（含 dir / adapter 路径）
 * @param {object} meta 适配器元数据（要 scripts / entry）
 */
export function createEngineIO(game, meta) {
  const scripts = Array.isArray(meta.scripts) && meta.scripts.length
    ? meta.scripts
    : ['js/data.js', 'js/engine.js'];
  for (const rel of scripts) {
    const abs = path.join(game.dir, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`游戏 ${meta.id} 的引擎脚本不在：${rel}（检查 adapter.js 里的 @adapter scripts）`);
    }
  }
  const ctx = loadEngine(game.dir, scripts);
  const host = new EngineSession({ ctx, state: null, gameDir: game.dir });

  return {
    host,
    describe: describeAction,
    gameDir: game.dir,
    entry: meta.entry || 'index.html',
    /**
     * 把 state 同步到网页（主人偶尔要看局面）。
     *
     * **全部失败都吞掉并如实回报**：他可能关着浏览器、可能没授权、可能没装钩子 ——
     * 这些都不该影响她继续玩，也不该让她以为"游戏出错了"。
     */
    async syncToPage(state, options = {}) {
      if (!state) return { ok: false, reason: 'no-state' };
      try {
        let tab = await findOpenGameTab(game);
        // ★autoOpen：开局时她自己去把页面开出来（主人 2026-10-22 要的）★
        //
        // ⚠️ **只能新开一个后台标签页，绝不覆盖主人正在看的那一页**：
        //    · `/new` 用的是 `Target.createTarget({ background: true })` —— 开在后台，
        //      不切走当前页（这一点是主人明确要求的，改动前必须重新确认）；
        //    · 这条路径上**没有任何 `/activate` 调用** —— 所以连"把标签页设成当前页"
        //      都不会发生。整条链上唯一会动标签页顺序的是代理的 /screenshot（截图前 activate），
        //      而玩游戏这条路不走截图。
        if (!tab?.targetId && options.autoOpen) {
          const page = await openGamePage(game);
          if (!page?.targetId) return { ok: false, reason: 'open-failed' };
          // 新开的页要等它加载完，再装钩子（装钩子会 reload 一次，所以要再等一轮）
          await new Promise((r) => setTimeout(r, 1500));
          const hookOk = await installHook(game, page.targetId).then(() => true).catch(() => false);
          if (hookOk) await new Promise((r) => setTimeout(r, 1500));
          tab = { targetId: page.targetId };
        }
        if (!tab?.targetId) return { ok: false, reason: 'page-not-open' };
        // 钩子在不在？不在就先装（装完会 reload 一次，状态会丢 —— 所以只在"页面没钩子"时做）
        const has = await evalInPage(tab.targetId, `String(typeof window.__GAME_IO__ === 'object' && window.__GAME_IO__.__version >= 2)`)
          .catch(() => 'false');
        if (has !== 'true') {
          await installHook(game, tab.targetId);
          return { ok: false, reason: 'hook-installed-need-retry', targetId: tab.targetId };
        }
        // 把 state 序列化塞进去（**只传数据**，不传代码）
        const json = JSON.stringify(state);
        await evalInPage(tab.targetId, `(function(){
          try { window.__GAME_IO__.set(JSON.parse(${JSON.stringify(json)})); }
          catch (e) { return 'set-failed:' + (e && e.message); }
          var r = window.__GAME_IO__.rerender();
          return 'ok:' + r;
        })()`, 15000);
        return { ok: true, targetId: tab.targetId };
      } catch (error) {
        // 连不上代理 / 没授权 / 页面没了 —— 都不是"游戏坏了"
        return { ok: false, reason: String(error?.message ?? error).slice(0, 120) };
      }
    },
    /** 让页面自己先把这一局渲染出来（开新局时用）。 */
    async ensurePage(state) {
      try {
        const page = await openGamePage(game);
        return { ok: true, targetId: page.targetId, opened: page.opened };
      } catch (error) {
        return { ok: false, reason: String(error?.message ?? error).slice(0, 120) };
      }
    },
  };
}

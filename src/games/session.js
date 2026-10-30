// 「玩一局」的会话器：把"打开游戏 → 装钩子 → 观察 → 行动"串成一条线。
//
// 为什么单独一层：适配器不该关心"页面开没开、钩子装没装、targetId 是哪个"——
// 它只该回答"现在什么局面、能做什么、做这个动作"。这些杂事在这里收口，
// 以后接第二个游戏时适配器能保持很短（几十行）。
import { installHook, openGamePage, evalInPage, findOpenGameTab } from './io.js';

const HOOK_FLAG = '__GAME_IO__';

/**
 * 打开一个游戏并确保钩子就位，返回一个可以直接交给适配器的会话。
 *
 * @returns {Promise<{targetId:string, evalInPage:Function, ready:boolean, notes:string[]}>}
 */
export async function openSession(game) {
  const notes = [];
  const page = await openGamePage(game);
  const targetId = page.targetId;
  if (page.opened) notes.push(`新开了游戏页（${page.url}）`);

  // ① 页面里已经有钩子了吗？
  const has = await evalInPage(targetId, `String(typeof window.${HOOK_FLAG} === 'object' && window.${HOOK_FLAG} ? 'yes' : 'no')`)
    .catch(() => 'no');
  if (has !== 'yes') {
    await installHook(game, targetId);
    notes.push('已给这一页装上接口钩子（并重新加载了一次）');
  }

  // ② 钩子装好后可能还没有对局（页面停在设置页）——
  //    适配器自己决定要不要开局，这里只如实说。
  const started = await evalInPage(targetId, '(window.__GAME_IO__ && window.__GAME_IO__.get) ? String(!!window.__GAME_IO__.get()) : "no-hook"')
    .catch(() => 'unknown');
  return {
    targetId,
    ready: started !== 'no-hook',
    hasGame: started === 'true',
    notes,
    evalInPage: (expr, timeoutMs) => evalInPage(targetId, expr, timeoutMs),
  };
}

/** 只是确保页面开着（不装钩子），给"只想看一眼"的场景用。 */
export async function ensurePage(game) {
  const existing = await findOpenGameTab(game);
  if (existing) return { targetId: existing.targetId, opened: false };
  const page = await openGamePage(game);
  return { targetId: page.targetId, opened: true };
}

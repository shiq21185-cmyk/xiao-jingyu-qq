# 网页游戏接入层（给小鲸鱼的「游戏接口」）

> 主人 2026-10-22：「我在 小鲸鱼的游戏 里面放入了第一个游戏，能不能让小鲸鱼直接接入这里
> 去玩游戏」，并明确要的是**接口**：「以后这里可能也会放其他的游戏，都是网页的，
> 不专门针对某一个」。后来又补了一句关键信息：
> **「我放在这里的是整个网页游戏的源码，所以你的操作空间会很大」** ——
> 于是执行层选了**直接在 Node 里跑游戏引擎**，页面只负责显示。
>
> 他选的方案：「引擎算 + 同步到页面显示」「我偶尔想看看局面」。

所以这一层长这样：**协议固定，游戏可插拔，执行方式按游戏的能力选。**

```
小鲸鱼的游戏/
├── 1.guwan-dafuweng/          ← 一个游戏一个目录（编号前缀随意）
│   ├── index.html             ← 游戏本体，原样不动
│   ├── js/data.js, js/engine.js  ← 纯逻辑，被 Node 直接载入
│   ├── game_io_hook.js        ← 可选：页面钩子（显示用）
│   └── adapter.js             ← ★ 接入一个游戏，只需要这一个文件
└── 2.未来的游戏/
    └── adapter.js
```

加法：**在游戏目录里放一个 `adapter.js`**，`game_list` 里就自动出现。
不需要改 `src/games/`、不需要改 MCP server、不需要重启桥接（每次现读目录）。

---

## 三种执行方式（`@adapter` 的 `kind`）

| kind | 什么时候用 | 代价 |
| --- | --- | --- |
| **`node-engine`** ⭐ | 游戏有**纯逻辑引擎**（不依赖 DOM）。引擎与数据被 Node 直接载入，state 存在内存里 | 一步几毫秒；**不需要浏览器、不需要点「允许」、不抢窗口** |
| `engine` | 引擎和状态都在页面里（状态在闭包，靠钩子掏出来） | 每步 ~200ms；需要 CDP 授权 |
| `ui` | 只能靠点按钮推进 | 每步 200ms~8s；可能把窗口顶到前台 |

**《古玩大亨》走的是 `node-engine`** —— 实测 `js/engine.js` 与 `js/data.js`
**零 DOM 依赖**，在 Node 的 vm 里能完整跑一局（开局→掷骰子→盗墓→买卖地契→AI 对手）。

> 🔑 **先说清一件事**：`node-engine` 这条路**完全不经过浏览器**，
> 所以"引擎算"和"页面显示"是两件独立的事：
> 算永远成功（只要游戏文件在），显示是尽力而为（页面没开/没授权都只是没显示）。

---

## 协议：适配器实现三个（可选四个）能力

`adapter.js` 是**一段函数体**，必须 `return` 一个对象。
它拿到一个参数 `GameIO`，里面有：

| 成员 | 用途 |
| --- | --- |
| `io.host` | **`node-engine` 型专用**：Node 里的引擎会话（`observe/actions/act/reset` + `state`） |
| `io.describe` | 动作 id → 人话（`describeAction`，Node 与浏览器共用同一套说法） |
| `io.syncToPage(state)` | 把 state 写回网页并尝试重绘（失败只回报，不抛） |
| `io.evalInPage(expr)` | 浏览器型用：在页面里跑一段表达式 |
| `io.gameDir` / `io.entry` | 游戏目录与入口页 |

**没有** `require` / `fs` / `fetch`：适配器是被信任的本地代码，但它不需要这些能力。

```js
// @adapter {"name":"游戏名字","kind":"node-engine",
//   "scripts":["js/data.js","js/engine.js"],
//   "entry":"index.html","about":"一句话说明"}
//     ↑ 这行是给 game_list 用的（纯数据，读它不执行任何代码）。
//       ⚠️ 允许多行，但每行开头的 // 会被自动剥掉（踩过：不剥就 JSON.parse 失败，
//          kind 读成 unknown，于是 io.host 没挂上）。

return {
  async observe(io) { return io.host.observe(); },
  async actions(io) { return io.host.actions(io.describe); },
  async act(io, actionId) {
    const res = io.host.act(actionId);
    const synced = await io.syncToPage(io.host.state).catch(() => ({ ok: false }));
    return { ...res, synced };
  },
  async reset(io, options) {
    const after = io.host.reset(options);
    const synced = await io.syncToPage(io.host.state).catch(() => ({ ok: false }));
    return { ok: true, after, synced };
  },
};
```

**换游戏时通常只需要改**：`observe` 里的"局面摘要"、`actions` 里的"动作描述"。
载入引擎、推进回合、同步页面这三件事可以照抄 `1.guwan-dafuweng/adapter.js`。

---

## `node-engine` 是怎么把整局跑起来的

`src/games/engine-host.js`：

1. `loadEngine(gameDir, scripts)` —— 用 `vm.createContext` 当 `global`，
   按顺序执行游戏自己的 `data.js` / `engine.js`（它们是 `(function(global){…})(globalThis)` 风格）。
2. `EngineSession` 持有 `state`，提供 `observe / actions / act / reset`。
3. **`advanceUntilChoiceOrEnd()`** —— 这条最重要：
   真实游戏里"轮到 AI"“回合该结束"都不是 `pending`，所以每次动作后要把流程自动走掉，
   直到又停下来等她决定、或者分出胜负。否则她看到的就是"做完了但什么都没变"。
   - 轮到她 → `startTurn` 给出 `pending`，停下等她；
   - 轮到 AI → 用**最小合法策略**（永远选第一个选项）保证对局能继续。

> ⚠️ AI 目前是"能走就行"，不是聪明对手。要更像样，可以把游戏的 `js/ai.js` 也载进来
> （它也大概率是纯逻辑），这是下一步很简单的事。

---

## 安全边界（和「网页上的手」同一档）

| 边界 | 在哪 |
| --- | --- |
| 四个工具**只给管理员私聊** | `plugins/qq-agent-presets/qq-tool-restrict.mjs` 的 `GAME_TOOLS` |
| 游戏目录限定在 `小鲸鱼的游戏/`，`..`/盘符/绝对路径一律拒 | `src/games/index.js` 的 `resolveInsideRoot` |
| 她只能传「游戏名 + 动作 id」，**没有任意 JS / 文件 / 网络** | `src/mcp-games.js` |
| 注入页面的脚本只来自本仓库的 `game_io_hook.js` | `src/games/io.js` |

⚠️ **适配器本身是被信任的**：`adapter.js` 会在桥接进程里执行（`new Function`）。
所以别把来路不明的 `adapter.js` 丢进游戏目录。

---

## 工具

| 工具 | 干什么 |
| --- | --- |
| `game_list` | 本机接了哪些游戏 |
| `game_look` | 看当前局面 + 现在能做哪些动作 |
| `game_reset` | 开一局（会清掉正在进行的对局） |
| `game_act` | 做一个决定（做完把之后的局面一起还给你） |

全部只给**主人私聊**。群里/普通成员私聊调用会被拒，理由是"能替人做决定"。

---

## 加一个游戏，四步

1. 把游戏目录拷进 `小鲸鱼的游戏/`（原样）。
2. 看它有没有纯逻辑引擎（`js/engine.js` 之类，不碰 `document`）。
   - 有 → `kind: node-engine`，在 `@adapter` 里写 `scripts` 指向那几个文件；
   - 没有 → 用 `kind: ui`，靠点按钮。
3. 写一份 `adapter.js`（抄参考实现）。
4. `game_list` 看一眼它出现了没有。

---

## 已知限制

- **state 只在内存里**：桥接重启 = 当前对局丢失（`ioCache` 是进程内存）。
  想存盘的话，下一步可以在 `EngineSession` 里加一个 `state.json` 落盘。
- **自适应 AI**：AI 对手只会选第一个合法项，不是真会玩。
- **页面显示是尽力而为**：`syncToPage` 需要网页开着 + 装过钩子 + CDP 连得上。
  这条**不影响她玩**，只是她玩的时候你可能看不到屏幕在动。
- **同时只能玩一个游戏**：底层只有一个"当前局面"的概念。

# LOCAL-PATCH — qq-bridge 本地改动记录

这个目录是 [web-access](https://github.com/eze-is/web-access) 的 **vendored 副本**（v2.6.0，一泽Eze）。
小鲸鱼"和主人一起看网页 / 动手操作网页"的能力靠它：MCP 工具 → `127.0.0.1:3456` → 本目录的 `cdp-proxy` → 主人日常那个 Edge（带登录态）。

**为什么要抄一份而不是直接用**：qq-bridge 是 git 仓库，把第三方代码放进去会污染 `git status`；
所以也可以放在仓库外面，作为 qq-bridge 与 SnowLuma 的兄弟目录。

---

## 2026-10-22：给她加了一只「手」

主人原话：「现在的小鲸鱼只能看网页，不能操作，我想让她可以操作网页，给她加一个手」。

他选的档（当场问的，不是猜的）：
1. **只在他私聊里放行** —— 群里、普通成员私聊完全没有。
2. **点、填字、滚动、按键、选下拉** —— **不含上传文件**。

### 能力落在哪三层

| 层 | 文件 | 管什么 |
| --- | --- | --- |
| 守卫（执行期） | `plugins/qq-agent-presets/qq-tool-restrict.mjs` → `WEB_HAND_TOOLS` | 六个工具**只给管理员私聊**；排在 `SAFE_PREFIXES` 之前判（否则 `mcp__web-search-safe__` 前缀会整包放行） |
| MCP 层 | `src/mcp-web-search-safe.js` | 只暴露六个受控动作：`web_click` / `web_type` / `web_key` / `web_scroll` / `web_select` / `web_whats_there`。**没有任意 JS** |
| 代理层 | 本目录 `scripts/cdp-proxy.mjs` | `/setFiles` **永远 403**（不跟只读开关走）；新增 `/type` `/key` `/select` `/wheel` `/activate` |

`src/cdp-browser.js` 里是"手"的实现（点击/填字/滚动/按键/选下拉/列元素 + 密码框拦截）。

### 新增的代理端路由

| 路由 | 干什么 | 为什么不用上游现成的 |
| --- | --- | --- |
| `GET /activate?target=` | 把那页切前台 | `/new` 建的是**后台**页，后台页里鼠标/滚轮事件到不了页面 |
| `GET /wheel?target=&delta=` | 滚动 | 见下面「滚动那条坑」 |
| `POST /type?target=` | 填字（`{selector?, text, submit?, clear?}`） | 走 `Input.insertText`：真实输入事件，React/Vue 受控组件才认 |
| `POST /key?target=` | 按键（`{key}`） | 只放一组安全常用键，不做组合键 |
| `POST /select?target=` | 选下拉（`{selector, value\|label\|index}`） | 选中后要补 `input`/`change` 事件，受控组件才认 |

### 「允许远程调试」到底什么时候要点（2026-10-22 查清）

主人当场问的：「怎么需要使用手的时候，我每次都要点这个浏览器的允许，我不是在一键启动里面就打开过一次了吗」。

**实测结论：这个确认是「按 CDP 连接」的，不是「按浏览器实例」的。**

| 情形 | 要不要点 |
| --- | --- |
| 代理那条连接还活着 | **一次都不用点**（本机从 10-18 连到 10-22 中间没点过） |
| 浏览器重启了 / 代理进程被杀后重启 | 新连接要重新确认一次 |
| Edge 只剩后台进程、没有可见窗口 | 永远等不到确认 —— 因为弹窗长在一个看不见的窗口里 |

证据：手工开一条全新的 WebSocket 到 Edge 的调试口，**8 秒内零回音**
（既无 `open` 也无 `error`，就是吊着等你点）；而代理自己的那条老连接一直 `connected: true`。

### 为此改了三处（都在"别平白无故重连"上）

**① `cdp-connection.mjs` 加握手超时。**
旧实现没有这条：socket 的 HTTP upgrade 被浏览器吊住时，`flight` Promise **永远不结算** ⇒
`/health` 一直 `connected:false`、每个请求都挂在同一个 flight 上、而且**不报错**，
用户只看到"卡住"。现在超时就关 socket 并 reject 一个 `code='CDP_HANDSHAKE_TIMEOUT'` 的错误，
文案直说"多半是在等你在 Edge 里点允许"。

**② `cdp-proxy.mjs` 改成"没人用就不重连"+ 指数退避。**
- 空闲时**绝不主动重连**（连接活着就一直用同一条）；
- 真的断线才连，间隔 5s → 10s → … 封顶 5 分钟；
- 判定为"在等授权"时退避直接拉到 **30 分钟**，只在日志里提示一次 —— 不反复撞弹窗；
- 有真实请求进来时立刻试一次（`reconnect.reset()`），不等退避；
- `/health` 新增 `waitingForAuth` / `nextRetryMs`，上层不用猜 `connected:false` 的原因。

**③ `launcher/launch-all.ps1` 先看再动手。**
以前不管三七二十一先跑一次 `check-deps`（等于把好好的连接又闯一遍，白多要一次授权）。
现在先读 `/health`：`connected === true` 就整段跳过，一个字都不打扰；
只有真在等授权（`waitingForAuth`）才把 Edge 提到前台让你点。

> 回归：`scripts/test-cdp-reconnect.mjs`（8 项，假 WebSocket，不碰真浏览器）钉住
> 「握手超时必须报错而不是挂住」「已连接时反复 connect 不新建 socket」「断线后能连回来」。

### 2026-10-22 真机踩过的三个坑（都改了，别再犯）

**① 后台标签页里，所有鼠标/滚轮事件都到不了页面。**
`/new` 用的是 `Target.createTarget({ background: true })`，那一页 `document.visibilityState === 'hidden'`。
在这上面发 `Input.synthesizeScrollGesture`：`window.scrollY` 一动都不动；点链接：事件发出去了，不导航。
⇒ 手在动手之前先 `/activate` 把页面切前台。这也顺带让主人看得见她在点哪儿。

**② 先算坐标、再切前台 → 点偏。**
切前台会让页面**重排**（滚动条消失、视口变宽），之前算的 `getBoundingClientRect` 就过期了。
实测表现极阴险：`/clickXY` 返回 `{clicked:true}`，链接却纹丝不动，而"点完再测"又看不出问题。
⇒ 顺序必须是 **切前台 → 定位 → 立刻点**（`clickElement` 里就是这么写的）。

**③ `Input.dispatchMouseEvent({type:'mouseWheel'})` 会把 CDP 堵死 30 秒。**
实测：发出去之后代理一直不回话，30 秒后报 `CDP 命令超时: Input.dispatchMouseEvent`，
既没滚动又把连接占了半分钟。换成 **`Input.synthesizeScrollGesture`**（`yDistance: -delta`）就好了：
它真的产生滚动输入（无限滚动的站点也认），而且会正常结算。

**④ `target=_blank` 的链接点了不开在本页。**
只看本页 URL 会得出"点了没反应"的错判断。所以 `clickElement` 点之前记一份标签页快照，
点完对比：冒出新的就把 `newTab: { targetId, url, title }` 一起回给她 —— 她接着用那个新 targetId。

### 不上传文件这一条为什么单独一层

`/setFiles` 在 `UPLOAD_BLOCKED` 里，而 `BLOCKED_ROUTES = READONLY ? (UPLOAD ∪ HANDS) : UPLOAD`。
也就是说：**只读开关只能增加拦截项，永远减不掉上传那一条**。
主人挑的就是「点填滚按选」这一档 —— 把本机文件塞进网页是另一件事，要给得单独再说一次。

### 想回到"只能看"（不建议）

启动代理时设 `WEB_ACCESS_READONLY=1`，`/click` `/clickAt` `/clickXY` `/type` `/key` 全部 403
（上传本来就已经是 403）。默认不设 = 手是放开的。

> ⚠️ 注意与旧版补丁的**语义反了**：2026-10-16 那版是 `READONLY !== '0'`（默认**开**），
> 现在是 `READONLY === '1'`（默认**关**）。这样"没设环境变量"的含义是"手放开"，
> 与主人 2026-10-22 的决定一致；而"只读"成了一次显式选择。

---

## 改了哪些文件（累积）

### `scripts/cdp-proxy.mjs`

**① 动作白名单 + 只读开关（约第 30 行）**

```js
const UPLOAD_BLOCKED = new Set(['/setFiles']);
const HANDS_BLOCKED = new Set(['/click', '/clickAt', '/clickXY', '/type', '/key']);
const READONLY = process.env.WEB_ACCESS_READONLY === '1';
const BLOCKED_ROUTES = READONLY ? new Set([...UPLOAD_BLOCKED, ...HANDS_BLOCKED]) : UPLOAD_BLOCKED;
```

**② handler 开头的拦截（约第 270 行）**：`BLOCKED_ROUTES` 命中就 403，上传与只读两组各给各的理由。

**③ `/targets` 加 `mine` 字段**：`mine: true` = 本代理用 `/new` 开的；`false` = 主人自己的页。

**④ `/close` 只能关自己开的页**：不是 `managedTabs` 里的就 403。
（`managedTabs` 在 `onDisconnect` 时清空，所以**代理重启后**旧页会退化成 `mine:false` → 关不掉。
失败的偏向是"不许关"，安全。）

**⑤ 新增 `/activate` `/type` `/key` `/select` `/wheel`**（见上表）。

---

## 一个已知的上游小毛病：优雅 stop 会被 stale 记录卡住

`proxy-maintenance.mjs stop` 在 `managedTabs.size > 0` 时会拒绝，回 `{"status":"busy",...}`。
但 `managedTabs` **只在 `/new` 时增、在 `/close` 时减**；如果标签页是被别的方式关掉的（主人手关、浏览器崩），
这条记录会一直挂着，直到闲置清扫（`CLEANUP_INTERVAL`）把它清掉。

**绕过办法**：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*cdp-proxy*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
node scripts\check-deps.mjs
```

**改完 cdp-proxy.mjs 必须重启代理才生效**（它是长驻进程），
而重启 = 一条新的 CDP 连接 = **Edge 会再弹一次「是否允许远程调试？」**，让主人点一下「允许」。


---

## 升级 web-access 时怎么做

1. 下载新版，覆盖本目录（`scripts/` `references/` `templates/` `SKILL.md` `README.md` `AGENTS.md`）。
2. **重新打上面那几处补丁**（用 `grep -n "BLOCKED_ROUTES\|WEB_ACCESS_READONLY\|managedTabs.has" scripts/cdp-proxy.mjs` 确认）。
3. 那五个新路由（`/activate` `/type` `/key` `/select` `/wheel`）也要一并补回去 —— 它们不在上游里。
4. 验一遍：
   ```bash
   node scripts/check-deps.mjs                                              # 期望 exit=0
   curl -s -X POST "http://127.0.0.1:3456/setFiles?target=x" -d '{}'        # 期望 403 上传被禁
   node --test ../../scripts/test-web-hand.mjs                              # 期望 16 passed
   ```
5. 更新本文件顶部的版本号与日期。

---

## 配置（不在本目录）

`%USERPROFILE%\.web-access\config.env`（UTF-8 无 BOM + LF）：

```
WEB_ACCESS_BROWSER=%LOCALAPPDATA%\Microsoft\Edge\User Data
WEB_ACCESS_CDP_PORT=
```

`WEB_ACCESS_CDP_PORT` 留空 = 用 `<数据目录>/DevToolsActivePort` 里写着的端口。

## 前置条件（浏览器侧，改不了）

Chromium 136+ 已经**禁用命令行 `--remote-debugging-port`**，所以必须由主人在 Edge 里手动开：

> 地址栏打开 `edge://inspect/#remote-debugging`，勾选 **"Allow remote debugging for this browser instance"**

**好消息**：不用重启 Edge，不丢标签页（本机 Edge 148.0.3967.83 实测）。
**坏消息**：这是浏览器内的开关，状态存在 Edge 自己的 profile 里 —— 如果哪天它自己关了，小鲸鱼读网页会失败，报错会明确提示去勾选（见 `browser-discovery.mjs` 的 `INSPECT_HINT`）。

## 顺手记一件事

`cdp-proxy` 返回 200 **不等于页面渲染完了**。2026-10-16 实测小黑盒那篇：
`/new` 立刻返回 targetId，但 `document.body.innerText.length === 0`、截图纯白；
1 秒后同一条 URL 就是 `ready=complete, innerText=9160 字`。
所以 MCP 侧的 `web_read_link` 内置了轮询（见 `src/cdp-browser.js` 的 `waitForPage`），不要直接读第一次结果。

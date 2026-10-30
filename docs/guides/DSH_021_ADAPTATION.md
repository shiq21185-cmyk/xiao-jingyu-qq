# DSH 0.2.1 适配记录（qq-bridge v0.2.1-r1）

> **本文的边界**：只记录**为对齐 DSH 0.2.1-rc.2 而做的改动**。每条给出：现象 / 为什么必须改 / 证据 / 怎么验证。
> 复核后**判定兼容、因此没改**的部分在 §4 —— "没改"同样是结论。
>
> 适配目标：`@deepseek-ai/dsh` **0.2.1-rc.2**（本机实测版本；上一版适配目标 0.2.0-rc.2，
> 记录见 [DSH_020_ADAPTATION.md](DSH_020_ADAPTATION.md)）。本文写于 2026-10-26。
>
> 版本身份：桥接 `v0.2.1-r1`（版本号方案见 DSH_020 附录 H：主版本与 DSH 同步，
> `r1` = 0.2.1 线第 1 次发布）。

---

## 0. 一句话结论

**业务逻辑零改动**；两处真实断裂，其中第一处本机早已规避、**但它的回归网写反了**：

| 级别 | 问题 | 影响 | 本版处置 |
|---|---|---|---|
| **P0** | 提示词变量 **`cwd` 在 0.2.1 被删除**（agent loop 只注册 `provider` / `model` / `response_language`） | 带 `{{cwd}}` 的 preset，**每个回合**在系统提示词装配阶段直接 error ⇒ QQ「完全不回」 | persona 早已写死、不受影响；**改掉两处要求 `{{cwd}}` 必须存在的反向断言** |
| **P1** | `dsh-base` 新增默认挂载 `working-directory`，全局层多出 **`working_directory`** | QQ 仿真会话 schema 继承它（L7 注册期要求被破坏）；执行期白名单仍拒绝调用 | 守卫名单补 16 个名字（67 → 83） |

改动全部落在 **preset 断言 + 守卫名单 + 版本号**，`src/bridge.js` 一行没动。

---

## 1. 协议层：没动

本机 DSH `0.2.1-rc.2` 下，桥接的协议代次（Cookie 鉴权 / 斜杠 RPC / `/api/remote.mux` 事件流）
与 0.2.0 无差异：`src/dsh-client.js` 钉的 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`
仍然讲得通 0.2.1 的线协议。传输层是唯一一个版本滞后的依赖，每次升级都要靠
`verify:adaptation` 盯住（见 §5 的已知局限）。

> 本版**没有重跑**活体协议断言（`verify:adaptation` 在本机跑不起来，见 §5）。
> 0.2.0 那一轮的 75 项实测记录见 [DSH_020_ADAPTATION.md](DSH_020_ADAPTATION.md)。

---

## 2. 断裂点一（P0）：`cwd` 变量被删除 ⇒ 每回合直接 error

### 2.1 现象

```
turn/start {"turn":1}
turn/end   {"turn":1,"reason":{"kind":"error","error":{
             "message":"unknown prompt variable \"{{cwd}}\" in section \"deployment:persona-suffix\";
                        registered variables: provider, model","code":"UNKNOWN"}},"text":""}
```

没有 `assistant/message`、没有 `tool/call` —— 模型根本没被调用。
QQ 侧的现象是「发消息没反应」，日志里只有一行空输出。

### 2.2 证据（本机 0.2.1-rc.2 实测）

从 DSH 安装目录的 `<安装目录>/resources/app.asar` 里扫 `systemPrompt.variable(` 注册的名字：

```
provider, model, response_language
```

`cwd` **不在其中**。同一份 asar 里 `interpolate()` 的实现确认是 **fail loud**：

```js
if (!Object.hasOwn(variables, name)) {
  const known = Object.keys(variables);
  throw new Error(`unknown prompt variable "{{${name}}}" in ${kind} "${input.name}";
                   registered variables: ${known.join(", ")}`);
}
```

即：不是渲染成空串，是直接抛错。

### 2.3 本机为什么没炸

`dsh/agent-presets/qq-chat*/agent.cordis.yml` 的 persona `suffix` **早就写死成文本**了
（`Your working directory is the qq-bridge-deploy folder of this project ...`），没写 `{{cwd}}`。
所以桥上这条链一直是通的。

### 2.4 但回归网是反的（本版真正修的）

两个校验脚本原先这样断言：

```js
check(`preset ${p}: 保留 {{model}} / {{cwd}} 变量`,
  /\{\{model\}\}/.test(row.config.prefix) && /\{\{cwd\}\}/.test(row.config.suffix ?? ''));
```

它要求 `{{cwd}}` **必须存在** —— 恰好是会让整条回话链炸掉的写法。
方向反了：**能跑的状态判红，炸掉的状态判绿。**

### 2.5 改法

改成「**只允许** DSH 已注册的提示词变量」的双向对账：

```js
const REGISTERED_PROMPT_VARS = new Set(['provider', 'model', 'response_language']);
// 扫出 preset prefix + suffix 里所有 {{var}}，与上面求差
```

同步改了两个文件：

- `scripts/verify-dsh-021-adaptation.mjs`（原 `verify-dsh-020-adaptation.mjs`）
- `scripts/verify-persona-config.mjs`

与既有的 `test-qq-preset-contract.mjs`（断言 `suffix` **不得**出现 `{{cwd}}`）互为印证。

### 2.6 怎么验证

```powershell
node scripts/test-qq-preset-contract.mjs   # 11/11
node scripts/verify-persona-config.mjs     # 需先解决 §5 的模块解析问题
```

---

## 3. 断裂点二（P1）：`working_directory` 进了仿真会话

### 3.1 证据

本机守卫的 apply 日志（`~/.dsh/logs/desktop-next-2026-10-26.0.jsonl`）实测：

```
known global tools: list_mcp_resource_templates, list_mcp_resources,
                    ops_read_files, read_mcp_resource, working_directory
```

`working_directory` **在全局层**。来源可查：`dsh-base/cordis.patch.yml` 现在无条件挂载
`working-directory` + `tool-working-directory` 两行，所有 preset 都继承。

### 3.2 为什么是安全问题而不是清洁问题

L7 要求仿真会话的 preset **注册期**就不得含本地能力。`tools.guard` 只在执行期拒绝，
工具名仍留在模型 schema 里 —— 既违反注册期要求，也会诱导模型去调它。
`working_directory` 能改写会话工作目录，属于「本地环境状态」，不是 QQ 动作面能力。

> 执行期白名单这一层**没有失效**：`working_directory` 不在 `SAFE_EXACT` / MCP 前缀里，
> 调用照样被拒（`verdictFor()` 实测）。这是「第二层兜住了」，不是「没问题」。

### 3.3 同轮新增的名字

| 名字 | 来源 | 为什么算危险 | 本机状态 |
|---|---|---|---|
| `terminal_open` / `_send` / `_read` / `_signal` / `_close` / `_list` | `dsh-tool-terminal`（0.2.1 转正） | 终端 = 直接 shell | 未启用 |
| `session_search` / `session_trace` / `session_event_read` / `session_event_search` / `session_event_trace` | `dsh-tool-session-query`（0.2.1 新增） | 跨会话读事件正文 ⇒ 把别的聊天记录递给 QQ 群 | 未启用 |
| `plugin_market` | `dsh-plugin-market`（0.2.1 新增） | 插件装载权 = 任意代码执行 | 未启用 |
| `create_worktree` / `wait_agent` | 实验包 | 写盘 + git 进程 / team 家族同族 | 未启用 |
| `ops_read_files` | **dsh-ops 0.4.1（本机装的）** | 直接读工作区文件 | **已在全局层** |

⚠️ `ops_read_files` **上游 v0.2.1-r1 的名单里也没有** —— 它是本机装了 `dsh-ops` 才出现的，
这条是本机自己加的。

`subagent_codex` / `subagent_claude_code` 在 0.2.1 改为按需安装（默认扫不到），
保留在名单里但算作「可选组」，不参与假名判定。

### 3.4 怎么验证

```powershell
node scripts/test-preset-local-tools.mjs   # 7/7
```

守卫名单长度实测 **83**（67 + 16），新增名字全部命中。

---

## 4. 逐条核对 0.2.1 变更：判定"无需改动"

| 0.2.1 变更 | 对桥接的影响 | 处置 |
|---|---|---|
| 移除运行时 `invariant` 插件与 `./invariant` 导出 | 桥接与三个 bundle 都没用 | 无 |
| 子路径插件不再读独立 `package.json` | `qq-mode-console` 是普通单入口插件 | 无 |
| 输入区统计扩展拆成 `activity` / `usage` | 桥接与插件都没有 composer 统计扩展 | 无 |
| 移除工具展示 `both` 混合模式 | preset 里没有配置 `presentation` | 无 |
| `agent-instructions` 逐行 `dshHome` 移除 | QQ preset 未挂 `agent-instructions` | 无 |
| Agent Team 消息改投目标 Inbox | 未启用 team 模式 | 无 |
| 子代理工具立即返回 child ID | 桥接不依赖子代理返回体 | 无 |
| 自动化任务改为 Web 内置（`schedule` 转正） | 守卫早已覆盖 `schedule_*` | 无 |
| API Key 优先级变更 | 桥接走 Cookie 铸造 + MCP，不读 API Key | 无 |
| `modelCatalog` 仍给 `deepseek-flash` | 桥接默认模型不变 | 无 |
| **提示词变量表移除 `cwd`** | **persona suffix 与两处断言** | **§2 已改** |
| **`dsh-base` 默认挂 `working-directory`** | **全局工具面多一个名字** | **§3 已改** |

---

## 5. 对账工具的 asar 支持（本版已修）

**修正 §5 的旧结论**：早期草稿说"`verify:adaptation` 在本机跑不起来，留待单独处理"。
本版已经把它修好了 —— 它是**这一轮适配的必要前提**（没有对账工具就没法确认工具面）。

### 5.1 根因

DSH 桌面版把 `@deepseek-ai/*` 全打在 `<安装目录>/resources/app.asar` 里，磁盘上
没有可解析的 `node_modules`。旧实现只认磁盘目录，于是：

| 脚本 | 旧症状 |
| --- | --- |
| `verify:adaptation` / `verify-persona-config` | `ERR_MODULE_NOT_FOUND`，根本跑不起来 |
| `scan-dsh-tool-names.mjs` | 扫到 **0 个工具名**，把 46 个**真实存在**的名字报成「假名」 |

「假名」这个方向特别危险：它会逼人把真名字从守卫名单里删掉，等于自己拆安全边界。

### 5.2 修法

`scripts/dsh-modules.mjs`：

- **asar 定位**：环境变量 → **从 DSH 自己的日志里抽 `resources/app.asar` 路径**
  （stack trace 里写着真实安装位置，比猜盘符稳）→ 常规布局兜底。不硬编任何盘符。
- **按需读文件**：`readDshFile` / `listDshDir` 磁盘与 asar 两种布局通用。
- **按需抽包再 import**：`importFromDsh` 把用到的包（含依赖闭包）抽到临时目录再 import。

`scripts/dsh-tool-names.mjs`：补包级**前缀拼装**（`ops_` 常量与工具名不在同一文件）、
工具顺序数组、`profiles/<p>/node_modules` 插件目录。

### 5.3 踩过的三个坑

1. **`queued` 必须在入队时去重**，不能只靠出队后标记的 `copied`。依赖图有环时同一个包
   会被反复推回队列，每轮都对 180 MB 的 asar 重走 `listDshDir` —— 表现为**进程挂死**。
2. **不能把整个 asar 读进内存**。180 MB 常驻后抽 700+ 文件时峰值会压死进程，
   症状是**静默退出**（连 `process.on('exit')` 都不触发）。改成只缓存 JSON 文件树。
3. **原生包不进依赖闭包**。`node-addon-*` 抽出来再 import 会让进程硬崩。

### 5.4 结果

```
node scripts/verify-dsh-021-adaptation.mjs   → 77 通过 / 0 失败（本机首次全绿）
node scripts/test-preset-local-tools.mjs     → 7/7
npm run scan:tool-names                      → 456 包 / 83 个真实名字；假名 0、漏网 0
```

---

## 6. 下次 DSH 升级的增量清单

沿用 [DSH_020_ADAPTATION.md §10](DSH_020_ADAPTATION.md)，本轮补充：

1. **`verify:adaptation` 必须有「真跑一回合」**：静态断言看不出提示词变量被删。
2. **先看守卫 apply 日志里的 `known global tools`** —— 它是「全局层到底有什么」的第一手证据，
   新增名字基本等于 1 个必须补的守卫条目。别只看 `restrict ok=` 的分子。
3. **提示词变量断言要用「只允许已注册」的口径**，不要写成「必须含某个变量」——
   0.2.1 这一轮正是这样把炸掉的状态判成了绿。

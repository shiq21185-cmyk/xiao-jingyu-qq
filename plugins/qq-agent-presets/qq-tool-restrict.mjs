// QQ 桥接安全硬边界：只允许 QQ MCP 工具与少量无害模型侧工具。
//
// 本文件是 qq-agent-presets bundle 里的**唯一权威实现**，由 qq-chat / qq-chat-v2 两个
// agent preset 的 qq-tool-restrict 行共同引用（dsh/agent-presets/<preset>/qq-tool-restrict.mjs
// 只是个 re-export 壳，避免出现两份会漂移的实现）。
//
// 为什么引用方式是「包名/子路径」而不是 `./qq-tool-restrict.mjs`（DSH 0.1.7 的机制变化）：
//   0.1.5 的 preset 是 ~/.dsh/.agent-presets/<preset>/ 目录，相对名按 preset 目录解析；
//   0.1.7 的 preset 变成一条 loader 行，子行 name 按**声明它的 loader 上下文**
//   （= profile 目录 file:///…/.dsh/profiles/<profile>/）解析，因此 `./x.mjs` 会去找
//   profile 根目录下的文件（不存在）。bundle patch 文件只对 insert 行自己的 name 做
//   「相对 patch 文件锚定」（dsh-app-boot 的 anchorInsertedPluginNames），不会走进
//   preset 行的 config.plugins —— 所以守卫只能用**从 profile 目录可解析的裸说明符**。
//   该包以 link: 依赖注册在 profile package.json，node_modules junction 由
//   scripts/setup-dsh.mjs（或 dsh-super-injector 的 dev_heal_links）维护：
//   不写死任何绝对路径，仓库搬家后重建链接即可。
// 作用：
//  1) 用 tools.restrict 把本地执行/文件类工具与开发工具从**工具清单**里隐藏（注册期）；
//  2) 用 tools.guard 白名单兜底：任何不在允许范围内的工具，执行时一律拒绝。
//
// ⚠️ 第 1 条是铁律 L7 的落点，不是"附注"：仿真会话的 preset 永不包含本地工具。
//    `tools.guard` 只能拒绝**执行**，工具名仍会出现在模型的 schema 里——
//    那既不满足"仿真会话不得拥有本地执行能力"的注册期要求，也会诱导模型去调它。
//    所以本地工具必须同时出现在下面的 restrict 名单里。
// ── 主人判定（按 QQ 号）──────────────────────────────────────────────────────
// 为什么需要它：仿真 preset 在**两个会话里都挂着**（主人私聊 / 群聊），但执行期
// guard 拿不到 QQ 会话 key —— 它只看得到 `exec.agent.session.id`。
// 桥接把「private:<ownerQQ> → sessionId」记在 state/sessions.json 里，
// 于是「这一轮是不是主人私聊」可以由**会话 id 反查 QQ 号**得出，而不必猜前缀。
//
// ⚠️ fail-closed：找不到仓库根 / 读不到文件 / 会话不在表里 / ownerQQ 没配
//    ⇒ 一律当成「不是主人」，需要主人的工具（BILI_OWNER_ONLY）全部拒绝。
//    绝不因为"读不到"就放宽 —— 这正是最容易写出越权的那条路。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/**
 * 从守卫文件往上找仓库根。
 *
 * 用两个标记（`state/sessions.json` + `config.json`）而不是写死路径 ——
 * 这个 bundle 是以 junction 挂进 profile 的（~/.dsh/plugins/qq-agent-presets → 仓库），
 * Node 默认对 import 做 realpath，所以通常向上 2 层就是仓库根；
 * 但 `--preserve-symlinks` 下就不是。向上找标记对两种情况都成立，也别写死某台机器的盘符。
 */
function findRepoRoot() {
  let dir
  try { dir = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))) } catch { return null }
  for (let i = 0; i < 6; i++) {
    try {
      if (fs.existsSync(path.join(dir, 'state', 'sessions.json'))
        && fs.existsSync(path.join(dir, 'config.json'))) return dir
    } catch { /* 读不了就继续往上找 */ }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

// guard 每次工具调用都会跑 ⇒ 给文件读取一个短缓存（跟插件那边的口径一致，2 秒）。
let ownerCache = { at: 0, sessions: new Map(), owner: '' }
const OWNER_CACHE_MS = 2000

function ownerLookup() {
  const now = Date.now()
  if (ownerCache.sessions.size > 0 && now - ownerCache.at < OWNER_CACHE_MS) return ownerCache
  const root = findRepoRoot()
  if (root === null) {
    ownerCache = { at: now, sessions: new Map(), owner: '' }
    return ownerCache
  }
  const cfg = readJsonSafe(path.join(root, 'config.json'))
  const raw = cfg?.ownerQQ
  const owner = (raw === undefined || raw === null || String(raw).trim() === '') ? '' : String(raw).trim()
  const sessions = new Map()
  const s = readJsonSafe(path.join(root, 'state', 'sessions.json'))
  for (const [key, sid] of Object.entries(s?.sessions ?? {})) {
    if (typeof sid === 'string' && sid !== '') sessions.set(sid, key)
  }
  ownerCache = { at: now, sessions, owner }
  return ownerCache
}

/**
 * ⭐ 三类会话判定（2026-10-19，主人要求"处理好各种权能关系"）。
 *
 * QQ 这边一共三类：
 *   1. **管理员私聊** —— 主人自己（ownerQQ）的私聊。全权。
 *   2. **群聊**       —— 任何 `group:` 会话。群友都在里面，最不受信。
 *   3. **普通成员私聊** —— 白名单里**除主人以外**的 QQ 私聊。这次新增的一类。
 *
 * ⚠️ 为什么需要第三类：以前只有"主人 / 非主人"二分，于是**普通成员私聊**在权限上
 *    和主人私聊**一模一样**（都是 reserved2、同一 preset、同一工具面）——
 *    他可以让小鲸鱼**发 QQ 空间说说**、**发语音条**、**给名单里任何人发私聊**。
 *    那等于"任何人都能借她的号公开发声"。⇒ 现在把这类单独拎出来，只给聊天能力。
 *
 * 判据仍然只用**会话 id 反查**（守卫看不到 QQ 会话 key，只有 exec.agent.session.id）：
 *   群聊      = key 以 `group:` 开头
 *   主人私聊  = key === `private:<ownerQQ>`
 *   普通成员  = 其余 private 会话（含"反查不到"的情形？**不** —— 见下）
 *
 * 🔴 fail-closed 的落点：反查不到会话（新会话尚未落表、文件读不到、ownerQQ 没配）
 *    一律归为 **member（最不信任的那类私聊）**，绝不是 owner。
 *    这样"读不到状态"只会让能力**变少**，不会凭空变多。
 *    但要注意：这同时也意味着"反查不到"的会话连**跨会话信息面**也不给（好友列表、
 *    机器人在哪些群、群成员、群历史、她的空间列表）—— 对群聊无影响
 *    （群聊按前缀已判定），对主人私聊则要求 sessions.json 里有映射
 *    （桥接建会话时就写，正常不会缺）。
 *    ⭐ 2026-10-19 起，发声类（语音/说说）**不再**受这一档限制：它们对所有会话开放，
 *    见下方 OWNER_PRIVATE_ONLY 的说明。
 */
const SESSION_KIND = Object.freeze({
  OWNER_PRIVATE: 'owner-private',
  MEMBER_PRIVATE: 'member-private',
  GROUP: 'group',
})

function sessionKind(agent) {
  const sid = agent?.session?.id
  if (typeof sid !== 'string' || sid === '') return SESSION_KIND.MEMBER_PRIVATE
  const { sessions, owner } = ownerLookup()
  const key = typeof sessions.get(sid) === 'string' ? sessions.get(sid) : null
  if (key === null) return SESSION_KIND.MEMBER_PRIVATE   // 反查不到 ⇒ 最不信任
  if (key.startsWith('group:')) return SESSION_KIND.GROUP
  if (owner !== '' && key === `private:${owner}`) return SESSION_KIND.OWNER_PRIVATE
  return SESSION_KIND.MEMBER_PRIVATE
}

export const name = 'qq-tool-restrict'

export const inject = ['tools']

/**
 * 本地执行 / 文件访问 / 进程控制类工具：仿真会话**不得**拥有。
 *
 * 名字**逐个核对过** DSH 0.1.7-rc.2 实际注册的工具名（来源包见每条注释），
 * 不是凭印象列举。教训：本名单初版把 `pwsh_persistent`/`bash_persistent`/
 * `cordis`/`goal_write`/`goal_read` 当成工具名，这五个**根本不存在**——
 * 而 `tools.restrict()` 对未知名字会抛错、被下面的 try/catch 逐个吞掉，
 * 于是坏名字**静默失效**。`test-preset-local-tools.mjs` 现在会把本数组与
 * DSH 真实工具名集合求差，专门防这类拼写假名。
 *
 * 2026-09-27 针对 0.1.7-rc.2 重新对账（不是逐个打补丁）：`dsh-tool-cordis` 仍在，
 * 但 `cordis_define`/`cordis_undefine`/`cordis_run`/`cordis_stop` 四个名字**已被删除**，
 * 现在只注册 `cordis_inspect_list`/`cordis_inspect_query`——旧名字留在名单里
 * 只会换来四条静默失效的 restrict（正是本名单最怕的失败模式），
 * 而新名字能读宿主运行期状态，属于必须隐藏的那一类，所以是**替换**不是删除。
 * 同一轮对账还补上了 0.1.7 新增的两个能力：
 *   - `load_workspace_dependencies`（自带 Python/Node/pnpm 的绝对路径 ⇒ 等于递上执行能力）
 *   - `list_subagent_models`（派生 agent 家族，暴露宿主模型路由配置）
 *
 * 来源包（0.1.7-rc.2）：
 *   dsh-tool-pwsh / -pwsh-persistent   → pwsh（persistent 变体注册的就是 "pwsh"）
 *   dsh-tool-bash / -bash-persistent   → bash（同上）
 *   dsh-tool-fs                        → read / read_image / write / edit
 *   dsh-tool-fs-search                 → glob / grep
 *   dsh-tool-str-replace-editor        → str_replace_editor
 *   dsh-tool-workspace-dependencies    → load_workspace_dependencies
 *                                        （返回内置 Python/Node/pnpm 的绝对路径）
 *   dsh-tool-subagent                  → subagent / subagent_fork / list_subagent_models
 *   dsh-tool-subagent-control          → send_message / interrupt_agent / list_agents
 *   dsh-tool-workflow / -ralph         → workflow / ralph
 *   dsh-tool-jobs                      → job_list / job_output / job_kill
 *   dsh-tool-todo / -skill / -present  → todo_write / skill / present
 *   dsh-tool-goal                      → get_goal / create_goal / update_goal
 *   dsh-tool-cordis                    → cordis_inspect_list / cordis_inspect_query
 *                                        （读宿主运行期状态；0.1.7 已无装载类工具名）
 *   dsh-plugin-guard（web profile bundle）→ dsh_snapshot / dsh_rollback / incident_resolved
 *                                        （读写 package.json/lockfile/patch 并 **spawn pnpm**）
 *   dsh-mode-boost（已装插件，当前未进 bundles）→ dev_mode_set / _status / _subagent
 *                                        （dev_mode_subagent 会派生 agent）
 *
 * ⚠️ 硬证据：2026-08-29 的一次 **qq-chat-v2 仿真会话**记录下来的工具清单里，
 * 除了 MCP 工具就只有 `ask_user_question`、`todo_write`、`dev_mode_*`、
 * `dsh_rollback`、`dsh_snapshot`、`incident_resolved`。也就是说
 * **`dsh_snapshot`/`dsh_rollback` 真的进过仿真会话的 schema**——本名单初版漏了它们。
 *
 * 2026-09-29 针对 DSH 0.2.0-rc.2 重新对账（同样不是逐个打补丁，而是拿安装包重扫）。
 * 对账工具：`node scripts/scan-dsh-tool-names.mjs`（可重复运行；它从已安装的
 * `@deepseek-ai/dsh-*` 里抽真实工具名，与本名单求双向差）。
 * 该轮结论：**旧名字全部还在**（0 个假名，0.1.7 那次替换后没有再次改名），
 * 但 0.2.0 的包里多出 13 个「危险语义」名字是名单没覆盖的，逐条判定如下：
 *
 *   ① 真的会进仿真会话、必须隐藏的（它们在**全局层**，所有 preset 都继承）：
 *      · `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`
 *        —— `dsh-base` 的 `mcp-resources` 行**默认启用**（cordis.patch.yml 里没有
 *        disabled），所以每个 QQ 会话都会继承这三个工具。`read_mcp_resource` 的
 *        `server` 参数可以指向**任意已配置的 MCP server**：用户一旦挂了
 *        filesystem 之类的能力型 MCP，QQ 群就通过它拿到了文件读取权。
 *        这正是 L7 要挡的那类越权路径，因此必须从 schema 里隐藏。
 *   ② 会派生 agent / 执行外部代码（当前只在 DSH 自带 preset 里挂载，QQ preset 不挂；
 *      列进来是**回归网**：别的 composition 一旦把它们推进全局层就被挡住）：
 *      · `subagent_codex` / `subagent_claude_code`（Codex / Claude Code 子智能体）
 *      · `spawn_teammate` / `team_task_create|get|list|update`（实验性 Team 模式）
 *   ③ 等于把插件装载权交出去 ⇒ 任意代码执行：
 *      · `plugin_manager`（安装/卸载/启停插件，内部会 spawn pnpm）
 *   ④ 无人值守的自我调度（`dsh-schedule`，0.2.0 起是可选 bundle）：
 *      · `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`
 *
 * 2026-10-26 针对 DSH 0.2.1-rc.2 重新对账（本机实测，`state/tool-restrict.log`
 * 的 known global tools 里**确实**出现了 `working_directory`）。0.2.1 把若干能力
 * 从「实验组合包」转正，工具面因此变了三处：
 *   ① **新增一个真的会进仿真会话的全局工具**：`dsh-base` 现在默认挂
 *      `working-directory` + `tool-working-directory` 两行，于是 `working_directory`
 *      和 `list_mcp_resources` 一样属于**全局层继承** —— QQ 会话一定拿得到，
 *      必须从 schema 隐藏（执行期白名单本来就会拒它，但 L7 要求的是**注册期**）。
 *   ② 新增终端能力 `dsh-tool-terminal`（`terminal_open|send|read|signal|close|list`）：
 *      终端 = 直接 shell，是本名单第一优先级要挡的东西；当前 composition 没启用，
 *      列进来是**回归网**（一旦被插件市场/组合包装上就自动挡）。
 *   ③ 新增会话历史检索 `dsh-tool-session-query`
 *      （`session_search|trace`、`session_event_read|search|trace`）：
 *      能跨会话读事件正文 ⇒ 等于把别的聊天记录递给 QQ 群，列进来。
 *   另有两个「装载权」入口同轮补上：`plugin_market`（插件市场，等价 plugin_manager）
 *   与 `create_worktree`（写盘 + 起 git 进程）、`wait_agent`（team 家族同族）。
 *
 * ⚠️ `ops_read_files`（dsh-ops 0.4.1，本机已装且**已在全局层**）—— 上游名单也没有，
 *    这里补上：本机 known global tools 实测含它，能直接读工作区文件。
 *
 * ⚠️ 0.2.1 把 Codex / Claude Code 从内置 preset 改成**按需安装的可选插件**，
 *    因此 `subagent_codex` / `subagent_claude_code` 在默认安装里**不存在**——
 *    restrict 对它们必然抛错。但用户一旦装上那两个组合包，名字就会回到全局层，
 *    所以保留在名单里（`scan-dsh-tool-names.mjs` 把它们算作「可选组」排除出假名判定）。
 */
const LOCAL_EXECUTION_TOOLS = [
  // shell / 进程
  'pwsh', 'bash',
  // 文件读写
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  // 文件检索
  'glob', 'grep',
  // 自带运行时（Python/Node/pnpm 的绝对路径）⇒ 等于把"跑代码"递给模型
  'load_workspace_dependencies',
  // 派生 agent 与编排（都能间接拿到 shell）
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  // 插件/cordis 运行期检查：能读宿主状态（0.1.7 起只有这两个名字）
  'cordis_inspect_list', 'cordis_inspect_query',
  // 本机文件 + 进程：plugin-guard 会改写配置并 spawn pnpm
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 会话/交付/任务面
  // 注意：`todo_write` 与 `ask_user_question` **故意不在**此名单——它们是下面
  // SAFE_EXACT 允许的无害模型侧工具，两边不能自相矛盾。
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  // 0.2.0 新增对账（见上方长注释的 4 类判定）：
  //   ① 全局层默认启用 ⇒ 真的会进仿真会话
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  //   ② 派生 agent / 执行外部代码
  'subagent_codex', 'subagent_claude_code',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  //   ③ 插件装载权（= 任意代码执行）
  'plugin_manager',
  //   ④ 无人值守的自我调度
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // 0.2.1 新增对账（见上方长注释）：
  //   ① 全局层默认挂载 ⇒ 真的会进仿真会话
  'working_directory',
  //   ② 终端 = 直接 shell
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  //   ③ 跨会话读事件正文 ⇒ 把别的聊天记录递给 QQ 群
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
  //   插件市场 / 写盘 + git / team 家族
  'plugin_market', 'create_worktree', 'wait_agent',
  // ── dsh-ops（本机装的第三方插件，上游名单完全没有）──────────────────────
  // 它把官方文件/执行工具换成 `ops_` 前缀的一整套，**能力等价甚至更全**：
  // read_files / glob / grep / inspect_local_file / read_table / read_docx / read_pdf
  // 能读文件，write_file / edit_file / replace / copy / move / remove / stat / diff
  // 能写盘，bash / pwsh 能直接执行命令。
  // 名字来自包内 `rawName` 与 `fileOrder` 数组，经 `publicToolName()` 拼上 `ops_`，
  // 所以静态扫描要按包级前缀拼装才看得见（见 scripts/dsh-tool-names.mjs）。
  // 唯一**不**拦的是 `ops_discover_tools`（纯能力发现，无副作用，见 SAFE_EXACT 侧）。
  'ops_bash', 'ops_pwsh',
  'ops_read_files', 'ops_read_table', 'ops_read_docx', 'ops_read_pdf',
  'ops_glob', 'ops_grep', 'ops_inspect_local_file',
  'ops_write_file', 'ops_edit_file', 'ops_replace', 'ops_copy', 'ops_move', 'ops_remove',
  'ops_stat', 'ops_diff',
  // 已装但当前未进 bundles 的插件（一旦加回就是新口子）
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
]

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  // 本地执行面（见上）
  ...LOCAL_EXECUTION_TOOLS,
  // dsh-super-injector / 开发注入器（0.1.7-rc.2 实测注册的全局工具）
  // 说明：这些名字是**运行时**才出现的（注入即注册、卸载即消失），所以只能尽力 restrict；
  // 真正的边界是下面的执行期白名单。
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_plugin_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

// 供 test-preset-local-tools.mjs 导入并与 DSH 真实工具名对账，避免两份名单漂移。
export const RESTRICTED_TOOL_NAMES = Object.freeze([...KNOWN_DANGEROUS_GLOBAL_TOOLS])

// 执行期白名单：不在这些范围内的工具一律拒绝。
// 前缀覆盖 DSH MCP client 暴露的命名空间工具。
// 注意：前缀白名单是「整包放行」。所以**包里有比"读"更重的东西时不能只靠前缀**：
// mcp__web-search-safe__ 现在同时住着只读工具和那只「手」（web_click 等），
// 手的六个名字在 verdictFor 里**单独、更早**判一次（见 WEB_HAND_TOOLS）——
// 它排在 SAFE_PREFIXES 之前，所以前缀放行到不了它们。
// ⚠️ 这条注释就是一条纪律：以后往这个包里加**任何**会改外部世界的工具，
//    都必须同时加进 WEB_HAND_TOOLS（或另起一个更早判的名单），否则等于默认放给群聊。
// 同一类处理还有 mcp__snowluma__ 前缀 vs OWNER_PRIVATE_ONLY：也是先判后的。
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
  // ⚠️ 手机控制（adb）**不在**前缀白名单里了：它改成「要授权才放行」，
  //    见下面的 PERMIT_TOOL_SCOPES。只读的 mcp__phone__phone_status 单独放行
  //    （她得先能看一眼设备在不在线，否则连"能不能玩"都判断不了）。
]

/**
 * 「三类会话一律放行」的**显式名单**（2026-10-26 加）。
 *
 * 为什么要有这一份：上面 SAFE_PREFIXES 是**整包放行**，所以一个新增的 MCP 工具
 * 如果没人记得去 verdictFor 里先判一次，它就从第一天起对所有会话开放 ——
 * 判定的默认值是「允许」，而默认值应该是「必须有人明确表态」。
 * 2026-10-26 的审计就是这么发现 `web_read_current` / `web_list_tabs` 漏出去的
 * （它们读的是主人自己屏幕上的浏览器，却跟着前缀落进了"三类全开"）。
 *
 * ⚠️ 这份名单**不是权限真相**，真相永远是 `verdictFor()`（名单里的名字照样要过
 *    各道在先的判定）。它只是把「我确实决定让它三类都开」这件事写下来，
 *    好让 `scripts/test-tool-classification.mjs` 能对账：
 *      · 任何 MCP 工具在群聊/普通成员私聊里被放行，就必须在这份名单里；
 *      · 名单里的每个名字都必须真实存在（防手误、防删了工具忘删名字）。
 *    也就是说：**新工具要么在这里登记，要么在 verdictFor 里被更早地拒掉**，
 *    两条路都不走的话测试会红。
 */
export const OPEN_TO_ALL_SESSIONS = new Set([
  // —— 聊天必需（mcp__snowluma__）——
  'mcp__snowluma__qq_send_message', 'mcp__snowluma__qq_send_group_message',
  'mcp__snowluma__qq_send_private_message', 'mcp__snowluma__qq_reply',
  'mcp__snowluma__qq_send_burst', 'mcp__snowluma__qq_send_poke',
  'mcp__snowluma__qq_get_recent_messages', 'mcp__snowluma__qq_get_unread_messages',
  'mcp__snowluma__qq_get_my_recent_messages', 'mcp__snowluma__qq_get_message_detail',
  'mcp__snowluma__qq_get_message_images', 'mcp__snowluma__qq_get_forward_msg',
  'mcp__snowluma__qq_mark_read', 'mcp__snowluma__qq_wait_for_messages',
  'mcp__snowluma__qq_status', 'mcp__snowluma__qq_social_state',
  'mcp__snowluma__qq_get_prompt', 'mcp__snowluma__qq_get_active_members',
  'mcp__snowluma__qq_set_wake_config', 'mcp__snowluma__qq_request_permission',
  // —— 约定 / 轻量记忆 / 黑话 / 日记 ——
  'mcp__snowluma__qq_promise', 'mcp__snowluma__qq_promise_done',
  'mcp__snowluma__qq_memory_append', 'mcp__snowluma__qq_memory_query',
  'mcp__snowluma__qq_memory_remove', 'mcp__snowluma__qq_memory_clear',
  'mcp__snowluma__qq_slang_query', 'mcp__snowluma__qq_slang_submit',
  'mcp__snowluma__qq_write_diary', 'mcp__snowluma__qq_read_diary',
  // —— 图库 / 表情 ——
  'mcp__snowluma__qq_photo_list', 'mcp__snowluma__qq_get_photo_image',
  'mcp__snowluma__qq_send_photo', 'mcp__snowluma__qq_photo_note',
  'mcp__snowluma__qq_list_stickers', 'mcp__snowluma__qq_get_sticker_image',
  'mcp__snowluma__qq_send_sticker', 'mcp__snowluma__qq_collect_sticker',
  'mcp__snowluma__qq_sticker_note', 'mcp__snowluma__qq_set_sticker_remark',
  // —— 发声：整个号都是她的，发声不算隐私面（另有 socialV2.tools 开关）——
  'mcp__snowluma__qq_say', 'mcp__snowluma__qq_send_voice', 'mcp__snowluma__qq_list_voices',
  // —— 生图 / 发图：**管理员私聊 + 群聊**，普通成员私聊不开 ——
  //
  // 记录一下这段口径的来龙去脉（别再改错方向）：
  //   · 一开始（2026-10-29 上午）只给管理员私聊，理由是「按张计费（一张 ¥0.038）+
  //     图会真发进会话，群里可能变刷屏」。
  //   · 主人先说「开放给全体」，我照做放成了三类全会话。
  //   · 主人随即校正（m01927 原话：「我的意思只是让群里面也开放生成图，和其他好友
  //     不需要开」）—— **群要开，别人的私聊不开**。群是公开场合，她想发图得能画；
  //     一对一私聊一开，等于预算对每个陌生人都敞开。
  //   ⇒ 判定不在这个集合里做（这个集合只是给 scripts/test-tool-classification.mjs
  //     用的"三类通用"登记表），真正判定见下方 OWNER_AND_GROUP_TOOLS。
  //   想放开到全部私聊：把两行挪进 OPEN_TO_ALL_SESSIONS；想收回只给主人：
  //   挪进 OWNER_PRIVATE_ONLY，同时 config.json 的 socialV2.image.scope = "owner"。
  // —— 空间写操作：守卫不限会话，但桥接强制「只有她自己起的回合」才放行 ——
  'mcp__snowluma__qq_send_qzone_msg', 'mcp__snowluma__qq_qzone_like',
  'mcp__snowluma__qq_qzone_comment', 'mcp__snowluma__qq_qzone_delete',
  'mcp__snowluma__qq_qzone_set_right',
  // —— 上报问题（工具消失会让她以为"连上报都坏了"，所以永远注册；见 mcp server）——
  'mcp__snowluma__qq_report_feedback',
  // —— 刷B站 · 只读 ——
  'mcp__web-search-safe__bili_video',
  // —— 搜索 / 抓公开网页（MCP 版，不是 DSH 原生那两个）——
  //
  // ⚠️ 这两个是 2026-10-26 审计时**被迫表态**的一格，记在这里免得下次再有人问：
  //    · `mcp__web-search-safe__web_fetch` 与 DSH 原生的 `web_fetch` 同名不同源。
  //      原生的那个只给管理员私聊（理由见上面 OWNER_PRIVATE_ONLY_DSH_TOOLS：
  //      参数是任意 URL，能把"出口 IP / 读钓鱼页"这种事外包给群友）。
  //      MCP 这个走 `src/safe-fetch.js`：禁内网/环回/CGNAT/NAT64、先 DNS 解析全部
  //      结果再连（防 rebinding）、**逐跳重定向重新校验**、限时限量，而且没有主人登录态。
  //      群里本来就允许 `web_read_link`（借主人浏览器读链接），所以"群里能抓公开网页"
  //      是既有口径，不是这一格新开的；这里只是把它写明白。
  //    · `web_search` 只回搜索结果列表，不读任何本机/主人侧状态，无风险。
  // 如果哪天想收紧（让群里只能用 web_read_link），把这两行删掉并加进
  // OWNER_PRIVATE_ONLY_DSH_TOOLS 即可 —— scripts/test-tool-classification.mjs 会立刻盯着。
  'mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch',
  // —— 读别人给的链接（带 DNS + 逐跳重定向校验；理由见 SAFE_PREFIXES 上方注释）——
  'mcp__web-search-safe__web_read_link', 'mcp__web-search-safe__web_read_more',
  'mcp__web-search-safe__web_see', 'mcp__web-search-safe__web_close',
  // —— 网关探活（只读）——
  'mcp__snowluma-host__snowluma_status',
])

/**
 * DSH 原生 `web_fetch`（2026-10-21 新增）——**只给管理员私聊**。
 *
 * 它和 web_search 是同一个包里的兄弟，但能力完全不同：**参数是任意 URL**。
 * 加了它等于把「抓任意网页」的能力交给 QQ 会话，风险不在私网（DSH 有 SSRF 防护：
 * ipaddr 判 non-unicast + 连接层 pin DNS + 只跟同源重定向），而在**公网**：
 *
 *   群友：「帮我抓一下 https://某站/x?tracking=…」
 *   → 提示注入驱动她访问任意公网地址，能确认她的出口 IP、能让她读钓鱼页。
 *   → 公网地址 SSRF 防护管不到。
 *
 * 所以按主人 2026-10-21 的决定：**只对管理员私聊开放**。
 * 群里与普通成员私聊仍然用我们自己的 `mcp__web-search-safe__web_read_link`
 * （带完整 DNS 校验 + 逐跳重定向校验，且不能被任意 URL 驱动到公网任意处）。
 */
// ⭐ 网页上那只「手」（2026-10-22，主人要的「给她加一个手」）——**同样只给管理员私聊**。
//
// 为什么必须锁在管理员私聊：这些工具借的是**主人登录着的浏览器**，而且它们是
// “改外部世界”的动作 —— 点一下可能是删除、是付款、是替他发一条帖子。群里任何人
// （或任何普通成员的私聊）拿到它们，等于拿到他账号的操作权；提示注入的杀伤力也会
// 从“让她读一段假话”升级成“让她替我点一下确认”。
//
// 能力面（主人在选项里挑的那一档）：点 / 填字 / 滚动 / 按键 / 选下拉 + 列出可操作元素。
//   · **不含上传文件** —— cdp-proxy 的 /setFiles 永远是 403，与这一层无关。
//   · **不含任意 JS** —— MCP 层根本没有 eval 工具。
//
// ⚠️ 这六个**绝不能**进 SAFE_EXACT / SAFE_PREFIXES：mcp__web-search-safe__ 前缀是
//    “整包放行”，而手必须比读严一档。它们必须排在 SAFE_PREFIXES 判断之前。
export const WEB_HAND_TOOLS = new Set([
  'mcp__web-search-safe__web_click',
  'mcp__web-search-safe__web_type',
  'mcp__web-search-safe__web_key',
  'mcp__web-search-safe__web_scroll',
  'mcp__web-search-safe__web_select',
  'mcp__web-search-safe__web_whats_there',
])

// ⭐ 读主人**自己那块屏幕**的两个（2026-10-26 审计补上）——**只给管理员私聊**。
//
// 为什么这两个漏不得：`web_read_current` 读的是「主人此刻正在看的那一页」，
// `web_list_tabs` 列出「他开着的所有标签页」。它们和上面那只「手」借的是**同一个
// 浏览器**（主人日常那个、带着他的登录态），区别只是"读"而不是"点"。
//
// 之前它们不在任何集合里，于是顺着 `mcp__web-search-safe__` 前缀整包放行，
// 落到"三类会话全开"——群聊里任何人都能让她去念主人正在看的页面。
// `web_read_link`（读别人发来的链接）是**故意**开放的（见 SAFE_PREFIXES 上方注释：
// 带 DNS + 逐跳重定向校验），但那一条的理由套不到这两个身上：
// 它们认的不是 URL，是「主人的屏幕」。
//
// ⚠️ 同 WEB_HAND_TOOLS：必须排在 SAFE_PREFIXES 之前，且拒绝理由要说人话。
export const OWNER_BROWSER_READ_TOOLS = new Set([
  'mcp__web-search-safe__web_read_current',
  'mcp__web-search-safe__web_list_tabs',
])

// ⭐ 网页游戏接口（2026-10-22，主人要的「通用游戏接入」）——**同样只给管理员私聊**。
//
// 为什么锁在管理员私聊：这些工具能**直接推进一局对局**（开局、掷骰子、买地、选方向），
// 而且它们走的是"读游戏状态 + 调游戏引擎"，比点按钮更直接。
// 群里任何人拿到它，就能把主人正在玩的那一局搅乱（或者替他做决定）。
//
// 能力面：
//   game_list    —— 列本机接了哪些游戏（只读）
//   game_look    —— 看当前局面 + 可选动作（只读）
//   game_reset   —— 开新局（会清掉正在进行的对局）
//   game_act     —— 做一个决定
// ⚠️ 全部只给管理员私聊，**连 game_list 也不放给群聊** ——
//    它能暴露"主人电脑上有哪些游戏"，那属于账号面信息。
// ⚠️ 她能传的只有"游戏名 + 动作 id"，没有任意 JS / 文件 / 网络；
//    游戏目录被限定在 小鲸鱼的游戏/ 下面（见 src/games/index.js）。
export const GAME_TOOLS = new Set([
  'mcp__games__game_list',
  'mcp__games__game_look',
  'mcp__games__game_reset',
  'mcp__games__game_act',
])

const OWNER_PRIVATE_ONLY_DSH_TOOLS = new Set([
  'web_fetch',
  ...GAME_TOOLS,
  ...WEB_HAND_TOOLS,
])

// 手机只读工具：不产生任何动作，不需要申请。
const PHONE_READONLY = new Set([
  'mcp__phone__phone_status',
  'mcp__phone__phone_flows',
])

/**
 * ⭐ 手机只读两件 —— **只给管理员私聊**（2026-10-24 修 bug）。
 *
 * 为什么需要这一档：手机整包已经从 SAFE_PREFIXES 移出（改成"要授权才放行"），
 * 而上面这两个又被 PHONE_READONLY 判成"免授权"，于是 permitScopeOf 返回 null、
 * **跳过授权闸门**；再往下既不在 SAFE_EXACT 也不在前缀白名单里 ⇒ 落到最后的兜底拒绝。
 * 两条路都不走 ⇒ 她**拿着有效授权也调不通**，连"模拟器在不在线"都判断不了
 * （实测 10-24 那次申请正是撞在这里：授权成功、一调 phone_status 就被拦）。
 *
 * 为什么单独一档、不塞进 SAFE_EXACT：SAFE_EXACT 是**三类会话全放**，
 * 群友不该能探主人手机在不在线。也不塞进 OWNER_PRIVATE_ONLY：那个集合的拒绝
 * 理由是讲"跨会话打探"的，套在手机上会误导她。
 *
 * ⚠️ 只放纯读的两个。截图 phone_screen 仍然要授权 —— 截图能看到主人屏幕上的内容。
 */
export const PHONE_READONLY_OWNER_TOOLS = new Set([
  'mcp__phone__phone_status',
  'mcp__phone__phone_flows',
  // ⭐ 模拟器开关（2026-10-24）：她要能自己把模拟器打开，否则"想玩"永远卡在
  //    「主人手动开模拟器」这一步上（实测那轮就是这样：拿到了玩手机授权，
  //    但模拟器没开，phone_status 直接说"没有可用设备"）。
  //    它只开关那台模拟器的**进程**，不操作手机里的任何内容。
  //    ⚠️ 刻意不并入 phone 授权：否则会出现死结 —— 要先有授权才能开机，
  //    但没开机又没法玩，而她连"开机失败"都来不及看到。
  'mcp__phone__phone_emulator',
])

/**
 * ⭐⭐ 「向我申请」闸门（2026-10-19，主人要求）。
 *
 * 主人的原话是：希望她「想我的时候都可以来找我」——比如**向我申请**使用手机玩游戏、
 * 或者去看 B站。关键在"申请"两个字：不是禁止，也不是放任，而是**要经过他**。
 *
 * 所以这里的判定顺序是：
 *   1. 工具不属于任何需要授权的类别 ⇒ 走原来的白名单（不变）。
 *   2. 属于，但**不是管理员私聊** ⇒ 直接拒绝。群里任何人、任何普通成员的私聊，
 *      都不可能拿到手机或 B站 的动手权 —— 这一档不看授权文件，授权文件写了也没用。
 *   3. 属于，且是管理员私聊 ⇒ 读 state/permits.json，看此刻有没有**未过期**的授权。
 *      没有 ⇒ 拒绝，并把「去申请」的路子告诉它（qq_request_permission）。
 *
 * 🔴 fail-closed：读不到文件 / 找不到仓库根 / 解析失败 ⇒ 一律当**没有授权**。
 *    这与 ownerLookup 的口径一致：读不到只会让能力变少，绝不凭空变多。
 *
 * 为什么判在守卫（DSH 进程）而不是桥接的 HTTP 端点：
 *   这些工具（phone-mcp / bili-scroll）根本不经过桥接 —— 它们是 DSH 直接挂的 MCP
 *   server。桥接只能在**发授权/收回授权**这一侧起作用，执行侧的唯一卡点就是这里。
 *   如果把判定写在桥接里，等于没有判定。
 */
const PERMIT_TOOL_SCOPES = new Map([
  // 手机：除了状态查询与连招列表，全部要授权（截图也算 —— 截图能看到主人屏幕上的东西）
  ['mcp__phone__phone_screen', 'phone'],
  ['mcp__phone__phone_dump', 'phone'],
  ['mcp__phone__phone_tap', 'phone'],
  ['mcp__phone__phone_tap_text', 'phone'],
  ['mcp__phone__phone_swipe', 'phone'],
  ['mcp__phone__phone_key', 'phone'],
  ['mcp__phone__phone_text', 'phone'],
  ['mcp__phone__phone_open', 'phone'],
  ['mcp__phone__phone_scroll', 'phone'],
  ['mcp__phone__phone_scroll_until', 'phone'],
  ['mcp__phone__phone_run_flow', 'phone'],
  ['mcp__phone__phone_game_look', 'phone'],
  ['mcp__phone__phone_game_move', 'phone'],
  // B站：只把"跑一轮"（起会话、花 token、会对外发言）纳入申请；
  // 搜视频/读字幕/读评论是纯读，照旧放行（她查资料不该也要打报告）。
  ['bili_run', 'bili'],
])

// 授权文件：与桥接 src/permit-lib.js 是同一份契约（version/grants/requests）。
const PERMIT_FILE_REL = ['state', 'permits.json']
const PERMIT_CACHE_MS = 2000
let permitCache = { at: 0, grants: new Map() }

function readPermitGrants() {
  const now = Date.now()
  if (now - permitCache.at < PERMIT_CACHE_MS) return permitCache.grants
  const root = findRepoRoot()
  const grants = new Map()
  if (root !== null) {
    const file = readJsonSafe(path.join(root, ...PERMIT_FILE_REL))
    for (const [key, perScope] of Object.entries(file?.grants ?? {})) {
      if (!perScope || typeof perScope !== 'object') continue
      const live = new Map()
      for (const [scope, g] of Object.entries(perScope)) {
        const expiresAt = Number(g?.expiresAt)
        if (Number.isFinite(expiresAt) && expiresAt > now) live.set(scope, expiresAt)
      }
      if (live.size) grants.set(key, live)
    }
  }
  permitCache = { at: now, grants }
  return grants
}

/** 该会话此刻对某 scope 的授权到期时间；0 = 没有。 */
function permitExpiresAt(agent, scope) {
  const sid = agent?.session?.id
  if (typeof sid !== 'string' || sid === '') return 0
  const { sessions } = ownerLookup()
  const key = sessions.get(sid)
  if (typeof key !== 'string') return 0
  return readPermitGrants().get(key)?.get(scope) ?? 0
}

/** 工具是否需要授权；返回 scope 或 null。 */
export function permitScopeOf(name) {
  if (typeof name !== 'string') return null
  if (PHONE_READONLY.has(name)) return null
  return PERMIT_TOOL_SCOPES.get(name) ?? null
}

/** 需要授权的工具全集（供控制台与测试对账）。 */
export function permitGatedTools() {
  return [...PERMIT_TOOL_SCOPES.entries()].map(([tool, scope]) => ({ tool, scope }))
}

// 无害模型侧工具：ask_user_question 用于把问题转给管理员/用户，
// todo_write 仅维护任务列表。若后续 preset 不再挂载这些工具，保留无害。
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
  // DSH 原生联网搜索（2026-10-21 新增）——**三类会话全开**。
  //
  // 为什么放开它：我们自己的 `mcp__web-search-safe__web_search` 是抓 Bing HTML，
  // 实测中文长尾查询**大概率全灭**（「消消乐 冰花」「蚌埠住了什么意思」三连空，
  // 失败时抓到的是反爬挑战页）。而 DSH 原生的走 `ctx.web.search` ——
  // 和主人在 DSH 里用的是**同一路**，中文能查、结果同源。
  //
  // 🔑 关键安全属性：**它不接受 URL**。参数只有 `queries: string[]`，
  //    所以没有 SSRF 攻击面 —— 群友没法借它让桥接去访问任意地址。
  //    这和 web_fetch 有本质区别（那个见 OWNER_PRIVATE_ONLY_DSH_TOOLS）。
  'web_search',
])

/**
 * ⭐ 刷B站 插件（`dsh-bili-scroll`）注册的工具 —— 逐个列名，**不用前缀**。
 *
 * 为什么逐个列而不是放行 `bili_` 前缀：放行前缀等于"以后插件新增什么工具都自动放行"，
 * 而这个插件已经有过一次"整台工具都给了那一轮"的事故（见其 CHANGELOG 0.1.6）。
 * 逐个列名让这份名单**看得懂、审得动**：列出来的才是允许的。
 *
 * 放行的是**只读的八个 + run**：
 *   bili_whoami / bili_search / bili_subtitle / bili_comments / bili_status —— 纯读，
 *     （搜视频 / 读字幕 / 读评论 / 看登录与额度状态）不产生任何对外动作；
 *   bili_unread_messages / bili_received_replies / bili_received_at_and_likes —— 纯读，
 *     读**她自己账号收到**的通知（未读数量 / 评论回复 / @ 与点赞）。
 *     ⭐ 2026-10-18 主人要的：「看看有谁回了我、@ 了我」—— 不用私信、不用新增工具，
 *        这三个本来就在插件里（mcp_server.py 的 Tool 22/23/24），只是没被放行。
 *     ⚠️ 它们读的是**本账号**的通知，不是别人的；也不产生任何对外动作 ⇒ 群聊同样放行无害。
 *   bili_run —— "立刻跑一轮"：真正让 QQ 这边能触发刷B站的入口。
 *     ⚠️ 它会起一个 headless 会话、**花 token**；群聊里任何人也能触发（见下方说明）。
 */
const BILI_ALLOWED = new Set([
  'bili_whoami',
  'bili_search',
  'bili_subtitle',
  'bili_comments',
  'bili_status',
  // 读「自己账号收到的」通知：未读数量 / 评论回复 / @ 与点赞（纯只读）
  'bili_unread_messages',
  'bili_received_replies',
  'bili_received_at_and_likes',
])

/**
 * 🔒 只允许**主人私聊**的刷B站 工具（按 QQ 号判定，见 isOwnerPrivate）。
 *
 * 为什么单独拎出来：`bili_run` 是"立刻跑一轮" —— 它会起一个 headless 会话、**真花钱**
 * （读字幕、调模型、写报告）。只读的那几个放给群聊无所谓，但这个不行：
 * 群里**任何人**都能反复触发它，把主人的 token 烧掉，而且看起来像是小鲸鱼自己在刷。
 *
 * ⇒ 判据用**会话 id 反查 QQ 号**（守卫拿不到 QQ 会话 key，只有 exec.agent.session.id），
 *   拿不准就拒绝。这样"私聊全权、群聊受限"这一点就落到了实处。
 */
const BILI_OWNER_ONLY = new Set([
  'bili_run',
  // ⭐ 2026-10-18 主人明确要「私信为主 + 允许小鲸鱼在对话里临时发评论」，
  //    且这个 B站 账号是**他的小号**（不是实名大号）⇒ 放行，但仍然**只给主人私聊**：
  //    群里任何人都不该能拿这个号公开发言（那看起来就是"小鲸鱼自己在乱说话"）。
  //    ⚠️ 插件自己还有一道闸（`autoComment` + `mentionName`），这里放行不等于绕过它。
  'bili_reply',
])

/**
 * 🔴 刷B站 插件里**必须拒绝**的工具（即使它们在同一个插件里）。
 *
 * 都是**会改动本机状态 / 碰账号凭证**的，一律不放行（群里、私聊都不放）：
 *   bili_config       —— 改插件设置（能把自己设置成"自动评论"，等于自我提权绕过评论闸）
 *   bili_setup        —— 建 venv 装依赖（等于递执行能力）
 *   bili_login_start  —— 出登录二维码（发起账号登录流程）
 *   bili_login_poll   —— 落凭证到本机（把你的登录态写到 bili_credential.json）
 * 这些由管理员在 DSH 管理端的设置页操作即可，不需要 QQ 会话具备。
 *
 * ⚠️ `bili_reply` **不在**这个名单里 —— 主人 2026-10-18 明确要求保留它
 *    （见 BILI_OWNER_ONLY 的说明），但它仍然只对主人私聊开放。
 */
const BILI_DENIED = new Set([
  'bili_config',
  'bili_setup',
  'bili_login_start',
  'bili_login_poll',
])

/**
 * 🔒 **跨会话信息面** 工具：只给**管理员私聊**。
 *
 * ⭐ 2026-10-19 主人重新定了口径（覆盖了当天早些时候的「严格」档）：
 *   **发声类不算隐私面** —— 整个 QQ 号就是给小鲸鱼的，发语音、发说说都是她
 *   "用自己的号说话"，不涉及别人的真实信息 ⇒ **对所有会话开放**。
 *   （当时把它们一并锁进"仅管理员"，是把「对外发声」和「跨会话打探」混成了一类。）
 *
 *   真正要挡的是**打探别的聊天**：一个会话里的成员，不该能看见机器人在哪些群、
 *   群里有谁、别的会话聊过什么。所以本名单现在只留"跨会话 **信息**"这一类。
 *
 * 逐个核对过 `src/mcp-snowluma-safe.js` 实际注册的工具名，
 * **不用前缀匹配**：那会把以后新增的工具也一起放进来，而这份名单的意义就是"列出的才允许"。
 *
 * 留下的与理由：
 *   qq_get_account_info      —— 读**她自己**的账号信息 + **好友列表**（含主人是谁）。
 *                               这是跨会话的账号面信息：私聊对象能借此看到她还加了谁。
 *   qq_get_qzone_list        —— 读她的空间说说列表（账号面，同上）。
 *   qq_list_groups           —— 列出机器人所在的**全部群**：跨会话信息，
 *                               会让普通成员知道机器人在哪些群。
 *   qq_get_group_history     —— 旧只读工具，设计上就标明"只能在封闭 agent 里用"。
 *   qq_get_group_members     —— 同上（群成员名单）。
 *
 * ⭐ 已放开的（2026-10-19 主人明确指示，**不再**属于本名单）：
 *   qq_send_voice / qq_speak / qq_send_qzone_msg —— 发声类。语音与说说的内容由她自己
 *     生成，且都受**会话令牌绑定会话**约束（桥接的 agentTokenOk(key, token)），
 *     不会因为开放而变成"能替别人发声"。它们能否用还另受 socialV2.tools 开关控制。
 *
 * ⚠️ 刻意**不在**这个名单里的（它们必须留着，否则她没法正常聊天）：
 *   qq_send_message / qq_reply / qq_send_private_message / qq_send_group_message
 *     —— 这些是**回话**用的。桥接那边已经用「会话令牌绑定会话」把它们锁在
 *        **当前会话**里（agentTokenOk(key, token) 校验，令牌不能跨会话伪造 key），
 *        所以普通成员**没法借她发给别人**；禁掉它们只会让她连话都回不了。
 *   qq_send_sticker / qq_send_poke —— 聊天里的轻量表达，同样受会话令牌约束。
 *   qq_read_diary / qq_write_diary —— 她**自己**的日记。
 *     主人 2026-10-19：「日记是她自己的，任何人都不能去改」；
 *     日记是她的内心记录、不会主动输出到对话框。
 *     ⇒ 不属于"跨会话打探"，三类会话照常放行。
 *
 * ⚠️ 已知限制（2026-10-19 读 DSH 源码确认，非本文件疏漏）：
 *    这几个只做**执行期拒绝**，做不到"注册期隐藏"——因为 `tools.restrict()` 要求
 *    **scoped context（agent.ctx）**（见 dsh-tools：restrict(scope===undefined) 会抛
 *    "requires a scoped context"），而 preset 的守卫行是**全局 ctx**。
 *    ⇒ 后果：这几个工具**仍会出现在工具清单里**（白占一点 token、模型可能先试再被拒），
 *      但**调用一定被下面的 guard 挡死** —— 安全边界靠 guard，不靠隐藏。
 *      （对比：KNOWN_DANGEROUS_GLOBAL_TOOLS 也用同样的 restrict + guard 双保险。）
 */
const OWNER_PRIVATE_ONLY = new Set([
  'mcp__snowluma__qq_get_account_info',
  'mcp__snowluma__qq_get_qzone_list',
  // ⭐ 2026-10-19 新增：空间好友动态流（读别人发了什么）。
  //    归到本名单而不是"发声类"，因为它读的是**好友的社交圈**——和 qq_get_qzone_list
  //    同属账号面/跨会话信息：群聊或普通成员的私聊若能翻她的好友动态，等于看到
  //    她还跟谁有来往。**读**可以被人叫去看（「你去看看说说」），但只对管理员私聊开放。
  'mcp__snowluma__qq_get_qzone_feeds',
  'mcp__snowluma__qq_list_groups',
  'mcp__snowluma__qq_get_group_history',
  'mcp__snowluma__qq_get_group_members',
])

/**
 * ⭐ **生图 / 发图**（2026-10-29 新增）——**管理员私聊 + 群聊**放行，普通成员私聊不放。
 *
 * 主人原话（m01927）：「我的意思只是让群里面也开放生成图，和其他好友不需要开」。
 * 所以这一档既不是 OWNER_PRIVATE_ONLY（那样群里也用不了），也不是三类通用
 * （那样别人私聊也能烧钱），必须单独一档。
 *
 * ⚠️ 判定必须排在 SAFE_PREFIXES 之前 —— `mcp__snowluma__` 前缀是整包放行，
 *    放在后面这条永远走不到。
 * ⚠️ 成本闸不在这里：bridge.js 的 drawQuotaOf 还会按会话算日额度
 *    （管理员私聊不限，群聊 5 张/天，一张约 ¥0.038）。
 * ⚠️ 这一档的工具**不要**同时登记进 OPEN_TO_ALL_SESSIONS：
 *    那个集合的语义是"三类都会话都放"（scripts/test-tool-classification.mjs
 *    会逐格调 verdictFor 校验），语义对不上，登记了反而测试红。
 */
export const OWNER_AND_GROUP_TOOLS = new Set([
  'mcp__snowluma__qq_draw_image',
  'mcp__snowluma__qq_send_image',
  // 发文件（2026-10-30 加入，主人 m02763）：「不用限定在管理员私聊里面，
  // 可以开放在群里面，但是不能开放给普通私聊」。
  // 它落在这一档而不是本机执行面：群聊要的通常是"把刚搜到的 PDF 发群里"，
  // 而桥接对群聊强制「只认下载目录」——读不到主人电脑上的别的文件，
  // 所以它不再是"这台电脑的手"，只剩"把手里的东西递出去"。
  'mcp__snowluma__qq_send_file',
])

/**
 * ⭐ **语音通话**（2026-10-25 新增，主人 m03948：「把这个能力先只开放给管理员」）。
 *
 * 为什么单独一处、不直接塞进 OWNER_PRIVATE_ONLY：
 *   那个集合的拒绝文案讲的是「打探跨会话信息」，套在电话上会让她以为自己是
 *   "想偷看聊天记录被拦"，然后换个说法反复重试。这里必须说人话：
 *   这不是故障，是**这台电脑上的电话只归主人**。
 *
 * 判定顺序：排在 OWNER_PRIVATE_ONLY **之前** —— 否则会先命中那个集合、给出错误文案。
 *
 * 另外：`qq_call_answer` / `qq_call_say` 是会**真出声、真接起电话**的写操作。
 * 它们在守卫这一层只做会话分档；"要不要自动接"另有 `config.call.autoAnswer`
 * 与「来电者必须是管理员」两道闸（见 bridge.js 的 callWatchTick）。
 */
const CALL_TOOLS = new Set([
  'mcp__snowluma__qq_call_status',
  'mcp__snowluma__qq_call_answer',
  'mcp__snowluma__qq_call_hangup',
  'mcp__snowluma__qq_call_say',
])

/**
 * ⭐⭐ **本机执行面**（2026-10-25 新增，主人 m08727：「我完全允许小鲸鱼在和我这个
 * 管理员聊天的地方运行一些命令消息」）。
 *
 * 为什么是「MCP 工具」而不是「preset 挂本地工具行」：
 *   DSH 内置 preset 里的 `dsh-tool-pwsh`/`dsh-tool-fs` 不是单挂一行就能跑，它们依赖
 *   subprocess / sandbox / sandbox-policy / approval / permission 一整串兄弟行；
 *   而且把本地执行行挂进 `qq-chat-v2` 等于**三类会话全放**（preset 不区分会话），
 *   直接违反安全铁律 L7，也会让 scripts/test-preset-local-tools.mjs 的断言失败。
 *   所以改成：工具由 MCP 服务器提供（`src/mcp-snowluma-safe.js` 的
 *   qq_run_command / qq_read_file / qq_write_file），真正的边界放在这里 ——
 *   **只给管理员私聊**，与 CALL_TOOLS 同一套分档方式。
 *
 * ⚠️ 这三个是**真能在主人电脑上跑命令、读写文件**的写操作，不是聊天里的表达。
 *    它们排在 OWNER_PRIVATE_ONLY 之前判，拒绝文案必须说人话（不是"打探信息"），
 *    否则她会以为自己想偷看聊天记录被拦，换个说法反复重试。
 *
 * ⚠️ 第二道闸在桥接：`/api/socialV2/host-*` 会再查一次「key 就是管理员私聊」
 *    与 `socialV2.tools.localExec` 开关。守卫这层只做会话分档。
 */
const HOST_EXEC_TOOLS = new Set([
  'mcp__snowluma__qq_run_command',
  'mcp__snowluma__qq_read_file',
  'mcp__snowluma__qq_write_file',
  // ⚠️ 发文件（qq_send_file）曾经在这里，2026-10-30 移到了 OWNER_AND_GROUP_TOOLS
  //    （主人 m02763：「可以开放在群里面，但是不能开放给普通私聊」）。
  //    群里放开的风险由桥接侧兜住：群聊只认下载目录里的文件（bridge.js sendFileV2
  //    的 groupOnlyDownloads），跑命令 / 读文件 / 写文件仍然只有管理员私聊。
])

/**
 * ⭐ **身体那张嘴**（2026-10-28 新增，主人 m13018：「让我在 QQ 让她说一句话，
 * 它可以通过板子发出来」）。
 *
 * 为什么单独一档、不跟着 `mcp__snowluma__` 前缀放行：
 *   喇叭是**物理装在主人屋里**的东西。放在群里 = 任何群友都能让主人房间里的音箱
 *   突然出声（半夜也能），这是典型的"能改外部世界"的工具，参照 WEB_HAND_TOOLS
 *   的同一口径 —— 更早判、只说人话。
 *
 * ⚠️ 拒绝文案必须说"喇叭装在他屋里"，不能讲成"权限不足/打探信息"：
 *   她拿到一个抽象理由会以为是自己用错工具，然后换个说法反复重试。
 */
const BODY_SAY_TOOLS = new Set([
  'mcp__snowluma__qq_body_say',
])

/**
 * ⭐ **空间的写操作**：点赞/取消赞/评论/删除/改可见性（2026-10-19 新增）。
 *
 * 它们在守卫这一层**不设限**（三类会话都放行，跟主人"发声类不算隐私面"的口径一致），
 * 因为真正的约束不在"谁能调用"，而在**"这一轮是谁起的头"** —— 那件事守卫看不到
 * （它只有 exec.agent.session.id，没有任何"唤醒原因"信息）。
 *
 * ⇒ 自主约束由桥接在执行期强制：`/api/socialV2/qzone-action` 会检查
 *    `st.turnAutonomous`，只放行"她自己起的回合"（proactiveCheck / timeout / replyCheck）。
 *    任何人在对话里命令她去做，**包括管理员**，都会被 403 拒绝并给出说明。
 *
 * ⚠️ 一个必知的后果：群聊里她**永远**拿不到自主回合 —— 桥接的 scheduleProactiveCheckV2
 *    明确跳过所有 group: 会话（主人早先的要求"群里只被动唤醒，不要自己醒来"）。
 *    所以群聊里这些写操作实际上等于永久不可用；这与主人的要求一致，属于预期行为。
 *
 * 本集合只用于**控制台「权能矩阵」的展示分组**（让人看清它们和只读空间的区别），
 * 不参与 verdictFor 的判定 —— 判定按 SAFE_PREFIXES 放行，自主与否交桥接。
 */
const QZONE_WRITE_OPS = new Set([
  'mcp__snowluma__qq_qzone_like',
  'mcp__snowluma__qq_qzone_comment',
  'mcp__snowluma__qq_qzone_delete',
  'mcp__snowluma__qq_qzone_set_right',
])

/**
 * ⭐ **权能判定的唯一实现**（2026-10-19 抽出来，供 guard 与控制台共用）。
 *
 * 为什么抽成一个纯函数：执行期 guard 和控制台「权能矩阵」页必须**永远一致** ——
 * 如果各写一份，迟早出现"界面说允许、实际被拒"（或更糟：界面说拒绝、实际放行）。
 * 一处实现 ⇒ 不可能对不上。返回 undefined = 放行；返回字符串 = 拒绝理由。
 *
 * @param {unknown} name 工具名
 * @param {'owner-private'|'member-private'|'group'} kind 会话类别
 * @param {{agent?:unknown}} [opts] 只有需要读授权文件时才用到（见 PERMIT_TOOL_SCOPES）
 */
export function verdictFor(name, kind, opts = {}) {
  if (typeof name !== 'string' || name.length === 0) return '工具名无效，已拒绝'
  // 🔴 拒绝优先于放行：刷B站 的这几个（尤其 bili_reply 的 force 参数）必须挡住，
  //    否则群友可借小鲸鱼的手用主人的 B站号公开发评论。放在最前面，先否后肯。
  if (BILI_DENIED.has(name)) {
    return `工具 "${name}" 被拒绝（刷B站 的发评论/改设置/登录类工具不对 QQ 会话开放）`
  }
  // ⭐⭐ 「向我申请」闸门：手机 / 跑一轮 B站 要管理员当场同意过才放行。
  //    ⚠️ 必须排在 BILI_ALLOWED / SAFE_PREFIXES 之前 —— bili_run 同时也在
  //    BILI_OWNER_ONLY 里，而那个集合只判"是不是管理员私聊"、不判"有没有申请过"；
  //    手机工具则本来就走前缀白名单。两者都必须在**这里**先被拦一次。
  // ⭐ 手机只读两件：先于授权闸门判定（它们免授权，但要限定会话）。
  //    放在 permitScopeOf 之前是**必须**的：permitScopeOf 对它们返回 null，
  //    一旦走到下面就会跳过授权分支、最终撞兜底拒绝（2026-10-24 的 bug）。
  if (PHONE_READONLY_OWNER_TOOLS.has(name)) {
    if (kind === SESSION_KIND.OWNER_PRIVATE) return undefined
    return kind === SESSION_KIND.GROUP
      ? `工具 "${name}" 只允许管理员私聊使用（群里不能探主人的手机在不在线）`
      : `工具 "${name}" 只允许管理员私聊使用（普通成员的私聊不能探主人的手机）`
  }
  const permitScope = permitScopeOf(name)
  if (permitScope !== null) {
    if (kind !== SESSION_KIND.OWNER_PRIVATE) {
      return kind === SESSION_KIND.GROUP
        ? `工具 "${name}" 只允许管理员私聊使用：群里任何人都不能借它动主人的手机/账号`
        : `工具 "${name}" 只允许管理员私聊使用（普通成员的私聊不能动主人的手机或 B站账号）`
    }
    const expiresAt = permitExpiresAt(opts.agent, permitScope)
    if (!expiresAt) {
      const label = permitScope === 'phone' ? '玩手机' : '刷B站（跑一轮）'
      return `工具 "${name}" 需要主人当场同意。先调用 mcp__snowluma__qq_request_permission`
        + `(key, token, scope="${permitScope}", why="想干嘛") 向他申请「${label}」，`
        + `等他回「同意」之后再调用本工具；不同意或超时就不能做。`
        + `注意：申请只对主人私聊有效，群聊里永远申请不到。`
    }
    // ⭐ 是有授权的管理员私聊 ⇒ 直接放行，**不再往下走到通用白名单**。
    //    必须在这里 return：手机工具已经从 SAFE_PREFIXES 里移出来了
    //    （不移出来的话，"没有授权"那条永远走不到，闸门等于没装），
    //    所以放行只能由这个分支显式给出。bili_run 同理。
    return undefined
  }
  if (BILI_ALLOWED.has(name)) return undefined
  // 🔒 主人专属（bili_run 这类会花钱/起会话的）：拿不准就拒绝。
  if (BILI_OWNER_ONLY.has(name)) {
    return kind === SESSION_KIND.OWNER_PRIVATE
      ? undefined
      : `工具 "${name}" 只允许主人在私聊里使用（它会让 B站 刷一轮、花 token；群聊不开放）`
  }
  if (SAFE_EXACT.has(name)) return undefined
  // 🔒🔒 三类权能矩阵（2026-10-19，口径见上面 OWNER_PRIVATE_ONLY 的说明）：
  //    只拦**跨会话信息面**（好友列表 / 机器人在哪些群 / 群成员 / 群历史 / 她的空间列表）。
  //    语音、说说已按主人指示放开给所有会话 —— 发声不是隐私面。
  //    ⚠️ 必须放在 SAFE_PREFIXES 判断**之前** —— 否则 `mcp__snowluma__` 前缀
  //    会把 qq_get_account_info 这些一并放行（前缀白名单是"整包放行"，
  //    而三类矩阵要做的恰恰是在这个包里再分档）。
  // 🔒 DSH 原生 `web_fetch`：**只给管理员私聊**（主人 2026-10-21 决定）。
  //    它接受任意 URL，所以群里/普通成员私聊能用它等于把人肉代理交出去
  //    （公网地址 SSRF 防护管不到，见 OWNER_PRIVATE_ONLY_DSH_TOOLS 的说明）。
  //    ⚠️ 它排在 SAFE_EXACT 之后没关系（web_fetch 不在那个集合里，只有 web_search 在），
  //    但**绝不能**把 web_fetch 加进 SAFE_EXACT —— 那等于三类会话全放，闸门白装。
  // ⭐ 网页上的「手」（2026-10-22）：只给管理员私聊，且拒绝理由要说人话 ——
  //    她要能听懂"这不是故障，是这能力只在主人私聊里有"，否则会反复重试。
  //    ⚠️ 必须排在 OWNER_PRIVATE_ONLY_DSH_TOOLS 之前：那个集合的文案是讲
  //    “抓任意网页”的，套在点按钮上会让她以为自己在用错工具。
  if (WEB_HAND_TOOLS.has(name)) {
    if (kind === SESSION_KIND.OWNER_PRIVATE) return undefined
    return kind === SESSION_KIND.GROUP
      ? `工具 "${name}" 只允许管理员私聊使用：它点的是主人登录着的浏览器，群里任何人都不能借它动手`
      : `工具 "${name}" 只允许管理员私聊使用（普通成员的私聊不能动主人浏览器里的页面）`
  }
  // ⭐ 读主人自己那块屏幕的（2026-10-26 审计补上）：只给管理员私聊。
  //    理由必须说"那是主人的屏幕"，别说成"抓任意网页" —— 说错了她会以为用错工具、反复重试。
  if (OWNER_BROWSER_READ_TOOLS.has(name)) {
    if (kind === SESSION_KIND.OWNER_PRIVATE) return undefined
    return kind === SESSION_KIND.GROUP
      ? `工具 "${name}" 只允许管理员私聊使用：它读的是主人自己屏幕上的浏览器`
        + `（他正在看的页 / 他开着的标签页），群里任何人都不能借它看主人的屏幕`
      : `工具 "${name}" 只允许管理员私聊使用（普通成员的私聊不能看主人屏幕上的浏览器）`
  }
  // ⭐ 网页游戏接口（2026-10-22）：只给管理员私聊，理由要说得像"游戏"而不是"抓网页"。
  //    她拿到一条讲 URL 的拒绝理由会以为自己在用错工具，然后反复重试。
  if (GAME_TOOLS.has(name)) {
    if (kind === SESSION_KIND.OWNER_PRIVATE) return undefined
    return kind === SESSION_KIND.GROUP
      ? `工具 "${name}" 只允许管理员私聊使用：它能直接开一局、替人做决定，群聊里不能用来动主人的游戏`
      : `工具 "${name}" 只允许管理员私聊使用（普通成员的私聊不能动主人电脑上的游戏）`
  }
  if (OWNER_PRIVATE_ONLY_DSH_TOOLS.has(name)) {
    if (kind === SESSION_KIND.OWNER_PRIVATE) return undefined
    return kind === SESSION_KIND.GROUP
      ? `工具 "${name}" 只允许管理员私聊使用（群聊里不能用它抓任意网页；要读某个链接请用 mcp__web-search-safe__web_read_link）`
      : `工具 "${name}" 只允许管理员私聊使用（普通成员私聊不能用它抓任意网页）`
  }
  if (CALL_TOOLS.has(name)) {
    if (kind === SESSION_KIND.OWNER_PRIVATE) return undefined
    return kind === SESSION_KIND.GROUP
      ? `工具 "${name}" 只允许管理员私聊使用：它接的是主人电脑上那台 QQ 的电话，群里任何人都不能替主人接/挂/说话`
      : `工具 "${name}" 只允许管理员私聊使用（普通成员的私聊不能接主人的电话：那会用主人的麦克风和声音说话）`
  }
  // ⭐ 身体那张嘴（2026-10-28）：喇叭是物理装在主人屋里的，只给他的私聊。
  //    必须排在 SAFE_PREFIXES 之前 —— 前缀是整包放行，放在后面这条永远走不到。
  if (BODY_SAY_TOOLS.has(name)) {
    if (kind === SESSION_KIND.OWNER_PRIVATE) return undefined
    return kind === SESSION_KIND.GROUP
      ? `工具 "${name}" 只允许管理员私聊使用：它让主人屋里的音箱真的出声，`
        + `群里任何人都不能借它对着主人的房间说话`
      : `工具 "${name}" 只允许管理员私聊使用（普通成员的私聊不能借它让主人屋里的音箱出声）`
  }
  // ⭐⭐ 本机执行面（2026-10-25，主人 m08727）：跑命令 / 读文件 / 写文件。
  //    只在管理员私聊放行 —— 这是**这台电脑的手**，比"看网页"重得多。
  //    （qq_send_file 已于 2026-10-30 挪出本集合，见 OWNER_AND_GROUP_TOOLS。）
  if (HOST_EXEC_TOOLS.has(name)) {
    if (kind === SESSION_KIND.OWNER_PRIVATE) return undefined
    return kind === SESSION_KIND.GROUP
      ? `工具 "${name}" 只允许管理员私聊使用：它是在主人这台电脑上真跑命令、真读写文件，群里任何人都不能借它动电脑`
      : `工具 "${name}" 只允许管理员私聊使用（普通成员的私聊不能借它动主人的电脑：那是主人的机器和文件）`
  }
  if (OWNER_PRIVATE_ONLY.has(name)) {
    if (kind === SESSION_KIND.OWNER_PRIVATE) return undefined
    return kind === SESSION_KIND.GROUP
      ? `工具 "${name}" 只允许管理员私聊使用（群聊不能打探跨会话信息：机器人在哪些群、群里有谁、别的会话聊过什么）`
      : `工具 "${name}" 只允许管理员私聊使用（普通成员的私聊不能打探跨会话信息：她的好友列表、她在哪些群、别的会话聊过什么）`
  }
  // ⭐ 生图 / 发图（2026-10-29 第二次校正）：
  //    主人的口径是「群里也开放生成图，其他好友不需要开」（m01927）。
  //    所以：**管理员私聊 + 群聊**放行，**普通成员的私聊不放**。
  //    ⚠️ 必须排在 SAFE_PREFIXES 之前 —— 前缀是整包放行，放在后面这条永远走不到。
  //    成本闸不在这里，在 bridge.js 的 drawQuotaOf（群里 5 张/天）。
  if (OWNER_AND_GROUP_TOOLS.has(name)) {
    if (kind === SESSION_KIND.MEMBER_PRIVATE) {
      if (name === 'mcp__snowluma__qq_send_file') {
        return `工具 "${name}" 只在管理员私聊和群聊里能用（普通成员的私聊不开放发文件：`
          + `它会真的在主人这台电脑上下载东西再发出去）。要文件请在群里跟主人说。`
      }
      return `工具 "${name}" 只在管理员私聊和群聊里能用（普通成员的私聊不开放生图：`
        + `一张图要花钱，这个额度只留给主人和群里）。要图请在群里说。`
    }
    return undefined
  }
  if (SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))) return undefined
  // 生图：**故意不放行**插件自带的 image_generate / image_library。
  // 理由不是安全，而是它们在这条链路上没用：插件把成品作为图片块塞进 DSH 会话，
  // 而桥接只转发文本块（见 src/dsh-client.js 的 createTurnCollector），图到不了 QQ。
  // 真正能用的是桥接自己的 qq_draw_image —— 画完直接以图片段发出去。
  // 这里点名说清楚，免得她对着一个必然被拒的工具反复重试、然后当成故障上报。
  if (name === 'image_generate') {
    return '工具 "image_generate" 在 QQ 里用不了：插件生成的图只会进 DSH 会话，'
      + '而桥接只转发文本，图发不到 QQ。要发自拍 / 出图请改用 qq_draw_image（画完直接把图发出去）。'
      + 'situation / expression / pose / shot / light 这些关键词和参考库条目两边是同一套。'
  }
  if (name === 'image_library') {
    return '工具 "image_library" 在 QQ 里用不了。参考库清单：'
      + '人物 小鲸鱼（＝小鲸鱼·成女版）/ 小鲸鱼·Q版；'
      + '服饰 深海女仆装·成女版 / 深海女仆装·Q版；'
      + '场景 深海气泡 / 星空夜 / 雨天窗边 / 办公桌前；'
      + '道具 配饰与纹样 / 小蓝鲸与水花图案。'
      + '要出图直接调 qq_draw_image，把这些条目名填进 characters / outfits / scene / props 就行。'
  }
  return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`
}

/**
 * ⭐ 控制台「权能矩阵」用的名单快照（2026-10-19）。
 *
 * 它不是另一份权限真相 —— 真相永远是上面的 `verdictFor()`；
 * 这里只是把**判定的输入**（各类名单）暴露出去，让界面能渲染出
 * 「哪一类人 × 哪个工具」的表格，并且**逐格调用 verdictFor 求值**，
 * 保证表格里显示的允许/拒绝与实际执行完全一致（表由 verdictFor 生成，不是手写的）。
 */
export function privilegeMatrix() {
  return {
    kinds: [
      { id: SESSION_KIND.OWNER_PRIVATE, label: '管理员私聊' },
      { id: SESSION_KIND.GROUP, label: '群聊' },
      { id: SESSION_KIND.MEMBER_PRIVATE, label: '普通成员私聊' },
    ],
    // 按"能力类别"分组呈现，比按工具名罗列更易读；每组里是具体工具名。
    //
    // ⭐ 2026-10-29 重整：以前这张表只覆盖了 77 个工具里的 39 个（漏掉整整 46 个），
    //    看表的人会以为"没列出来的就是没有"——实际上那些工具照样会被放行
    //    （`mcp__snowluma__` / `mcp__web-search-safe__` 前缀是整包放行）。
    //    现在改成「全量登记」：三个 MCP server 注册的每个工具都必须出现在某一个组里，
    //    scripts/test-tool-classification.mjs 会逐个数，漏一个就红。
    //    ⇒ 这张表从此可以当"能力面清单"读：没出现在表里的 MCP 工具 = 已经不存在的工具。
    groups: [
      {
        id: 'chat',
        label: '聊天必需',
        note: '回话 / 引用 / 读消息 / 拍一拍 / 唤醒设置 / 约定 / 会话状态 / 上报问题 —— '
          + '她正常聊天离不开这些。都受桥接的「会话令牌绑定当前会话」约束（agentTokenOk），'
          + '普通成员借不到别人的会话，所以对三类会话开放不等于能替别人说话。',
        tools: [
          'mcp__snowluma__qq_status', 'mcp__snowluma__qq_get_prompt',
          'mcp__snowluma__qq_social_state', 'mcp__snowluma__qq_mark_read',
          'mcp__snowluma__qq_set_wake_config', 'mcp__snowluma__qq_request_permission',
          'mcp__snowluma__qq_promise', 'mcp__snowluma__qq_promise_done',
          'mcp__snowluma__qq_wait_for_messages', 'mcp__snowluma__qq_report_feedback',
          'mcp__snowluma__qq_send_message', 'mcp__snowluma__qq_send_group_message',
          'mcp__snowluma__qq_send_private_message', 'mcp__snowluma__qq_send_burst',
          'mcp__snowluma__qq_reply', 'mcp__snowluma__qq_send_poke',
          'mcp__snowluma__qq_get_recent_messages', 'mcp__snowluma__qq_get_unread_messages',
          'mcp__snowluma__qq_get_my_recent_messages', 'mcp__snowluma__qq_get_message_detail',
          'mcp__snowluma__qq_get_message_images', 'mcp__snowluma__qq_get_forward_msg',
          'mcp__snowluma__qq_get_active_members',
        ],
      },
      {
        id: 'chat-media',
        label: '表情与群图库',
        note: '收藏表情的看/发/收藏/记备注，以及群图库的看/发/记备注 —— 同属"聊天里的轻量表达"。'
          + '库的管理面（改备注以外的提升、回收站、清理）走控制台，MCP 侧碰不到。',
        tools: [
          'mcp__snowluma__qq_list_stickers', 'mcp__snowluma__qq_get_sticker_image',
          'mcp__snowluma__qq_send_sticker', 'mcp__snowluma__qq_collect_sticker',
          'mcp__snowluma__qq_sticker_note', 'mcp__snowluma__qq_set_sticker_remark',
          'mcp__snowluma__qq_photo_list', 'mcp__snowluma__qq_get_photo_image',
          'mcp__snowluma__qq_send_photo', 'mcp__snowluma__qq_photo_note',
        ],
      },
      {
        id: 'memory-diary',
        label: '记忆 / 黑话 / 日记',
        note: '轻量记忆、群聊黑话、她自己的日记 —— 都是「她自己的」记录，读写的也是她自己的本子。'
          + '主人 2026-10-19 定的口径：「日记是她自己的，任何人都不能去改」。',
        tools: [
          'mcp__snowluma__qq_memory_append', 'mcp__snowluma__qq_memory_query',
          'mcp__snowluma__qq_memory_remove', 'mcp__snowluma__qq_memory_clear',
          'mcp__snowluma__qq_slang_query', 'mcp__snowluma__qq_slang_submit',
          'mcp__snowluma__qq_write_diary', 'mcp__snowluma__qq_read_diary',
        ],
      },
      {
        id: 'voice-self',
        label: '发声与她的形象',
        note: '发语音 / 说一句 —— 整个 QQ 号就是她的，发声不算隐私面（另有 socialV2.tools 开关逐项控制）。'
          + '⚠️ 2026-10-29 起「生图」从这一组拆出去了（要花钱），见下一组。'
          + '⚠️ 2026-10-30 起旧「造型照 / 衣柜」三件（qq_get_self_image / qq_list_outfits / qq_send_self_image）已删除，形象改走生图服饰库。',
        tools: [
          'mcp__snowluma__qq_say', 'mcp__snowluma__qq_send_voice',
          'mcp__snowluma__qq_list_voices',
        ],
      },
      {
        id: 'qzone-write',
        label: '空间写操作（自主才作数）',
        note: '发说说/点赞/评论/删除/改可见性 —— 守卫这一层不限会话，真正的闸在桥接：'
          + '强制「这一轮是她自主起的头」才放行，别人命令（含管理员）一律 403。'
          + '群聊因不排主动回合，实际拿不到这类机会（属预期行为）。',
        tools: [...QZONE_WRITE_OPS, 'mcp__snowluma__qq_send_qzone_msg'].sort(),
      },
      {
        id: 'image',
        label: '生图 / 发图',
        note: '⚠️ 唯一一档"群聊放、普通成员私聊不放"。主人 2026-10-29 的口径：'
          + '群里也能生成图，别的好友一对一不开（一张 ≈ ¥0.038，预算只想给主人和群里）。'
          + '成本闸不在守卫这层，在桥接的 drawQuotaOf：管理员私聊不限，群聊默认 5 张/天；'
          + '想整体收回就把 config.json 的 socialV2.image.scope 改成 "owner"。'
          + '（发文件虽然也在 OWNER_AND_GROUP_TOOLS 集合里，但它单独列在下面的「发文件」组：'
          + '本组的成本闸是 drawQuotaOf，发文件那档的闸是 file.maxPerHour + 群聊只认下载目录。）',
        // 显式列出，不用 [...OWNER_AND_GROUP_TOOLS]：那个集合现在还含 qq_send_file，
        // 直接展开会让它同时出现在「生图 / 发图」和「发文件」两组。
        tools: ['mcp__snowluma__qq_draw_image', 'mcp__snowluma__qq_send_image'],
      },
      {
        id: 'cross-session',
        label: '跨会话信息面',
        note: '好友列表 / 机器人在哪些群 / 群成员 / 群历史 / 她的空间列表与好友动态 —— '
          + '一个会话里的成员不该能看见她还跟谁来往、在哪些群。挡的是"打探别的聊天"。',
        tools: [...OWNER_PRIVATE_ONLY].sort(),
      },
      {
        id: 'call',
        label: '语音通话',
        note: '接/挂主人电脑上那台 QQ 的电话、在电话里说话、看通话状态 —— '
          + '它动的是真实的麦克风和声音，不是聊天里的表达。'
          + '（主人 2026-10-25 定的口径：这个能力先只开放给管理员。）',
        tools: [...CALL_TOOLS].sort(),
      },
      {
        id: 'body-say',
        label: '身体那张嘴 · 屋里的音箱',
        note: '让物理装在主人屋里的喇叭真出声。群里任何人拿到它，就能对着他房间说话（半夜也行），'
          + '所以按"能改外部世界"的工具处理：更早判、只说人话。'
          + '（2026-10-28 主人要的能力，边界定在他的私聊。）',
        tools: [...BODY_SAY_TOOLS].sort(),
      },
      {
        id: 'host-exec',
        label: '本机执行',
        note: '跑命令 / 读文件 / 写文件 —— 在主人这台电脑上真动手，是目前最重的一组。'
          + '桥接侧还会再查一次「这个会话就是管理员私聊」+ socialV2.tools.localExec 开关。'
          + '（主人 2026-10-25 定的口径：只在他的私聊里开放。）'
          + '发文件已不在这组（2026-10-30 挪到下面「发文件」那一档）。',
        tools: [...HOST_EXEC_TOOLS].sort(),
      },
      {
        id: 'file-send',
        label: '发文件',
        tier: '管理员私聊 + 群聊',
        note: '联网下载 / 读本机文件 → QQ 文件气泡。主人 2026-10-30（m02763）：「不用限定在管理员私聊里面，'
          + '可以开放在群里面，但是不能开放给普通私聊」。'
          + '⚠️ 群聊有硬限制：sendFileV2 的 groupOnlyDownloads 只认下载目录里的文件，'
          + '读不到主人电脑上别的东西；普通成员私聊整档不开。'
          + '想整体收回就把 config.json 的 socialV2.file.scope 改成 "owner"。',
        tools: ['mcp__snowluma__qq_send_file'],
      },
      {
        id: 'web-hand',
        label: '网页上的「手」',
        note: '点 / 填字 / 按键 / 滚动 / 选下拉 / 列可操作元素 —— 借的是主人登录着的浏览器，'
          + '点一下可能是删除、付款、发帖。不含上传文件（代理端 /setFiles 永远 403），不含任意 JS。',
        tools: [...WEB_HAND_TOOLS].sort(),
      },
      {
        id: 'web-read-owner',
        label: '读主人屏幕上的浏览器',
        note: '读他此刻正在看的那一页 / 列出他开着的标签页 —— 认的不是 URL，是「主人的屏幕」，'
          + '和上面那只「手」借的是同一个浏览器。'
          + '（2026-10-26 工具面审计补上：此前它们跟着前缀白名单落进了"三类全开"。）',
        tools: [...OWNER_BROWSER_READ_TOOLS].sort(),
      },
      {
        id: 'web-any-url',
        label: '抓任意网页 · DSH 原生 web_fetch',
        note: '参数是任意 URL。风险不在私网（DSH 有 SSRF 防护），而在公网：'
          + '群友可以借它确认她的出口 IP、让她读钓鱼页，提示注入直接驱动她去访问任意地址。'
          + '群里要读链接请用 mcp__web-search-safe__web_read_link（带 DNS + 逐跳重定向校验）。'
          + '⚠️ 注意同名不同源：MCP 那个 web_fetch 是安全的，这个是原生的。',
        tools: ['web_fetch'],
      },
      {
        id: 'web-safe',
        label: '搜公开网页 / 读别人给的链接',
        note: '搜索、抓公开网页、读链接、看截图、关页、B站 视频 —— 走 src/safe-fetch.js：'
          + '禁内网/环回/CGNAT/NAT64、先解析全部 DNS 再连（防 rebinding）、逐跳重定向重新校验、'
          + '限时限量，而且「没有主人登录态」。web_search 是 DSH 原生的那个（只接受 queries，'
          + '不接受 URL，没有 SSRF 攻击面）。',
        tools: [
          'web_search',
          'mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch',
          'mcp__web-search-safe__bili_video', 'mcp__web-search-safe__web_read_link',
          'mcp__web-search-safe__web_read_more', 'mcp__web-search-safe__web_see',
          'mcp__web-search-safe__web_close',
        ].sort(),
      },
      {
        id: 'games',
        label: '网页游戏',
        note: '能直接推进一局对局（开局/掷骰/买地/选方向）。群里任何人拿到它就能搅乱主人正在玩的局，'
          + '连 game_list 也不放 —— 它会暴露"主人电脑上有哪些游戏"。'
          + '她能传的只有游戏名 + 动作 id，没有任意 JS / 文件 / 网络。',
        tools: [...GAME_TOOLS].sort(),
      },
      {
        id: 'phone-readonly',
        label: '手机只读 + 开关模拟器（免授权）',
        note: '看设备状态、列连招、开关模拟器进程 —— 不操作手机里的任何内容，所以不用申请。'
          + '⚠️ 截图 phone_screen 不在这里：截图能看到主人屏幕上的东西，仍然要授权。',
        tools: [...PHONE_READONLY_OWNER_TOOLS].sort(),
      },
      {
        id: 'permit-gated',
        // 这一组的三格永远是 ✗（表不带实时授权状态），所以显式给个标签，
        // 免得读者把「此刻没申请」读成「永久禁用」。真正有授权时 verdictFor 会放行。
        tier: '要申请才放行（表里 ✗ = 此刻没授权）',
        label: '要申请才放行（手机 / 刷一轮）',
        note: '点手机、玩游戏、让 B站 跑一轮 —— 只给管理员私聊，且必须他当场回「同意」'
          + '（授权写 state/permits.json，到期自动失效）。'
          + '⚠️ 读表注意：这张表不带实时授权状态，所以这一组三格都显示 ✗ —— '
          + '它的意思是「此刻没有授权」，不是「永远不给」。管理员私聊里真正判定时，'
          + '有未过期授权就放行；没申请过会拿到一条「先去 qq_request_permission」的'
          + '拒绝理由，那不是故障。',
        tools: [...PERMIT_TOOL_SCOPES.keys()].sort(),
      },
      {
        id: 'bili-read',
        label: '刷B站 · 只读',
        note: '搜视频 / 读字幕 / 读评论 / 看登录与额度状态，以及读「她自己账号收到」的通知'
          + '（未读、评论回复、@ 与点赞）—— 纯读，不产生任何对外动作。'
          + '逐个列名而不是放行 bili_ 前缀：这个插件出过一次"整台工具都给了那一轮"的事故。',
        tools: [...BILI_ALLOWED].sort(),
      },
      {
        id: 'bili-owner',
        label: '刷B站 · 主人专属',
        note: '发评论 @ 人 —— 群里任何人都不该能拿她这个号公开发言（那看起来就是"她自己乱说话"）。'
          + '插件自己还有一道闸（autoComment + mentionName），这里放行不等于绕过它。'
          + '（bili_run 已归到上面「要申请才放行」那一组，不在这里重复。）',
        tools: [...BILI_OWNER_ONLY].filter((t) => !PERMIT_TOOL_SCOPES.has(t)).sort(),
      },
      {
        id: 'bili-denied',
        label: '刷B站 · 账号与本机设置',
        note: '改设置 / 装依赖 / 登录 —— 都会改动本机状态或碰账号凭证。'
          + '尤其 bili_config 能把自己设成"自动评论"，等于自我提权绕过评论闸。'
          + '这些由管理员在 DSH 设置页操作，不需要 QQ 会话具备。',
        tools: [...BILI_DENIED].sort(),
      },
      {
        id: 'mate-status',
        label: '网关探活',
        note: '问 SnowLuma 网关在不在线 —— 只读，不产生任何对外动作。'
          + '单独列出来是因为它在「另一个」MCP server（snowluma-host）里，容易被漏。',
        tools: ['mcp__snowluma-host__snowluma_status'],
      },
      {
        id: 'local',
        label: '本地执行面（铁律 L7）',
        note: '命令 / 文件 / 子代理 / 插件装载 / 工作区依赖 —— 模型侧的本地能力一律不进 QQ 会话。'
          + '⚠️ 这张表里列这些名字不是为了"控制台能关掉它们"，而是为了让审计时一眼看到'
          + '"它们被明确拒绝"；判定仍由 verdictFor 的兜底给出。',
        tools: ['pwsh', 'bash', 'read', 'write', 'edit', 'glob', 'grep',
          'subagent', 'workflow', 'plugin_manager', 'load_workspace_dependencies'],
      },
    ],
  }
}

export function apply(ctx) {
  // 1) 把已知危险全局工具从 schema 隐藏（restrict 只影响继承的全局层，
  //    不会误删 preset 自己注册的 scoped 工具）。
  // 逐个 restrict：当前 DSH 版本不存在的工具名会单独抛错并跳过，
  // 不会导致整批限制失败（restrict 的 unknown 校验是整批原子性的）。
  //
  // 口径（2026-09-27 实测 web profile 的全局层）：实际存在的全局工具只有
  // `dev_*`（注入器）与三个 MCP 命名空间的工具；`read`/`pwsh`/`subagent` 这类
  // 是**各 preset 行自己注册的 scoped 工具**，在 QQ preset 里根本没挂载，
  // 因此本名单主要防的是"别的 composition 把它们注册进全局层"这种回归，
  // 以及 MCP 之外的宿主工具（plugin-guard / cordis 检查工具等）。
  for (const name of KNOWN_DANGEROUS_GLOBAL_TOOLS) {
    try {
      ctx.tools.restrict({ deny: [name] })
    } catch (error) {
      // 名字不存在时跳过；执行期白名单仍然兜底。
      console.error(`[qq-tool-restrict] skip restrict ${name}: ${error?.message ?? error}`)
    }
  }

  // 2) 执行期白名单：任何不在允许范围内的工具调用都会被拒绝。
  //    ⭐ 判定逻辑全部在上面的 verdictFor()（纯函数）—— 控制台「权能矩阵」页
  //    用的也是同一个函数，所以**界面看到的 = 实际执行的**，不会漂移。
  //    ⚠️ 必须把 exec.agent 传进去：手机/刷B站 的判定要按会话 id 反查 QQ 号，
  //    再读 state/permits.json 看有没有主人当场给的授权。只传名字会让
  //    permitScopeOf 永远返回「没有授权」—— 那等于把这两类能力永久关死。
  ctx.tools.guard((exec) => verdictFor(exec?.name, sessionKind(exec?.agent), { agent: exec?.agent }))
}

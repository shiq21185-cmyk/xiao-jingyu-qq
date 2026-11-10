// QQ 桥接安全硬边界（管理员私聊 · DSH 全接入版）。
//
// 与 qq-tool-restrict.mjs 的区别：这个守卫挂在 `qq-owner-dsh` preset 上，
// 那个人格同 qq-chat-v2，但工具面多了「手 + 眼 + 脑」—— read / write / edit /
// glob / grep / pwsh / ops_bash 这些 DSH 原生本地工具。
// 主人 2026-11-09 拍板（m09018 三决策之一）：管理员私聊完全接入 DSH，能在
// 这台电脑上直接动手；群聊 / 普通成员私聊**仍然一律拒绝本地工具**（铁律 L7 只在
// owner-private 这一档放宽，不放宽其它两档）。
//
// 为什么单独一份守卫、而不是改 qq-tool-restrict.mjs：
//   qq-chat-v2 的铁律是「仿真会话永不包含本地工具」，它的 restrict 名单要求把
//   read/pwsh/ops_bash 这些**注册期就隐藏**；而本 preset 恰恰要它们在管理员私聊里
//   可用。两份守卫的 restrict 名单方向相反，共用一个文件必然互相污染。
//   所以本文件只复制「会话反查」那段基础设施（自包含，不依赖主守卫的未导出内部），
//   判定逻辑则**复用主守卫导出的 verdictFor 作为兜底**——QQ MCP 工具、生图、通话、
//   看屏幕、身体、越权工具（subagent/workflow/plugin_manager…）的判定与 qq-chat-v2
//   完全一致，只有「手眼脑」这 7 个名字在本文件里先判一次。
//
// ⚠️ fail-closed 与主守卫一致：反查不到会话 / 读不到文件 / ownerQQ 没配
//    ⇒ 一律当「不是主人」，手眼脑工具全部拒绝。绝不因为"读不到"就放宽。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verdictFor as baseVerdictFor, RESTRICTED_TOOL_NAMES } from './qq-tool-restrict.mjs'

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/**
 * 从守卫文件往上找仓库根（与主守卫同款逻辑，见 qq-tool-restrict.mjs 头注释）。
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

export const name = 'qq-tool-restrict-owner'

export const inject = ['tools']

/**
 * 手 + 眼 + 脑：管理员私聊放行的 DSH 原生本地工具（主人 2026-11-09 选的这一档）。
 *
 * 刻意**不放**整族 ops_（ops_read_files / ops_write_file / ops_glob / ops_grep …），
 * 也不放 subagent / workflow / skill / terminal / plugin_manager —— 那些是「派生 agent /
 * 装载插件 / 直接 shell」的越权面，不是"手眼脑"，继续交给 baseVerdictFor 拒绝。
 * 文件读写用 DSH 原生的 read/write/edit（dsh-tool-fs），检索用 glob/grep（fs-search），
 * 执行用 pwsh（Windows）+ ops_bash（dsh-ops 全局层）。
 */
const OWNER_DSH_HAND_EYE_BRAIN = new Set([
  'read', 'write', 'edit',
  'glob', 'grep',
  'pwsh', 'ops_bash',
])

export function verdictFor(name, kind, opts = {}) {
  if (OWNER_DSH_HAND_EYE_BRAIN.has(name)) {
    if (kind === SESSION_KIND.OWNER_PRIVATE) return undefined
    return kind === SESSION_KIND.GROUP
      ? `工具 "${name}" 只允许管理员私聊使用：它是在主人这台电脑上真读文件、真跑命令，`
        + `群里任何人都不能借它动电脑`
      : `工具 "${name}" 只允许管理员私聊使用（普通成员的私聊不能借它动主人的电脑：那是主人的机器和文件）`
  }
  return baseVerdictFor(name, kind, opts)
}

// 注册期隐藏名单 = 主守卫的越权面，去掉手眼脑那 7 个（它们要在管理员私聊里可用）。
// 注意：read/write/edit/glob/grep/pwsh 是 preset 行挂载的 scoped 工具，restrict 对它们
// 本来就会抛「requires a scoped context」被吞；filter 掉只是避免无谓调用。真正的边界
// 在下面的执行期 guard（verdictFor 手眼脑分支）。
const HIDDEN_TOOLS = RESTRICTED_TOOL_NAMES.filter((n) => !OWNER_DSH_HAND_EYE_BRAIN.has(n))

export function apply(ctx) {
  for (const name of HIDDEN_TOOLS) {
    try {
      ctx.tools.restrict({ deny: [name] })
    } catch (error) {
      console.error(`[qq-tool-restrict-owner] skip restrict ${name}: ${error?.message ?? error}`)
    }
  }
  ctx.tools.guard((exec) => verdictFor(exec?.name, sessionKind(exec?.agent), { agent: exec?.agent }))
}

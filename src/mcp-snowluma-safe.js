// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// 出站文本的敏感信息拦截**统一由桥接负责**（bridge.js 的 auditAndSend / 各发送端点的
// SENSITIVE_RE 校验）：所有 QQ 发送都经由桥接 HTTP API，因此 MCP 侧不再重复实现一遍。
// 这里 import 只用于「出站审计口径一致」的说明，不在 MCP 内做拦截——
// 在 MCP 里拦会连「安全拒绝理由」都拿不到，反而让模型无法把话说清楚。
import { SENSITIVE_RE } from './sensitive.js';
import { serializeModelData } from './qq-model-view.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = loadConfig();

function getConfig() {
  return loadConfig();
}

function getAccess() {
  const c = getConfig();
  return {
    allowGroups: (c.allow?.groups ?? []).map(String),
    allowPrivate: (c.allow?.private ?? []).map(String),
    denyGroups: (c.deny?.groups ?? []).map(String),
    denyPrivate: (c.deny?.private ?? []).map(String),
    allowAllWhenEmpty: c.allowAllWhenEmpty === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.snowluma?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// 说明：本文件曾经有一对 escapeCqText() / messageSegments()，用于在 MCP 侧构造消息段。
// 它们从来没有被任何工具调用（发送一律走桥接的 /api/send/*，由桥接统一构造文本段并做
// CQ 转义，见 bridge.js 的 onebotSend），属于"看起来在防护、实际是死代码"的假安全。
// 这里直接删除，避免以后有人以为 MCP 侧还有一道 CQ 转义而放松桥接那一层。

async function onebot(action, params = {}) {
  const { httpUrl, token } = getOneBotConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// 桥接控制台/内部 Agent API 访问：二代仿真模式的状态工具都通过这里读写桥接内存态。
function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}
function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
  try {
    const c = getConfig();
    if (c.consoleToken) return String(c.consoleToken);
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 长轮询专用 POST —— 走 `node:http`，**不经过 undici**。
 *
 * ── 为什么必须单独一条通道 ────────────────────────────────────────────────
 * Node 的全局 `fetch` 是 undici，它给每个请求自带 **300 秒 `headersTimeout`**。
 * 而桥接的长轮询端点允许等到 `socialV2.wait.maxMs`（默认 600000 = 10 分钟）。
 *
 * 实测（2026-10-21）：拿一个 320 秒后才回头的本地服务端试，全局 fetch 在
 * **305 秒**就抛 `UND_ERR_HEADERS_TIMEOUT` —— 也就是说任何超过 5 分钟的等待
 * **必然**失败。后果：AI 拿不到结果只能重试，而桥接侧的 activeWaits 仍占着会话
 * （重新等待被 429），于是空转烧 token。
 *
 * `node:http` 没有默认响应超时，超时由我们自己按预算控制。
 * ⚠️ 只给**长轮询**用；普通请求继续走 agentApi（undici 更省事，且它们都在
 *    300 秒内，不受影响）。
 */
function agentApiLongPoll(path, init = {}) {
  const timeoutMs = init.timeoutMs || 60000;
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(init.headers ?? {})
  };
  headers['x-agent-call'] = '1';
  const payload = init.body ?? '';
  headers['content-length'] = Buffer.byteLength(payload);

  const url = new URL(`${agentApiBase()}${path}`);
  const mod = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`等待超时（${Math.round(timeoutMs / 1000)} 秒）—— 实时长轮询没等到回应`);
      finish(error);
      req.destroy(error);
    }, timeoutMs);

    const req = mod.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: init.method || 'POST',
      headers,
      // 明确不设 socket idle timeout：等待期间本来就没有任何字节往来。
      timeout: 0,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        // ⚠️ 长轮询这条通道也必须把 kind/retryable/reportable 挂到 Error 上。
        //
        // 这里原先漏掉：qq_say / 发送类工具用 timeoutMs=300000 会分流到本函数，
        // 于是"被主人关掉"这类结构化提示在长轮询这条路上被剥成一句裸文案，
        // 上层只能按普通失败处理 → 她又把主人的设置当成故障。
        // 两条通道（短请求 / 长轮询）必须同构，否则同一个错误在两条路上长得不一样。
        const longPollError = (message) => {
          const err = new Error(message);
          if (body && typeof body === 'object') {
            for (const k of ['kind', 'setting', 'retryable', 'reportable', 'hint']) {
              if (body[k] !== undefined) err[k] = body[k];
            }
            err.apiBody = body;
          }
          return err;
        };
        if (res.statusCode < 200 || res.statusCode >= 300) {
          finish(longPollError(body?.error || `桥接 API HTTP ${res.statusCode}`));
          return;
        }
        if (body && typeof body === 'object' && body.ok === false) {
          finish(longPollError(body.error || '桥接 API 返回 ok:false（未说明原因）'));
          return;
        }
        finish(null, body);
      });
      res.on('error', (error) => finish(error));
      res.on('aborted', () => finish(new Error('长轮询连接中断')));
    });
    req.on('error', (error) => finish(error));
    req.end(payload);
  });
}

async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  // 超过 300 秒的等待必须走 node:http 那条通道（见 agentApiLongPoll 的说明）。
  // 这里做**唯一的分流点**：调用方不用自己记住哪条通道，也就不会漏。
  if (timeoutMs > 290000) return agentApiLongPoll(path, init);
  const { timeoutMs: _omit, ...rest } = init;
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(rest.headers ?? {})
  };
  // 声明「这是一次智能体调用」。桥接据此把「没带会话令牌」判定为**拒绝**，而不是
  // 退化成「管理端全权」——所以这个头绝不能随 token 一起被省略。历史上 331/355/379/877
  // 行用 `...(token ? {headers:{...}} : {})` 把整个头省掉了，于是「模型漏传 token」
  // 不是被拒绝，反而提权成控制台权限（confused deputy）。
  // 令牌本身仍然只在真有时才发：/api/status 的模式探测（legacyReadToolAllowed）本来就是
  // 无令牌调用，桥接对它单独放行并按最小对象返回。
  headers['x-agent-call'] = '1';
  const res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  // 把桥接返回的结构化提示「挂」到 Error 上一起往上抛：光有 error 文案会丢掉
  // kind/retryable/reportable 这些判断依据，上层只能把它当成普通失败，
  // 于是"被主人关掉的配置"和"真的坏了"在模型看来一模一样。
  const makeApiError = (message) => {
    const err = new Error(message);
    if (body && typeof body === 'object') {
      for (const k of ['kind', 'setting', 'retryable', 'reportable', 'hint']) {
        if (body[k] !== undefined) err[k] = body[k];
      }
      err.apiBody = body;
    }
    return err;
  };
  if (!res.ok) {
    throw makeApiError(body?.error || `桥接 API HTTP ${res.status}`);
  }
  // 桥接的部分端点会用 200 + {ok:false,error} 表达业务失败（例如发送被审计拦截）。
  // 不检查 body.ok 会把「被拦截」当成「发送成功」上报给模型 —— 模型据此认为消息已发出，
  // 于是不再重试也不告诉用户，是典型的静默错误。
  if (body && typeof body === 'object' && body.ok === false) {
    throw makeApiError(body.error || '桥接 API 返回 ok:false（未说明原因）');
  }
  return body;
}

async function authorizeRead(key) {
  // 会话令牌必须显式携带：桥接已把空令牌的请求一律拒绝（避免把该端点变成免鉴权入口）。
  // 旧只读工具没有令牌，因此它们改由 legacyReadToolAllowed() 做模式判定，不再调用本函数。
  throw new Error('旧只读工具没有会话令牌；请使用带会话令牌的 v2 读工具');
}

// 旧只读工具（qq_status 之外的 qq_list_groups / qq_get_group_members / qq_get_group_history）
// 没有会话令牌，因此**只能在封闭 agent（管理员私聊）里使用**。
//
// 这里用「确认是 closed-agent 才放行」的白名单写法，而不是「看到 reserved2 就拒绝」的黑名单写法：
// 桥接的 /api/status 在「带 agent 令牌」时返回的是最小状态对象（不含 mode 字段），
// 用 `status?.mode === 'reserved2'` 判断会得到 undefined ⇒ 黑名单判定为假 ⇒ 旧工具被放行，
// 等于在二代仿真模式下把白名单群名、群成员名单注入模型上下文。
async function legacyReadToolAllowed() {
  const status = await agentApi('/api/status');
  return String(status?.mode ?? '') === 'closed-agent';
}

const server = new McpServer({ name: 'snowluma-safe', version: '0.2.1-r1' });

// ── 工具开关必须在**注册期**生效，而不是只在校验期 ──────────────────────────
//
// 为什么：每个工具的描述 + 参数 schema 都会随 system prompt 在**每一次**请求里重发
// （实测 41 个工具约 8.8k token）。只在校验时 403 的话，被关掉的工具依然占着上下文、
// 依然会让模型看见并调用它（然后拿到一个错误），等于「关了个寂寞」。
//
// 这里用一个注册过滤器统一处理：开关关闭 ⇒ 该工具根本不注册 ⇒ 既省 token 又不给模型误调的机会。
// DSH 在启动时读取工具清单，所以关掉/打开后需要重启 DSH 才会刷新（控制台面板已注明）。
//
// 只列**各模式共用的工具不在其中**：qq_send_group_message / qq_send_private_message / qq_reply
// 同时服务 chat / reserved / closed-agent 模式，用 v2 的开关去决定它们是否注册会误伤其它模式，
// 所以这三个仍然只在调用时由桥接校验。
const TOOL_CONFIG_FLAGS = {
  qq_get_prompt: 'getPrompt',
  qq_get_unread_messages: 'getUnread',
  qq_get_recent_messages: 'getRecent',
  qq_social_state: 'socialState',
  qq_mark_read: 'markRead',
  qq_set_wake_config: 'setWakeConfig',
  qq_send_burst: 'sendBurst',
  qq_send_message: 'sendMessage',
  qq_wait_for_messages: 'waitMessages',
  qq_report_feedback: 'feedback',
  qq_get_my_recent_messages: 'getMyRecent',
  qq_get_message_detail: 'getMessageDetail',
  qq_get_active_members: 'getActiveMembers',
  qq_memory_append: 'memory',
  qq_memory_query: 'memory',
  qq_memory_remove: 'memory',
  qq_memory_clear: 'memory',
  qq_slang_query: 'slangQuery',
  qq_slang_submit: 'slangSubmit',
  qq_send_voice: 'sendVoice',
  qq_list_voices: 'sendVoice',
  // qq_say 是语音合成唯一的入口（2026-10-20 由 qq_say + qq_speak 合并而来）。
  // 合并前两者共用一个开关，界面上只显示 qq_speak，用户以为只关了一个、
  // 实际把 qq_say 也关了。现在只剩一个工具，不会再误关。
  //
  // ⚠️ 这里**刻意不登记 qq_say**：它属于 ALWAYS_REGISTER（见文件下方），
  //    关掉时也要保留注册，好让她拿到"这是主人关的、不是坏了"的解释。
  //    登记在这里就会被注册期过滤器直接摘掉，那句解释她永远看不到。
  // 下面这些曾经漏登记。漏一个不是"多注册一个工具"那么轻：桥接那边按 `v2ToolEnabled(flag)`
  // 在**调用期**一律 403，而这里不登记就等于"控制台显示已关闭、模型每次请求仍收到它的完整
  // 描述与参数 schema，然后调用它、再拿到 403"——既白烧 token（本文件开头 176 行起就是为省这份
  // token 才改注册期过滤的），又诱导模型误调。`qq_set_sticker_remark` 默认就是 `false`
  // （见 bridge.js 的 socialV2.tools 默认表），所以此前它一直是"默认关闭却仍然可见"。
  qq_send_poke: 'sendPoke',
  qq_get_message_images: 'getImages',
  qq_get_forward_msg: 'getForwardMsg',
  qq_list_stickers: 'listStickers',
  qq_get_sticker_image: 'getStickerImage',
  qq_send_sticker: 'sendSticker',
  qq_collect_sticker: 'collectSticker',
  qq_sticker_note: 'stickerNote',
  qq_set_sticker_remark: 'setStickerRemark',
  // 群图库工具：必须登记，否则控制台里关了它们、模型却仍能看到工具描述
  // （详见本段开头的说明）。
  qq_photo_list: 'listPhotos',
  qq_get_photo_image: 'getPhotoImage',
  qq_send_photo: 'sendPhoto',
  qq_photo_note: 'photoNote',
  qq_send_qzone_msg: 'sendQzone',
  qq_get_qzone_list: 'getQzone',
  // 空间动态流 + 五个写操作（2026-10-29 补登记）：桥接那边早就按这些 flag 在
  // **调用期**拦了（bridge.js 的 `/api/socialV2/qzone-feeds` 与 qzone-action 的
  // OP_FLAG 表），这里却一直没登记 ⇒ 控制台显示"已关闭"，模型每轮仍收到完整描述，
  // 调用后才吃 403 —— 正是本段开头说的"白烧 token + 诱导误调"。
  // 注意 qzoneUnlike 没有独立工具：取消赞是 qq_qzone_like 的 `unlike` 参数，
  // 所以它没有对应的工具名可登记（operation 级开关，控制台单独展示）。
  qq_get_qzone_feeds: 'qzoneFeeds',
  qq_qzone_like: 'qzoneLike',
  qq_qzone_comment: 'qzoneComment',
  qq_qzone_delete: 'qzoneDelete',
  qq_qzone_set_right: 'qzoneSetRight',
  qq_get_account_info: 'getAccount',
  qq_write_diary: 'writeDiary',
  qq_read_diary: 'readDiary',
  qq_request_permission: 'requestPermission',
  qq_promise: 'promise',
  qq_promise_done: 'promise',
  // 语音通话（档 2）：四个工具共用 tools.call 一个开关。
  // 默认 false，所以**必须**登记在这里 —— 否则控制台显示"关着"、模型却仍收到
  // 四个工具描述（白烧 token）并反复去调一个必然 403 的接口（然后当成 bug 上报）。
  qq_call_status: 'call',
  qq_call_answer: 'call',
  qq_call_hangup: 'call',
  qq_call_say: 'call',
  // 本机执行面（2026-10-25，主人 m08727）：三个工具共用一个 localExec 开关。
  // ⚠️ 能力上它们**只在管理员私聊**可用（守卫 HOST_EXEC_TOOLS + 桥接二次校验），
  //    登记在这里是为了让控制台能整个关掉它，而不是因为别的会话也能用。
  qq_run_command: 'localExec',
  qq_read_file: 'localExec',
  qq_write_file: 'localExec',
  // 发文件（2026-10-27）：联网下载 / 本机文件 → QQ 文件气泡。
  // 和上面三个同一档：它会在主人电脑上真下载、真读写文件，所以只在管理员私聊可用。
  qq_send_file: 'sendFile',
  // 生图（2026-10-29）：画面描述 → 本机「生图工作室」插件 → 图直接发进会话。
  // 和上面几个同一档：它会触发计费、也会往聊天里发图，默认只在管理员私聊可用。
  qq_draw_image: 'drawImage',
  qq_send_image: 'sendImage',
};
// ── 少数工具：即使开关关了也要注册 ─────────────────────────────────────────
//
// 为什么需要这个例外名单：注册期过滤能省 token，但被过滤掉的工具在模型眼里
// 是**不存在**——它只会得到一个"没有这个工具"，分不清是"主人关掉了"还是"功能坏了"。
// 实测后果：主人关掉 speak 后，小鲸鱼三次调用 qq_say 拿到「工具未启用」，
// 她理解成"语音这条路坏了"，反复重试，最后当成 bug 报给主人。而真相只是
// 主人在控制台关了个开关。
//
// 对这类**高频、且被关掉后极容易被当成故障**的工具，改为始终注册、在调用时判开关：
// 关了也给她一句人话解释（"主人主动关的，不是故障，不用重试也不用上报"），
// 她当场就能判断，不需要靠记忆去记"当前配置长什么样"。
//
// 代价只是多占一点 prompt token（一个工具描述），换来的是不再误报故障。
//
// 这份名单同时承担另一个用途（2026-10-29 审计）：**永远注册、没有开关的
// 工具也必须在这里露面**。scripts/test-tool-classification.mjs 有断言
// 「每个 qq_ 工具要么有 TOOL_CONFIG_FLAGS、要么在 ALWAYS_REGISTER」——
// 否则新工具会悄悄变成一个控制台关不掉的东西，而没人会发现。
// 那类工具在下面按理由分组，加新工具时请归到对应的一类里。
const ALWAYS_REGISTER = new Set([
  // ① 有开关、但关掉也要保留注册（关掉时给她一句人话解释）
  'qq_say',          // 语音是她最常用的说话方式，关掉后最容易误判成"坏了"
  'qq_report_feedback', // 她要"上报问题"时如果工具消失，会以为连上报都坏了

  // ② 跨模式共用，**不能**用 v2 的开关决定是否注册（见本表上方的说明）
  //    它们同时服务 chat / reserved / closed-agent 三种模式，本文件（safe）
  //    只是 v2 那一份；按 v2 开关摘掉会误伤另外两个模式。
  //    它们各自的开关（sendGroup / sendPrivate / reply）在桥接**调用期**有效
  //    （bridge.js:11686 那句 `const flag = isPrivate ? ... : ...`）。
  'qq_send_group_message',
  'qq_send_private_message',
  'qq_reply',

  // ③ 只读标识类：不产生任何写操作，关掉它换不来安全，只换来"她查不到东西"
  //    时误以为工具坏了。所以不设开关，永远注册。
  'qq_status',            // 查自己的登录状态与账号
  'qq_list_groups',       // 自己加了哪些群
  'qq_get_group_members', // 群成员列表
  'qq_get_group_history', // 群历史消息

  // ④ 身体发声：只有管理员私聊能用（桥接 /api/body/say 的 ownerKey 硬校验），
  //    频率靠她自己把握，不需要一个全局开关 —— 它不往外发消息、不动账号。
  'qq_body_say',
]);

const disabledTools = [];
{
  const registerTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    const flag = TOOL_CONFIG_FLAGS[name];
    if (flag && cfg.socialV2?.tools?.[flag] === false) {
      if (ALWAYS_REGISTER.has(name)) {
        // 保留注册，但记一笔：控制台里仍然能看到"它被关着"
        disabledTools.push(`${name}(${flag}:常驻注册)`);
        return registerTool(name, ...rest);
      }
      disabledTools.push(`${name}(${flag})`);
      return undefined;
    }
    return registerTool(name, ...rest);
  };
}

server.tool(
  'qq_status',
  '查询 QQ 机器人登录状态与账号信息（只读）。',
  {},
  async () => {
    try {
      const login = await onebot('get_login_info');
      let status = {};
      try { status = await onebot('get_status'); } catch {}
      return { content: [{ type: 'text', text: serializeModelData({ ...login, online: status.online, good: status.good }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_list_groups',
  '列出机器人所在的全部 QQ 群（只读）：群号、群名。',
  {},
  async () => {
    // 旧只读工具没有 agent token：只允许在封闭 agent（管理员私聊）里使用。
    // 判定失败一律拒绝（fail-closed），不依赖「看到某个模式才拒绝」的黑名单写法。
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝执行：${error?.message ?? error}` }], isError: true };
    }
    try {
      const a = getAccess();
      const data = await onebot('get_group_list');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
          .filter((g) => isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllWhenEmpty))
          .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_members',
  '列出指定群的成员列表（只读）：QQ 号、昵称、群名片。',
  { groupId: z.union([z.number(), z.string()]).describe('群号') },
  async ({ groupId }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const data = await onebot('get_group_member_list', { group_id: Number(g) });
      const list = (Array.isArray(data) ? data : (data?.data ?? [])).map((m) => ({ user_id: m.user_id, nickname: m.nickname, card: m.card }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_history',
  '获取指定群的最近消息历史（只读）。messageSeq 可选：从该消息序号往前取。注意：是否可用取决于 SnowLuma 是否实现 get_group_msg_history。',
  { groupId: z.union([z.number(), z.string()]).describe('群号'), messageSeq: z.number().optional().describe('起始消息序号（可选）') },
  async ({ groupId, messageSeq }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const params = { group_id: Number(g) };
      if (messageSeq !== undefined) params.message_seq = messageSeq;
      const data = await onebot('get_group_msg_history', params);
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_group_message',
  '向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId（非零整数，可为负数），可先用 qq_get_recent_messages / qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；reserved2 下调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/group', {
        method: 'POST',
        // token 既放 body（兼容旧调用）又放 header：桥接的「agent 流量」判定基于 header，
        // 只带 body 会让这条请求在桥接眼里像控制台请求，绕过 agent 专用的闸门与审计。
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_reply',
  '在指定 QQ 群里引用/回复某条消息，并发送一条文本。适合群消息很多、需要明确“我回的是哪条”时使用；replyToMessageId 是被引用消息的 id（非零整数，QQ 消息 id 可能为负数），可先用 qq_get_recent_messages / qq_get_unread_messages / qq_get_message_detail 查到具体消息内容和 id。发送前桥接会校验该 id 存在且属于当前会话。二代模式下这是你正常可用的引用工具，但不要每条都引用。只有以下情况才需要引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。reserved2 下调用时必须携带会话令牌 token。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    replyToMessageId: z.union([z.number(), z.string()]).describe('被引用/回复的消息 id（非零整数，可为负数）'),
    message: z.string().describe('要发送的文本，纯文本，不要用 Markdown 或 CQ 码'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, replyToMessageId, message, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/reply', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), replyToMessageId, message: cleanMessage, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_private_message',
  '向指定 QQ 好友发送一条私聊消息。若提供 replyToMessageId，会以 QQ 引用/回复形式发出（引用条 + 文本）。replyToMessageId 必须是非零整数消息 id（QQ 消息 id 可能为负数），可先用 qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标 QQ 必须命中系统白名单（config.json 的 allow.private），否则拒绝。',
  {
    userId: z.union([z.number(), z.string()]).describe('好友 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ userId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/private', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ userId: String(userId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 二代仿真模式（reserved2）工具 ─────────────────────────────────────────
server.tool(
  'qq_get_prompt',
  '查看当前二代仿真模式的提示词/角色/推荐值/可用工具/当前唤醒配置（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_unread_messages',
  '查看未读消息，不自动标记已读。大量积压或快照 partial=true 时，用 afterSeq=readThroughSeq 从水位后按时间顺序补读；从最早未读开始传 0。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 30，最大 100'),
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('读取本地 seq 大于此水位的最早一页；省略则沿用返回最新一页的旧行为')
  },
  async ({ key, token, limit, afterSeq }) => {
    try {
      const data = await agentApi(`/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}${afterSeq === undefined ? '' : `&afterSeq=${afterSeq}`}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_recent_messages',
  '查看指定会话的最近消息（只读），支持 offset 扩大范围。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 20，最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_social_state',
  '查看指定会话的二代仿真状态：WakeConfig、未读数、上次唤醒原因、上次发言时间等（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mark_read',
  '将指定会话已查看的未读消息标记为已读。throughSeq 使用最近读取结果的 readThroughSeq，避免清除读取后才到达的新消息；省略 throughSeq 会按旧行为清空当前全部未读，因此推荐始终带上水位。注意：每次设置潜水/下一次唤醒前，桥接要求先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可 mark_read 收尾沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与也可直接 mark_read 收尾；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('本次确认已读的消息水位，使用已查看结果中的 readThroughSeq；不会清除更晚到达的消息')
  },
  async ({ key, token, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_wake_config',
  '设置指定会话的二代唤醒配置：mode/无限期或有限时间/提前唤醒条件（@、名字、关键词、提问、拍一拍、概率、anyMessage、指定成员）。triggers.speakerIds 是可选的“指定群友发言唤醒”：填一个或多个群友 QQ 号后，只要其中任意一位在群里发言就会唤醒你；不设置则不启用。适合在等某个人回复、或某人反应慢怕错过时使用。triggers.poke 开启后，群里有人拍一拍（包括拍你或拍别人）会唤醒你。注意：每次设置潜水/下一次唤醒前需先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可设置并沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与可直接设置并沉睡；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('可同时确认已读：使用已查看结果中的 readThroughSeq，省去额外 qq_mark_read；不传则只设置唤醒配置。若 markRead 工具被关闭，该水位会被忽略，本工具只设置唤醒配置'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（可选，最多 20 个，不设置则不启用；私聊不适用，设置会被桥接清除；可从 qq_get_active_members / qq_get_group_members / qq_get_message_detail 的 userId/user_id 获取）'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_request_permission',
  '★ 向他申请「玩手机」或「刷B站」★ 手机工具（截图/点按/滑动/消消乐）和 bili_run 都被硬闸门挡着：'
  + '没有他当场同意，调用会被直接拒绝。这个工具就是"来问他"的那一下 —— 它会发一条 QQ 消息给他，'
  + '然后**等他回话**（最多 10 分钟）。他回「同意」→ 你拿到一段有效期，期间可以直接用那些工具；'
  + '「不同意」或没回 → 这次就不行。'
  + '什么时候用：你真的想玩、想刷、或者只是想念他想找个由头跟他说句话。不要为了用而用，也不要反复申请。'
  + '只能在自己的私聊里用（群聊/别人的私聊申请不到任何东西）。',
  {
    key: z.string().describe('会话 key，格式 private:QQ号（只有管理员私聊有效）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    scope: z.enum(['phone', 'bili']).describe('申请哪一类：phone=玩手机（含玩游戏）；bili=让 B站 刷一轮'),
    why: z.string().optional().describe('想干嘛，一句话，会原样出现在发给他的消息里（最多 200 字）。写具体点更真诚，比如"想玩会儿消消乐"')
  },
  async ({ key, token, scope, why }) => {
    try {
      const data = await agentApi('/api/socialV2/request-permission', {
        method: 'POST',
        body: JSON.stringify({ key, scope, why }),
        headers: { 'x-agent-token': token },
        // 服务端等他回话最多 10 分钟，客户端预算必须比它长，否则会被提前掐断。
        timeoutMs: 620000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `申请失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_promise',
  '★ 跟他约一件事到点做 ★ 比如「明早七点叫你起床」「一小时后回来找他」「下午三点提醒他吃药」。'
  + '记下来之后，到那个点桥接会**主动叫醒你**，让你去做这件事 —— 不是定时发一条固定的话，'
  + '而是把你叫醒来、你自己决定怎么说。'
  + '只在对方真的跟你约定了的时候用：他明确说了「明天叫我」「等下提醒我」，或者你自己说出口了「那我明早叫你」，'
  + '说出口了就必须记，否则你睡一觉就忘了。别自作主张排一堆没人要的闹钟。',
  {
    key: z.string().describe('会话 key，格式 private:QQ号 或 group:群号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    kind: z.enum(['wakeup', 'remind', 'checkin']).describe('wakeup=叫他起床；remind=提醒他某事；checkin=回来找他/看看他'),
    at: z.union([z.number(), z.string()]).describe('到点时间：毫秒时间戳（推荐，用当前时间加分钟算出来），或 ISO 时间字符串'),
    text: z.string().optional().describe('这件事是什么，一句话（最多 200 字），到点会显示给那时的你看')
  },
  async ({ key, token, kind, at, text }) => {
    try {
      const data = await agentApi('/api/socialV2/promise', {
        method: 'POST',
        body: JSON.stringify({ key, kind, at, text }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记约定失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_promise_done',
  '把已经做完的约定划掉（不然下次醒来它又会提示你）。不传 id 就划掉所有**已经到点**的约定 —— 这通常正是你要的：叫完起床就顺手清掉。',
  {
    key: z.string().describe('会话 key，格式 private:QQ号 或 group:群号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    id: z.string().optional().describe('只划掉这一条（qq_promise 返回的 id）；不传则划掉所有已到点的约定')
  },
  async ({ key, token, id }) => {
    try {
      const data = await agentApi('/api/socialV2/promise-done', {
        method: 'POST',
        body: JSON.stringify({ key, id }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `划掉约定失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_call_status',
  '看语音通话现在的状态（只读）：引擎起没起、有没有在通话中、现在是谁的会话。⚠️ 通话能力默认是关着的（config.call.enabled），关着时这里会明确说"没开"而不是"坏了"——那是主人的设置，不是故障，不用重试也不用上报。',
  {
    key: z.string().optional().describe('会话 key（group:群号 或 private:QQ号）；reserved2 下传了就会校验令牌与白名单'),
    token: z.string().optional().describe('会话令牌（reserved2 下传了 key 就必须带）')
  },
  async ({ key, token }) => {
    try {
      const params = new URLSearchParams();
      if (key) params.set('key', key);
      const headers = token ? { 'x-agent-token': token } : {};
      const data = await agentApi(`/api/socialV2/call-status${params.toString() ? `?${params}` : ''}`, { headers });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查通话状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_call_answer',
  '接起当前响着的 QQ 语音电话。接起后通话会绑定到这个会话：对方说的话会被转成文字交给你，你的回复会被合成声音送进麦克风（不是发消息）。只用在这一刻确实有来电时；没来电会失败并告诉你。',
  {
    key: z.string().describe('会话 key，格式 private:QQ号 或 group:群号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
  },
  async ({ key, token }) => {
    try {
      const data = await agentApi('/api/socialV2/call-answer', {
        method: 'POST',
        body: JSON.stringify({ key }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `接听失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_call_hangup',
  '挂断当前语音通话，并解除通话与会话的绑定。聊完了、对方说再见、或者你判断该结束时用它。',
  {
    key: z.string().describe('会话 key，格式 private:QQ号 或 group:群号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
  },
  async ({ key, token }) => {
    try {
      const data = await agentApi('/api/socialV2/call-hangup', {
        method: 'POST',
        body: JSON.stringify({ key }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `挂断失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_call_say',
  '在通话中主动说一句（合成成声音送进麦克风，对方会听到）。⚠️ 正常情况下**不需要**你手动调它：对方说完，你的回复会自动变成声音（通话中发消息会自动改道成说话，不会漏进聊天窗）。只在确实要抢在对方之前说点什么、或者这条不属于「回复对方」时用，别一句一句都自己念。',
  {
    key: z.string().describe('会话 key，格式 private:QQ号 或 group:群号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    text: z.string().describe('要说的话（口语、短句，别带 Markdown / 列表 / 代码）')
  },
  async ({ key, token, text }) => {
    try {
      const data = await agentApi('/api/socialV2/call-say', {
        method: 'POST',
        body: JSON.stringify({ key, text }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `通话中说话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_body_say',
  '让她**用屋里的喇叭**说一句话（身体那张嘴）。'
  + '跟打字/发语音条不是一回事：这句话会从她旁边的音箱放出来，屋里的人听得见，但**不会进 QQ 聊天窗**。'
  + '★什么时候用★ 主人在 QQ 里说「你从音箱里说一句给我听」「用身体说」「让屋里听见」这类要求时用它；'
  + '或者你自己觉得此刻该出声（比如他刚回到家、你被叫到名字）也能主动用一次。'
  + '★不要每条回复都调★ 那样喇叭会变成 QQ 的复读机 —— 只在真的需要"屋里听见"时才用。'
  + '说的话要口语、短（一两句），它会被念出来而不是被读。'
  + '⚠️ 只在管理员的私聊里可用：喇叭装在他屋里，别的地方调用会被拒绝（那不是故障）。'
  + '板子没开机/没连上网时会直接失败，并告诉你是哪一种。',
  {
    key: z.string().describe('会话 key，格式 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    text: z.string().describe('要念出来的话（口语、短；不要 Markdown/列表/链接）'),
    volume: z.number().optional().describe('临时音量 0~1.5；不填用控制台里那个滑杆的值'),
    timeoutMs: z.number().optional().describe('超时毫秒（默认 90000，最长 180000）')
  },
  async ({ key, token, text, volume, timeoutMs }) => {
    try {
      const data = await agentApi('/api/body/say', {
        method: 'POST',
        body: JSON.stringify({ key, text, volume, timeoutMs }),
        headers: { 'x-agent-token': token },
        // 念一句话要合成 + 按节拍推 + 等板子放完，几秒到几十秒；fetch 的默认预算不够。
        timeoutMs: Math.min(180000, Math.max(5000, Number(timeoutMs) || 90000)) + 5000
      });
      return {
        content: [{ type: 'text', text: serializeModelData(data) }],
        ...(data?.ok === false ? { isError: true } : {})
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `从喇叭说话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_run_command',
  '在主人这台电脑上执行一条命令，把输出（stdout/stderr/退出码）拿回来。'
  + '⚠️ 只允许在**管理员的私聊**里使用：群里和别人的私聊调用会被拒绝（那不是故障，是这台电脑只归主人）。'
  + '默认走 cmd.exe；要 PowerShell 就传 shell:"powershell"。cwd 不给就用项目目录。'
  + '⚠️ 命令会在主人的真实机器上生效（会真的建/删文件、真的装东西），调用前想清楚；'
  + '输出按 UTF-8/GBK 自动解码，超长会截断。',
  {
    key: z.string().describe('会话 key，格式 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    command: z.string().describe('要执行的命令行，例如 soffice --headless --convert-to docx 文件.md'),
    cwd: z.string().optional().describe('工作目录（绝对路径，或相对项目目录）；不填用项目目录'),
    shell: z.enum(['cmd', 'powershell']).optional().describe('用哪个 shell，默认 cmd'),
    timeoutMs: z.number().optional().describe('超时毫秒（默认 60000，最大 600000）')
  },
  async ({ key, token, command, cwd, shell, timeoutMs }) => {
    try {
      const data = await agentApi('/api/socialV2/host-run', {
        method: 'POST',
        body: JSON.stringify({ key, command, cwd, shell, timeoutMs }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }], ...(data?.ok === false ? { isError: true } : {}) };
    } catch (error) {
      return { content: [{ type: 'text', text: `执行命令失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_read_file',
  '读主人这台电脑上的一个文本文件（默认从开头读 20000 字，可用 offset/maxChars 往后翻；给目录路径则列目录）。'
  + '⚠️ 只允许在**管理员的私聊**里使用（群里和别人的私聊会被拒绝）。',
  {
    key: z.string().describe('会话 key，格式 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    path: z.string().describe('文件或目录路径（绝对路径，或相对项目目录）'),
    offset: z.number().optional().describe('从第几个字符开始读，默认 0'),
    maxChars: z.number().optional().describe('这次最多读多少字符（默认 20000，最大 60000）')
  },
  async ({ key, token, path: filePath, offset, maxChars }) => {
    try {
      const data = await agentApi('/api/socialV2/host-read', {
        method: 'POST',
        body: JSON.stringify({ key, path: filePath, offset, maxChars }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }], ...(data?.ok === false ? { isError: true } : {}) };
    } catch (error) {
      return { content: [{ type: 'text', text: `读文件失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_write_file',
  '在主人这台电脑上写一个文本文件（默认覆盖，append:true 则追加；父目录不存在会自动建）。'
  + '⚠️ 只允许在**管理员的私聊**里使用（群里和别人的私聊会被拒绝）。'
  + '⚠️ 会真改主人机器上的文件：覆盖前想清楚，宁可先 qq_read_file 看一眼。',
  {
    key: z.string().describe('会话 key，格式 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    path: z.string().describe('目标文件路径（绝对路径，或相对项目目录）'),
    content: z.string().describe('要写入的文本内容'),
    append: z.boolean().optional().describe('true=追加到文件末尾；默认 false=覆盖')
  },
  async ({ key, token, path: filePath, content, append }) => {
    try {
      const data = await agentApi('/api/socialV2/host-write', {
        method: 'POST',
        body: JSON.stringify({ key, path: filePath, content, append }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }], ...(data?.ok === false ? { isError: true } : {}) };
    } catch (error) {
      return { content: [{ type: 'text', text: `写文件失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.file?.enabled !== false && cfg.socialV2?.tools?.sendFile !== false) {
  server.tool(
    'qq_send_file',
    '发一个文件给对方（QQ 文件气泡，不是图片也不是语音）。管理员私聊和群里都能用（普通成员的私聊不开）。\n'
      + '⚠️ 群里只能发**下载目录里的**文件（她刚下载下来的那些）；要主人电脑上别的文件，得在管理员私聊里说。\n'
      + '两种用法：① 给一个 http(s) 链接，桥接自己下载到本机再上传（最常用，例如"把这个 PDF 下载下来发给我"）；'
      + '② 给一个本机路径（下载目录里的文件名也行），直接上传那个文件。\n'
      + '下载会走 SSRF 白名单校验（只允许 http/https、禁内网地址），单文件上限由主人设（默认 200 MB）。\n'
      + '下载的东西落在 `桌面\\QQ bot\\小鲸鱼下载\\YYYY-MM-DD\\`，按天分袋；之后只写文件名（如 `报告.pdf`）她会自己在各日期袋里找到。\n'
      + '文件由网关上传并发成气泡，所以你不需要再补一句"文件已发送"——发完正常说话就行。\n'
      + '⚠️ 同一小时有数量上限；超了会明确告诉你，别重试。\n'
      + '⚠️ 这个工具不支持引用/@：文件气泡由网关发，拼不进 reply 段。想引用就先用 qq_reply 说那句话，再发文件。',
    {
      key: z.string().describe('会话 key，格式 private:QQ号 或 group:群号（管理员私聊和群聊都能用；普通成员的私聊不开）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      file: z.string().describe('http(s) 链接（会先下载），或本机文件路径 / 下载目录里的文件名（群里只能给下载目录里的）'),
      name: z.string().optional().describe('发给对方时显示的文件名（不给就用链接或路径里的名字）')
    },
    async ({ key, token, file, name }) => {
      try {
        const data = await agentApi('/api/socialV2/send-file', {
          method: 'POST',
          body: JSON.stringify({ key, token, file: String(file), name }),
          headers: { 'x-agent-token': token },
          // 大文件要下载 + 上传 + 过高速通道，给足时间（和 qq_send_photo 同级）。
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }], ...(data?.ok === false ? { isError: true } : {}) };
      } catch (error) {
        return { content: [{ type: 'text', text: `发文件失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// 生图（2026-10-29）：走本机桌面版的「生图工作室」插件，画完直接把图发进当前会话。
//
// ⚠️ 必须登记在这里的理由和 call / localExec 一样：控制台里关了它们、模型却仍能看到
//    工具描述，就会反复去调一个必然 403 的接口（然后当成 bug 上报）。
if (cfg.socialV2?.image?.enabled !== false && cfg.socialV2?.tools?.drawImage !== false) {
  server.tool(
    'qq_draw_image',
    '画一张图，并直接发进当前会话 —— QQ 里要发自拍/出图就用这个。\n'
      + '⚠️ 不要用插件自带的 image_generate：它在 QQ 会话里被工具守卫拦着，调了也是白调。'
      + '画面怎么描述、有哪些关键词和参考库条目，看上面「生图」那一段的说明就行，参数名两边是一样的。\n'
      + '出图要 1~5 分钟（4K 那档更久），工具会一直等到画完再发，所以**不要**再说"正在画""稍等"这类话；'
      + '万一超过 7 分钟，就已经挂到后台继续等了，画好会直接补发给你，你如实说一句"还在画"就好。\n'
      + '现有参考库：人物（小鲸鱼·成女版 / 小鲸鱼·Q版）、服饰（深海女仆装·成女版 / 深海女仆装·Q版）、'
      + '场景（深海气泡 / 星空夜 / 雨天窗边 / 办公桌前）、道具（配饰与纹样 / 小蓝鲸与水花图案）。\n'
      + '管理员私聊和群里都能用（普通成员的私聊不开，别的一对一也开不了）；一次一张，一张约 4 分钱。\n'
      + '⚠️ 有日额度：管理员私聊不限，群聊默认每人每天 5 张，用完会明确告诉你。'
      + '有人反复要、或者要你画很多张时，别一张张硬试 —— 直接说今天额度到了。',
    {
      key: z.string().describe('会话 key，格式 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      prompt: z.string().describe('这一张的画面本身：她在哪、在做什么、和周围的互动、构图与情绪重点'),
      situation: z.string().optional().describe('情境关键词：在家休息/睡前/刚睡醒/客厅放松/工作学习/外出/吃东西/下雨天'),
      expression: z.string().optional().describe('神态关键词：开心/微笑/害羞/得意/撒娇/委屈/生气/惊讶/困倦/认真/平静/难过/无语/紧张'),
      pose: z.string().optional().describe('动作关键词：站着/坐着/抱膝坐/躺着/趴着/伸懒腰/托腮/挥手/回头/比耶/抱着东西/看书/喝饮料/奔跑'),
      shot: z.string().optional().describe('镜头关键词：自拍/特写/近景/半身/全身/远景/俯视/仰视/第一人称'),
      light: z.string().optional().describe('光线关键词：午后暖阳/清晨柔光/黄昏逆光/夜晚台灯/霓虹夜景/阴雨天/月光'),
      characters: z.array(z.string()).optional().describe('人物库条目（id 或名字），一般填 ["小鲸鱼"] 或 ["小鲸鱼·Q版"]'),
      outfits: z.array(z.string()).optional().describe('服饰库条目（id 或名字）；不填就按情境和场景自动搭'),
      scene: z.string().optional().describe('场景库条目（id 或名字）'),
      props: z.array(z.string()).optional().describe('道具库条目（id 或名字）'),
      extra_images: z.array(z.string()).optional().describe('想在上一张的基础上改时，填它的图片编号（img- 开头）'),
      aspect: z.string().optional().describe('画幅，如 3:4、1:1、16:9；不填按 3:4'),
      replyToMessageId: z.string().optional().describe('要引用/回复的消息 id（可选）')
    },
    async ({ key, token, ...rest }) => {
      try {
        const data = await agentApi('/api/socialV2/draw-image', {
          method: 'POST',
          body: JSON.stringify({ key, token, ...rest }),
          headers: { 'x-agent-token': token },
          // 桥接那边自己等 7 分钟，这里要留得比它宽。
          timeoutMs: 570000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }], ...(data?.ok === false ? { isError: true } : {}) };
      } catch (error) {
        return { content: [{ type: 'text', text: `生图失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// 控制台那个开关叫 `drawImage`，说明里写的是「关掉后这两个工具整个消失」——
// 所以这里也得看 drawImage，否则关了开关 qq_send_image 还在。
if (cfg.socialV2?.image?.enabled !== false && cfg.socialV2?.tools?.drawImage !== false && cfg.socialV2?.tools?.sendImage !== false) {
  server.tool(
    'qq_send_image',
    '把一张已经画好的图再发一次（只认「生图工作室」产出目录里的文件）。\n'
      + '平时用不着 —— qq_draw_image 画完就会自动发。这个用在"刚才那张再发一遍""换个人/群再发一次"的时候。\n'
      + 'image 填文件名（img-….png）或 img- 开头的编号都行。管理员私聊和群里都能用。',
    {
      key: z.string().describe('会话 key，格式 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      image: z.string().describe('要发的图：文件名、img- 开头的编号，或产出目录里的相对路径'),
      replyToMessageId: z.string().optional().describe('要引用/回复的消息 id（可选）')
    },
    async ({ key, token, ...rest }) => {
      try {
        const data = await agentApi('/api/socialV2/send-image', {
          method: 'POST',
          body: JSON.stringify({ key, token, ...rest }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }], ...(data?.ok === false ? { isError: true } : {}) };
      } catch (error) {
        return { content: [{ type: 'text', text: `发图失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_send_burst',
  '在指定 QQ 群分多条发送消息（二代仿真模式专用），桥接会按真人化随机间隔发送。暂不支持引用，需要引用请用 qq_reply。注意：数组里的每个字符串就是一条 QQ 消息，字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.array(z.string()).min(1), z.string()]).describe('要发送的消息数组，每条为纯文本；也兼容传入 JSON 数组字符串')
  },
  async ({ groupId, token, messages }) => {
    try {
      const key = `group:${groupId}`;
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-burst', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分条发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_message',
  '统一发送工具：可发一条或多条，可引用某条消息，可自定义/按字数计算条间时间差。二代仿真模式专用。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。只有以下情况才需要传 replyToMessageId 引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_qzone_msg',
  '在 QQ 空间发表一条说说（自主发送，公开可见）。content 为正文；ugcRight 控制可见范围：1=所有人可见，4=好友可见（默认，推荐），16=部分好友可见，64=仅自己可见，128=部分好友不可见；16/128 时必须传 targetUins（QQ 号数组）。images 可选，传图片（file:// http:// base64:// 自动上传）。说说是公开内容，发之前想清楚措辞，不要发隐私、真实姓名、令牌或任何敏感信息。reserved2 下必须携带会话令牌 token。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    content: z.string().describe('说说正文'),
    ugcRight: z.number().optional().describe('查看权限：1=所有人/4=好友可见（默认）/16=部分好友/64=仅自己/128=部分不可见'),
    images: z.array(z.string()).optional().describe('图片数组（可选），file:// http:// base64:// 自动上传'),
    targetUins: z.array(z.number()).optional().describe('权限作用 QQ 号数组，ugcRight=16/128 时必填')
  },
  async ({ key, token, content, ugcRight, images, targetUins }) => {
    try {
      const data = await agentApi('/api/socialV2/send-qzone', {
        method: 'POST',
        body: JSON.stringify({ key, content, ugcRight: ugcRight ?? 4, images, targetUins }),
        headers: { 'x-agent-token': token },
        timeoutMs: 60000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发说说失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_qzone_list',
  '查看 QQ 空间说说列表（只读）。默认看自己空间的说说，返回 tid、正文、发表时间、评论数、可见性、图片 URL。用来确认「我刚发的说说发出去没有、现在是什么样」，也可以翻自己以前的说说。要操作某条说说（点赞/评论/删）需要先从这里拿 tid。reserved2 下必须携带会话令牌 token。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    pos: z.number().optional().describe('起始偏移，默认 0'),
    num: z.number().optional().describe('本页数量，默认 20，最大 100'),
    targetUin: z.union([z.number(), z.string()]).optional().describe('目标 QQ 号，省略则看自己的空间')
  },
  async ({ key, token, pos, num, targetUin }) => {
    const q = new URLSearchParams({ key });
    if (pos !== undefined) q.set('pos', String(pos));
    if (num !== undefined) q.set('num', String(num));
    if (targetUin !== undefined && targetUin !== null) q.set('targetUin', String(targetUin));
    try {
      const data = await agentApi(`/api/socialV2/qzone-list?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取说说列表失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_qzone_feeds',
  '看 QQ 空间好友动态流（只读）：返回好友们最近发的说说（作者 QQ 号、昵称、时间、appid、feed key 和一段预渲染文本）。用来「看看大家在空间里发了什么」——这个可以被人叫去看，不受自主限制。想看某条说说的完整正文或要操作它，先用 qq_get_qzone_list 拿 tid。reserved2 下必须携带会话令牌 token。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    pageNum: z.number().optional().describe('页码，默认 1（仅首页可靠）'),
    count: z.number().optional().describe('本页数量，默认 10，最大 50')
  },
  async ({ key, token, pageNum, count }) => {
    const q = new URLSearchParams({ key });
    if (pageNum !== undefined) q.set('pageNum', String(pageNum));
    if (count !== undefined) q.set('count', String(count));
    try {
      const data = await agentApi(`/api/socialV2/qzone-feeds?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取空间动态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ⭐ 空间写操作（点赞/取消赞/评论/删除/改可见性）都走同一个端点，由桥接的
// 「自主闸门」在执行期判定：**只有你自己起的回合才允许**（主动冒泡/潜水到期/回看回复），
// 别人在对话里叫你去做 —— 包括管理员 —— 会被拒绝，并给出说明，照实转述即可。
server.tool(
  'qq_qzone_like',
  '给一条说说点赞或取消赞（QQ 空间）。⚠️ 这是写操作：只有在**你自己起的回合**里才能做（主动冒泡、潜水到期、回看回复）；如果是别人在对话里叫你「去点赞」，会被桥接拒绝——包括管理员要求的也一样，照实说明即可。tid 用 qq_get_qzone_list / qq_get_qzone_feeds 拿；给别人的说说点赞要传 targetUin，省略则是自己空间。reserved2 下必须携带会话令牌 token。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    tid: z.string().describe('说说 tid（来自 qq_get_qzone_list / qq_get_qzone_feeds）'),
    unlike: z.boolean().optional().describe('true=取消赞，省略/false=点赞'),
    targetUin: z.union([z.number(), z.string()]).optional().describe('说说所属 QQ 号，省略则为自己的说说'),
    abstime: z.number().optional().describe('说说发表时间（unix 秒），传真实值更可靠')
  },
  async ({ key, token, tid, unlike, targetUin, abstime }) => {
    try {
      const data = await agentApi('/api/socialV2/qzone-action', {
        method: 'POST',
        body: JSON.stringify({ key, op: unlike ? 'unlike' : 'like', tid, targetUin, abstime }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `空间点赞${unlike ? '（取消）' : ''}失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_qzone_comment',
  '评论一条说说（QQ 空间）。⚠️ 这是**公开发言**的写操作：只有在**你自己起的回合**里才能做，别人叫你评论会被桥接拒绝（包括管理员）。内容会走与发说说相同的敏感信息审计（路径/凭据/令牌一律拦），上限 500 字。给别人的说说评论要传 targetUin。reserved2 下必须携带会话令牌 token。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    tid: z.string().describe('说说 tid'),
    content: z.string().describe('评论正文（≤500 字）'),
    targetUin: z.union([z.number(), z.string()]).optional().describe('说说所属 QQ 号，省略则为自己的说说')
  },
  async ({ key, token, tid, content, targetUin }) => {
    try {
      const data = await agentApi('/api/socialV2/qzone-action', {
        method: 'POST',
        body: JSON.stringify({ key, op: 'comment', tid, content, targetUin }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `空间评论失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_qzone_delete',
  '删除一条自己的说说（QQ 空间）。⚠️ 写操作，且不可撤销：只有在**你自己起的回合**里才能做，别人叫你删会被拒绝（包括管理员）。tid 从 qq_get_qzone_list 拿。reserved2 下必须携带会话令牌 token。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    tid: z.string().describe('要删除的说说 tid（来自 qq_get_qzone_list）')
  },
  async ({ key, token, tid }) => {
    try {
      const data = await agentApi('/api/socialV2/qzone-action', {
        method: 'POST',
        body: JSON.stringify({ key, op: 'delete', tid }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `删除说说失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_qzone_set_right',
  '修改一条自己说说的可见范围（QQ 空间）。⚠️ 写操作：只有在**你自己起的回合**里才能做，别人叫你改会被拒绝（包括管理员）。ugcRight：1=所有人可见，4=好友可见，16=部分好友可见，64=仅自己可见，128=部分好友不可见；16/128 时必须传 targetUins。reserved2 下必须携带会话令牌 token。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    tid: z.string().describe('说说 tid'),
    ugcRight: z.number().describe('可见范围：1/4/16/64/128'),
    targetUins: z.array(z.number()).optional().describe('ugcRight=16/128 时的可见/不可见名单')
  },
  async ({ key, token, tid, ugcRight, targetUins }) => {
    try {
      const data = await agentApi('/api/socialV2/qzone-action', {
        method: 'POST',
        body: JSON.stringify({ key, op: 'setRight', tid, ugcRight, targetUins }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `修改说说可见范围失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_account_info',
  '查看当前 QQ 账号自己的身份信息（只读）：自己的 QQ 号、昵称、签名、性别年龄、等级，以及好友列表（QQ 号/昵称/备注），并标出哪一个是主人。用来搞清楚「我是谁、我有哪些好友」——尤其在不记得自己昵称或想确认某个好友是不是主人时。reserved2 下必须携带会话令牌 token。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
  },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/account-info?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取账号信息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.tools?.sendPoke !== false) {
  server.tool(
    'qq_send_poke',
    '发送 QQ 拍一拍（群聊/私聊）。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。群聊必须传 targetUserId（要拍的群友 QQ 号，可从 qq_get_active_members / qq_get_message_detail 的 userId 获取）；私聊可不传 targetUserId（默认拍当前私聊对象）。reserved2 下必须携带会话令牌 token，发送会受桥接白名单与发送频率限制。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_wait_for_messages',
  '等待分两种用途。首答前已读消息、只想确认有没有补充：用 purpose="reply"，按最后来信时间补足 quietMs 静默，已安静足够就立即返回；读取/思考时新到的消息也会返回，新消息重算静默。timeoutMs 是最长预算，不要求等满；预算到但 quiet=false 不代表对方已说完。此用途绝不代替沉睡前观察。等对方继续说、等回复或睡前观察：用默认 purpose="messages"；先等新消息，收到后才按 quietMs 等静默，没有新消息会等到 timeoutMs，单传 quietMs 不会缩短总等待。静默下限由后台配置，默认 10000ms。直接看 newMessages、unreadCount 和 readThroughSeq，返回消息无需重复查询；仍有未展示未读才补读。决定潜水/收尾时才用默认用途加 timeoutMs=300000 完成沉睡前观察，不能把 5 分钟观察放在首答之前；短等待不能代替。全程无人说话返回 preSleepWaitSatisfied=true；观察期间来了新消息返回 preSleepWaitObserved=true，读后不需参与可收尾，参与回复则下次收尾重新观察。preSleepWaitRemainingMs 仅供准备收尾时参考。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    purpose: z.enum(['messages', 'reply']).optional().describe('默认 messages：等新消息/回复/睡前观察；reply：回复前短静默，计入最后来信后已过去的时间，绝不授予睡前观察资格'),
    timeoutMs: z.number().optional().describe('等待预算毫秒数，默认 120000、最大 600000；reply 达到静默即返回，不必等满；沉睡前观察用 messages 并传 300000'),
    minNewMessages: z.number().optional().describe('仅 messages 用途：至少等到多少条新消息才进入静默窗口，默认 1；reply 用途会忽略它'),
    quietMs: z.number().optional().describe('静默窗口毫秒数，建议 10000~12000；reply 从最后来信开始计时，messages 只在等到新消息后计时；后台默认至少 10000')
  },
  async ({ key, token, purpose, timeoutMs, minNewMessages, quietMs }) => {
    try {
      const data = await agentApi('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, purpose, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 120000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_report_feedback',
  '⭐ 发现出问题时，用它**告诉主人** —— 会真的给他发一条 QQ 私信（不是只写日志）。'
  + '什么时候用：工具连续失败（发不出、空间被拒、语音合成不了）、配置看着不对、'
  + '或者你发现"这事主人应该知道但他不知道"。'
  + '由你自己判断值不值得占他一次注意力 —— 但真发现问题别闷着，他不知道就永远没法修。'
  + '⚠️ 同一个问题反复发生，每次都报（别以为"报过了"就不报，他需要知道还没好）。'
  + '⚠️ 这只是通知，不是对话：写清楚"发生了什么 + 你试过什么 + 现在什么状态"，别指望他马上回。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容'),
    // 默认按 level 决定（warning/error 会推，info 只记录）；这个参数用来覆盖默认。
    notify: z.boolean().optional().describe('可选：是否私信主人。不填则 warning/error 会推、info 只记录。'
      + '当你觉得"这事他必须知道"时传 true（哪怕 level 是 info）；只是留个记录就传 false。')
  },
  async ({ key, token, level, message, notify }) => {
    try {
      const data = await agentApi('/api/socialV2/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message, notify }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_my_recent_messages',
  '查看自己最近发过的消息（只读），避免重复/保持人设。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 10，最大 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_message_detail',
  '按 message_id / 本地 seq 查看单条消息的发送者、引用信息与正文（只读）。注意：正文最多返回 200 字符，textTruncated=true 表示被截断，这里不是读取长消息全文的入口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可能为负数）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/socialV2/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_active_members',
  '查看最近活跃成员列表（只读），帮助判断话题参与者。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_append',
  '记录一条轻量记忆：activeTopic=进行中的话题；pendingThought=你想说但还没说的话；memberImpression=对某位群友的印象。记忆会持久化，并在后续唤醒/qq_get_prompt 中自动出现。⚠️ memberImpression 的 target **必须是 QQ 号**（例如 "100000001"），不要填昵称/群名片——昵称会被随便乱改、也会重名，只有 QQ 号能稳定认出同一个人；昵称想留就放 displayName。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().describe('记忆内容，例如话题、想说的话、对某人的印象标签'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友 **QQ 号**（纯数字，不是昵称）'),
      displayName: z.string().optional().describe('memberImpression 时的显示名（昵称/群名片，仅用于展示，不参与身份判断）'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_query',
  '查看记忆（只读）。默认返回当前会话的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象。'
  + '带 q 参数则改为检索「更早的记忆归档」。'
  + '⭐ 对方说了具体日期（"10月22号我们聊了什么""昨天说过什么"）时，用 day 参数 —— 它会直接列出那天的记忆，不用猜关键词。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression', 'archive']).optional().describe('可选：只看某一类记忆；archive = 查更早的归档记忆'),
    q: z.string().optional().describe('可选：在归档记忆里检索的关键词（多个词用空格分隔，任一命中即算）。给了它就查归档，不再返回轻量记忆。'
      + '⭐ 检索会自动带上同义词（搜"硬件"能搜到写着"板子/单片机"的记忆，搜"游戏"能搜到"消消乐"，搜"语音"能搜到"喇叭"），所以用你会说的那个词就行，不必猜原话。'
      + '⭐ 想严格要求"两个词都要有"就在词前加 +（如 `+硬件 +语音`）；不加 + 就是"沾上哪个都算"，想不起原话时用这个。'
      + '⭐ 结果里带 `~（推断）` 的是**你自己当时推出来的**（不是对方说的、也不是你亲眼见的）：可以提，但要带上"我猜""我记得好像是"，别当成他说过的话去对质。'),
    day: z.string().optional().describe('可选：查**某一天**的归档记忆。可写 2026-10-22 / 10月22 / 昨天 / 前天 / 3天前。给了它就只列那天的事（可以和 q 叠加）'),
    from: z.string().optional().describe('可选：日期区间起点（写法同 day）。和 to 一起用，查"这一段时间"'),
    to: z.string().optional().describe('可选：日期区间终点（写法同 day）'),
    limit: z.number().optional().describe('可选：归档检索最多返回几条（默认 12，最大 50）')
  },
  async ({ key, token, category, q, day, from, to, limit }) => {
    try {
      const params = new URLSearchParams({ key });
      if (category) params.set('category', category);
      if (q) params.set('q', q);
      if (day) params.set('day', day);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (limit) params.set('limit', String(limit));
      const data = await agentApi(`/api/socialV2/memory?${params.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_remove',
  '删除一条轻量记忆：activeTopic/pendingThought 用 content 匹配原文删除；memberImpression 用 target 参数指定 **QQ 号**删除。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().optional().describe('要删除的话题/想法原文（memberImpression 不需要）'),
    target: z.string().optional().describe('memberImpression 时要删除的群友 **QQ 号**')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_clear',
  '清空轻量记忆：不传 category 清空全部；传 activeTopic/pendingThought/memberImpression 只清空对应类别。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('要清空的类别，缺省清空全部')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_query',
  '查看当前已确认的群聊黑话/梗/网络表达（只读）。返回已确认词条列表和格式化黑话表；遇到不熟悉的词可先查这里，再决定是否搜索/使用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    q: z.string().optional().describe('可选搜索词，按词条/含义/用法/示例过滤')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/socialV2/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_submit',
  '把你在群里经常看到但不确定含义/用法的陌生词、黑话、梗或网络表达提交给管理员筛选。提交后进入候选库，管理员确认后会被写入黑话提示词，成为你后续可查询和使用的记忆。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    content: z.string().describe('要提交的陌生词/黑话/梗（最多 50 字）'),
    context: z.string().optional().describe('可选：你是在什么语境/哪条消息里看到的，帮助管理员判断')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/socialV2/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
if (cfg.socialV2?.tools?.getImages !== false) {
  server.tool(
    'qq_get_message_images',
    '获取指定 QQ 消息中的图片/表情，并直接以图像内容返回给模型（视觉模型可“看懂”）。当消息文本里出现 [图片]、[表情] 或 hasMedia=true 时调用。支持一条消息里的多张图片/表情；二代模式下必须携带会话令牌。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        for (const img of images) {
          if (img?.data && img?.mimeType) {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 socialV2.sticker.maxListCount 配置上限约束（当前通常 100）'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        // 强制同步走 POST：GET 上的 refresh 参数会让「读接口」产生写副作用
        // （真的去问 OneBot 拉收藏表情并落盘 state/stickers.json），
        // 从而绕开控制台对所有非 GET 请求的 CSRF 防护（一个 <img src=...> 就能触发）。
        const data = await agentApi('/api/socialV2/sticker-list', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, query: query ? String(query) : '', count, refresh: refresh === true, token })
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.getStickerImage !== false) {
  server.tool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${data?.error || '未知'}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  server.tool(
    'qq_send_sticker',
    '在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  server.tool(
    'qq_collect_sticker',
    '收藏当前会话里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。messageId 用 qq_get_unread_messages / qq_get_recent_messages 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages / qq_get_recent_messages）'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
    },
    async ({ key, token, messageId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 群图库工具（本地存的群友图片） ─────────────────────────────────────────
// ⚠️ 与上面的「收藏表情」是两套东西、两套工具，别混：
//   收藏表情 → qq_list_stickers / qq_get_sticker_image / qq_send_sticker
//   本地群图 → qq_photo_list    / qq_get_photo_image    / qq_send_photo
// 群图是桥接**自动**从群里收下来的（去重后落盘），她没有"收藏"这个动作要做。
if (cfg.socialV2?.photo?.enabled !== false && cfg.socialV2?.tools?.listPhotos !== false) {
  server.tool(
    'qq_photo_list',
    '查看本地「群图库」里存下来的群友图片：这是桥接自动从群消息里收下来的图（已去重、分候选/正式/回收站），和 QQ 账号的收藏表情不是一回事。可用 query 按备注/标签/来源消息搜；没有备注的图先 qq_get_photo_image 看一眼再决定要不要用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词：按备注/标签/发图人/消息文本过滤'),
      tag: z.string().optional().describe('可选：只看某个标签'),
      count: z.number().optional().describe('返回几条，默认 24')
    },
    async ({ key, token, query, tag, count }) => {
      try {
        const q = new URLSearchParams({ key });
        if (query) q.set('query', String(query));
        if (tag) q.set('tag', String(tag));
        if (count) q.set('count', String(count));
        const data = await agentApi(`/api/socialV2/photo-list?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取群图失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.photo?.enabled !== false && cfg.socialV2?.tools?.getPhotoImage !== false) {
  server.tool(
    'qq_get_photo_image',
    '获取本地群图库里某一张图的画面内容，直接以图像返回给模型（视觉模型可“看懂”）。当 qq_photo_list 返回的条目没有备注、你拿不准它长什么样时调用；看完可以用 qq_photo_note 记下你的理解。photoId 用 qq_photo_list 返回的 id。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      photoId: z.string().describe('群图 id（来自 qq_photo_list）')
    },
    async ({ key, token, photoId }) => {
      try {
        const q = new URLSearchParams({ key, photoId: String(photoId) });
        const data = await agentApi(`/api/socialV2/photo-image?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 180000
        });
        if (!data?.data || !data?.mimeType) {
          return { content: [{ type: 'text', text: `群图没有可返回的画面：${data?.error || '未知'}` }], isError: true };
        }
        const desc = data.desc ? `（备注：${data.desc}）` : '';
        const tags = Array.isArray(data.tags) && data.tags.length ? `（标签：${data.tags.join('/')}）` : '';
        return {
          content: [
            { type: 'text', text: `群图 ${data.photoId}${desc}${tags} 的画面内容：` },
            { type: 'image', mimeType: data.mimeType, data: data.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取群图画面失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.photo?.enabled !== false && cfg.socialV2?.tools?.sendPhoto !== false) {
  server.tool(
    'qq_send_photo',
    '在指定会话发送一张「本地群图库」里的图片。photoId 用 qq_photo_list 返回的 id（也可直接给一句描述，但仅在能唯一匹配到一张图时有效）。注意：一条消息只能是一张图，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发，再单独发这张图。要发 QQ 收藏表情请用 qq_send_sticker。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      photoId: z.string().describe('群图 id（来自 qq_photo_list）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, photoId, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-photo', {
          method: 'POST',
          body: JSON.stringify({ key, photoId: String(photoId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送群图失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.photo?.enabled !== false && cfg.socialV2?.tools?.photoNote !== false) {
  server.tool(
    'qq_photo_note',
    '给群图库里的一张图记下你自己的理解（描述/标签），下次选图就能更准。看完图（qq_get_photo_image）再写；只在真的看懂、值得记的时候写，别每张都写。这是本地记忆，不会改 QQ 账号里的任何东西。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      photoId: z.string().describe('群图 id（来自 qq_photo_list）'),
      note: z.string().optional().describe('你对这张图的理解，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]')
    },
    async ({ key, token, photoId, note, tags }) => {
      try {
        const data = await agentApi('/api/socialV2/photo-note', {
          method: 'POST',
          body: JSON.stringify({ key, token, photoId: String(photoId), note, tags }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录群图备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.voice?.enabled !== false && cfg.socialV2?.tools?.sendVoice !== false) {
  server.tool(
    'qq_send_voice',
    '在指定会话发一条 QQ 语音（把语音库里准备好的音频当语音条发出去）。voice 传 qq_list_voices 返回的 name（文件名，可带子目录），也可以直接传语音库里的文件名（不带扩展名也能匹配）。注意：① 只能发语音库（qq-bridge/audio/）里的文件，不能发任意本地路径，也不能发 URL/base64；② 受时长与频率上限约束（见 qq_list_voices 的 limits），超限会被拒绝；③ 语音是「开口说话」的强表达，别滥用，闲聊里偶尔发一条即可；④ 返回的 verified=true 表示已经用 get_msg 回读到这条消息的 record 段（语音确实落地了）—— 只有 verified=true 才能对用户说你发了语音；⑤ readback 只对「收到的」语音有意义（QQ 会转写别人的语音），自己发的语音一般拿不到转写文本，默认关闭，别依赖它。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      voice: z.string().describe('语音库里的文件名（来自 qq_list_voices 的 name，可带子目录/可省略扩展名）'),
      label: z.string().optional().describe('可选：写进会话记录里的说明，如「说了句晚安」'),
      verify: z.boolean().optional().describe('是否回读校验语音已落地（默认 true，建议保持开启）'),
      readback: z.boolean().optional().describe('是否额外索取 QQ 转写文本（自己发的语音通常没有，默认 false）')
    },
    async ({ key, token, voice, label, verify, readback }) => {
      try {
        const data = await agentApi('/api/socialV2/send-voice', {
          method: 'POST',
          body: JSON.stringify({
            key,
            voice: String(voice),
            label: label || '',
            verify: verify !== false,
            readback: readback === true,
            token
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送语音失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_list_voices',
    '查看可用的语音库（qq-bridge 的 audio 目录里准备好的音频文件）：文件名、时长、大小。想发语音前先调用这个看有哪些能发（名字用返回的 name）。返回里 limits 是时长/体积/频率上限。语音库里没有合适内容时不要硬发，也不要假装发了语音。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      probe: z.boolean().optional().describe('是否逐个探测时长（默认 true；文件多时可传 false 加快）')
    },
    async ({ key, token, probe }) => {
      try {
        const q = new URLSearchParams({ key });
        if (probe === false) q.set('probe', '0');
        const data = await agentApi(`/api/socialV2/voices?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取语音库失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ⚠️ 这里**不再**用 `speak !== false` 当注册条件。
//
// 原因见上面 ALWAYS_REGISTER 的说明：关掉之后工具如果直接消失，她只会看到
// "没有这个工具"，分不清"主人关的"还是"语音坏了"——实测她就这么误报过。
// 现在改成始终注册，开关状态由桥接在调用时判定并给出人话解释。
// tts.enabled 同理：桥接那边是热读 cfg 的，这里用启动快照判断会与实况不一致。
{
  server.tool(
    'qq_say',
    '★ 你现在的默认说话方式：先把话**念出来**发语音条，语音实在发不出去才用文字。★'
    + '这是主人 2026-10-20 定下的规则：他发文字、发语音，你都回语音，除非语音用不了。'
    + '日常回话优先用它，而不是 qq_send_message —— 除非：① 内容需要被精确阅读（链接、代码、长列表、数字）；'
    + '② 你已经知道语音这会儿发不出去（比如刚连试两次都退回文字），那这轮就直接 qq_send_message，别硬试；'
    + '③ 你在群里说话而且要引用/@ 别人（这个工具不支持引用和 @，那种场合用 qq_send_message / qq_reply）。'
    + '\n返回里的 `mode` 字段是**唯一可信的实况**：mode="voice" 表示真的发出了语音条；'
    + 'mode="text" 表示这次退成了文字（detail 里写了原因）。'
    + '⚠️ 不要因为 mode="text" 就重复调用再试一次 —— 桥接已经替你兜底发出去了，再发就是重复消息。'
    + '⚠️ 语音合成要一两秒，一次别发太多条；单条 300 字以内。'
    + '\n【语音被主人关掉的时候】如果 mode="text" 且 detail 说"语音是主人自己关掉的"，'
    + '那不是故障、不是坏了 —— 是他主动在设置里关了（socialV2.tools.speak=false），这句话已经按文字发给对方了。'
    + '之后直接打文字就行（这个工具会一直这样退回文字），不用再试语音、不用换别的工具、也不用报给主人。'
    + '\n【mode】默认 voice-first：发不出去就自动改文字，保证对方一定收到。'
    + '如果这句话必须用声音说（退成打字就变味了，比如一句「晚安」），传 mode="voice-only"：'
    + '那样发不出去就直接报错，绝不改文字。'
    + '\n【verify】可选，控制要不要回读校验这条语音真的落地了；不传就按后台配置。',
    {
      key: z.string().describe('会话 key，格式 private:QQ号（群聊里用 qq_send_message 更好，能引用/@）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      text: z.string().describe('要说的话本身（口语、别带 Markdown / 列表 / 代码；一两句最好，超长会被截断）'),
      label: z.string().optional().describe('可选：写进会话记录的说明，如「说了句晚安」'),
      voice: z.string().optional().describe('可选：临时换音色；一般不用填，用默认音色就好'),
      rate: z.string().optional().describe('可选：语速，如 "+10%" / "-10%"；不填用默认'),
      verify: z.boolean().optional().describe('可选：是否回读校验语音已落地（不填就按桥接的 voice.autoReadback 配置）'),
      mode: z.enum(['voice-first', 'voice-only']).optional().describe(
        '可选：voice-first=发不出去就改文字（默认，推荐）；'
        + 'voice-only=只发语音，发不出去就报错、绝不改文字。'
        + '什么时候用 voice-only：这句话必须用声音说才有味道（比如一句「晚安」），退成打字就变味了。'
      )
    },
    async ({ key, token, text, label, voice, rate, verify, mode }) => {
      try {
        const data = await agentApi('/api/socialV2/speak-or-text', {
          method: 'POST',
          body: JSON.stringify({
            key,
            text: String(text),
            label: label || '',
            voice: voice || '',
            rate: rate || '',
            verify: verify === undefined ? null : verify,
            mode: mode || ''
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        // ⭐ 「被主人关掉的配置」不是故障：必须把这条区别明明白白交给她，
        //    否则她会读成"语音坏了"，反复重试，还把这事当成 bug 报给主人 ——
        //    而真相是主人在控制台主动关的开关。
        //    这里不能只抛一句 error 文案：她需要知道「不用重试、不用上报、改用文字」。
        if (error?.kind === 'disabledByOwner') {
          return {
            content: [{
              type: 'text',
              text: '语音已被主人在设置里关了（socialV2.tools.speak=false），不是坏了、不是故障。\n' +
                '· 不用重试，也不必把它当成问题报给主人；主人在控制台重新打开就会恢复。\n' +
                '· 这一轮改用 qq_send_message 发文字就行。'
            }],
            isError: true
          };
        }
        return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.stickerNote !== false) {
  server.tool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/socialV2/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.setStickerRemark !== false) {
  server.tool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（socialV2.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
if (cfg.socialV2?.tools?.getForwardMsg !== false) {
  server.tool(
    'qq_get_forward_msg',
    '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）与 nestedForwardIds；如果合并转发里有图片，工具会直接把最多 5 张图片以图像内容返回给视觉模型；如果里面有嵌套合并转发，会附带嵌套转发 id 和前几条预览，必要时可继续用本工具查看嵌套 id。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: serializeModelData(data) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/socialV2/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  // ── 日记本（她自己的本子）────────────────────────────────────────────────
  // 只有"写一条"和"看"两个工具。**故意不给删除、不给改写、不给"改成某一天"**：
  // 日记是发生过的事，不是草稿。要改只能用户手动改 data/日记/YYYY-MM-DD.jsonl。
  //
  // 描述文案是照《进阶篇》的三个坑写的：
  //   ① 不规定"什么时候写"（否则就是打卡，不是日记）；
  //   ② 明确禁止"今天真是充实的一天"这类总结句；
  //   ③ 不出现"你应该记录今天发生的事"，只说"你想写什么就写什么"。
  server.tool(
    'qq_write_diary',
    '★写一条日记★ 你自己的本子，没人检查，想写什么写什么：今天发生的事、此刻的心情、想记住的那一下，都行。写法：第一人称、口语、短句，像自己跟自己说话；不要 Markdown，也别写"今天真是充实的一天"这种总结句——写具体的那个瞬间，比如"那只梨没回来"。一天最多 3 条，一般一两句就够，有话说也可以多写。什么时候写随你：睡前、发生了想记住的事、心情有起伏的时候。不想写就不写。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      text: z.string().describe('日记内容，一两句就行'),
      mood: z.string().optional().describe('心情，几个字，比如"还行""有点闷"'),
      title: z.string().optional().describe('可选的小标题'),
      tags: z.array(z.string()).optional().describe('可选的标签'),
      day: z.string().optional().describe('可选：写到哪一天（YYYY-MM-DD），默认今天'),
      time: z.string().optional().describe('可选：书写时间（HH:mm），默认现在')
    },
    async ({ key, token, text, mood, title, tags, day, time }) => {
      try {
        const data = await agentApi('/api/socialV2/diary', {
          method: 'POST',
          body: JSON.stringify({ key, text, mood, title, tags, day, time }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `写日记失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_read_diary',
    '翻你自己的日记本（只读）。想看最近几条就传 n；想看某一天的全天就传 day（格式 YYYY-MM-DD）。想起以前写过什么、或者想回顾某天的时候用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      n: z.number().optional().describe('看最近几条，默认 10，最多 100'),
      day: z.string().optional().describe('看某一天，格式 YYYY-MM-DD')
    },
    async ({ key, token, n, day }) => {
      try {
        const q = new URLSearchParams({ key });
        if (day) q.set('day', day);
        else if (n !== undefined) q.set('n', String(n));
        const data = await agentApi(`/api/socialV2/diary?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `翻日记失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

await server.connect(new StdioServerTransport());

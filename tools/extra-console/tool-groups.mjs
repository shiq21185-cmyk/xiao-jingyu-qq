// 「工具开关」的展示元数据 —— 只给专项控制台（3101）用。
//
// 为什么需要这个文件：
//   主控制台 public/console.html 的工具清单是**写死在 HTML 里的一串 <label>**
//   （第 2064-2069 行），不是动态读的。后果有两个：
//     ① 后来新增的工具它看不到 —— 实测已经漏了 qq_say / qq_request_permission /
//        qq_promise / qq_promise_done 四个；
//     ② 一个开关管多个工具时，界面上只列了其中一个，用户以为只关了那一个 ——
//        例如 `speak` 同时管 qq_speak 和 qq_say，在那边取消勾选会把两个都关掉，
//        而 qq_say 根本没显示，用户看不到自己关了什么。
//
// 所以专项控制台**不抄那份写死清单**，改为：
//   · 开关的**现值**从桥接现读（GET /api/socialV2/config 的 tools 段）；
//   · 开关的**说明与分组**放在本文件（它是独立目录里的，插件更新不会碰它）。
//
// ⚠️ 这份表是"展示元数据"，不是权限真相。真相永远是桥接的 toolFlags + 各工具的
//    注册条件；这里写错顶多是说明文字不准，不会让工具开关失效。
//    但**工具名和开关名必须拼对** —— 拼错会让界面显示一个不存在的开关。
//    由 scripts/test-extra-console.mjs 去 qq-tool-restrict / bridge.js / mcp server
//    三处对账，防止漂移。

/**
 * 分组显示。order 决定渲染顺序。
 * 每组里的 items 是 { flag, tools, note }。
 *   flag  —— 写进 config 的开关名（必须与 bridge toolFlags 一致）
 *   tools —— 这个开关管着哪几个工具（**全部列出**，这是本文件存在的意义）
 *   note  —— 一句话说明；缺省时用 defaultNote
 *   danger—— 标红提示（风险操作）
 *   off   —— 默认关闭，界面上要显眼
 */
export const TOOL_GROUPS = [
  {
    id: 'read',
    label: '读消息 / 状态',
    note: '她看东西用的，关掉她就像被蒙住眼',
    items: [
      { flag: 'getPrompt', tools: ['qq_get_prompt'], note: '查角色卡、推荐值、当前唤醒配置' },
      { flag: 'getUnread', tools: ['qq_get_unread_messages'], note: '看未读消息' },
      { flag: 'getRecent', tools: ['qq_get_recent_messages'], note: '看最近消息' },
      { flag: 'socialState', tools: ['qq_social_state'], note: '看自己的唤醒/潜水状态' },
      { flag: 'getMyRecent', tools: ['qq_get_my_recent_messages'], note: '看自己最近发过什么' },
      { flag: 'getMessageDetail', tools: ['qq_get_message_detail'], note: '按 id 看单条详情' },
      { flag: 'getActiveMembers', tools: ['qq_get_active_members'], note: '看最近谁在说话' },
      { flag: 'getImages', tools: ['qq_get_message_images'], note: '看消息里的图片/表情' },
      { flag: 'getForwardMsg', tools: ['qq_get_forward_msg'], note: '看合并转发；这个描述最长（约 1k token）' },
      { flag: 'getAccount', tools: ['qq_get_account_info'], note: '看自己账号与好友列表（只给管理员私聊）' },
    ]
  },
  {
    id: 'send',
    label: '发消息',
    note: '她说话用的。这几个通常都该开着',
    items: [
      { flag: 'sendMessage', tools: ['qq_send_message'], note: '统一发送：一条/多条/引用' },
      { flag: 'reply', tools: ['qq_reply'], note: '引用回复某条消息' },
      { flag: 'sendBurst', tools: ['qq_send_burst'], note: '按数组分多条快速发（群聊）' },
      { flag: 'sendGroup', tools: ['qq_send_group_message'], note: '群聊单条文本' },
      { flag: 'sendPrivate', tools: ['qq_send_private_message'], note: '私聊单条文本' },
      { flag: 'sendPoke', tools: ['qq_send_poke'], note: '拍一拍' },
    ]
  },
  {
    id: 'voice',
    label: '语音（说话）',
    note: 'speak 现在只管 qq_say 一个工具（2026-10-20 合并后）',
    items: [
      {
        flag: 'speak',
        tools: ['qq_say'],
        off: true,
        note: '现合成语音：她给一段文字，本机念出来发成语音条。'
          + '默认"开口说、发不出去才打字"；也能让她指定"只发语音不改文字"。'
          + '（原先 qq_say 与 qq_speak 两个工具已合并成这一个）'
      },
      {
        flag: 'sendVoice',
        tools: ['qq_send_voice', 'qq_list_voices'],
        off: true,
        note: '发语音库（audio/）里现成的音频；不是她说话，是播一段录音。默认关'
      },
      {
        flag: 'call',
        tools: ['qq_call_status', 'qq_call_answer', 'qq_call_hangup', 'qq_call_say'],
        off: true,
        note: '★ 语音通话（档 2）：接/挂主人电脑上那台 QQ 的电话、在电话里说话。'
          + '**只对管理员私聊开放**（守卫 HOST/CALL 分档）。'
          + '需要 VB-CABLE + 通话 sidecar，环境没齐时开着只会反复失败，所以默认关'
      },
      {
        flag: 'localExec',
        tools: ['qq_run_command', 'qq_read_file', 'qq_write_file'],
        danger: true,
        off: true,
        note: '★★ 本机执行：在她那边**真跑命令、真读写文件**（主人 2026-10-25 批准）。'
          + '这是目前最重的一组能力 —— 守卫与桥接都只放管理员私聊，群聊与普通成员私聊一律拒绝。'
          + '关掉它她就只剩聊天能力（工具会从清单里消失）'
      },
    ]
  },
  {
    id: 'memory',
    label: '记忆',
    note: '她记事用的',
    items: [
      {
        flag: 'memory',
        tools: ['qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear'],
        note: '轻量记忆：话题 / 想说的话 / 对群友的印象。**一个开关管四个工具**'
      }
    ]
  },
  {
    id: 'sticker',
    label: '表情与图片',
    note: '聊天里的轻量表达',
    items: [
      { flag: 'listStickers', tools: ['qq_list_stickers'], note: '查看收藏表情' },
      { flag: 'getStickerImage', tools: ['qq_get_sticker_image'], note: '看表情长什么样' },
      { flag: 'sendSticker', tools: ['qq_send_sticker'], note: '发收藏表情' },
      { flag: 'collectSticker', tools: ['qq_collect_sticker'], note: '收藏别人的表情' },
      { flag: 'stickerNote', tools: ['qq_sticker_note'], note: '给表情记含义' },
      {
        flag: 'setStickerRemark',
        tools: ['qq_set_sticker_remark'],
        off: true,
        danger: true,
        note: '改 QQ 官方表情备注。默认关（会动账号上的东西）'
      },
      { flag: 'listPhotos', tools: ['qq_photo_list'], note: '列群图库' },
      { flag: 'getPhotoImage', tools: ['qq_get_photo_image'], note: '看群图' },
      { flag: 'sendPhoto', tools: ['qq_send_photo'], note: '发群图' },
      { flag: 'photoNote', tools: ['qq_photo_note'], note: '给群图记备注' },
    ]
  },
  {
    id: 'qzone',
    label: 'QQ 空间',
    note: '写操作只能是她自己起的回合，任何人命令都不算',
    items: [
      { flag: 'getQzone', tools: ['qq_get_qzone_list'], note: '看自己的说说列表' },
      { flag: 'qzoneFeeds', tools: ['qq_get_qzone_feeds'], note: '看好友动态流' },
      { flag: 'sendQzone', tools: ['qq_send_qzone_msg'], note: '发说说（对外可见）' },
      { flag: 'qzoneLike', tools: ['qq_qzone_like'], note: '点赞（同一个工具，靠参数控制方向）' },
      // ⚠️ qzoneUnlike **不是**多余的键：MCP 里没有叫 qq_qzone_unlike 的工具，
      //    但 bridge.js 的 QZONE op 映射里 unlike → qzoneUnlike（第 6607 行），
      //    也就是**取消赞**这个操作单独的开关。我一度以为它不存在而移除，
      //    结果它会掉进"未归类"。判断一个 flag 真不真实，要看**有没有代码读它**，
      //    不是看有没有同名工具。
      // operation: true = 它不是一个独立工具，而是某个工具的一个操作开关。
      // 界面据此显示"操作开关"，而不是"工具未注册"（后者看着像坏了）。
      { flag: 'qzoneUnlike', tools: [], operation: true, note: '取消赞 —— 它是 qq_qzone_like 的 unlike 参数，不是一个独立工具' },
      { flag: 'qzoneComment', tools: ['qq_qzone_comment'], note: '评论别人的说说（对外可见）' },
      { flag: 'qzoneDelete', tools: ['qq_qzone_delete'], note: '删自己的说说' },
      { flag: 'qzoneSetRight', tools: ['qq_qzone_set_right'], note: '改说说可见范围' },
    ]
  },
  {
    id: 'misc',
    label: '其他',
    note: '游戏、约定、申请、日记',
    items: [
      {
        flag: 'requestPermission',
        tools: ['qq_request_permission'],
        note: '★ 向我申请玩手机 / 刷B站。关掉她就没法来问你（手机与 bili_run 会被守卫拒绝）'
      },
      {
        flag: 'promise',
        tools: ['qq_promise', 'qq_promise_done'],
        note: '★ 约定到点做事（叫起床/提醒）。**一个开关管两个工具**'
      },
      { flag: 'writeDiary', tools: ['qq_write_diary'], note: '写日记' },
      { flag: 'readDiary', tools: ['qq_read_diary'], note: '翻日记' },
      { flag: 'slangQuery', tools: ['qq_slang_query'], note: '查确认过的黑话' },
      { flag: 'slangSubmit', tools: ['qq_slang_submit'], note: '提交陌生词给管理员筛选' },
      { flag: 'feedback', tools: ['qq_report_feedback'], note: '向你反馈她遇到的问题' },
      { flag: 'waitMessages', tools: ['qq_wait_for_messages'], note: '等她说完再回' },
      { flag: 'markRead', tools: ['qq_mark_read'], note: '标记已读' },
      { flag: 'setWakeConfig', tools: ['qq_set_wake_config'], note: '设置下次什么时候醒' },
      {
        flag: 'sendFile',
        tools: ['qq_send_file'],
        danger: true,
        note: '★ 发文件（联网下载 / 读本机文件 → QQ 文件气泡）。'
          + '管理员私聊和群聊都能用（2026-10-30 主人口径：群里开、普通成员私聊不开）；'
          + '群里只认下载目录里的文件。它会在你电脑上真下载真落盘，打开前先想清楚'
      },
      {
        flag: 'drawImage',
        tools: ['qq_draw_image', 'qq_send_image'],
        danger: true,
        note: '★ 生图（画面描述 → 本机「生图工作室」插件 → 图直接发进会话）。'
          + '管理员私聊和群聊都能用（2026-10-29 主人口径：群里也开、别的好友不开）；成本靠日额度管：'
          + '管理员私聊不限，群聊默认 5 张/天（一张约 4 分钱）。'
          + '关掉后这两个工具整个消失'
      },
    ]
  }
];

/** 展平成 { flag: { tools, note, ... } }，方便查。 */
export function flatToolFlags() {
  const out = {};
  for (const g of TOOL_GROUPS) {
    for (const it of g.items) {
      out[it.flag] = { ...it, group: g.id, groupLabel: g.label };
    }
  }
  return out;
}

/**
 * 由真实注册表反推分组：对于开关表里**没写**的 flag，归到"未归类"。
 * 这样以后桥接加了新开关，界面不会静默漏掉它 —— 会以"未归类"出现。
 * @param {string[]} knownFlags 桥接 toolFlags 名单
 */
export function unclassifiedFlags(knownFlags) {
  const flat = flatToolFlags();
  return (Array.isArray(knownFlags) ? knownFlags : []).filter((f) => !flat[f]);
}

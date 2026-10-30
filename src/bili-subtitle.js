// B 站字幕：从 player/v2 的返回里挑出能用的那一条、再把 cue 拼成正文。
//
// 为什么单独一个文件：这段逻辑有两个非直觉的坑，都得拿真实结构做断言才好测 ——
//   ① 挑错视频：player/v2 的 subtitle_url 指向的往往是**这个账号播放器上当前那个视频**
//      的字幕，而不是我们问的那一个（实测问暗黑地牢，拿回来的正文是「我现在在南京…」
//      的 vlog）。回包 echo 的 aid/cid 是照抄请求参数的，认不出这个问题；能认的是
//      URL 路径前缀 <aid><cid>（详见 subtitleBelongsTo 上面的注释）。
//   ② 字幕是"听音频"来的：只有人说话的地方才有字，画面里发生什么一个字都没有；
//      而且 AI 字幕会把同一句话连着重复好几遍，直接拼会显得像复读机。
import { safeFetch } from './safe-fetch.js';
import { closePage, evalValue, listTabs, openPage, proxyConnected } from './cdp-browser.js';

const SUBTITLE_BUDGET_MS = 6000;
const SUBTITLE_MAX_CHARS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 挑语言：人工字幕优先，其次中文 AI 字幕；别的语言先不要（她读中文）。
// ★但先得证明这份字幕是这个视频的★（见 subtitleBelongsTo），证明不了的直接不要。
// 返回统一成 { lan, url }：调用方不用管上游字段是 subtitle_url 还是我们搬过来的 url。
export function pickSubtitle(subs, { aid, cid } = {}) {
  const usable = (Array.isArray(subs) ? subs : [])
    .map((s) => ({ lan: s?.lan, url: String(s?.subtitle_url ?? s?.url ?? '') }))
    .filter((s) => s.url && subtitleBelongsTo(s.url, { aid, cid }));
  const picked = usable.find((s) => s.lan === 'zh-CN' || s.lan === 'zh-Hans' || s.lan === 'zh')
    ?? usable.find((s) => /^ai-zh/i.test(String(s.lan)))
    ?? null;
  return picked ? { lan: picked.lan, url: picked.url } : null;
}

// ★防串台的唯一可靠判据★：AI 字幕的路径是
//   //aisubtitle.hdslb.com/bfs/ai_subtitle/prod/<aid><cid><hash>?auth_key=…
// 前缀就是 aid 拼 cid，一位不差。
//
// 为什么不能靠别的东西：
//   · 回包里 echo 的 aid/cid 是**我们问的那一对**（B站照抄请求参数），所以拿它当判据
//     毫无用处 —— 实测问暗黑地牢（aid=1304048355 cid=1535359663）时，echo 完全正确，
//     但 subtitle_url 指向的是 aid=11338592879 cid=20042650918 那份，正文是
//     「我现在在南京…」的 vlog，跟视频毫无关系。
//   · 真正的成因是这个账号的播放器"当前那个视频"顶了上来：他正开着的 TTS 视频
//     （aid=117381221322935 cid=42449240242）拿到的前缀就是 11738122132293542449240242。
//   · hash 本身不透明、每次都变，认不出来；但**前缀**认得出来。
// 认不出来的一律不要 —— 宁可这次没有字幕，也不能把别人的话当成这个视频的内容讲出去。
export function subtitleBelongsTo(url, { aid, cid } = {}) {
  if (!aid || !cid) return false;
  return String(url ?? '').includes(`${aid}${cid}`);
}

// 回包里 echo 的 aid/cid 要跟我们要的那一对一致。
//
// ⚠️ 这一条**必要但远远不够**：B站是把请求参数照抄回来的，所以哪怕它递过来的是
// 别人的字幕，这一条照样是 true（实测见过）。真正能定归属的是 subtitleBelongsTo。
// 留着它是因为"连 aid/cid 都对不上"时说明这次请求本身就没成，早点退出更干净。
export function ownsVideo(data, { aid, cid } = {}) {
  if (!aid || !cid) return false;
  return String(data?.aid ?? '') === String(aid) && String(data?.cid ?? '') === String(cid);
}

// 把 cue 拼成一段正文：丢掉连续重复的整句，超长截断。
// 截断了一定要留省略号 —— 不然她会把被砍掉半句的字幕当成完整原话转述出去。
export function mergeCues(cues, maxChars = 4000) {
  const list = Array.isArray(cues) ? cues : [];
  const parts = [];
  let size = 0;
  let truncated = false;
  for (let i = 0; i < list.length; i++) {
    const text = String(list[i]?.content ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (parts.length && parts[parts.length - 1] === text) continue;
    parts.push(text);
    size += text.length + 1;
    if (size >= maxChars) {
      truncated = i < list.length - 1;
      break;
    }
  }
  let joined = parts.join(' ');
  if (joined.length > maxChars) {
    joined = joined.slice(0, maxChars);
    truncated = true;
  }
  return truncated ? `${joined}…` : joined;
}

// 字幕文件本身不需要 cookie：URL 上带了 auth_key 签名，普通 HTTPS 就能取。
export async function readSubtitleText(url, maxChars = 4000) {
  const raw = String(url ?? '');
  const abs = raw.startsWith('//') ? `https:${raw}` : raw;
  if (!abs) return '';
  const res = await safeFetch(abs, 400000);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`字幕文件 HTTP ${res.statusCode}`);
  const json = JSON.parse(res.body);
  return mergeCues(json?.body, maxChars);
}

// ---------------------------------------------------------------------------
// ★完全机会主义，绝不强求★（用户要求："如果没开浏览器不要卡住"）
// 字幕清单要靠登录态才给（player/v2 匿名只回 subtitles: []），所以这一步得借主人
// Edge 里的 cookie。因此：连不上浏览器就立刻返回 null —— 不等待、不拉起浏览器、
// 不报错，跟没有这个功能时一模一样。整段另有 SUBTITLE_BUDGET_MS 的上限，
// 而且调用方把它和弹幕/评论**并行**跑，所以正常情况下不多花时间。
// 任何异常都吞掉：这是附加能力，坏了也不能影响 bili_video 的主结果。
// ---------------------------------------------------------------------------
export async function biliSubtitleViaBrowser({ bvid, aid, cid }) {
  if (!aid || !cid) return null;
  if (!(await proxyConnected().catch(() => false))) return null;

  const deadline = Date.now() + SUBTITLE_BUDGET_MS;
  let targetId = null;
  let openedByUs = false;
  try {
    // 他正好开着 B站 的页面就直接借用（同源、带 cookie），省一次开关标签页。
    // ★优先借"就是这一个视频"的那一页★：实测 player/v2 给的字幕跟着这个账号播放器上
    // "当前那个视频"走 —— 借对了页才拿得到对的字幕，借错了只会拿到别人的（然后被
    // pickSubtitle 的 URL 前缀判据挡掉，等于白跑一趟）。
    const tabs = await listTabs().catch(() => []);
    const biliTabs = (Array.isArray(tabs) ? tabs : [])
      .filter((t) => /bilibili\.com/i.test(String(t?.url ?? '')));
    const hit = biliTabs.find((t) => bvid && String(t?.url ?? '').includes(bvid)) ?? biliTabs[0];
    if (hit?.targetId) {
      targetId = hit.targetId;
    } else {
      const page = await openPage('https://www.bilibili.com/');
      targetId = page?.targetId ?? null;
      openedByUs = true;
    }
    if (!targetId) return null;

    // 在页面里发请求才带 cookie；发完把结果挂到 window 上，再分几次取回来。
    // 刚 /new 出来的页面可能还没建好执行上下文，所以允许重试两次。
    const query = `bvid=${encodeURIComponent(bvid ?? '')}&aid=${encodeURIComponent(aid)}&cid=${encodeURIComponent(cid)}`;
    const kick = `(function(){window.__bsub='PENDING';`
      + `fetch('https://api.bilibili.com/x/player/v2?${query}',{credentials:'include'})`
      + '.then(function(r){return r.json()})'
      + '.then(function(j){var D=(j&&j.data)||{};var s=(D.subtitle&&D.subtitle.subtitles)||[];'
      + 'window.__bsub=JSON.stringify({code:(j&&j.code),aid:D.aid,cid:D.cid,'
      + 'subs:s.map(function(x){return {lan:x.lan,url:x.subtitle_url};})});})'
      + `.catch(function(e){window.__bsub=JSON.stringify({err:String(e)})});return 'go';})()`;

    let kicked = false;
    for (let attempt = 0; attempt < 3 && !kicked; attempt++) {
      try {
        await evalValue(targetId, kick, 8000);
        kicked = true;
      } catch {
        await sleep(400);
      }
    }
    if (!kicked) return null;

    let payload = null;
    while (Date.now() < deadline) {
      await sleep(250);
      const raw = await evalValue(targetId, 'String(window.__bsub||"")', 3000).catch(() => '');
      if (!raw || raw === 'PENDING') continue;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
      break;
    }
    if (!payload || payload.err) return null;
    // ⚠️ 这一条只是"请求本身成没成"的粗筛，B站会把 aid/cid 照抄回来，证明不了归属。
    if (!ownsVideo(payload, { aid, cid })) return null;

    // ★真正的防线在 pickSubtitle 里★：只认 URL 路径前缀带 <aid><cid> 的那一条。
    // 认不出来就当这次没有字幕 —— 绝不拿别人的话冒充这个视频的内容。
    const picked = pickSubtitle(payload.subs, { aid, cid });
    if (!picked) return null;
    const text = await readSubtitleText(picked.url, SUBTITLE_MAX_CHARS);
    return text ? { text, lan: picked.lan } : null;
  } catch {
    return null;
  } finally {
    // 我们自己开的页一定要关掉 —— 别在主人浏览器里留垃圾。
    if (openedByUs && targetId) await closePage(targetId).catch(() => {});
  }
}

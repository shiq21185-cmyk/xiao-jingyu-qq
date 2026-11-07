// 身体 MCP server（stdio）—— 让小鲸鱼真的"用"上那副身体：拍照、说话、看状态。
//
// 2026-10-31：主人通过语音问她「能不能看见我」，她答「视频还没有接入」——
// 因为直到这一刻，她的工具面里**根本没有眼睛**。板子早就通了（e5 固件：耳朵+嘴+屏幕+
// OV2640 摄像头），缺的是把"板子会拍"这件事变成她能调的**工具**。
//
// 三个工具，全部是**调用 rot 工作区里已经验过的脚本**，不在这儿重写协议：
//   · body_photo  → rot/tools/body_camera.py --json      拍一张存本机，返回路径
//   · body_say    → rot/tools/body_say.py <文本>          用板子喇叭说话
//   · body_status → rot/tools/body_probe.py              板子在不在线、电量式计数
//
// 边界（和别的手 MCP 一致）：
//   · 只跑上面这三个固定脚本，参数只有"文本 / 张数"，**没有**任意路径、命令、网络。
//   · 照片只落在本机 `.tmp/cam/` 下；要给对方看，得她自己再调 qq_send_file 发出去。
//   · 板子/前缀/broker 一律从 state/body-config.json 读（和桥接、控制台同一份），
//     这里不写死任何一台板子。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadJson(file, fallback = {}) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch { return fallback; }
}

/** 身体工作区（rot）——和 launch-all.ps1 同一约定：优先 paths.json 的 bodyDir。 */
function bodyDir() {
  const p = loadJson(path.join(ROOT, 'launcher', 'paths.json')).bodyDir;
  if (p && fs.existsSync(path.join(p, 'tools', 'body_probe.py'))) return p;
  for (const cand of [
    path.join(path.dirname(ROOT), 'rot'),
    path.join(ROOT, '..', 'rot'),
  ]) {
    if (fs.existsSync(path.join(cand, 'tools', 'body_probe.py'))) return path.resolve(cand);
  }
  throw new Error('找不到身体工作区 rot（里面有 tools/body_probe.py）。'
    + '在 launcher/paths.json 里写 "bodyDir": "D:\\\\...\\\\rot" 即可。');
}

/**
 * 解释器：她 ASR 那个 venv。
 *
 * 为什么必须是它：三个脚本都要 paho-mqtt（相机/说话还要 edge-tts），
 * 系统 python 没装。launch-all.ps1 也是拿这个解释器做探活，别另起一套。
 */
function pythonExe() {
  const venv = path.join(ROOT, 'tools', 'asr', '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venv)) return venv;
  throw new Error(`找不到语音 venv：${venv}（先跑 launcher\\install.ps1，或用控制台装一次语音引擎）`);
}

/** 跑一个脚本，stdout/stderr 一起收回来（中文按 utf-8 解，解不干净再退 gbk）。 */
function run(args, { timeout = 120000, cwd = ROOT } = {}) {
  const r = spawnSync(pythonExe(), args, {
    cwd,
    timeout,
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  const decode = (buf) => {
    if (!buf) return '';
    try { return buf.toString('utf8'); } catch { /* 落到下面 */ }
    try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('latin1'); }
  };
  return {
    code: r.status,
    timedOut: r.error?.code === 'ETIMEDOUT',
    out: decode(r.stdout).trim(),
    err: decode(r.stderr).trim(),
  };
}

function jpegSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

const server = new McpServer({ name: 'body', version: '0.1.0' });

server.tool(
  'body_photo',
  '让身体拍一张照片，**画面会直接回到你眼前**（640x480 JPEG），同时给你一个本机绝对路径。'
    + '她想知道"你长什么样 / 屋里现在什么样 / 能不能看见我"时用这个。'
    + '看到之后要发给他，再调 qq_send_file（路径原样传进去）。'
    + '⚠️ 2026-10-31 修：早先只返回路径，她回"我这边真的只有路径，没有画面，描述不出来"——'
    + '工具的返回值必须带 image 内容块，模型才真的看得见。',
  {
    count: z.number().int().min(1).max(5).optional().describe('拍几张，默认 1'),
  },
  async ({ count }) => {
    try {
      const dir = bodyDir();
      const n = Math.max(1, Math.min(5, Number(count) || 1));
      const r = run([
        path.join(dir, 'tools', 'body_camera.py'),
        '--json', '-n', String(n), '--timeout', String(12 * n + 10),
      ], { timeout: 30 * n + 30000 });
      const line = r.out.split(/\r?\n/).filter(Boolean).pop() || '';
      let info = null;
      try { info = JSON.parse(line); } catch { /* 下面按失败处理 */ }
      if (!info || !info.ok || !info.files?.length) {
        const why = r.timedOut ? '等太久超时了' : (r.err || r.out || '没拿到图');
        return {
          content: [{
            type: 'text',
            text: `没拍到：${String(why).slice(0, 300)}\n`
              + '（板子可能没开机、没连上 Wi-Fi，或者不在控制台配置的那个主题前缀上）',
          }],
          isError: true,
        };
      }
      const lines = info.files.map((f) => `- ${f}（${jpegSize(f)} 字节）`);
      // ⭐ 关键：把 JPEG 作为 image 内容块还回去。只给路径的话，模型手里只有一串字符，
      //    她只能回"我这边真的只有路径，没有画面"（2026-10-31 实测就是这句）。
      const content = [];
      for (const f of info.files) {
        try {
          const data = fs.readFileSync(f);
          content.push({ type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' });
        } catch { /* 读不到这张就先跳过，下面的路径还在 */ }
      }
      content.push({
        type: 'text',
        text: `拍好了，${info.files.length} 张，上面就是画面本身（640x480；镜头定焦约 40cm，太近会虚）。\n`
          + lines.join('\n') + '\n'
          + '要发给他，用 qq_send_file 把这些路径原样传进去。',
      });
      return { content };
    } catch (error) {
      return { content: [{ type: 'text', text: `没拍到：${String(error?.message ?? error).slice(0, 300)}` }], isError: true };
    }
  }
);

server.tool(
  'body_say',
  '用身体旁边的喇叭说一句话（屋里的人听得见，不会进 QQ 聊天窗）。'
    + '适合"用身体说给我听/让屋里也听见"这种场合；日常聊天文字/语音条别用它。',
  {
    text: z.string().min(1).max(300).describe('要说的话（口语、短句，不要 Markdown）'),
  },
  async ({ text }) => {
    try {
      const dir = bodyDir();
      const r = run([path.join(dir, 'tools', 'body_say.py'), text], { timeout: 180000 });
      if (r.code !== 0) {
        const tail = (r.err || r.out).split(/\r?\n/).slice(-3).join('\n');
        return { content: [{ type: 'text', text: `没说成（退出码 ${r.code}）：\n${tail.slice(0, 400)}` }], isError: true };
      }
      return { content: [{ type: 'text', text: `说了：「${text}」` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `没说成：${String(error?.message ?? error).slice(0, 300)}` }], isError: true };
    }
  }
);

server.tool(
  'body_status',
  '看身体在不在线：板子是否回心跳、Wi-Fi 信号、IP、麦克风/喇叭计数。'
    + '她不确定"板子开没开"时先看这个，不要瞎猜。',
  {},
  async () => {
    try {
      const dir = bodyDir();
      const r = run([path.join(dir, 'tools', 'body_probe.py'), '--timeout', '8'], { timeout: 30000 });
      const line = r.out.split(/\r?\n/).filter(Boolean).pop() || '';
      let j = null;
      try { j = JSON.parse(line); } catch { /* ignore */ }
      if (!j) {
        return { content: [{ type: 'text', text: `探活没结果：${(r.err || r.out || '空').slice(0, 300)}` }], isError: true };
      }
      if (j.online === false) {
        return { content: [{ type: 'text', text: `板子没回心跳（${j.why || '原因未知'}）—— 大概没开机或没连上网。` }] };
      }
      return {
        content: [{
          type: 'text',
          text: `板子在线：IP ${j.ip}，信号 ${j.rssi} dBm，剩余内存 ${(j.heap / 1048576).toFixed(1)} MB，`
            + `开机 ${Math.floor((j.up || 0) / 60)} 分钟；麦克风轮次 ${j.mloop ?? '-'}、`
            + `喇叭已收 ${j.dpkts ?? 0} 包（缺料 ${j.ddrop ?? 0}）。`,
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `探活失败：${String(error?.message ?? error).slice(0, 300)}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());

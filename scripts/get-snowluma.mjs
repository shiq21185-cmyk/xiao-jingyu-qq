#!/usr/bin/env node
// get-snowluma.mjs — 把 SnowLuma 官方发行包下载/解压到指定目录（换电脑时用）。
//
// 为什么不在仓库里放二进制：SnowLuma 的 EULA §5.4 明确写了「不得把专有组件并入第三方
// 安装包、也不得通过自动化脚本部署」，所以这个仓库**不携带** SnowLuma 的任何字节：
// 由你自己从官方发布渠道取到 zip，再用本脚本解压 + 校验。
//
// 用法（两种都行）：
//   node scripts/get-snowluma.mjs --zip "<你下载的 SnowLuma-1.14.22.zip>"
//   node scripts/get-snowluma.mjs --url "https://…官方给的下载直链…"
//
// 参数：
//   --zip <path>    你手动下载好的官方 zip
//   --url <url>     直链（脚本用 node 原生 fetch 拉下来；需要该链接允许直接下载）
//   --dest <dir>    解压到哪，默认「仓库的兄弟目录 SnowLuma」（即 <仓库上级目录>\SnowLuma）
//   --force         目标目录已存在且非空时也覆盖（默认拒绝，避免盖掉你正在用的那份）
//   --dry           只打印计划，不落盘
//
// 退出码：0 成功 / 1 参数或下载失败 / 2 目标已存在（未加 --force）

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { zip: '', url: '', dest: '', force: false, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--zip') out.zip = argv[++i] || '';
    else if (a === '--url') out.url = argv[++i] || '';
    else if (a === '--dest') out.dest = argv[++i] || '';
    else if (a === '--force') out.force = true;
    else if (a === '--dry') out.dry = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else {
      console.error(`未知参数：${a}`);
      out.help = true;
    }
  }
  return out;
}

function usage() {
  console.log(`用法：
  node scripts/get-snowluma.mjs --zip <官方zip路径> [--dest <目录>] [--force]
  node scripts/get-snowluma.mjs --url <下载直链>     [--dest <目录>] [--force]

说明：本仓库不携带 SnowLuma 二进制（EULA §5.4 禁止再分发）。请自行从官方渠道取得 zip。`);
}

function isNonEmptyDir(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

async function download(url, outFile) {
  console.log(`下载：${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length') || 0);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outFile, buf);
  const mb = (buf.length / 1048576).toFixed(1);
  console.log(`已保存：${outFile}（${mb} MB${total ? ` / 预期 ${(total / 1048576).toFixed(1)} MB` : ''}）`);
  if (total && buf.length !== total) throw new Error('下载不完整（长度不一致）');
  return outFile;
}

function unzip(zipFile, destDir) {
  // 不引第三方依赖：Windows 自带 tar.exe（libarchive）能直接解 zip。
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync('tar', ['-xf', zipFile, '-C', destDir], { stdio: 'inherit' });
  if (r.error) throw new Error(`调用 tar 失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`解压失败（tar 退出码 ${r.status}）`);
}

// 发行包有时外面套一层同名目录；若 dest 里只有一个目录且其中有 index.mjs，就把内容提上来。
function flattenIfWrapped(destDir) {
  const entries = fs.readdirSync(destDir);
  if (entries.length !== 1) return;
  const only = path.join(destDir, entries[0]);
  if (!fs.statSync(only).isDirectory()) return;
  if (!fs.existsSync(path.join(only, 'index.mjs'))) return;
  for (const name of fs.readdirSync(only)) {
    fs.renameSync(path.join(only, name), path.join(destDir, name));
  }
  fs.rmdirSync(only);
  console.log(`已把内层目录 ${entries[0]}/ 的内容提到 ${destDir}`);
}

function verify(destDir) {
  const need = ['index.mjs', 'package.json', 'EULA.md'];
  const missing = need.filter((n) => !fs.existsSync(path.join(destDir, n)));
  if (missing.length) {
    console.error(`[X] 解压后缺少关键文件：${missing.join(', ')}`);
    console.error('    这说明这个 zip 不是 SnowLuma 官方发行包，或者解压到了错误的位置。');
    return false;
  }
  let version = '(未知)';
  try {
    version = JSON.parse(fs.readFileSync(path.join(destDir, 'package.json'), 'utf8')).version || version;
  } catch { }
  const hasNode = fs.existsSync(path.join(destDir, 'node.exe'));
  console.log(`[OK] SnowLuma v${version} → ${destDir}`);
  console.log(`     自带 node.exe：${hasNode ? '有（可以直接用）' : '没有（请确保系统 Node ≥ 22.13）'}`);
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage() || 0;

  if (!args.zip && !args.url) {
    console.error('[X] 需要 --zip 或 --url 之一。');
    usage();
    return 1;
  }

  const dest = args.dest
    ? path.resolve(args.dest)
    : path.join(path.dirname(REPO_ROOT), 'SnowLuma');

  console.log(`仓库根：${REPO_ROOT}`);
  console.log(`目标目录：${dest}`);

  if (isNonEmptyDir(dest) && !args.force) {
    console.error(`[X] 目标目录已存在且非空：${dest}`);
    console.error('    确认要覆盖请加 --force；或换一个 --dest。');
    return 2;
  }

  let zipFile = args.zip ? path.resolve(args.zip) : '';
  let tempZip = '';

  if (zipFile) {
    if (!fs.existsSync(zipFile)) {
      console.error(`[X] 找不到 zip：${zipFile}`);
      return 1;
    }
  } else {
    tempZip = path.join(os.tmpdir(), `snowluma-${Date.now()}.zip`);
    zipFile = tempZip;
  }

  if (args.dry) {
    console.log(`[dry] 将解压 ${zipFile} → ${dest}`);
    return 0;
  }

  try {
    if (!args.zip) await download(args.url, tempZip);
    unzip(zipFile, dest);
    flattenIfWrapped(dest);
  } catch (e) {
    console.error(`[X] ${e.message}`);
    return 1;
  } finally {
    if (tempZip && fs.existsSync(tempZip)) {
      try { fs.unlinkSync(tempZip); } catch { }
    }
  }

  return verify(dest) ? 0 : 1;
}

process.exitCode = await main();

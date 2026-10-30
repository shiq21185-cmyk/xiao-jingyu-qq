# -*- coding: utf-8 -*-
"""阶段 1：通话盲测。只观察、不点击、不接听。

用途：确认「QQ 来电时，窗口/画面能不能被程序认出来」，这是档 2（保留 SnowLuma，
自己控制有头 QQ 接电话）唯一的生死点。认不出来就不用往下做了。

它每 POLL_S 秒做一次：
  1. 枚举 QQ 进程所有顶层窗口，发现新窗口就记一笔（标题/类名/尺寸）
  2. 抓每个窗口的画面，OCR 出文字
  3. 命中去电关键词（接听/挂断/通话中…）就高亮，并把那一帧存成 PNG
  4. 全程只读文件系统 + 屏幕，绝不 PostMessage / 不点击 / 不按键

夜间安全：默认跑 300 秒就自己退出；任何时候 Ctrl+C 都能停。

用法：
    tools/asr/.venv/Scripts/python.exe tools/call/call_probe.py
    ... --seconds 600 --pid 13888 --out tools/call/recordings
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import win_capture as wc  # noqa: E402

POLL_S = 0.8
# 抓到「新窗口」或「命中关键词」时才落盘，避免几百张废图
SAVE_ON_HIT = True


def _ts() -> str:
    return datetime.now().strftime("%H:%M:%S.%f")[:-3]


def _find_qq_pid() -> int | None:
    """找不到 pid 时自己找：QQ.exe 里有可见主窗口的那个。"""
    import ctypes
    import ctypes.wintypes as wt

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    arr = (wt.DWORD * 4096)()
    need = wt.DWORD()
    if not psapi.EnumProcesses(arr, ctypes.sizeof(arr), ctypes.byref(need)):
        return None
    n = need.value // ctypes.sizeof(wt.DWORD)
    cands = []
    for i in range(n):
        pid = arr[i]
        h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            continue
        try:
            buf = ctypes.create_unicode_buffer(1024)
            sz = wt.DWORD(1024)
            if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(sz)):
                if buf.value.lower().endswith("\\qq.exe"):
                    cands.append(pid)
        finally:
            k32.CloseHandle(h)
    for pid in cands:
        if wc.list_windows(pid):
            return pid
    return cands[0] if cands else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", type=int, default=0)
    ap.add_argument("--seconds", type=float, default=300.0)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "recordings"))
    ap.add_argument("--poll", type=float, default=POLL_S)
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    log_path = out_dir / f"probe-{datetime.now():%Y%m%d-%H%M%S}.jsonl"

    pid = args.pid or _find_qq_pid()
    if not pid:
        print("找不到 QQ 进程（QQ.exe 没在跑？）", file=sys.stderr)
        return 2

    print(f"盲测开始 pid={pid} 时长={args.seconds}s 日志={log_path}", flush=True)
    print("★ 现在请用小号给这个 QQ 打一个【语音通话】，然后等它响、再挂掉。", flush=True)
    print("★ 本程序不会接听，只截图认字。", flush=True)

    seen: dict[int, tuple] = {}
    hit_frames = 0
    call_window_seen = False
    t_end = time.time() + args.seconds
    polls = 0

    with log_path.open("a", encoding="utf-8") as fh:
        while time.time() < t_end:
            polls += 1
            try:
                wins = wc.list_windows(pid)
            except Exception as exc:  # noqa: BLE001
                fh.write(json.dumps({"t": _ts(), "err": str(exc)}, ensure_ascii=False) + "\n")
                time.sleep(args.poll)
                continue

            cur = {w.hwnd: (w.title, w.w, w.h, w.x, w.y, w.minimized) for w in wins}
            for hwnd, sig in cur.items():
                if hwnd not in seen:
                    print(f"[{_ts()}] ★新窗口 {hwnd} {sig[0]!r} {sig[1]}x{sig[2]}", flush=True)
                    fh.write(json.dumps({"t": _ts(), "event": "new_window", "hwnd": hwnd,
                                         "sig": sig}, ensure_ascii=False) + "\n")
                    seen[hwnd] = sig
                elif seen[hwnd] != sig and _meaningful_change(seen[hwnd], sig):
                    print(f"[{_ts()}] 窗口变化 {hwnd} {seen[hwnd]} -> {sig}", flush=True)
                    fh.write(json.dumps({"t": _ts(), "event": "window_change", "hwnd": hwnd,
                                         "from": seen[hwnd], "to": sig}, ensure_ascii=False) + "\n")
                    seen[hwnd] = sig

            for w in wins:
                img = wc.grab(w.hwnd)
                if img is None:
                    continue
                try:
                    lines = wc.ocr_lines(img)
                except Exception:  # noqa: BLE001
                    continue
                hits = wc.looks_like_call(lines)
                rec = {
                    "t": _ts(), "hwnd": w.hwnd, "title": w.title,
                    "lines": [ln["text"] for ln in lines],
                    "hits": hits,
                }
                if hits:
                    call_window_seen = True
                    print(f"[{_ts()}] ★★ 疑似通话 UI: {hits} (窗口 {w.title!r})", flush=True)
                    fh.write(json.dumps({**rec, "event": "call_hit"}, ensure_ascii=False) + "\n")
                    fh.flush()
                    if SAVE_ON_HIT and hit_frames < 40:
                        hit_frames += 1
                        p = out_dir / f"hit-{datetime.now():%H%M%S%f}-{w.hwnd}.png"
                        img.save(p)
                        print(f"      已存帧 {p.name}", flush=True)
                else:
                    fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

            time.sleep(args.poll)

    print(f"\n盲测结束：轮询 {polls} 次，落帧 {hit_frames} 张。", flush=True)
    print(f"通话 UI 命中：{'是' if call_window_seen else '否'}", flush=True)
    print(f"日志：{log_path}", flush=True)
    return 0 if call_window_seen else 1


def _meaningful_change(a: tuple, b: tuple) -> bool:
    """标题/尺寸/最小化变了才算；只是位置抖一下不算。"""
    return a[0] != b[0] or a[1:3] != b[1:3] or a[5] != b[5]


if __name__ == "__main__":
    raise SystemExit(main())

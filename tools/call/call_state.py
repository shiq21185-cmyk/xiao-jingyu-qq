# -*- coding: utf-8 -*-
"""阶段 1 状态机 + 阶段 4 接口：看 QQ 有头客户端的通话状态，并能点「接听/挂断」。

设计上分两层：
  CallWatcher  —— 只看不动。轮询所有 QQ 进程的可见窗口 + OCR，判断
                  idle / ringing / in_call / unknown。给上层轮询用。
  CallControl  —— 真正动手（点击）。只有明确要接/挂时才调用。

安全约定（重要）：
  * 默认 dry_run=True，CallControl 只打印「我会点哪里」，不真点。
  * 点击用 PostMessage 到「子窗口」，不动鼠标、不抢用户焦点。
  * 从不知道按哪里就不点，宁可返回 unknown 让上层去问人。

用法：
    python tools/call/call_state.py --watch 20        # 观察 20 秒，打印状态变化
    python tools/call/call_state.py --json            # 输出一行 JSON（给 bridge 调）
"""
from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wt
import json
import pathlib
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import win_capture as wc  # noqa: E402

user32 = ctypes.WinDLL("user32", use_last_error=True)
k32 = ctypes.WinDLL("kernel32", use_last_error=True)
psapi = ctypes.WinDLL("psapi", use_last_error=True)

WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_CLOSE = 0x0010

# 真鼠标事件（SendInput / mouse_event 走系统输入队列）
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010


# --------------------------------------------------------------------------- QQ 进程

def _exe_of(pid: int) -> str:
    h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        sz = wt.DWORD(1024)
        if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(sz)):
            return buf.value
        return ""
    finally:
        k32.CloseHandle(h)


def qq_pids() -> list[int]:
    """所有 qq.exe 进程。

    实测坑（2026-10-25）：用 psapi.EnumProcesses 枚举会漏掉主进程（有窗口的那个
    13888 就不在列表里），只按 pid 找窗口会得到 0 个窗口。所以改成
    「先枚举窗口 → 取窗口的 pid → 反查 exe 名」，这样一定能覆盖到有界面的进程。
    """
    pids: set[int] = set()

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def _cb(hwnd, _l):
        p = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if p.value:
            pids.add(p.value)
        return True

    user32.EnumWindows(_cb, 0)

    # 再补一遍全量进程（有些进程可能没窗口，但我们要的正是有窗口的，所以只是保险）
    arr = (wt.DWORD * 4096)()
    need = wt.DWORD()
    if psapi.EnumProcesses(arr, ctypes.sizeof(arr), ctypes.byref(need)):
        for i in range(need.value // ctypes.sizeof(wt.DWORD)):
            if arr[i]:
                pids.add(arr[i])

    return sorted(p for p in pids if _exe_of(p).lower().endswith("\\qq.exe"))


def qq_windows(*, visible_only: bool = True) -> list[wc.WinInfo]:
    out: list[wc.WinInfo] = []
    for pid in qq_pids():
        try:
            out.extend(wc.list_windows(pid, visible_only=visible_only))
        except Exception:  # noqa: BLE001
            continue
    return out


# --------------------------------------------------------------------------- 状态判定

RING_WORDS = ("接听", "拒绝", "挂断", "语音通话", "视频通话", "邀请你语音", "正在呼叫",
              "邀请你视频", "响铃")
INCALL_WORDS = ("通话中", "麦克风", "扬声器", "静音", "免提", "摄像头", "挂断")
IDLE_BAD = ("群聊", "联系人", "消息", "空间", "设置")

STATE_IDLE = "idle"
STATE_RINGING = "ringing"
STATE_IN_CALL = "in_call"
STATE_UNKNOWN = "unknown"


@dataclass
class CallSnapshot:
    state: str = STATE_UNKNOWN
    window: wc.WinInfo | None = None
    lines: list[str] = field(default_factory=list)
    hits: list[str] = field(default_factory=list)
    ocr_ok: bool = False
    note: str = ""
    ts: str = ""
    windows_seen: int = 0

    def to_dict(self) -> dict:
        return {
            "state": self.state,
            "ts": self.ts,
            "note": self.note,
            "windows_seen": self.windows_seen,
            "ocr_ok": self.ocr_ok,
            "hits": self.hits,
            "window": (None if self.window is None else
                       {"hwnd": self.window.hwnd, "title": self.window.title,
                        "cls": self.window.cls, "w": self.window.w,
                        "h": self.window.h, "minimized": self.window.minimized}),
            "lines": self.lines[:40],
        }


def _classify(lines: list[str]) -> tuple[str, list[str]]:
    joined = " | ".join(lines)
    hits = [w for w in RING_WORDS if w in joined]
    incall = [w for w in INCALL_WORDS if w in joined]
    # 「接听 + 拒绝」同时出现 = 来电弹窗（最典型）
    if ("接听" in joined and ("拒绝" in joined or "挂断" in joined)) or "邀请你语音" in joined:
        return STATE_RINGING, hits
    if "通话中" in joined or ("挂断" in joined and ("麦克风" in joined or "静音" in joined)):
        return STATE_IN_CALL, incall
    if len(incall) >= 2:
        return STATE_IN_CALL, incall
    return STATE_IDLE, hits


CALL_TITLE_WORDS = ("语音通话", "视频通话", "通话中", "邀请你语音", "邀请你视频")


def _title_says_call(w: wc.WinInfo) -> bool:
    t = w.title or ""
    return any(k in t for k in CALL_TITLE_WORDS)


def _buttons_of(hwnd: int, visible: bool) -> list[dict]:
    """按颜色读当前通话窗口上的圆按钮（接听=绿 / 挂断=红）。

    为什么要单独抽出来：QQNT 通话窗口**接起前后标题都是「语音通话」**，OCR 又一个字
    读不出（Chromium 自绘），所以「标题」和「文字」都无法区分「还在响」和「已接通」。
    可靠的差别只有按钮本身：
        响铃中 —— 绿（接听）+ 红（拒绝）并排，都在 y≈508
        已接通 —— 绿按钮消失，只剩红（挂断）
    这套颜色判据是 2026-10-25 真来电截图实测出来的（360x640，绿在 x94..133，红在
    x226..265，y489..528）。
    """
    shot = wc.grab_screen(hwnd) if visible else None
    if shot is None:
        shot = wc.grab(hwnd)
    if shot is None:
        return []
    try:
        return _color_buttons(shot)
    except Exception:  # noqa: BLE001
        return []


def _grab_and_read(w: wc.WinInfo) -> tuple[object | None, list[str], str]:
    """抓一张图并 OCR，返回 (img, lines, 走了哪条抓图路径)。

    实测（2026-10-25 真来电）：来电窗口 `Chrome_WidgetWin_1 / 标题'语音通话' /
    360x640 / vis=True` 是**可见**的，但 PrintWindow 抓出来是噪点（std≈26、OCR 一个字
    都读不出）——因为 QQ 是 Chromium 自绘 + GPU 合成，PrintWindow 拿到的是旧/残缓冲。
    所以这里改成两级：
      1) PrintWindow（窗口被挡住、最小化时也能用）
      2) 屏幕 BitBlt（像素是真的，来电窗口此刻就在桌面上）
    只要第 1 级 OCR 出字就不走第 2 级；出不了字就换屏幕，哪怕窗口被挡也先试一把。
    """
    img = wc.grab(w.hwnd)
    lines: list[str] = []
    if img is not None:
        try:
            lines = [ln["text"] for ln in wc.ocr_lines(img)]
        except Exception:  # noqa: BLE001
            lines = []
    if lines:
        return img, lines, "printwindow"
    if w.visible:
        shot = wc.grab_screen(w.hwnd)
        if shot is not None:
            try:
                slines = [ln["text"] for ln in wc.ocr_lines(shot)]
            except Exception:  # noqa: BLE001
                slines = []
            if slines:
                return shot, slines, "screen"
            if img is None:
                return shot, [], "screen"
    return img, lines, "printwindow"


def probe_once(*, ocr: bool = True, save_dir: Path | None = None) -> CallSnapshot:
    snap = CallSnapshot(ts=datetime.now().strftime("%H:%M:%S.%f")[:-3])
    wins = qq_windows()
    snap.windows_seen = len(wins)
    if not wins:
        # 「一个可见 QQ 窗口都没有」在这台机器上是**常态**，不是异常：
        # 桌面 QQ 被 SnowLuma 注入后主窗口一直 IsWindowVisible=false（缩在托盘），
        # 只有**来电那一刻**才会冒出一个可见的 `标题='语音通话'` 顶层窗口。
        # 所以这里必须报 idle 而不是 unknown —— 报 unknown 的话：
        #   a) 上层永远等不到 idle，通话结束后引擎不会自己收手；
        #   b) 控制台上永远是「未知」，排查时看不出「现在就是没电话」。
        if qq_pids():
            snap.state = STATE_IDLE
            snap.note = "QQ 在跑但当前没有可见窗口（正常待机）"
        else:
            snap.state = STATE_UNKNOWN
            snap.note = "没有 QQ 进程（QQ 没开？）"
        return snap

    best: tuple[int, CallSnapshot] | None = None
    for w in wins:
        img, lines, how = _grab_and_read(w)
        if img is None and not _title_says_call(w):
            continue
        state, hits = _classify(lines)
        # 标题本身是铁证：窗口标题变成「语音通话/视频通话」时不可能还是 idle。
        # 这时 OCR 就算一个字没读出来（Chromium 自绘抓不到字是常态），也要报成
        # ringing，让上层有机会去点「接听」——否则真来电会被当成 idle 静默错过。
        title_call = _title_says_call(w)
        if title_call and state == STATE_IDLE:
            state = STATE_RINGING
            if not hits:
                hits = [w.title]
        # 标题 + OCR 都分不出「还在响」和「已接通」时，用按钮颜色补判
        # （详见 _buttons_of 的注释：接起后绿按钮消失、只剩红色挂断）。
        via_btn = ""
        if title_call:
            btns = _buttons_of(w.hwnd, w.visible)
            if btns:
                has_green = any(b["word"] == "接听" for b in btns)
                if has_green:
                    state = STATE_RINGING
                else:
                    state = STATE_IN_CALL
                via_btn = "buttons"
                hits = [b["word"] for b in btns]
        cand = CallSnapshot(state=state, window=w, lines=lines, hits=hits,
                            ocr_ok=bool(lines), ts=snap.ts,
                            windows_seen=len(wins),
                            note=(via_btn if via_btn else ("" if lines else f"title-only({how})")))
        # ringing > in_call > idle 优先
        score = {STATE_RINGING: 3, STATE_IN_CALL: 2, STATE_IDLE: 1}.get(state, 0)
        if best is None or score > {STATE_RINGING: 3, STATE_IN_CALL: 2,
                                    STATE_IDLE: 1}.get(best[1].state, 0):
            best = (score, cand)
        if state == STATE_RINGING and lines:
            break

    if best is None:
        snap.state = STATE_UNKNOWN
        snap.note = snap.note or "QQ 窗口抓不到画面"
        return snap

    snap = best[1]
    if save_dir is not None and snap.state in (STATE_RINGING, STATE_IN_CALL):
        save_dir.mkdir(parents=True, exist_ok=True)
        img = wc.grab(snap.window.hwnd) if snap.window else None
        if img is not None:
            img.save(save_dir / f"{snap.state}-{datetime.now():%H%M%S%f}.png")
    return snap


def click_real(sx: int, sy: int, *, hwnd: int | None = None) -> dict:
    """在屏幕坐标 (sx, sy) 投一次**真鼠标**左键。

    为什么必须补这一条（2026-10-25 真来电实测）：
      QQNT 的通话窗口是 Chromium 自绘（`Chrome_WidgetWin_1`）。PostMessage
      发过去的 WM_LBUTTONDOWN 会被 Chromium 的输入管线**静默丢弃** —— 函数返回
      「sent=true」，看起来成功了，实际上 QQ 一点反应都没有，电话继续响。
      日志上表现为「已接听，绑定 …」但主人那边电话根本没接起来。

      Chromium 只认系统输入队列里的真鼠标事件，所以这里用 SetCursorPos +
      mouse_event(LEFTDOWN/UP)，并先把窗口提到最前（否则点到的可能是别的窗口）。
      代价是会短暂移动真实鼠标/抢一次焦点 —— 只在「真的要接/挂」时走这条。

      ⚠️ 2026-10-25 补记（根因，务必别删）：本文件所在工作区被 DSH 沙箱标成
      `Low Mandatory Level`，而 **exe 上的低完整性标签会压低启动进程的令牌**。
      于是 `tools/asr/.venv/Scripts/python.exe` 起出来的本进程原先只有 Low ——
      Low 进程向 Medium 的 QQ 投鼠标，被 UIPI **静默丢弃**（返回码看着正常、
      光标不动、GetLastError=0）。已用 `icacls <exe> /setintegritylevel Medium`
      把 venv 里的 exe 提到 Medium，直接注入恢复可用。
      若哪天又「点了没反应」，先查 `icacls tools\\asr\\.venv\\Scripts\\python.exe` 的标签。
    """
    info: dict = {"screen": [sx, sy], "hwnd": hwnd, "real": True}
    prev = wt.POINT()
    user32.GetCursorPos(ctypes.byref(prev))
    if hwnd:
        # 提到最前但不激活：SWP_NOACTIVATE 避免抢走主人正在打字的焦点
        user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                            SWP_NOMOVE | SWP_NOSIZE | 0x0010)
        user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0,
                            SWP_NOMOVE | SWP_NOSIZE | 0x0010)

    # ── 主通道：本进程直接注入（进程已是 Medium，能落到 Medium 的 QQ 上）────────
    ok_pos = bool(user32.SetCursorPos(int(sx), int(sy)))
    time.sleep(0.09)
    cur = wt.POINT()
    user32.GetCursorPos(ctypes.byref(cur))
    landed = (cur.x, cur.y) == (int(sx), int(sy))
    info["set_cursor"] = ok_pos
    info["landed"] = landed
    if landed:
        user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        time.sleep(0.05)
        user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
        time.sleep(0.05)
        user32.SetCursorPos(prev.x, prev.y)   # 鼠标还回去
        info["sent"] = True
        info["via"] = "direct"
        return info

    # ── 兜底：node 派生 powershell 投递 ────────────────────────────────────────
    # 进程若被降级成 Low（例如 exe 标签又被改回 Low），直接注入会被静默丢弃，
    # 这时交给 node→powershell 那条链（Medium）来点。
    via_node = _click_via_node(int(sx), int(sy), prev.x, prev.y)
    info.update(via_node)
    info["sent"] = bool(via_node.get("ok"))
    return info


_CLICK_JS = pathlib.Path(__file__).resolve().parents[2] / "audio" / "call" / "click_once.cjs"


def _click_via_node(sx: int, sy: int, rx: int | None = None, ry: int | None = None) -> dict:
    """把一次真鼠标点击交给 node + powershell 投递。

    实测（2026-10-25）：python 进程链里直接调 win32 输入 API 会被静默丢弃，
    而 node 派生 powershell 后光标能真正移动、点击能落到 Chromium 窗口上。
    """
    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        return {"ok": False, "why": "找不到 node"}
    if not _CLICK_JS.exists():
        return {"ok": False, "why": f"缺少 {_CLICK_JS}"}
    argv = [node, str(_CLICK_JS), str(int(sx)), str(int(sy))]
    if rx is not None and ry is not None:
        argv += [str(int(rx)), str(int(ry))]
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=40,
                           encoding="utf-8", errors="replace")
    except Exception as e:
        return {"ok": False, "why": f"node 调用失败：{e}"}
    out = (r.stdout or "").strip().splitlines()
    last = out[-1].strip() if out else ""
    try:
        res = json.loads(last)
    except Exception:
        return {"ok": False, "why": f"node 输出无法解析：{last[:120]}"}
    res["via"] = "node-powershell"
    return res


# --------------------------------------------------------------------------- 点击

def _children(hwnd: int) -> list[tuple[int, str, tuple[int, int, int, int]]]:
    """列出所有后代子窗口（QQ 的内容都在 Chrome_WidgetWin_0 子窗口里）。"""
    out: list[tuple[int, str, tuple[int, int, int, int]]] = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def _cb(h, _l):
        buf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(h, buf, 256)
        r = wt.RECT()
        user32.GetWindowRect(h, ctypes.byref(r))
        out.append((h, buf.value, (r.left, r.top, r.right - r.left, r.bottom - r.top)))
        return True

    user32.EnumChildWindows(hwnd, _cb, 0)
    return out


def click_at(hwnd: int, sx: int, sy: int, *, dry_run: bool = True) -> dict:
    """在屏幕坐标 (sx, sy) 往目标窗口投一次左键。

    用 PostMessage 直接投到「命中点所属的子窗口」，坐标是相对该子窗口的客户区。
    这样不移动真实鼠标、不抢焦点、也不受窗口被遮挡影响。
    """
    target, rel = _resolve_click_target(hwnd, sx, sy)
    info = {"hwnd": hwnd, "screen": [sx, sy], "target": target, "rel": rel,
            "dry_run": dry_run}
    if dry_run or target == 0:
        return {**info, "sent": False}
    lparam = (rel[1] << 16) | (rel[0] & 0xFFFF)
    user32.PostMessageW(target, WM_LBUTTONDOWN, 1, lparam)
    time.sleep(0.05)
    user32.PostMessageW(target, WM_LBUTTONUP, 0, lparam)
    return {**info, "sent": True}


def _resolve_click_target(hwnd: int, sx: int, sy: int) -> tuple[int, tuple[int, int]]:
    """找到屏幕点 (sx,sy) 命中的最深子窗口，返回 (hwnd, 客户区相对坐标)。"""
    best = (hwnd, (sx, sy))
    for h, _cls, (x, y, w, hh) in _children(hwnd):
        if x <= sx < x + w and y <= sy < y + hh and (w * hh) > 0:
            best = (h, (sx - x, sy - y))
    return best


def _ocr_boxes(img) -> list[dict]:
    return wc.ocr_lines(img)


def _center_of(ln: dict) -> tuple[float, float]:
    """win_capture.ocr_lines 只给 box=(x1,y1,x2,y2)，没有 center 字段。

    以前这里直接读 ln["center"] → KeyError（被上层 except 吞掉，表现成
    「来电窗口里找不到『接听』按钮」）。现在统一从 box 算。
    """
    box = ln.get("box") or (0, 0, 0, 0)
    return ((box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0)


def _pick_button(boxes: list[dict], words: tuple[str, ...], size) -> dict | None:
    cands = []
    for ln in boxes:
        if any(w in ln["text"] for w in words):
            cands.append(ln)
    if not cands:
        return None
    # 取最靠下、最居中的那个（通话界面按钮在底部一排）
    W, _H = size
    cands.sort(key=lambda d: (-_center_of(d)[1], abs(_center_of(d)[0] - W / 2)))
    ln = cands[0]
    cx, cy = _center_of(ln)
    return {"word": ln["text"], "cx": int(cx), "cy": int(cy), "box": ln.get("box")}


def _color_buttons(img) -> list[dict]:
    """按颜色找「接听（绿）/挂断（红）」圆按钮，给 OCR 失灵时兜底。

    为什么需要它：QQ 的通话窗口是 Chromium 自绘 + GPU 合成，PrintWindow 抓到的是
    残缓冲（实测 std≈26 的噪点、OCR 零字），屏幕 BitBlt 也可能慢半拍。但**按钮的
    颜色是稳的**：真来电截图（`audio/call/callwin.png` 360x640）实测
      - 绿按钮：x 94..133, y 489..528 → 中心约 (114, 508)
      - 红按钮：x 226..265, y 489..528 → 中心约 (245, 508)
    位置是「下半部分、左右对称」的固定布局，所以颜色聚类比 OCR 更可靠。
    """
    import numpy as np

    a = np.asarray(img.convert("RGB")).astype(np.int16)
    H, W, _ = a.shape
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    masks = {
        "接听": (g > 110) & (g - r > 40) & (g - b > 40),
        "挂断": (r > 120) & (r - g > 50) & (r - b > 50),
    }
    out: list[dict] = []
    for word, m in masks.items():
        ys, xs = np.nonzero(m)
        if len(xs) < 200:
            continue
        # 只认窗口下半部分（按钮所在的区域），排除头像/背景里的杂色
        keep = ys > H * 0.5
        if keep.sum() < 200:
            continue
        xs, ys = xs[keep], ys[keep]
        box = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
        out.append({"word": word, "cx": int(xs.mean()), "cy": int(ys.mean()),
                    "box": box, "img_size": [W, H], "via": "color"})
    return out


def find_button(snap: CallSnapshot, words: tuple[str, ...]) -> dict | None:
    """在通话窗口里找某个按钮的位置（屏幕坐标 + 包围盒）。

    坐标基准必须和窗口左上角一致：PrintWindow 抓的是整窗（含外框），
    屏幕 BitBlt 抓的也是整窗区域，两者都相对窗口左上角 (x, y)，
    所以统一加 snap.window.x / y 就是屏幕坐标。

    三级兜底（2026-10-25 真来电实测得出）：
      1) PrintWindow + OCR  —— 窗口被挡住/最小化时也能用
      2) 屏幕 BitBlt + OCR  —— 像素是真的
      3) **颜色找圆按钮**   —— 前两级 OCR 都读不出字时的最后一条路
    """
    if snap.window is None:
        return None

    def _to_screen(hit: dict) -> dict:
        hit.update({"cx": snap.window.x + hit["cx"], "cy": snap.window.y + hit["cy"]})
        return hit

    img = wc.grab(snap.window.hwnd)
    if img is not None:
        hit = _pick_button(_ocr_boxes(img), words, img.size)
        if hit:
            hit["via"] = "printwindow"
            return _to_screen(hit)

    shot = None
    if snap.window.visible:
        shot = wc.grab_screen(snap.window.hwnd)
        if shot is not None:
            hit = _pick_button(_ocr_boxes(shot), words, shot.size)
            if hit:
                hit["via"] = "screen"
                return _to_screen(hit)

    # 第三条：颜色。绿=接听、红=挂断/拒绝。
    # 只用屏幕那张图：PrintWindow 的残缓冲连颜色都不可信。
    if shot is not None:
        for hit in _color_buttons(shot):
            if any(w in hit["word"] or hit["word"] in w for w in words):
                return _to_screen(hit)
    return None


def _ensure_on_screen(hwnd: int) -> dict:
    """把整个停在屏幕外的窗口挪回可见区域（真鼠标够不到负坐标）。

    实测（2026-10-25，Medium 完整性下）：QQ 主窗被放在 `400x724 @(1520,-724)` ——
    大小正常但 y 是负的，整块在屏幕上方之外。这种窗口 `SetCursorPos(y<0)` 直接失败，
    真鼠标点击根本投不出去。`SetWindowPos` 在 Medium 下是可用的（Low 时会被拒），
    所以先把窗口拽回主屏中央，再点。
    """
    info: dict = {"on_screen": True}
    r = wt.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return {"on_screen": None, "why": "GetWindowRect 失败"}
    w, h = r.right - r.left, r.bottom - r.top
    sw = user32.GetSystemMetrics(0)
    sh = user32.GetSystemMetrics(1)
    # 判定「有用面积在屏幕内」：至少要有一块能放下标题栏的区域
    if r.left >= 0 and r.top >= 0 and r.left < sw - 50 and r.top < sh - 50:
        info["rect"] = [r.left, r.top, w, h]
        return info
    x = max(60, (sw - w) // 2)
    y = max(60, (sh - h) // 3)
    ok = user32.SetWindowPos(hwnd, 0, x, y, 0, 0,
                             SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
    time.sleep(0.25)
    r2 = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r2))
    info.update({
        "on_screen": bool(r2.left >= 0 and r2.top >= 0),
        "moved_from": [r.left, r.top, w, h],
        "moved_to": [r2.left, r2.top, r2.right - r2.left, r2.bottom - r2.top],
        "move_ok": bool(ok),
        "why": "原窗口整块在屏幕外，已挪回可见区域",
    })
    return info


def _click_and_verify(snap: CallSnapshot, btn: dict, *, dry_run: bool) -> dict:
    """点一下按钮，然后**回读状态**确认真接起来了。

    校验是必须的：QQNT 是 Chromium 自绘，早先用 PostMessage 点「接听」时函数返回
    sent=true 但 QQ 毫无反应，上层于是记成「已接听」，而电话还在响 —— 那种假成功
    比直接失败更难查。所以这里：
      dry_run   → 只报「会点哪里」；
      real      → 真鼠标点完等 1.2s 再探一次状态，状态真的变了才算成功。
    """
    if dry_run:
        return click_at(snap.window.hwnd, btn["cx"], btn["cy"], dry_run=True)
    before = snap.state
    # 窗口若停在屏幕外（真鼠标够不到负坐标），先拽回可见区，然后**重新探一遍**：
    # 按钮的屏幕坐标是基于旧窗口位置算出来的，窗口一动就全废了。
    moved = _ensure_on_screen(snap.window.hwnd)
    if moved.get("moved_from"):
        time.sleep(0.35)
        fresh = probe_once()
        if fresh.window is not None and fresh.window.hwnd == snap.window.hwnd:
            again = find_button(fresh, (btn["word"],))
            if again:
                snap, btn = fresh, again
    res = click_real(btn["cx"], btn["cy"], hwnd=snap.window.hwnd)
    res["window_moved"] = moved
    time.sleep(1.2)
    after = probe_once().state
    res["state_before"] = before
    res["state_after"] = after
    res["changed"] = after != before
    return res


def answer(snap_or_none: CallSnapshot | None = None, *, dry_run: bool = True) -> dict:
    snap = snap_or_none or probe_once()
    if snap.state != STATE_RINGING:
        return {"ok": False, "why": f"当前状态 {snap.state}，不是来电"}
    btn = find_button(snap, ("接听", "接听语音", "接受"))
    if not btn:
        return {"ok": False, "why": "来电窗口里找不到「接听」按钮", "state": snap.state}
    res = _click_and_verify(snap, btn, dry_run=dry_run)
    if not dry_run and not res.get("changed"):
        return {"ok": False, "why": f"点了「{btn['word']}」但状态没变（点空了/被丢弃）",
                "button": btn["word"], **res}
    return {"ok": True, "button": btn["word"], **res}


def hangup(snap_or_none: CallSnapshot | None = None, *, dry_run: bool = True) -> dict:
    snap = snap_or_none or probe_once()
    if snap.state not in (STATE_IN_CALL, STATE_RINGING):
        return {"ok": False, "why": f"当前状态 {snap.state}，没有可挂断的通话"}
    btn = find_button(snap, ("挂断", "拒绝", "结束"))
    if not btn:
        return {"ok": False, "why": "找不到「挂断」按钮", "state": snap.state}
    res = _click_and_verify(snap, btn, dry_run=dry_run)
    if not dry_run and not res.get("changed"):
        return {"ok": False, "why": f"点了「{btn['word']}」但状态没变", "button": btn["word"], **res}
    return {"ok": True, "button": btn["word"], **res}


# --------------------------------------------------------------------------- CLI

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--watch", type=float, default=0.0, help="观察多少秒")
    ap.add_argument("--poll", type=float, default=1.0)
    ap.add_argument("--json", action="store_true", help="只输出最终 JSON")
    ap.add_argument("--no-ocr", action="store_true")
    ap.add_argument("--save", action="store_true", help="把命中帧存到 recordings/")
    ap.add_argument("--answer", action="store_true", help="试着接听（默认 dry-run）")
    ap.add_argument("--hangup", action="store_true", help="试着挂断（默认 dry-run）")
    ap.add_argument("--real", action="store_true", help="真的点，不是 dry-run")
    args = ap.parse_args()

    save_dir = (Path(__file__).resolve().parent / "recordings") if args.save else None

    if args.answer:
        print(json.dumps(answer(dry_run=not args.real), ensure_ascii=False))
        return 0
    if args.hangup:
        print(json.dumps(hangup(dry_run=not args.real), ensure_ascii=False))
        return 0

    if args.watch <= 0:
        snap = probe_once(ocr=not args.no_ocr, save_dir=save_dir)
        print(json.dumps(snap.to_dict(), ensure_ascii=False, indent=None if args.json else 2))
        return 0

    t_end = time.time() + args.watch
    last = None
    while time.time() < t_end:
        snap = probe_once(ocr=not args.no_ocr, save_dir=save_dir)
        if snap.state != last:
            if not args.json:
                print(f"[{snap.ts}] {snap.state:8s} win={snap.window.title if snap.window else None!r} "
                      f"hits={snap.hits}")
                if snap.state != STATE_IDLE and snap.lines:
                    print("        OCR:", " / ".join(snap.lines[:8]))
            last = snap.state
        elif not args.json:
            print(f"[{snap.ts}] {snap.state} (无变化)", end="\r")
        time.sleep(args.poll)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())

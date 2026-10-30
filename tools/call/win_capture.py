# -*- coding: utf-8 -*-
"""Windows 窗口枚举 + 截图 + OCR（通话盲测与接听自动化的地基）。

为什么要自己写：QQ 的 UIA 树是空的（实测 elements=0，纯自绘），
读不到「接听」按钮这样的控件——只能截图再认字。

本模块只做三件事，全部无副作用（不点击、不按键）：
  1. list_windows(pid)   枚举某个进程的所有顶层窗口
  2. grab(hwnd)          PrintWindow 抓一张 PIL 图（窗口被遮挡也能抓到）
  3. ocr_lines(img)      用 Windows 自带 OCR 认出文字 + 包围盒

OCR 用 Windows.Media.Ocr（系统已装 zh-Hans-CN），零额外安装。
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
from dataclasses import dataclass

from PIL import Image

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

PW_RENDERFULLCONTENT = 0x00000002


@dataclass
class WinInfo:
    hwnd: int
    pid: int
    title: str
    cls: str
    x: int
    y: int
    w: int
    h: int
    visible: bool
    minimized: bool

    @property
    def size(self) -> tuple[int, int]:
        return (self.w, self.h)

    def __str__(self) -> str:
        return (f"hwnd={self.hwnd} pid={self.pid} {self.w}x{self.h} "
                f"@({self.x},{self.y}) vis={self.visible} min={self.minimized} "
                f"cls={self.cls!r} title={self.title!r}")


def _window_text(hwnd: int) -> str:
    n = user32.GetWindowTextLengthW(hwnd)
    if n <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def _class_name(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def _rect(hwnd: int) -> tuple[int, int, int, int]:
    r = wt.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return (0, 0, 0, 0)
    return (r.left, r.top, r.right - r.left, r.bottom - r.top)


def list_windows(pid: int | None = None, *, visible_only: bool = True) -> list[WinInfo]:
    """枚举顶层窗口；pid 给定时只返回那个进程的。"""
    out: list[WinInfo] = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def _cb(hwnd, _lparam):
        wpid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
        if pid is not None and wpid.value != pid:
            return True
        vis = bool(user32.IsWindowVisible(hwnd))
        if visible_only and not vis:
            return True
        x, y, w, h = _rect(hwnd)
        if w <= 0 or h <= 0:
            return True
        out.append(WinInfo(
            hwnd=hwnd, pid=wpid.value, title=_window_text(hwnd),
            cls=_class_name(hwnd), x=x, y=y, w=w, h=h,
            visible=vis, minimized=bool(user32.IsIconic(hwnd)),
        ))
        return True

    user32.EnumWindows(_cb, 0)
    return out


def _bitblt_from_screen(hdc_dst, x: int, y: int, w: int, h: int) -> bool:
    """从屏幕 DC 直接 BitBlt 一块。窗口被遮挡时抓到的是遮挡物，这是固有限制。"""
    hdc_screen = user32.GetDC(0)
    if not hdc_screen:
        return False
    try:
        return bool(gdi32.BitBlt(hdc_dst, 0, 0, w, h, hdc_screen, x, y, 0x00CC0020))
    finally:
        user32.ReleaseDC(0, hdc_screen)


def _children(hwnd: int) -> list[tuple[int, str, tuple[int, int, int, int]]]:
    """所有后代子窗口：[(hwnd, class, (x, y, w, h))]，坐标是屏幕坐标。"""
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


class _BMIH(ctypes.Structure):
    _fields_ = [
        ("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
        ("biPlanes", wt.WORD), ("biBitCount", wt.WORD),
        ("biCompression", wt.DWORD), ("biSizeImage", wt.DWORD),
        ("biXPelsPerMeter", wt.LONG), ("biYPelsPerMeter", wt.LONG),
        ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD),
    ]


def _render(hwnd: int, x: int, y: int, w: int, h: int) -> Image.Image | None:
    """把 hwnd 的内容渲染成一张 w×h 的图（坐标只用于兜底 BitBlt）。

    返回 None 表示这条路没成功；返回全黑图也视为失败（上层会换路）。
    """
    hdc_src = user32.GetWindowDC(hwnd)
    if not hdc_src:
        return None
    hdc_mem = gdi32.CreateCompatibleDC(hdc_src)
    bmp = gdi32.CreateCompatibleBitmap(hdc_src, w, h)
    old = gdi32.SelectObject(hdc_mem, bmp)
    try:
        ok = user32.PrintWindow(hwnd, hdc_mem, PW_RENDERFULLCONTENT)
        if not ok:
            ok = user32.PrintWindow(hwnd, hdc_mem, 0)
        if not ok:
            ok = _bitblt_from_screen(hdc_mem, x, y, w, h)
        if not ok:
            return None

        bi = _BMIH()
        bi.biSize = ctypes.sizeof(_BMIH)
        bi.biWidth = w
        bi.biHeight = -h          # 负数 = 自上而下
        bi.biPlanes = 1
        bi.biBitCount = 32
        bi.biCompression = 0      # BI_RGB

        buf = ctypes.create_string_buffer(w * h * 4)
        if gdi32.GetDIBits(hdc_mem, bmp, 0, h, buf, ctypes.byref(bi), 0) == 0:
            return None
        return Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1).convert("RGB")
    finally:
        gdi32.SelectObject(hdc_mem, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(hdc_mem)
        user32.ReleaseDC(hwnd, hdc_src)


def _is_blank(img: Image.Image) -> bool:
    """全黑/全白都算抓失败（PrintWindow 对某些窗口会「成功」地吐一张纯色图）。"""
    import numpy as np
    a = np.asarray(img)
    return float(a.std()) < 2.0


def grab(hwnd: int) -> Image.Image | None:
    """抓窗口画面。三级兜底，全都不行才返回 None。

    本机实测（2026-10-25，QQ 的 Electron 窗口）：
      顶层窗口 PrintWindow          → 返回 0，GetLastError=5（拒绝访问），全黑
      子窗口 Intermediate D3D Window → PrintWindow 返回 1，**画面完整** ✅
      屏幕 BitBlt                   → 能用，但要求窗口没被遮挡

    所以主路径是「对子窗口 PrintWindow」：QQ 用 Chromium 的 D3D 子窗口画内容，
    抓那个才有像素；对顶层抓永远黑屏。这条路的附带好处是窗口被别的窗口盖住、
    甚至最小化也照样能抓——无人值守接电话必须靠它。
    """
    x, y, w, h = _rect(hwnd)
    if w <= 0 or h <= 0:
        return None

    # 1) 子窗口 PrintWindow：按面积从大到小试，第一个非空白图就用
    kids = [k for k in _children(hwnd) if k[2][2] > 0 and k[2][3] > 0]
    kids.sort(key=lambda k: -(k[2][2] * k[2][3]))
    for chw, _cls, (cx, cy, cw, chh) in kids[:6]:
        img = _render(chw, cx, cy, cw, chh)
        if img is not None and not _is_blank(img):
            if (cw, chh) == (w, h):
                return img
            # 子窗口比顶层小：贴到同尺寸画布上，保持坐标一致
            canvas = Image.new("RGB", (w, h), (0, 0, 0))
            canvas.paste(img, (cx - x, cy - y))
            return canvas

    # 2) 顶层 PrintWindow / 3) 屏幕 BitBlt
    img = _render(hwnd, x, y, w, h)
    if img is not None and not _is_blank(img):
        return img
    return None


def grab_screen(hwnd: int) -> Image.Image | None:
    """从屏幕抓某个窗口区域（可见窗口才有效，但像素是真的）。

    为什么需要它：来电窗口（Chrome_WidgetWin_1 标题「语音通话」）内容是
    Chromium 的 D3D 合成层，PrintWindow 抓出来是噪点（实测 OCR 一个字都读不出）；
    而它**是可见的**，直接 BitBlt 屏幕就有真像素。
    """
    x, y, w, h = _rect(hwnd)
    if w <= 0 or h <= 0:
        return None
    try:
        from PIL import ImageGrab
        vx = user32.GetSystemMetrics(76)   # SM_XVIRTUALSCREEN
        vy = user32.GetSystemMetrics(77)   # SM_YVIRTUALSCREEN
        full = ImageGrab.grab(all_screens=True)
        box = (x - vx, y - vy, x - vx + w, y - vy + h)
        img = full.crop(box).convert("RGB")
        return img
    except Exception:  # noqa: BLE001
        return None


def ocr_lines(img: Image.Image, lang: str = "zh-Hans-CN") -> list[dict]:
    """OCR 出每行文字 + 包围盒：[{text, box:(x1,y1,x2,y2), words:[...]}]"""
    import winocr

    if img.mode != "RGB":
        img = img.convert("RGB")
    res = winocr.recognize_pil_sync(img, lang)
    out: list[dict] = []
    for ln in res.get("lines", []):
        words = ln.get("words") or []
        if not words:
            continue
        x1 = min(w["bounding_rect"]["x"] for w in words)
        y1 = min(w["bounding_rect"]["y"] for w in words)
        x2 = max(w["bounding_rect"]["x"] + w["bounding_rect"]["width"] for w in words)
        y2 = max(w["bounding_rect"]["y"] + w["bounding_rect"]["height"] for w in words)
        out.append({
            "text": ln.get("text", "").replace(" ", ""),
            "box": (round(x1), round(y1), round(x2), round(y2)),
            "words": words,
        })
    return out


# 「这看起来像不像一个来电/通话窗口」——只看字，不做判断以外的动作。
CALL_WORDS = ("接听", "挂断", "拒绝", "通话中", "语音通话", "视频通话", "正在呼叫", "邀请你语音")


def looks_like_call(lines: list[dict]) -> list[str]:
    hits: list[str] = []
    for ln in lines:
        t = ln["text"]
        for kw in CALL_WORDS:
            if kw in t:
                hits.append(t)
                break
    return hits


if __name__ == "__main__":
    import json
    import sys

    pid = int(sys.argv[1]) if len(sys.argv) > 1 else None
    for wi in list_windows(pid):
        print(wi)
        img = grab(wi.hwnd)
        if img is None:
            print("   (抓不到画面)")
            continue
        lines = ocr_lines(img)
        print(f"   OCR {len(lines)} 行:", json.dumps([l["text"] for l in lines[:8]], ensure_ascii=False))
        hits = looks_like_call(lines)
        if hits:
            print("   ★ 疑似通话窗口:", hits)

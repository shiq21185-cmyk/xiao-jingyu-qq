#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""通话音频的自动清理：按年龄 + 按总量双闸。

主人 2026-10-29 定的规矩（原话见 DEVLOG 那天那一条）：

  · 录音 `call-*.wav` 与逐字稿 `call-*.json` 是**成果** —— 超过 `keep_days` 天自动删；
    另外整个目录超过 `keep_mb` 时从**最旧的**开始删（防止某段时间打得特别多）。
    两个阈值都由调用方从 `config.json` 的 `call.recKeepDays` / `call.recKeepMB` 传进来，
    所以想改规矩不用改代码。
  · 临时合成音频 `say-*.mp3`（"合成一句就播出去"那一下）不归这里管，它由
    `call_sidecar.sweep_spool()` 在引擎启动与挂断两个时机清掉。

为什么这段逻辑要单独放一个文件：它会**真的删主人的东西**，所以必须能被单独验证 ——
`python tools/call/retention.py --selftest` 会造一批假文件，把年龄闸和总量闸各跑一遍。

只删匹配 `pattern` 的文件，目录里其他东西（比如 `click_once.cjs`）一律不动。
"""
from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

DAY_S = 86400.0


def _candidates(directory: Path, pattern: str) -> list[tuple[Path, float, int]]:
    """列出目录里匹配 pattern 的普通文件 → [(路径, mtime, 字节)]，按名字升序。

    按名字而不是 mtime 排序：文件名里就带 `YYYYMMDD-HHMMSS` 时间戳，
    同一次通话的 wav/json 同名，按名字排能保证"先删更早的那通"。
    """
    out: list[tuple[Path, float, int]] = []
    try:
        entries = sorted(directory.glob(pattern))
    except OSError:
        return out
    for p in entries:
        try:
            if not p.is_file():
                continue
            st = p.stat()
        except OSError:
            continue          # 正好被别人删了/锁着，跳过就行
        out.append((p, st.st_mtime, st.st_size))
    return out


def sweep_dir(directory, pattern: str = "call-*.wav", keep_days: float = 30.0,
              keep_mb: float = 1024.0, now: float | None = None, log=print) -> dict:
    """清一个目录，返回一份账：{"deleted":[(path,原因)],"kept":n,"freed_bytes":x,
    "bytes_left":y,"failed":[(path,错误)]"}。

    先过年龄闸，再对**活着的那批**过总量闸（超了从最旧的删）。
    任何一步出错都不会抛给调用方 —— 清不动旧文件绝不该让通话打不了。
    """
    res = {"deleted": [], "kept": 0, "freed_bytes": 0, "bytes_left": 0, "failed": []}
    d = Path(directory)
    if not d.is_dir():
        return res
    now = time.time() if now is None else now
    keep: list[tuple[Path, float, int]] = []
    for p, mtime, size in _candidates(d, pattern):
        age_days = (now - mtime) / DAY_S
        if keep_days and age_days > keep_days:
            res["deleted"].append((p, f"超龄 {age_days:.0f} 天 > {keep_days:.0f} 天"))
        else:
            keep.append((p, mtime, size))
    cap = int(keep_mb * 1024 * 1024) if keep_mb else 0
    total = sum(s for _, _, s in keep)
    while cap and keep and total > cap:
        p, _, size = keep.pop(0)
        res["deleted"].append((p, f"目录超上限（{total / 1048576:.0f}MB > {keep_mb:.0f}MB）"))
        total -= size
    for p, why in res["deleted"]:
        try:
            size = p.stat().st_size
            p.unlink()
            res["freed_bytes"] += size
            log(f"🗑 清理 {p.name}（{why}）")
        except OSError as exc:
            res["failed"].append((p, f"{type(exc).__name__}: {exc}"))
            log(f"⚠️ 清不掉 {p.name}：{type(exc).__name__}: {exc}")
    res["kept"] = len(keep)
    res["bytes_left"] = total
    return res


def sweep_many(targets, keep_days: float = 30.0, keep_mb: float = 1024.0, log=print) -> dict:
    """对多个 (目录, pattern, 名字) 各跑一遍，合并成一份总账（给 sidecar / CLI 用）。"""
    total = {"deleted": [], "kept": 0, "freed_bytes": 0, "bytes_left": 0, "failed": [], "parts": []}
    for directory, pattern, what in targets:
        r = sweep_dir(directory, pattern=pattern, keep_days=keep_days, keep_mb=keep_mb, log=log)
        r["what"] = what
        total["parts"].append(r)
        for k in ("deleted", "kept", "freed_bytes", "bytes_left", "failed"):
            if k == "kept" or k == "freed_bytes" or k == "bytes_left":
                total[k] += r[k]
            else:
                total[k].extend(r[k])
    return total


# --------------------------------------------------------------------------
# 自检：这段逻辑会删东西，所以必须能单独证明它对
# --------------------------------------------------------------------------
def selftest() -> int:
    import tempfile

    fails: list[str] = []

    def check(cond, msg):
        print(("  [OK]   " if cond else "  [FAIL] ") + msg)
        if not cond:
            fails.append(msg)

    quiet = lambda *a, **k: None  # noqa: E731

    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        now = time.time()

        def mk(name, size, age_days):
            p = d / name
            p.write_bytes(b"x" * size)
            t = now - age_days * DAY_S
            os.utime(p, (t, t))
            return p

        print("==> 年龄闸：30 天以上删掉，以内的留着")
        fresh = mk("call-20261029-120000.wav", 1000, 0.1)
        old_a = mk("call-20260801-120000.wav", 2000, 40)
        old_b = mk("call-20260802-120000.wav", 3000, 41)
        stranger = d / "click_once.cjs"
        stranger.write_text("运行时依赖，绝不能删")
        r = sweep_dir(d, keep_days=30, keep_mb=1024, log=quiet)
        left = sorted(p.name for p in d.iterdir())
        check(left == ["call-20261029-120000.wav", "click_once.cjs"], f"只该剩今天的那个 + 非匹配文件（实际 {left}）")
        check(not old_a.exists() and not old_b.exists(), "两个超龄录音都被删了")
        check(fresh.exists(), "今天的录音没被动")
        check(stranger.exists(), "不匹配 pattern 的文件没被动")
        check(len(r["deleted"]) == 2 and r["freed_bytes"] == 5000, f"账对得上（deleted={len(r['deleted'])} freed={r['freed_bytes']}）")

        print("==> 总量闸：全都很新、但超过上限时从最旧的删")
        for p in list(d.glob("call-*.wav")):
            p.unlink()
        a = mk("call-20261029-100000.wav", 1000, 3)
        b = mk("call-20261029-110000.wav", 1000, 2)
        c = mk("call-20261029-120000.wav", 1000, 1)
        r2 = sweep_dir(d, keep_days=30, keep_mb=0.002, log=quiet)   # 0.002 MB ≈ 2097 B
        check(not a.exists(), "最旧的那个被删（腾地方）")
        check(b.exists() and c.exists(), "另外两个留着")
        check(r2["bytes_left"] <= 2097, f"剩下的总量已回到上限内（{r2['bytes_left']} B）")

        print("==> 目录不存在 / 空目录：不该抛")
        try:
            sweep_dir(d / "no-such-dir", log=quiet)
            check(True, "不存在的目录安全返回")
        except Exception as exc:  # noqa: BLE001
            check(False, f"不存在的目录抛了异常：{exc}")

        print("==> sweep_many：两份目录合并成一份总账")
        logdir = d / "logs"
        logdir.mkdir()
        mk2 = logdir / "call-20260101-000000.json"
        mk2.write_bytes(b"y" * 500)
        t = now - 99 * DAY_S
        os.utime(mk2, (t, t))
        tot = sweep_many([(d, "call-*.wav", "录音"), (logdir, "call-*.json", "逐字稿")],
                         keep_days=30, keep_mb=1024, log=quiet)
        check(len(tot["parts"]) == 2 and tot["deleted"], "两份都扫了，并且逐字稿被删了")
        check(not mk2.exists(), "超龄逐字稿被删")

    print()
    if fails:
        print(f"结果：{len(fails)} 项没过")
        return 1
    print("结果：全部通过。")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="通话录音/逐字稿的自动清理（按年龄 + 按总量双闸）")
    ap.add_argument("--dir", default=None, help="要清的目录（不给就只跑 --selftest）")
    ap.add_argument("--pattern", default="call-*.wav", help="只清匹配这个名字的东西（默认 call-*.wav）")
    ap.add_argument("--keep-days", type=float, default=30.0, help="超过这么多天就删（默认 30）")
    ap.add_argument("--keep-mb", type=float, default=1024.0, help="目录超过这么多 MB 就从最旧的删（默认 1024）")
    ap.add_argument("--selftest", action="store_true", help="跑自检（会造临时文件，不动真数据）")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if not args.dir:
        ap.print_help()
        return 2
    r = sweep_dir(args.dir, pattern=args.pattern, keep_days=args.keep_days, keep_mb=args.keep_mb)
    print(f"删了 {len(r['deleted'])} 个（{r['freed_bytes'] / 1048576:.2f} MB），"
          f"留着 {r['kept']} 个 / 剩 {r['bytes_left'] / 1048576:.2f} MB，失败 {len(r['failed'])} 个")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

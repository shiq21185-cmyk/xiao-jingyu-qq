# -*- coding: utf-8 -*-
"""探测：本机已有的「虚拟声卡对」能不能当 QQ 麦克风的注入通道。

背景：小鲸鱼要说话，必须把声音灌进 QQ 的「麦克风」。正规做法是装 VB-CABLE，
但那要 UAC 提权。本机已经存在一套虚拟音频设备（UU远程虚拟音频设备），
它有一个播放端和一个采集端——如果「往播放端播的声音能从采集端录回来」，
那它本身就是一根现成的虚拟线，不用装任何驱动。

判定标准很硬：播 1kHz 单音，从采集端录回来，看 1kHz 的能量是否显著高于底噪。
不许用「能打开设备」当成功。

用法：
    python tools/call/probe_virtual_mic.py
"""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import call_audio as ca  # noqa: E402

SR = 48000


def tone(freq: float, seconds: float, amp: float = 0.25) -> np.ndarray:
    t = np.arange(int(SR * seconds)) / SR
    env = np.ones_like(t)
    fade = int(SR * 0.02)
    env[:fade] = np.linspace(0, 1, fade)
    env[-fade:] = np.linspace(1, 0, fade)
    return (amp * env * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def band_energy(x: np.ndarray, sr: int, freq: float, width: float = 40.0) -> float:
    """x 在 freq±width 频带内的能量占比（粗略，够判断有没有这个音）。"""
    if x.size < 1024:
        return 0.0
    win = np.hanning(x.size)
    spec = np.abs(np.fft.rfft(x * win)) ** 2
    freqs = np.fft.rfftfreq(x.size, 1.0 / sr)
    band = (freqs >= freq - width) & (freqs <= freq + width)
    total = spec.sum()
    return float(spec[band].sum() / total) if total > 0 else 0.0


def probe_mic_pair(spk_name: str, mic_name: str) -> dict:
    import soundcard as sc

    ca.ensure_com()
    res: dict = {"speaker": spk_name, "mic": mic_name}
    spk = next((m for m in sc.all_speakers() if spk_name.lower() in m.name.lower()), None)
    mic = next((m for m in sc.all_microphones(include_loopback=True)
                if mic_name.lower() in m.name.lower()), None)
    if spk is None or mic is None:
        res["ok"] = False
        res["why"] = "设备没找到"
        return res

    clip = tone(1000.0, 2.5)
    grabbed: list[np.ndarray] = []
    started = threading.Event()

    def _rec():
        ca.ensure_com()
        try:
            with mic.recorder(samplerate=SR, channels=1, blocksize=480) as rec:
                started.set()
                t_end = time.time() + 3.0
                while time.time() < t_end:
                    d = rec.record(numframes=480)
                    mono = d.mean(axis=1) if d.ndim == 2 else d
                    grabbed.append(np.asarray(mono, dtype=np.float32))
        except Exception as exc:  # noqa: BLE001
            res["rec_err"] = f"{type(exc).__name__}: {exc}"

    th = threading.Thread(target=_rec, daemon=True)
    th.start()
    started.wait(3.0)
    time.sleep(0.3)

    def _play():
        ca.ensure_com()
        try:
            with spk.player(samplerate=SR, channels=2) as sp:
                sp.play(np.repeat(clip.reshape(-1, 1), 2, axis=1))
        except Exception as exc:  # noqa: BLE001
            res["play_err"] = f"{type(exc).__name__}: {exc}"

    pt = threading.Thread(target=_play, daemon=True)
    pt.start()
    pt.join(6.0)
    th.join(6.0)

    if not grabbed:
        res["ok"] = False
        res["why"] = res.get("rec_err") or "采集端没录到任何数据"
        return res

    x = np.concatenate(grabbed)
    rms = float(np.sqrt(np.mean(np.square(x)))) if x.size else 0.0
    dbfs = 20 * np.log10(max(rms, 1e-9))
    ratio = band_energy(x, SR, 1000.0)
    res.update({
        "samples": int(x.size),
        "seconds": round(x.size / SR, 2),
        "dbfs": round(dbfs, 1),
        "tone_ratio": round(ratio, 4),
    })
    # 判定：录到足够时长 + 电平不是静音 + 1kHz 明显占优
    res["ok"] = bool(x.size > SR * 0.5 and dbfs > -60 and ratio > 0.35)
    if not res["ok"]:
        res["why"] = ("采集端几乎没声音（dbfs 太低）" if dbfs <= -60 else
                      "录到了东西，但听不出那个 1kHz（可能不是同一根线）")
    return res


def main() -> int:
    info = ca.list_devices()
    print("播放设备：")
    for s in info["speakers"]:
        print("   ", s["name"])
    print("采集设备：")
    for m in info["microphones"]:
        print(f"    {m['name']}{'  [环回]' if m['loopback'] else ''}")
    print()

    candidates = [
        ("扬声器 (UU远程虚拟音频设备)", "麦克风阵列 (UU远程虚拟音频设备)"),
    ]
    any_ok = False
    for spk, mic in candidates:
        print(f"测试：播 [{spk}] → 录 [{mic}]")
        r = probe_mic_pair(spk, mic)
        print(f"   结果：{'通 ✅' if r.get('ok') else '不通 ❌'}")
        for k, v in r.items():
            if k not in ("ok",):
                print(f"      {k}: {v}")
        print()
        any_ok = any_ok or bool(r.get("ok"))
    print("结论：", "本机已有可用的虚拟麦克风通道" if any_ok else "现有虚拟设备不能当麦克风通道，需要 VB-CABLE")
    return 0 if any_ok else 1


if __name__ == "__main__":
    sys.exit(main())

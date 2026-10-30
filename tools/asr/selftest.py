#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""selftest.py —— 装完语音能力后跑一次，确认「能听」和「能说」都真的通。

它只做四件小事，每件都尽量不联网：
  1. import 检查：faster-whisper / ctranslate2 / av / edge_tts 是否都在
  2. 听：把一段静音 WAV 喂给 worker 的模型（只验证模型能加载，不验证识别质量）
  3. 繁 → 简：真电话里 whisper 会吐繁体原句，确认 opencc 转换真的可用（2026-10-26 加）
  4. 说：用 SAPI（离线）合成一句话到临时文件，确认 TTS 链路可用
     edge-tts 需要联网，所以只做 import 检查，不真的发请求

退出码：0 全通 / 1 有硬失败
"""
from __future__ import annotations

import os
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
FAILS: list[str] = []


def ok(msg: str) -> None:
    print(f"    [OK]   {msg}")


def warn(msg: str) -> None:
    print(f"    [WARN] {msg}")


def bad(msg: str) -> None:
    print(f"    [X]    {msg}")
    FAILS.append(msg)


def step(msg: str) -> None:
    print(f"\n==> {msg}")


def make_silence_wav(path: Path, seconds: float = 1.0, rate: int = 16000) -> None:
    """写一段 16k 单声道静音 WAV —— faster-whisper 只需要能解码就行。"""
    n = int(rate * seconds)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * n)


def main() -> int:
    print(f"  目标目录：{HERE}")
    print(f"  Python  ：{sys.version.split()[0]}  ({sys.executable})")

    # ---------- 1. import ----------
    step("检查依赖")
    modules = [
        ("faster_whisper", "ASR 引擎"),
        ("ctranslate2", "faster-whisper 的后端"),
        ("av", "音频解码"),
        ("edge_tts", "在线语音（edge 引擎）"),
    ]
    for mod, what in modules:
        try:
            __import__(mod)
            ok(f"{mod}  ({what})")
        except Exception as exc:
            bad(f"import {mod} 失败：{exc}  —— {what}")

    try:
        import win32com.client  # noqa: F401
        ok("pywin32  (SAPI 离线语音)")
    except Exception as exc:
        warn(f"import win32com 失败（{exc}）；离线 SAPI 说话不可用，edge 引擎不受影响")

    # ---------- 2. 听 ----------
    step("听：加载 whisper 模型并跑一段静音")
    model_dir = Path(os.environ.get("ASR_MODEL_DIR", str(HERE / "models")))
    model_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        wav = Path(td) / "silence.wav"
        make_silence_wav(wav)
        code = (
            "import sys, os\n"
            f"os.environ['ASR_MODEL_DIR'] = r'{model_dir}'\n"
            "sys.path.insert(0, r'%s')\n" % str(HERE)
            + "from faster_whisper import WhisperModel\n"
            f"m = WhisperModel('small', device='cpu', compute_type='int8', download_root=r'{model_dir}')\n"
            f"segs, info = m.transcribe(r'{wav}', language='zh')\n"
            "n = sum(1 for _ in segs)\n"
            "print('模型就绪，静音片段数 =', n)\n"
        )
        py = sys.executable
        r = subprocess.run([py, "-c", code], capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode == 0:
            ok((r.stdout or "").strip().splitlines()[-1] if r.stdout.strip() else "模型就绪")
        else:
            tail = (r.stderr or "").strip().splitlines()[-6:]
            bad("whisper 模型加载失败")
            for line in tail:
                print("           " + line)

    # ---------- 3. 繁 → 简 ----------
    step("繁 → 简：真电话里的繁体原句能不能转成简体")
    try:
        import transcribe as T

        ready, why = T.warmup_t2s()
        if not ready:
            bad(f"opencc 不可用：{why} —— 通话里 whisper 吐的繁体不会被纠正（pip install -r requirements.txt）")
        else:
            # 这句抄自 2026-10-25 那通真电话的 ASR 原句（audio/call/ears.txt）
            sample = "你能不能主動掛斷"
            want = "你能不能主动挂断"
            got = T.to_simplified(sample)
            if got == want:
                ok(f"{why}；「{sample}」→「{got}」")
            else:
                bad(f"转换结果不对：「{sample}」→「{got}」（应为「{want}」）")
            if T.INITIAL_PROMPT.strip():
                ok(f"简体倾向提示词：{T.INITIAL_PROMPT!r}")
            else:
                warn("ASR_INITIAL_PROMPT 是空的 —— 模型不会被往简体引，只剩转换兜底")
    except Exception as exc:
        bad(f"繁→简 自检失败：{exc}")

    # ---------- 4. 说 ----------
    step("说：SAPI 离线合成一句话")
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "hello.wav"
        code = (
            "import win32com.client, os\n"
            "sp = win32com.client.Dispatch('SAPI.SpVoice')\n"
            "st = win32com.client.Dispatch('SAPI.SpFileStream')\n"
            f"st.Open(r'{out}', 3, False)\n"
            "sp.AudioOutputStream = st\n"
            "sp.Speak('语音自检')\n"
            "st.Close()\n"
            f"print(os.path.getsize(r'{out}'))\n"
        )
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode == 0 and out.exists() and out.stat().st_size > 1000:
            ok(f"SAPI 合成成功（{out.stat().st_size} 字节）")
        else:
            warn("SAPI 离线合成没成功（机器上没有中文语音包时正常）；edge 引擎仍然可用")

    # ---------- 收尾 ----------
    step("结果")
    if FAILS:
        print(f"    有 {len(FAILS)} 项硬失败：")
        for f in FAILS:
            print(f"      - {f}")
        return 1
    print("    全部通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

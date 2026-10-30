#!/usr/bin/env python
"""本机语音合成（TTS）：把文字念成一段音频。

为什么要和 ASR 分成两个文件：她「听」（transcribe.py / worker.py）和她「说」
（这里）是两件独立的事，引擎、依赖、失败面都不同 —— ASR 是本地 whisper、
永远离线；TTS 则分两条路：

  edge  微软 Edge 的在线神经网络语音。自然、像真人，但**需要联网**，
        而且**要念的文字会发到微软的语音服务**。（她打的话本来就已经在
        云端模型上跑过一遍，但这仍是多出去的一份数据，所以引擎做成可配的。）
  sapi  Windows 自带的离线语音。零联网、零额外依赖，机器味重、中文音色
        只有四个，但**她的话一个字都不出这台电脑**。

stdout 只输出一行 JSON，stderr 给人看。退出码非 0 表示失败。
"""
import argparse
import asyncio
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

DEFAULT_ENGINE = os.environ.get("TTS_ENGINE", "edge")
DEFAULT_VOICE = os.environ.get("TTS_VOICE", "")
DEFAULT_RATE = os.environ.get("TTS_RATE", "+0%")
DEFAULT_VOLUME = os.environ.get("TTS_VOLUME", "+0%")
DEFAULT_PITCH = os.environ.get("TTS_PITCH", "+0Hz")
DEFAULT_SAPI_VOICE = os.environ.get("TTS_SAPI_VOICE", "Huihui")
DEFAULT_SAPI_RATE = os.environ.get("TTS_SAPI_RATE", "0")
DEFAULT_MAX_CHARS = int(os.environ.get("TTS_MAX_CHARS", "300") or 300)

EDGE_FALLBACK_VOICE = "zh-CN-XiaoyiNeural"


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def clean_text(text, max_chars=DEFAULT_MAX_CHARS):
    """把要念的文字收拾干净：去控制字符与 Markdown 记号、压空白、限长。"""
    s = str(text or "")
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    # 行首列表记号（"- "、"1. "、"1、"）念出来是"减号"或奇怪停顿，先去干净。
    # `-`/`+`/`*` 后面必须有空格才算记号（否则"-5 度"的负号会被误吃），
    # 而 `1.`/`1、` 本身就是分隔符，空格可有可无。
    s = re.sub(r"(^|\n)[ \t]*(?:[-+*][ \t]+|\d+[.、)][ \t]*)", r"\1", s)
    s = s.replace("\n", " ")
    # Markdown 记号念出来很奇怪（星号会被读成"星号"）
    s = re.sub(r"[`*_~#>|]+", "", s)
    s = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    if max_chars and len(s) > max_chars:
        s = s[:max_chars].strip()
        s = re.sub(r"[\s，。、；：]+$", "", s) + "…"
    return s


def default_voice(engine=None):
    eng = str(engine or DEFAULT_ENGINE).lower()
    if DEFAULT_VOICE:
        return DEFAULT_VOICE
    return EDGE_FALLBACK_VOICE if eng == "edge" else DEFAULT_SAPI_VOICE


# ── edge：在线神经网络语音 ───────────────────────────────────────────────
async def _edge_save(text, out_path, voice, rate, volume, pitch):
    import edge_tts
    comm = edge_tts.Communicate(text, voice, rate=rate, volume=volume, pitch=pitch)
    await comm.save(str(out_path))


def synth_edge(text, out_path, voice=None, rate=None, volume=None, pitch=None):
    voice = voice or default_voice("edge")
    asyncio.run(_edge_save(
        text, out_path, voice,
        rate or DEFAULT_RATE, volume or DEFAULT_VOLUME, pitch or DEFAULT_PITCH,
    ))
    return voice


async def _edge_voices():
    import edge_tts
    out = []
    for v in await edge_tts.list_voices():
        out.append({
            "name": v.get("ShortName", ""),
            "gender": v.get("Gender", ""),
            "locale": v.get("Locale", ""),
            "friendly": v.get("FriendlyName", ""),
        })
    return out


# ── sapi：Windows 自带离线语音 ───────────────────────────────────────────
def _sapi_pick(sp, want):
    want = str(want or "").lower()
    voices = list(sp.GetVoices())
    if want:
        for v in voices:
            if want in v.GetDescription().lower():
                return v
    # 兜底：第一个中文音色，再不行就第一个
    for v in voices:
        d = v.GetDescription().lower()
        if "chinese" in d or "zh-cn" in d or "huihui" in d or "yaoyao" in d:
            return v
    return voices[0] if voices else None


def _sapi_rate(rate):
    raw = str(rate if rate is not None else DEFAULT_SAPI_RATE).strip()
    m = re.search(r"-?\d+", raw)
    if not m:
        return 0
    return max(-10, min(10, int(m.group(0))))


def synth_sapi(text, out_path, voice=None, rate=None, **_ignored):
    import win32com.client
    sp = win32com.client.Dispatch("SAPI.SpVoice")
    chosen = _sapi_pick(sp, voice or default_voice("sapi"))
    if chosen is not None:
        sp.Voice = chosen
    sp.Rate = _sapi_rate(rate)
    stream = win32com.client.Dispatch("SAPI.SpFileStream")
    stream.Open(str(out_path), 3, False)   # 3 = SSFMCreateForWrite
    sp.AudioOutputStream = stream
    try:
        sp.Speak(text)
    finally:
        stream.Close()
    return chosen.GetDescription() if chosen is not None else ""


def list_sapi_voices():
    import win32com.client
    sp = win32com.client.Dispatch("SAPI.SpVoice")
    return [{"name": v.GetDescription(), "gender": "", "locale": "", "friendly": ""} for v in sp.GetVoices()]


ENGINES = {"edge": synth_edge, "sapi": synth_sapi}
EXT_BY_ENGINE = {"edge": ".mp3", "sapi": ".wav"}


def synth(text, out_path, engine=None, **kw):
    eng = str(engine or DEFAULT_ENGINE).lower()
    fn = ENGINES.get(eng)
    if fn is None:
        raise ValueError(f"未知引擎：{eng}（可选 {', '.join(ENGINES)}）")
    return fn(text, out_path, **kw)


def list_voices(engine=None):
    eng = str(engine or DEFAULT_ENGINE).lower()
    if eng == "edge":
        return asyncio.run(_edge_voices())
    if eng == "sapi":
        return list_sapi_voices()
    raise ValueError(f"未知引擎：{eng}")


def default_out(engine=None):
    eng = str(engine or DEFAULT_ENGINE).lower()
    ext = EXT_BY_ENGINE.get(eng, ".mp3")
    return Path(tempfile.gettempdir()) / f"tts-{int(time.time() * 1000)}{ext}"


def main():
    ap = argparse.ArgumentParser(description="把文字念成一段音频（本机 TTS）")
    ap.add_argument("text", nargs="?", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--engine", default=DEFAULT_ENGINE)
    ap.add_argument("--voice", default="")
    ap.add_argument("--rate", default="")
    ap.add_argument("--volume", default="")
    ap.add_argument("--pitch", default="")
    ap.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS)
    ap.add_argument("--list", action="store_true", help="列出可用音色")
    ap.add_argument("--repeat", type=int, default=1, help="重复念同一段（量边际耗时）")
    args = ap.parse_args()

    try:
        if args.list:
            emit({"ok": True, "engine": args.engine, "voices": list_voices(args.engine)})
            return 0

        text = clean_text(args.text, args.max_chars)
        if not text:
            emit({"ok": False, "error": "没有要念的文字"})
            return 2

        out = Path(args.out) if args.out else default_out(args.engine)
        out.parent.mkdir(parents=True, exist_ok=True)

        runs = []
        used = ""
        for _ in range(max(1, args.repeat)):
            t0 = time.time()
            used = synth(text, out, engine=args.engine, voice=args.voice or None,
                         rate=args.rate or None, volume=args.volume or None,
                         pitch=args.pitch or None)
            runs.append(int((time.time() - t0) * 1000))

        if not out.exists() or out.stat().st_size == 0:
            emit({"ok": False, "error": "合成结果是空文件"})
            return 3
        emit({
            "ok": True,
            "path": str(out),
            "bytes": out.stat().st_size,
            "engine": args.engine,
            "voice": used,
            "chars": len(text),
            "elapsed_ms": runs[-1],
            "runs_ms": runs,
        })
        return 0
    except Exception as exc:   # noqa: BLE001
        emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return 1


if __name__ == "__main__":
    sys.exit(main())

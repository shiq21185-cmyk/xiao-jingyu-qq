#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""常驻转写工作进程：模型只加载一次，之后每段语音只花零点几秒。

为什么要有它：`transcribe.py` 每次现起一个进程，模型加载约 3.5 秒，
而 QQ 语音往往只有几秒——真正转写 0.6 秒，等模型 3.5 秒不划算。
这个进程用行分隔的 JSON 通信（一行一个请求／一行一个回复），
桥接那边只要保持 stdin/stdout 两条管道即可。

协议：
    请求（stdin，一行一个 JSON 对象）
        {"id": 1, "wav": "D:\\...\\a.wav", "language": "zh"}
        {"id": 2, "b64": "<base64 wav 字节>", "language": "zh"}
        {"id": 3, "ping": true}
        {"id": 4, "shutdown": true}
    回复（stdout，一行一个 JSON 对象）
        {"id": 1, "ok": true, "text": "...", "elapsed_ms": 612,
         "language": "zh", "duration_seconds": 5.2}
        {"id": 2, "ok": false, "error": "..."}
        {"id": 0, "ready": true, "model": "small", "device": "cuda"}

日志一律走 stderr，stdout 只留协议数据。
"""
from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

MODEL_DIR = Path(os.environ.get("ASR_MODEL_DIR", str(Path(__file__).resolve().parent / "models")))


def log(message: str) -> None:
    print(f"[asr-worker] {message}", file=sys.stderr, flush=True)


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


# --------------------------------------------------------------------- 繁 → 简

# 实现只有一份，在 transcribe.py：一次性 CLI 与这个常驻 worker 共用同一套
# 「哪个繁体字该转成哪个简体字」，免得两处各维护一份词表。
import transcribe as T  # noqa: E402  （上面已经把本目录插进 sys.path）

INITIAL_PROMPT = T.INITIAL_PROMPT
T2S_ENABLED = T.T2S_ENABLED


def to_simplified(text: str) -> str:
    return T.to_simplified(text)


def load_model():
    T._add_cuda_dll_dirs()
    from faster_whisper import WhisperModel

    name = os.environ.get("ASR_MODEL", "small")
    log(T.prefer_local_model(name, MODEL_DIR))
    # 本地有这份模型就直接给快照路径 —— 否则 huggingface_hub 会建 HTTP client，
    # 撞上 Windows 注册表里带 `[::1]` 的代理例外表，报 Invalid port（见 T.local_snapshot）
    resolved = T.local_snapshot(name, MODEL_DIR) or name
    want = os.environ.get("ASR_DEVICE", "auto")
    device, compute = "cpu", "int8"
    if want in ("auto", "cuda"):
        try:
            import ctranslate2

            if ctranslate2.get_cuda_device_count() > 0:
                device, compute = "cuda", "float16"
        except Exception as exc:
            log(f"cuda 不可用，走 CPU：{exc}")
    started = time.time()
    try:
        if resolved != name:
            log(f"用本地快照：{resolved}")
        model = WhisperModel(resolved, device=device, compute_type=compute, download_root=str(MODEL_DIR))
    except Exception as exc:
        if device == "cuda":
            log(f"cuda 加载失败，退回 CPU：{exc}")
            device, compute = "cpu", "int8"
            model = WhisperModel(resolved, device=device, compute_type=compute, download_root=str(MODEL_DIR))
        else:
            raise
    log(f"模型就绪：{name} / {device} / {compute}，加载耗时 {int((time.time() - started) * 1000)}ms")
    if T2S_ENABLED:
        # 在这里就把 opencc 的词表读进来：第一句话不该为它多等几十毫秒。
        ok_t2s, why_t2s = T.warmup_t2s()
        log(f"繁→简：{why_t2s}")
        if not ok_t2s:
            log("（转写照常，只是不转简体；想彻底关掉提示可设 ASR_T2S=0）")
    return model, name, device


def main() -> int:
    try:
        model, name, device = load_model()
    except Exception as exc:
        emit({"id": 0, "ready": False, "error": f"加载模型失败：{exc}"})
        return 1
    emit({"id": 0, "ready": True, "model": name, "device": device})

    beam = int(os.environ.get("ASR_BEAM", "5"))
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:
            emit({"id": None, "ok": False, "error": f"请求不是合法 JSON：{exc}"})
            continue

        if req.get("shutdown"):
            log("收到 shutdown，退出")
            return 0
        if req.get("ping"):
            emit({"id": req.get("id"), "ok": True, "pong": True})
            continue

        rid = req.get("id")
        language = req.get("language") or os.environ.get("ASR_LANGUAGE", "zh")
        tmp_path = None
        try:
            if req.get("b64"):
                raw = base64.b64decode(req["b64"])
                tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
                tmp.write(raw)
                tmp.close()
                tmp_path = tmp.name
                source = tmp_path
            else:
                source = str(req.get("wav") or "")
                if not source or not Path(source).is_file():
                    raise FileNotFoundError(f"音频文件不存在：{source}")

            started = time.time()
            want_t2s = T2S_ENABLED and req.get("t2s", True) is not False
            # 请求里给了 initial_prompt 就用它；给空串＝这一句不要提示（调试/对拍用）。
            prompt = req.get("initial_prompt")
            if prompt is None:
                prompt = INITIAL_PROMPT
            prompt = (prompt or "").strip() or None
            segments, info = model.transcribe(
                source,
                language=language or None,
                beam_size=beam,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 400},
                condition_on_previous_text=False,
                initial_prompt=prompt,
            )
            text = "".join((seg.text or "").strip() for seg in segments).strip()
            raw = text
            if want_t2s:
                text = to_simplified(text)
            emit(
                {
                    "id": rid,
                    "ok": True,
                    "text": text,
                    "language": getattr(info, "language", None),
                    "duration_seconds": round(float(getattr(info, "duration", 0.0) or 0.0), 2),
                    "elapsed_ms": int((time.time() - started) * 1000),
                    "device": device,
                    "t2s": want_t2s,
                    "t2s_changed": bool(want_t2s and text != raw),
                }
            )
        except Exception as exc:
            emit({"id": rid, "ok": False, "error": f"{type(exc).__name__}: {exc}"})
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass
    return 0


if __name__ == "__main__":
    sys.exit(main())

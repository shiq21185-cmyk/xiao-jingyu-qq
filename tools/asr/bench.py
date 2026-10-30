#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""量一下：模型加载多久、热起来之后每段音频转写多久。

用途：决定桥接那边是"每条语音现起一个 python"还是"常驻一个热进程"。
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import transcribe as T  # noqa: E402

T._add_cuda_dll_dirs()
from faster_whisper import WhisperModel  # noqa: E402

wav = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).parent / "samples" / "sample-zh.wav")
model_dir = str(Path(__file__).parent / "models")

t0 = time.time()
model = WhisperModel("small", device="cuda", compute_type="float16", download_root=model_dir)
load_ms = int((time.time() - t0) * 1000)

results = []
for i in range(3):
    t1 = time.time()
    segments, info = model.transcribe(wav, language="zh", beam_size=5, vad_filter=True, condition_on_previous_text=False)
    text = "".join((s.text or "").strip() for s in segments)
    results.append({"run": i + 1, "ms": int((time.time() - t1) * 1000), "chars": len(text)})

print(json.dumps({"load_ms": load_ms, "audio_seconds": round(info.duration, 2), "runs": results}, ensure_ascii=False))

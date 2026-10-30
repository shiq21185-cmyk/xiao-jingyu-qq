#!/usr/bin/env python
"""常驻语音合成（TTS）worker：行分隔 JSON 协议，与 worker.py（ASR）同构。

为什么要常驻：edge 引擎每次冷启一个 python 进程要 4 秒左右，而真正的合成本身
只有几百毫秒。她说话是「发出去就要被听到」的东西，4 秒太钝；常驻之后每次
合成只花网络那一下。

请求（每行一个 JSON）：
  {"id":1,"text":"要说的话","out":"D:/tmp/a.mp3","voice":"...","rate":"+0%"}
  {"id":2,"listVoices":true}
  {"id":3,"ping":true}
  {"id":4,"shutdown":true}
回复：
  {"id":0,"ready":true,"engine":"edge","voice":"zh-CN-XiaoyiNeural"}   ← 启动完成
  {"id":1,"ok":true,"path":"...","bytes":12345,"voice":"...","elapsed_ms":800}
  {"id":1,"ok":false,"error":"..."}
  就绪失败时：{"id":0,"ready":false,"engine":"edge","error":"..."} 然后退出 1

日志全部走 stderr。任何一次合成都不会让进程退出。
"""
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tts as T  # noqa: E402

ENGINE = os.environ.get("TTS_ENGINE", T.DEFAULT_ENGINE)


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def warm():
    """提前 import，把「依赖没装」这种错在启动时就暴露出来，别等到要说话才发现。"""
    eng = str(ENGINE).lower()
    if eng == "edge":
        import edge_tts  # noqa: F401
    elif eng == "sapi":
        import win32com.client  # noqa: F401


def main():
    try:
        warm()
    except Exception as exc:   # noqa: BLE001
        emit({"id": 0, "ready": False, "engine": ENGINE, "error": f"{type(exc).__name__}: {exc}"})
        return 1

    voice = T.default_voice(ENGINE)
    emit({"id": 0, "ready": True, "engine": ENGINE, "voice": voice})
    log(f"TTS worker 就绪：engine={ENGINE} voice={voice}")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:   # noqa: BLE001
            log(f"忽略无法解析的一行：{exc}")
            continue

        rid = req.get("id")
        if req.get("shutdown"):
            emit({"id": rid, "ok": True, "bye": True})
            return 0
        if req.get("ping"):
            emit({"id": rid, "ok": True, "pong": True})
            continue
        if req.get("listVoices"):
            try:
                emit({"id": rid, "ok": True, "voices": T.list_voices(req.get("engine") or ENGINE)})
            except Exception as exc:   # noqa: BLE001
                emit({"id": rid, "ok": False, "error": f"{type(exc).__name__}: {exc}"})
            continue

        engine = req.get("engine") or ENGINE
        text = T.clean_text(req.get("text"), int(req.get("maxChars") or T.DEFAULT_MAX_CHARS))
        if not text:
            emit({"id": rid, "ok": False, "error": "没有要念的文字"})
            continue

        out = Path(req["out"]) if req.get("out") else T.default_out(engine)
        try:
            out.parent.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass

        t0 = time.time()
        try:
            used = T.synth(text, out, engine=engine, voice=req.get("voice") or None,
                           rate=req.get("rate") or None, volume=req.get("volume") or None,
                           pitch=req.get("pitch") or None)
            size = out.stat().st_size if out.exists() else 0
            if size <= 0:
                raise RuntimeError("合成结果是空文件")
            emit({
                "id": rid, "ok": True, "path": str(out), "bytes": size,
                "engine": engine, "voice": used, "chars": len(text),
                "elapsed_ms": int((time.time() - t0) * 1000),
            })
        except Exception as exc:   # noqa: BLE001
            # 失败时别留半截文件：SnowLuma 会把 0 字节当成坏音频
            try:
                if out.exists() and out.stat().st_size == 0:
                    out.unlink()
            except Exception:
                pass
            emit({"id": rid, "ok": False, "error": f"{type(exc).__name__}: {exc}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""本地语音转文字（faster-whisper）。

用法：
    python transcribe.py <音频文件> [--model small] [--language zh] [--json]
    python transcribe.py --stdin-wav < 文件.wav

设计约束（照《进阶篇》进阶 3）：
- **完全本地**：模型从本地目录加载，音频不出这台机器。
- 出错时退出码非 0，并往 stderr 写一句人话（桥接那边照抄给日志）。
- stdout 只输出一行 JSON，方便桥接解析。

为什么是 faster-whisper：CTranslate2 实现，RTX 4060 上 fp16/int8 都够快，
中文识别质量与 openai-whisper 一致但快数倍、内存占用低得多。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

# 模型缓存目录（与脚本同级的 models/），避免默认写进用户目录、
# 也方便整个 asr 目录一起删掉重来。
_HERE = Path(__file__).resolve().parent
DEFAULT_MODEL_DIR = _HERE / "models"

# os.add_dll_directory() 返回的句柄必须一直活着，否则目录会在对象被回收时立刻从
# DLL 搜索路径里撤掉（官方文档里明写的坑）——所以这里留一个模块级列表挂住它们。
_DLL_DIR_HANDLES: list = []


def _add_cuda_dll_dirs() -> None:
    """把 pip 装的 CUDA 运行库目录挂进 DLL 搜索路径。

    为什么需要：CTranslate2 的 Windows 轮子不自带 cublas64_12.dll / cudnn，
    靠 pip 的 nvidia-*-cu12 包提供；那些 DLL 在 site-packages/nvidia/<lib>/bin 里，
    不在 PATH 上，ctranslate2 加载时会报 "Library cublas64_12.dll is not found"。
    """
    if os.name != "nt":
        return
    dirs: list[str] = []
    try:
        import site
        import sysconfig

        roots = []
        try:
            roots.extend(site.getsitepackages())
        except Exception:
            pass
        try:
            roots.append(sysconfig.get_paths().get("purelib") or "")
        except Exception:
            pass
        for root in {r for r in roots if r}:
            nvidia = Path(root) / "nvidia"
            if not nvidia.is_dir():
                continue
            for lib in nvidia.iterdir():
                for sub in ("bin", "lib"):
                    d = lib / sub
                    if d.is_dir():
                        dirs.append(str(d))
    except Exception:
        pass

    if not dirs:
        return

    # 两条路都走：add_dll_directory 给 LoadLibraryEx 用，PATH 给别的加载方式兜底。
    if hasattr(os, "add_dll_directory"):
        for d in dirs:
            try:
                _DLL_DIR_HANDLES.append(os.add_dll_directory(d))
            except Exception:
                pass
    os.environ["PATH"] = os.pathsep.join(dirs + [os.environ.get("PATH", "")])


def _fail(message: str, code: int = 2):
    print(message, file=sys.stderr, flush=True)
    json.dump({"ok": False, "error": message}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()
    sys.exit(code)


# --------------------------------------------------------------------- 繁 → 简

# Whisper 对普通话经常吐繁体（它的中文训练语料里繁体占比不低），通话里读出来很别扭。
# 两道都不花时间，所以两道都上：
#   ① initial_prompt —— 只往解码器前面喂几个 token，不换模型、不增加解码轮数；它只是
#      **倾向**，不保证；
#   ② 结果过一次 opencc 的 t2s 词表 —— 实测 <1ms，只作用在**最终文本**上，不碰解码。
#      （tools/asr/.venv 里已经有 opencc，见 requirements.txt）
# 关掉：环境变量 ASR_T2S=0 / 命令行 --no-t2s / 请求里带 "t2s": false。
INITIAL_PROMPT = os.environ.get("ASR_INITIAL_PROMPT", "以下是普通话的句子。")
T2S_ENABLED = os.environ.get("ASR_T2S", "1").strip().lower() not in ("0", "false", "no", "off")

_t2s = None
_t2s_ready = False


def warmup_t2s() -> tuple[bool, str]:
    """把词表读进来（跑一次就够）。返回 (可用?, 说明文字)。

    为什么单独一个函数：worker.py 在模型加载完后调它一次，这样**第一句话**不用
    临时等词表；而且 opencc 没装时只在这里报一声，转写照常跑。
    """
    global _t2s, _t2s_ready
    if _t2s_ready:
        return _t2s is not None, "opencc t2s" if _t2s is not None else "未启用"
    _t2s_ready = True
    t = time.time()
    try:
        import opencc

        _t2s = opencc.OpenCC("t2s")
        return True, f"opencc t2s（词表加载 {int((time.time() - t) * 1000)}ms）"
    except Exception as exc:  # noqa: BLE001
        _t2s = None
        return False, f"没装 opencc，繁体不转简体（{exc}）"


def to_simplified(text: str) -> str:
    """繁 → 简。失败就原样返回 —— 转写本身绝不能因为它挂掉。"""
    if not text:
        return text
    if not _t2s_ready:
        warmup_t2s()
    if _t2s is None:
        return text
    try:
        return _t2s.convert(text)
    except Exception:  # noqa: BLE001
        return text


def prefer_local_model(model: str, model_dir: Path | None = None) -> str:
    """模型已经在本地时切成离线加载。

    faster-whisper 每次构造 WhisperModel 都会去 huggingface.co 问一次版本；
    这台机器连不上，于是**干等 20 秒**才退回本地缓存（实测 small 从 22.5s 降到 1.7s）。
    只在本地确实有该模型的缓存目录时才切，所以以后第一次下新模型不受影响。
    返回一句给日志用的说明。
    """
    if os.environ.get("HF_HUB_OFFLINE"):
        return "HF_HUB_OFFLINE 已由外部设置，保持离线"
    root = Path(model_dir) if model_dir else DEFAULT_MODEL_DIR
    cache = root / f"models--Systran--faster-whisper-{model}"
    if not cache.is_dir():
        return f"本地还没有 {model}，保持联网（首次会下载）"
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    return f"本地已有 {model}，已切离线加载"


def local_snapshot(model: str, model_dir: Path | None = None) -> str | None:
    """本地已有这份模型时，返回快照目录的绝对路径，否则 None。

    为什么非要给路径：`WhisperModel(名字, download_root=...)` 会让 huggingface_hub
    去问一次仓库（即使 HF_HUB_OFFLINE=1，它也**先建一个 HTTP client**）。
    而 Windows 注册表里的代理例外表（FlClash 之类的系统代理会写 ProxyOverride，
    里面带 `[::1]`）会被 httpx 当成 URL 解析，直接抛
        InvalidURL: Invalid port: ':1]'
    —— 表现就是「加载模型失败」，整套 ASR 不可用（2026-10-30 实测踩到）。
    传快照目录进去就完全不碰 hub：同一份缓存，传 "small" 报错，传目录 1.5 秒就绪。
    """
    name = (model or "").strip()
    if not name:
        return None
    if os.path.isdir(name):
        return name
    root = Path(model_dir) if model_dir else DEFAULT_MODEL_DIR
    base = root / f"models--Systran--faster-whisper-{name}"
    snaps = base / "snapshots"
    if not snaps.is_dir():
        return None
    ref = base / "refs" / "main"
    if ref.is_file():
        try:
            want = ref.read_text(encoding="utf-8").strip()
        except OSError:
            want = ""
        if want and (snaps / want).is_dir():
            return str(snaps / want)
    cands = sorted(x for x in snaps.iterdir() if x.is_dir())
    return str(cands[-1]) if cands else None


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("audio", nargs="?", help="音频文件路径")
    ap.add_argument("--stdin-wav", action="store_true", help="从 stdin 读 wav 字节")
    ap.add_argument("--model", default=os.environ.get("ASR_MODEL", "small"))
    ap.add_argument("--language", default=os.environ.get("ASR_LANGUAGE", "zh"))
    ap.add_argument("--model-dir", default=os.environ.get("ASR_MODEL_DIR", str(DEFAULT_MODEL_DIR)))
    ap.add_argument("--beam-size", type=int, default=5)
    ap.add_argument("--device", default=os.environ.get("ASR_DEVICE", "auto"), choices=["auto", "cuda", "cpu"])
    ap.add_argument("--initial-prompt", default=INITIAL_PROMPT, help="解码前的倾向文本（默认引导用简体）")
    ap.add_argument("--no-t2s", action="store_true", help="不做繁→简转换（默认做）")
    args = ap.parse_args()

    if not args.stdin_wav and not args.audio:
        _fail("没有给音频：要么给一个文件路径，要么加 --stdin-wav 从标准输入读")

    started = time.time()

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # pragma: no cover - 环境缺依赖时
        _fail(f"没有装 faster-whisper（{exc}）；在这个目录跑：.venv\\Scripts\\python.exe -m pip install faster-whisper -i https://pypi.tuna.tsinghua.edu.cn/simple")

    model_dir = Path(args.model_dir)
    model_dir.mkdir(parents=True, exist_ok=True)
    print(f"  {prefer_local_model(args.model, model_dir)}")

    device = args.device
    compute_type = "int8"
    if device in ("auto", "cuda"):
        _add_cuda_dll_dirs()
        try:
            import ctranslate2

            if ctranslate2.get_cuda_device_count() > 0:
                device = "cuda"
                compute_type = "float16"
            else:
                device = "cpu"
        except Exception:
            device = "cpu"

    # 本地有的话直接给路径，别让 huggingface_hub 去建 HTTP client（见 local_snapshot）
    model_ref = local_snapshot(args.model, model_dir) or args.model
    try:
        model = WhisperModel(model_ref, device=device, compute_type=compute_type, download_root=str(model_dir))
    except Exception as exc:
        if device == "cuda":
            # 显卡那条路挂了（缺 DLL、显存被占满等）不能让她听不见你说话：
            # 退回 CPU int8，慢一点但一定能出字。
            print(f"[asr] cuda 加载失败，退回 CPU：{exc}", file=sys.stderr, flush=True)
            device = "cpu"
            compute_type = "int8"
            try:
                model = WhisperModel(model_ref, device=device, compute_type=compute_type, download_root=str(model_dir))
            except Exception as exc2:
                _fail(f"加载模型失败（{args.model} / {device}）：{exc2}")
        else:
            _fail(f"加载模型失败（{args.model} / {device}）：{exc}")

    if args.stdin_wav:
        import tempfile

        raw = sys.stdin.buffer.read()
        if not raw:
            _fail("标准输入里没有音频数据")
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        try:
            tmp.write(raw)
            tmp.close()
            source = tmp.name
        except Exception as exc:
            _fail(f"写临时文件失败：{exc}")
    else:
        source = args.audio
        if not Path(source).is_file():
            _fail(f"音频文件不存在：{source}")

    want_t2s = T2S_ENABLED and not args.no_t2s
    if want_t2s:
        ok_t2s, why_t2s = warmup_t2s()
        print(f"[asr] 繁→简：{why_t2s}", file=sys.stderr, flush=True)
        want_t2s = ok_t2s
    try:
        segments, info = model.transcribe(
            source,
            language=args.language or None,
            beam_size=args.beam_size,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
            condition_on_previous_text=False,
            initial_prompt=args.initial_prompt or None,
        )
        pieces = []
        for seg in segments:
            text = (seg.text or "").strip()
            if text:
                pieces.append(text)
    except Exception as exc:
        _fail(f"转写失败：{exc}")
    finally:
        if args.stdin_wav:
            try:
                os.unlink(source)
            except Exception:
                pass

    text = "".join(pieces).strip()
    raw_text = text
    if want_t2s:
        text = to_simplified(text)
    payload = {
        "ok": True,
        "text": text,
        "language": getattr(info, "language", None),
        "language_probability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 3),
        "duration_seconds": round(float(getattr(info, "duration", 0.0) or 0.0), 2),
        "model": args.model,
        "device": device,
        "elapsed_ms": int((time.time() - started) * 1000),
        "t2s": want_t2s,
        "t2s_changed": bool(want_t2s and text != raw_text),
    }
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())

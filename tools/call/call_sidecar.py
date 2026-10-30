# -*- coding: utf-8 -*-
"""call_sidecar：小鲸鱼接打 QQ 语音电话的实时引擎（进程内常驻）。

分工（这是整个档 2 方案的心脏）：
    QQ 有头客户端  ←—— SnowLuma ——→  QQ 好友
       ↑ 截图/点击（call_state.py）      ↑ 声音
       │                                 │
   本文件：听（环回采集→VAD→ASR）  说（文字→TTS→虚拟声卡→QQ 麦克风）

为什么不用「虚拟摄像头 + 实时音色」：那套要 GPU，本机没有。这里一条音色都不换，
就是小鲸鱼自己已有的 edge-tts（zh-CN-XiaoyiNeural），所以声音是主人熟悉的那一个。

数据流：
    对方说话 → QQ 播到扬声器 → WASAPI 环回采集 → VAD 切句 → ASR → 文本
    → brain（默认走 bridge/DSH，回一段话）→ TTS 合成 → 解码成 PCM
    → 播到「虚拟声卡输出」→ QQ 从「虚拟声卡麦克风」读到 → 传给对方

分档可用性（缺件时**明确降级并报出来**，绝不假装成功）：
    没 VB-CABLE  → 只听得见、说不出（TTS 那段播到默认扬声器让你自己听）
    没 bridge    → 用离线占位脑（回一句固定话），仅用于链路自测

用法：
    python tools/call/call_sidecar.py --selftest     # 全链路自测（不需要真打电话）
    python tools/call/call_sidecar.py --serve        # 起常驻服务
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import queue
import sys
import threading
import time
import wave
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import call_audio as ca  # noqa: E402
import call_state as cs  # noqa: E402
import retention  # noqa: E402  （按年龄+总量清旧录音/逐字稿，见 retention.py）

REPO = HERE.parent.parent
ASR_DIR = REPO / "tools" / "asr"
PYTHON = str(ASR_DIR / ".venv" / "Scripts" / "python.exe")
ASR_WORKER = str(ASR_DIR / "worker.py")
TTS_WORKER = str(ASR_DIR / "tts_worker.py")
SPOOL = REPO / "audio" / "call"
LOGS = REPO / "tools" / "call" / "logs"

# 通话声音的落点。主人 2026-10-25 要求「录音放在一个我能够看到的地方」，
# 2026-10-29 又定死「放到 qqbot 里面」——所以固定落在 QQ bot 根目录下的
# `小鲸鱼的语音/` 里，跟 SnowLuma-lite、qq-bridge-deploy、小鲸鱼出图、
# 小鲸鱼下载 并排，资源管理器里一眼能看见。
VOICE_DIR = REPO.parent / "小鲸鱼的语音"
# 录音（整通电话一个 wav）。可用 --rec-dir 覆盖。
# ⚠️ 目录建不出来时**必须回落 SPOOL**：录音失败会让整通电话失去复盘依据，
# 而目录权限/OneDrive 占位这类问题不该毁掉通话本身。
REC_DIR = VOICE_DIR / "通话录音"
# 通话逐字稿（每通电话一份 JSON）。这是「通话摘要」的唯一素材来源：
# 整理插件（qq-memory-rollover）第二天会读这里，把电话内容提炼进长期记忆。
# 之所以由 sidecar 落盘而不是直接写 daily-memory.json：那个文件归整理脚本独写，
# 两个进程同时写必然互相覆盖。
# 2026-10-29 从仓库内 `state/call-logs/` 搬到主人看得见的地方（跟录音并排）；
# 整理插件改成读同一份配置（config.json 的 call.transcriptDir），两边不会走岔。
TRANSCRIPT_DIR = VOICE_DIR / "通话逐字稿"
CALL_LOG_DIR = TRANSCRIPT_DIR

# 自动清理的两个阈值（主人 2026-10-29 选「30 天 + 总量 1 GB 双闸」）。
# 录音与逐字稿是**成果**，值得留，但不该无限堆着：过了 keep_days 天就删；
# 目录超过 keep_mb 时从最旧的开始删（防止某段时间打得特别多）。
# 都能从 config.json 的 call.recKeepDays / call.recKeepMB 改，不必动代码。
KEEP_DAYS = 30.0
KEEP_MB = 1024.0


def sweep_retention(rec_dir: Path | None = None, keep_days: float | None = None,
                    keep_mb: float | None = None) -> None:
    """按「年龄 + 总量」双闸清旧的录音与逐字稿（主人 2026-10-29 定的规矩）。

    录音与逐字稿是**成果**：留着有用，但不该越积越多 —— 超过 keep_days 天删，
    目录超过 keep_mb 时从最旧的开始删。真正的删除逻辑在 `retention.py` 里，
    那样它才能被单独测（`python tools/call/retention.py --selftest`）——
    这段代码会真的删主人的东西，不能被"看起来对"糊弄过去。

    和 `sweep_spool()` 的分工：那个清**内部产物**（say-*.mp3，播完就没用了），
    这个清**成果的存量**。两个都在同一批安全时机跑：引擎启动、挂断之后。

    清不动（文件被占用、权限）只会记一行日志：删不掉旧录音绝不该让通话打不了。
    """
    kd = KEEP_DAYS if keep_days is None else keep_days
    kmb = KEEP_MB if keep_mb is None else keep_mb
    targets = [(Path(rec_dir), "call-*.wav", "录音")] if rec_dir else []
    targets.append((CALL_LOG_DIR, "call-*.json", "逐字稿"))
    try:
        total = retention.sweep_many(targets, keep_days=kd, keep_mb=kmb, log=log)
    except Exception as exc:  # noqa: BLE001
        log(f"⚠️ 自动清理失败（不影响通话）：{type(exc).__name__}: {exc}")
        return
    for part in total.get("parts", []):
        if part["deleted"]:
            log(f"🧹 {part['what']}自动清理：删 {len(part['deleted'])} 个"
                f"（{part['freed_bytes'] / 1048576:.1f} MB），留 {part['kept']} 个"
                f" / 剩 {part['bytes_left'] / 1048576:.1f} MB")


def sweep_spool(keep: Path | None = None) -> int:
    """清掉通话留下的临时合成音频（SPOOL/say-*.mp3）。

    为什么要有它：通话里每说一句就是「合成一个 mp3 → 播出去」，而这些文件
    以前**从不删** —— 只有录音和逐字稿被认为值得留。一通电话十几句，跑得多了
    SPOOL 里就是几百个没人会看的小文件。主人 2026-10-29 说「避免越积越多」。

    为什么可以放心清：这一族是**内部产物**，真正要留的东西（录音 wav、逐字稿
    json）都不在这个目录里。

    只在安全时机调：引擎启动时、以及挂断之后（此时没人正在播）。
    keep 用来保护"这一次正在用的那个文件"；被别的进程占用的文件删不掉，
    会走 OSError 分支跳过（Windows 上"正在播放"就是这个表现）。
    """
    n = 0
    try:
        for f in SPOOL.glob("say-*.mp3"):
            if keep is not None and f == keep:
                continue
            try:
                f.unlink()
                n += 1
            except OSError:
                pass
    except OSError:
        pass
    return n

VAD_THRESH = -45.0          # dBFS
VAD_HANG = 0.9              # 静音多久算一句说完
VAD_MIN_SPEECH = 0.45       # 短于这个不当一句
MAX_UTTER = 20.0            # 一句话最长 20 秒，免得对方一直说不切成段


def log(msg: str) -> None:
    line = f"[{datetime.now():%H:%M:%S}] {msg}"
    try:
        print(line, flush=True)
    except (UnicodeEncodeError, ValueError):
        # 控制台还是 GBK（main 里 _fix_stdio 之前，或被别的入口直接 import 时）：
        # 不能让一行日志把业务逻辑连带崩掉 —— 降级成 ASCII 转义再打一次。
        try:
            print(line.encode("ascii", "backslashreplace").decode("ascii"), flush=True)
        except Exception:  # noqa: BLE001
            pass


def _fix_stdio() -> None:
    """Windows 控制台默认 GBK，日志里的 emoji/中文会 UnicodeEncodeError 直接崩。

    必须在任何 log() 之前跑；redirect 到文件时同样适用。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass


# --------------------------------------------------------------------------- 解码 / 编码音频

def decode_audio(path: str | Path) -> tuple[np.ndarray, int]:
    """把 mp3/wav 解码成 (mono float32, samplerate)。用 PyAV，venv 里已有。"""
    import av

    frames: list[np.ndarray] = []
    sr = 48000
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        sr = stream.rate or 48000
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=sr)
        for frame in container.decode(stream):
            for rf in resampler.resample(frame):
                arr = rf.to_ndarray()          # shape (1, samples) for mono fltp
                frames.append(arr.reshape(-1).astype(np.float32))
        for rf in resampler.resample(None):
            frames.append(rf.to_ndarray().reshape(-1).astype(np.float32))
    if not frames:
        return np.zeros(0, dtype=np.float32), sr
    return np.concatenate(frames), sr


def pcm_to_wav_bytes(pcm: np.ndarray, sr: int) -> bytes:
    """float32 mono → 16-bit PCM wav 字节（ASR worker 吃这个）。"""
    pcm = np.clip(pcm, -1.0, 1.0)
    ints = (pcm * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(ints.tobytes())
    return buf.getvalue()


# --------------------------------------------------------------------------- ASR worker

class AsrClient:
    """常驻 ASR 子进程（协议见 tools/asr/worker.py）。模型只加载一次。"""

    def __init__(self) -> None:
        self.child = None
        self.seq = 0
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.outq: queue.Queue = queue.Queue()
        self.err: str | None = None
        self.device: str | None = None

    def start(self, timeout: float = 240.0) -> bool:
        import subprocess

        env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        env.setdefault("ASR_MODEL", "small")
        env.setdefault("ASR_MODEL_DIR", str(ASR_DIR / "models"))
        self.child = subprocess.Popen(
            [PYTHON, ASR_WORKER], cwd=str(ASR_DIR), env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", bufsize=1,
        )

        def _reader():
            for line in self.child.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except Exception:  # noqa: BLE001
                    continue
                if msg.get("id") == 0:
                    if msg.get("ready"):
                        self.device = msg.get("device")
                        self.ready.set()
                    else:
                        self.err = msg.get("error") or "worker 启动失败"
                        self.ready.set()
                    continue
                self.outq.put(msg)

        def _errs():
            for line in self.child.stderr:
                s = line.strip()
                if s:
                    log(f"  [asr] {s[:160]}")

        threading.Thread(target=_reader, daemon=True).start()
        threading.Thread(target=_errs, daemon=True).start()
        ok = self.ready.wait(timeout)
        return bool(ok and not self.err)

    def transcribe(self, pcm: np.ndarray, sr: int) -> str:
        if not self.child:
            raise RuntimeError("ASR worker 没启动")
        b64 = base64.b64encode(pcm_to_wav_bytes(pcm, sr)).decode("ascii")
        with self.lock:
            self.seq += 1
            rid = self.seq
            self.child.stdin.write(json.dumps({"id": rid, "b64": b64, "language": "zh"}) + "\n")
            self.child.stdin.flush()
            t_end = time.time() + 90
            while time.time() < t_end:
                try:
                    msg = self.outq.get(timeout=0.2)
                except queue.Empty:
                    continue
                if msg.get("id") != rid:
                    continue
                if msg.get("ok"):
                    return str(msg.get("text") or "").strip()
                raise RuntimeError(msg.get("error") or "转写失败")
        raise TimeoutError("ASR 超时")

    def stop(self) -> None:
        if not self.child:
            return
        try:
            self.child.stdin.write(json.dumps({"id": 9999, "shutdown": True}) + "\n")
            self.child.stdin.flush()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.child.wait(timeout=5)
        except Exception:  # noqa: BLE001
            self.child.kill()


# --------------------------------------------------------------------------- TTS worker

class TtsClient:
    """常驻 TTS 子进程。音色用配置里那一个（不换）。"""

    def __init__(self, voice: str | None = None, rate: str | None = None) -> None:
        self.child = None
        self.seq = 0
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.outq: queue.Queue = queue.Queue()
        self.err: str | None = None
        self.voice = voice
        self.rate = rate

    def start(self, timeout: float = 120.0) -> bool:
        import subprocess

        env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1",
               "TTS_ENGINE": "edge"}
        self.child = subprocess.Popen(
            [PYTHON, TTS_WORKER], cwd=str(ASR_DIR), env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", bufsize=1,
        )

        def _reader():
            for line in self.child.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except Exception:  # noqa: BLE001
                    continue
                if msg.get("id") == 0:
                    if msg.get("ready"):
                        self.voice = msg.get("voice") or self.voice
                        self.ready.set()
                    else:
                        self.err = msg.get("error") or "TTS 启动失败"
                        self.ready.set()
                    continue
                self.outq.put(msg)

        def _errs():
            for line in self.child.stderr:
                s = line.strip()
                if s:
                    log(f"  [tts] {s[:160]}")

        threading.Thread(target=_reader, daemon=True).start()
        threading.Thread(target=_errs, daemon=True).start()
        ok = self.ready.wait(timeout)
        return bool(ok and not self.err)

    def synthesize(self, text: str, *, out: Path | None = None,
                   timeout: float = 60.0, attempts: int = 3) -> Path:
        """合成一句话，失败重试。

        为什么必须重试：edge 是**在线**服务，偶发会返回
        `NoAudioReceived: No audio was received`（2026-10-25 实测：同一句话
        隔几分钟再发就好了，逐字不变）。这不是我们的参数错了，是那一下服务端
        没给音频。通话场景里"这一句没念出来"就是对话断了，所以要在这一层吞掉
        抖动，而不是把它抛给上层当成能力缺失。
        """
        if not self.child:
            raise RuntimeError("TTS worker 没启动")
        SPOOL.mkdir(parents=True, exist_ok=True)
        last_err: str = ""
        for attempt in range(1, max(1, attempts) + 1):
            path = out or (SPOOL / f"say-{int(time.time() * 1000)}-{attempt}.mp3")
            payload = {"text": text, "out": str(path), "engine": "edge"}
            if self.voice:
                payload["voice"] = self.voice
            if self.rate:
                payload["rate"] = self.rate
            with self.lock:
                self.seq += 1
                rid = self.seq
                self.child.stdin.write(json.dumps({"id": rid, **payload}, ensure_ascii=False) + "\n")
                self.child.stdin.flush()
                t_end = time.time() + timeout
                while time.time() < t_end:
                    try:
                        msg = self.outq.get(timeout=0.2)
                    except queue.Empty:
                        continue
                    if msg.get("id") != rid:
                        continue
                    if msg.get("ok"):
                        return Path(msg.get("path") or path)
                    last_err = str(msg.get("error") or "合成失败")
                    break
                else:
                    last_err = "TTS 超时"
            if attempt < attempts:
                delay = 0.6 * attempt
                log(f"  ↻ TTS 第 {attempt} 次失败（{last_err[:80]}），{delay:.1f}s 后重试")
                time.sleep(delay)
        raise RuntimeError(last_err or "合成失败")

    def stop(self) -> None:
        if not self.child:
            return
        try:
            self.child.stdin.write(json.dumps({"id": 9999, "shutdown": True}) + "\n")
            self.child.stdin.flush()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.child.wait(timeout=5)
        except Exception:  # noqa: BLE001
            self.child.kill()


# --------------------------------------------------------------------------- 分段器

@dataclass
class Segmenter:
    """从连续环回音频里切出「一句人话」。

    不是在找静音，是在找**语音区间的起止**：能量持续高于门限算在说话，
    静音超过 VAD_HANG 就算这句完了。太短的丢掉（咳嗽/键盘声）。
    """
    thresh_dbfs: float = VAD_THRESH
    hang: float = VAD_HANG
    min_speech: float = VAD_MIN_SPEECH
    max_utter: float = MAX_UTTER
    _in_speech: bool = False
    _started_at: float = 0.0
    _last_voice_at: float = 0.0
    _buf: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))

    def feed(self, chunk: np.ndarray, sr: int, now: float) -> np.ndarray | None:
        """喂一块音频；凑成一句就返回那句（float32），否则 None。"""
        voiced = ca.is_speech(chunk, thresh_dbfs=self.thresh_dbfs)
        if voiced:
            if not self._in_speech:
                self._in_speech = True
                self._started_at = now
                self._buf = np.zeros(0, dtype=np.float32)
            self._last_voice_at = now
            self._buf = np.concatenate([self._buf, chunk.astype(np.float32)])
            if now - self._started_at >= self.max_utter:
                return self._take()
            return None
        if self._in_speech:
            self._buf = np.concatenate([self._buf, chunk.astype(np.float32)])
            if now - self._last_voice_at >= self.hang:
                return self._take()
        return None

    def _take(self) -> np.ndarray | None:
        speech_s = self._last_voice_at - self._started_at
        buf = self._buf
        self._in_speech = False
        self._buf = np.zeros(0, dtype=np.float32)
        if speech_s < self.min_speech:
            return None
        return buf


# --------------------------------------------------------------------------- 脑（把文本变成回复）

class EchoBrain:
    """离线占位脑：只用于链路自测。不带任何人格，只回一句固定话。"""

    name = "echo"

    def reply(self, text: str, *, timeout: float = 30.0) -> str:
        log(f"  [brain:echo] 收到：{text}")
        return f"我听见了，你说的是：{text}"


class HttpBrain:
    """把一句话交给 bridge/DSH，等它这一轮的最终文本。

    走 bridge 的本地 HTTP 接口（bridge 自己会 ensureSession + prompt + 收 turn）。
    """

    name = "bridge"

    def __init__(self, url: str, key: str, token: str | None = None) -> None:
        self.url = url.rstrip("/")
        self.key = key
        # 启动时给的 key（通常为空）。每通电话开始时要回到这个值，
        # 免得上一通学到的 key 被下一通（可能是别的号打来）冒用。
        self._boot_key = key
        self.token = token

    def reply(self, text: str, *, timeout: float = 120.0) -> str:
        import urllib.error
        import urllib.request

        body = json.dumps({"key": self.key, "text": text}, ensure_ascii=False).encode()
        req = urllib.request.Request(self.url, data=body, method="POST",
                                     headers={"content-type": "application/json; charset=utf-8"})
        if self.token:
            # ⚠️ 必须用 x-console-token，**不能**用 x-agent-token。
            # sidecar 是主人这边的本机进程，不是智能体：带上 x-agent-token 会被桥接当成
            # 「AI 在调管理面」直接 403（而且 /api/call/turn 本来就不在 agent 白名单里，
            # 那个端点能读到会话全文，绝不能开给 AI）。
            req.add_header("x-console-token", self.token)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as exc:
            raise RuntimeError(f"bridge 不可达：{exc}") from exc
        if not data.get("ok"):
            raise RuntimeError(data.get("error") or "bridge 返回失败")
        # 桥接会把这轮实际绑定的会话 key 回过来（接听那一刻才知道绑给谁）。
        # 记住它，通话结束时逐字稿才能落到正确的会话名下；否则整理脚本只能按空 key 跳过。
        got = str(data.get("key") or "").strip()
        if got:
            self.key = got
        return str(data.get("reply") or "").strip()


# --------------------------------------------------------------------------- 编排

@dataclass
class CallEngine:
    """一次通话的完整编排：听 → 想 → 说。"""
    brain: object
    out_device: str | None = None      # 虚拟声卡输出（VB-CABLE 装好后是 'CABLE Input'）
    monitor: bool = True               # 没虚拟声卡时，把回复播到默认扬声器让你听见
    voice: str | None = None
    rate: str | None = None
    asr: AsrClient | None = None
    tts: TtsClient | None = None
    tap: ca.RingTap | None = None
    running: bool = False
    # 是否「在通话中」。只有接起来之后才为 True —— 否则引擎会一直听着扬声器，
    # 把歌、视频、别人在旁边说的话全当成"对方在说话"，然后对着空气回话。
    active: bool = False
    # 通话期整段录音：从接通那刻起，把环回里收到的**每一块**音频都写进一个 wav。
    # 用途只有诊断：万一「听不见对方」，事后能把那通电话原样放出来听，
    # 而不是靠猜（此前就因为没录音，把「没声」和「有声称但没识别」混在一起）。
    rec_path: Path | None = None
    rec_writer: object | None = None
    _rec_pos: int | None = None   # 录音在环形缓冲里的独立游标（不受 drain/skip 影响）
    rec_written_s: float = 0.0    # 本次录音已写入多少秒（诊断用）
    # 录音目录：None ⇒ 用 REC_DIR（主人能看见的那个文件夹）；建不出来时回落 SPOOL。
    rec_dir: Path | None = None
    rec_fell_back: bool = False   # 本次录音是否用了回落目录（诊断用）
    # 自动清理阈值（来自 config.json 的 call.recKeepDays / call.recKeepMB）。
    # 放在实例上而不是读全局，是为了让"这一台 sidecar 用的是哪个规矩"看得见。
    keep_days: float = 30.0
    keep_mb: float = 1024.0
    # 本通电话的起始时刻（ISO），给逐字稿和文件名用；空串 = 还没接过电话。
    call_started_at: str = ""
    # 本通电话的逐字稿落盘路径（接听时生成，挂断时写入）
    call_log_path: Path | None = None
    last_db: float = -180.0
    history: list[dict] = field(default_factory=list)
    _thr: threading.Thread | None = None
    _stop: threading.Event = field(default_factory=threading.Event)
    stats: dict = field(default_factory=lambda: {"utterances": 0, "asr_ms": [],
                                                 "tts_ms": [], "brain_ms": []})

    # ---- 设备自检 ----
    def check_devices(self) -> dict:
        info: dict = {}
        ok, detail = ca.SpeakerOut(device=self.out_device).available() if self.out_device \
            else (False, "未配置虚拟声卡输出")
        info["out_device"] = {"configured": self.out_device, "ok": ok, "detail": detail}
        try:
            info["default_speaker"] = ca.list_devices()["default_speaker"]
        except Exception as exc:  # noqa: BLE001
            info["default_speaker"] = f"查询失败: {exc}"
        return info

    # ---- 启动 ----
    def start_components(self) -> None:
        """只起 ASR / TTS / 采集，不开主循环。自测要用这个，否则会和自测抢音频。"""
        if self.asr is None:
            self.asr = AsrClient()
        if self.tts is None:
            self.tts = TtsClient(self.voice, self.rate)
        if not self.asr.start():
            raise RuntimeError(f"ASR 启动失败：{self.asr.err}")
        log(f"ASR 就绪（device={self.asr.device}）")
        if not self.tts.start():
            raise RuntimeError(f"TTS 启动失败：{self.tts.err}")
        log(f"TTS 就绪（voice={self.tts.voice}）")
        if self.tap is None:
            self.tap = ca.RingTap().start()
            time.sleep(0.4)
            if self.tap.error:
                raise RuntimeError(f"环回采集失败：{self.tap.error}")
            log(f"环回采集已开（{self.tap.total_seconds():.2f}s 缓冲）")

    def start(self) -> None:
        if self.running:
            return
        self.start_components()
        self._stop.clear()
        self.running = True
        self._thr = threading.Thread(target=self._loop, name="call-loop", daemon=True)
        self._thr.start()

    def stop(self) -> None:
        self._stop.set()
        self.running = False
        if self._thr:
            self._thr.join(timeout=3)
        if self.tap:
            self.tap.stop()
        if self.asr:
            self.asr.stop()
        if self.tts:
            self.tts.stop()

    # ---- 主循环 ----
    def set_active(self, on: bool, *, reason: str = "") -> None:
        """切换「在通话中」，并同步开/关整段录音。

        所有地方都必须走这里，不要再直接写 `engine.active = x`：
        只要有一次漏掉，就会出现「引擎在采但没录音」的无声电话，
        事后完全无法复盘。
        """
        on = bool(on)
        was = self.active
        self.active = on
        if on and not was:
            self._rec_open(reason)
        elif not on and was:
            self._rec_close()
        elif on and self.rec_writer is None:
            self._rec_open(reason)

    def _rec_dir(self) -> Path:
        """选一个真的能写的录音目录。

        优先级：engine.rec_dir > REC_DIR（主人能看见的文件夹）> SPOOL（仓库内）。
        为什么要有回落：目录可能在 OneDrive 里被占位、或被安全软件锁住，
        而「录音存不下来」绝不能变成「电话打不了」。
        """
        for cand in (self.rec_dir, REC_DIR):
            if cand is None:
                continue
            try:
                Path(cand).mkdir(parents=True, exist_ok=True)
                self.rec_fell_back = Path(cand) != Path(REC_DIR)
                return Path(cand)
            except Exception as exc:  # noqa: BLE001
                log(f"⚠️ 录音目录建不出来（{cand}）：{type(exc).__name__}: {exc}")
        self.rec_fell_back = True
        SPOOL.mkdir(parents=True, exist_ok=True)
        return SPOOL

    def sweep_stale(self) -> None:
        """清"旧成果"：超龄的录音 wav 与逐字稿 json（阈值在 self.keep_days/keep_mb）。

        为什么挂在 engine 上：录音目录到底是哪个，只有 `_rec_dir()` 说了算
        （配置的、主人看得见的那个、还是回落到仓库里），清理必须跟着它走，
        否则会出现"录音存在回落目录里，清理却去清另一个目录"这种糊涂账。
        """
        sweep_retention(self._rec_dir(), self.keep_days, self.keep_mb)

    def _rec_open(self, reason: str) -> None:
        try:
            out_dir = self._rec_dir()
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            path = out_dir / f"call-{stamp}.wav"
            w = wave.open(str(path), "wb")
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(self.tap.samplerate if self.tap else 48000)
            self.rec_path = path
            self.rec_writer = w
            self.rec_written_s = 0.0
            self.call_started_at = datetime.now().isoformat(timespec="seconds")
            self.call_log_path = CALL_LOG_DIR / f"call-{stamp}.json"
            # 逐字稿按「一通电话」切分：不清空的话第二通电话的 transcript 会把
            # 第一通的话一起带上，长期记忆里就会冒出「那天明明没说过」的内容。
            self.history.clear()
            # 会话 key 也要回到本轮通话的起点：brain.key 会在第一句话时被桥接告诉，
            # 之后一直留在对象上。不重置的话，下一通（可能是另一个号打来的）如果
            # 一句话没说，逐字稿就会顶着上一通的 key，记忆会记到别人头上。
            if self.brain is not None and hasattr(self.brain, "key"):
                self.brain.key = str(getattr(self.brain, "_boot_key", self.brain.key) or "")
            # 录音走**自己的游标**（不是 drain 的），从「此刻」开始往后追。
            self._rec_pos = None
            where = "（回落到仓库目录）" if self.rec_fell_back else ""
            log(f"🔴 开始录音 {path.name}（{reason or '通话开始'}）{where}")
        except Exception as exc:  # noqa: BLE001
            self.rec_writer = None
            self.rec_path = None
            log(f"⚠️ 录音开不了（不影响通话）：{type(exc).__name__}: {exc}")

    def _rec_pump(self) -> None:
        """把录音游标往后推，并把新音频写盘。

        和切句用的 `drain()` 完全分开：`say()` 里为了「别听见自己」会调
        `skip_pending()`，那会把 drain 的游标整体推到最新——如果把录音也挂在
        drain 上，每说一句话就会在录音里凭空少掉十几秒（实测一通 63 秒的电话
        只录到 15 秒，缺口正好是我们自己说话的时长）。
        """
        if self.rec_writer is None or self.tap is None:
            return
        self._rec_pos = getattr(self, "_rec_pos", None)
        # 一直抽到抽空为止：handle_utterance 会阻塞十几秒（ASR+脑子+说话），
        # 那期间没人推进游标。一次只取 4 秒的话，长通话会永久落后。
        for _ in range(64):        # 上限只是防跑飞（64×4s 远超 120s 环形缓冲）
            data, self._rec_pos = self.tap.read_from(self._rec_pos, 4.0)
            if not data.size:
                return
            self._rec_feed(data)

    def _rec_close(self) -> None:
        self._rec_pump()          # 收尾时先把剩下的灌进去，别丢尾巴
        w, self.rec_writer = self.rec_writer, None
        if w is not None:
            try:
                w.close()
                log(f"⏹ 录音已存 {self.rec_path.name if self.rec_path else '?'}")
            except Exception:  # noqa: BLE001
                pass
        # ⭐ 通话结束的天然钩子：把这一通的逐字稿落盘。
        # 为什么不在这里直接写长期记忆：daily-memory.json 归整理脚本独写，
        # 两个进程同时写会互相覆盖。这里只落"原材料"，第二天由整理脚本提炼。
        self._rec_write_transcript()
        self.rec_path = None
        self._rec_pos = None
        # 通话结束：这一通攒下的临时合成音频没用了，顺手清掉（录音和逐字稿都已落盘）。
        cleared = sweep_spool()
        if cleared:
            log(f"🧹 清掉本次通话的临时音频 {cleared} 个")
        # 顺带过一遍「年龄 + 总量」双闸：引擎可能几周不重启，只在启动时清的话，
        # 天天打电话也不会有人来收旧录音。
        self.sweep_stale()

    def _rec_write_transcript(self) -> None:
        """把本次通话的 history 存成一份 JSON 逐字稿（供整理脚本提炼进长期记忆）。

        哪怕 history 是空的也**要写**：空录音+空逐字稿正是「接起来但没声音」
        这种故障的唯一证据，缺了它下次只能重新猜。
        """
        path = self.call_log_path
        if path is None:
            return
        try:
            CALL_LOG_DIR.mkdir(parents=True, exist_ok=True)
            turns = [t for t in self.history if isinstance(t, dict) and t.get("text")]
            # 会话 key 优先取「通话中途桥接告诉我们的那个」（第一次换话才有），
            # 没有就退回启动参数里给的。两者都可能为空（接起来一句话没说），
            # 这种逐字稿整理脚本会跳过 —— 那是故意的：没有内容的记录不该变成记忆。
            call_key = str(getattr(self.brain, "key", "") or "")
            payload = {
                "startedAt": self.call_started_at or "",
                "endedAt": datetime.now().isoformat(timespec="seconds"),
                # 这通电话绑定的会话 key（private:QQ号）。整理脚本靠它决定
                # 这条记忆属于"跟谁的通话"，别让它落到别的会话名下。
                "key": call_key,
                "recording": self.rec_path.name if self.rec_path else "",
                "writtenSeconds": round(float(self.rec_written_s or 0.0), 2),
                "turns": turns,
            }
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(path)
            log(f"📝 通话逐字稿已存 {path.name}（{len(turns)} 句）")
        except Exception as exc:  # noqa: BLE001
            log(f"⚠️ 逐字稿写不了：{type(exc).__name__}: {exc}")
        finally:
            self.call_log_path = None
            self.call_started_at = ""

    def _rec_feed(self, chunk: np.ndarray) -> None:
        w = self.rec_writer
        if w is None or chunk.size == 0:
            return
        try:
            pcm = np.clip(chunk, -1.0, 1.0)
            w.writeframes((pcm * 32767.0).astype(np.int16).tobytes())
            self.rec_written_s += chunk.size / (self.tap.samplerate if self.tap else 48000)
        except Exception as exc:  # noqa: BLE001
            log(f"⚠️ 写录音失败，关掉录音：{exc}")
            self._rec_close()

    def _loop(self) -> None:
        seg = Segmenter()
        sr = self.tap.samplerate
        while not self._stop.is_set():
            # 录音走独立游标，每轮都先抽一把，和 drain 的消费进度无关。
            self._rec_pump()
            # 一次多取一点：handle_utterance 里 ASR+brain+TTS 会阻塞好几秒，
            # 这期间新音频全堆在 RingTap 里。如果每次只取 0.25s，追赶速度靠
            # 循环次数，边追边又触发新的一句话，录音就会一直落后于墙钟
            # （实测 4 秒通话只录到 1.3 秒）。取 1.0s 后吞吐够了。
            chunk = self.tap.drain(1.0)
            if chunk.size == 0:
                time.sleep(0.05)
                continue
            # 先量电平：与「是不是在通话」无关，
            # 否则诊断的时候看不到「对方到底有没有出声」。
            rms = float(np.sqrt(np.mean(np.square(chunk))))
            self.last_db = 20.0 * np.log10(max(rms, 1e-9))
            # 没在通话就别切句：扬声器里放着歌/视频，切出来的每一句都会去
            # 问一次脑子、再合成一段语音播出来 —— 没人打电话时那是纯噪音。
            # 缓冲照常读走（不能让它堆满），只是不喂给 VAD。
            if not self.active:
                continue
            utt = seg.feed(chunk, sr, time.time())
            if utt is None:
                continue
            try:
                self.handle_utterance(utt, sr)
            except Exception as exc:  # noqa: BLE001
                log(f"⚠️ 处理这句失败：{type(exc).__name__}: {exc}")
        self._rec_close()

    def handle_utterance(self, utt: np.ndarray, sr: int) -> dict | None:
        pcm16 = ca.resample(utt, sr, ca.SR_TARGET)
        dur = pcm16.size / ca.SR_TARGET
        if dur < 0.3:
            return None
        t0 = time.time()
        try:
            text = self.asr.transcribe(pcm16, ca.SR_TARGET)
        except Exception as exc:  # noqa: BLE001
            log(f"  ⚠️ ASR 失败：{exc}")
            return None
        asr_ms = (time.time() - t0) * 1000
        if not text:
            log(f"  （{dur:.1f}s 语音，没识别出字，跳过）")
            return None
        log(f"👂 {text}  [{dur:.1f}s / ASR {asr_ms:.0f}ms]")
        self.stats["utterances"] += 1
        self.stats["asr_ms"].append(asr_ms)
        self.history.append({"t": datetime.now().isoformat(timespec="seconds"),
                             "who": "other", "text": text})

        t1 = time.time()
        try:
            reply = self.brain.reply(text)
        except Exception as exc:  # noqa: BLE001
            log(f"  ⚠️ 脑子没转过来：{exc}")
            reply = ""
        brain_ms = (time.time() - t1) * 1000
        self.stats["brain_ms"].append(brain_ms)
        if not reply:
            return None
        log(f"🗣  {reply}  [brain {brain_ms:.0f}ms]")
        self.history.append({"t": datetime.now().isoformat(timespec="seconds"),
                             "who": "self", "text": reply})
        self.say(reply)
        return {"text": text, "reply": reply, "asr_ms": asr_ms, "brain_ms": brain_ms}

    def say(self, text: str) -> dict:
        """把一句话说出来。返回实际执行情况（有没有真的进 QQ 麦克风）。"""
        t0 = time.time()
        try:
            path = self.tts.synthesize(text)
        except Exception as exc:  # noqa: BLE001
            log(f"  ⚠️ TTS 失败：{exc}")
            return {"ok": False, "why": f"TTS 失败：{exc}"}
        tts_ms = (time.time() - t0) * 1000
        self.stats["tts_ms"].append(tts_ms)
        try:
            pcm, sr = decode_audio(path)
        except Exception as exc:  # noqa: BLE001
            log(f"  ⚠️ 解码失败：{exc}")
            return {"ok": False, "why": f"解码失败：{exc}"}
        dur = pcm.size / sr if sr else 0

        target = self.out_device
        sent_to_q = False
        if target:
            ok, detail = ca.SpeakerOut(device=target).available()
            if ok:
                try:
                    ca.SpeakerOut(device=target).play(pcm, sr=sr)
                    sent_to_q = True
                except Exception as exc:  # noqa: BLE001
                    log(f"  ⚠️ 播到 {target} 失败：{exc}")
            else:
                log(f"  ⚠️ 虚拟声卡不可用（{detail}）")
        if not sent_to_q and self.monitor:
            ca.SpeakerOut().play(pcm, sr=sr)
            log(f"  （没接虚拟声卡，已播到默认扬声器，时长 {dur:.1f}s / TTS {tts_ms:.0f}ms）")
        # 自己说的话会从扬声器漏进环回（自激）。播完把这段没读的音频丢掉。
        if self.tap is not None:
            time.sleep(0.1)
            dropped = self.tap.skip_pending()
            if dropped > 0.05:
                log(f"  （丢掉刚播出去那 {dropped:.1f}s，防止听见自己）")
        return {"ok": True, "to_qq": sent_to_q, "path": str(path),
                "seconds": round(dur, 2), "tts_ms": round(tts_ms, 1)}

    def status(self) -> dict:
        return {
            "running": self.running,
            "active": self.active,
            "brain": getattr(self.brain, "name", "?"),
            "out_device": self.out_device,
            "history": self.history[-20:],
            "stats": self.stats,
            "rec": (str(self.rec_path) if self.rec_path else None),
            # 录音到底存哪：主人要看得到，所以把绝对路径和"是否回落"都吐出来，
            # 省得下次又得翻代码找文件去哪了。
            "rec_dir": str(self.rec_dir or REC_DIR),
            "rec_fell_back": bool(self.rec_fell_back),
            # 逐字稿落在哪：跟录音一样是"主人要看得到"的东西，
            # 而且它必须和整理插件读的目录一致 —— 吐出来才好核对。
            "transcript_dir": str(CALL_LOG_DIR),
            # 自动清理的规矩（超过 days 天删、目录超过 mb 就从最旧的删）。
            "rec_keep": {"days": self.keep_days, "mb": self.keep_mb},
            "rec_written_s": round(float(self.rec_written_s or 0.0), 1),
            "call_started_at": self.call_started_at,
            "call_log": (str(self.call_log_path) if self.call_log_path else None),
            "last_db": round(self.last_db, 1),
            "audio": (None if not self.tap else
                      {"buffered_s": round(self.tap.total_seconds(), 2),
                       "dbfs": round(self.tap.dbfs(0.3), 1),
                       # 采集线程到底还活着没有：blocks 不再增长 = 环回流卡死
                       # （WASAPI 环回在设备长时间空闲后可能停在那不返回数据，
                       #  这时 buffered_s 会一直卡在 120 上限、dbfs 恒 -180，
                       #  外面看起来像「没人说话」，其实是耳朵聋了）。
                       "blocks": self.tap.blocks_written,
                       "device": self.tap.device_name,
                       "alive": bool(self.tap._thr and self.tap._thr.is_alive()),
                       "dropped_s": round(self.tap.dropped_samples / 48000, 1),
                       "err": self.tap.error}),
        }


# --------------------------------------------------------------------------- 自测

def selftest(out_device: str | None = None) -> int:
    """全链路自测：不需要真打电话，也不需要主人做任何事。

    做法：用 edge-tts 造一段「对方说的话」→ 播到默认扬声器 → 环回采集
    → VAD 切句 → ASR → echo 脑 → TTS → 解码 → 报结果。
    这条链就是真实通话里会走的同一条链，只是「对方的嘴」换成了 TTS。

    如果给了 out_device（虚拟声卡），最后再加一步**注入验证**：
    把回复播到 CABLE Input，再从 CABLE Output 录回来做 ASR，
    确认「说话声」真的进了虚拟麦克风、而且听得清（不是只听电平）。
    """
    LOGS.mkdir(parents=True, exist_ok=True)
    print("=" * 68)
    print("全链路自测：会说 → 听 → 认字 → 想 → 再说（不接真电话）")
    print("=" * 68)

    engine = CallEngine(brain=EchoBrain(), out_device=out_device, monitor=False)
    print("\n[1/6] 设备")
    for k, v in engine.check_devices().items():
        print(f"   {k}: {v}")

    print("\n[2/6] 起 ASR / TTS / 采集（不开主循环，免得和自测抢音频）")
    t0 = time.time()
    engine.start_components()
    print(f"   就绪，{time.time()-t0:.1f}s")

    try:
        sentence = "喂，能听见我说话吗？我是打电话来问你晚上吃什么的。"
        print(f"\n[3/6] 造一句「对方的话」（edge-tts 合成）：{sentence}")
        probe_tts = TtsClient(voice="zh-CN-YunxiNeural")     # 换一个男声当"对方"
        assert probe_tts.start(), probe_tts.err
        fake = probe_tts.synthesize(sentence)
        probe_tts.stop()
        pcm, sr = decode_audio(fake)
        print(f"   {pcm.size/sr:.2f}s, {sr}Hz")

        print("\n[4/6] 播到默认扬声器，让引擎从环回里听回来…")
        # 必须边播边听：play 默认是阻塞的，等它放完再 drain 的话，
        # 刚放出去那句早就堆在缓冲里、还会被我们当成「自己人」丢掉。
        ca.SpeakerOut().play(pcm, sr=sr, blocking=False)
        time.sleep(0.15)
        engine.tap.skip_pending()   # 只丢掉播放之前残留的静音
        got = None
        t_end = time.time() + 20
        seg = Segmenter()
        while time.time() < t_end:
            chunk = engine.tap.drain(0.25)
            if chunk.size == 0:
                time.sleep(0.05)
                continue
            utt = seg.feed(chunk, engine.tap.samplerate, time.time())
            if utt is None:
                continue
            got = engine.handle_utterance(utt, engine.tap.samplerate)
            break
        if not got:
            print("   ❌ 没切出一句完整的语音（VAD/采集有问题）")
            return 1
        print(f"\n[5/6] 识别结果：{got['text']}")
        print(f"   ASR {got['asr_ms']:.0f}ms")

        print("\n[6/6] 说完之后的统计")
        for k, v in engine.stats.items():
            print(f"   {k}: {v}")
        print("\n链路结论：")
        print(f"   听 → 认字      : {'通 ✅' if got['text'] else '断 ❌'}")
        print(f"   认字 → 想      : 通 ✅（echo 脑）")
        print(f"   想 → 出声      : 通 ✅（TTS + 解码 + 播放）")
        inj = None
        if out_device:
            inj = _selftest_injection(out_device)
            print(f"   出声 → 进QQ麦克风: {'通 ✅' if inj.get('ok') else '断 ❌'}"
                  f"（{out_device} → CABLE Output）")
        else:
            print("   出声 → 进QQ麦克风: 未测（没给 --out-device）")
        return 0 if (got["text"] and (inj is None or inj.get("ok"))) else 1
    finally:
        engine.stop()


def _selftest_injection(out_device: str) -> dict:
    """注入验证：把一段话播到虚拟声卡，再从它的录音端录回来做 ASR。

    光看电平不算数（静音也可能是 -90dB，噪音也可能 -20dB），必须
    **录回来还能识别出正确的字**，才说明 QQ 那边真的会听见人话。
    """
    print("\n[+] 注入验证：播到虚拟声卡 → 从录音端录回 → ASR 核对")
    sentence = "晚上吃火锅还是烤肉，你选一个。"
    res: dict = {"out_device": out_device, "sentence": sentence, "ok": False}
    tts = TtsClient(voice="zh-CN-XiaoyiNeural")
    if not tts.start():
        res["why"] = f"TTS 起不来：{tts.err}"
        return res
    try:
        wav = tts.synthesize(sentence)
    finally:
        tts.stop()
    pcm, sr = decode_audio(wav)

    ca.ensure_com()
    import soundcard as sc
    cap = next((m for m in sc.all_microphones(include_loopback=True)
                if "CABLE Output".lower() in m.name.lower()), None)
    if cap is None:
        res["why"] = "找不到 CABLE Output 录音端"
        return res

    grabbed: list[np.ndarray] = []
    started = threading.Event()

    def _rec() -> None:
        ca.ensure_com()
        try:
            with cap.recorder(samplerate=48000, channels=1, blocksize=480) as rec:
                started.set()
                t_end = time.time() + max(6.0, pcm.size / sr + 3.0)
                while time.time() < t_end:
                    d = rec.record(numframes=480)
                    mono = d.mean(axis=1) if d.ndim == 2 else d
                    grabbed.append(np.asarray(mono, dtype=np.float32))
        except Exception as exc:  # noqa: BLE001
            res["rec_err"] = f"{type(exc).__name__}: {exc}"

    th = threading.Thread(target=_rec, daemon=True)
    th.start()
    started.wait(3.0)
    time.sleep(0.2)
    ca.SpeakerOut(device=out_device).play(pcm, sr=sr)
    th.join(timeout=max(8.0, pcm.size / sr + 6.0))

    if not grabbed:
        res["why"] = res.get("rec_err") or "录音端没数据"
        return res
    x = np.concatenate(grabbed)
    rms = float(np.sqrt(np.mean(np.square(x)))) if x.size else 0.0
    dbfs = 20 * np.log10(max(rms, 1e-9))
    res["dbfs"] = round(dbfs, 1)
    res["seconds"] = round(x.size / 48000, 2)

    asr = AsrClient()
    if not asr.start():
        res["why"] = f"ASR 起不来：{asr.err}"
        return res
    try:
        # 录到的头尾有静音，直接整段送去识别（whisper 自带 VAD/对齐）
        heard = asr.transcribe(ca.resample(x, 48000, ca.SR_TARGET), ca.SR_TARGET)
    finally:
        asr.stop()
    res["heard"] = heard
    # 判定：识别出来的字与原句有足够重合（中文按字符集合算，容忍错字）
    import re
    norm = lambda s: re.sub(r"[^\w]", "", s or "")
    a, b = set(norm(sentence)), set(norm(heard))
    overlap = len(a & b) / max(1, len(a))
    res["char_overlap"] = round(overlap, 3)
    res["ok"] = bool(heard and overlap >= 0.5 and dbfs > -50)
    if not res["ok"]:
        res["why"] = ("录音端电平太低" if dbfs <= -50 else
                      f"识别重合度不够（{overlap:.0%}）：{heard!r}")
    print(f"   原句：{sentence}")
    print(f"   录回：{heard!r}  电平 {dbfs}dBFS  重合 {overlap:.0%}")
    if not res["ok"]:
        print(f"   ❌ {res.get('why')}")
    return res


# --------------------------------------------------------------------------- 服务

def serve(args) -> int:
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    # 逐字稿目录允许被桥接按配置覆盖（config.json 的 call.transcriptDir）：
    # 整理插件读的是同一份配置，两边必须落在同一个目录，否则"逐字稿搬了家、
    # 整理脚本还在老地方找" —— 那种错不会报错，只会让记忆悄悄少掉电话那一块。
    global CALL_LOG_DIR
    if args.transcript_dir:
        CALL_LOG_DIR = Path(args.transcript_dir)
    brain = (HttpBrain(args.brain_url, args.key, args.token) if args.brain_url
             else EchoBrain())
    engine = CallEngine(brain=brain, out_device=args.out_device,
                        monitor=args.monitor, voice=args.voice, rate=args.rate,
                        rec_dir=Path(args.rec_dir) if args.rec_dir else None,
                        keep_days=args.keep_days, keep_mb=args.keep_mb)
    # 上次通话如果被强杀（没走到 _rec_close），临时音频会留在 SPOOL 里；
    # 启动时人还没在通话，是最安全的一次清理时机。
    stale = sweep_spool()
    if stale:
        log(f"🧹 启动清理：上次通话遗留的临时音频 {stale} 个")
    # 存量也顺手过一遍双闸（引擎可能几周不重启，平时没人来收旧录音）。
    engine.sweep_stale()
    engine.start()
    log(f"通话引擎已就绪：brain={getattr(brain,'name','?')} out={args.out_device}")

    # ⚠️ 必须定义在**类外面**：class 体里的名字不是方法的闭包作用域，
    #    do_GET 里直接写 `idle_watch` 会 NameError（真要写就得写 Handler.idle_watch）。
    #    放成 serve() 的局部变量，方法按闭包规则就能读到。
    idle_watch = {"since": 0.0}

    class Handler(BaseHTTPRequestHandler):
        def _json(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            if self.path.startswith("/status"):
                state = cs.probe_once().to_dict()
                # 对方先挂了 / QQ 自己断了：窗口回到 idle 而我们还在「通话中」状态。
                # 这时候必须自己收手，否则引擎会一直听着扬声器，把环境声当对方说话。
                #
                # 但**不能一帧 idle 就收手**：这一帧的识别全靠截图 + OCR，窗口被挡一下、
                # 最小化一下、或者 OCR 只是没读全，都会得出 idle。真按一帧就停采集，
                # 表现就是「聊着聊着突然听不见了」，而且再也不会恢复。
                # 判据用**持续时间**（≥5 秒都 idle）而不是「连续 N 次」：
                # /status 会被桥接守夜、控制台、MCP 工具分别调用，次数不固定，
                # 按次数算的话控制台多刷两下就能把一个偶发误判变成"挂断"。
                now = time.monotonic()
                # 计时只在「正在通话」时走。不在通话时归零，否则空闲期间攒下的
                # 那个时间戳会让刚接起来的一瞬间就被判成「窗口已消失」——
                # 表现就是刚接上就停采集、录音文件只有一两秒。
                if not engine.active:
                    idle_watch["since"] = 0.0
                    idle_s = 0.0
                else:
                    if state.get("state") == cs.STATE_IDLE:
                        if not idle_watch["since"]:
                            idle_watch["since"] = now
                    else:
                        idle_watch["since"] = 0.0
                    idle_s = (now - idle_watch["since"]) if idle_watch["since"] else 0.0
                    if idle_s >= 5.0:
                        engine.set_active(False, reason="窗口消失")
                        idle_watch["since"] = 0.0
                        log("📴 通话窗口已消失（对方挂了），停止采集")
                return self._json({"ok": True, "engine": engine.status(), "qq": state,
                                   "idle_s": round(idle_s, 1)})
            self._json({"ok": False, "error": "not found"}, 404)

        def do_POST(self):  # noqa: N802
            n = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(n) if n else b"{}"
            try:
                body = json.loads(raw or b"{}")
            except Exception:  # noqa: BLE001
                body = {}
            if self.path == "/say":
                # 说一句失败**不能**变成 500 + traceback：桥接那边拿到的是
                # `ok:false / 500`，她会以为"话已经说出去了"，而对方什么也没听见
                # （2026-10-25 实测：`speak-or-text` 里 `engine.say` 抛异常，
                #  整个请求炸掉，日志只有一屏 traceback，哪里都看不出「这句没播」）。
                try:
                    return self._json({"ok": True, **engine.say(str(body.get("text") or ""))})
                except Exception as exc:  # noqa: BLE001
                    log(f"⚠️ /say 异常：{exc}")
                    return self._json({"ok": False, "why": f"说话时出错：{exc}"})
            if self.path == "/answer":
                r = cs.answer(dry_run=not body.get("real"))
                # 只有真的接起来了才开「在通话中」：dry_run 只是看按钮能不能找到。
                if r.get("ok") and body.get("real"):
                    engine.set_active(True, reason="已接听")
                    log("📞 已接听，开始听对方说话")
                return self._json(r)
            if self.path == "/hangup":
                r = cs.hangup(dry_run=not body.get("real"))
                if r.get("ok") and body.get("real"):
                    engine.set_active(False, reason="挂断")
                    log("📴 已挂断，停止采集")
                return self._json(r)
            if self.path == "/listen":
                # 只切「听不听」，不点任何按钮。
                # 用途：电话其实已经接通了（比如主人自己手点的、或者接听那一下点成功了但
                # sidecar 重启过丢了 active 状态），需要让引擎恢复采集，而不该再点一次接听。
                on = bool(body.get("on", True))
                engine.set_active(on, reason="手动 /listen")
                log("🎧 开始采集（对方说话会被听见）" if on else "🔇 停止采集")
                return self._json({"ok": True, "active": engine.active})
            self._json({"ok": False, "error": "not found"}, 404)

        def log_message(self, *a):  # 静音
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    log(f"监听 http://127.0.0.1:{args.port}  （/status /say /answer /hangup）")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        engine.stop()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--port", type=int, default=3210)
    ap.add_argument("--out-device", default=None,
                    help="虚拟声卡输出设备名，装好 VB-CABLE 后填 'CABLE Input'")
    ap.add_argument("--monitor", action="store_true", default=True,
                    help="虚拟声卡不可用时，把回复播到默认扬声器")
    ap.add_argument("--no-monitor", dest="monitor", action="store_false")
    ap.add_argument("--brain-url", default=None,
                    help="bridge 的接话端点，例如 http://127.0.0.1:3100/api/call/turn")
    ap.add_argument("--key", default="", help="会话 key，如 private:12345678")
    ap.add_argument("--token", default=None, help="x-agent-token")
    ap.add_argument("--voice", default=None, help="TTS 音色（默认用配置里的那个）")
    ap.add_argument("--rate", default=None)
    ap.add_argument("--rec-dir", default=None,
                    help=f"通话录音存到哪（默认 {REC_DIR}）")
    ap.add_argument("--transcript-dir", default=None,
                    help=f"通话逐字稿存到哪（默认 {TRANSCRIPT_DIR}）")
    ap.add_argument("--keep-days", type=float, default=KEEP_DAYS,
                    help=f"录音/逐字稿超过这么多天就自动删（默认 {KEEP_DAYS:.0f}）")
    ap.add_argument("--keep-mb", type=float, default=KEEP_MB,
                    help=f"录音/逐字稿目录超过这么多 MB 就从最旧的开始删（默认 {KEEP_MB:.0f}）")
    args = ap.parse_args()
    _fix_stdio()
    if args.selftest:
        return selftest(args.out_device)
    if args.serve:
        return serve(args)
    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())

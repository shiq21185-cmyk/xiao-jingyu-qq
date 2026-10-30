# -*- coding: utf-8 -*-
"""阶段 2 地基：QQ 通话的音频进/出。

通话的音频是两路独立的：
  对方的声音  → QQ 播到【默认扬声器】→ 我们环回采集（WASAPI loopback），零驱动
  小鲸鱼的声音 → 我们需要往 QQ 的【麦克风】灌进去 → 必须有一个虚拟输入设备

第一路现在就能跑（Windows 自带 WASAPI loopback，不用装任何驱动）。
第二路缺 VB-CABLE（免费虚拟声卡，从 https://vb-audio.com/Cable/ 自己下、装完重启；
安装包不入库，理由同 tools/asr/models —— 第三方驱动不进公开仓库），
所以 Injector 允许先把设备名配好、真正可用之前会明确报错，不会假装成功。

用法：
    python tools/call/call_audio.py --list          # 有什么设备
    python tools/call/call_audio.py --selftest 5    # 录 5 秒系统声，报电平
"""
from __future__ import annotations

import argparse
import queue
import sys
import threading
import time
import warnings
from dataclasses import dataclass, field

import numpy as np

SR_TARGET = 16000          # ASR 要的采样率
BLOCK = 480                # 10ms @48k


def _silence_soundcard_noise() -> None:
    """压掉 soundcard 在设备空闲时刷屏的 `data discontinuity` 告警。

    现象：`mediafoundation.py:772` 每次 WASAPI 报 `AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY`
    就 warn 一条，而 `mediafoundation.py:26` 用 `simplefilter('always', ...)` 关掉了
    去重 —— 结果设备静音（或没在放声）时每 3~5 秒一条，实测占 bridge.log 的 53%，
    把真日志全挤没了。它本身是良性的：环回缓冲会丢一块，但我们的环形缓冲
    `dropped_s` 一直是 0.0。

    为什么这里能压住：`warnings.filterwarnings()` 把 filter **插到列表最前面**，
    匹配时按顺序走，所以会先于模块里那条 `simplefilter('always')` 命中。
    """
    try:
        import soundcard as sc
        warnings.filterwarnings('ignore', category=sc.SoundcardRuntimeWarning,
                                message='data discontinuity')
    except Exception:  # noqa: BLE001
        pass   # 非 Windows / 没装 soundcard：这里失败不影响任何东西


_silence_soundcard_noise()


# --------------------------------------------------------------------------- COM

_COM_INITIALIZED = False


def ensure_com() -> None:
    """每个要用 SoundCard 的线程都必须先 CoInitialize，否则报 0x800401F0。

    SoundCard 底层走 MediaFoundation（WASAPI），是 COM API。Python 线程默认没有
    初始化 COM 单元，主线程在裸 `python -` 里也没有 —— 所以统一在这里兜住。
    重复调用无害（RPC_E_CHANGED_MODE 也当成功）。
    """
    global _COM_INITIALIZED
    import ctypes
    try:
        hr = ctypes.windll.ole32.CoInitializeEx(None, 0x2)  # COINIT_APARTMENTTHREADED
        _COM_INITIALIZED = True
        # 0=S_OK, 1=S_FALSE(已初始化), -2147417850=RPC_E_CHANGED_MODE(别的模式已初始化)
        _ = hr
    except Exception:  # noqa: BLE001
        pass


ensure_com()


# --------------------------------------------------------------------------- 设备

def list_devices() -> dict:
    import soundcard as sc

    spk = [{"name": m.name, "id": m.id} for m in sc.all_speakers()]
    mic = [{"name": m.name, "id": m.id, "loopback": bool(m.isloopback)}
           for m in sc.all_microphones(include_loopback=True)]
    try:
        d_spk = sc.default_speaker().name
    except Exception:  # noqa: BLE001
        d_spk = None
    try:
        d_mic = sc.default_microphone().name
    except Exception:  # noqa: BLE001
        d_mic = None
    return {"speakers": spk, "microphones": mic,
            "default_speaker": d_spk, "default_microphone": d_mic}


def _loopback_for(name_substr: str | None):
    """拿到某个扬声器的「环回麦克风」——SoundCard 里它同时是 Microphone。

    注意：Speaker 对象没有 recorder()，只有 Microphone 有。
    环回设备的 id 和扬声器相同，名字也相同，所以按名字匹配即可。
    """
    import soundcard as sc
    want = name_substr or sc.default_speaker().name
    mics = [m for m in sc.all_microphones(include_loopback=True) if m.isloopback]
    for m in mics:
        if want.lower() in m.name.lower():
            return m
    raise RuntimeError(f"没有 {want!r} 的环回设备；现有环回：{[m.name for m in mics]}")


def _find_speaker(name_substr: str | None):
    import soundcard as sc
    if not name_substr:
        return sc.default_speaker()
    for m in sc.all_speakers():
        if name_substr.lower() in m.name.lower():
            return m
    raise RuntimeError(f"找不到扬声器 {name_substr!r}；现有：{[m.name for m in sc.all_speakers()]}")


def _find_mic(name_substr: str | None, *, loopback: bool | None = None):
    import soundcard as sc
    if not name_substr:
        return sc.default_microphone()
    for m in sc.all_microphones(include_loopback=True):
        if name_substr.lower() in m.name.lower():
            if loopback is not None and bool(m.isloopback) != loopback:
                continue
            return m
    raise RuntimeError(f"找不到输入设备 {name_substr!r}")


def resample(x: np.ndarray, sr_in: int, sr_out: int = SR_TARGET) -> np.ndarray:
    """线性重采样。语音够用；不引入 scipy。"""
    if sr_in == sr_out or x.size == 0:
        return x.astype(np.float32, copy=False)
    n_out = int(round(x.size * sr_out / sr_in))
    if n_out <= 0:
        return np.zeros(0, dtype=np.float32)
    xp = np.linspace(0.0, 1.0, x.size, endpoint=False)
    fp = np.linspace(0.0, 1.0, n_out, endpoint=False)
    return np.interp(fp, xp, x).astype(np.float32)


# --------------------------------------------------------------------------- 采集

@dataclass
class RingTap:
    """环回采集：后台线程不停录。

    两种读法，别混用：
      * `grab(seconds)` —— 看「最近 N 秒」（诊断、看电平用；会重复读到同一段）
      * `drain(max_seconds)` —— 只吐**从上次 drain 之后**新来的音频，流式切句必须用这个

    早先只实现 grab，导致切句循环一直在重复看同一段尾音，永远等不到一句话说完。
    """
    speaker: str | None = None
    samplerate: int = 48000
    # 预分配的环形缓冲（不增长）。2026-10-30 之前是 `np.concatenate([_buf, new])`，
    # 缓冲填满 120s 后每 10ms 就要整体复制一次 23MB（≈2.3GB/s 的纯内存拷贝），
    # 实测让 sidecar 在**没有通话时**也稳定吃着 54% 单核。现在改成写指针覆盖，
    # 每块只写 480 个样本，CPU 归零。
    _ring: np.ndarray | None = None
    _cap: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _stop: threading.Event = field(default_factory=threading.Event)
    _thr: threading.Thread | None = None
    _err: str | None = None
    max_seconds: float = 120.0
    blocks_written: int = 0
    _total: int = 0          # 至今写入的总样本数（绝对水位，只增不减）
    _consumed: int = 0       # drain 已消费到哪
    dropped_samples: int = 0
    device_name: str = ""    # 实际挂上的环回设备名（诊断：确认监听的是哪个扬声器）

    def start(self) -> "RingTap":
        self._stop.clear()
        self._cap = max(int(self.max_seconds * self.samplerate), BLOCK * 2)
        self._ring = np.zeros(self._cap, dtype=np.float32)
        try:
            self.device_name = _loopback_for(self.speaker).name
        except Exception:  # noqa: BLE001
            self.device_name = f"<解析失败 speaker={self.speaker!r}>"
        self._thr = threading.Thread(target=self._run, name="looptap", daemon=True)
        self._thr.start()
        return self

    def _write(self, mono: np.ndarray) -> None:
        """把一块音频写进环形缓冲（调用方持有 _lock）。

        满了就覆盖最旧的那块：写指针回绕，`_total`（绝对水位）照常前进，
        读端用 `_ring_start()` 判断哪些位置已经被盖掉了。
        """
        n = mono.size
        if n == 0:
            return
        if n >= self._cap:                       # 极端情况：一块比整个环还长
            self._ring[:] = mono[-self._cap:]
            self._total += n
            return
        pos = self._total % self._cap
        end = pos + n
        if end <= self._cap:
            self._ring[pos:end] = mono
        else:                                     # 跨过末尾，分两段写
            head = self._cap - pos
            self._ring[pos:] = mono[:head]
            self._ring[:end - self._cap] = mono[head:]
        self._total += n

    def _ring_start(self) -> int:
        """环里现存最老样本的绝对位置（更早的已被覆盖）。"""
        return max(0, self._total - self._cap)

    def _read(self, abs_pos: int, count: int) -> np.ndarray:
        """按绝对位置读 count 个样本，返回新数组（调用方持有 _lock）。

        调用方必须保证 abs_pos + count <= _total（不读未来）。
        """
        out = np.empty(count, dtype=np.float32)
        pos = abs_pos % self._cap
        end = pos + count
        if end <= self._cap:
            out[:] = self._ring[pos:end]
        else:
            head = self._cap - pos
            out[:head] = self._ring[pos:]
            out[head:] = self._ring[:end - self._cap]
        return out

    def _run(self) -> None:
        ensure_com()
        rec_dev = _loopback_for(self.speaker)
        try:
            with rec_dev.recorder(samplerate=self.samplerate, channels=1,
                                  blocksize=BLOCK) as rec:
                while not self._stop.is_set():
                    data = rec.record(numframes=BLOCK)
                    mono = data.mean(axis=1) if data.ndim == 2 else data
                    mono = np.asarray(mono, dtype=np.float32)
                    with self._lock:
                        self._write(mono)
                        # 缓冲满了之后，还没被 drain 读走的旧数据就算丢了
                        start = self._ring_start()
                        if self._consumed < start:
                            self.dropped_samples += start - self._consumed
                            self._consumed = start
                    self.blocks_written += 1
        except Exception as exc:  # noqa: BLE001
            self._err = f"{type(exc).__name__}: {exc}"

    def stop(self) -> None:
        self._stop.set()
        if self._thr:
            self._thr.join(timeout=2.0)

    @property
    def error(self) -> str | None:
        return self._err

    def grab(self, seconds: float, *, to_asr: bool = True) -> np.ndarray:
        with self._lock:
            n = int(seconds * self.samplerate)
            avail = self._total - self._ring_start() if self._ring is not None else 0
            n = min(n, avail)
            chunk = self._read(self._total - n, n) if n > 0 else np.zeros(0, dtype=np.float32)
        return resample(chunk, self.samplerate) if to_asr else chunk

    def drain(self, max_seconds: float = 0.25) -> np.ndarray:
        """把「上次 drain 之后新到」的音频一次性取走（最多 max_seconds）。

        流式切句只能用它：grab 每次都返回同一段尾巴，会让 VAD 卡在原地。
        """
        with self._lock:
            avail = self._total - self._consumed
            if avail <= 0:
                return np.zeros(0, dtype=np.float32)
            take = min(avail, int(max_seconds * self.samplerate))
            chunk = self._read(self._consumed, take)
            self._consumed += take
            return chunk

    def skip_pending(self) -> float:
        """丢掉还没读的音频，返回丢了多少秒（用于「别听见自己」）。"""
        with self._lock:
            avail = self._total - self._consumed
            self._consumed = self._total
        return avail / self.samplerate

    def read_from(self, pos: int | None, max_seconds: float = 4.0) -> tuple[np.ndarray, int]:
        """按**独立游标**顺序读环形缓冲（录音专用）。

        为什么不能用 drain：drain 是给切句用的单游标流，`skip_pending()` 会把它
        整体推到最新位置——于是「说话给自己听」的那十几秒音频对 drain 来说就消失
        了。录音要的是**每一块都留下**，所以必须自己拿一个游标往前走。

        pos=None 表示「从现在开始」。返回 (chunk, 新游标)。落后的部分已经被覆盖
        掉时，从最早还能读到的地方接上（宁可断一小段，也不返回错位数据）。
        """
        with self._lock:
            if pos is None:
                pos = self._total
            start_of_buf = self._ring_start()
            if pos < start_of_buf:
                pos = start_of_buf
            avail = self._total - pos
            if avail <= 0:
                return np.zeros(0, dtype=np.float32), pos
            take = min(avail, int(max_seconds * self.samplerate))
            return self._read(pos, take), pos + take

    def total_seconds(self) -> float:
        with self._lock:
            if self._ring is None:
                return 0.0
            return (self._total - self._ring_start()) / self.samplerate

    def dbfs(self, seconds: float = 0.5) -> float:
        x = self.grab(seconds, to_asr=False)
        if x.size == 0:
            return -120.0
        rms = float(np.sqrt(np.mean(np.square(x))))
        return 20.0 * np.log10(max(rms, 1e-9))


# --------------------------------------------------------------------------- 播放

@dataclass
class SpeakerOut:
    """把 PCM 播到一个输出设备。VB-CABLE 装好后 device 传 'CABLE Input'。"""
    device: str | None = None
    samplerate: int = 48000

    def _dev(self):
        return _find_speaker(self.device)

    def available(self) -> tuple[bool, str]:
        """设备在不在。**绝不抛异常** —— 它被 /say 直接调用，抛一下整个请求就 500。

        2026-10-25 实测：HTTP handler 线程里 `sc.all_speakers()` 抛过一次
        （`call_audio.py:270`，整条 /say 变成 500 + traceback），
        表现是「她正说着话，那条回复没声音了」。枚举设备是**尽力而为**的事，
        枚举不出来只能说明查不到，不能说明设备不在 —— 所以失败时选择
        「当作可用，让后面的 play 自己报错」，而不是让调用方炸掉。
        """
        if not self.device:
            return False, "未配置输出设备"
        try:
            import soundcard as sc
            # HTTP handler 跑在自己的线程里，没 CoInitialize 过；不先兜一下，
            # all_speakers() 会直接抛 COM 错误（0x800401F0），/say 就整条 500。
            ensure_com()
            names = [m.name for m in sc.all_speakers()]
        except Exception as exc:  # noqa: BLE001
            return True, f"枚举设备失败（{exc}），按可用处理，交给 play 报错"
        for n in names:
            if self.device.lower() in n.lower():
                return True, n
        return False, f"没有名为 {self.device!r} 的设备；现有：{names}"

    def play(self, pcm: np.ndarray, sr: int = SR_TARGET, *, blocking: bool = True) -> None:
        """pcm: float32 mono。会重采样到设备采样率。

        非阻塞时**整个 with 都要在子线程里**：player 是 COM 对象，所在的 `with`
        一退出就 release，播放线程再去碰它直接段错误（实测 exit 139）。
        """
        if pcm.dtype != np.float32:
            pcm = pcm.astype(np.float32)
        pcm = np.clip(pcm, -1.0, 1.0)
        up = resample(pcm, sr, self.samplerate)
        stereo = np.repeat(up.reshape(-1, 1), 2, axis=1)

        def _run() -> None:
            import soundcard as sc  # noqa: F401
            ensure_com()
            dev = self._dev()
            with dev.player(samplerate=self.samplerate, channels=2) as sp:
                sp.play(stereo)

        if blocking:
            _run()
        else:
            threading.Thread(target=_run, daemon=True).start()


# --------------------------------------------------------------------------- VAD

def is_speech(x: np.ndarray, *, thresh_dbfs: float = -45.0) -> bool:
    """能量门限 VAD。够用：通话里静音底噪通常 < -55 dBFS。"""
    if x.size == 0:
        return False
    rms = float(np.sqrt(np.mean(np.square(x))))
    return 20.0 * np.log10(max(rms, 1e-9)) > thresh_dbfs


def wait_for_speech(tap: RingTap, *, timeout: float = 30.0, window: float = 0.3,
                    thresh_dbfs: float = -45.0, poll: float = 0.05) -> bool:
    t_end = time.time() + timeout
    while time.time() < t_end:
        if is_speech(tap.grab(window, to_asr=False), thresh_dbfs=thresh_dbfs):
            return True
        time.sleep(poll)
    return False


# --------------------------------------------------------------------------- CLI

def _selftest(seconds: float) -> int:
    info = list_devices()
    print("默认扬声器:", info["default_speaker"])
    print("默认麦克风:", info["default_microphone"])
    tap = RingTap().start()
    time.sleep(0.3)
    print(f"录音 {seconds:.0f}s（现在随便放点声音，或让人说话）…")
    peak, samples = -120.0, []
    t_end = time.time() + seconds
    while time.time() < t_end:
        peak = max(peak, tap.dbfs(0.25))
        samples.append(tap.dbfs(0.25))
        time.sleep(0.25)
    tap.stop()
    if tap.error:
        print("采集出错:", tap.error)
        return 1
    print(f"录到 {tap.total_seconds():.2f}s，峰值 {peak:.1f} dBFS，"
          f"均值 {np.mean(samples):.1f} dBFS")
    print("判定:", "有声音 ✅" if peak > -50 else "几乎静音（设备没在播？）")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--selftest", type=float, default=0.0, metavar="SECONDS")
    args = ap.parse_args()
    if args.list:
        import json
        print(json.dumps(list_devices(), ensure_ascii=False, indent=2))
        return 0
    if args.selftest:
        return _selftest(args.selftest)
    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())

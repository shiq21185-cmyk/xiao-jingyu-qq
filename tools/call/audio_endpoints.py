# -*- coding: utf-8 -*-
"""Windows 默认音频端点：读 / 设（console / multimedia / communications 三个角色）。

为什么需要它：
    QQ 语音通话用哪一路麦克风，取决于 Windows 的「默认麦克风」；
    而通话里对方的声音从哪一路出来，取决于「默认扬声器」。
    小鲸鱼要「听对方 + 灌自己声音」，就必须把这两路指准确：
        默认扬声器 → 耳机 / 真扬声器（对方声音要进人耳，同时被 loopback 采集）
        默认麦克风 → CABLE Output（QQ 从这根线读小鲸鱼的声音）

    QQ 还有「通讯」角色的专用设置，它优先于普通默认设备 —— 三个角色要一起设。

判据很硬：设完立刻回读，不一致就报错，绝不假装成功。

用法：
    python tools/call/audio_endpoints.py --list
    python tools/call/audio_endpoints.py --set-mic "CABLE Output"
    python tools/call/audio_endpoints.py --set-speaker "Headphones"
    python tools/call/audio_endpoints.py --json out.json   # 结果写 UTF-8 文件（控制台中文会乱码）
"""
from __future__ import annotations

import argparse
import json
import sys

from pycaw.pycaw import AudioUtilities
from pycaw.constants import AudioDeviceState

FLOW_NAMES = {0: "render", 1: "capture", "render": 0, "capture": 1}
ROLE_NAMES = ("console", "multimedia", "communications")
ROLE_VALUES = {"console": 0, "multimedia": 1, "communications": 2}

try:  # pycaw 新旧版本枚举名不一致，兜住
    from pycaw.constants import ERole
    _ROLE_ENUM = [ERole.eConsole, ERole.eMultimedia, ERole.eCommunications]
except Exception:  # noqa: BLE001
    _ROLE_ENUM = [0, 1, 2]


# --------------------------------------------------------------------------- 读

def _active(flow: int) -> list:
    return [d for d in AudioUtilities.GetAllDevices(data_flow=flow)
            if d.state == AudioDeviceState.Active]


def _default_name(flow: int, role: int) -> str:
    """用 GetDefaultAudioEndpoint 拿该角色的默认设备名（这是唯一权威来源）。

    ⚠️ 不要对返回的枚举器调 .Release()：pycaw 的 CoCreateInstance 会复用同一个
    COM 对象，Release 掉之后下一次 EnumAudioEndpoints 会直接访问违例
    （实测 OSError: access violation writing 0x24）。交给 GC 就好。
    """
    try:
        en = AudioUtilities.GetDeviceEnumerator()
        dev = en.GetDefaultAudioEndpoint(flow, role)
        if dev is None:
            return ""
        # GetDefaultAudioEndpoint 返回的是裸 POINTER(IMMDevice)，没有 FriendlyName；
        # 必须先包成 AudioDevice 才能读名字（直接 .FriendlyName 会 AttributeError，
        # 被 except 吞掉就变成「所有默认设备都读不到」）。
        ad = AudioUtilities.CreateDevice(dev)
        return str(ad.FriendlyName) if ad is not None else ""
    except Exception:  # noqa: BLE001
        return ""


def current_defaults() -> dict:
    return {
        "render": {ROLE_NAMES[r]: _default_name(0, r) for r in range(3)},
        "capture": {ROLE_NAMES[r]: _default_name(1, r) for r in range(3)},
    }


def list_endpoints(flow: int) -> list[dict]:
    defaults = {_default_name(flow, r): ROLE_NAMES[r] for r in range(3)}
    out = []
    for d in _active(flow):
        name = str(d.FriendlyName)
        roles = [ROLE_NAMES[r] for r in range(3) if _default_name(flow, r) == name]
        out.append({"name": name, "id": str(d.id), "roles": roles})
    return out


# --------------------------------------------------------------------------- 写

def set_default(flow: int, match: str, *, roles: tuple[int, ...] = (0, 1, 2)) -> dict:
    """把名字包含 match 的活动端点设为默认，覆盖指定角色。设完回读校验。"""
    cands = [d for d in _active(flow) if match.lower() in str(d.FriendlyName).lower()]
    if not cands:
        raise LookupError(
            f"没有名字含 {match!r} 的活动{'播放' if flow == 0 else '采集'}设备；"
            f"现有：{[str(d.FriendlyName) for d in _active(flow)]}")
    dev = cands[0]
    target_name = str(dev.FriendlyName)
    AudioUtilities.SetDefaultDevice(str(dev.id), roles=[_ROLE_ENUM[r] for r in roles])

    after = {ROLE_NAMES[r]: _default_name(flow, r) for r in roles}
    bad = [r for r, n in after.items() if n != target_name]
    return {"device": target_name, "id": str(dev.id), "after": after, "mismatch": bad}


# --------------------------------------------------------------------------- CLI

def main() -> int:
    ap = argparse.ArgumentParser(description="Windows 默认音频端点读写")
    ap.add_argument("--list", action="store_true", help="列出设备 + 三个角色的默认值")
    ap.add_argument("--set-speaker", metavar="SUBSTR")
    ap.add_argument("--set-mic", metavar="SUBSTR")
    ap.add_argument("--role", default="all", choices=["all", *ROLE_NAMES])
    ap.add_argument("--json", metavar="PATH", help="把结果写到这个 UTF-8 文件")
    args = ap.parse_args()

    if args.list or not (args.set_speaker or args.set_mic):
        payload = {
            "render": list_endpoints(0),
            "capture": list_endpoints(1),
            "defaults": current_defaults(),
        }
        code = 0
    else:
        roles = (0, 1, 2) if args.role == "all" else (ROLE_VALUES[args.role],)
        payload = {}
        try:
            if args.set_speaker:
                payload["speaker"] = set_default(0, args.set_speaker, roles=roles)
            if args.set_mic:
                payload["mic"] = set_default(1, args.set_mic, roles=roles)
        except Exception as exc:  # noqa: BLE001
            payload = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
            code = 1
        else:
            bad = any(v.get("mismatch") for v in payload.values())
            payload["ok"] = not bad
            payload["defaults"] = current_defaults()
            code = 0 if not bad else 2

    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.json:
        from pathlib import Path
        Path(args.json).write_text(text, encoding="utf-8")
        print(f"written: {args.json}")
    else:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        print(text)
    return code


if __name__ == "__main__":
    sys.exit(main())

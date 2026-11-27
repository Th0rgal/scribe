"""Desktop audio recorder (Mic + PipeWire/PulseAudio System Audio monitor) + ElevenLabs Scribe batch diarization."""
from __future__ import annotations

import array
import json
import mimetypes
import os
import subprocess
import threading
import time
import urllib.request
import uuid
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


def resolve_elevenlabs_key() -> Optional[str]:
    val = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if val:
        return val
    p = os.environ.get("ELEVENLABS_API_KEY_FILE", "").strip()
    if p and Path(p).is_file():
        tok = Path(p).read_text(encoding="utf-8").strip()
        if tok:
            return tok
    return None


def _pactl_default(kind: str) -> Optional[str]:
    try:
        out = subprocess.check_output(["pactl", f"get-default-{kind}"], text=True, timeout=3).strip()
        return out or None
    except Exception:
        return None


def transcribe_elevenlabs_diarize(wav_path: Path) -> Optional[list[dict[str, Any]]]:
    """Send WAV to ElevenLabs Scribe batch API (`diarize=true`) and return grouped speaker segments."""
    api_key = resolve_elevenlabs_key()
    if not api_key or not wav_path.is_file() or wav_path.stat().st_size < 1000:
        return None

    boundary = f"----ScribeBoundary{uuid.uuid4().hex}"
    parts: list[bytes] = []

    def add_field(name: str, value: str) -> None:
        parts.append(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
            f"{value}\r\n".encode("utf-8")
        )

    add_field("model_id", "scribe_v1")
    add_field("diarize", "true")
    add_field("timestamps_granularity", "word")

    mime = mimetypes.guess_type(str(wav_path))[0] or "audio/wav"
    parts.append(
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{wav_path.name}"\r\n'
        f"Content-Type: {mime}\r\n\r\n".encode("utf-8")
    )
    parts.append(wav_path.read_bytes())
    parts.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))
    body = b"".join(parts)

    req = urllib.request.Request(
        "https://api.elevenlabs.io/v1/speech-to-text",
        data=body,
        headers={
            "xi-api-key": api_key,
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": "Scribe/0.2.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None

    words = data.get("words") or []
    if not words:
        text = (data.get("text") or "").strip()
        return [{"speaker": "Speaker 1", "text": text, "start": 0.0, "end": 0.0}] if text else None

    speaker_map: dict[str, str] = {}
    segments: list[dict[str, Any]] = []
    cur_spk: Optional[str] = None
    cur_start = 0.0
    cur_end = 0.0
    buf: list[str] = []

    def flush() -> None:
        txt = "".join(buf).strip()
        if txt and cur_spk is not None:
            label = speaker_map.setdefault(cur_spk, f"Speaker {len(speaker_map) + 1}")
            segments.append({"speaker": label, "text": txt, "start": cur_start, "end": cur_end})
        buf.clear()

    for w in words:
        wtype = w.get("type", "word")
        if wtype not in ("word", "spacing"):
            continue
        spk = (w.get("speaker_id") or "speaker_0").strip() or "speaker_0"
        s = float(w.get("start") or 0.0)
        e = float(w.get("end") or 0.0)
        if wtype == "word" and cur_spk is not None and cur_spk != spk:
            flush()
            cur_spk = spk
            cur_start = s
        elif cur_spk is None and wtype == "word":
            cur_spk = spk
            cur_start = s
        if e > cur_end:
            cur_end = e
        buf.append(w.get("text") or "")
    flush()
    return segments or None


class DesktopRecorder:
    """Captures 16 kHz mono PCM from Mic and/or System Audio monitor via `parec`."""

    SAMPLE_RATE = 16000

    def __init__(self, notes_dir: Path) -> None:
        self.notes_dir = notes_dir
        self._lock = threading.Lock()
        self._recording = False
        self._mic = True
        self._system_audio = True
        self._started_at = 0.0
        self._slug = ""
        self._wav_path: Optional[Path] = None
        self._procs: list[subprocess.Popen] = []
        self._buffers: list[bytearray] = []
        self._threads: list[threading.Thread] = []

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "recording": self._recording,
                "elapsed_secs": round(time.time() - self._started_at, 1) if self._recording else 0.0,
                "mic": self._mic,
                "system_audio": self._system_audio,
                "slug": self._slug,
            }

    def start(self, mic: bool = True, system_audio: bool = True) -> dict[str, Any]:
        with self._lock:
            if self._recording:
                return self.status()
            if not mic and not system_audio:
                raise ValueError("Enable at least Mic or System Audio")

            devices: list[str] = []
            if mic:
                src = _pactl_default("source")
                devices.append(src or "@DEFAULT_SOURCE@")
            if system_audio:
                sink = _pactl_default("sink")
                devices.append(f"{sink}.monitor" if sink else "@DEFAULT_MONITOR@")

            self._slug = time.strftime("%Y-%m-%d_%H-%M-%S")
            self._wav_path = self.notes_dir / f"{self._slug}.wav"
            self._mic = mic
            self._system_audio = system_audio
            self._started_at = time.time()
            self._procs = []
            self._buffers = []
            self._threads = []

            for dev in devices:
                proc = subprocess.Popen(
                    [
                        "parec",
                        "--format=s16le",
                        f"--rate={self.SAMPLE_RATE}",
                        "--channels=1",
                        f"--device={dev}",
                    ],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                )
                buf = bytearray()

                def _reader(p: subprocess.Popen, b: bytearray) -> None:
                    assert p.stdout is not None
                    while True:
                        chunk = p.stdout.read(3200)
                        if not chunk:
                            break
                        b.extend(chunk)

                t = threading.Thread(target=_reader, args=(proc, buf), daemon=True)
                t.start()
                self._procs.append(proc)
                self._buffers.append(buf)
                self._threads.append(t)

            self._recording = True
            return {
                "recording": True,
                "elapsed_secs": 0.0,
                "mic": self._mic,
                "system_audio": self._system_audio,
                "slug": self._slug,
            }

    def stop(self) -> tuple[str, Path, float, list[dict[str, Any]] | None]:
        with self._lock:
            if not self._recording or not self._wav_path:
                raise RuntimeError("Not recording")
            self._recording = False
            procs = self._procs
            buffers = self._buffers
            threads = self._threads
            wav_path = self._wav_path
            slug = self._slug
            duration = max(0.1, time.time() - self._started_at)
            self._procs = []
            self._buffers = []
            self._threads = []

        for p in procs:
            try:
                p.terminate()
            except Exception:
                pass
        for t in threads:
            t.join(timeout=2.0)

        # Mix 1 or 2 PCM16 mono streams cleanly into wav_path
        pcm_streams = [bytes(b) for b in buffers if len(b) >= 2]
        if not pcm_streams:
            mixed = b""
        elif len(pcm_streams) == 1:
            n = len(pcm_streams[0]) - (len(pcm_streams[0]) % 2)
            mixed = pcm_streams[0][:n]
        else:
            a1 = array.array("h")
            a2 = array.array("h")
            n1 = len(pcm_streams[0]) - (len(pcm_streams[0]) % 2)
            n2 = len(pcm_streams[1]) - (len(pcm_streams[1]) % 2)
            a1.frombytes(pcm_streams[0][:n1])
            a2.frombytes(pcm_streams[1][:n2])
            max_len = max(len(a1), len(a2))
            out = array.array("h", [0] * max_len)
            for i in range(max_len):
                v = (a1[i] if i < len(a1) else 0) + (a2[i] if i < len(a2) else 0)
                if v > 32767:
                    v = 32767
                elif v < -32768:
                    v = -32768
                out[i] = v
            mixed = out.tobytes()

        wav_path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(wav_path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(self.SAMPLE_RATE)
            wf.writeframes(mixed)

        segments = transcribe_elevenlabs_diarize(wav_path)
        return slug, wav_path, duration, segments

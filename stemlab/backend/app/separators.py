"""Audio source separation back-ends.

`demucs` runs Meta's Demucs model as a subprocess and parses its progress bar.
`mock` is a classical DSP split (filters + mid/side) that needs no model; it is
for development and tests only and is NOT machine learning.
"""
import io
import os
import zipfile
import urllib.request
import urllib.error
import re
import shutil
import subprocess
import sys
from collections import deque
from pathlib import Path
from typing import Callable

from .config import STEMS, settings

ProgressFn = Callable[[int, str], None]

_PCT = re.compile(r"(\d{1,3})%\|")

def run_modal(input_path: Path, out_dir: Path, on_progress: ProgressFn, modal_url: str) -> None:
    on_progress(10, "กำลังส่งไฟล์เสียงไปยัง Modal Cloud...")
    
    # ส่งไฟล์เพลงไปยัง Modal Web Endpoint
    boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
    filename = input_path.name
    with open(input_path, "rb") as f:
        file_bytes = f.read()
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: audio/mpeg\r\n\r\n"
    ).encode("utf-8") + file_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")
    req = urllib.request.Request(
        modal_url,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST"
    )
    on_progress(30, "AI กำลังแยกเสียงบน Modal Worker (CPU)...")
    try:
        with urllib.request.urlopen(req, timeout=600) as response:
            zip_bytes = response.read()
    except Exception as e:
        raise RuntimeError(f"Modal ประมวลผลล้มเหลว: {e}")
    on_progress(90, "กำลังบันทึก Stems 4 แทร็ก...")
    out_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        zf.extractall(out_dir)
        
    on_progress(100, "ประมวลผลเสร็จสิ้น")

def separate(input_path: Path, out_dir: Path, on_progress: ProgressFn) -> None:
    """Write vocals/drums/bass/other .wav files into `out_dir`."""
    backend = settings.separator.lower()
    modal_url = getattr(settings, "modal_demucs_url", None) or os.environ.get("MODAL_DEMUCS_URL")

    if backend == "modal" or (modal_url and backend != "mock"):
        if not modal_url:
            raise ValueError("ต้องกำหนด MODAL_DEMUCS_URL เมื่อใช้ SEPARATOR='modal'")
        run_modal(input_path, out_dir, on_progress, modal_url)
    elif backend == "demucs":
        run_demucs(input_path, out_dir, on_progress)
    elif backend == "mock":
        run_mock(input_path, out_dir, on_progress)
    else:
        raise ValueError(f"Unknown SEPARATOR '{settings.separator}' (use 'demucs', 'modal' or 'mock')")


def run_demucs(input_path: Path, out_dir: Path, on_progress: ProgressFn) -> None:
    work = out_dir.parent / "_demucs"
    shutil.rmtree(work, ignore_errors=True)

    cmd = [
        sys.executable, "-m", "demucs.separate",
        "-n", settings.demucs_model,
        "-o", str(work),
        "--filename", "{stem}.{ext}",
        "--segment", str(settings.demucs_segment),
        "--shifts", str(settings.demucs_shifts),
        "--jobs", str(settings.demucs_jobs),
    ]
    if settings.demucs_device != "auto":
        cmd += ["-d", settings.demucs_device]
    cmd.append(str(input_path))

    on_progress(3, "กำลังโหลดโมเดล AI (Demucs)")
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert proc.stdout is not None

    tail: deque[str] = deque(maxlen=15)
    last_pct = -1
    # tqdm redraws its bar with '\r'; text mode turns that into line breaks.
    try:
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            tail.append(line)
            match = _PCT.search(line)
            if match:
                pct = min(int(match.group(1)), 100)
                if pct != last_pct:
                    last_pct = pct
                    on_progress(5 + int(pct * 0.9), "AI กำลังแยกเสียง")
    except Exception:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        shutil.rmtree(work, ignore_errors=True)
        raise

    code = proc.wait()
    if code != 0:
        raise RuntimeError(f"Demucs exited with code {code}: " + " | ".join(tail))

    on_progress(97, "กำลังจัดเก็บไฟล์เสียง")
    out_dir.mkdir(parents=True, exist_ok=True)
    for stem in STEMS:
        found = next(work.rglob(f"{stem}.wav"), None)
        if found is None:
            raise RuntimeError(
                f"Demucs did not produce {stem}.wav - use a 4-stem model such as htdemucs"
            )
        shutil.move(str(found), out_dir / f"{stem}.wav")
    shutil.rmtree(work, ignore_errors=True)


def run_mock(input_path: Path, out_dir: Path, on_progress: ProgressFn) -> None:
    import numpy as np
    import soundfile as sf
    from scipy.signal import butter, sosfiltfilt

    on_progress(10, "อ่านไฟล์เสียง (โหมดจำลอง DSP)")
    data, sr = sf.read(str(input_path), always_2d=True, dtype="float32")
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    data = data[:, :2]

    def filt(x: "np.ndarray", kind: str, freq) -> "np.ndarray":
        sos = butter(4, freq, btype=kind, fs=sr, output="sos")
        return sosfiltfilt(sos, x, axis=0)

    on_progress(35, "กรองย่านเสียงเบส")
    bass = filt(data, "lowpass", 150)
    on_progress(55, "กรองย่านเสียงกลอง")
    drums = filt(data, "highpass", 6000)
    on_progress(75, "ดึงเสียงกลาง (vocals)")
    mid = data.mean(axis=1, keepdims=True)
    vocals = np.repeat(filt(mid, "bandpass", [250, 4000]), 2, axis=1)
    other = data - bass - drums - vocals

    out_dir.mkdir(parents=True, exist_ok=True)
    for name, signal in (("vocals", vocals), ("drums", drums), ("bass", bass), ("other", other)):
        sf.write(str(out_dir / f"{name}.wav"), np.clip(signal, -1.0, 1.0), sr, subtype="PCM_16")
    on_progress(97, "กำลังจัดเก็บไฟล์เสียง")

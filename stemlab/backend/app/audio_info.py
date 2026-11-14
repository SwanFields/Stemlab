"""Best-effort audio length, read once at upload so the dashboard can total listening minutes."""
from pathlib import Path

_MPEG1_L3_KBPS = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320)
_MPEG2_L3_KBPS = (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)


def _mp3_estimate(path: Path) -> float | None:
    """Constant-bitrate estimate from the first frame header (exact for CBR, close for VBR)."""
    try:
        size = path.stat().st_size
        with path.open("rb") as f:
            head = f.read(10)
            offset = 0
            if head[:3] == b"ID3" and len(head) == 10:
                tag = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]
                offset = 10 + tag
            f.seek(offset)
            chunk = f.read(8192)
        for i in range(len(chunk) - 4):
            if chunk[i] == 0xFF and chunk[i + 1] & 0xE0 == 0xE0:
                version = (chunk[i + 1] >> 3) & 3  # 3 = MPEG1, 2 = MPEG2
                layer = (chunk[i + 1] >> 1) & 3  # 1 = layer III
                idx = chunk[i + 2] >> 4
                if layer != 1 or version not in (2, 3) or idx in (0, 15):
                    continue
                kbps = (_MPEG1_L3_KBPS if version == 3 else _MPEG2_L3_KBPS)[idx]
                return max(0.0, (size - offset) * 8 / (kbps * 1000))
    except OSError:
        return None
    return None


def audio_duration_seconds(path: Path) -> float | None:
    try:
        import soundfile as sf

        info = sf.info(str(path))
        if info.samplerate and info.frames:
            return info.frames / info.samplerate
    except Exception:  # noqa: BLE001 - unsupported codec in this libsndfile build
        pass
    if path.suffix.lower() == ".mp3":
        return _mp3_estimate(path)
    return None

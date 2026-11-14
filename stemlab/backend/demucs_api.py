"""Modal Serverless Demucs API for Stemlab.

This script runs Meta's Demucs (htdemucs) model on Modal GPU workers.
Features:
- Pre-downloads and bakes model weights into the Modal image (Fast cold start)
- Loads model once per container onto GPU (T4 / A10G)
- Supports Python RPC (modal.Cls / modal.Function) and HTTP Web API (FastAPI)
- Returns separated 4 stems: vocals, drums, bass, other

Commands:
- Local test:  modal run demucs_api.py
- Test audio:  modal run demucs_api.py --input-file "path/to/song.mp3"
- Deploy:      modal deploy demucs_api.py
"""

import io
import zipfile
from pathlib import Path
from typing import Any, Dict

import modal

try:
    from fastapi import File, UploadFile  # type: ignore
except ImportError:
    UploadFile = Any  # type: ignore
    File = lambda *args, **kwargs: None  # type: ignore

# ----------------- Configuration -----------------
APP_NAME = "stemlab-demucs"
MODEL_NAME = "htdemucs"  # 4-stem model (vocals, drums, bass, other)



# ----------------- Pre-download Hook -----------------
def download_model_weights():
    """Runs during Modal image build to bake Demucs weights into the container image."""
    from demucs.pretrained import get_model  # type: ignore
    print(f"Pre-downloading Demucs model '{MODEL_NAME}' during image build...")
    get_model(MODEL_NAME)
    print("Demucs model cached successfully.")


# ----------------- Modal Image -----------------
demucs_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "torch>=2.1,<2.9",
        "torchaudio>=2.1,<2.9",
        "demucs==4.0.1",
        "soundfile",
        "fastapi[standard]",
        "python-multipart",
    )
    .run_function(download_model_weights)
)

app = modal.App(name=APP_NAME, image=demucs_image)


# ----------------- Demucs Service Class -----------------
@app.cls(
    image=demucs_image,
    cpu=4.0,
    memory=8192,
    timeout=600,
    scaledown_window=120,
)
class DemucsService:
    device: str
    model: Any
    samplerate: int
    sources: list[str]

    @modal.enter()
    def load_model(self):
        """Loads model into CPU memory when the container starts."""
        import torch  # type: ignore
        from demucs.pretrained import get_model  # type: ignore

        # Optimize PyTorch to use all allocated CPU cores
        torch.set_num_threads(4)

        self.device = "cpu"
        print(f"Loading Demucs '{MODEL_NAME}' onto device: {self.device} (threads={torch.get_num_threads()})")
        
        self.model = get_model(MODEL_NAME)
        self.model.to(self.device)
        self.model.eval()
        self.samplerate = self.model.samplerate
        self.sources = self.model.sources
        print(f"Demucs ready! Stems: {self.sources}, Sample rate: {self.samplerate}Hz")

    def _process_audio(self, audio_bytes: bytes) -> Dict[str, bytes]:
        """Separates audio bytes into 4 stems: {stem_name: wav_bytes}."""
        import soundfile as sf  # type: ignore
        import torch  # type: ignore
        import torchaudio  # type: ignore
        from demucs.apply import apply_model  # type: ignore

        # 1. Load audio from bytes
        try:
            wav, sr = torchaudio.load(io.BytesIO(audio_bytes))
        except Exception:
            # Fallback to soundfile if torchaudio fails on specific format
            audio_np, sr = sf.read(io.BytesIO(audio_bytes), dtype="float32", always_2d=True)
            wav = torch.from_numpy(audio_np.T)

        # 2. Resample if necessary
        if sr != self.samplerate:
            wav = torchaudio.functional.resample(wav, sr, self.samplerate)

        # 3. Ensure stereo (2 channels)
        if wav.shape[0] == 1:
            wav = wav.repeat(2, 1)
        elif wav.shape[0] > 2:
            wav = wav[:2]

        # 4. Normalize
        ref = wav.mean(0)
        wav = (wav - ref.mean()) / (ref.std() + 1e-8)

        # 5. Apply Demucs model
        with torch.no_grad():
            sources = apply_model(
                self.model,
                wav[None],
                device=self.device,
                shifts=1,
                split=True,
                overlap=0.25,
                progress=False,
            )[0]

        # 6. Denormalize
        sources *= (ref.std() + 1e-8)
        sources += ref.mean()

        # 7. Convert each stem tensor to 16-bit PCM WAV bytes
        stems: Dict[str, bytes] = {}
        for source, name in zip(sources, self.sources):
            audio_np = source.cpu().numpy().T  # (samples, channels)
            buf = io.BytesIO()
            sf.write(buf, audio_np, self.samplerate, format="WAV", subtype="PCM_16")
            stems[name] = buf.getvalue()

        return stems

    @modal.method()
    def separate(self, audio_bytes: bytes) -> Dict[str, bytes]:
        """Python RPC method callable via `DemucsService().separate.remote(bytes)`."""
        return self._process_audio(audio_bytes)

    @modal.fastapi_endpoint(method="POST")
    def api_separate(self, file: UploadFile = File(...)):  # type: ignore
        """HTTP Web API: Upload an audio file and download a ZIP containing all 4 stems."""
        from fastapi import Response  # type: ignore

        audio_bytes = file.file.read()
        stems = self._process_audio(audio_bytes)

        # Pack into a ZIP archive
        zip_buf = io.BytesIO()
        with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for stem_name, stem_bytes in stems.items():
                zf.writestr(f"{stem_name}.wav", stem_bytes)

        stem_zip_bytes = zip_buf.getvalue()
        return Response(
            content=stem_zip_bytes,
            media_type="application/zip",
            headers={"Content-Disposition": "attachment; filename=stems.zip"},
        )

    @modal.fastapi_endpoint(method="GET")
    def health(self):
        """HTTP Health Check endpoint."""
        return {
            "status": "healthy",
            "model": MODEL_NAME,
            "device": self.device,
            "cpu_cores": 4.0,
            "stems": self.sources,
        }


# ----------------- Local Testing Entrypoint -----------------
@app.local_entrypoint()
def main(input_file: str = ""):
    """Test function when running `modal run demucs_api.py` locally."""
    if not input_file:
        print("=" * 60)
        print("Demucs Modal Service is ready to deploy!")
        print("To test with a real audio file, run:")
        print("  modal run demucs_api.py --input-file path/to/song.mp3")
        print("\nTo deploy to production on Modal, run:")
        print("  modal deploy demucs_api.py")
        print("=" * 60)
        return

    path = Path(input_file)
    if not path.exists():
        print(f"Error: File '{input_file}' not found.")
        return

    print(f"Reading '{input_file}'...")
    audio_bytes = path.read_bytes()

    print("Sending audio to Modal worker for Demucs separation...")
    service = DemucsService()
    stems = service.separate.remote(audio_bytes)  # type: ignore

    out_dir = Path("output_stems")
    out_dir.mkdir(exist_ok=True)
    for stem_name, stem_bytes in stems.items():
        stem_path = out_dir / f"{stem_name}.wav"
        stem_path.write_bytes(stem_bytes)
        print(f"Saved: {stem_path} ({len(stem_bytes)} bytes)")

    print(f"\nAll stems successfully separated into '{out_dir}/'!")

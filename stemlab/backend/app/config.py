"""Application settings, read from environment variables or a .env file."""
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# The four stems every supported model produces (htdemucs, htdemucs_ft, mdx_extra ...).
STEMS = ("vocals", "drums", "bass", "other")
ALLOWED_EXTENSIONS = (".mp3", ".wav", ".flac")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    redis_url: str = "redis://localhost:6379/0"
    storage_dir: Path = Path("./storage")
    database_url: str | None = None
    max_upload_mb: int = 50
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    job_ttl_hours: int = 6
    auth_cookie_secure: bool = False

    # "demucs" = real ML model (needs torch + demucs + ffmpeg)
    # "mock"   = classical DSP filters, only for development without a GPU/torch
    separator: str = "demucs"
    demucs_model: str = "htdemucs"
    demucs_device: str = "auto"  # auto | cpu | cuda | mps

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()

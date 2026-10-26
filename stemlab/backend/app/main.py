"""REST API: upload a song, queue AI separation, poll status, download stems."""
import re
import shutil
import time
import uuid
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import BackgroundTasks, Cookie, Depends, FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, field_validator

from .auth import SESSION_TTL_SECONDS, auth_store
from .config import ALLOWED_EXTENSIONS, STEMS, settings
from .store import store
from .tasks import separate_task

JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
CHUNK = 1024 * 1024


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.storage_dir.mkdir(parents=True, exist_ok=True)
    auth_store.initialize()
    yield


app = FastAPI(title="Stemlab API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
    allow_credentials=True,
)

@app.middleware("http")
async def validate_cookie_request_origin(request: Request, call_next):
    origin = request.headers.get("origin")
    if request.method in {"POST", "PUT", "DELETE"} and origin and origin not in settings.cors_origin_list:
        return JSONResponse(status_code=403, content={"detail": "Origin ไม่ได้รับอนุญาต"})
    return await call_next(request)


# ---------- schemas ----------
class UploadResponse(BaseModel):
    job_id: str
    filename: str
    size_bytes: int


class StemLink(BaseModel):
    name: str
    url: str


class StatusResponse(BaseModel):
    job_id: str
    filename: str
    status: str  # uploaded | queued | processing | done | failed
    progress: int
    stage: str
    error: str | None = None
    stems: list[StemLink] = []


class HistoryItem(BaseModel):
    job_id: str
    filename: str
    status: str
    created_at: float
    completed_at: float | None = None
    stems: list[str]
    available: bool


class RegistrationCredentials(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    username: str = Field(min_length=3, max_length=30)
    password: str = Field(min_length=10, max_length=128)

    @field_validator("username")
    @classmethod
    def validate_username(cls, username: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_]{3,30}", username):
            raise ValueError("Username ต้องมี 3-30 ตัว ใช้ได้เฉพาะ a-z, 0-9 และ _")
        return username.lower()

    @field_validator("password")
    @classmethod
    def require_letters_and_digits(cls, password: str) -> str:
        if not any(character.isalpha() for character in password) or not any(
            character.isdigit() for character in password
        ):
            raise ValueError("รหัสผ่านต้องมีตัวอักษรและตัวเลขอย่างน้อยอย่างละ 1 ตัว")
        return password


class UsernameUpdate(BaseModel):
    username: str = Field(min_length=3, max_length=30)

    @field_validator("username")
    @classmethod
    def validate_username(cls, username: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_]{3,30}", username):
            raise ValueError("Username ต้องมี 3-30 ตัว ใช้ได้เฉพาะ a-z, 0-9 และ _")
        return username.lower()


class LoginCredentials(BaseModel):
    identifier: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=10, max_length=128)


class UserResponse(BaseModel):
    id: str
    email: str
    username: str


# ---------- helpers ----------
def job_dir(job_id: str) -> Path:
    return settings.storage_dir / job_id


def current_user(stemlab_session: str | None = Cookie(default=None)) -> dict[str, str]:
    user = auth_store.get_session_user(stemlab_session)
    if user is None:
        raise HTTPException(401, "กรุณาเข้าสู่ระบบก่อนใช้งาน")
    return user


def require_job(job_id: str, user_id: str) -> dict:
    job = store.get(job_id) if JOB_ID_RE.match(job_id) else None
    expired = (
        job is not None
        and job.get("created_at", 0) > 0
        and time.time() >= job["created_at"] + settings.job_ttl_hours * 3600
    )
    if job is None or job.get("user_id") != user_id or expired:
        raise HTTPException(404, "ไม่พบงานนี้ (อาจหมดอายุแล้ว)")
    return job


def looks_like_audio(head: bytes, ext: str) -> bool:
    """Check magic bytes so a renamed .exe/.txt cannot pass as audio."""
    if ext == ".mp3":
        return head[:3] == b"ID3" or (len(head) > 1 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0)
    if ext == ".wav":
        return head[:4] == b"RIFF" and head[8:12] == b"WAVE"
    if ext == ".flac":
        return head[:4] == b"fLaC"
    return False


def safe_base_name(filename: str) -> str:
    base = Path(filename).stem or "track"
    return re.sub(r'[\\/:*?"<>|\r\n]+', "_", base)[:80]


def cleanup_expired() -> None:
    root = settings.storage_dir
    if not root.is_dir():
        return
    cutoff = time.time() - settings.job_ttl_hours * 3600
    for entry in root.iterdir():
        if entry.is_dir() and JOB_ID_RE.match(entry.name) and entry.stat().st_mtime < cutoff:
            shutil.rmtree(entry, ignore_errors=True)


def build_zip(job_id: str, filename: str) -> Path:
    target = job_dir(job_id) / "stems.zip"
    if not target.exists():
        tmp = target.with_name(f"stems.{uuid.uuid4().hex}.tmp")
        base = safe_base_name(filename)
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as zf:  # WAV barely compresses
            for stem in STEMS:
                zf.write(job_dir(job_id) / "stems" / f"{stem}.wav", arcname=f"{base}_{stem}.wav")
        tmp.replace(target)
    return target


# ---------- endpoints ----------
@app.post("/api/auth/register", response_model=UserResponse, status_code=201)
def register(credentials: RegistrationCredentials, response: Response) -> dict[str, str]:
    email = credentials.email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise HTTPException(422, "กรุณากรอกอีเมลให้ถูกต้อง")
    user = auth_store.create_user(email, credentials.username, credentials.password)
    if user is None:
        raise HTTPException(409, "อีเมลหรือ Username นี้มีบัญชีอยู่แล้ว")
    token = auth_store.create_session(user["id"])
    response.set_cookie(
        "stemlab_session",
        token,
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        secure=settings.auth_cookie_secure,
        samesite="lax",
        path="/",
    )
    return user


@app.post("/api/auth/login", response_model=UserResponse)
def login(credentials: LoginCredentials, response: Response) -> dict[str, str]:
    user = auth_store.verify_user(credentials.identifier.strip().lower(), credentials.password)
    if user is None:
        raise HTTPException(401, "อีเมลหรือรหัสผ่านไม่ถูกต้อง")
    token = auth_store.create_session(user["id"])
    response.set_cookie(
        "stemlab_session",
        token,
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        secure=settings.auth_cookie_secure,
        samesite="lax",
        path="/",
    )
    return user


@app.get("/api/auth/me", response_model=UserResponse)
def me(user: dict[str, str] = Depends(current_user)) -> dict[str, str]:
    return user


@app.put("/api/auth/username", response_model=UserResponse)
def update_username(
    update: UsernameUpdate,
    user: dict[str, str] = Depends(current_user),
) -> dict[str, str]:
    updated_user = auth_store.update_username(user["id"], update.username)
    if updated_user is None:
        raise HTTPException(409, "Username นี้มีบัญชีใช้อยู่แล้ว")
    return updated_user


@app.post("/api/auth/logout", status_code=204)
def logout(
    response: Response,
    stemlab_session: str | None = Cookie(default=None),
) -> Response:
    auth_store.delete_session(stemlab_session)
    response.delete_cookie("stemlab_session", path="/", httponly=True, samesite="lax")
    response.status_code = 204
    return response


@app.get("/api/health")
def health() -> dict:
    try:
        store.client.ping()
        redis_ok = True
    except Exception:  # noqa: BLE001
        redis_ok = False
    model = settings.demucs_model if settings.separator == "demucs" else "mock-dsp"
    return {
        "status": "ok" if redis_ok else "degraded",
        "redis": redis_ok,
        "separator": settings.separator,
        "model": model,
        "max_upload_mb": settings.max_upload_mb,
    }


@app.get("/api/history", response_model=list[HistoryItem])
def history(user: dict[str, str] = Depends(current_user)) -> list[HistoryItem]:
    items = auth_store.list_job_history(user["id"])
    history_items = []
    for item in items:
        job = store.get(str(item["job_id"]))
        stems = item["stems"]
        available = (
            item["status"] == "done"
            and time.time() < float(item["created_at"]) + settings.job_ttl_hours * 3600
            and job is not None
            and job.get("user_id") == user["id"]
            and job.get("status") == "done"
            and isinstance(stems, list)
            and bool(stems)
            and set(stems).issubset(STEMS)
            and all((job_dir(str(item["job_id"])) / "stems" / f"{stem}.wav").is_file() for stem in stems)
        )
        history_items.append(HistoryItem(**item, available=available))
    return history_items


@app.post("/api/upload", response_model=UploadResponse, status_code=201)
async def upload(
    background: BackgroundTasks,
    file: UploadFile = File(...),
    user: dict[str, str] = Depends(current_user),
) -> UploadResponse:
    name = Path(file.filename or "").name
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(415, "รองรับเฉพาะไฟล์ MP3, WAV และ FLAC")

    job_id = uuid.uuid4().hex
    jdir = job_dir(job_id)
    jdir.mkdir(parents=True)
    input_file = f"input{ext}"
    size = 0
    try:
        head = await file.read(16)
        if not looks_like_audio(head, ext):
            raise HTTPException(415, "เนื้อหาไฟล์ไม่ตรงกับนามสกุล ไม่ใช่ไฟล์เสียงที่ถูกต้อง")
        with (jdir / input_file).open("wb") as out:
            out.write(head)
            size = len(head)
            while chunk := await file.read(CHUNK):
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise HTTPException(413, f"ไฟล์ใหญ่เกิน {settings.max_upload_mb} MB")
                out.write(chunk)
        if size == 0:
            raise HTTPException(400, "ไฟล์ว่างเปล่า")
    except Exception:
        shutil.rmtree(jdir, ignore_errors=True)
        raise

    created_at = time.time()
    store.create(
        job_id,
        filename=name,
        input_file=input_file,
        size_bytes=size,
        user_id=user["id"],
        created_at=created_at,
    )
    background.add_task(cleanup_expired)
    return UploadResponse(job_id=job_id, filename=name, size_bytes=size)


@app.post("/api/process/{job_id}", status_code=202)
def process(job_id: str, user: dict[str, str] = Depends(current_user)) -> dict:
    require_job(job_id, user["id"])
    if not store.transition(job_id, "uploaded", status="queued", progress=0, stage="อยู่ในคิว"):
        current = store.get(job_id) or {}
        raise HTTPException(409, f"งานนี้อยู่ในสถานะ '{current.get('status')}' แล้ว")
    job = store.get(job_id)
    if job is None:
        raise HTTPException(404, "ไม่พบงานนี้")
    auth_store.record_job(job_id, user["id"], job["filename"], job["created_at"], status="queued")
    current = store.get(job_id)
    if current is None or current["status"] == "cancelled":
        auth_store.delete_job_history(job_id)
        raise HTTPException(409, "งานนี้ถูกยกเลิกแล้ว")
    auth_store.update_job_history(job_id, status="queued")
    try:
        separate_task.delay(job_id)
    except Exception as exc:  # noqa: BLE001 - broker down
        store.update(job_id, status="failed", stage="เข้าคิวไม่สำเร็จ", error="เชื่อมต่อคิวงาน (Redis) ไม่ได้")
        raise HTTPException(503, "เชื่อมต่อคิวงานไม่ได้ ลองใหม่อีกครั้ง") from exc
    return {"job_id": job_id, "status": "queued"}


@app.delete("/api/jobs/{job_id}", status_code=204)
def cancel_job(job_id: str, user: dict[str, str] = Depends(current_user)) -> Response:
    job = require_job(job_id, user["id"])
    if job["status"] not in {"uploaded", "queued", "processing"}:
        raise HTTPException(409, "งานนี้ไม่สามารถยกเลิกได้แล้ว")
    store.update(job_id, status="cancelled", stage="ยกเลิกแล้ว")
    auth_store.delete_job_history(job_id)
    if job["status"] == "uploaded":
        shutil.rmtree(job_dir(job_id), ignore_errors=True)
        store.delete(job_id)
    return Response(status_code=204)


@app.get("/api/status/{job_id}", response_model=StatusResponse)
def status(job_id: str, user: dict[str, str] = Depends(current_user)) -> StatusResponse:
    job = require_job(job_id, user["id"])
    stems = [
        StemLink(name=s, url=f"/api/download/{job_id}/{s}") for s in job["stems"] if s in STEMS
    ]
    return StatusResponse(
        job_id=job_id,
        filename=job["filename"],
        status=job["status"],
        progress=job["progress"],
        stage=job["stage"],
        error=job["error"],
        stems=stems,
    )


@app.get("/api/download/{job_id}/{track_name}")
def download(
    job_id: str,
    track_name: str,
    as_attachment: bool = False,
    user: dict[str, str] = Depends(current_user),
) -> FileResponse:
    """Stream one stem (`vocals`, `drums`, `bass`, `other`) or all of them (`all` -> ZIP)."""
    job = require_job(job_id, user["id"])
    if job["status"] != "done":
        raise HTTPException(409, "ยังประมวลผลไม่เสร็จ")

    disposition = "attachment" if as_attachment else "inline"
    base = safe_base_name(job["filename"])

    if track_name == "all":
        return FileResponse(
            build_zip(job_id, job["filename"]),
            media_type="application/zip",
            filename=f"{base}_stems.zip",
            content_disposition_type="attachment",
        )

    stem = track_name.removesuffix(".wav")
    if stem not in STEMS:  # whitelist: no user text ever reaches the filesystem path
        raise HTTPException(404, "ไม่พบแทร็กนี้")
    return FileResponse(
        job_dir(job_id) / "stems" / f"{stem}.wav",
        media_type="audio/wav",
        filename=f"{base}_{stem}.wav",
        content_disposition_type=disposition,
    )

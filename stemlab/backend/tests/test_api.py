import io
import math
import sqlite3
import struct
import sys
import time
import wave
import zipfile
from pathlib import Path

import fakeredis
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import main, separators, tasks  # noqa: E402
from app.auth import auth_store  # noqa: E402
from app.config import STEMS, settings  # noqa: E402
from app.store import store  # noqa: E402

FAKE_DEMUCS = str(Path(__file__).parent / "fake_demucs")


def make_wav(seconds: float = 1.5, sr: int = 22050) -> bytes:
    """Stereo test tone: 80 Hz bass + 1 kHz mid + 9 kHz hiss-like top."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = bytearray()
        for i in range(int(seconds * sr)):
            t = i / sr
            v = 0.3 * math.sin(2 * math.pi * 80 * t) + 0.3 * math.sin(2 * math.pi * 1000 * t)
            v += 0.2 * math.sin(2 * math.pi * 9000 * t)
            s = int(max(-1, min(1, v)) * 32767)
            frames += struct.pack("<hh", s, s)
        w.writeframes(bytes(frames))
    return buf.getvalue()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_dir", tmp_path)
    monkeypatch.setattr(settings, "separator", "mock")
    monkeypatch.setattr(store, "_client", fakeredis.FakeRedis(decode_responses=True))
    queued: list[str] = []
    monkeypatch.setattr(main.separate_task, "delay", lambda job_id: queued.append(job_id))
    with TestClient(main.app) as c:
        registered = c.post(
            "/api/auth/register",
            json={
                "email": "test@example.com",
                "username": "testuser",
                "password": "correct horse battery1",
            },
        )
        assert registered.status_code == 201
        c.queued = queued  # type: ignore[attr-defined]
        yield c


def upload(client, data: bytes, name: str = "song.wav"):
    return client.post("/api/upload", files={"file": (name, data, "audio/wav")})


def test_rejects_unsupported_extension(client):
    r = upload(client, b"hello", "notes.txt")
    assert r.status_code == 415


def test_registration_login_and_logout(client):
    assert client.get("/api/auth/me").json()["email"] == "test@example.com"
    token = client.cookies.get("stemlab_session")
    assert token
    with sqlite3.connect(Path(settings.storage_dir) / "users.sqlite3") as db:
        password_hash = db.execute("SELECT password_hash FROM users").fetchone()[0]
        saved_session = db.execute("SELECT token_hash FROM sessions").fetchone()[0]
    assert "correct horse battery1" not in password_hash
    assert token not in saved_session
    assert len(saved_session) == 64
    assert client.post(
        "/api/auth/register",
        json={
            "email": "TEST@example.com",
            "username": "otheruser",
            "password": "correct horse battery1",
        },
    ).status_code == 409
    assert client.post(
        "/api/auth/login",
        json={"identifier": "test@example.com", "password": "incorrect password"},
    ).status_code == 401
    assert client.post(
        "/api/auth/logout",
        headers={"Origin": "https://untrusted.example"},
    ).status_code == 403
    assert client.get("/api/auth/me").status_code == 200
    assert client.post("/api/auth/logout").status_code == 204
    assert client.get("/api/auth/me").status_code == 401
    assert client.post(
        "/api/auth/login",
        json={"identifier": "TEST@example.com", "password": "correct horse battery1"},
    ).status_code == 200
    assert client.get("/api/auth/me").json()["email"] == "test@example.com"
    client.post("/api/auth/logout")
    assert client.post(
        "/api/auth/login",
        json={"identifier": "TESTUSER", "password": "correct horse battery1"},
    ).status_code == 200


@pytest.mark.parametrize("password", ["letters only password", "123456789012", "short1"])
def test_registration_requires_password_with_letters_and_digits(client, password):
    response = client.post(
        "/api/auth/register",
        json={"email": "weak@example.com", "username": "weakuser", "password": password},
    )
    assert response.status_code == 422


def test_registration_accepts_letters_and_digits_in_password(client):
    response = client.post(
        "/api/auth/register",
        json={"email": "strong@example.com", "username": "stronguser", "password": "learning2026"},
    )
    assert response.status_code == 201


def test_registration_rejects_invalid_or_duplicate_username(client):
    invalid = client.post(
        "/api/auth/register",
        json={"email": "invalid@example.com", "username": "bad user", "password": "learning2026"},
    )
    assert invalid.status_code == 422
    duplicate = client.post(
        "/api/auth/register",
        json={"email": "duplicate@example.com", "username": "TESTUSER", "password": "learning2026"},
    )
    assert duplicate.status_code == 409


def test_username_can_be_updated_and_used_to_login(client):
    response = client.put("/api/auth/username", json={"username": "New_User2026"})
    assert response.status_code == 200
    assert response.json()["username"] == "new_user2026"
    assert client.get("/api/auth/me").json()["username"] == "new_user2026"

    client.post("/api/auth/logout")
    login = client.post(
        "/api/auth/login",
        json={"identifier": "NEW_USER2026", "password": "correct horse battery1"},
    )
    assert login.status_code == 200
    assert login.json()["username"] == "new_user2026"


def test_username_update_rejects_invalid_duplicate_and_unauthenticated(client):
    untrusted_origin = client.put(
        "/api/auth/username",
        json={"username": "newuser"},
        headers={"Origin": "https://untrusted.example"},
    )
    assert untrusted_origin.status_code == 403

    invalid = client.put("/api/auth/username", json={"username": "not a username"})
    assert invalid.status_code == 422

    with TestClient(main.app) as other:
        assert other.post(
            "/api/auth/register",
            json={
                "email": "other@example.com",
                "username": "otheruser",
                "password": "another safe password2",
            },
        ).status_code == 201
    duplicate = client.put("/api/auth/username", json={"username": "OTHERUSER"})
    assert duplicate.status_code == 409

    client.post("/api/auth/logout")
    assert client.put("/api/auth/username", json={"username": "newuser"}).status_code == 401


def test_jobs_require_login_and_are_private_to_their_owner(client):
    job_id = upload(client, make_wav()).json()["job_id"]

    with TestClient(main.app) as other:
        assert other.post(
            "/api/auth/register",
            json={
                "email": "other@example.com",
                "username": "otheruser",
                "password": "another safe password2",
            },
        ).status_code == 201
        assert other.get(f"/api/status/{job_id}").status_code == 404
        assert other.post(f"/api/process/{job_id}").status_code == 404
        assert other.get(f"/api/download/{job_id}/vocals").status_code == 404
        assert other.get("/api/history").json() == []

    client.post("/api/auth/logout")
    assert upload(client, make_wav()).status_code == 401
    assert client.get("/api/history").status_code == 401


def test_expired_job_cannot_be_reopened_from_history(client):
    job_id = upload(client, make_wav(), "expired.wav").json()["job_id"]
    client.post(f"/api/process/{job_id}")
    tasks.separate_task.run(job_id)

    expired_at = time.time() - settings.job_ttl_hours * 3600 - 1
    store.update(job_id, created_at=expired_at)
    auth_store.update_job_history(job_id, status="done")
    with sqlite3.connect(Path(settings.storage_dir) / "users.sqlite3") as db:
        db.execute("UPDATE job_history SET created_at = ? WHERE job_id = ?", (expired_at, job_id))

    item = next(entry for entry in client.get("/api/history").json() if entry["job_id"] == job_id)
    assert item["available"] is False
    assert client.get(f"/api/status/{job_id}").status_code == 404


def test_rejects_fake_audio_content(client):
    r = upload(client, b"MZ\x90\x00" + b"\x00" * 100, "virus.mp3")
    assert r.status_code == 415


def test_rejects_empty_and_oversized(client, monkeypatch):
    assert upload(client, b"", "empty.wav").status_code == 415  # no magic bytes
    monkeypatch.setattr(settings, "max_upload_mb", 0)
    assert upload(client, make_wav()).status_code == 413
    # failed uploads must not leave folders behind
    assert not [path for path in Path(settings.storage_dir).iterdir() if path.is_dir()]


def test_full_flow_with_mock_separator(client):
    r = upload(client, make_wav(), "My Song.wav")
    assert r.status_code == 201
    job_id = r.json()["job_id"]
    assert client.get(f"/api/status/{job_id}").json()["status"] == "uploaded"
    assert client.get("/api/history").json() == []

    # downloads are blocked until processing finished
    assert client.get(f"/api/download/{job_id}/vocals").status_code == 409

    assert client.post(f"/api/process/{job_id}").status_code == 202
    assert client.queued == [job_id]
    assert client.get(f"/api/status/{job_id}").json()["status"] == "queued"
    # a second request must not enqueue the job twice
    assert client.post(f"/api/process/{job_id}").status_code == 409
    assert client.queued == [job_id]

    tasks.separate_task.run(job_id)  # what the Celery worker would do

    status = client.get(f"/api/status/{job_id}").json()
    assert status["status"] == "done" and status["progress"] == 100
    assert [s["name"] for s in status["stems"]] == list(STEMS)

    history = client.get("/api/history").json()
    item = next(entry for entry in history if entry["job_id"] == job_id)
    assert item["filename"] == "My Song.wav"
    assert item["status"] == "done"
    assert item["created_at"] > 0
    assert item["completed_at"] >= item["created_at"]
    assert item["stems"] == list(STEMS)
    assert item["available"] is True

    for stem in STEMS:
        r = client.get(f"/api/download/{job_id}/{stem}")
        assert r.status_code == 200
        assert r.headers["content-type"] == "audio/wav"
        with wave.open(io.BytesIO(r.content)) as w:
            assert w.getnchannels() == 2 and w.getnframes() > 0

    r = client.get(f"/api/download/{job_id}/all")
    assert r.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert names == [f"My Song_{s}.wav" for s in STEMS]

    # History is retained in SQLite even after the temporary Redis job expires.
    store.client.delete(store._key(job_id))
    retained = client.get("/api/history").json()
    retained_item = next(entry for entry in retained if entry["job_id"] == job_id)
    assert retained_item["available"] is False


def test_cancelling_uploaded_job_does_not_create_history(client):
    job_id = upload(client, make_wav()).json()["job_id"]

    response = client.delete(f"/api/jobs/{job_id}")

    assert response.status_code == 204
    assert client.get("/api/history").json() == []
    assert client.get(f"/api/status/{job_id}").status_code == 404
    assert not (Path(settings.storage_dir) / job_id).exists()


def test_cancelling_queued_job_removes_history_and_worker_cleans_up(client):
    job_id = upload(client, make_wav()).json()["job_id"]
    assert client.post(f"/api/process/{job_id}").status_code == 202
    assert len(client.get("/api/history").json()) == 1

    response = client.delete(f"/api/jobs/{job_id}")
    assert response.status_code == 204
    assert client.get("/api/history").json() == []

    tasks.separate_task.run(job_id)
    assert client.get(f"/api/status/{job_id}").status_code == 404
    assert not (Path(settings.storage_dir) / job_id).exists()


def test_unknown_job_and_traversal(client):
    assert client.get("/api/status/" + "0" * 32).status_code == 404
    assert client.get("/api/status/not-a-job").status_code == 404
    job_id = upload(client, make_wav()).json()["job_id"]
    client.post(f"/api/process/{job_id}")
    tasks.separate_task.run(job_id)
    assert client.get(f"/api/download/{job_id}/..%2F..%2Fetc%2Fpasswd").status_code == 404
    assert client.get(f"/api/download/{job_id}/guitar").status_code == 404


def test_queue_down_marks_job_failed(client, monkeypatch):
    def boom(_):
        raise ConnectionError("redis down")

    monkeypatch.setattr(main.separate_task, "delay", boom)
    job_id = upload(client, make_wav()).json()["job_id"]
    assert client.post(f"/api/process/{job_id}").status_code == 503
    assert client.get(f"/api/status/{job_id}").json()["status"] == "failed"


def test_failed_separation_reports_error(client, monkeypatch):
    monkeypatch.setattr(settings, "separator", "nope")
    job_id = upload(client, make_wav()).json()["job_id"]
    client.post(f"/api/process/{job_id}")
    tasks.separate_task.run(job_id)
    status = client.get(f"/api/status/{job_id}").json()
    assert status["status"] == "failed" and "Unknown SEPARATOR" in status["error"]


def test_mock_stems_split_frequency_bands(client):
    import numpy as np
    import soundfile as sf

    job_id = upload(client, make_wav(2.0)).json()["job_id"]
    client.post(f"/api/process/{job_id}")
    tasks.separate_task.run(job_id)

    def dominant_hz(stem: str) -> float:
        data, sr = sf.read(str(settings.storage_dir / job_id / "stems" / f"{stem}.wav"))
        spectrum = np.abs(np.fft.rfft(data[:, 0]))
        return float(np.fft.rfftfreq(len(data), 1 / sr)[spectrum.argmax()])

    assert dominant_hz("bass") < 150
    assert 800 < dominant_hz("vocals") < 1200
    assert dominant_hz("drums") > 6000


def test_demucs_wrapper_parses_progress_and_collects_stems(tmp_path, monkeypatch):
    monkeypatch.setenv("PYTHONPATH", FAKE_DEMUCS)
    monkeypatch.setattr(settings, "demucs_device", "cpu")
    src = tmp_path / "input.wav"
    src.write_bytes(make_wav(0.2))
    seen: list[int] = []
    out = tmp_path / "stems"

    separators.run_demucs(src, out, lambda pct, _stage: seen.append(pct))

    assert sorted(p.name for p in out.iterdir()) == sorted(f"{s}.wav" for s in STEMS)
    assert seen == sorted(seen)  # progress never goes backwards
    assert {5, 27, 50, 72, 95, 97} <= set(seen)  # 0/25/50/75/100% mapped onto 5-95
    assert not (tmp_path / "_demucs").exists()  # scratch folder cleaned up


def test_demucs_wrapper_surfaces_failure(tmp_path, monkeypatch):
    monkeypatch.setenv("PYTHONPATH", FAKE_DEMUCS)
    monkeypatch.setenv("FAKE_DEMUCS_FAIL", "1")
    src = tmp_path / "input.wav"
    src.write_bytes(make_wav(0.2))
    with pytest.raises(RuntimeError, match="out of memory"):
        separators.run_demucs(src, tmp_path / "stems", lambda *_: None)

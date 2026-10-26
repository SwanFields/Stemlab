"""SQLite-backed user accounts and opaque browser sessions."""
import hashlib
import hmac
import json
import secrets
import sqlite3
import time
import uuid
from pathlib import Path

from .config import settings

SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
PASSWORD_ITERATIONS = 310_000


class AuthStore:
    def __init__(self) -> None:
        self._db_path: Path | None = None

    def initialize(self) -> None:
        path = settings.storage_dir / "users.sqlite3"
        if self._db_path == path and path.is_file():
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    username TEXT,
                    password_hash TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
                CREATE TABLE IF NOT EXISTS job_history (
                    job_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    filename TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    completed_at REAL,
                    stems TEXT NOT NULL DEFAULT '[]'
                );
                CREATE INDEX IF NOT EXISTS job_history_user_date_idx
                ON job_history(user_id, created_at DESC);
                """
            )
            columns = {row[1] for row in db.execute("PRAGMA table_info(users)")}
            if "username" not in columns:
                db.execute("ALTER TABLE users ADD COLUMN username TEXT")
            db.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique "
                "ON users(username COLLATE NOCASE) WHERE username IS NOT NULL"
            )
        self._db_path = path

    def _connect(self) -> sqlite3.Connection:
        if self._db_path is None:
            raise RuntimeError("Auth store has not been initialized")
        db = sqlite3.connect(self._db_path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        return db

    @staticmethod
    def _hash_password(password: str, salt: bytes | None = None) -> str:
        actual_salt = salt or secrets.token_bytes(16)
        derived = hashlib.pbkdf2_hmac("sha256", password.encode(), actual_salt, PASSWORD_ITERATIONS)
        return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${actual_salt.hex()}${derived.hex()}"

    @staticmethod
    def _session_hash(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def create_user(self, email: str, username: str, password: str) -> dict[str, str] | None:
        user_id = uuid.uuid4().hex
        try:
            with self._connect() as db:
                db.execute(
                    "INSERT INTO users (id, email, username, password_hash, created_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (user_id, email, username, self._hash_password(password), int(time.time())),
                )
        except sqlite3.IntegrityError:
            return None
        return {"id": user_id, "email": email, "username": username}

    def verify_user(self, identifier: str, password: str) -> dict[str, str] | None:
        with self._connect() as db:
            user = db.execute(
                "SELECT id, email, username, password_hash FROM users "
                "WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE",
                (identifier, identifier),
            ).fetchone()
        if user is None:
            return None
        algorithm, rounds, salt_hex, expected_hex = user["password_hash"].split("$", 3)
        if algorithm != "pbkdf2_sha256" or int(rounds) != PASSWORD_ITERATIONS:
            return None
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt_hex), PASSWORD_ITERATIONS
        ).hex()
        if not hmac.compare_digest(actual, expected_hex):
            return None
        return {"id": user["id"], "email": user["email"], "username": user["username"] or ""}

    def update_username(self, user_id: str, username: str) -> dict[str, str] | None:
        try:
            with self._connect() as db:
                db.execute("UPDATE users SET username = ? WHERE id = ?", (username, user_id))
                user = db.execute(
                    "SELECT id, email, username FROM users WHERE id = ?", (user_id,)
                ).fetchone()
        except sqlite3.IntegrityError:
            return None
        if user is None:
            return None
        return {"id": user["id"], "email": user["email"], "username": user["username"] or ""}

    def create_session(self, user_id: str) -> str:
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        with self._connect() as db:
            db.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            db.execute(
                "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                (self._session_hash(token), user_id, now + SESSION_TTL_SECONDS),
            )
        return token

    def get_session_user(self, token: str | None) -> dict[str, str] | None:
        if not token:
            return None
        with self._connect() as db:
            row = db.execute(
                """
                SELECT users.id, users.email, users.username FROM sessions
                JOIN users ON users.id = sessions.user_id
                WHERE sessions.token_hash = ? AND sessions.expires_at > ?
                """,
                (self._session_hash(token), int(time.time())),
            ).fetchone()
        return {"id": row["id"], "email": row["email"], "username": row["username"] or ""} if row else None

    def delete_session(self, token: str | None) -> None:
        if not token:
            return
        with self._connect() as db:
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (self._session_hash(token),))

    def record_job(
        self,
        job_id: str,
        user_id: str,
        filename: str,
        created_at: float,
        status: str = "uploaded",
    ) -> None:
        self.initialize()
        with self._connect() as db:
            db.execute(
                """
                INSERT INTO job_history (job_id, user_id, filename, status, created_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(job_id) DO UPDATE SET status = excluded.status
                """,
                (job_id, user_id, filename, status, created_at),
            )

    def update_job_history(
        self,
        job_id: str,
        status: str,
        completed_at: float | None = None,
        stems: tuple[str, ...] | list[str] | None = None,
    ) -> None:
        self.initialize()
        assignments = ["status = ?"]
        values: list[object] = [status]
        if completed_at is not None:
            assignments.append("completed_at = ?")
            values.append(completed_at)
        if stems is not None:
            assignments.append("stems = ?")
            values.append(json.dumps(stems))
        values.append(job_id)
        with self._connect() as db:
            db.execute(
                f"UPDATE job_history SET {', '.join(assignments)} WHERE job_id = ?",
                values,
            )

    def delete_job_history(self, job_id: str) -> None:
        self.initialize()
        with self._connect() as db:
            db.execute("DELETE FROM job_history WHERE job_id = ?", (job_id,))

    def list_job_history(self, user_id: str, limit: int = 100) -> list[dict[str, object]]:
        self.initialize()
        with self._connect() as db:
            rows = db.execute(
                """
                SELECT job_id, filename, status, created_at, completed_at, stems
                FROM job_history
                WHERE user_id = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (user_id, limit),
            ).fetchall()
        return [
            {
                "job_id": row["job_id"],
                "filename": row["filename"],
                "status": row["status"],
                "created_at": row["created_at"],
                "completed_at": row["completed_at"],
                "stems": json.loads(row["stems"]),
            }
            for row in rows
        ]


auth_store = AuthStore()

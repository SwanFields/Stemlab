"""Database-backed user accounts and opaque browser sessions."""
import hashlib
import hmac
import json
import secrets
import time
import uuid

from sqlalchemy import (
    BigInteger,
    Column,
    Float,
    ForeignKey,
    Integer,
    Index,
    MetaData,
    String,
    Table,
    Text,
    URL,
    create_engine,
    event,
    func,
    inspect,
    select,
    update,
)
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import IntegrityError

from .config import settings

SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
PASSWORD_ITERATIONS = 310_000

metadata = MetaData()
users = Table(
    "users",
    metadata,
    Column("id", String, primary_key=True),
    Column("email", String, nullable=False),
    Column("username", String),
    Column("password_hash", String, nullable=False),
    Column("created_at", BigInteger, nullable=False),
)
sessions = Table(
    "sessions",
    metadata,
    Column("token_hash", String, primary_key=True),
    Column("user_id", String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("expires_at", BigInteger, nullable=False),
)
job_history = Table(
    "job_history",
    metadata,
    Column("job_id", String, primary_key=True),
    Column("user_id", String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("filename", String, nullable=False),
    Column("status", String, nullable=False),
    Column("created_at", Float, nullable=False),
    Column("completed_at", Float),
    Column("stems", Text, nullable=False, server_default="[]"),
    Column("duration_seconds", Float),
)
stem_events = Table(
    "stem_events",
    metadata,
    Column("id", BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True),
    Column("user_id", String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("job_id", String, nullable=False),
    Column("stem", String, nullable=False),
    Column("created_at", Float, nullable=False),
)
Index("users_email_lower_unique", func.lower(users.c.email), unique=True)
Index(
    "users_username_lower_unique",
    func.lower(users.c.username),
    unique=True,
    postgresql_where=users.c.username.is_not(None),
    sqlite_where=users.c.username.is_not(None),
)
Index("sessions_user_id_idx", sessions.c.user_id)
Index("job_history_user_date_idx", job_history.c.user_id, job_history.c.created_at.desc())
Index("stem_events_user_date_idx", stem_events.c.user_id, stem_events.c.created_at)


class AuthStore:
    def __init__(self) -> None:
        self._engine: Engine | None = None
        self._engine_key: str | URL | None = None

    def _database_url(self) -> str | URL:
        if settings.database_url:
            database_url = settings.database_url
            if database_url.startswith("postgresql://"):
                database_url = database_url.replace(
                    "postgresql://", "postgresql+psycopg://", 1
                )
            return database_url
        path = settings.storage_dir / "users.sqlite3"
        path.parent.mkdir(parents=True, exist_ok=True)
        return URL.create("sqlite", database=str(path.resolve()))

    def initialize(self) -> None:
        database_url = self._database_url()
        if self._engine is not None and self._engine_key == database_url:
            return

        if self._engine is not None:
            self._engine.dispose()

        connect_args = {"timeout": 10} if str(database_url).startswith("sqlite") else {}
        engine = create_engine(
            database_url,
            connect_args=connect_args,
            pool_pre_ping=True,
        )
        if engine.dialect.name == "sqlite":
            @event.listens_for(engine, "connect")
            def enable_sqlite_options(dbapi_connection, _connection_record) -> None:
                cursor = dbapi_connection.cursor()
                cursor.execute("PRAGMA foreign_keys=ON")
                cursor.execute("PRAGMA journal_mode=WAL")
                cursor.close()

            # Older SQLite databases may predate the username column.
            with engine.begin() as connection:
                existing_tables = inspect(connection).get_table_names()
                if "users" in existing_tables:
                    columns = {column["name"] for column in inspect(connection).get_columns("users")}
                    if "username" not in columns:
                        connection.exec_driver_sql("ALTER TABLE users ADD COLUMN username TEXT")

        metadata.create_all(engine)
        # Databases created before the stats feature lack job_history.duration_seconds.
        with engine.begin() as connection:
            history_columns = {c["name"] for c in inspect(connection).get_columns("job_history")}
            if "duration_seconds" not in history_columns:
                connection.exec_driver_sql("ALTER TABLE job_history ADD COLUMN duration_seconds FLOAT")
        self._engine = engine
        self._engine_key = database_url

    def _connect(self) -> Connection:
        if self._engine is None:
            raise RuntimeError("Auth store has not been initialized")
        return self._engine.connect()

    @staticmethod
    def _hash_password(password: str, salt: bytes | None = None) -> str:
        actual_salt = salt or secrets.token_bytes(16)
        derived = hashlib.pbkdf2_hmac("sha256", password.encode(), actual_salt, PASSWORD_ITERATIONS)
        return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${actual_salt.hex()}${derived.hex()}"

    @staticmethod
    def _session_hash(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def create_user(self, email: str, username: str, password: str) -> dict[str, str] | None:
        self.initialize()
        user_id = uuid.uuid4().hex
        try:
            with self._connect() as db, db.begin():
                db.execute(
                    users.insert().values(
                        id=user_id,
                        email=email,
                        username=username,
                        password_hash=self._hash_password(password),
                        created_at=int(time.time()),
                    )
                )
        except IntegrityError:
            return None
        return {"id": user_id, "email": email, "username": username}

    def verify_user(self, identifier: str, password: str) -> dict[str, str] | None:
        self.initialize()
        with self._connect() as db:
            user = db.execute(
                select(users.c.id, users.c.email, users.c.username, users.c.password_hash).where(
                    (func.lower(users.c.email) == identifier.lower())
                    | (func.lower(users.c.username) == identifier.lower())
                )
            ).mappings().first()
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
        self.initialize()
        try:
            with self._connect() as db, db.begin():
                db.execute(update(users).where(users.c.id == user_id).values(username=username))
                user = db.execute(
                    select(users.c.id, users.c.email, users.c.username).where(users.c.id == user_id)
                ).mappings().first()
        except IntegrityError:
            return None
        if user is None:
            return None
        return {"id": user["id"], "email": user["email"], "username": user["username"] or ""}

    def create_session(self, user_id: str) -> str:
        self.initialize()
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        with self._connect() as db, db.begin():
            db.execute(sessions.delete().where(sessions.c.expires_at <= now))
            db.execute(
                sessions.insert().values(
                    token_hash=self._session_hash(token),
                    user_id=user_id,
                    expires_at=now + SESSION_TTL_SECONDS,
                )
            )
        return token

    def get_session_user(self, token: str | None) -> dict[str, str] | None:
        if not token:
            return None
        self.initialize()
        with self._connect() as db:
            row = db.execute(
                select(users.c.id, users.c.email, users.c.username)
                .select_from(sessions.join(users, users.c.id == sessions.c.user_id))
                .where(
                    sessions.c.token_hash == self._session_hash(token),
                    sessions.c.expires_at > int(time.time()),
                )
            ).mappings().first()
        return (
            {"id": row["id"], "email": row["email"], "username": row["username"] or ""}
            if row
            else None
        )

    def delete_session(self, token: str | None) -> None:
        if not token:
            return
        self.initialize()
        with self._connect() as db, db.begin():
            db.execute(sessions.delete().where(sessions.c.token_hash == self._session_hash(token)))

    def record_job(
        self,
        job_id: str,
        user_id: str,
        filename: str,
        created_at: float,
        status: str = "uploaded",
        duration_seconds: float | None = None,
    ) -> None:
        self.initialize()
        with self._connect() as db, db.begin():
            existing = db.execute(
                select(job_history.c.job_id).where(job_history.c.job_id == job_id)
            ).first()
            if existing:
                db.execute(
                    update(job_history).where(job_history.c.job_id == job_id).values(status=status)
                )
            else:
                db.execute(
                    job_history.insert().values(
                        job_id=job_id,
                        user_id=user_id,
                        filename=filename,
                        status=status,
                        created_at=created_at,
                        duration_seconds=duration_seconds,
                    )
                )

    def update_job_history(
        self,
        job_id: str,
        status: str,
        completed_at: float | None = None,
        stems: tuple[str, ...] | list[str] | None = None,
    ) -> None:
        self.initialize()
        values: dict[str, object] = {"status": status}
        if completed_at is not None:
            values["completed_at"] = completed_at
        if stems is not None:
            values["stems"] = json.dumps(stems)
        with self._connect() as db, db.begin():
            db.execute(update(job_history).where(job_history.c.job_id == job_id).values(**values))

    def delete_job_history(self, job_id: str) -> None:
        self.initialize()
        with self._connect() as db, db.begin():
            db.execute(job_history.delete().where(job_history.c.job_id == job_id))

    def list_job_history(self, user_id: str, limit: int = 100) -> list[dict[str, object]]:
        self.initialize()
        with self._connect() as db:
            rows = db.execute(
                select(
                    job_history.c.job_id,
                    job_history.c.filename,
                    job_history.c.status,
                    job_history.c.created_at,
                    job_history.c.completed_at,
                    job_history.c.stems,
                )
                .where(job_history.c.user_id == user_id)
                .order_by(job_history.c.created_at.desc())
                .limit(limit)
            ).mappings().all()
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


    # ---------- account management ----------
    def _password_ok(self, db: Connection, user_id: str, password: str) -> bool:
        row = db.execute(select(users.c.password_hash).where(users.c.id == user_id)).first()
        if row is None:
            return False
        try:
            algorithm, rounds, salt_hex, expected_hex = row[0].split("$", 3)
        except ValueError:
            return False
        if algorithm != "pbkdf2_sha256":
            return False
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt_hex), int(rounds)
        ).hex()
        return hmac.compare_digest(actual, expected_hex)

    def change_password(
        self, user_id: str, current_password: str, new_password: str, keep_token: str | None
    ) -> bool:
        """Returns False when the current password is wrong. Other sessions are signed out."""
        self.initialize()
        with self._connect() as db, db.begin():
            if not self._password_ok(db, user_id, current_password):
                return False
            db.execute(
                update(users)
                .where(users.c.id == user_id)
                .values(password_hash=self._hash_password(new_password))
            )
            others = sessions.delete().where(sessions.c.user_id == user_id)
            if keep_token:
                others = others.where(sessions.c.token_hash != self._session_hash(keep_token))
            db.execute(others)
        return True

    def delete_account(self, user_id: str, password: str) -> list[str] | None:
        """Delete the user and everything tied to them.

        Returns the job ids whose files should be removed, or None if the password is wrong.
        """
        self.initialize()
        with self._connect() as db, db.begin():
            if not self._password_ok(db, user_id, password):
                return None
            job_ids = [
                row[0]
                for row in db.execute(
                    select(job_history.c.job_id).where(job_history.c.user_id == user_id)
                )
            ]
            # Explicit deletes so this also works if a database lacks FK cascades.
            db.execute(stem_events.delete().where(stem_events.c.user_id == user_id))
            db.execute(job_history.delete().where(job_history.c.user_id == user_id))
            db.execute(sessions.delete().where(sessions.c.user_id == user_id))
            db.execute(users.delete().where(users.c.id == user_id))
        return job_ids

    # ---------- usage statistics ----------
    def record_stem_downloads(self, user_id: str, job_id: str, stems: list[str]) -> None:
        self.initialize()
        now = time.time()
        with self._connect() as db, db.begin():
            db.execute(
                stem_events.insert(),
                [{"user_id": user_id, "job_id": job_id, "stem": s, "created_at": now} for s in stems],
            )

    def usage_stats(self, user_id: str) -> dict[str, object]:
        """Raw rows for the dashboard; month bucketing is done in Python so it works on SQLite and Postgres."""
        self.initialize()
        with self._connect() as db:
            created = db.execute(select(users.c.created_at).where(users.c.id == user_id)).scalar()
            jobs = db.execute(
                select(
                    job_history.c.created_at,
                    job_history.c.status,
                    job_history.c.duration_seconds,
                ).where(job_history.c.user_id == user_id)
            ).all()
            events = db.execute(
                select(stem_events.c.created_at, stem_events.c.stem).where(
                    stem_events.c.user_id == user_id
                )
            ).all()
        return {"created_at": created, "jobs": jobs, "events": events}


auth_store = AuthStore()

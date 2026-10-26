CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    username TEXT,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
);

CREATE TABLE job_history (
    job_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at REAL NOT NULL,
    completed_at REAL,
    stems TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX sessions_user_id_idx
    ON sessions(user_id);

CREATE INDEX job_history_user_date_idx
    ON job_history(user_id, created_at DESC);

CREATE UNIQUE INDEX users_username_unique
    ON users(username COLLATE NOCASE)
    WHERE username IS NOT NULL;

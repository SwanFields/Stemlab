#!/bin/sh
set -e

celery -A app.celery_app.celery worker --loglevel=info --pool=solo --concurrency=1 &
worker_pid=$!

cleanup() {
    kill "$worker_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"

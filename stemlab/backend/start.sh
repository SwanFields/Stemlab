#!/bin/sh
set -e

export OMP_NUM_THREADS="${OMP_NUM_THREADS:-1}"
export MKL_NUM_THREADS="${MKL_NUM_THREADS:-1}"
export OPENBLAS_NUM_THREADS="${OPENBLAS_NUM_THREADS:-1}"

celery -A app.celery_app.celery worker --loglevel=info --pool=solo --concurrency=1 &
worker_pid=$!

cleanup() {
    kill "$worker_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"

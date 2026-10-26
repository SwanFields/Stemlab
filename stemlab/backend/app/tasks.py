import shutil
import time

from celery.utils.log import get_task_logger

from . import separators
from .auth import auth_store
from .celery_app import celery
from .config import STEMS, settings
from .store import store

logger = get_task_logger(__name__)


def job_dir(job_id: str):
    return settings.storage_dir / job_id


class JobCancelled(Exception):
    pass


def cleanup_cancelled_job(job_id: str) -> None:
    shutil.rmtree(job_dir(job_id), ignore_errors=True)
    store.delete(job_id)


@celery.task(name="stemlab.separate")
def separate_task(job_id: str) -> None:
    job = store.get(job_id)
    if job is None:
        logger.warning("job %s vanished before processing", job_id)
        return
    if job["status"] == "cancelled":
        cleanup_cancelled_job(job_id)
        return
    if not store.transition(
        job_id, "queued", status="processing", progress=1, stage="เริ่มประมวลผล"
    ):
        current = store.get(job_id)
        if current is None or current["status"] == "cancelled":
            cleanup_cancelled_job(job_id)
        return

    input_path = job_dir(job_id) / job["input_file"]
    stems_dir = job_dir(job_id) / "stems"

    def on_progress(pct: int, stage: str) -> None:
        if not store.transition(
            job_id, "processing", status="processing", progress=pct, stage=stage
        ):
            raise JobCancelled

    def is_cancelled() -> bool:
        current = store.get(job_id)
        return current is None or current["status"] == "cancelled"

    try:
        separators.separate(input_path, stems_dir, on_progress)
        if is_cancelled():
            raise JobCancelled
        missing = [s for s in STEMS if not (stems_dir / f"{s}.wav").is_file()]
        if missing:
            raise RuntimeError(f"Missing stems: {', '.join(missing)}")
        completed_at = time.time()
        if not store.transition(
            job_id,
            "processing",
            status="done",
            progress=100,
            stage="เสร็จสิ้น",
            stems=list(STEMS),
            completed_at=completed_at,
            error=None,
        ):
            if is_cancelled():
                raise JobCancelled
            raise RuntimeError("Job state changed before completion")
        auth_store.update_job_history(
            job_id,
            status="done",
            completed_at=completed_at,
            stems=list(STEMS),
        )
    except JobCancelled:
        cleanup_cancelled_job(job_id)
    except Exception as exc:  # noqa: BLE001 - report any failure to the user
        if is_cancelled():
            cleanup_cancelled_job(job_id)
            return
        logger.exception("separation failed for job %s", job_id)
        store.update(job_id, status="failed", stage="ประมวลผลไม่สำเร็จ", error=str(exc)[:500])
        auth_store.update_job_history(job_id, status="failed")

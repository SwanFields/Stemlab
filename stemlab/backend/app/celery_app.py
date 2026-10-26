from celery import Celery

from .config import settings

celery = Celery("stemlab", broker=settings.redis_url, include=["app.tasks"])

celery.conf.update(
    task_serializer="json",
    accept_content=["json"],
    task_ignore_result=True,  # job state lives in our own Redis hash (app/store.py)
    worker_prefetch_multiplier=1,  # one heavy job at a time per worker process
    task_acks_late=True,
    task_time_limit=60 * 30,
    broker_connection_retry_on_startup=True,
)

"""Job state kept in Redis, shared by the API process and the Celery worker."""
import json
import time
from typing import Any

import redis

from .config import settings


class JobStore:
    def __init__(self, client: Any = None) -> None:
        self._client = client

    @property
    def client(self) -> Any:
        if self._client is None:
            self._client = redis.Redis.from_url(settings.redis_url, decode_responses=True)
        return self._client

    @client.setter
    def client(self, value: Any) -> None:
        self._client = value

    @staticmethod
    def _key(job_id: str) -> str:
        return f"stemlab:job:{job_id}"

    @staticmethod
    def _encode(fields: dict[str, Any]) -> dict[str, str]:
        out: dict[str, str] = {}
        for key, value in fields.items():
            if value is None:
                out[key] = ""
            elif isinstance(value, (list, dict)):
                out[key] = json.dumps(value, ensure_ascii=False)
            else:
                out[key] = str(value)
        return out

    def create(self, job_id: str, **fields: Any) -> None:
        data = {
            "status": "uploaded",
            "progress": 0,
            "stage": "อัปโหลดไฟล์แล้ว",
            "error": None,
            "stems": [],
            "created_at": time.time(),
            **fields,
        }
        key = self._key(job_id)
        pipe = self.client.pipeline()
        pipe.hset(key, mapping=self._encode(data))
        pipe.expire(key, settings.job_ttl_hours * 3600 + 3600)
        pipe.execute()

    def get(self, job_id: str) -> dict[str, Any] | None:
        raw = self.client.hgetall(self._key(job_id))
        if not raw:
            return None
        return {
            "job_id": job_id,
            "filename": raw.get("filename", ""),
            "input_file": raw.get("input_file", ""),
            "user_id": raw.get("user_id", ""),
            "created_at": float(raw.get("created_at") or 0),
            "status": raw.get("status", "uploaded"),
            "progress": int(float(raw.get("progress") or 0)),
            "stage": raw.get("stage", ""),
            "error": raw.get("error") or None,
            "stems": json.loads(raw.get("stems") or "[]"),
        }

    def update(self, job_id: str, **fields: Any) -> None:
        self.client.hset(self._key(job_id), mapping=self._encode(fields))

    def delete(self, job_id: str) -> None:
        self.client.delete(self._key(job_id))

    def transition(self, job_id: str, expected: str, **fields: Any) -> bool:
        """Atomically change status away from `expected`.

        Returns False if the job was not in that state, so two concurrent
        POST /process calls cannot both enqueue the same job.
        """
        key = self._key(job_id)
        with self.client.pipeline() as pipe:
            try:
                pipe.watch(key)
                if pipe.hget(key, "status") != expected:
                    pipe.unwatch()
                    return False
                pipe.multi()
                pipe.hset(key, mapping=self._encode(fields))
                pipe.execute()
                return True
            except redis.WatchError:
                return False


store = JobStore()

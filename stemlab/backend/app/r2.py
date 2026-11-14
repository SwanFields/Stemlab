"""Cloudflare R2 (S3-compatible) Object Storage client for Stemlab."""
import logging
import os
from pathlib import Path
from typing import Any

from .config import STEMS, settings

logger = logging.getLogger(__name__)

_s3_client: Any = None


def is_r2_configured() -> bool:
    """Check if Cloudflare R2 credentials are fully configured."""
    endpoint = settings.r2_endpoint_url or os.getenv("R2_ENDPOINT_URL")
    access_key = settings.r2_access_key_id or os.getenv("R2_ACCESS_KEY_ID")
    secret_key = settings.r2_secret_access_key or os.getenv("R2_SECRET_ACCESS_KEY")
    return bool(endpoint and access_key and secret_key)


def get_r2_client() -> Any:
    """Get or initialize the S3/R2 client."""
    global _s3_client
    if _s3_client is not None:
        return _s3_client

    if not is_r2_configured():
        return None

    try:
        import boto3  # type: ignore
        from botocore.config import Config  # type: ignore

        endpoint = (settings.r2_endpoint_url or os.getenv("R2_ENDPOINT_URL", "")).strip()
        access_key = (settings.r2_access_key_id or os.getenv("R2_ACCESS_KEY_ID", "")).strip()
        secret_key = (settings.r2_secret_access_key or os.getenv("R2_SECRET_ACCESS_KEY", "")).strip()

        _s3_client = boto3.client(
            service_name="s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name="auto",
            config=Config(signature_version="s3v4"),
        )
        return _s3_client
    except Exception as exc:
        logger.error("Failed to initialize Cloudflare R2 client: %s", exc)
        return None


def get_bucket_name() -> str:
    return (settings.r2_bucket_name or os.getenv("R2_BUCKET_NAME") or "stemlab-audio").strip()


def upload_file(local_path: Path | str, object_key: str, content_type: str = "audio/wav") -> bool:
    """Upload a local file to Cloudflare R2."""
    client = get_r2_client()
    if client is None:
        return False

    path = Path(local_path)
    if not path.is_file():
        logger.warning("R2 upload failed: file %s does not exist", path)
        return False

    try:
        extra_args = {"ContentType": content_type}
        client.upload_file(str(path), get_bucket_name(), object_key, ExtraArgs=extra_args)
        logger.info("Uploaded %s to R2 as %s", path.name, object_key)
        return True
    except Exception as exc:
        logger.error("Error uploading %s to R2: %s", object_key, exc)
        return False


def upload_job_stems(job_id: str, stems_dir: Path) -> list[str]:
    """Upload all separated stems in stems_dir to R2 under {job_id}/{stem}.wav."""
    if not is_r2_configured():
        return []

    uploaded = []
    for stem in STEMS:
        stem_path = stems_dir / f"{stem}.wav"
        if stem_path.is_file():
            key = f"{job_id}/{stem}.wav"
            if upload_file(stem_path, key, content_type="audio/wav"):
                uploaded.append(stem)
    return uploaded


def get_presigned_download_url(
    object_key: str,
    expires_in: int = 3600,
    download_filename: str | None = None,
) -> str | None:
    """Generate a presigned download URL for direct browser access."""
    client = get_r2_client()
    if client is None:
        return None

    try:
        params: dict[str, Any] = {
            "Bucket": get_bucket_name(),
            "Key": object_key,
        }
        if download_filename:
            params["ResponseContentDisposition"] = f'attachment; filename="{download_filename}"'

        url = client.generate_presigned_url(
            ClientMethod="get_object",
            Params=params,
            ExpiresIn=expires_in,
        )
        return str(url)
    except Exception as exc:
        logger.error("Error generating presigned URL for %s: %s", object_key, exc)
        return None


def download_file_bytes(object_key: str) -> bytes | None:
    """Download an object from R2 and return its bytes."""
    client = get_r2_client()
    if client is None:
        return None

    try:
        response = client.get_object(Bucket=get_bucket_name(), Key=object_key)
        body = response["Body"].read()
        return bytes(body)
    except Exception as exc:
        logger.error("Error downloading %s from R2: %s", object_key, exc)
        return None


def download_file(object_key: str, dest_path: Path) -> bool:
    """Download an object from R2 directly to a local file path."""
    client = get_r2_client()
    if client is None:
        return False

    try:
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        client.download_file(get_bucket_name(), object_key, str(dest_path))
        return True
    except Exception as exc:
        logger.error("Error downloading %s to %s: %s", object_key, dest_path, exc)
        return False


def stem_exists(job_id: str, stem_name: str) -> bool:
    """Check if a stem object exists in R2."""
    client = get_r2_client()
    if client is None:
        return False

    key = f"{job_id}/{stem_name}.wav"
    try:
        client.head_object(Bucket=get_bucket_name(), Key=key)
        return True
    except Exception:
        return False


def delete_job_files(job_id: str) -> None:
    """Delete all objects related to a job in R2."""
    client = get_r2_client()
    if client is None:
        return

    try:
        # List objects with prefix {job_id}/
        bucket = get_bucket_name()
        res = client.list_objects_v2(Bucket=bucket, Prefix=f"{job_id}/")
        objects = res.get("Contents", [])
        if objects:
            delete_keys = [{"Key": obj["Key"]} for obj in objects]
            client.delete_objects(Bucket=bucket, Delete={"Objects": delete_keys})
            logger.info("Deleted %d objects for job %s from R2", len(delete_keys), job_id)
    except Exception as exc:
        logger.error("Error deleting job %s files from R2: %s", job_id, exc)

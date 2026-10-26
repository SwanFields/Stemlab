export type JobStatus = "uploaded" | "queued" | "processing" | "done" | "failed";

export interface StemInfo {
  name: string;
  url: string;
}

export interface JobInfo {
  job_id: string;
  filename: string;
  status: JobStatus;
  progress: number;
  stage: string;
  error: string | null;
  stems: StemInfo[];
}

export interface Health {
  status: string;
  separator: string;
  model: string;
  max_upload_mb: number;
}

export interface User {
  id: string;
  email: string;
  username: string;
}

export interface HistoryItem {
  job_id: string;
  filename: string;
  status: JobStatus;
  created_at: number;
  completed_at: number | null;
  stems: string[];
  available: boolean;
}

const BASE: string = import.meta.env.VITE_API_BASE ?? "";
const NETWORK_MESSAGE = "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบว่า Backend ทำงานอยู่";

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, credentials: "include" });
  } catch {
    throw new ApiError(NETWORK_MESSAGE);
  }
  if (!res.ok) {
    let message = `เซิร์ฟเวอร์ตอบกลับผิดพลาด (${res.status})`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === "string") message = body.detail;
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const register = (email: string, username: string, password: string) =>
  request<User>("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, username, password }),
  });

export const login = (identifier: string, password: string) =>
  request<User>("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });

export const getCurrentUser = () => request<User>("/api/auth/me");

export const updateUsername = (username: string) =>
  request<User>("/api/auth/username", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });

export const getHistory = () => request<HistoryItem[]>("/api/history");

export const logout = () => request<void>("/api/auth/logout", { method: "POST" });

/** POST /api/upload with upload progress (fetch cannot report that, XHR can). */
export function uploadFile(
  file: File,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
): Promise<{ job_id: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}/api/upload`);
    xhr.withCredentials = true;
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as { job_id: string });
      } else {
        const detail = (xhr.response as { detail?: unknown } | null)?.detail;
        reject(new ApiError(typeof detail === "string" ? detail : `อัปโหลดไม่สำเร็จ (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new ApiError(NETWORK_MESSAGE));
    xhr.onabort = () => reject(new ApiError("ยกเลิกการอัปโหลดแล้ว"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });

    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export const startProcessing = (jobId: string) =>
  request<{ job_id: string }>(`/api/process/${jobId}`, { method: "POST" });

export const cancelJob = (jobId: string) =>
  request<void>(`/api/jobs/${jobId}`, { method: "DELETE" });

export const getStatus = (jobId: string) => request<JobInfo>(`/api/status/${jobId}`);

export const getHealth = () => request<Health>("/api/health");

export const stemUrl = (jobId: string, name: string) => `${BASE}/api/download/${jobId}/${name}`;

/** Same file, but the server asks the browser to save it instead of playing it. */
export const downloadUrl = (jobId: string, name: string) => `${stemUrl(jobId, name)}?as_attachment=true`;

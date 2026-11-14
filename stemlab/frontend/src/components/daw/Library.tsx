import { useEffect, useRef, useState, type DragEvent } from "react";
import { getHistory, type HistoryItem } from "../../api";
import type { DawSource } from "../../audio/DawEngine";
import { useLanguage } from "../Language";
import { formatDuration } from "./dawUtils";

interface Props {
  sources: DawSource[];
  auditioning: string | null;
  busy: string | null;
  usedIds: Set<string>;
  onFiles: (files: File[]) => void;
  onLoadJob: (job: HistoryItem, place: boolean) => void;
  onAudition: (id: string) => void;
  onAddToTimeline: (id: string) => void;
  onBpm: (id: string, bpm: number) => void;
  onRemove: (id: string) => void;
  onDragSource: (id: string | null) => void;
}

export default function Library({
  sources,
  auditioning,
  busy,
  usedIds,
  onFiles,
  onLoadJob,
  onAudition,
  onAddToTimeline,
  onBpm,
  onRemove,
  onDragSource,
}: Props) {
  const { t } = useLanguage();
  const [jobs, setJobs] = useState<HistoryItem[] | null>(null);
  const [jobsError, setJobsError] = useState(false);
  const [jobId, setJobId] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const [overDrop, setOverDrop] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getHistory()
      .then((items) => {
        if (cancelled) return;
        const ready = items.filter((i) => i.status === "done" && i.available);
        setJobs(ready);
        setJobId((current) => current || ready[0]?.job_id || "");
      })
      .catch(() => {
        if (!cancelled) setJobsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedJob = jobs?.find((j) => j.job_id === jobId) ?? null;

  const onDropFiles = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOverDrop(false);
    const files = Array.from(event.dataTransfer.files).filter((f) => f.type.startsWith("audio/") || /\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(f.name));
    if (files.length) onFiles(files);
  };

  return (
    <aside className="daw-library" aria-label={t("คลังเสียง", "Sound library")}>
      <section className="daw-lib-section">
        <h3 className="daw-lib-title">{t("สเตมจาก Stemlab", "Stems from Stemlab")}</h3>
        {jobsError && <p className="daw-lib-note">{t("เข้าสู่ระบบเพื่อดึงสเตมที่แยกไว้ หรือใช้ไฟล์ของคุณเองด้านล่าง", "Log in to use your separated stems, or add your own files below.")}</p>}
        {jobs && jobs.length === 0 && <p className="daw-lib-note">{t("ยังไม่มีสเตมที่พร้อมใช้งาน แยกเพลงก่อนที่หน้าสตูดิโอ", "No stems available yet. Separate a song in the studio first.")}</p>}
        {jobs && jobs.length > 0 && (
          <>
            <select className="daw-select daw-lib-select" value={jobId} onChange={(e) => setJobId(e.target.value)} aria-label={t("เลือกเพลง", "Choose a song")}>
              {jobs.map((j) => (
                <option key={j.job_id} value={j.job_id}>{j.filename}</option>
              ))}
            </select>
            <div className="daw-lib-actions">
              <button type="button" className="daw-btn" disabled={!selectedJob || busy !== null} onClick={() => selectedJob && onLoadJob(selectedJob, false)}>
                {t("โหลดสเตม", "Load stems")}
              </button>
              <button type="button" className="daw-btn daw-btn-accent" disabled={!selectedJob || busy !== null} onClick={() => selectedJob && onLoadJob(selectedJob, true)}>
                {t("โหลดและวางลงแทร็ก", "Load & place")}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="daw-lib-section">
        <h3 className="daw-lib-title">{t("ไฟล์ของคุณ", "Your files")}</h3>
        <div
          className={`daw-dropzone${overDrop ? " is-over" : ""}`}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setOverDrop(true);
            }
          }}
          onDragLeave={() => setOverDrop(false)}
          onDrop={onDropFiles}
        >
          <button type="button" className="daw-btn" onClick={() => fileInput.current?.click()} disabled={busy !== null}>
            {t("เพิ่มไฟล์เสียง", "Add audio files")}
          </button>
          <span>{t("หรือลากไฟล์มาวางที่นี่ / บน timeline", "or drop files here or on the timeline")}</span>
          <input
            ref={fileInput}
            className="sr-only"
            type="file"
            accept="audio/*,.mp3,.wav,.flac,.ogg,.m4a,.aac"
            multiple
            onChange={(e) => {
              const files = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = "";
              if (files.length) onFiles(files);
            }}
          />
        </div>
      </section>

      {busy && <p className="daw-lib-busy" aria-live="polite">{busy}</p>}

      <section className="daw-lib-section daw-lib-sources">
        <h3 className="daw-lib-title">
          {t("ซาวด์ในโปรเจกต์", "Project sounds")} <span>{sources.length}</span>
        </h3>
        {sources.length === 0 && <p className="daw-lib-note">{t("ยังว่างอยู่ โหลดสเตมหรือเพิ่มไฟล์เพื่อเริ่มทำ remix", "Empty so far. Load stems or add a file to start remixing.")}</p>}
        <ul className="daw-source-list">
          {sources.map((src) => (
            <li
              key={src.id}
              className="daw-source"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-stemlab-source", src.id);
                e.dataTransfer.effectAllowed = "copy";
                onDragSource(src.id);
              }}
              onDragEnd={() => onDragSource(null)}
              style={{ "--clip": src.color } as React.CSSProperties}
            >
              <div className="daw-source-top">
                <span className="daw-source-swatch" aria-hidden="true" />
                <span className="daw-source-name" title={src.name}>{src.name}</span>
                <span className="daw-source-dur">{formatDuration(src.buffer.duration)}</span>
              </div>
              <div className="daw-source-controls">
                <button
                  type="button"
                  className={`daw-icon-btn${auditioning === src.id ? " is-on" : ""}`}
                  onClick={() => onAudition(src.id)}
                  aria-label={auditioning === src.id ? t("หยุดฟัง", "Stop preview") : t("ฟังตัวอย่าง", "Preview")}
                  title={auditioning === src.id ? t("หยุดฟัง", "Stop preview") : t("ฟังตัวอย่าง", "Preview")}
                >
                  {auditioning === src.id ? "■" : "▶"}
                </button>
                <label className="daw-bpm-field" title={t("BPM ของไฟล์นี้ (ตรวจจับโดยประมาณ แก้ได้)", "This sound's BPM (approximate detection, editable)")}>
                  <input
                    type="number"
                    min={40}
                    max={240}
                    step={0.1}
                    defaultValue={src.bpm}
                    key={src.bpm}
                    onBlur={(e) => {
                      const v = Number(e.currentTarget.value);
                      if (isFinite(v) && v > 0) onBpm(src.id, v);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                  />
                  <span>BPM</span>
                </label>
                <button type="button" className="daw-icon-btn" onClick={() => onBpm(src.id, src.bpm / 2)} aria-label="BPM ÷ 2" title="÷ 2">½</button>
                <button type="button" className="daw-icon-btn" onClick={() => onBpm(src.id, src.bpm * 2)} aria-label="BPM × 2" title="× 2">2×</button>
                <button type="button" className="daw-icon-btn daw-add" onClick={() => onAddToTimeline(src.id)} aria-label={t("วางลง timeline ที่ตำแหน่งเพลย์เฮด", "Add to timeline at the playhead")} title={t("วางที่เพลย์เฮด", "Add at playhead")}>
                  +
                </button>
                {!usedIds.has(src.id) && (
                  <button type="button" className="daw-icon-btn" onClick={() => onRemove(src.id)} aria-label={t("เอาออกจากคลัง", "Remove from library")} title={t("เอาออก", "Remove")}>
                    ×
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}

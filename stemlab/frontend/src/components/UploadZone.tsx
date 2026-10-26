import { useState, type ChangeEvent, type DragEvent } from "react";
import { useLanguage } from "./Language";

export const MAX_UPLOAD_MB = 50;
const EXTENSIONS = [".mp3", ".wav", ".flac"];

export function validateFile(file: File, language: "th" | "en" = "th"): string | null {
  const isEnglish = language === "en";
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!EXTENSIONS.includes(ext)) return isEnglish ? "Only MP3, WAV, and FLAC files are supported." : "รองรับเฉพาะไฟล์ MP3, WAV และ FLAC";
  if (file.size === 0) return isEnglish ? "The file is empty." : "ไฟล์ว่างเปล่า";
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return isEnglish ? `File exceeds ${MAX_UPLOAD_MB} MB.` : `ไฟล์ใหญ่เกิน ${MAX_UPLOAD_MB} MB`;
  return null;
}

const LANES = [
  { label: "Vocals", bar: (i: number) => 0.2 + 0.6 * Math.abs(Math.sin(i * 0.18)) * rand(i, 1) },
  { label: "Drums", bar: (i: number) => (i % 8 === 0 ? 1 : 0.12 + 0.2 * rand(i, 2)) },
  { label: "Bass", bar: (i: number) => 0.3 + 0.4 * Math.abs(Math.sin(i * 0.1 + 1)) },
  { label: "Other", bar: (i: number) => 0.15 + 0.55 * rand(i, 4) },
];

/** Deterministic pseudo-random number in [0, 1) so the preview never changes between renders. */
function rand(i: number, lane: number): number {
  const x = Math.sin(i * 12.9898 + lane * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function StemLanes({ active }: { active: boolean }) {
  const bars = 96;
  return (
    <div
      aria-hidden="true"
      className={`upload-waveform grid h-44 w-full grid-rows-4 transition-all duration-300 ${active ? "gap-3 opacity-90" : "gap-1.5 opacity-35"}`}
    >
      {LANES.map((lane) => (
        <div key={lane.label} className="flex items-center gap-4">
          <span className="w-14 shrink-0 text-xs text-neutral-400">{lane.label}</span>
          <svg viewBox={`0 0 ${bars * 5} 20`} preserveAspectRatio="none" className="h-full w-full text-neutral-100">
            {Array.from({ length: bars }, (_, i) => {
              const h = Math.max(1, lane.bar(i) * 18);
              return <rect key={i} x={i * 5} y={10 - h / 2} width={3} height={h} fill="currentColor" />;
            })}
          </svg>
        </div>
      ))}
    </div>
  );
}

interface Props {
  onFile: (file: File) => void;
  error?: string | null;
}

export default function UploadZone({ onFile, error }: Props) {
  const { language, t } = useLanguage();
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const accept = (file: File | undefined) => {
    if (!file) return;
    const problem = validateFile(file, language);
    setLocalError(problem);
    if (!problem) onFile(file);
  };

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragging(false);
    accept(e.dataTransfer.files[0]);
  };

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    accept(e.target.files?.[0]);
    e.target.value = ""; // lets the same file be chosen again after an error
  };

  const message = localError ?? error;

  return (
    <div>
      <label
        htmlFor="song-file"
        onDragEnter={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={onDrop}
        className={`upload-dropzone flex cursor-pointer flex-col items-center gap-8 border px-6 py-10 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-white sm:px-10 ${
          dragging ? "border-white bg-neutral-900" : "border-neutral-800 hover:border-neutral-600"
        }`}
      >
        <input
          id="song-file"
          type="file"
          accept=".mp3,.wav,.flac,audio/mpeg,audio/wav,audio/x-wav,audio/flac"
          className="sr-only"
          onChange={onChange}
        />
        <div className="upload-zone-meta" aria-hidden="true">
          <span>01 <i /> {t("อินพุตเสียง", "AUDIO INPUT")}</span>
          <span>{t("สเตอริโอ / 4 แทร็ก", "STEREO / 4 STEMS")}</span>
        </div>
        <StemLanes active={dragging} />
        <div className="text-center">
          <p className="text-lg font-medium text-neutral-100">
            {dragging ? t("ปล่อยไฟล์เพื่อเริ่มแยกเสียง", "Drop the file to start separating") : t("ลากไฟล์เพลงมาวางที่นี่", "Drag and drop a song here")}
          </p>
          <p className="mt-2 text-sm text-neutral-400">{t("หรือคลิกเพื่อเลือกไฟล์จากเครื่อง", "or click to choose a file from your device")}</p>
          <p className="mt-4 text-xs text-neutral-500">
            {t(`รองรับ MP3, WAV, FLAC ขนาดไม่เกิน ${MAX_UPLOAD_MB} MB`, `MP3, WAV, and FLAC up to ${MAX_UPLOAD_MB} MB`)}
          </p>
        </div>
      </label>
      {message && (
        <p role="alert" className="mt-4 border-l-2 border-white pl-3 text-sm text-neutral-200">
          {message}
        </p>
      )}
    </div>
  );
}

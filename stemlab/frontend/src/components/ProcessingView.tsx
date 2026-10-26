import type { JobStatus } from "../api";
import { useLanguage } from "./Language";

interface Props {
  fileName: string;
  fileSize: number;
  uploadPercent: number;
  status: JobStatus | "uploading";
  aiPercent: number;
  stage: string;
  onCancel: () => void;
}

function Bar({ label, value, caption }: { label: string; value: number; caption: string }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between text-sm">
        <span className="text-neutral-200">{label}</span>
        <span className="tabular-nums text-neutral-400">{caption}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="h-1 w-full bg-neutral-800"
      >
        <div className="h-full bg-white transition-[width] duration-500 ease-out" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

const formatSize = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export default function ProcessingView({
  fileName,
  fileSize,
  uploadPercent,
  status,
  aiPercent,
  stage,
  onCancel,
}: Props) {
  const { t } = useLanguage();
  const waiting = status === "uploading" || status === "uploaded" || status === "queued";
  return (
    <section aria-labelledby="processing-title" className="border border-neutral-800 p-6 sm:p-10">
      <h2 id="processing-title" className="break-words text-xl font-medium text-neutral-100">
        {fileName}
      </h2>
      <p className="mt-1 text-sm text-neutral-500">{formatSize(fileSize)}</p>

      <div className="mt-10 space-y-8">
        <Bar
          label={t("อัปโหลดไฟล์", "Uploading file")}
          value={uploadPercent}
          caption={uploadPercent >= 100 ? t("เสร็จแล้ว", "Complete") : `${uploadPercent}%`}
        />
        <Bar
          label={t("AI แยกเสียง", "AI separation")}
          value={aiPercent}
          caption={status === "uploading" ? t("รอการอัปโหลด", "Waiting for upload") : waiting ? t("อยู่ในคิว", "Queued") : `${aiPercent}%`}
        />
      </div>

      <p aria-live="polite" className="mt-8 min-h-6 text-sm text-neutral-300">
        {status === "uploading" ? t("กำลังอัปโหลดไฟล์...", "Uploading file...") : stage ? `${stage}...` : t("กำลังประมวลผลด้วย AI...", "Processing with AI...")}
      </p>
      <p className="mt-1 text-xs text-neutral-500">{t("การแยกเสียงใช้เวลาตั้งแต่หลักสิบวินาทีถึงหลายนาที ขึ้นกับความยาวเพลงและเครื่องที่ประมวลผล", "Separation can take from seconds to several minutes, depending on the song length and processing hardware.")}</p>

      <button
        type="button"
        onClick={onCancel}
        className="mt-8 border border-neutral-700 px-4 py-2 text-sm text-neutral-200 transition-colors hover:border-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        {t("ยกเลิก", "Cancel")}
      </button>
    </section>
  );
}

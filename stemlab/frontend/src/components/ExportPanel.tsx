import { downloadUrl, type StemInfo } from "../api";
import { DownloadIcon } from "./icons";
import { useLanguage } from "./Language";

interface Props {
  jobId: string;
  stems: StemInfo[];
}

const linkClass =
  "inline-flex items-center gap-2 border px-4 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

export default function ExportPanel({ jobId, stems }: Props) {
  const { t } = useLanguage();
  return (
    <section aria-labelledby="export-title" className="pt-10">
      <h2 id="export-title" className="text-lg font-medium text-neutral-100">
        {t("ดาวน์โหลด", "Downloads")}
      </h2>
      <p className="mt-1 text-sm text-neutral-400">
        {t("ไฟล์ WAV ของแต่ละแทร็กเป็นต้นฉบับที่ AI แยกมา ไม่รวมการปรับความดังหรือ Mute ในหน้านี้", "Each WAV is the original separated track and does not include the volume or mute adjustments made here.")}
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        {stems.map((stem) => (
          <a
            key={stem.name}
            href={downloadUrl(jobId, stem.name)}
            download
            className={`${linkClass} border-neutral-700 text-neutral-200 hover:border-white`}
          >
            <DownloadIcon />
            {t(`${stem.name}.wav`, `${stem.name}.wav`)}
          </a>
        ))}
        <a
          href={downloadUrl(jobId, "all")}
          download
          className={`${linkClass} border-white bg-white font-medium text-black hover:bg-neutral-300`}
        >
          <DownloadIcon />
          {t("ดาวน์โหลดทั้งหมด (ZIP)", "Download all (ZIP)")}
        </a>
      </div>
    </section>
  );
}

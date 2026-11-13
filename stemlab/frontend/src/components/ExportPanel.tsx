import { useState } from "react";
import { downloadUrl, type StemInfo } from "../api";
import type { StemPlayer } from "../audio/StemPlayer";
import { usePlayer } from "../hooks";
import { DownloadIcon } from "./icons";
import { useLanguage } from "./Language";

interface Props {
  jobId: string;
  filename: string;
  stems: StemInfo[];
  player: StemPlayer;
}

const linkClass =
  "inline-flex items-center gap-2 border px-4 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

/** Song name without its extension and without characters that are not allowed in file names. */
function defaultSongName(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|\r\n]+/g, "_").trim() || "track";
}

export default function ExportPanel({ jobId, filename, stems, player }: Props) {
  const { t } = useLanguage();
  usePlayer(player); // so the summary of the mix stays current
  const [songName, setSongName] = useState(() => defaultSongName(filename));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const changed = player.tracks.filter((track) => track.volume !== 1 || track.pan !== 0 || track.muted || track.solo).length;

  const downloadMix = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { blob, normalized } = await player.renderMix();
      const safe = defaultSongName(songName);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safe} (Mixed).wav`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setMessage({
        kind: "ok",
        text: normalized
          ? t("ดาวน์โหลดแล้ว (ลดระดับเสียงรวมเล็กน้อยเพื่อไม่ให้เสียงแตก)", "Downloaded (overall level lowered slightly to avoid clipping).")
          : t("ดาวน์โหลดแล้ว", "Downloaded."),
      });
    } catch (e) {
      const silent = e instanceof Error && e.message === "NO_AUDIBLE_TRACKS";
      setMessage({
        kind: "error",
        text: silent
          ? t("ทุกแทร็กถูกปิดเสียงอยู่ ไม่มีเสียงให้บันทึก", "Every track is muted, so there is nothing to export.")
          : t("สร้างไฟล์มิกซ์ไม่สำเร็จ ลองใหม่อีกครั้ง", "Could not render the mix. Please try again."),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="export-title" className="pt-10">
      <div className="mix-export">
        <div className="min-w-0 flex-1">
          <h2 id="export-title" className="text-lg font-medium text-neutral-100">
            {t("ดาวน์โหลดมิกซ์ของคุณ", "Download your mix")}
          </h2>
          <p className="mt-1 text-sm text-neutral-400">
            {t(
              "รวมทุกแทร็กตามที่ปรับไว้ในหน้านี้ (ความดัง Mute Solo และ Pan) เป็นไฟล์ WAV ไฟล์เดียว",
              "Bounces every track exactly as set here (volume, mute, solo and pan) into one WAV file.",
            )}
            {changed === 0 && ` ${t("ตอนนี้ยังไม่ได้ปรับอะไร", "Nothing has been changed yet.")}`}
          </p>
          <div className="mt-4 flex flex-wrap items-stretch gap-2">
            <label className="mix-name">
              <span className="sr-only">{t("ชื่อไฟล์", "File name")}</span>
              <input
                type="text"
                value={songName}
                maxLength={80}
                onChange={(e) => setSongName(e.target.value)}
                placeholder={t("ชื่อเพลง", "Song name")}
                spellCheck={false}
              />
              <em>(Mixed).wav</em>
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => void downloadMix()}
              className={`${linkClass} border-white bg-white font-medium text-black hover:bg-neutral-300 disabled:cursor-wait disabled:opacity-60`}
            >
              <DownloadIcon />
              {busy ? t("กำลังสร้างไฟล์...", "Rendering...") : t("ดาวน์โหลดมิกซ์", "Download mix")}
            </button>
          </div>
          <p role="status" aria-live="polite" className={`mt-2 min-h-5 text-sm ${message?.kind === "error" ? "text-neutral-100" : "text-neutral-400"}`}>
            {message?.text}
          </p>
        </div>
      </div>

      <h3 className="mt-8 text-base font-medium text-neutral-100">{t("แทร็กต้นฉบับที่แยกแล้ว", "Original separated tracks")}</h3>
      <p className="mt-1 text-sm text-neutral-400">
        {t("ไฟล์ WAV ของแต่ละแทร็กเป็นต้นฉบับที่ AI แยกมา ไม่รวมการปรับความดัง Mute หรือ Pan ในหน้านี้", "Each WAV is the raw separated track and does not include the volume, mute or pan adjustments made here.")}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {stems.map((stem) => (
          <a
            key={stem.name}
            href={downloadUrl(jobId, stem.name)}
            download
            className={`${linkClass} border-neutral-700 text-neutral-200 hover:border-white`}
          >
            <DownloadIcon />
            {`${stem.name}.wav`}
          </a>
        ))}
        <a
          href={downloadUrl(jobId, "all")}
          download
          className={`${linkClass} border-neutral-700 text-neutral-200 hover:border-white`}
        >
          <DownloadIcon />
          {t("ดาวน์โหลดทั้งหมด (ZIP)", "Download all (ZIP)")}
        </a>
      </div>
    </section>
  );
}

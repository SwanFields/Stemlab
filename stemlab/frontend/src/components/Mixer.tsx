import { useEffect, useState } from "react";
import type { StemInfo } from "../api";
import { StemPlayer } from "../audio/StemPlayer";
import ExportPanel from "./ExportPanel";
import TrackStrip from "./TrackStrip";
import Transport from "./Transport";
import { useLanguage } from "./Language";

interface Props {
  jobId: string;
  filename: string;
  stems: StemInfo[];
  onReset: () => void;
}

export default function Mixer({ jobId, filename, stems, onReset }: Props) {
  const { t } = useLanguage();
  const [player, setPlayer] = useState<StemPlayer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(0);

  useEffect(() => {
    const p = new StemPlayer();
    let cancelled = false;
    setPlayer(null);
    setError(null);
    setLoaded(0);
    p.load(stems, (done) => {
      if (!cancelled) setLoaded(done);
    })
      .then(() => {
        if (!cancelled) setPlayer(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : t("โหลดไฟล์เสียงไม่สำเร็จ", "Could not load audio files."));
      });
    return () => {
      cancelled = true;
      p.dispose();
    };
  }, [stems, t]);

  if (error) {
    return (
      <div role="alert" className="border-l-2 border-white pl-4">
        <p className="text-neutral-100">{error}</p>
        <button
          type="button"
          onClick={onReset}
          className="mt-4 border border-neutral-700 px-4 py-2 text-sm hover:border-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          {t("เริ่มใหม่", "Try again")}
        </button>
      </div>
    );
  }

  if (!player) {
    return (
      <p aria-live="polite" className="text-sm text-neutral-400">
        {t(`กำลังโหลดแทร็กเสียง ${loaded}/${stems.length}...`, `Loading audio tracks ${loaded}/${stems.length}...`)}
      </p>
    );
  }

  return (
    <section aria-labelledby="mixer-title" className="mixer-studio">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow"><span className="status-dot" /> {t("มิกเซอร์ STEM", "STEM MIXER")}</p>
          <h2 id="mixer-title" className="mt-1 break-words text-2xl font-medium text-neutral-100">
            {filename}
          </h2>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="border border-neutral-700 px-4 py-2 text-sm text-neutral-200 transition-colors hover:border-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          {t("แยกเพลงอื่น", "Separate another song")}
        </button>
      </header>

      <Transport player={player} />

      <div className="mixer-console-meta" aria-hidden="true">
        <span><i /> {t("แชนเนลแทร็ก", "CHANNEL STRIPS")}</span>
        <span>{t("4 แทร็ก", "04 TRACKS")} <b /> {t("สเตอริโอ", "STEREO")}</span>
      </div>
      <div className="mixer-track-list divide-y divide-neutral-900 border-y border-neutral-900">
        {player.tracks.map((track, index) => (
          <TrackStrip key={track.name} player={player} track={track} index={index} />
        ))}
      </div>

      <ExportPanel jobId={jobId} stems={stems} />
    </section>
  );
}

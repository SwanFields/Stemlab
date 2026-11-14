import { useEffect } from "react";
import type { StemInfo } from "../api";
import { playbackSession, usePlaybackSession } from "../audio/PlaybackSession";
import AbSwitch from "./AbSwitch";
import ExportPanel from "./ExportPanel";
import TrackStrip from "./TrackStrip";
import Transport from "./Transport";
import Visualizer from "./Visualizer";
import { useLanguage } from "./Language";

interface Props {
  jobId: string;
  filename: string;
  stems: StemInfo[];
  onReset: () => void;
  onOpenDaw?: () => void;
}

export default function Mixer({ jobId, filename, stems, onReset, onOpenDaw }: Props) {
  const { t } = useLanguage();
  const session = usePlaybackSession();

  // The player belongs to the app-wide playback session, not to this page, so the music keeps
  // playing (and the mini player dock can control it) after you leave the mixer.
  useEffect(() => {
    playbackSession.open(jobId, filename, stems);
  }, [jobId, filename, stems]);

  // While the mixer is on screen it is the player UI; the dock stays out of the way.
  useEffect(() => {
    playbackSession.setSuppressed("mixer", true);
    return () => playbackSession.setSuppressed("mixer", false);
  }, []);

  const mine = session.jobId === jobId;
  const player = mine && session.status === "ready" ? session.player : null;
  const error = mine && session.status === "error" ? (session.error ?? t("โหลดไฟล์เสียงไม่สำเร็จ", "Could not load audio files.")) : null;
  const loaded = mine ? session.loaded : 0;

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
        <div className="flex flex-wrap items-center gap-3">
          {onOpenDaw && (
            <button
              type="button"
              onClick={onOpenDaw}
              className="daw-cta daw-cta-lg"
            >
              <span className="daw-cta-bars" aria-hidden="true"><i /><i /><i /><i /></span>
              {t("เปิดใน Mini DAW", "Open in Mini DAW")} <span aria-hidden="true">↗</span>
            </button>
          )}
          <button
            type="button"
            onClick={onReset}
            className="border border-neutral-700 px-4 py-2 text-sm text-neutral-200 transition-colors hover:border-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            {t("แยกเพลงอื่น", "Separate another song")}
          </button>
        </div>
      </header>

      <Transport player={player} />
      <AbSwitch player={player} />
      <Visualizer player={player} />

      <div className="mixer-console-meta" aria-hidden="true">
        <span><i /> {t("แชนเนลแทร็ก", "CHANNEL STRIPS")}</span>
        <span>{t("4 แทร็ก", "04 TRACKS")} <b /> {t("สเตอริโอ", "STEREO")}</span>
      </div>
      <div className="mixer-track-list divide-y divide-neutral-900 border-y border-neutral-900">
        {player.tracks.map((track, index) => (
          <TrackStrip key={track.name} player={player} track={track} index={index} />
        ))}
      </div>

      <ExportPanel jobId={jobId} filename={filename} stems={stems} player={player} />
    </section>
  );
}

import { useRef, type CSSProperties } from "react";
import { MAX_VOLUME, type StemPlayer, type Track } from "../audio/StemPlayer";
import { usePlayer, useFrame } from "../hooks";
import Waveform from "./Waveform";
import { useLanguage } from "./Language";

const LABELS: Record<string, { en: string; th: string }> = {
  vocals: { en: "Vocals", th: "เสียงร้อง" },
  drums: { en: "Drums", th: "กลอง" },
  bass: { en: "Bass", th: "เบส" },
  other: { en: "Other", th: "เครื่องดนตรีอื่นๆ" },
};

interface Props {
  player: StemPlayer;
  track: Track;
  index: number;
}

export default function TrackStrip({ player, track, index }: Props) {
  const { language, t } = useLanguage();
  usePlayer(player); // volume / mute / solo live on the player, so re-render when they change
  const meter = useRef<HTMLDivElement>(null);
  useFrame(() => {
    if (meter.current) meter.current.style.transform = `scaleX(${player.getLevel(track.name)})`;
  });

  const label = LABELS[track.name] ?? { en: track.name, th: "" };
  const audible = player.isAudible(track);
  const fill = (track.volume / MAX_VOLUME) * 100;

  return (
    <div
      className={`channel-strip grid grid-cols-1 gap-x-8 gap-y-4 py-5 transition-opacity md:grid-cols-[15rem_1fr] ${audible ? "" : "opacity-40"} ${track.muted ? "is-muted" : ""} ${track.solo ? "is-solo" : ""}`}
    >
      <div>
        <div className="channel-heading">
          <span className="channel-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
          <h3 className="min-w-0 flex-1 text-base font-medium text-neutral-100">
            {language === "en" ? label.en : label.th}
          </h3>
          <div className="channel-buttons">
            <button
              type="button"
              aria-pressed={track.muted}
              onClick={() => player.toggleMute(track.name)}
              className={`channel-button channel-button-mute ${track.muted ? "is-active" : ""}`}
            >
              {t("ปิดเสียง", "Mute")}
            </button>
            <button
              type="button"
              aria-pressed={track.solo}
              onClick={() => player.toggleSolo(track.name)}
              className={`channel-button channel-button-solo ${track.solo ? "is-active" : ""}`}
            >
              {t("เดี่ยว", "Solo")}
            </button>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <input
            type="range"
            className="fader"
            min={0}
            max={MAX_VOLUME}
            step={0.01}
            value={track.volume}
            style={{ "--fill": `${fill}%` } as CSSProperties}
            aria-label={t(`ความดัง ${label.th}`, `${label.en} volume`)}
            onChange={(e) => player.setVolume(track.name, Number(e.target.value))}
          />
          <output className="w-11 shrink-0 text-right text-xs tabular-nums text-neutral-400">
            {Math.round(track.volume * 100)}%
          </output>
        </div>
      </div>

      <div>
        <Waveform player={player} peaks={track.peaks} />
        <div className="mt-1 h-0.5 w-full bg-neutral-900" aria-hidden="true">
          <div ref={meter} className="h-full origin-left bg-neutral-100" style={{ transform: "scaleX(0)" }} />
        </div>
      </div>
    </div>
  );
}

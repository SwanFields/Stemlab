import { useEffect, useState, type CSSProperties } from "react";
import type { StemPlayer } from "../audio/StemPlayer";
import { formatTime, useFrame, usePlayer } from "../hooks";
import { PauseIcon, PlayIcon, StopIcon } from "./icons";
import { useLanguage } from "./Language";

export default function Transport({ player }: { player: StemPlayer }) {
  const { t } = useLanguage();
  usePlayer(player);
  const [position, setPosition] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null); // value while the thumb is being dragged

  useFrame(() => {
    const p = player.position;
    setPosition((prev) => (Math.abs(prev - p) > 0.02 ? p : prev));
  });

  // Space toggles play / pause unless the focus is on something that already uses Space.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "BUTTON" || tag === "TEXTAREA") return;
      if (tag === "INPUT" && (el as HTMLInputElement).type !== "range") return;
      e.preventDefault();
      if (player.isPlaying) player.pause();
      else void player.play();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player]);

  const shown = scrub ?? position;
  const fill = player.duration ? (shown / player.duration) * 100 : 0;
  const commit = () => {
    if (scrub === null) return;
    player.seek(scrub);
    setScrub(null);
  };

  const buttonClass =
    "inline-flex items-center gap-2 px-4 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

  return (
    <div className="sticky top-0 z-10 -mx-4 bg-black/90 px-4 py-4 backdrop-blur sm:-mx-0 sm:px-0">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => (player.isPlaying ? player.pause() : void player.play())}
            className={`${buttonClass} bg-white font-medium text-black hover:bg-neutral-300`}
          >
            {player.isPlaying ? <PauseIcon /> : <PlayIcon />}
            {player.isPlaying ? t("หยุดชั่วคราว", "Pause") : t("เล่น", "Play")}
          </button>
          <button
            type="button"
            onClick={() => player.stop()}
            className={`${buttonClass} border border-neutral-700 text-neutral-200 hover:border-white`}
          >
            <StopIcon />
            {t("หยุด", "Stop")}
          </button>
        </div>

        <div className="flex min-w-60 flex-1 items-center gap-4">
          <span className="w-10 text-right text-sm tabular-nums text-neutral-300">{formatTime(shown)}</span>
          <input
            type="range"
            className="fader"
            min={0}
            max={player.duration || 1}
            step={0.01}
            value={shown}
            style={{ "--fill": `${fill}%` } as CSSProperties}
            aria-label={t("ตำแหน่งเพลง", "Song position")}
            aria-valuetext={`${formatTime(shown)} ${t("จาก", "of")} ${formatTime(player.duration)}`}
            onChange={(e) => setScrub(Number(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
          />
          <span className="w-10 text-sm tabular-nums text-neutral-500">{formatTime(player.duration)}</span>
        </div>
      </div>
    </div>
  );
}

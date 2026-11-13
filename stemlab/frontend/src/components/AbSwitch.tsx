import { useEffect } from "react";
import type { StemPlayer } from "../audio/StemPlayer";
import { usePlayer } from "../hooks";
import { useLanguage } from "./Language";

/** A/B comparison: the song as uploaded vs. the stems as mixed below. Switches instantly, in sync, mid-playback. */
export default function AbSwitch({ player }: { player: StemPlayer }) {
  const { t } = useLanguage();
  usePlayer(player);

  // A / B keys flip between the two while the focus is not in a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.tagName === "TEXTAREA" || (el?.tagName === "INPUT" && (el as HTMLInputElement).type === "text")) return;
      if (e.key === "a" || e.key === "A") player.setMode("original");
      else if (e.key === "b" || e.key === "B") player.setMode("mix");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player]);

  if (!player.hasOriginal) return null;
  const original = player.mode === "original";

  return (
    <div className="ab-switch" role="group" aria-label={t("เปรียบเทียบ A/B", "A/B comparison")}>
      <button
        type="button"
        aria-pressed={original}
        onClick={() => player.setMode("original")}
        className={`ab-option ${original ? "is-active" : ""}`}
      >
        <b>A</b>
        {t("ต้นฉบับ", "Original")}
      </button>
      <button
        type="button"
        aria-pressed={!original}
        onClick={() => player.setMode("mix")}
        className={`ab-option ${!original ? "is-active" : ""}`}
      >
        <b>B</b>
        {t("มิกซ์ของคุณ", "Your mix")}
      </button>
      <span className="ab-hint" aria-live="polite">
        {original
          ? t("กำลังฟังเพลงต้นฉบับ (เฟเดอร์ด้านล่างยังไม่มีผล)", "Listening to the untouched song (faders below are bypassed)")
          : t("กำลังฟังมิกซ์ที่ปรับแล้ว · กด A / B เพื่อสลับ", "Listening to your mix · press A / B to switch")}
      </span>
    </div>
  );
}

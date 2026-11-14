import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { playbackSession, usePlaybackSession } from "../audio/PlaybackSession";
import type { StemPlayer } from "../audio/StemPlayer";
import { formatTime, useFrame, usePlayer } from "../hooks";
import { PauseIcon, PlayIcon } from "./icons";
import { useLanguage } from "./Language";

const SKIP_SECONDS = 10;
const NEAR_Y = 72; // px from the bottom edge where a mouse wakes the dock
const NEAR_HALF_W = 330; // px either side of the centre line
const SWIPE_OPEN = 26; // upward swipe distance that opens the sheet
const SWIPE_CLOSE = 56; // downward swipe distance that closes it
const CLOSE_DELAY = 280;

type OpenMode = "closed" | "hover" | "pinned";

/**
 * Persistent mini player. Collapsed it is only a soft, music-reactive glow along the bottom edge
 * plus a small grab pill. A mouse moving near the bottom, a tap, or a swipe up (phones) raises
 * the controls; moving away, Escape, tapping outside or a swipe down tucks them away again.
 */
export default function MiniPlayerDock() {
  const session = usePlaybackSession();
  if (session.status !== "ready" || !session.player || session.suppressed) return null;
  return <Dock key={session.jobId ?? "song"} player={session.player} filename={session.filename} />;
}

function SkipIcon({ forward }: { forward: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {forward ? (
        <>
          <path d="M12 5a7.5 7.5 0 1 1-7.5 7.5" />
          <path d="m12 1.8 3.4 3.2L12 8.2" />
        </>
      ) : (
        <>
          <path d="M12 5a7.5 7.5 0 1 0 7.5 7.5" />
          <path d="M12 1.8 8.6 5 12 8.2" />
        </>
      )}
      <text x="12" y="16" textAnchor="middle" fontSize="7.4" fontWeight="600" fill="currentColor" stroke="none" fontFamily="inherit">
        10
      </text>
    </svg>
  );
}

function Dock({ player, filename }: { player: StemPlayer; filename: string }) {
  const { t } = useLanguage();
  usePlayer(player);
  const [mode, setMode] = useState<OpenMode>("closed");
  const open = mode !== "closed";

  const rootRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const seekRef = useRef<HTMLInputElement>(null);
  const nowRef = useRef<HTMLSpanElement>(null);
  const totalRef = useRef<HTMLSpanElement>(null);
  const modeRef = useRef<OpenMode>("closed");
  const closeTimer = useRef<number | null>(null);
  const scrubbing = useRef(false);
  const level = useRef(0);
  const swipe = useRef<{ id: number; y: number; dy: number; kind: "grab" | "sheet" } | null>(null);
  const tapHandled = useRef(false);

  const apply = useCallback((next: OpenMode) => {
    modeRef.current = next;
    setMode(next);
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const scheduleClose = useCallback(
    (delay = CLOSE_DELAY) => {
      if (closeTimer.current !== null) return;
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = null;
        if (modeRef.current === "hover") apply("closed");
      }, delay);
    },
    [apply],
  );

  useEffect(() => cancelClose, [cancelClose]);

  /* ---- mouse proximity (no overlay element, so the page underneath stays fully clickable) ---- */
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const near = e.clientY > window.innerHeight - NEAR_Y && Math.abs(e.clientX - window.innerWidth / 2) < NEAR_HALF_W;
      if (modeRef.current === "closed") {
        if (near) apply("hover");
        return;
      }
      if (modeRef.current !== "hover") return;
      const r = sheetRef.current?.getBoundingClientRect();
      const inside = r ? e.clientX >= r.left - 28 && e.clientX <= r.right + 28 && e.clientY >= r.top - 28 : false;
      if (inside || near) cancelClose();
      else scheduleClose();
    };
    const onLeaveWindow = () => {
      if (modeRef.current === "hover") scheduleClose(120);
    };
    window.addEventListener("pointermove", onMove);
    document.documentElement.addEventListener("mouseleave", onLeaveWindow);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeaveWindow);
    };
  }, [apply, cancelClose, scheduleClose]);

  /* ---- Escape / tap outside close a pinned sheet ---- */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") apply("closed");
    };
    const onDown = (e: PointerEvent) => {
      if (modeRef.current !== "pinned") return;
      if (!rootRef.current?.contains(e.target as Node)) apply("closed");
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, apply]);

  /* ---- per-frame: progress + music-reactive glow ---- */
  useFrame(() => {
    const dur = player.duration || 0;
    const pos = player.position;
    const seek = seekRef.current;
    if (seek && !scrubbing.current) {
      seek.max = String(dur || 1);
      seek.value = String(pos);
      seek.style.setProperty("--fill", `${dur ? (pos / dur) * 100 : 0}%`);
    }
    if (nowRef.current && !scrubbing.current) {
      const text = formatTime(pos);
      if (nowRef.current.textContent !== text) nowRef.current.textContent = text;
    }
    if (totalRef.current) {
      const text = formatTime(dur);
      if (totalRef.current.textContent !== text) totalRef.current.textContent = text;
    }
    let target = 0;
    if (player.isPlaying) {
      let sum = 0;
      for (const track of player.tracks) sum += player.getLevel(track.name);
      target = Math.min(1, (sum / Math.max(1, player.tracks.length)) * 1.5);
    }
    level.current = Math.max(target, level.current * 0.9); // quick attack, slow release
    rootRef.current?.style.setProperty("--lvl", level.current.toFixed(3));
  });

  /* ---- swipe (touch / pen) ---- */
  const onSwipeDown = (e: ReactPointerEvent<HTMLElement>, kind: "grab" | "sheet") => {
    if (e.pointerType === "mouse") return;
    if (kind === "sheet" && (e.target as HTMLElement).closest("button, input")) return;
    swipe.current = { id: e.pointerId, y: e.clientY, dy: 0, kind };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onSwipeMove = (e: ReactPointerEvent<HTMLElement>) => {
    const s = swipe.current;
    if (!s || s.id !== e.pointerId) return;
    s.dy = e.clientY - s.y;
    if (s.kind === "grab" && s.dy < -SWIPE_OPEN && modeRef.current === "closed") {
      apply("pinned");
      swipe.current = null;
    } else if (s.kind === "sheet" && sheetRef.current) {
      const pull = Math.max(0, s.dy);
      sheetRef.current.style.transition = "none";
      sheetRef.current.style.transform = `translateY(${pull}px)`;
    }
  };

  const onSwipeUp = (e: ReactPointerEvent<HTMLElement>) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s || s.id !== e.pointerId) return;
    const sheet = sheetRef.current;
    if (sheet) {
      sheet.style.transition = "";
      sheet.style.transform = "";
    }
    if (s.kind === "sheet") {
      if (s.dy > SWIPE_CLOSE) apply("closed");
    } else if (Math.abs(s.dy) < 8) {
      tapHandled.current = true; // the click event that follows must not toggle a second time
      apply(modeRef.current === "closed" ? "pinned" : "closed"); // a tap on the pill
    }
  };

  const playing = player.isPlaying;
  const commitSeek = () => {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    const v = Number(seekRef.current?.value ?? 0);
    player.seek(v);
  };
  const skip = (delta: number) => player.seek(player.position + delta);
  const status = playing ? t("กำลังเล่น", "Playing") : t("หยุดชั่วคราว", "Paused");

  return (
    <div ref={rootRef} className="mp-root" data-open={open} data-playing={playing} style={{ "--lvl": 0 } as CSSProperties}>
      <div className="mp-glow" aria-hidden="true">
        <i className="mp-blob mp-blob-a" />
        <i className="mp-blob mp-blob-b" />
        <i className="mp-blob mp-blob-c" />
      </div>

      <button
        type="button"
        className="mp-grab"
        aria-expanded={open}
        aria-label={`${t("แสดงเครื่องเล่นเพลง", "Show player")}: ${filename} (${status})`}
        onPointerDown={(e) => onSwipeDown(e, "grab")}
        onPointerMove={onSwipeMove}
        onPointerUp={onSwipeUp}
        onPointerCancel={onSwipeUp}
        onClick={() => {
          // touch taps were handled by the swipe logic; mouse and keyboard land here
          if (tapHandled.current) {
            tapHandled.current = false;
            return;
          }
          cancelClose();
          apply(modeRef.current === "pinned" ? "closed" : "pinned");
        }}
      >
        <span className="mp-pill">
          <span className="mp-eq" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
        </span>
      </button>

      <section
        ref={sheetRef}
        className="mp-sheet"
        role="region"
        aria-label={t("เครื่องเล่นเพลง", "Music player")}
        aria-hidden={!open}
        inert={!open}
        onPointerDown={(e) => onSwipeDown(e, "sheet")}
        onPointerMove={onSwipeMove}
        onPointerUp={onSwipeUp}
        onPointerCancel={onSwipeUp}
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") cancelClose();
        }}
      >
        <span className="mp-sheet-handle" aria-hidden="true" />
        <div className="mp-head">
          <span className="mp-eq mp-eq-lg" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <div className="mp-title">
            <strong title={filename}>{filename}</strong>
            <span>{status} · Stemlab</span>
          </div>
          <button
            type="button"
            className="mp-close"
            aria-label={t("ปิดเครื่องเล่นและหยุดเพลง", "Close player and stop the music")}
            title={t("ปิดเครื่องเล่น", "Close player")}
            onClick={() => playbackSession.close()}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="m3.5 3.5 9 9m0-9-9 9" />
            </svg>
          </button>
        </div>

        <div className="mp-progress">
          <span ref={nowRef} className="mp-time">0:00</span>
          <input
            ref={seekRef}
            type="range"
            className="mp-seek"
            min={0}
            max={player.duration || 1}
            step={0.05}
            defaultValue={0}
            aria-label={t("ตำแหน่งเพลง", "Song position")}
            onPointerDown={() => {
              scrubbing.current = true;
            }}
            onInput={(e) => {
              scrubbing.current = true;
              const v = Number(e.currentTarget.value);
              const dur = player.duration || 1;
              e.currentTarget.style.setProperty("--fill", `${(v / dur) * 100}%`);
              if (nowRef.current) nowRef.current.textContent = formatTime(v);
            }}
            onPointerUp={commitSeek}
            onKeyUp={commitSeek}
            onBlur={commitSeek}
          />
          <span ref={totalRef} className="mp-time mp-time-total">0:00</span>
        </div>

        <div className="mp-controls">
          <button type="button" className="mp-btn" onClick={() => skip(-SKIP_SECONDS)} aria-label={t("ถอยหลัง 10 วินาที", "Back 10 seconds")} title={t("ถอยหลัง 10 วินาที", "Back 10 seconds")}>
            <SkipIcon forward={false} />
          </button>
          <button
            type="button"
            className="mp-btn mp-btn-play"
            onClick={() => (playing ? player.pause() : void player.play())}
            aria-label={playing ? t("หยุดชั่วคราว", "Pause") : t("เล่น", "Play")}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button type="button" className="mp-btn" onClick={() => skip(SKIP_SECONDS)} aria-label={t("ไปข้างหน้า 10 วินาที", "Forward 10 seconds")} title={t("ไปข้างหน้า 10 วินาที", "Forward 10 seconds")}>
            <SkipIcon forward />
          </button>
        </div>
      </section>
    </div>
  );
}

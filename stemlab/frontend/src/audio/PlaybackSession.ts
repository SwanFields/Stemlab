import { useSyncExternalStore } from "react";
import { stemUrl, type StemInfo } from "../api";
import { StemPlayer } from "./StemPlayer";

/**
 * The song that is currently loaded for listening.
 *
 * The StemPlayer used to live inside <Mixer> and was disposed when the page changed, so
 * the music stopped as soon as you left the mixer. It now lives here, at module level,
 * so it survives client-side navigation and the mini player dock can control it from
 * any page. Opening a different job replaces it; `close()` stops it for good.
 */
export type SessionStatus = "idle" | "loading" | "ready" | "error";

export interface SessionState {
  jobId: string | null;
  filename: string;
  status: SessionStatus;
  loaded: number;
  total: number;
  /** Raw error message from the loader, or null when there is none / it is unknown. */
  error: string | null;
  player: StemPlayer | null;
  /** True while a page that has its own player UI (mixer, DAW) is on screen. */
  suppressed: boolean;
}

const IDLE: SessionState = {
  jobId: null,
  filename: "",
  status: "idle",
  loaded: 0,
  total: 0,
  error: null,
  player: null,
  suppressed: false,
};

class PlaybackSession {
  private state: SessionState = IDLE;
  private listeners = new Set<() => void>();
  private reasons = new Set<string>();
  private loading: StemPlayer | null = null;
  private token = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stable between changes, as useSyncExternalStore requires. */
  getSnapshot = (): SessionState => this.state;

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  private disposePlayers(): void {
    this.state.player?.dispose();
    this.loading?.dispose();
    this.loading = null;
  }

  /** Load a job's stems. Does nothing when that job is already loading or loaded. */
  open(jobId: string, filename: string, stems: StemInfo[]): void {
    const s = this.state;
    if (s.jobId === jobId && (s.status === "loading" || s.status === "ready")) {
      if (s.filename !== filename) this.set({ filename });
      return;
    }
    this.disposePlayers();
    const token = ++this.token;
    const player = new StemPlayer();
    this.loading = player;
    this.set({ jobId, filename, status: "loading", loaded: 0, total: stems.length, error: null, player: null });
    player
      .load(
        stems,
        (done) => {
          if (token === this.token) this.set({ loaded: done });
        },
        stemUrl(jobId, "original"),
      )
      .then(() => {
        if (token !== this.token) return; // a newer open() / close() already disposed this player
        this.loading = null;
        this.set({ status: "ready", player });
      })
      .catch((e: unknown) => {
        player.dispose();
        if (token !== this.token) return;
        this.loading = null;
        this.set({ status: "error", error: e instanceof Error ? e.message : null });
      });
  }

  /** Stop playback and forget the song (the dock disappears). */
  close(): void {
    this.token++;
    this.disposePlayers();
    this.state = { ...IDLE, suppressed: this.state.suppressed };
    this.listeners.forEach((fn) => fn());
  }

  pause(): void {
    this.state.player?.pause();
  }

  /** A page with its own player UI calls this so the dock does not duplicate it. */
  setSuppressed(reason: string, on: boolean): void {
    const had = this.reasons.has(reason);
    if (on === had) return;
    if (on) this.reasons.add(reason);
    else this.reasons.delete(reason);
    const suppressed = this.reasons.size > 0;
    if (suppressed !== this.state.suppressed) this.set({ suppressed });
  }
}

export const playbackSession = new PlaybackSession();

export function usePlaybackSession(): SessionState {
  return useSyncExternalStore(playbackSession.subscribe, playbackSession.getSnapshot);
}

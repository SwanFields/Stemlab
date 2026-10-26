import { useEffect, useRef, useSyncExternalStore } from "react";
import type { StemPlayer } from "./audio/StemPlayer";

/** Re-render the calling component whenever the player's state changes. */
export function usePlayer(player: StemPlayer): void {
  useSyncExternalStore(player.subscribe, player.getVersion);
}

/** Run `callback` on every animation frame while the component is mounted. */
export function useFrame(callback: () => void): void {
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => {
    let id = 0;
    const loop = () => {
      latest.current();
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, []);
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

import { useEffect, useRef, type MouseEvent } from "react";
import type { StemPlayer } from "../audio/StemPlayer";
import { useFrame } from "../hooks";

interface Props {
  player: StemPlayer;
  peaks: Float32Array;
}

/** Canvas waveform: bright up to the playhead, dim after it. Click to seek. */
export default function Waveform({ player, peaks }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const lastKey = useRef("");

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const rect = el.getBoundingClientRect();
      el.width = Math.round(rect.width * dpr);
      el.height = Math.round(rect.height * dpr);
      size.current = { w: el.width, h: el.height };
      lastKey.current = ""; // force a redraw at the new size
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useFrame(() => {
    const el = canvas.current;
    const { w, h } = size.current;
    if (!el || !w || !h) return;

    const fraction = player.duration ? player.position / player.duration : 0;
    const theme = document.documentElement.dataset.theme ?? "dark";
    const key = `${w}x${h}:${theme}:${fraction.toFixed(4)}`;
    if (key === lastKey.current) return; // nothing moved, skip the redraw
    lastKey.current = key;

    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const dpr = window.devicePixelRatio || 1;
    const lightTheme = theme === "light";
    const barWidth = w / peaks.length;
    const mid = h / 2;
    const playedX = fraction * w;
    for (let i = 0; i < peaks.length; i++) {
      const x = i * barWidth;
      const amp = Math.max(dpr, peaks[i] * mid * 0.92);
      ctx.fillStyle = x < playedX ? (lightTheme ? "#37322f" : "#f5f5f5") : (lightTheme ? "#c5beb6" : "#525252");
      ctx.fillRect(x, mid - amp, Math.max(dpr, barWidth - dpr), amp * 2);
    }
    ctx.fillStyle = lightTheme ? "#cf9474" : "#ffffff";
    ctx.fillRect(Math.round(playedX), 0, Math.max(1, Math.round(dpr)), h);
  });

  const seekFromClick = (e: MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    player.seek(((e.clientX - rect.left) / rect.width) * player.duration);
  };

  // Seeking is also available from the keyboard-accessible slider in the transport bar.
  return <canvas ref={canvas} aria-hidden="true" onClick={seekFromClick} className="block h-20 w-full cursor-pointer" />;
}

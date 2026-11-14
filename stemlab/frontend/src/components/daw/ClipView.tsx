import { memo, useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { PEAKS_PER_SECOND, type DawSource } from "../../audio/DawEngine";
import { LANE_H } from "./dawUtils";

const HEAD_H = 16;
const WAVE_H = LANE_H - HEAD_H - 2;

interface Props {
  id: string;
  name: string;
  source: DawSource;
  start: number; // beats
  beats: number; // length on the timeline
  offset: number; // seconds into the source
  dur: number; // seconds of the source
  warp: boolean;
  ppb: number;
  selected: boolean;
  ghost?: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, id: string) => void;
}

function drawWave(canvas: HTMLCanvasElement, source: DawSource, offset: number, dur: number, color: string) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || 1;
  const w = Math.max(1, Math.min(6000, Math.ceil(cssW * dpr)));
  const h = Math.ceil(WAVE_H * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = color;
  const peaks = source.peaks;
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    const a = (offset + (x / w) * dur) * PEAKS_PER_SECOND;
    const b = (offset + ((x + 1) / w) * dur) * PEAKS_PER_SECOND;
    const i0 = Math.max(0, Math.floor(a));
    const i1 = Math.min(peaks.length - 1, Math.max(i0, Math.ceil(b) - 1));
    let max = 0;
    for (let i = i0; i <= i1; i++) if (peaks[i] > max) max = peaks[i];
    // A little floor keeps silence visible as a thin line instead of nothing.
    const amp = Math.max(0.01, max) * (mid - 2);
    ctx.fillRect(x, mid - amp, 1, amp * 2);
  }
}

function ClipViewBase({ id, name, source, start, beats, offset, dur, warp, ppb, selected, ghost, onPointerDown }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const width = Math.max(2, beats * ppb);

  useEffect(() => {
    if (canvas.current) drawWave(canvas.current, source, offset, dur, source.color);
  }, [source, offset, dur, width]);

  const style = {
    left: start * ppb,
    width,
    "--clip": source.color,
  } as CSSProperties;

  return (
    <div
      className={`daw-clip${selected ? " is-selected" : ""}${ghost ? " is-ghost" : ""}`}
      style={style}
      data-clip={id}
      onPointerDown={(e) => onPointerDown(e, id)}
    >
      <div className="daw-clip-head">
        <span className="daw-clip-name">{name}</span>
        {warp && width > 70 && <span className="daw-clip-badge">W</span>}
      </div>
      <canvas ref={canvas} className="daw-clip-wave" style={{ height: WAVE_H }} />
      <span className="daw-clip-edge left" />
      <span className="daw-clip-edge right" />
    </div>
  );
}

export default memo(ClipViewBase);

import { useEffect, useRef } from "react";
import type { StemPlayer } from "../audio/StemPlayer";
import { useFrame } from "../hooks";
import { useLanguage } from "./Language";

type Kind = "vocals" | "drums" | "bass" | "other";

const LABELS: Record<string, { en: string; th: string }> = {
  vocals: { en: "Vocals", th: "เสียงร้อง" },
  drums: { en: "Drums", th: "กลอง" },
  bass: { en: "Bass", th: "เบส" },
  other: { en: "Other", th: "เครื่องดนตรีอื่นๆ" },
};

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Mean magnitude (0..1) of the FFT bins between two frequencies. */
function band(data: Uint8Array, sampleRate: number, lo: number, hi: number): number {
  const hz = sampleRate / 2 / data.length;
  const from = Math.max(0, Math.floor(lo / hz));
  const to = Math.min(data.length - 1, Math.ceil(hi / hz));
  let sum = 0;
  for (let i = from; i <= to; i++) sum += data[i];
  return sum / ((to - from + 1) * 255);
}

/** Attack fast, release slowly: motion reads as "weight" instead of jitter. */
const follow = (prev: number, next: number) => prev + (next - prev) * (next > prev ? 0.75 : 0.14);

const VOCAL_BINS = 96;
const OTHER_BARS = 40;
const RING_SPIKES = 64; // spectrum points around the drum ring (mirrored left / right)

interface Wave {
  age: number; // 0 -> 1
  power: number;
}

interface ScopeProps {
  player: StemPlayer;
  name: string;
}

/**
 * One minimal canvas per stem, each with its own shape:
 *   vocals -> mirrored mid-range silhouette (96 bands)
 *   drums  -> spectrum ring that is punched outward by every kick / snare, with shock rings
 *   bass   -> the real low-frequency waveform, drawn like an oscilloscope
 *   other  -> 40 thin bars
 */
function StemScope({ player, name }: ScopeProps) {
  const { language } = useLanguage();
  const canvas = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const state = useRef({
    bins: new Float32Array(VOCAL_BINS),
    bars: new Float32Array(OTHER_BARS),
    spikes: new Float32Array(RING_SPIKES),
    bass: 0,
    period: 512,
    scratch: new Float32Array(0),
    trace: new Float32Array(180),
    // drums: spring (x = displacement, v = velocity), onset detector, shock rings
    x: 0,
    v: 0,
    prevKick: 0,
    prevSnap: 0,
    avgKick: 0,
    cooldown: 0,
    flash: 0,
    waves: [] as Wave[],
    frame: 0,
  });
  const kind = (["vocals", "drums", "bass", "other"].includes(name) ? name : "other") as Kind;

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const rect = el.getBoundingClientRect();
      el.width = Math.round(rect.width * dpr);
      el.height = Math.round(rect.height * dpr);
      size.current = { w: el.width, h: el.height };
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useFrame(() => {
    const el = canvas.current;
    const { w, h } = size.current;
    if (!el || !w || !h) return;
    const s = state.current;
    const calm = reducedMotion();
    if (calm && s.frame++ % 4 !== 0) return;

    const data = player.getFrequencyData(name);
    const sr = player.sampleRate;
    const ctx = el.getContext("2d");
    if (!data || !ctx) return;

    const light = (document.documentElement.dataset.theme ?? "dark") === "light";
    const ink = light ? "#37322f" : "#f5f5f5";
    const accent = "#cf9474";
    const dpr = window.devicePixelRatio || 1;
    const cx = w / 2;
    // keep the top strip free for the stem name so the drawing never runs under the label
    const pad = 28 * dpr;
    const ah = h - pad;
    const cy = pad + ah / 2;
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (kind === "vocals") {
      // 96 log-spaced bands, 120 Hz .. 7 kHz, drawn as a mirrored silhouette
      const n = VOCAL_BINS;
      const top: number[] = [];
      for (let i = 0; i < n; i++) {
        const lo = 120 * Math.pow(58, i / n);
        const hi = 120 * Math.pow(58, (i + 1) / n);
        s.bins[i] = follow(s.bins[i], Math.min(1, band(data, sr, lo, hi) * 1.7));
      }
      for (let i = 0; i < n; i++) {
        // light 3-point blur so neighbouring bands read as one smooth, detailed curve
        const v = (s.bins[Math.max(0, i - 1)] + 2 * s.bins[i] + s.bins[Math.min(n - 1, i + 1)]) / 4;
        const edge = Math.sin((Math.PI * i) / (n - 1)); // taper both ends to a point
        top.push(v * ah * 0.44 * (0.3 + 0.7 * edge));
      }
      ctx.beginPath();
      for (let i = 0; i < n; i++) ctx.lineTo((i / (n - 1)) * w, cy - Math.max(top[i], dpr * 0.5));
      for (let i = n - 1; i >= 0; i--) ctx.lineTo((i / (n - 1)) * w, cy + Math.max(top[i], dpr * 0.5));
      ctx.closePath();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = ink;
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = ink;
      ctx.lineWidth = dpr * 1.1;
      ctx.stroke();
    } else if (kind === "drums") {
      const unit = Math.min(w, ah);
      const kick = band(data, sr, 35, 140);
      const snap = band(data, sr, 1500, 7000);
      const air = band(data, sr, 7000, 14000);

      // --- onset detection: a sharp rise above the recent average = a hit ---
      s.avgKick = s.avgKick * 0.94 + kick * 0.06;
      const kickFlux = kick - s.prevKick;
      const snapFlux = snap - s.prevSnap;
      s.prevKick = kick;
      s.prevSnap = snap;
      s.cooldown = Math.max(0, s.cooldown - 1);
      let impact = 0;
      if (kickFlux > 0.04 && kick > s.avgKick * 1.2 && kick > 0.12) {
        impact = Math.min(1, 0.55 + kickFlux * 3 + (kick - s.avgKick) * 1.5);
      } else if (snapFlux > 0.06 && snap > 0.1) {
        impact = Math.min(0.7, 0.3 + snapFlux * 2.5); // snares hit softer than kicks
      }
      if (impact > 0 && s.cooldown === 0) {
        s.x = Math.max(s.x, impact * 0.9); // instant jump, not a slow swell
        s.v = Math.max(s.v, impact * 0.4);
        s.flash = Math.max(s.flash, impact);
        s.waves.push({ age: 0, power: impact });
        if (s.waves.length > 4) s.waves.shift();
        s.cooldown = 4; // ~65 ms: no double-triggers from one hit
      }
      // spring-back with a little overshoot = the "thump"
      s.v = s.v * 0.8 - s.x * 0.24;
      s.x = Math.max(-0.35, Math.min(1.4, s.x + s.v));
      s.flash *= 0.86;

      // --- spectrum ring detail (mirrored so it stays symmetric) ---
      const half = RING_SPIKES / 2;
      for (let i = 0; i < half; i++) {
        const lo = 40 * Math.pow(300, i / half);
        const hi = 40 * Math.pow(300, (i + 1) / half);
        const v = Math.min(1, band(data, sr, lo, hi) * 1.8);
        s.spikes[i] = follow(s.spikes[i], v);
      }

      const shake = calm ? 0 : s.flash * dpr * 3.5;
      const ox = cx + (Math.random() - 0.5) * shake;
      const oy = cy + (Math.random() - 0.5) * shake;
      const base = unit * 0.2;
      const r = base * (1 + s.x * 0.55);

      // shock rings: expand and fade after each hit
      ctx.strokeStyle = accent;
      s.waves = s.waves.filter((wave) => {
        wave.age += 0.045;
        if (wave.age >= 1) return false;
        ctx.globalAlpha = (1 - wave.age) * 0.6 * wave.power;
        ctx.lineWidth = dpr * (0.8 + (1 - wave.age) * 2);
        ctx.beginPath();
        ctx.arc(ox, oy, r + wave.age * unit * (0.2 + 0.2 * wave.power), 0, Math.PI * 2);
        ctx.stroke();
        return true;
      });

      // core flash
      if (s.flash > 0.02) {
        ctx.globalAlpha = Math.min(0.5, s.flash * 0.4);
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(ox, oy, r * (0.55 + s.flash * 0.25), 0, Math.PI * 2);
        ctx.fill();
      }

      // the ring itself: radius punched by the spring, outline pushed out by the spectrum
      ctx.beginPath();
      for (let i = 0; i <= RING_SPIKES; i++) {
        const k = i % RING_SPIKES;
        const idx = k < half ? k : RING_SPIKES - 1 - k;
        const angle = (k / RING_SPIKES) * Math.PI * 2 - Math.PI / 2;
        const rr = r + s.spikes[idx] * unit * 0.14 + air * unit * 0.02;
        const px = ox + Math.cos(angle) * rr;
        const py = oy + Math.sin(angle) * rr;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = ink;
      ctx.lineWidth = dpr * (1.1 + Math.max(0, s.x) * 2.6);
      ctx.stroke();
    } else if (kind === "bass") {
      // The real bass waveform, drawn like an oscilloscope. Three things keep it steady instead of jittery:
      //  1. a light smoothing of the samples removes hiss without hiding the shape,
      //  2. the trace is locked to a rising zero-crossing with hysteresis, so it does not jump between frames,
      //  3. the window always spans ~2 periods of the detected pitch, so a higher note visibly packs more
      //     waves into the view and a lower note stretches them out.
      const wave = player.getWaveform(name);
      if (wave && wave.length > 4) {
        const n = wave.length;
        const smooth = s.scratch.length === n ? s.scratch : (s.scratch = new Float32Array(n));
        let peak = 0;
        for (let i = 2; i < n - 2; i++) {
          smooth[i] = (wave[i - 2] + 2 * wave[i - 1] + 3 * wave[i] + 2 * wave[i + 1] + wave[i + 2]) / 9;
          const a = Math.abs(smooth[i]);
          if (a > peak) peak = a;
        }
        s.bass += (peak - s.bass) * (peak > s.bass ? 0.5 : 0.1);
        if (!Number.isFinite(s.bass)) s.bass = 0;

        // rising zero-crossings with hysteresis (must dip below -thr before crossing up)
        const thr = Math.max(0.01, s.bass * 0.12);
        const crossings: number[] = [];
        let armed = false;
        for (let i = 2; i < n - 2; i++) {
          if (smooth[i] < -thr) armed = true;
          else if (armed && smooth[i] >= 0) {
            crossings.push(i);
            armed = false;
          }
        }
        if (crossings.length >= 2) {
          const measured = (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1);
          if (Number.isFinite(measured) && measured > 0) {
            s.period += (measured - s.period) * 0.25;
          }
        }
        if (!Number.isFinite(s.period) || s.period < 16) s.period = 512;

        const span = Math.max(32, Math.min(n - 4, Math.round(s.period * 2)));

        // Find the first crossing that leaves enough room for span, or default to safe start
        let start = 2;
        for (const c of crossings) {
          if (c + span < n) {
            start = c;
            break;
          }
        }

        const points = s.trace.length;
        const gain = 2.4;
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.45 + Math.min(1, s.bass * 2.5) * 0.5;
        ctx.lineWidth = dpr * (1.3 + Math.min(1, s.bass * 2) * 1.5);
        ctx.beginPath();
        for (let p = 0; p < points; p++) {
          const sampleIdx = Math.min(n - 1, Math.max(0, start + Math.floor((p / (points - 1)) * (span - 1))));
          const rawSample = smooth[sampleIdx];
          const sample = Number.isFinite(rawSample) ? rawSample : 0;
          const target = Math.tanh(sample * gain); // soft limit: loud notes round off instead of clipping flat

          if (!Number.isFinite(s.trace[p])) s.trace[p] = 0;
          s.trace[p] += (target - s.trace[p]) * 0.7; // tiny temporal blend against frame-to-frame flicker
          if (!Number.isFinite(s.trace[p])) s.trace[p] = 0;

          const taper = Math.sin((Math.PI * p) / (points - 1));
          const y = cy - s.trace[p] * ah * 0.44 * (0.3 + 0.7 * taper);
          const safeY = Number.isFinite(y) ? y : cy;
          const x = (p / (points - 1)) * w;
          if (p === 0) ctx.moveTo(x, safeY);
          else ctx.lineTo(x, safeY);
        }
        ctx.stroke();
      }
    } else {
      // 40 thin bars across 200 Hz .. 12 kHz
      const n = OTHER_BARS;
      const gap = w / n;
      ctx.fillStyle = ink;
      for (let i = 0; i < n; i++) {
        const lo = 200 * Math.pow(60, i / n);
        const hi = 200 * Math.pow(60, (i + 1) / n);
        s.bars[i] = follow(s.bars[i], Math.min(1, band(data, sr, lo, hi) * 2.1));
        const bh = Math.max(dpr * 2, s.bars[i] * ah * 0.88);
        ctx.globalAlpha = 0.3 + s.bars[i] * 0.65;
        ctx.fillRect(i * gap + gap * 0.28, cy - bh / 2, Math.max(dpr, gap * 0.44), bh);
      }
    }
    ctx.globalAlpha = 1;
  });

  const label = LABELS[name] ?? { en: name, th: name };
  return (
    <div className="viz-panel">
      <canvas ref={canvas} aria-hidden="true" className="viz-canvas" />
      <span className="viz-label">{language === "en" ? label.en : label.th}</span>
    </div>
  );
}

export default function Visualizer({ player }: { player: StemPlayer }) {
  const { t } = useLanguage();
  return (
    <div className="viz-grid" role="img" aria-label={t("ภาพเคลื่อนไหวตอบสนองต่อเสียงของแต่ละแทร็ก", "Per-track audio-reactive visualizer")}>
      {player.tracks.map((track) => (
        <StemScope key={track.name} player={player} name={track.name} />
      ))}
    </div>
  );
}

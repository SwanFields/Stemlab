import { useEffect, useRef } from "react";
import type { StemName } from "../api";

interface Props {
  /** How often each stem is saved; sets the size and brightness of its ring. */
  weights: Record<StemName, number>;
  /** 0..1, how active the account was this month; drives spin speed and pulse. */
  intensity: number;
  size?: number;
  label: string;
}

const ORDER: StemName[] = ["vocals", "drums", "bass", "other"];
const RING_POINTS = 56;
const CORE_POINTS = 70;

// [dark theme, light theme]
const COLORS: Record<StemName, [string, string]> = {
  vocals: ["224,174,145", "168,111,80"],
  drums: ["226,226,226", "70,64,58"],
  bass: ["160,150,140", "110,98,88"],
  other: ["190,170,160", "140,118,104"],
};

interface Dot {
  x: number;
  y: number;
  z: number;
  ring: number; // -1 = core
  phase: number;
}

function buildDots(): Dot[] {
  const dots: Dot[] = [];
  // core: fibonacci sphere
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < CORE_POINTS; i++) {
    const y = 1 - (i / (CORE_POINTS - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const a = golden * i;
    dots.push({ x: Math.cos(a) * r * 0.28, y: y * 0.28, z: Math.sin(a) * r * 0.28, ring: -1, phase: i });
  }
  // four tilted orbit rings, one per stem
  ORDER.forEach((_, ring) => {
    const radius = 0.52 + ring * 0.13;
    const tiltX = (ring * Math.PI) / 4 + 0.35;
    const tiltZ = ring % 2 === 0 ? 0.5 : -0.5;
    for (let i = 0; i < RING_POINTS; i++) {
      const a = (i / RING_POINTS) * Math.PI * 2;
      let x = Math.cos(a) * radius;
      let y = 0;
      let z = Math.sin(a) * radius;
      // tilt around X, then Z
      const y1 = y * Math.cos(tiltX) - z * Math.sin(tiltX);
      const z1 = y * Math.sin(tiltX) + z * Math.cos(tiltX);
      y = y1;
      z = z1;
      const x2 = x * Math.cos(tiltZ) - y * Math.sin(tiltZ);
      const y2 = x * Math.sin(tiltZ) + y * Math.cos(tiltZ);
      x = x2;
      y = y2;
      dots.push({ x, y, z, ring, phase: i });
    }
  });
  return dots;
}

/** Small canvas-only 3D scene: a pulsing core with one orbit ring per stem type. */
export default function ProfileOrb({ weights, intensity, size = 168, label }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ weights, intensity });
  live.current = { weights, intensity };
  const dataKey = `${ORDER.map((k) => weights[k] || 0).join(",")}|${intensity.toFixed(2)}`;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const dots = buildDots();
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let raf = 0;
    let angle = 0.6;
    let last = performance.now();
    let pointerTilt = 0;
    let targetTilt = 0;

    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      targetTilt = ((e.clientY - rect.top) / rect.height - 0.5) * 0.7;
    };
    const onLeave = () => { targetTilt = 0; };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { weights: w, intensity: act } = live.current;
      const light = document.documentElement.dataset.theme === "light";
      const total = ORDER.reduce((sum, k) => sum + (w[k] || 0), 0);

      if (!reduced) angle += dt * (0.25 + act * 0.9);
      pointerTilt += (targetTilt - pointerTilt) * 0.08;

      ctx.clearRect(0, 0, size, size);
      const cx = size / 2;
      const cy = size / 2;
      const scale = size * 0.42;
      const tilt = 0.45 + pointerTilt;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const cosT = Math.cos(tilt);
      const sinT = Math.sin(tilt);
      const pulse = reduced ? 1 : 1 + Math.sin(now / 420) * (0.04 + act * 0.1);

      const projected = dots.map((d) => {
        let x = d.x;
        let y = d.y;
        let z = d.z;
        if (d.ring === -1) { x *= pulse; y *= pulse; z *= pulse; }
        // spin around Y, tilt around X
        const x1 = x * cosA + z * sinA;
        const z1 = -x * sinA + z * cosA;
        const y2 = y * cosT - z1 * sinT;
        const z2 = y * sinT + z1 * cosT;
        const persp = 1 / (1.9 - z2);
        return { d, sx: cx + x1 * scale * persp * 1.9, sy: cy + y2 * scale * persp * 1.9, depth: z2, persp };
      });
      projected.sort((a, b) => a.depth - b.depth);

      for (const p of projected) {
        const depthAlpha = 0.25 + ((p.depth + 0.8) / 1.6) * 0.75;
        let rgb: string;
        let radius: number;
        let alpha: number;
        if (p.d.ring === -1) {
          rgb = COLORS.vocals[light ? 1 : 0];
          radius = 1.1 * p.persp * 1.9;
          alpha = depthAlpha * (0.55 + act * 0.4);
        } else {
          const stem = ORDER[p.d.ring];
          const share = total > 0 ? (w[stem] || 0) / total : 0.25;
          rgb = COLORS[stem][light ? 1 : 0];
          // a bright dot travels around each ring
          const head = ((now / 1000) * (0.25 + act)) % 1;
          const near = Math.abs(((p.d.phase / RING_POINTS - head + 1.5) % 1) - 0.5);
          const glow = reduced ? 0 : Math.max(0, 1 - near * 6);
          radius = (0.6 + share * 2.4 + glow * 1.6) * p.persp * 1.9;
          alpha = Math.min(1, depthAlpha * (0.3 + share * 1.1) + glow * 0.5);
        }
        ctx.beginPath();
        ctx.fillStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
        ctx.arc(p.sx, p.sy, Math.max(0.4, radius), 0, Math.PI * 2);
        ctx.fill();
      }
      if (!reduced) raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, [size, dataKey]);

  return (
    <canvas
      ref={canvasRef}
      className="profile-orb"
      style={{ width: size, height: size }}
      role="img"
      aria-label={label}
    />
  );
}

import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  DELAY_DIVISIONS,
  EQ_MAX_DB,
  EQ_MAX_HZ,
  EQ_MIN_HZ,
  REVERB_PRESETS,
  clampNum,
  defaultFx,
  eqBandType,
  eqCurveDb,
  formatHz,
  fxActive,
  hzFromUnit,
  unitFromHz,
  type TrackFx,
} from "../../audio/FxChain";
import { useLanguage } from "../Language";

interface Props {
  trackName: string;
  fx: TrackFx;
  sampleRate: number;
  onChange: (fx: TrackFx, record: boolean) => void;
  onClose: () => void;
}

type ModuleKey = "filter" | "eq" | "delay" | "reverb";

const EQ_W = 360;
const EQ_H = 150;
const CURVE_POINTS = 120;
const curveFreqs = Float32Array.from({ length: CURVE_POINTS }, (_, i) => hzFromUnit(i / (CURVE_POINTS - 1)));
const GRID_HZ = [50, 100, 200, 500, 1000, 2000, 5000, 10000];

const dbToY = (db: number) => EQ_H / 2 - (clampNum(db, -EQ_MAX_DB, EQ_MAX_DB) / EQ_MAX_DB) * (EQ_H / 2 - 10);
const yToDb = (y: number) => clampNum(((EQ_H / 2 - y) / (EQ_H / 2 - 10)) * EQ_MAX_DB, -EQ_MAX_DB, EQ_MAX_DB);

export default function FxPanel({ trackName, fx, sampleRate, onChange, onClose }: Props) {
  const { t, language } = useLanguage();
  const [band, setBand] = useState(3);
  const svgRef = useRef<SVGSVGElement>(null);

  /** Edits one module. Touching any knob switches the module on, so a tweak is always audible. */
  const edit = <K extends ModuleKey>(key: K, patch: Partial<TrackFx[K]>, record = false, autoOn = true) => {
    const next = { ...fx, [key]: { ...fx[key], ...patch, ...(autoOn && !("on" in patch) ? { on: true } : null) } } as TrackFx;
    onChange(next, record);
  };
  const toggle = (key: ModuleKey) => onChange({ ...fx, [key]: { ...fx[key], on: !fx[key].on } }, true);
  const resetAll = () => onChange(defaultFx(), true);

  // ---- EQ ---------------------------------------------------------------------
  const curve = useMemo(() => eqCurveDb(fx.eq.bands, curveFreqs, sampleRate), [fx.eq.bands, sampleRate]);
  const curvePath = useMemo(
    () => Array.from(curve, (db, i) => `${i === 0 ? "M" : "L"}${((i / (CURVE_POINTS - 1)) * EQ_W).toFixed(1)} ${dbToY(db).toFixed(1)}`).join(" "),
    [curve],
  );

  const setBandValues = (index: number, patch: Partial<{ freq: number; gain: number; q: number }>, record = false) => {
    const bands = fx.eq.bands.map((b, i) => (i === index ? { ...b, ...patch } : b));
    onChange({ ...fx, eq: { ...fx.eq, on: true, bands } }, record);
  };

  const onPointDown = (event: ReactPointerEvent<SVGCircleElement>, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    setBand(index);
    const svg = svgRef.current;
    if (!svg) return;
    const shelf = eqBandType(index) !== "peaking";
    const move = (e: PointerEvent) => {
      const rect = svg.getBoundingClientRect();
      const x = clampNum(((e.clientX - rect.left) / rect.width) * EQ_W, 0, EQ_W);
      const y = clampNum(((e.clientY - rect.top) / rect.height) * EQ_H, 0, EQ_H);
      const gain = Math.round(yToDb(y) * 2) / 2;
      const freq = hzFromUnit(x / EQ_W);
      const lo = index === 0 ? EQ_MIN_HZ : fx.eq.bands[index - 1].freq * 1.05;
      const hi = index === fx.eq.bands.length - 1 ? EQ_MAX_HZ : fx.eq.bands[index + 1].freq / 1.05;
      setBandValues(index, { gain, freq: shelf ? clampNum(freq, lo, hi) : clampNum(freq, Math.max(lo, EQ_MIN_HZ), Math.min(hi, EQ_MAX_HZ)) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const sel = fx.eq.bands[band];
  const label = (th: string, en: string) => (language === "th" ? th : en);

  return (
    <section className="daw-fx" aria-label={t(`เอฟเฟกต์ของ ${trackName}`, `Effects for ${trackName}`)}>
      <header className="daw-fx-head">
        <strong>
          FX <span>· {trackName}</span>
        </strong>
        <span className="daw-fx-sub">{t("Filter → EQ → Delay → Reverb", "Filter → EQ → Delay → Reverb")}</span>
        <div className="daw-fx-head-actions">
          <button type="button" className="daw-btn" onClick={resetAll} disabled={!fxActive(fx) && JSON.stringify(fx) === JSON.stringify(defaultFx())}>
            {t("รีเซ็ตทั้งหมด", "Reset all")}
          </button>
          <button type="button" className="daw-btn" onClick={onClose}>
            {t("ปิด", "Close")}
          </button>
        </div>
      </header>

      <div className="daw-fx-grid">
        {/* ---- Filter ---- */}
        <Module title="Filter" on={fx.filter.on} onToggle={() => toggle("filter")}>
          <Knob
            label={t("ตัดเสียงต่ำ (HP)", "High-pass")}
            value={unitFromHz(fx.filter.hp)}
            display={`${formatHz(fx.filter.hp)} Hz`}
            onChange={(u) => edit("filter", { hp: Math.min(hzFromUnit(u), fx.filter.lp * 0.9) })}
          />
          <Knob
            label={t("ตัดเสียงสูง (LP)", "Low-pass")}
            value={unitFromHz(fx.filter.lp)}
            display={`${formatHz(fx.filter.lp)} Hz`}
            onChange={(u) => edit("filter", { lp: Math.max(hzFromUnit(u), fx.filter.hp * 1.1) })}
          />
          <Knob label={t("เรโซแนนซ์", "Resonance")} value={(fx.filter.res - 0.5) / 11.5} display={fx.filter.res.toFixed(1)} onChange={(u) => edit("filter", { res: 0.5 + u * 11.5 })} />
        </Module>

        {/* ---- EQ ---- */}
        <Module title="EQ Eight" wide on={fx.eq.on} onToggle={() => toggle("eq")}>
          <svg ref={svgRef} className="daw-eq-graph" viewBox={`0 0 ${EQ_W} ${EQ_H}`} role="img" aria-label={t("กราฟ EQ ลากจุดเพื่อปรับ", "EQ graph, drag the points")}>
            {GRID_HZ.map((hz) => (
              <g key={hz}>
                <line x1={unitFromHz(hz) * EQ_W} x2={unitFromHz(hz) * EQ_W} y1={0} y2={EQ_H} className="daw-eq-grid" />
                <text x={unitFromHz(hz) * EQ_W + 2} y={EQ_H - 3} className="daw-eq-axis">
                  {formatHz(hz)}
                </text>
              </g>
            ))}
            {[-12, -6, 0, 6, 12].map((db) => (
              <line key={db} x1={0} x2={EQ_W} y1={dbToY(db)} y2={dbToY(db)} className={db === 0 ? "daw-eq-zero" : "daw-eq-grid"} />
            ))}
            <path d={curvePath} className={`daw-eq-curve${fx.eq.on ? " is-on" : ""}`} />
            {fx.eq.bands.map((b, i) => (
              <g key={i}>
                <circle
                  cx={unitFromHz(b.freq) * EQ_W}
                  cy={dbToY(b.gain)}
                  r={i === band ? 7 : 5.5}
                  className={`daw-eq-point${i === band ? " is-selected" : ""}`}
                  onPointerDown={(e) => onPointDown(e, i)}
                  onDoubleClick={() => setBandValues(i, { gain: 0 }, true)}
                />
                <text x={unitFromHz(b.freq) * EQ_W} y={dbToY(b.gain) + 3} className="daw-eq-num">
                  {i + 1}
                </text>
              </g>
            ))}
          </svg>
          <div className="daw-eq-bands" role="tablist" aria-label={t("แบนด์ EQ", "EQ bands")}>
            {fx.eq.bands.map((b, i) => (
              <button key={i} type="button" role="tab" aria-selected={i === band} className={`daw-chip${i === band ? " is-on is-solo" : ""}${b.gain !== 0 ? " has-gain" : ""}`} onClick={() => setBand(i)}>
                {i + 1}
              </button>
            ))}
          </div>
          <div className="daw-fx-row">
            <Knob label={t("ความถี่", "Freq")} value={unitFromHz(sel.freq)} display={`${formatHz(sel.freq)} Hz`} onChange={(u) => setBandValues(band, { freq: hzFromUnit(u) })} />
            <Knob label={t("เกน", "Gain")} value={(sel.gain + EQ_MAX_DB) / (2 * EQ_MAX_DB)} display={`${sel.gain > 0 ? "+" : ""}${sel.gain.toFixed(1)} dB`} onChange={(u) => setBandValues(band, { gain: Math.round((u * 2 * EQ_MAX_DB - EQ_MAX_DB) * 2) / 2 })} />
            <Knob label="Q" value={(sel.q - 0.2) / 9.8} display={sel.q.toFixed(2)} disabled={eqBandType(band) !== "peaking"} onChange={(u) => setBandValues(band, { q: 0.2 + u * 9.8 })} />
          </div>
        </Module>

        {/* ---- Delay ---- */}
        <Module title="Delay" on={fx.delay.on} onToggle={() => toggle("delay")}>
          <div className="daw-seg" role="group" aria-label={t("ช่วงเวลาดีเลย์", "Delay time")}>
            {DELAY_DIVISIONS.map((d, i) => (
              <button key={d.label} type="button" className={`daw-seg-btn${fx.delay.division === i ? " is-on" : ""}`} aria-pressed={fx.delay.division === i} onClick={() => edit("delay", { division: i }, true)}>
                {d.label}
              </button>
            ))}
          </div>
          <Knob label={t("ฟีดแบ็ก", "Feedback")} value={fx.delay.feedback / 0.92} display={`${Math.round(fx.delay.feedback * 100)}%`} onChange={(u) => edit("delay", { feedback: u * 0.92 })} />
          <Knob label={t("มิกซ์", "Mix")} value={fx.delay.mix} display={`${Math.round(fx.delay.mix * 100)}%`} onChange={(u) => edit("delay", { mix: u })} />
          <Knob label={t("โทน (ตัดแหลม)", "Tone")} value={unitFromHz(fx.delay.tone, 400, 18000)} display={`${formatHz(fx.delay.tone)} Hz`} onChange={(u) => edit("delay", { tone: hzFromUnit(u, 400, 18000) })} />
        </Module>

        {/* ---- Reverb ---- */}
        <Module title="Reverb" on={fx.reverb.on} onToggle={() => toggle("reverb")}>
          <div className="daw-seg" role="group" aria-label={t("พรีเซ็ตรีเวิร์บ", "Reverb preset")}>
            {REVERB_PRESETS.map((p) => (
              <button key={p.key} type="button" className="daw-seg-btn" onClick={() => edit("reverb", p.values, true)}>
                {label(p.th, p.en)}
              </button>
            ))}
          </div>
          <Knob label={t("มิกซ์", "Mix")} value={fx.reverb.mix} display={`${Math.round(fx.reverb.mix * 100)}%`} onChange={(u) => edit("reverb", { mix: u })} />
          <Knob label={t("ดีเคย์", "Decay")} value={(fx.reverb.decay - 0.3) / 7.7} display={`${fx.reverb.decay.toFixed(1)} s`} onChange={(u) => edit("reverb", { decay: 0.3 + u * 7.7 })} />
          <Knob label="Pre-delay" value={fx.reverb.predelay / 0.15} display={`${Math.round(fx.reverb.predelay * 1000)} ms`} onChange={(u) => edit("reverb", { predelay: u * 0.15 })} />
          <Knob label={t("ทึบ (Damping)", "Damping")} value={fx.reverb.damping} display={`${Math.round(fx.reverb.damping * 100)}%`} onChange={(u) => edit("reverb", { damping: u })} />
        </Module>
      </div>
    </section>
  );
}

function Module({ title, on, onToggle, wide, children }: { title: string; on: boolean; onToggle: () => void; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`daw-fx-mod${on ? " is-on" : ""}${wide ? " is-wide" : ""}`}>
      <div className="daw-fx-mod-head">
        <button type="button" className={`daw-power${on ? " is-on" : ""}`} aria-pressed={on} onClick={onToggle} aria-label={`${title} on/off`} title="On / Off" />
        <span>{title}</span>
      </div>
      <div className="daw-fx-mod-body">{children}</div>
    </div>
  );
}

function Knob({ label, value, display, onChange, disabled }: { label: string; value: number; display: string; onChange: (unit: number) => void; disabled?: boolean }) {
  return (
    <label className="daw-fx-knob">
      <span className="daw-fx-knob-label">{label}</span>
      <input type="range" min={0} max={1} step={0.002} value={clampNum(value, 0, 1)} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} aria-valuetext={display} />
      <span className="daw-fx-knob-value">{display}</span>
    </label>
  );
}

/**
 * Quick FX chain, one per track (Web Audio).
 *
 *   input -> Utility (gain) -> Filter (HPF + LPF) -> EQ (8 bands) -> Delay (tempo-synced) -> Reverb -> output
 *
 * The same class builds the live chain and the offline (export) chain, so what you hear
 * is what you render. Every module has an on/off switch; a disabled module is bypassed by
 * parking its parameters at neutral values, so toggling never clicks or rewires the graph.
 */

export interface UtilityFx {
  on: boolean;
  /** Gain in dB, UTILITY_MIN_DB..UTILITY_MAX_DB. Applied before the other effects. */
  gain: number;
}

export interface FilterFx {
  on: boolean;
  /** High-pass cutoff, Hz. */
  hp: number;
  /** Low-pass cutoff, Hz. */
  lp: number;
  /** Resonance (Q) shared by both filters. */
  res: number;
}

export interface EqBand {
  freq: number;
  /** dB, -15..15 */
  gain: number;
  q: number;
}

export interface EqFx {
  on: boolean;
  bands: EqBand[];
}

export interface DelayFx {
  on: boolean;
  /** Index into DELAY_DIVISIONS. */
  division: number;
  /** 0..0.92 */
  feedback: number;
  /** Wet level 0..1 */
  mix: number;
  /** Cutoff of the low-pass inside the feedback loop, Hz. */
  tone: number;
}

export interface ReverbFx {
  on: boolean;
  /** Wet level 0..1 */
  mix: number;
  /** Decay time (RT60), seconds. */
  decay: number;
  /** Pre-delay, seconds. */
  predelay: number;
  /** 0 = bright, 1 = dark. */
  damping: number;
}

export interface TrackFx {
  utility: UtilityFx;
  filter: FilterFx;
  eq: EqFx;
  delay: DelayFx;
  reverb: ReverbFx;
}

export const UTILITY_MIN_DB = -12;
export const UTILITY_MAX_DB = 24;

export const EQ_BAND_COUNT = 8;
export const EQ_MIN_HZ = 20;
export const EQ_MAX_HZ = 20000;
export const EQ_MAX_DB = 15;

/** Beats per delay repeat. */
export const DELAY_DIVISIONS: { label: string; beats: number }[] = [
  { label: "1/16", beats: 0.25 },
  { label: "1/8", beats: 0.5 },
  { label: "1/8 ·", beats: 0.75 },
  { label: "1/4", beats: 1 },
  { label: "1/4 ·", beats: 1.5 },
  { label: "1/2", beats: 2 },
];

export interface ReverbPreset {
  key: string;
  th: string;
  en: string;
  values: Pick<ReverbFx, "mix" | "decay" | "predelay" | "damping">;
}

export const REVERB_PRESETS: ReverbPreset[] = [
  { key: "room", th: "ห้องเล็ก", en: "Room", values: { mix: 0.16, decay: 0.8, predelay: 0.004, damping: 0.45 } },
  { key: "plate", th: "เพลท", en: "Plate", values: { mix: 0.18, decay: 1.8, predelay: 0.012, damping: 0.3 } },
  { key: "hall", th: "ฮอลล์", en: "Hall", values: { mix: 0.2, decay: 3.4, predelay: 0.025, damping: 0.5 } },
  { key: "vintage", th: "วินเทจ", en: "Vintage", values: { mix: 0.14, decay: 2.4, predelay: 0.018, damping: 0.72 } },
];

const EQ_DEFAULT_FREQS = [60, 150, 400, 1000, 2500, 5000, 9000, 12000];
const EQ_DEFAULT_Q = [0.7, 1, 1, 1, 1, 1, 1, 0.7];

export const eqBandType = (index: number): BiquadFilterType =>
  index === 0 ? "lowshelf" : index === EQ_BAND_COUNT - 1 ? "highshelf" : "peaking";

export function defaultFx(): TrackFx {
  return {
    utility: { on: false, gain: 6 },
    filter: { on: false, hp: 80, lp: 12000, res: 0.7 },
    eq: {
      on: false,
      bands: EQ_DEFAULT_FREQS.map((freq, i) => ({ freq, gain: 0, q: EQ_DEFAULT_Q[i] })),
    },
    delay: { on: false, division: 1, feedback: 0.38, mix: 0.25, tone: 5500 },
    reverb: { on: false, ...REVERB_PRESETS[1].values },
  };
}

/** True when any module is switched on (used for the little indicator on the track header). */
export function fxActive(fx: TrackFx): boolean {
  return fx.utility.on || fx.filter.on || fx.eq.on || fx.delay.on || fx.reverb.on;
}

/** Names of the modules that are switched on, e.g. ["Delay", "Reverb"]. */
export function fxActiveModules(fx: TrackFx): string[] {
  const names: string[] = [];
  if (fx.utility.on) names.push("Utility");
  if (fx.filter.on) names.push("Filter");
  if (fx.eq.on) names.push("EQ");
  if (fx.delay.on) names.push("Delay");
  if (fx.reverb.on) names.push("Reverb");
  return names;
}

/** Seconds of tail the effects add after the last clip ends, for offline rendering. */
export function fxTailSeconds(fx: TrackFx, bpm: number): number {
  let tail = 0;
  if (fx.reverb.on) tail = Math.max(tail, fx.reverb.decay + fx.reverb.predelay);
  if (fx.delay.on) {
    const step = (DELAY_DIVISIONS[fx.delay.division]?.beats ?? 1) * (60 / bpm);
    const repeats = Math.ceil(Math.log(0.001) / Math.log(Math.max(0.05, fx.delay.feedback)));
    tail = Math.max(tail, Math.min(12, repeats * step));
  }
  return tail;
}

// ---- helpers ------------------------------------------------------------------

export const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Log mapping between a 0..1 slider and a frequency. */
export const hzFromUnit = (u: number, lo = EQ_MIN_HZ, hi = EQ_MAX_HZ) => lo * Math.pow(hi / lo, clampNum(u, 0, 1));
export const unitFromHz = (hz: number, lo = EQ_MIN_HZ, hi = EQ_MAX_HZ) => Math.log(clampNum(hz, lo, hi) / lo) / Math.log(hi / lo);

export function formatHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2).replace(/\.?0+$/, "")}k` : `${Math.round(hz)}`;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Synthesises a stereo impulse response: early reflections, then a dense noise tail that
 * decays exponentially (-60 dB at `decay`) while a one-pole low-pass slowly closes, which is
 * what gives the tail its soft, vintage-plate feel. Seeded, so the same settings always
 * produce the same room (no shimmer when you nudge another knob).
 */
export function buildReverbImpulse(ctx: BaseAudioContext, decay: number, damping: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = clampNum(decay * 1.15 + 0.1, 0.3, 9);
  const length = Math.max(1, Math.floor(seconds * rate));
  const buffer = ctx.createBuffer(2, length, rate);
  const rt60 = Math.max(0.1, decay);
  const startHz = 15000 - damping * 11000; // bright..dark at the start of the tail
  const endHz = 5500 - damping * 4500; // where the tail ends up after one RT60
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    const rand = mulberry32(0x9e3779b1 + ch * 7919);
    let y = 0;
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      const env = Math.exp((-6.9078 * t) / rt60);
      const attack = Math.min(1, t / 0.012);
      const fc = Math.max(300, endHz + (startHz - endHz) * Math.exp((-3 * t) / rt60));
      const a = 1 - Math.exp((-2 * Math.PI * fc) / rate);
      y += a * ((rand() * 2 - 1) - y);
      data[i] = y * env * attack;
    }
    // Early reflections: a handful of discrete taps in the first ~70 ms.
    const taps = 9;
    for (let k = 0; k < taps; k++) {
      const at = Math.floor((0.004 + rand() * 0.066) * rate);
      if (at < length) data[at] += (rand() < 0.5 ? -1 : 1) * (0.9 - (k / taps) * 0.6) * (0.55 + rand() * 0.45);
    }
  }
  return buffer;
}

/**
 * Combined EQ magnitude (dB) at each frequency, computed from the RBJ biquad formulas so the
 * drawn curve matches the filters exactly and reacts instantly while a point is dragged.
 */
export function eqCurveDb(bands: EqBand[], freqs: ArrayLike<number>, sampleRate: number): Float32Array {
  const out = new Float32Array(freqs.length);
  bands.forEach((b, idx) => {
    if (b.gain === 0) return;
    const type = eqBandType(idx);
    const A = Math.pow(10, b.gain / 40);
    const w0 = (2 * Math.PI * clampNum(b.freq, 1, sampleRate / 2 - 1)) / sampleRate;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    if (type === "peaking") {
      const alpha = sin / (2 * Math.max(0.1, b.q));
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
    } else {
      // Shelves use S = 1 (the Web Audio behaviour).
      const alpha = (sin / 2) * Math.SQRT2;
      const sq = 2 * Math.sqrt(A) * alpha;
      if (type === "lowshelf") {
        b0 = A * (A + 1 - (A - 1) * cos + sq);
        b1 = 2 * A * (A - 1 - (A + 1) * cos);
        b2 = A * (A + 1 - (A - 1) * cos - sq);
        a0 = A + 1 + (A - 1) * cos + sq;
        a1 = -2 * (A - 1 + (A + 1) * cos);
        a2 = A + 1 + (A - 1) * cos - sq;
      } else {
        b0 = A * (A + 1 + (A - 1) * cos + sq);
        b1 = -2 * A * (A - 1 + (A + 1) * cos);
        b2 = A * (A + 1 + (A - 1) * cos - sq);
        a0 = A + 1 - (A - 1) * cos + sq;
        a1 = 2 * (A - 1 - (A + 1) * cos);
        a2 = A + 1 - (A - 1) * cos - sq;
      }
    }
    for (let i = 0; i < freqs.length; i++) {
      const w = (2 * Math.PI * freqs[i]) / sampleRate;
      const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
      const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
      const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
      out[i] += 10 * Math.log10(Math.max(1e-12, (nr * nr + ni * ni) / (dr * dr + di * di)));
    }
  });
  return out;
}

const RAMP = 0.015;

/** The live (or offline) effects processor for one track. */
export class FxProcessor {
  readonly input: GainNode;
  readonly output: GainNode;

  private ctx: BaseAudioContext;
  private util: GainNode;
  private hp: BiquadFilterNode;
  private lp: BiquadFilterNode;
  private eq: BiquadFilterNode[];
  private delay: DelayNode;
  private delayFeedback: GainNode;
  private delayTone: BiquadFilterNode;
  private delayWet: GainNode;
  private reverbDry: GainNode;
  private reverbWet: GainNode;
  private preDelay: DelayNode;
  private convolver: ConvolverNode;
  private reverbLow: BiquadFilterNode;
  private analyserPre: AnalyserNode | null = null;
  private analyserPost: AnalyserNode | null = null;
  private impulseKey = "";
  private impulseTimer = 0;
  private disposed = false;
  private nodes: AudioNode[] = [];

  /** `analysis` adds two spectrum taps (before / after the EQ) for the live EQ display; leave off when rendering. */
  constructor(ctx: BaseAudioContext, fx: TrackFx, bpm: number, analysis = false) {
    this.ctx = ctx;
    const mk = <T extends AudioNode>(node: T): T => {
      this.nodes.push(node);
      return node;
    };

    this.input = mk(ctx.createGain());
    this.output = mk(ctx.createGain());

    this.util = mk(ctx.createGain());
    this.hp = mk(ctx.createBiquadFilter());
    this.hp.type = "highpass";
    this.lp = mk(ctx.createBiquadFilter());
    this.lp.type = "lowpass";
    this.eq = Array.from({ length: EQ_BAND_COUNT }, (_, i) => {
      const f = mk(ctx.createBiquadFilter());
      f.type = eqBandType(i);
      return f;
    });

    // Delay: dry + wet summed into one node feeding the reverb.
    const delayIn = mk(ctx.createGain());
    const delayDry = mk(ctx.createGain());
    const delaySum = mk(ctx.createGain());
    this.delay = mk(ctx.createDelay(6));
    this.delayFeedback = mk(ctx.createGain());
    this.delayTone = mk(ctx.createBiquadFilter());
    this.delayTone.type = "lowpass";
    this.delayWet = mk(ctx.createGain());

    // Reverb: dry + (pre-delay -> convolver -> low cut) wet.
    this.reverbDry = mk(ctx.createGain());
    this.reverbWet = mk(ctx.createGain());
    this.preDelay = mk(ctx.createDelay(0.5));
    this.convolver = mk(ctx.createConvolver());
    this.reverbLow = mk(ctx.createBiquadFilter());
    this.reverbLow.type = "highpass";
    this.reverbLow.frequency.value = 170;

    // Wiring.
    this.input.connect(this.util);
    this.util.connect(this.hp);
    this.hp.connect(this.lp);
    let prev: AudioNode = this.lp;
    for (const f of this.eq) {
      prev.connect(f);
      prev = f;
    }
    prev.connect(delayIn);

    if (analysis) {
      const tap = (): AnalyserNode => {
        const a = mk(ctx.createAnalyser());
        a.fftSize = 8192; // ~5 Hz per bin at 44.1 kHz, enough to resolve the low end
        a.smoothingTimeConstant = 0.8;
        return a;
      };
      this.analyserPre = tap();
      this.analyserPost = tap();
      this.lp.connect(this.analyserPre);
      prev.connect(this.analyserPost);
    }

    delayIn.connect(delayDry);
    delayDry.connect(delaySum);
    delayIn.connect(this.delay);
    this.delay.connect(this.delayTone);
    this.delayTone.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delay);
    this.delayTone.connect(this.delayWet);
    this.delayWet.connect(delaySum);

    delaySum.connect(this.reverbDry);
    this.reverbDry.connect(this.output);
    delaySum.connect(this.preDelay);
    this.preDelay.connect(this.convolver);
    this.convolver.connect(this.reverbLow);
    this.reverbLow.connect(this.reverbWet);
    this.reverbWet.connect(this.output);

    this.apply(fx, bpm, true, true);
  }

  /** Number of frequency bins getSpectrum() fills (0 when this processor has no analysis taps). */
  get spectrumSize(): number {
    return this.analyserPre?.frequencyBinCount ?? 0;
  }

  /** Spectrum in dB (-Infinity when silent) of the track before or after its EQ. */
  getSpectrum(which: "pre" | "post", out: Float32Array<ArrayBuffer>): boolean {
    const analyser = which === "pre" ? this.analyserPre : this.analyserPost;
    if (!analyser || out.length < analyser.frequencyBinCount) return false;
    analyser.getFloatFrequencyData(out);
    return true;
  }

  /** Pushes a TrackFx state onto the nodes. `immediate` skips smoothing (initial setup). */
  apply(fx: TrackFx, bpm: number, immediate = false, syncImpulse = false) {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    const set = (param: AudioParam, value: number, tc = RAMP) => {
      if (!Number.isFinite(value)) return;
      if (immediate) param.setValueAtTime(value, now);
      else param.setTargetAtTime(value, now, tc);
    };

    // Utility: plain gain, 0 dB (x1) when off
    const u = fx.utility;
    set(this.util.gain, u.on ? Math.pow(10, clampNum(u.gain, UTILITY_MIN_DB, UTILITY_MAX_DB) / 20) : 1);

    // Filter
    const f = fx.filter;
    set(this.hp.frequency, f.on ? clampNum(f.hp, 20, 20000) : 10);
    set(this.lp.frequency, f.on ? clampNum(f.lp, 20, 20000) : Math.min(20000, this.ctx.sampleRate / 2 - 100));
    set(this.hp.Q, f.on ? f.res : 0.7071);
    set(this.lp.Q, f.on ? f.res : 0.7071);

    // EQ
    fx.eq.bands.forEach((b, i) => {
      const node = this.eq[i];
      if (!node) return;
      set(node.frequency, clampNum(b.freq, EQ_MIN_HZ, EQ_MAX_HZ));
      set(node.Q, clampNum(b.q, 0.2, 10));
      set(node.gain, fx.eq.on ? clampNum(b.gain, -EQ_MAX_DB, EQ_MAX_DB) : 0);
    });

    // Delay
    const d = fx.delay;
    const beats = DELAY_DIVISIONS[d.division]?.beats ?? 1;
    set(this.delay.delayTime, clampNum((beats * 60) / bpm, 0.01, 5.9), 0.03);
    set(this.delayFeedback.gain, d.on ? clampNum(d.feedback, 0, 0.92) : 0);
    set(this.delayWet.gain, d.on ? clampNum(d.mix, 0, 1) : 0);
    set(this.delayTone.frequency, clampNum(d.tone, 400, 18000));

    // Reverb
    const r = fx.reverb;
    set(this.reverbWet.gain, r.on ? clampNum(r.mix, 0, 1) * 1.6 : 0);
    set(this.reverbDry.gain, r.on ? 1 - clampNum(r.mix, 0, 1) * 0.35 : 1);
    set(this.preDelay.delayTime, clampNum(r.predelay, 0, 0.45), 0.02);
    if (r.on) this.ensureImpulse(r, syncImpulse);
  }

  private ensureImpulse(r: ReverbFx, now: boolean) {
    const key = `${r.decay.toFixed(2)}|${r.damping.toFixed(2)}|${this.ctx.sampleRate}`;
    if (key === this.impulseKey) return;
    const build = () => {
      if (this.disposed) return;
      this.impulseKey = key;
      this.convolver.buffer = buildReverbImpulse(this.ctx, r.decay, r.damping);
    };
    window.clearTimeout(this.impulseTimer);
    // Sliders fire many times a second; build the room once they settle.
    if (now || !this.convolver.buffer) build();
    else this.impulseTimer = window.setTimeout(build, 90);
  }

  dispose() {
    this.disposed = true;
    window.clearTimeout(this.impulseTimer);
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }
}

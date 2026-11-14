/**
 * Mini DAW engine (Web Audio).
 *
 * Model
 *  - Source : a decoded AudioBuffer (a stem or a user file) with a BPM.
 *  - Track  : a lane with volume / pan / mute / solo and a list of clips.
 *  - Clip   : a region of a source placed on a lane. `start` is in BEATS (timeline
 *             position); `offset` / `dur` are in SECONDS of the source.
 *             Warped clips are time-stretched by playbackRate = projectBpm / sourceBpm,
 *             so they keep their length in beats when the tempo changes.
 *
 * The project is immutable: every edit calls commit(next), which pushes the old
 * project on the undo stack. Playback is rebuilt from the current position after
 * any edit, so scheduling is always derived from the project state.
 */

export interface DawSource {
  id: string;
  name: string;
  buffer: AudioBuffer;
  /** Max-abs envelope, PEAKS_PER_SECOND buckets per second, normalised to 0..1. */
  peaks: Float32Array;
  color: string;
  bpm: number;
  origin: "stem" | "file";
}

export interface DawClip {
  id: string;
  sourceId: string;
  track: string;
  /** Timeline position in beats. */
  start: number;
  /** Start inside the source, seconds. */
  offset: number;
  /** Length inside the source, seconds. */
  dur: number;
  warp: boolean;
  /** Clip gain, linear 0..2. */
  gain: number;
}

export interface DawTrack {
  id: string;
  name: string;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
}

export interface Project {
  bpm: number;
  beatsPerBar: number;
  tracks: DawTrack[];
  clips: DawClip[];
  loop: { start: number; end: number; on: boolean };
  metronome: boolean;
}

export const PEAKS_PER_SECOND = 100;
export const MIN_BPM = 40;
export const MAX_BPM = 240;
const DECLICK = 0.004; // seconds of fade at clip edges
const LOOKAHEAD = 0.6; // seconds of loop scheduling headroom

let counter = 0;
export const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function computePeaks(buffer: AudioBuffer): Float32Array {
  const buckets = Math.max(1, Math.ceil(buffer.duration * PEAKS_PER_SECOND));
  const peaks = new Float32Array(buckets);
  const size = buffer.length / buckets;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  let overall = 0;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * size);
    const end = Math.min(buffer.length, Math.max(start + 1, Math.floor((b + 1) * size)));
    const stride = Math.max(1, Math.floor((end - start) / 64));
    let max = 0;
    for (const data of channels) {
      for (let i = start; i < end; i += stride) {
        const v = Math.abs(data[i]);
        if (v > max) max = v;
      }
    }
    peaks[b] = max;
    if (max > overall) overall = max;
  }
  if (overall > 0) for (let b = 0; b < buckets; b++) peaks[b] /= overall;
  return peaks;
}

/**
 * Rough tempo estimate: onset envelope + autocorrelation over 70..180 BPM,
 * folded into that range. Good for drums / loops, approximate for anything else,
 * so the UI always lets the person correct it.
 */
export function detectBpm(buffer: AudioBuffer): number {
  const rate = 200; // envelope frames per second
  const hop = Math.max(1, Math.floor(buffer.sampleRate / rate));
  const limit = Math.min(buffer.length, buffer.sampleRate * 90); // first 90 s is plenty
  const frames = Math.floor(limit / hop);
  if (frames < rate * 4) return 120;
  const data = buffer.getChannelData(0);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * hop;
    for (let i = 0; i < hop; i += 2) sum += Math.abs(data[base + i]);
    env[f] = sum / (hop / 2);
  }
  const onset = new Float32Array(frames);
  let mean = 0;
  for (let f = 1; f < frames; f++) {
    onset[f] = Math.max(0, env[f] - env[f - 1]);
    mean += onset[f];
  }
  mean /= frames;
  for (let f = 0; f < frames; f++) onset[f] = Math.max(0, onset[f] - mean);

  let best = 120;
  let bestScore = 0;
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const lag = (60 / bpm) * rate;
    let score = 0;
    for (let k = 1; k <= 4; k++) {
      const l = lag * k;
      const li = Math.floor(l);
      const frac = l - li;
      for (let f = 0; f + li + 1 < frames; f++) {
        score += onset[f] * (onset[f + li] * (1 - frac) + onset[f + li + 1] * frac) / k;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = bpm;
    }
  }
  return Math.round(best * 10) / 10;
}

/** Length of a clip on the timeline, in beats, at the given project tempo. */
export function clipBeats(clip: DawClip, src: DawSource, projectBpm: number): number {
  const bpm = clip.warp ? src.bpm : projectBpm;
  return (clip.dur * bpm) / 60;
}

export function clipRate(clip: DawClip, src: DawSource, projectBpm: number): number {
  return clip.warp ? projectBpm / src.bpm : 1;
}

function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytes = channels * 2;
  const data = new DataView(new ArrayBuffer(44 + frames * bytes));
  const text = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  data.setUint32(4, 36 + frames * bytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, channels, true);
  data.setUint32(24, buffer.sampleRate, true);
  data.setUint32(28, buffer.sampleRate * bytes, true);
  data.setUint16(32, bytes, true);
  data.setUint16(34, 16, true);
  text(36, "data");
  data.setUint32(40, frames * bytes, true);
  const chans = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = clamp(chans[c][i], -1, 1);
      data.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([data], { type: "audio/wav" });
}

interface TrackNodes {
  gain: GainNode;
  pan: StereoPannerNode;
  analyser: AnalyserNode;
}

const DEFAULT_TRACKS = 4;

export function emptyProject(): Project {
  return {
    bpm: 120,
    beatsPerBar: 4,
    tracks: Array.from({ length: DEFAULT_TRACKS }, (_, i) => ({
      id: uid("t"),
      name: `Track ${i + 1}`,
      volume: 0.9,
      pan: 0,
      muted: false,
      solo: false,
    })),
    clips: [],
    loop: { start: 0, end: 4 * 4, on: false },
    metronome: false,
  };
}

export class DawEngine {
  readonly ctx: AudioContext;
  private master: GainNode;
  private nodes = new Map<string, TrackNodes>();
  private active: { node: AudioScheduledSourceNode; end: number }[] = [];
  private audition: AudioBufferSourceNode | null = null;
  private timer = 0;

  sources = new Map<string, DawSource>();
  project: Project = emptyProject();

  private undoStack: Project[] = [];
  private redoStack: Project[] = [];
  private version = 0;
  private listeners = new Set<() => void>();

  playing = false;
  /** Beat at which the transport was (re)started, and the context time it happened. */
  private anchorBeat = 0;
  private anchorTime = 0;
  /** Where Play starts from when stopped. */
  cursor = 0;
  private looping = false;
  private stopBeat = 0; // beat where the scheduled (non-looping) material ends
  private passEnd = 0; // context time at which the last scheduled loop pass ends

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
    this.syncTrackNodes();
  }

  // ---- React store -------------------------------------------------------
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  // ---- Project edits -----------------------------------------------------
  /**
   * Replace the project. `record:false` is for live tweaks (sliders, loop dragging): no undo
   * entry, and any re-scheduling of running audio is debounced.
   */
  commit(next: Project, record = true) {
    const prev = this.project;
    if (record) {
      this.undoStack.push(prev);
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }
    const beat = this.playing ? this.getBeat() : this.cursor;
    const reschedule =
      next.clips !== prev.clips ||
      next.bpm !== prev.bpm ||
      next.beatsPerBar !== prev.beatsPerBar ||
      next.loop !== prev.loop ||
      next.metronome !== prev.metronome;
    this.project = next;
    this.syncTrackNodes();
    this.applyMixer();
    if (this.playing && reschedule) {
      window.clearTimeout(this.restartTimer);
      if (record) this.startAt(beat);
      else this.restartTimer = window.setTimeout(() => this.playing && this.startAt(this.getBeat()), 140);
    }
    this.emit();
  }

  private restartTimer = 0;

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.project);
    this.restore(prev);
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.project);
    this.restore(next);
  }

  private restore(p: Project) {
    const beat = this.playing ? this.getBeat() : this.cursor;
    this.project = p;
    this.syncTrackNodes();
    this.applyMixer();
    if (this.playing) this.startAt(beat);
    this.emit();
  }

  addSource(src: DawSource) {
    this.sources.set(src.id, src);
    this.emit();
  }

  removeUnusedSource(id: string) {
    if (this.project.clips.some((c) => c.sourceId === id)) return false;
    this.sources.delete(id);
    this.emit();
    return true;
  }

  setSourceBpm(id: string, bpm: number) {
    const src = this.sources.get(id);
    if (!src) return;
    src.bpm = clamp(bpm, MIN_BPM, MAX_BPM);
    if (this.playing) this.startAt(this.getBeat());
    this.emit();
  }

  // ---- Mixer graph -------------------------------------------------------
  private syncTrackNodes() {
    const ids = new Set(this.project.tracks.map((t) => t.id));
    for (const [id, n] of this.nodes) {
      if (!ids.has(id)) {
        n.analyser.disconnect();
        n.pan.disconnect();
        n.gain.disconnect();
        this.nodes.delete(id);
      }
    }
    for (const t of this.project.tracks) {
      if (this.nodes.has(t.id)) continue;
      const gain = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      gain.connect(pan);
      pan.connect(analyser);
      analyser.connect(this.master);
      this.nodes.set(t.id, { gain, pan, analyser });
    }
  }

  private effectiveGain(t: DawTrack): number {
    const anySolo = this.project.tracks.some((x) => x.solo);
    const audible = anySolo ? t.solo : !t.muted;
    return audible ? t.volume : 0;
  }

  private applyMixer() {
    const now = this.ctx.currentTime;
    for (const t of this.project.tracks) {
      const n = this.nodes.get(t.id);
      if (!n) continue;
      n.gain.gain.setTargetAtTime(this.effectiveGain(t), now, 0.012);
      n.pan.pan.setTargetAtTime(t.pan, now, 0.012);
    }
  }

  /** Peak level 0..1 of a track, for the header meters. */
  private meterBuf = new Float32Array(1024);
  trackLevel(id: string): number {
    const n = this.nodes.get(id);
    if (!n || !this.playing) return 0;
    n.analyser.getFloatTimeDomainData(this.meterBuf);
    let peak = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const v = Math.abs(this.meterBuf[i]);
      if (v > peak) peak = v;
    }
    return Math.min(1, peak);
  }

  // ---- Transport ---------------------------------------------------------
  private beatToSec(beats: number) {
    return (beats * 60) / this.project.bpm;
  }

  /** End of the last clip, in beats. */
  contentEnd(): number {
    let end = 0;
    for (const c of this.project.clips) {
      const src = this.sources.get(c.sourceId);
      if (!src) continue;
      end = Math.max(end, c.start + clipBeats(c, src, this.project.bpm));
    }
    return end;
  }

  /** Current playhead in beats (handles the loop wrap). */
  getBeat(): number {
    if (!this.playing) return this.cursor;
    let beat = this.anchorBeat + ((this.ctx.currentTime - this.anchorTime) * this.project.bpm) / 60;
    beat = Math.max(beat, this.anchorBeat);
    const { loop } = this.project;
    if (this.looping && beat >= loop.end) {
      beat = loop.start + ((beat - loop.start) % (loop.end - loop.start));
    }
    return beat;
  }

  async play(fromBeat?: number) {
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.startAt(fromBeat ?? this.cursor);
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    this.cursor = this.getBeat();
    this.stopSources();
    this.playing = false;
    this.emit();
  }

  stop() {
    this.stopSources();
    this.playing = false;
    this.cursor = 0;
    this.emit();
  }

  seek(beat: number) {
    const b = Math.max(0, beat);
    if (this.playing) this.startAt(b);
    else this.cursor = b;
    this.emit();
  }

  private stopSources() {
    window.clearInterval(this.timer);
    for (const { node } of this.active) {
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
      node.disconnect();
    }
    this.active = [];
  }

  private startAt(beat: number) {
    this.stopSources();
    this.playing = true;
    this.anchorBeat = beat;
    this.anchorTime = this.ctx.currentTime + 0.05;
    const { loop } = this.project;
    this.looping = loop.on && loop.end > loop.start && beat < loop.end;
    const endBeat = this.looping ? loop.end : Math.max(this.contentEnd(), beat);
    this.stopBeat = endBeat;
    this.passEnd = this.anchorTime + this.beatToSec(endBeat - beat);
    this.scheduleSpan(this.ctx, (id) => this.nodes.get(id)?.gain ?? null, beat, endBeat, this.anchorTime, this.project.metronome, this.active);
    this.timer = window.setInterval(() => this.tick(), 40);
  }

  /** Runs while playing: queues the next loop pass, or stops at the end of the arrangement. */
  private tick() {
    const now = this.ctx.currentTime;
    this.active = this.active.filter((s) => s.end > now);
    if (this.looping) {
      const { loop } = this.project;
      const passSec = this.beatToSec(loop.end - loop.start);
      // Queue passes ahead of time so there is no gap at the loop seam.
      while (this.passEnd < now + LOOKAHEAD) {
        this.scheduleSpan(this.ctx, (id) => this.nodes.get(id)?.gain ?? null, loop.start, loop.end, this.passEnd, this.project.metronome, this.active);
        this.passEnd += passSec;
      }
      return;
    }
    if (this.getBeat() >= this.stopBeat) {
      this.stopSources();
      this.playing = false;
      this.cursor = 0;
      this.emit();
    }
  }

  // ---- Scheduling --------------------------------------------------------
  /**
   * Creates the sources for every clip that overlaps [fromBeat, toBeat) and starts them
   * so that `fromBeat` lands on `when`. Works on the live or an offline context.
   */
  private scheduleSpan(
    ctx: BaseAudioContext,
    destFor: (trackId: string) => AudioNode | null,
    fromBeat: number,
    toBeat: number,
    when: number,
    metronome: boolean,
    keep: { node: AudioScheduledSourceNode; end: number }[] | null,
  ) {
    const bpm = this.project.bpm;
    const secPerBeat = 60 / bpm;
    for (const clip of this.project.clips) {
      const src = this.sources.get(clip.sourceId);
      const dest = destFor(clip.track);
      if (!src || !dest) continue;
      const rate = clipRate(clip, src, bpm);
      const lenBeats = clipBeats(clip, src, bpm);
      const clipStart = clip.start;
      const clipEnd = clip.start + lenBeats;
      if (clipEnd <= fromBeat || clipStart >= toBeat) continue;

      const playFrom = Math.max(clipStart, fromBeat);
      const playTo = Math.min(clipEnd, toBeat);
      const skipBeats = playFrom - clipStart;
      const offset = clip.offset + (skipBeats * secPerBeat) * rate;
      const playSec = (playTo - playFrom) * secPerBeat; // wall-clock duration
      const srcSec = playSec * rate; // how much source that consumes
      if (srcSec <= 0.0005 || offset >= src.buffer.duration) continue;

      const node = ctx.createBufferSource();
      node.buffer = src.buffer;
      node.playbackRate.value = rate;
      const env = ctx.createGain();
      const t0 = when + (playFrom - fromBeat) * secPerBeat;
      const peak = clip.gain;
      const fade = Math.min(DECLICK, playSec / 2);
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(peak, t0 + fade);
      env.gain.setValueAtTime(peak, Math.max(t0 + fade, t0 + playSec - fade));
      env.gain.linearRampToValueAtTime(0, t0 + playSec);
      node.connect(env);
      env.connect(dest);
      node.start(t0, offset, srcSec);
      node.stop(t0 + playSec + 0.01);
      keep?.push({ node, end: t0 + playSec + 0.02 });
    }

    if (metronome) {
      const firstBeat = Math.ceil(fromBeat - 1e-6);
      for (let b = firstBeat; b < toBeat; b++) {
        const t = when + (b - fromBeat) * secPerBeat;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        const accent = b % this.project.beatsPerBar === 0;
        osc.frequency.value = accent ? 1568 : 1046;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(accent ? 0.35 : 0.2, t + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.06);
        keep?.push({ node: osc, end: t + 0.07 });
      }
    }
  }

  // ---- Auditioning a source from the library ------------------------------
  auditionSource(id: string | null) {
    if (this.audition) {
      try {
        this.audition.stop();
      } catch {
        /* ended */
      }
      this.audition.disconnect();
      this.audition = null;
    }
    const src = id ? this.sources.get(id) : null;
    if (!src) return;
    void this.ctx.resume();
    const node = this.ctx.createBufferSource();
    node.buffer = src.buffer;
    node.connect(this.master);
    node.start();
    node.onended = () => {
      if (this.audition === node) {
        this.audition = null;
        this.emit();
      }
    };
    this.audition = node;
    this.auditionId = id;
    this.emit();
  }
  auditionId: string | null = null;
  get auditioning(): string | null {
    return this.audition ? this.auditionId : null;
  }

  // ---- Export ------------------------------------------------------------
  async renderWav(): Promise<Blob> {
    const end = this.contentEnd();
    if (end <= 0) throw new Error("empty");
    const bpm = this.project.bpm;
    const seconds = (end * 60) / bpm + 0.5;
    const rate = this.ctx.sampleRate;
    const off = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate);
    const master = off.createGain();
    master.gain.value = 0.9;
    master.connect(off.destination);
    const nodes = new Map<string, GainNode>();
    for (const t of this.project.tracks) {
      const g = off.createGain();
      g.gain.value = this.effectiveGain(t);
      const p = off.createStereoPanner();
      p.pan.value = t.pan;
      g.connect(p);
      p.connect(master);
      nodes.set(t.id, g);
    }
    this.scheduleSpan(off, (id) => nodes.get(id) ?? null, 0, end, 0, false, null);
    const rendered = await off.startRendering();
    return encodeWav(rendered);
  }

  dispose() {
    window.clearTimeout(this.restartTimer);
    this.stopSources();
    this.playing = false;
    this.auditionSource(null);
    this.listeners.clear();
    void this.ctx.close();
  }
}

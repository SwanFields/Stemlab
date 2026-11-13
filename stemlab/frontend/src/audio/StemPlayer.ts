/**
 * Multi-track player built on the Web Audio API.
 *
 * Every stem is decoded into an AudioBuffer and played by its own
 * AudioBufferSourceNode. All sources are started with the *same* `when` value on
 * the *same* AudioContext clock, so they begin on the same audio sample and
 * cannot drift apart (unlike several <audio> elements, which each have their own
 * clock). Seeking and resuming create fresh sources and schedule them the same way.
 */
export interface StemSource {
  name: string;
  url: string;
}

export interface Track {
  readonly name: string;
  readonly buffer: AudioBuffer;
  readonly gain: GainNode;
  readonly panner: StereoPannerNode;
  readonly analyser: AnalyserNode;
  readonly level: Float32Array<ArrayBuffer>;
  /** Reused buffer for getFrequencyData(). */
  readonly spectrum: Uint8Array<ArrayBuffer>;
  /** Normalised 0..1 amplitude envelope used to draw the waveform. */
  readonly peaks: Float32Array;
  volume: number;
  /** Stereo position, -1 (left) .. 1 (right). */
  pan: number;
  muted: boolean;
  solo: boolean;
  source: AudioBufferSourceNode | null;
}

export type ListenMode = "mix" | "original";

export interface RenderedMix {
  blob: Blob;
  /** True when the mix was louder than full scale and had to be scaled down to avoid clipping. */
  normalized: boolean;
}

export const MAX_VOLUME = 1.5;
const FADE = 0.012; // time constant (s) of every level / pan / A-B change, short enough to feel instant, long enough to avoid clicks
const PEAK_BUCKETS = 900;
const START_LEAD = 0.06; // seconds of scheduling headroom before the first sample plays

function computePeaks(buffer: AudioBuffer, buckets: number): Float32Array {
  const peaks = new Float32Array(buckets);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const size = Math.max(1, Math.floor(buffer.length / buckets));
  const stride = Math.max(1, Math.floor(size / 256)); // sampling is enough for a drawing
  let overall = 0;
  for (let b = 0; b < buckets; b++) {
    const start = b * size;
    const end = Math.min(buffer.length, start + size);
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

function encodeWav(buffer: AudioBuffer, scale: number): Blob {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytesPerFrame = channels * 2;
  const data = new DataView(new ArrayBuffer(44 + frames * bytesPerFrame));
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) data.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  data.setUint32(4, 36 + frames * bytesPerFrame, true);
  text(8, "WAVE");
  text(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true); // PCM
  data.setUint16(22, channels, true);
  data.setUint32(24, buffer.sampleRate, true);
  data.setUint32(28, buffer.sampleRate * bytesPerFrame, true);
  data.setUint16(32, bytesPerFrame, true);
  data.setUint16(34, 16, true);
  text(36, "data");
  data.setUint32(40, frames * bytesPerFrame, true);

  const sources = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, sources[c][i] * scale));
      data.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([data], { type: "audio/wav" });
}

export class StemPlayer {
  readonly tracks: Track[] = [];
  duration = 0;
  /** True when the unseparated original was loaded and A/B comparison is possible. */
  hasOriginal = false;
  mode: ListenMode = "mix";

  private ctx = new AudioContext();
  private stemBus = this.ctx.createGain(); // every stem -> here -> speakers ("B": the mix)
  private originalGain = this.ctx.createGain(); // the untouched song ("A")
  private originalBuffer: AudioBuffer | null = null;
  private originalSource: AudioBufferSourceNode | null = null;
  private startedAt = 0; // ctx time at which the song position would have been 0
  private pausedAt = 0; // song position while not playing
  private playing = false;
  private version = 0;
  private listeners = new Set<() => void>();

  /* ---- React bridge (useSyncExternalStore) ---- */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getVersion = (): number => this.version;
  private emit(): void {
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  /* ---- loading ---- */
  async load(
    sources: StemSource[],
    onProgress?: (done: number, total: number) => void,
    originalUrl?: string,
  ): Promise<void> {
    this.stemBus.connect(this.ctx.destination);
    this.originalGain.connect(this.ctx.destination);
    this.originalGain.gain.value = 0;

    // The original is optional: if it cannot be fetched the mixer still works, just without A/B.
    const originalPromise = originalUrl
      ? fetch(originalUrl, { credentials: "include" })
          .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(String(res.status)))))
          .then((data) => this.ctx.decodeAudioData(data))
          .catch(() => null)
      : Promise.resolve(null);

    let done = 0;
    const loaded = await Promise.all(
      sources.map(async (src) => {
        const res = await fetch(src.url, { credentials: "include" });
        if (!res.ok) throw new Error(`โหลดแทร็ก ${src.name} ไม่สำเร็จ (${res.status})`);
        const buffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
        onProgress?.(++done, sources.length);
        return { src, buffer };
      }),
    );

    this.originalBuffer = await originalPromise;
    this.hasOriginal = this.originalBuffer !== null;

    for (const { src, buffer } of loaded) {
      const gain = this.ctx.createGain();
      const panner = this.ctx.createStereoPanner();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = src.name === "drums" ? 0.05 : 0.55;
      gain.connect(panner);
      panner.connect(analyser);
      analyser.connect(this.stemBus);
      this.tracks.push({
        name: src.name,
        buffer,
        gain,
        panner,
        analyser,
        level: new Float32Array(analyser.fftSize),
        spectrum: new Uint8Array(analyser.frequencyBinCount),
        peaks: computePeaks(buffer, PEAK_BUCKETS),
        volume: 1,
        pan: 0,
        muted: false,
        solo: false,
        source: null,
      });
    }
    this.duration = Math.max(0, ...this.tracks.map((t) => t.buffer.duration));
    if (this.originalBuffer) this.duration = Math.max(this.duration, this.originalBuffer.duration);
    this.applyGains();
    this.emit();
  }

  /* ---- transport ---- */
  get isPlaying(): boolean {
    return this.playing;
  }

  get position(): number {
    if (!this.playing) return this.pausedAt;
    return Math.min(Math.max(this.ctx.currentTime - this.startedAt, 0), this.duration);
  }

  async play(): Promise<void> {
    if (this.playing || this.tracks.length === 0) return;
    await this.ctx.resume(); // browsers keep the context suspended until a user gesture
    if (this.playing) return; // a second click arrived while resuming
    if (this.pausedAt >= this.duration - 0.01) this.pausedAt = 0;
    this.startSources(this.pausedAt);
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedAt = this.position;
    this.haltSources();
    this.playing = false;
    this.emit();
  }

  stop(): void {
    this.haltSources();
    this.playing = false;
    this.pausedAt = 0;
    this.emit();
  }

  seek(seconds: number): void {
    const target = Math.min(Math.max(seconds, 0), Math.max(0, this.duration - 0.01));
    const wasPlaying = this.playing;
    if (wasPlaying) this.haltSources();
    this.pausedAt = target;
    if (wasPlaying) this.startSources(target);
    this.emit();
  }

  /* ---- mixer ---- */
  setVolume(name: string, volume: number): void {
    const track = this.tracks.find((t) => t.name === name);
    if (!track) return;
    track.volume = Math.min(Math.max(volume, 0), MAX_VOLUME);
    this.applyGains();
    this.emit();
  }

  setPan(name: string, pan: number): void {
    const track = this.tracks.find((t) => t.name === name);
    if (!track) return;
    track.pan = Math.min(Math.max(pan, -1), 1);
    track.panner.pan.setTargetAtTime(track.pan, this.ctx.currentTime, FADE);
    this.emit();
  }

  /** A/B: "original" = the song as uploaded, "mix" = the stems with the faders / mute / solo / pan below. */
  setMode(mode: ListenMode): void {
    if (mode === this.mode || (mode === "original" && !this.hasOriginal)) return;
    this.mode = mode;
    this.applyMode();
    this.emit();
  }

  toggleMode(): void {
    this.setMode(this.mode === "mix" ? "original" : "mix");
  }

  /** Frequency magnitudes (0..255, low -> high) of one track *after* its fader, mute and pan. */
  getFrequencyData(name: string): Uint8Array<ArrayBuffer> | null {
    const track = this.tracks.find((t) => t.name === name);
    if (!track) return null;
    track.analyser.getByteFrequencyData(track.spectrum);
    return track.spectrum;
  }

  /** Latest raw samples (-1..1) of one track after its fader / mute / pan, for oscilloscope-style drawing. */
  getWaveform(name: string): Float32Array<ArrayBuffer> | null {
    const track = this.tracks.find((t) => t.name === name);
    if (!track) return null;
    track.analyser.getFloatTimeDomainData(track.level);
    return track.level;
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  /**
   * Bounce the current mix (faders, mute, solo, pan) to a 16-bit stereo WAV, faster than real time.
   * Uses the same gain / pan maths as live playback so the file sounds like what you hear.
   */
  async renderMix(): Promise<RenderedMix> {
    const live = this.tracks.filter((t) => this.isAudible(t) && t.volume > 0);
    if (live.length === 0) throw new Error("NO_AUDIBLE_TRACKS");
    const sampleRate = this.ctx.sampleRate;
    const length = Math.max(1, Math.ceil(Math.max(...live.map((t) => t.buffer.duration)) * sampleRate));
    const offline = new OfflineAudioContext(2, length, sampleRate);
    for (const t of live) {
      const src = offline.createBufferSource();
      src.buffer = t.buffer;
      const gain = offline.createGain();
      gain.gain.value = t.volume;
      const panner = offline.createStereoPanner();
      panner.pan.value = t.pan;
      src.connect(gain);
      gain.connect(panner);
      panner.connect(offline.destination);
      src.start(0);
    }
    const rendered = await offline.startRendering();

    let peak = 0;
    for (let c = 0; c < rendered.numberOfChannels; c++) {
      const data = rendered.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
      }
    }
    const normalized = peak > 0.999;
    return { blob: encodeWav(rendered, normalized ? 0.999 / peak : 1), normalized };
  }

  toggleMute(name: string): void {
    const track = this.tracks.find((t) => t.name === name);
    if (!track) return;
    track.muted = !track.muted;
    this.applyGains();
    this.emit();
  }

  toggleSolo(name: string): void {
    const track = this.tracks.find((t) => t.name === name);
    if (!track) return;
    track.solo = !track.solo;
    this.applyGains();
    this.emit();
  }

  /** Whether a track currently reaches the speakers (mute wins; solo silences the others). */
  isAudible(track: Track): boolean {
    const anySolo = this.tracks.some((t) => t.solo);
    return !track.muted && (!anySolo || track.solo);
  }

  /** Current loudness of a track, 0..1, for the level meter. */
  getLevel(name: string): number {
    const track = this.tracks.find((t) => t.name === name);
    if (!track || !this.playing) return 0;
    track.analyser.getFloatTimeDomainData(track.level);
    let sum = 0;
    for (let i = 0; i < track.level.length; i++) sum += track.level[i] * track.level[i];
    return Math.min(1, Math.sqrt(sum / track.level.length) * 3);
  }

  dispose(): void {
    this.haltSources();
    this.playing = false;
    this.listeners.clear();
    this.ctx.close().catch(() => {});
  }

  /* ---- internals ---- */
  private applyGains(): void {
    const now = this.ctx.currentTime;
    for (const t of this.tracks) {
      // a short time constant avoids clicks when a fader or button changes the level
      t.gain.gain.setTargetAtTime(this.isAudible(t) ? t.volume : 0, now, 0.015);
    }
  }

  private applyMode(): void {
    const now = this.ctx.currentTime;
    const original = this.mode === "original";
    this.stemBus.gain.setTargetAtTime(original ? 0 : 1, now, FADE);
    this.originalGain.gain.setTargetAtTime(original ? 1 : 0, now, FADE);
  }

  private startSources(offset: number): void {
    const when = this.ctx.currentTime + START_LEAD;
    if (this.originalBuffer) {
      // runs silently in lock-step with the stems, so switching A/B never changes the position
      const src = this.ctx.createBufferSource();
      src.buffer = this.originalBuffer;
      src.connect(this.originalGain);
      src.start(when, Math.min(offset, this.originalBuffer.duration));
      this.originalSource = src;
    }
    this.tracks.forEach((track, index) => {
      const src = this.ctx.createBufferSource();
      src.buffer = track.buffer;
      src.connect(track.gain);
      src.start(when, offset); // identical `when` for every stem = sample-accurate sync
      track.source = src;
      if (index === 0) {
        src.onended = () => {
          if (track.source === src) this.finish();
        };
      }
    });
    this.startedAt = when - offset;
    this.playing = true;
  }

  private haltSources(): void {
    if (this.originalSource) {
      try {
        this.originalSource.stop();
      } catch {
        /* already stopped */
      }
      this.originalSource.disconnect();
      this.originalSource = null;
    }
    for (const track of this.tracks) {
      const src = track.source;
      if (!src) continue;
      src.onended = null; // otherwise a manual stop would look like "reached the end"
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      src.disconnect();
      track.source = null;
    }
  }

  private finish(): void {
    this.haltSources();
    this.playing = false;
    this.pausedAt = 0;
    this.emit();
  }
}

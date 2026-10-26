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
  readonly analyser: AnalyserNode;
  readonly level: Float32Array<ArrayBuffer>;
  /** Normalised 0..1 amplitude envelope used to draw the waveform. */
  readonly peaks: Float32Array;
  volume: number;
  muted: boolean;
  solo: boolean;
  source: AudioBufferSourceNode | null;
}

export const MAX_VOLUME = 1.5;
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

export class StemPlayer {
  readonly tracks: Track[] = [];
  duration = 0;

  private ctx = new AudioContext();
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
  async load(sources: StemSource[], onProgress?: (done: number, total: number) => void): Promise<void> {
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

    for (const { src, buffer } of loaded) {
      const gain = this.ctx.createGain();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      gain.connect(analyser);
      analyser.connect(this.ctx.destination);
      this.tracks.push({
        name: src.name,
        buffer,
        gain,
        analyser,
        level: new Float32Array(analyser.fftSize),
        peaks: computePeaks(buffer, PEAK_BUCKETS),
        volume: 1,
        muted: false,
        solo: false,
        source: null,
      });
    }
    this.duration = Math.max(0, ...this.tracks.map((t) => t.buffer.duration));
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

  private startSources(offset: number): void {
    const when = this.ctx.currentTime + START_LEAD;
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

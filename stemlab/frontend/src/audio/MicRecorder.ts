/**
 * Microphone capture for the DAW.
 *
 * Raw PCM is captured inside the DAW's own AudioContext (AudioWorklet, with a ScriptProcessor
 * fallback), so every sample has an exact position on the same clock the transport uses. That is
 * what lets a take line up with the music instead of drifting like a MediaRecorder blob would.
 * Echo cancellation, noise suppression and auto-gain are switched off: they are made for calls
 * and would pump and gate a singing voice.
 */

export interface MicTake {
  /** Mono recording at the context sample rate. */
  buffer: AudioBuffer;
  /** AudioContext time (seconds) of the first captured sample. */
  startTime: number;
}

export type MicError = "MIC_UNSUPPORTED" | "MIC_DENIED" | "MIC_MISSING" | "MIC_BUSY" | "MIC_ERROR";

const WORKLET_SOURCE = `
class StemlabCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.first = -1;
    this.port.onmessage = (e) => {
      if (e.data === "start") { this.on = true; this.n = 0; this.first = -1; }
      else if (e.data === "stop") {
        if (this.n > 0) this.port.postMessage({ chunk: this.buf.slice(0, this.n), frame: this.first });
        this.n = 0;
        this.on = false;
        this.port.postMessage({ done: true });
      }
    };
  }
  process(inputs) {
    if (!this.on) return true;
    const input = inputs[0];
    const frames = 128;
    if (this.first < 0) this.first = currentFrame;
    for (let i = 0; i < frames; i++) {
      let v = 0;
      if (input && input.length > 0) {
        for (let c = 0; c < input.length; c++) v += input[c][i] || 0;
        v /= input.length;
      }
      this.buf[this.n++] = v;
      if (this.n === this.buf.length) {
        this.port.postMessage({ chunk: this.buf.slice(0), frame: this.first });
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("stemlab-capture", StemlabCapture);
`;

const loaded = new WeakSet<BaseAudioContext>();

async function ensureWorklet(ctx: AudioContext): Promise<boolean> {
  if (!ctx.audioWorklet) return false;
  if (loaded.has(ctx)) return true;
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
    loaded.add(ctx);
    return true;
  } catch {
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class MicRecorder {
  private chunks: Float32Array[] = [];
  private firstFrame = -1;
  private capturing = false;
  private meter = new Float32Array(1024);
  private waiting: (() => void) | null = null;

  private constructor(
    private ctx: AudioContext,
    private stream: MediaStream,
    private source: MediaStreamAudioSourceNode,
    private analyser: AnalyserNode,
    private sink: GainNode,
    private worklet: AudioWorkletNode | null,
    private processor: ScriptProcessorNode | null,
  ) {}

  static async open(ctx: AudioContext, monitorTo: AudioNode | null): Promise<MicRecorder> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("MIC_UNSUPPORTED" satisfies MicError);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: ctx.sampleRate,
        },
      });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      const code: MicError =
        name === "NotAllowedError" || name === "SecurityError"
          ? "MIC_DENIED"
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "MIC_MISSING"
            : name === "NotReadableError" || name === "AbortError"
              ? "MIC_BUSY"
              : "MIC_ERROR";
      throw new Error(code);
    }

    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      // Capture nodes only run while something downstream pulls them, so they end in a muted sink.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      sink.connect(ctx.destination);
      if (monitorTo) source.connect(monitorTo);

      let worklet: AudioWorkletNode | null = null;
      let processor: ScriptProcessorNode | null = null;
      if (await ensureWorklet(ctx)) {
        worklet = new AudioWorkletNode(ctx, "stemlab-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        source.connect(worklet);
        worklet.connect(sink);
      } else {
        processor = ctx.createScriptProcessor(2048, 1, 1);
        source.connect(processor);
        processor.connect(sink);
      }
      const rec = new MicRecorder(ctx, stream, source, analyser, sink, worklet, processor);
      rec.attach();
      return rec;
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      throw e;
    }
  }

  private attach() {
    if (this.worklet) {
      this.worklet.port.onmessage = (e: MessageEvent<{ chunk?: Float32Array; frame?: number; done?: boolean }>) => {
        if (e.data.chunk) {
          if (this.firstFrame < 0 && typeof e.data.frame === "number") this.firstFrame = e.data.frame;
          this.chunks.push(e.data.chunk);
        }
        if (e.data.done) this.waiting?.();
      };
    } else if (this.processor) {
      this.processor.onaudioprocess = (e) => {
        if (!this.capturing) return;
        if (this.firstFrame < 0) this.firstFrame = Math.round(e.playbackTime * this.ctx.sampleRate);
        this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
    }
  }

  /** Begin keeping samples. */
  start() {
    this.chunks = [];
    this.firstFrame = -1;
    this.capturing = true;
    this.worklet?.port.postMessage("start");
  }

  /** Current input peak, 0..1, for the meter. */
  level(): number {
    this.analyser.getFloatTimeDomainData(this.meter);
    let peak = 0;
    for (let i = 0; i < this.meter.length; i++) peak = Math.max(peak, Math.abs(this.meter[i]));
    return Math.min(1, peak);
  }

  /** Stops, releases the microphone and returns the take (null if nothing was captured). */
  async stop(): Promise<MicTake | null> {
    this.capturing = false;
    if (this.worklet) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 600); // never hang if the worklet is gone
        this.waiting = () => {
          window.clearTimeout(timer);
          resolve();
        };
        this.worklet?.port.postMessage("stop");
      });
    }
    this.release();

    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    if (total === 0 || this.firstFrame < 0) return null;
    const buffer = this.ctx.createBuffer(1, total, this.ctx.sampleRate);
    const out = buffer.getChannelData(0);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    this.chunks = [];
    return { buffer, startTime: this.firstFrame / this.ctx.sampleRate };
  }

  /** Throws the take away. */
  cancel() {
    this.capturing = false;
    this.chunks = [];
    this.release();
  }

  private release() {
    if (this.worklet) this.worklet.port.onmessage = null;
    if (this.processor) this.processor.onaudioprocess = null;
    for (const node of [this.source, this.analyser, this.worklet, this.processor, this.sink]) {
      try {
        node?.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.stream.getTracks().forEach((t) => t.stop());
  }
}

import { clipBeats, uid, type DawClip, type DawSource, type Project } from "../../audio/DawEngine";

export const LANE_H = 92;
export const HEADER_W = 208;
export const MIN_CLIP_SEC = 0.02;
export const MAX_SLICES = 128;

export const STEM_COLORS: Record<string, string> = {
  vocals: "#e08fa3",
  drums: "#e0a15f",
  bass: "#6fa8dc",
  other: "#a98fd9",
};
export const FILE_COLORS = ["#7fc4a4", "#d9c36a", "#d98f6f", "#6fc0c9", "#c58fd1", "#9ab86a"];

export interface SnapOption {
  key: string;
  /** Beats, or 0 for "off", or -1 for "one bar". */
  beats: number;
  th: string;
  en: string;
}

export const SNAP_OPTIONS: SnapOption[] = [
  { key: "bar", beats: -1, th: "1 ห้อง", en: "1 bar" },
  { key: "2", beats: 2, th: "2 จังหวะ", en: "2 beats" },
  { key: "1", beats: 1, th: "1 จังหวะ", en: "1 beat" },
  { key: "1/2", beats: 0.5, th: "1/2 จังหวะ", en: "1/2 beat" },
  { key: "1/4", beats: 0.25, th: "1/4 จังหวะ (16th)", en: "1/4 beat (16th)" },
  { key: "1/8", beats: 0.125, th: "1/8 จังหวะ (32nd)", en: "1/8 beat (32nd)" },
  { key: "off", beats: 0, th: "ไม่สแนป", en: "Off" },
];

export function snapSize(key: string, beatsPerBar: number): number {
  const opt = SNAP_OPTIONS.find((o) => o.key === key) ?? SNAP_OPTIONS[2];
  return opt.beats < 0 ? beatsPerBar : opt.beats;
}

export function snapTo(beat: number, size: number): number {
  return size > 0 ? Math.round(beat / size) * size : beat;
}

/** "012.3.2" = bar 12, beat 3, sixteenth 2 (all 1-based). */
export function formatBars(beat: number, beatsPerBar: number): string {
  const b = Math.max(0, beat);
  const bar = Math.floor(b / beatsPerBar) + 1;
  const inBar = b % beatsPerBar;
  const beatNo = Math.floor(inBar) + 1;
  const sixteenth = Math.floor((inBar % 1) * 4 + 1e-6) + 1;
  return `${String(bar).padStart(3, "0")}.${beatNo}.${sixteenth}`;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Source seconds that pass per timeline beat for this clip. */
export function secPerBeat(clip: DawClip, src: DawSource, projectBpm: number): number {
  return 60 / (clip.warp ? src.bpm : projectBpm);
}

export function clipEnd(clip: DawClip, src: DawSource, projectBpm: number): number {
  return clip.start + clipBeats(clip, src, projectBpm);
}

type Sources = Map<string, DawSource>;

/** Splits one clip at `beat`. Returns [clip] unchanged when the cut is at or past an edge. */
export function splitClip(clip: DawClip, beat: number, sources: Sources, bpm: number): DawClip[] {
  const src = sources.get(clip.sourceId);
  if (!src) return [clip];
  const end = clipEnd(clip, src, bpm);
  const eps = 0.001;
  if (beat <= clip.start + eps || beat >= end - eps) return [clip];
  const spb = secPerBeat(clip, src, bpm);
  const cut = (beat - clip.start) * spb;
  if (cut < MIN_CLIP_SEC || clip.dur - cut < MIN_CLIP_SEC) return [clip];
  return [
    { ...clip, dur: cut },
    { ...clip, id: uid("c"), start: beat, offset: clip.offset + cut, dur: clip.dur - cut },
  ];
}

export function splitClipsAt(
  project: Project,
  sources: Sources,
  ids: Set<string> | null,
  beat: number,
): { clips: DawClip[]; created: string[]; changed: boolean } {
  const out: DawClip[] = [];
  const created: string[] = [];
  let changed = false;
  for (const clip of project.clips) {
    const eligible = ids ? ids.has(clip.id) : true;
    const parts = eligible ? splitClip(clip, beat, sources, project.bpm) : [clip];
    if (parts.length > 1) {
      changed = true;
      created.push(parts[1].id);
    }
    out.push(...parts);
  }
  return { clips: out, created, changed };
}

/** Cuts a clip at every multiple of `step` beats. */
export function sliceClip(clip: DawClip, step: number, sources: Sources, bpm: number): DawClip[] {
  const src = sources.get(clip.sourceId);
  if (!src || step <= 0) return [clip];
  const end = clipEnd(clip, src, bpm);
  const points: number[] = [];
  for (let p = (Math.floor(clip.start / step + 1e-6) + 1) * step; p < end - 0.001; p += step) {
    if (p > clip.start + 0.001) points.push(p);
    if (points.length >= MAX_SLICES) break;
  }
  let pieces: DawClip[] = [clip];
  for (const p of points) {
    const last = pieces[pieces.length - 1];
    const parts = splitClip(last, p, sources, bpm);
    pieces = [...pieces.slice(0, -1), ...parts];
  }
  return pieces;
}

/** Copies `clips` so the group repeats `times` times right after itself. */
export function repeatClips(clips: DawClip[], sources: Sources, bpm: number, times: number): DawClip[] {
  let min = Infinity;
  let max = 0;
  for (const c of clips) {
    const src = sources.get(c.sourceId);
    if (!src) continue;
    min = Math.min(min, c.start);
    max = Math.max(max, clipEnd(c, src, bpm));
  }
  if (!isFinite(min)) return [];
  const span = max - min;
  const out: DawClip[] = [];
  for (let n = 1; n <= times; n++) {
    for (const c of clips) out.push({ ...c, id: uid("c"), start: c.start + span * n });
  }
  return out;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);
}

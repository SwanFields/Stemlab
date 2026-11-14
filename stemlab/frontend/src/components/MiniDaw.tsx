import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { getStatus, type HistoryItem } from "../api";
import {
  DawEngine,
  MAX_BPM,
  MIN_BPM,
  clamp,
  clipBeats,
  computePeaks,
  detectBpm,
  emptyProject,
  uid,
  type DawClip,
  type DawSource,
  type DawTrack,
  type Project,
} from "../audio/DawEngine";
import { useFrame } from "../hooks";
import { defaultFx, fxActive } from "../audio/FxChain";
import ClipView from "./daw/ClipView";
import FxPanel from "./daw/FxPanel";
import Library from "./daw/Library";
import {
  FILE_COLORS,
  HEADER_W,
  LANE_H,
  MIN_CLIP_SEC,
  SNAP_OPTIONS,
  STEM_COLORS,
  clipEnd,
  formatBars,
  formatClock,
  isTypingTarget,
  repeatClips,
  secPerBeat,
  sliceClip,
  snapSize,
  snapTo,
  splitClipsAt,
} from "./daw/dawUtils";
import { useLanguage } from "./Language";

type Tool = "select" | "chop";

interface DragState {
  kind: "move" | "trimL" | "trimR";
  primary: string;
  ids: string[];
  copy: boolean;
  preview: Map<string, DawClip>;
  moved: boolean;
}

interface Ghost {
  track: number;
  beat: number;
  beats: number;
  color: string;
}

const MIN_PPB = 8;
const MAX_PPB = 360;
const ppbFromSlider = (v: number) => MIN_PPB * Math.pow(MAX_PPB / MIN_PPB, v);
const sliderFromPpb = (ppb: number) => Math.log(ppb / MIN_PPB) / Math.log(MAX_PPB / MIN_PPB);

export default function MiniDaw({ initialJobId }: { initialJobId: string | null }) {
  const { t } = useLanguage();
  const [engine, setEngine] = useState<DawEngine | null>(null);
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    let e: DawEngine;
    try {
      e = new DawEngine();
    } catch {
      setUnsupported(true);
      return;
    }
    setEngine(e);
    return () => {
      e.dispose();
      setEngine(null);
    };
  }, []);

  if (unsupported) {
    return <p className="daw-fatal" role="alert">{t("เบราว์เซอร์นี้ไม่รองรับ Web Audio จึงเปิด Mini DAW ไม่ได้", "This browser does not support Web Audio, so the Mini DAW is unavailable.")}</p>;
  }
  if (!engine) return null;
  return <Daw engine={engine} initialJobId={initialJobId} />;
}

function Daw({ engine, initialJobId }: { engine: DawEngine; initialJobId: string | null }) {
  const { t, language } = useLanguage();
  useSyncExternalStore(engine.subscribe, engine.getVersion);
  const project = engine.project;
  const bpb = project.beatsPerBar;

  // ---- view state --------------------------------------------------------
  const [ppb, setPpb] = useState(44);
  const [snapKey, setSnapKey] = useState("1");
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeTrack, setActiveTrack] = useState(0);
  const [follow, setFollow] = useState(true);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [chopGuide, setChopGuide] = useState<{ track: number; beat: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [fxTrackId, setFxTrackId] = useState<string | null>(null);

  const snap = snapSize(snapKey, bpb);

  // ---- refs --------------------------------------------------------------
  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const rulerHeadRef = useRef<HTMLDivElement>(null);
  const barsRef = useRef<HTMLSpanElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const meterRefs = useRef(new Map<string, HTMLSpanElement>());
  const draggingRef = useRef(false);
  const dragSourceRef = useRef<string | null>(null);
  const ppbRef = useRef(ppb);
  ppbRef.current = ppb;
  const zoomAnchor = useRef<{ beat: number; screenX: number } | null>(null);
  const colorIndex = useRef(0);
  const stemKeys = useRef(new Map<string, string>()); // "jobId:stem" -> source id

  const sourceList = useMemo(() => Array.from(engine.sources.values()), [engine, engine.getVersion()]); // eslint-disable-line react-hooks/exhaustive-deps
  const usedIds = useMemo(() => new Set(project.clips.map((c) => c.sourceId)), [project.clips]);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 4500);
  }, []);

  // ---- derived geometry --------------------------------------------------
  const contentEnd = engine.contentEnd();
  const totalBars = Math.max(16, Math.ceil(contentEnd / bpb) + 6);
  const totalBeats = totalBars * bpb;
  const laneWidth = totalBeats * ppb;

  const clipBeatLen = useCallback(
    (clip: DawClip) => {
      const src = engine.sources.get(clip.sourceId);
      return src ? clipBeats(clip, src, project.bpm) : 0;
    },
    [engine, project.bpm],
  );

  // ---- zoom anchoring ------------------------------------------------------
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    const el = scrollRef.current;
    if (!a || !el) return;
    el.scrollLeft = Math.max(0, HEADER_W + a.beat * ppb - a.screenX);
    zoomAnchor.current = null;
  }, [ppb]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const current = ppbRef.current;
      const beat = (el.scrollLeft + screenX - HEADER_W) / current;
      const next = clamp(current * Math.exp(-e.deltaY * 0.0022), MIN_PPB, MAX_PPB);
      zoomAnchor.current = { beat, screenX };
      setPpb(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (factor: number) => {
    const el = scrollRef.current;
    if (el) {
      const screenX = HEADER_W + (el.clientWidth - HEADER_W) / 2;
      zoomAnchor.current = { beat: (el.scrollLeft + screenX - HEADER_W) / ppb, screenX };
    }
    setPpb((p) => clamp(p * factor, MIN_PPB, MAX_PPB));
  };

  // ---- per-frame UI (playhead, readouts, meters, follow) --------------------
  useFrame(() => {
    const beat = engine.getBeat();
    const x = beat * ppbRef.current;
    if (playheadRef.current) playheadRef.current.style.transform = `translateX(${HEADER_W + x}px)`;
    if (rulerHeadRef.current) rulerHeadRef.current.style.transform = `translateX(${x}px)`;
    if (barsRef.current) barsRef.current.textContent = formatBars(beat, engine.project.beatsPerBar);
    if (clockRef.current) clockRef.current.textContent = formatClock((beat * 60) / engine.project.bpm);
    for (const [id, el] of meterRefs.current) el.style.transform = `scaleX(${engine.trackLevel(id)})`;
    const scroller = scrollRef.current;
    if (follow && engine.playing && scroller && !draggingRef.current) {
      const screen = HEADER_W + x - scroller.scrollLeft;
      if (screen > scroller.clientWidth - 48 || screen < HEADER_W) {
        scroller.scrollLeft = Math.max(0, x - 24);
      }
    }
  });

  // ---- project helpers -----------------------------------------------------
  const update = useCallback(
    (fn: (p: Project) => Project, record = true) => engine.commit(fn(engine.project), record),
    [engine],
  );

  const pointerBeat = useCallback(
    (clientX: number, el: HTMLElement | null, offsetX = 0) => {
      const rect = el?.getBoundingClientRect();
      if (!rect) return 0;
      return Math.max(0, (clientX - rect.left - offsetX) / ppbRef.current);
    },
    [],
  );

  const trackFromY = useCallback((clientY: number) => {
    const rect = lanesRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.floor((clientY - rect.top) / LANE_H);
  }, []);

  // ---- loading audio ---------------------------------------------------------
  const registerSource = useCallback(
    (name: string, buffer: AudioBuffer, origin: "stem" | "file", color?: string, bpm?: number): DawSource => {
      const src: DawSource = {
        id: uid("s"),
        name,
        buffer,
        peaks: computePeaks(buffer),
        color: color ?? FILE_COLORS[colorIndex.current++ % FILE_COLORS.length],
        bpm: bpm ?? detectBpm(buffer),
        origin,
      };
      engine.addSource(src);
      return src;
    },
    [engine],
  );

  const makeClip = (src: DawSource, track: string, start: number): DawClip => ({
    id: uid("c"),
    sourceId: src.id,
    track,
    start,
    offset: 0,
    dur: src.buffer.duration,
    warp: true,
    gain: 1,
  });

  /** Adds clips for the given placements; the very first clip also sets the project tempo. */
  const placeClips = useCallback(
    (placements: { src: DawSource; track: number; start: number }[]) => {
      if (placements.length === 0) return;
      const ids: string[] = [];
      update((p) => {
        let tracks = p.tracks;
        const needed = Math.max(...placements.map((x) => x.track)) + 1;
        if (needed > tracks.length) {
          tracks = [...tracks, ...Array.from({ length: needed - tracks.length }, (_, i) => newTrack(tracks.length + i))];
        }
        const clips = [...p.clips];
        for (const { src, track, start } of placements) {
          const clip = makeClip(src, tracks[track].id, start);
          ids.push(clip.id);
          clips.push(clip);
        }
        const adopt = p.clips.length === 0;
        return { ...p, tracks, clips, bpm: adopt ? Math.round(clamp(placements[0].src.bpm, MIN_BPM, MAX_BPM)) : p.bpm };
      });
      setSelected(new Set(ids));
    },
    [update], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const decodeFile = useCallback(
    async (file: File) => {
      const data = await file.arrayBuffer();
      const buffer = await engine.ctx.decodeAudioData(data);
      return registerSource(file.name.replace(/\.[^.]+$/, ""), buffer, "file");
    },
    [engine, registerSource],
  );

  const addFiles = useCallback(
    async (files: File[], at?: { track: number; beat: number }) => {
      const loaded: DawSource[] = [];
      for (const file of files) {
        setBusy(t(`กำลังอ่าน ${file.name}...`, `Reading ${file.name}...`));
        try {
          loaded.push(await decodeFile(file));
        } catch {
          flash(t(`อ่านไฟล์ ${file.name} ไม่ได้`, `Could not read ${file.name}.`));
        }
      }
      setBusy(null);
      if (at && loaded.length) {
        placeClips(loaded.map((src, i) => ({ src, track: at.track + i, start: at.beat })));
      } else if (loaded.length) {
        flash(t("เพิ่มลงคลังแล้ว ลากไปวางบน timeline ได้เลย", "Added to the library. Drag it onto the timeline."));
      }
    },
    [decodeFile, flash, placeClips, t],
  );

  const stemLabel = useCallback(
    (name: string) =>
      ({
        vocals: t("เสียงร้อง", "Vocals"),
        drums: t("กลอง", "Drums"),
        bass: t("เบส", "Bass"),
        other: t("เสียงอื่น ๆ", "Other"),
      })[name] ?? name,
    [t],
  );

  const loadJob = useCallback(
    async (jobId: string, filename: string, place: boolean) => {
      setBusy(t("กำลังโหลดสเตม...", "Loading stems..."));
      try {
        const job = await getStatus(jobId);
        if (job.status !== "done" || job.stems.length === 0) throw new Error(t("งานนี้ยังไม่พร้อม หรือไฟล์หมดอายุแล้ว", "This job is not ready or its files have expired."));
        const base = (filename || job.filename).replace(/\.[^.]+$/, "");
        const fresh: { name: string; buffer: AudioBuffer }[] = [];
        const existing: DawSource[] = [];
        let done = 0;
        await Promise.all(
          job.stems.map(async (stem) => {
            const key = `${jobId}:${stem.name}`;
            const known = stemKeys.current.get(key);
            if (known && engine.sources.has(known)) {
              existing.push(engine.sources.get(known)!);
              return;
            }
            const res = await fetch(stem.url, { credentials: "include" });
            if (!res.ok) throw new Error(t(`โหลดแทร็ก ${stem.name} ไม่สำเร็จ (${res.status})`, `Could not load the ${stem.name} track (${res.status}).`));
            const buffer = await engine.ctx.decodeAudioData(await res.arrayBuffer());
            fresh.push({ name: stem.name, buffer });
            setBusy(t(`กำลังโหลดสเตม ${++done}/${job.stems.length}...`, `Loading stems ${done}/${job.stems.length}...`));
          }),
        );
        // All stems share one tempo, and drums are the most reliable to measure.
        const drums = fresh.find((f) => f.name === "drums");
        const tempo = drums ? detectBpm(drums.buffer) : fresh[0] ? detectBpm(fresh[0].buffer) : existing[0]?.bpm ?? 120;
        const order = ["vocals", "drums", "bass", "other"];
        const made = fresh.map(({ name, buffer }) => {
          const src = registerSource(`${stemLabel(name)} · ${base}`, buffer, "stem", STEM_COLORS[name], tempo);
          stemKeys.current.set(`${jobId}:${name}`, src.id);
          return { name, src };
        });
        for (const src of existing) {
          const name = Array.from(stemKeys.current.entries()).find(([, id]) => id === src.id)?.[0].split(":")[1] ?? "other";
          made.push({ name, src });
        }
        made.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
        if (place && made.length) {
          const startBeat = 0;
          const empty = engine.project.clips.length === 0;
          update((p) => {
            const tracks = p.tracks.slice();
            while (tracks.length < made.length) tracks.push(newTrack(tracks.length));
            const renamed = empty ? tracks.map((tr, i) => (made[i] ? { ...tr, name: stemLabel(made[i].name) } : tr)) : tracks;
            const at = empty ? startBeat : Math.ceil(engine.contentEnd() / p.beatsPerBar) * p.beatsPerBar;
            const clips = [
              ...p.clips,
              ...made.map(({ src }, i) => makeClip(src, renamed[i].id, at)),
            ];
            return { ...p, tracks: renamed, clips, bpm: empty ? Math.round(clamp(tempo, MIN_BPM, MAX_BPM)) : p.bpm };
          });
          setSelected(new Set());
          flash(t("วางสเตมลงแทร็กแล้ว กด Space เพื่อเล่น", "Stems placed on tracks. Press Space to play."));
        } else {
          flash(t("โหลดสเตมเข้าคลังแล้ว ลากไปวางบน timeline ได้เลย", "Stems loaded. Drag them onto the timeline."));
        }
      } catch (e) {
        flash(e instanceof Error ? e.message : t("โหลดสเตมไม่สำเร็จ", "Could not load stems."));
      } finally {
        setBusy(null);
      }
    },
    [engine, flash, registerSource, stemLabel, t, update], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Arriving from the mixer ("Open in Mini DAW"): load and place the fresh stems straight away.
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (!initialJobId || autoLoaded.current) return;
    autoLoaded.current = true;
    void loadJob(initialJobId, "", true);
  }, [initialJobId, loadJob]);

  // ---- clip editing ----------------------------------------------------------
  const selectedClips = useMemo(() => project.clips.filter((c) => selected.has(c.id)), [project.clips, selected]);

  const splitAtPlayhead = useCallback(() => {
    const beat = engine.getBeat();
    const ids = selected.size ? selected : null;
    const res = splitClipsAt(engine.project, engine.sources, ids, beat);
    if (!res.changed) {
      flash(t("ไม่มีคลิปให้ตัดที่ตำแหน่งเพลย์เฮด", "No clip to split at the playhead."));
      return;
    }
    update((p) => ({ ...p, clips: res.clips }));
  }, [engine, flash, selected, t, update]);

  const deleteSelected = useCallback(() => {
    if (selected.size === 0) return;
    update((p) => ({ ...p, clips: p.clips.filter((c) => !selected.has(c.id)) }));
    setSelected(new Set());
  }, [selected, update]);

  const repeatSelected = useCallback(
    (times: number) => {
      const group = engine.project.clips.filter((c) => selected.has(c.id));
      const copies = repeatClips(group, engine.sources, engine.project.bpm, times);
      if (!copies.length) return;
      update((p) => ({ ...p, clips: [...p.clips, ...copies] }));
      setSelected(new Set(copies.map((c) => c.id)));
    },
    [engine, selected, update],
  );

  const sliceSelected = useCallback(() => {
    const step = snap > 0 ? snap : 1;
    let count = 0;
    const next: DawClip[] = [];
    for (const clip of engine.project.clips) {
      if (!selected.has(clip.id)) {
        next.push(clip);
        continue;
      }
      const pieces = sliceClip(clip, step, engine.sources, engine.project.bpm);
      count += pieces.length - 1;
      next.push(...pieces);
    }
    if (count === 0) {
      flash(t("คลิปสั้นกว่าช่วงสไลซ์ จึงไม่มีอะไรให้ตัด", "The clip is shorter than the slice step, nothing to cut."));
      return;
    }
    update((p) => ({ ...p, clips: next }));
    flash(t(`หั่นแล้ว ${count} จุด`, `Sliced at ${count} points.`));
  }, [engine, flash, selected, snap, t, update]);

  const setClipField = useCallback(
    (patch: Partial<DawClip>, record = true) => {
      update((p) => ({ ...p, clips: p.clips.map((c) => (selected.has(c.id) ? { ...c, ...patch } : c)) }), record);
    },
    [selected, update],
  );

  const setTrack = useCallback(
    (id: string, patch: Partial<DawTrack>, record = false) => {
      update((p) => ({ ...p, tracks: p.tracks.map((tr) => (tr.id === id ? { ...tr, ...patch } : tr)) }), record);
    },
    [update],
  );

  const removeTrack = (id: string) => {
    if (engine.project.tracks.length <= 1) return;
    update((p) => ({ ...p, tracks: p.tracks.filter((tr) => tr.id !== id), clips: p.clips.filter((c) => c.track !== id) }));
    setFxTrackId((cur) => (cur === id ? null : cur));
    setSelected(new Set());
  };

  const addTrack = () => update((p) => ({ ...p, tracks: [...p.tracks, newTrack(p.tracks.length)] }));

  // ---- keyboard ----------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (e.code === "Space") {
        e.preventDefault();
        if (engine.playing) engine.pause();
        else void engine.play();
      } else if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) engine.redo();
        else engine.undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        engine.redo();
      } else if (mod && key === "d") {
        e.preventDefault();
        repeatSelected(1);
      } else if (mod && key === "a") {
        e.preventDefault();
        setSelected(new Set(engine.project.clips.map((c) => c.id)));
      } else if (!mod && key === "s") {
        splitAtPlayhead();
      } else if (!mod && key === "v") {
        setTool("select");
      } else if (!mod && key === "c") {
        setTool("chop");
      } else if (!mod && key === "l") {
        update((p) => ({ ...p, loop: { ...p.loop, on: !p.loop.on } }), false);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelected();
      } else if (e.key === "Escape") {
        setSelected(new Set());
      } else if (e.key === "Home") {
        engine.seek(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelected, engine, repeatSelected, splitAtPlayhead, update]);

  // ---- clip dragging -----------------------------------------------------------
  const onClipPointerDown = (event: ReactPointerEvent<HTMLDivElement>, id: string) => {
    if (event.button !== 0) return;
    const clip = engine.project.clips.find((c) => c.id === id);
    const src = clip && engine.sources.get(clip.sourceId);
    if (!clip || !src) return;
    event.stopPropagation();

    const proj = engine.project;
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const clipLen = clipBeats(clip, src, proj.bpm);

    if (tool === "chop") {
      event.preventDefault();
      const beat = snapTo(pointerBeat(event.clientX, lanesRef.current, HEADER_W), snap);
      const res = splitClipsAt(proj, engine.sources, new Set([id]), beat);
      if (res.changed) {
        update((p) => ({ ...p, clips: res.clips }));
        setSelected(new Set(res.created));
      }
      return;
    }

    event.preventDefault();
    const kind: DragState["kind"] = localX <= 7 ? "trimL" : localX >= rect.width - 7 && rect.width > 20 ? "trimR" : "move";
    let ids: string[];
    if (event.shiftKey) {
      const next = new Set(selected);
      if (next.has(id) && kind === "move") next.delete(id);
      else next.add(id);
      setSelected(next);
      ids = [...next];
      if (!next.has(id)) return;
    } else if (selected.has(id)) {
      ids = [...selected];
    } else {
      ids = [id];
      setSelected(new Set(ids));
    }
    if (kind !== "move") ids = [id];
    setActiveTrack(Math.max(0, proj.tracks.findIndex((tr) => tr.id === clip.track)));

    const originals = new Map(proj.clips.filter((c) => ids.includes(c.id)).map((c) => [c.id, c]));
    const startX = event.clientX;
    const startY = event.clientY;
    const startPpb = ppbRef.current;
    const trackIndex = (trackId: string) => proj.tracks.findIndex((tr) => tr.id === trackId);
    const minStart = Math.min(...[...originals.values()].map((c) => c.start));
    const minTrack = Math.min(...[...originals.values()].map((c) => trackIndex(c.track)));
    const maxTrack = Math.max(...[...originals.values()].map((c) => trackIndex(c.track)));
    const primaryStart = clip.start;
    const copy = event.altKey && kind === "move";
    let latest: DragState | null = null;
    draggingRef.current = true;

    const compute = (e: PointerEvent) => {
      const noSnap = e.metaKey || e.ctrlKey;
      const size = noSnap ? 0 : snap;
      const dBeatRaw = (e.clientX - startX) / startPpb;
      const preview = new Map<string, DawClip>();
      if (kind === "move") {
        let dBeat = snapTo(primaryStart + dBeatRaw, size) - primaryStart;
        dBeat = Math.max(dBeat, -minStart);
        const dTrack = clamp(Math.round((e.clientY - startY) / LANE_H), -minTrack, proj.tracks.length - 1 - maxTrack);
        for (const c of originals.values()) {
          preview.set(c.id, { ...c, start: c.start + dBeat, track: proj.tracks[trackIndex(c.track) + dTrack].id });
        }
      } else if (kind === "trimL") {
        const spb = secPerBeat(clip, src, proj.bpm);
        let newStart = snapTo(clip.start + dBeatRaw, size);
        newStart = clamp(newStart, Math.max(0, clip.start - clip.offset / spb), clip.start + clipLen - (MIN_CLIP_SEC / spb));
        const d = newStart - clip.start;
        preview.set(id, { ...clip, start: newStart, offset: clip.offset + d * spb, dur: clip.dur - d * spb });
      } else {
        const spb = secPerBeat(clip, src, proj.bpm);
        let newEnd = snapTo(clip.start + clipLen + dBeatRaw, size);
        const maxDur = src.buffer.duration - clip.offset;
        newEnd = clamp(newEnd, clip.start + MIN_CLIP_SEC / spb, clip.start + maxDur / spb);
        preview.set(id, { ...clip, dur: Math.min(maxDur, (newEnd - clip.start) * spb) });
      }
      const moved = Math.abs(e.clientX - startX) > 3 || Math.abs(e.clientY - startY) > 3;
      latest = { kind, primary: id, ids, copy, preview, moved };
      setDrag(latest);
    };

    const finish = () => {
      window.removeEventListener("pointermove", compute);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      draggingRef.current = false;
      const final = latest;
      setDrag(null);
      if (!final || !final.moved) {
        if (!event.shiftKey && ids.length > 1) setSelected(new Set([id]));
        return;
      }
      if (final.copy) {
        const copies = [...final.preview.values()].map((c) => ({ ...c, id: uid("c") }));
        update((p) => ({ ...p, clips: [...p.clips, ...copies] }));
        setSelected(new Set(copies.map((c) => c.id)));
      } else {
        update((p) => ({ ...p, clips: p.clips.map((c) => final.preview.get(c.id) ?? c) }));
      }
    };

    window.addEventListener("pointermove", compute);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  // ---- lane background: seek / deselect, chop guide -----------------------------
  const onLanePointerDown = (event: ReactPointerEvent<HTMLDivElement>, trackIdx: number) => {
    if (event.button !== 0) return;
    setActiveTrack(trackIdx);
    const beat = snapTo(pointerBeat(event.clientX, lanesRef.current, HEADER_W), snap);
    engine.seek(beat);
    if (!event.shiftKey) setSelected(new Set());
  };

  const onLanePointerMove = (event: ReactPointerEvent<HTMLDivElement>, trackIdx: number) => {
    if (tool !== "chop" || draggingRef.current) {
      if (chopGuide) setChopGuide(null);
      return;
    }
    const beat = snapTo(pointerBeat(event.clientX, lanesRef.current, HEADER_W), snap);
    const track = engine.project.tracks[trackIdx];
    const over = track && engine.project.clips.some((c) => c.track === track.id && beat > c.start && beat < clipEnd(c, engine.sources.get(c.sourceId)!, engine.project.bpm));
    setChopGuide(over ? { track: trackIdx, beat } : null);
  };

  // ---- drag & drop onto lanes ------------------------------------------------------
  const onLaneDragOver = (event: DragEvent<HTMLDivElement>, trackIdx: number) => {
    const types = event.dataTransfer.types;
    const isSource = types.includes("application/x-stemlab-source");
    if (!isSource && !types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const src = dragSourceRef.current ? engine.sources.get(dragSourceRef.current) : null;
    const beat = snapTo(pointerBeat(event.clientX, lanesRef.current, HEADER_W), snap);
    setGhost({
      track: trackIdx,
      beat,
      beats: src ? (src.buffer.duration * (src.bpm / 60)) : 4,
      color: src?.color ?? "#999",
    });
  };

  const onLaneDrop = (event: DragEvent<HTMLDivElement>, trackIdx: number) => {
    event.preventDefault();
    const beat = snapTo(pointerBeat(event.clientX, lanesRef.current, HEADER_W), snap);
    setGhost(null);
    const id = event.dataTransfer.getData("application/x-stemlab-source");
    if (id) {
      const src = engine.sources.get(id);
      if (src) placeClips([{ src, track: trackIdx, start: beat }]);
      return;
    }
    const files = Array.from(event.dataTransfer.files).filter((f) => f.type.startsWith("audio/") || /\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(f.name));
    if (files.length) void addFiles(files, { track: trackIdx, beat });
  };

  const addSourceAtPlayhead = (id: string) => {
    const src = engine.sources.get(id);
    if (!src) return;
    const track = clamp(activeTrack, 0, engine.project.tracks.length - 1);
    const beat = snapTo(engine.getBeat(), snap);
    placeClips([{ src, track, start: beat }]);
  };

  // ---- ruler & loop strip ---------------------------------------------------------------
  const onRulerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const go = (clientX: number) => engine.seek(snapTo(pointerBeat(clientX, rulerRef.current), snap));
    go(event.clientX);
    const move = (e: PointerEvent) => go(e.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onLoopPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const loop = engine.project.loop;
    const size = snap > 0 ? snap : 0.25;
    const beatAt = (clientX: number) => snapTo(pointerBeat(clientX, rulerRef.current), size);
    const downBeat = pointerBeat(event.clientX, rulerRef.current);
    const edge = 7 / ppbRef.current;
    let mode: "new" | "move" | "left" | "right" = "new";
    if (Math.abs(downBeat - loop.start) <= edge) mode = "left";
    else if (Math.abs(downBeat - loop.end) <= edge) mode = "right";
    else if (downBeat > loop.start && downBeat < loop.end) mode = "move";
    const anchor = beatAt(event.clientX);
    const grab = downBeat - loop.start;
    const length = loop.end - loop.start;

    const move = (e: PointerEvent) => {
      const b = beatAt(e.clientX);
      const raw = pointerBeat(e.clientX, rulerRef.current);
      let next = loop;
      if (mode === "new") {
        const a = Math.min(anchor, b);
        const z = Math.max(anchor, b);
        next = { start: a, end: Math.max(z, a + size), on: true };
      } else if (mode === "left") {
        next = { ...loop, start: Math.min(b, loop.end - size) };
      } else if (mode === "right") {
        next = { ...loop, end: Math.max(b, loop.start + size) };
      } else {
        const start = Math.max(0, snapTo(raw - grab, size));
        next = { ...loop, start, end: start + length };
      }
      update((p) => ({ ...p, loop: next }), false);
    };
    const up = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (mode === "move" && Math.abs(e.clientX - event.clientX) < 3) {
        update((p) => ({ ...p, loop: { ...p.loop, on: !p.loop.on } }), false);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---- export ---------------------------------------------------------------------------
  const exportWav = async () => {
    if (engine.contentEnd() <= 0) {
      flash(t("ยังไม่มีคลิปให้ส่งออก", "Nothing to export yet."));
      return;
    }
    setExporting(true);
    try {
      const blob = await engine.renderWav();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "stemlab-remix-sketch.wav";
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      flash(t("ส่งออกไม่สำเร็จ", "Export failed."));
    } finally {
      setExporting(false);
    }
  };

  // ---- render ------------------------------------------------------------------------------
  const clipsToRender = useMemo(() => {
    if (!drag) return project.clips.map((c) => ({ clip: c, ghost: false }));
    const out: { clip: DawClip; ghost: boolean }[] = [];
    for (const c of project.clips) {
      const moved = drag.preview.get(c.id);
      if (moved && !drag.copy) out.push({ clip: moved, ghost: false });
      else out.push({ clip: c, ghost: false });
    }
    if (drag.copy) for (const c of drag.preview.values()) out.push({ clip: { ...c, id: `${c.id}~copy` }, ghost: true });
    return out;
  }, [drag, project.clips]);

  const fxTrack = project.tracks.find((tr) => tr.id === fxTrackId) ?? null;
  const single = selectedClips.length === 1 ? selectedClips[0] : null;
  const singleSrc = single ? engine.sources.get(single.sourceId) : null;
  const subVisible = ppb >= 64;
  const labelStep = [1, 2, 4, 8, 16, 32].find((s) => s * bpb * ppb >= 52) ?? 32;
  const showBeatLabels = ppb >= 58;
  const loop = project.loop;

  const gridVars = {
    "--ppb": ppb,
    "--bpb": bpb,
    "--lane-h": `${LANE_H}px`,
    "--header-w": `${HEADER_W}px`,
  } as CSSProperties;

  const barLabels = useMemo(() => {
    const items: { left: number; text: string; beat: boolean }[] = [];
    for (let bar = 0; bar < totalBars; bar++) {
      if (bar % labelStep === 0) items.push({ left: bar * bpb * ppb, text: String(bar + 1), beat: false });
      if (showBeatLabels) for (let b = 1; b < bpb; b++) items.push({ left: (bar * bpb + b) * ppb, text: `${bar + 1}.${b + 1}`, beat: true });
    }
    return items;
  }, [bpb, labelStep, ppb, showBeatLabels, totalBars]);

  return (
    <div className={`daw${tool === "chop" ? " tool-chop" : ""}`} aria-label="Mini DAW">
      {/* Transport & tools */}
      <div className="daw-toolbar" role="toolbar" aria-label={t("แถบควบคุม", "Transport and tools")}>
        <div className="daw-group">
          <button type="button" className={`daw-btn daw-play${engine.playing ? " is-on" : ""}`} onClick={() => (engine.playing ? engine.pause() : void engine.play())} aria-label={engine.playing ? t("หยุดชั่วคราว", "Pause") : t("เล่น", "Play")} title="Space">
            {engine.playing ? "❚❚" : "▶"}
          </button>
          <button type="button" className="daw-btn" onClick={() => engine.stop()} aria-label={t("หยุดและกลับไปจุดเริ่ม", "Stop and return to start")} title={t("หยุด / กลับต้น (Home)", "Stop / to start (Home)")}>
            ■
          </button>
          <button type="button" className={`daw-btn daw-toggle${loop.on ? " is-on" : ""}`} aria-pressed={loop.on} onClick={() => update((p) => ({ ...p, loop: { ...p.loop, on: !p.loop.on } }), false)} title="L">
            {t("ลูป", "Loop")}
          </button>
          <button type="button" className={`daw-btn daw-toggle${project.metronome ? " is-on" : ""}`} aria-pressed={project.metronome} onClick={() => update((p) => ({ ...p, metronome: !p.metronome }), false)}>
            {t("เมโทรนอม", "Metro")}
          </button>
        </div>

        <div className="daw-readout" aria-live="off">
          <span ref={barsRef} className="daw-readout-main">001.1.1</span>
          <span ref={clockRef} className="daw-readout-sub">0:00.0</span>
        </div>

        <div className="daw-group">
          <label className="daw-field">
            <span>BPM</span>
            <input
              key={project.bpm}
              className="daw-input daw-input-bpm"
              type="number"
              min={MIN_BPM}
              max={MAX_BPM}
              step={1}
              defaultValue={project.bpm}
              onBlur={(e) => {
                const v = Math.round(clamp(Number(e.currentTarget.value) || project.bpm, MIN_BPM, MAX_BPM));
                if (v !== project.bpm) update((p) => ({ ...p, bpm: v }));
                else e.currentTarget.value = String(project.bpm);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </label>
          <label className="daw-field">
            <span>{t("ห้อง", "Meter")}</span>
            <select className="daw-select" value={bpb} onChange={(e) => update((p) => ({ ...p, beatsPerBar: Number(e.target.value), loop: { ...p.loop, end: p.loop.start + Math.max(1, Math.round((p.loop.end - p.loop.start) / p.beatsPerBar)) * Number(e.target.value) } }))}>
              {[3, 4, 5, 6, 7].map((n) => (
                <option key={n} value={n}>{n}/4</option>
              ))}
            </select>
          </label>
          <label className="daw-field">
            <span>{t("สแนป", "Snap")}</span>
            <select className="daw-select" value={snapKey} onChange={(e) => setSnapKey(e.target.value)}>
              {SNAP_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>{language === "th" ? o.th : o.en}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="daw-group" role="group" aria-label={t("เครื่องมือ", "Tools")}>
          <button type="button" className={`daw-btn daw-toggle${tool === "select" ? " is-on" : ""}`} aria-pressed={tool === "select"} onClick={() => setTool("select")} title="V">
            {t("เลือก", "Select")} <kbd>V</kbd>
          </button>
          <button type="button" className={`daw-btn daw-toggle${tool === "chop" ? " is-on" : ""}`} aria-pressed={tool === "chop"} onClick={() => setTool("chop")} title="C">
            {t("หั่น", "Chop")} <kbd>C</kbd>
          </button>
          <button type="button" className="daw-btn" onClick={splitAtPlayhead} title="S">
            {t("ตัดที่เพลย์เฮด", "Split")} <kbd>S</kbd>
          </button>
        </div>

        <div className="daw-group daw-group-end">
          <button type="button" className="daw-icon-btn" onClick={() => zoomBy(1 / 1.4)} aria-label={t("ซูมออก", "Zoom out")}>−</button>
          <input className="daw-zoom" type="range" min={0} max={1} step={0.005} value={sliderFromPpb(ppb)} onChange={(e) => setPpb(ppbFromSlider(Number(e.target.value)))} aria-label={t("ซูม", "Zoom")} />
          <button type="button" className="daw-icon-btn" onClick={() => zoomBy(1.4)} aria-label={t("ซูมเข้า", "Zoom in")}>+</button>
          <button type="button" className={`daw-btn daw-toggle${follow ? " is-on" : ""}`} aria-pressed={follow} onClick={() => setFollow((f) => !f)}>
            {t("ตามเพลย์เฮด", "Follow")}
          </button>
          <button type="button" className="daw-icon-btn" disabled={!engine.canUndo} onClick={() => engine.undo()} aria-label={t("ย้อนกลับ", "Undo")} title="Ctrl/⌘ Z">↶</button>
          <button type="button" className="daw-icon-btn" disabled={!engine.canRedo} onClick={() => engine.redo()} aria-label={t("ทำซ้ำ", "Redo")} title="Ctrl/⌘ Shift Z">↷</button>
          <button type="button" className="daw-btn daw-btn-accent" onClick={() => void exportWav()} disabled={exporting}>
            {exporting ? t("กำลังเรนเดอร์...", "Rendering...") : t("ส่งออก WAV", "Export WAV")}
          </button>
        </div>
      </div>

      <div className="daw-body">
        <Library
          sources={sourceList}
          auditioning={engine.auditioning}
          busy={busy}
          usedIds={usedIds}
          onFiles={(files) => void addFiles(files)}
          onLoadJob={(job: HistoryItem, place) => void loadJob(job.job_id, job.filename, place)}
          onAudition={(id) => engine.auditionSource(engine.auditioning === id ? null : id)}
          onAddToTimeline={addSourceAtPlayhead}
          onBpm={(id, bpm) => engine.setSourceBpm(id, bpm)}
          onRemove={(id) => engine.removeUnusedSource(id)}
          onDragSource={(id) => {
            dragSourceRef.current = id;
            if (!id) setGhost(null);
          }}
        />

        <div className="daw-arrange">
          <div className="daw-scroll" ref={scrollRef} style={gridVars}>
            <div className={`daw-inner${subVisible ? " show-sub" : ""}`} style={{ width: HEADER_W + laneWidth }}>
              {/* Ruler */}
              <div className="daw-ruler-row">
                <div className="daw-corner">
                  {notice ? <span className="daw-notice" role="status">{notice}</span> : <span>{t("แทร็ก", "Tracks")}</span>}
                </div>
                <div className="daw-ruler-col" ref={rulerRef} style={{ width: laneWidth }}>
                  <div className="daw-loopstrip" onPointerDown={onLoopPointerDown} title={t("ลากเพื่อกำหนดช่วงลูป", "Drag to set the loop region")}>
                    <div
                      className={`daw-loop-region${loop.on ? " is-on" : ""}`}
                      style={{ left: loop.start * ppb, width: Math.max(2, (loop.end - loop.start) * ppb) }}
                    >
                      <span className="daw-loop-handle left" />
                      <span className="daw-loop-handle right" />
                    </div>
                  </div>
                  <div className="daw-ruler" onPointerDown={onRulerPointerDown}>
                    {barLabels.map((l) => (
                      <span key={`${l.text}-${l.beat}`} className={`daw-ruler-label${l.beat ? " is-beat" : ""}`} style={{ left: l.left }}>
                        {l.text}
                      </span>
                    ))}
                    <div className="daw-ruler-head" ref={rulerHeadRef} />
                  </div>
                </div>
              </div>

              {/* Lanes */}
              <div className="daw-lanes" ref={lanesRef}>
                {project.tracks.map((track, index) => {
                  const rowClips = clipsToRender.filter((c) => c.clip.track === track.id);
                  return (
                    <div className={`daw-row${activeTrack === index ? " is-active" : ""}`} key={track.id}>
                      <div className="daw-head" onPointerDown={() => setActiveTrack(index)}>
                        <div className="daw-head-top">
                          <input
                            className="daw-track-name"
                            value={track.name}
                            aria-label={t("ชื่อแทร็ก", "Track name")}
                            onChange={(e) => setTrack(track.id, { name: e.target.value })}
                          />
                          <button type="button" className={`daw-chip${track.muted ? " is-on is-mute" : ""}`} aria-pressed={track.muted} onClick={() => setTrack(track.id, { muted: !track.muted }, true)} title={t("ปิดเสียง", "Mute")}>M</button>
                          <button type="button" className={`daw-chip${track.solo ? " is-on is-solo" : ""}`} aria-pressed={track.solo} onClick={() => setTrack(track.id, { solo: !track.solo }, true)} title={t("โซโล", "Solo")}>S</button>
                          <button type="button" className={`daw-chip daw-chip-fx${fxActive(track.fx) ? " has-fx" : ""}${fxTrackId === track.id ? " is-open" : ""}`} aria-pressed={fxTrackId === track.id} onClick={() => setFxTrackId((cur) => (cur === track.id ? null : track.id))} title={t("เอฟเฟกต์ของแทร็ก", "Track effects")}>FX</button>
                          <button type="button" className="daw-chip daw-chip-del" onClick={() => removeTrack(track.id)} disabled={project.tracks.length <= 1} aria-label={t("ลบแทร็ก", "Delete track")} title={t("ลบแทร็ก", "Delete track")}>×</button>
                        </div>
                        <div className="daw-head-mix">
                          <label>
                            <span>{t("ดัง", "Vol")}</span>
                            <input type="range" min={0} max={1.25} step={0.01} value={track.volume} onChange={(e) => setTrack(track.id, { volume: Number(e.target.value) })} aria-label={t("ความดัง", "Volume")} />
                          </label>
                          <label>
                            <span>{t("แพน", "Pan")}</span>
                            <input type="range" min={-1} max={1} step={0.02} value={track.pan} onChange={(e) => setTrack(track.id, { pan: Number(e.target.value) })} onDoubleClick={() => setTrack(track.id, { pan: 0 })} aria-label="Pan" />
                          </label>
                        </div>
                        <div className="daw-meter" aria-hidden="true">
                          <span
                            ref={(el) => {
                              if (el) meterRefs.current.set(track.id, el);
                              else meterRefs.current.delete(track.id);
                            }}
                          />
                        </div>
                      </div>
                      <div
                        className="daw-lane"
                        style={{ width: laneWidth }}
                        data-track={track.id}
                        onPointerDown={(e) => onLanePointerDown(e, index)}
                        onPointerMove={(e) => onLanePointerMove(e, index)}
                        onPointerLeave={() => chopGuide && setChopGuide(null)}
                        onDragOver={(e) => onLaneDragOver(e, index)}
                        onDragLeave={() => setGhost(null)}
                        onDrop={(e) => onLaneDrop(e, index)}
                      >
                        {rowClips.map(({ clip, ghost: isGhost }) => {
                          const src = engine.sources.get(clip.sourceId);
                          if (!src) return null;
                          return (
                            <ClipView
                              key={clip.id}
                              id={clip.id}
                              name={src.name}
                              source={src}
                              start={clip.start}
                              beats={clipBeats(clip, src, project.bpm)}
                              offset={clip.offset}
                              dur={clip.dur}
                              warp={clip.warp}
                              ppb={ppb}
                              selected={selected.has(clip.id.replace("~copy", ""))}
                              ghost={isGhost}
                              onPointerDown={onClipPointerDown}
                            />
                          );
                        })}
                        {ghost && ghost.track === index && (
                          <div className="daw-drop-ghost" style={{ left: ghost.beat * ppb, width: Math.max(8, ghost.beats * ppb), "--clip": ghost.color } as CSSProperties} />
                        )}
                        {chopGuide && chopGuide.track === index && <div className="daw-chop-guide" style={{ left: chopGuide.beat * ppb }} />}
                      </div>
                    </div>
                  );
                })}
                <div className="daw-row daw-row-add">
                  <div className="daw-head daw-head-add">
                    <button type="button" className="daw-btn" onClick={addTrack}>+ {t("เพิ่มแทร็ก", "Add track")}</button>
                  </div>
                  <div className="daw-lane daw-lane-empty" style={{ width: laneWidth }} />
                </div>
                <div className="daw-playhead" ref={playheadRef} aria-hidden="true" />
                {loop.on && (
                  <>
                    <div className="daw-loop-shade" style={{ left: HEADER_W, width: loop.start * ppb }} aria-hidden="true" />
                    <div className="daw-loop-shade" style={{ left: HEADER_W + loop.end * ppb, width: Math.max(0, laneWidth - loop.end * ppb) }} aria-hidden="true" />
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Quick FX chain for the chosen track */}
          {fxTrack && (
            <FxPanel
              key={fxTrack.id}
              trackName={fxTrack.name}
              fx={fxTrack.fx}
              sampleRate={engine.ctx.sampleRate}
              onChange={(fx, record) => setTrack(fxTrack.id, { fx }, record)}
              onClose={() => setFxTrackId(null)}
            />
          )}

          {/* Inspector */}
          <div className="daw-inspector">
            {selectedClips.length === 0 && (
              <p className="daw-hint">
                {t(
                  "ลากสเตมจากคลังมาวาง · เครื่องมือหั่น (C) คลิกบนคลิปเพื่อตัด · ลากกลางคลิปเพื่อย้าย ลากขอบเพื่อตัดความยาว · Alt+ลาก = คัดลอก · Ctrl/⌘+ล้อเมาส์ = ซูม",
                  "Drag stems in from the library · Chop tool (C): click a clip to cut · drag a clip to move, its edges to trim · Alt+drag = copy · Ctrl/⌘+wheel = zoom",
                )}
              </p>
            )}
            {selectedClips.length > 0 && (
              <>
                <div className="daw-insp-info">
                  <strong>{single && singleSrc ? singleSrc.name : t(`${selectedClips.length} คลิป`, `${selectedClips.length} clips`)}</strong>
                  {single && singleSrc && (
                    <span>
                      {formatBars(single.start, bpb)} · {(clipBeats(single, singleSrc, project.bpm)).toFixed(2)} {t("จังหวะ", "beats")} · {single.dur.toFixed(2)}s
                    </span>
                  )}
                </div>
                <label className="daw-field">
                  <input type="checkbox" checked={selectedClips.every((c) => c.warp)} onChange={(e) => setClipField({ warp: e.target.checked })} />
                  <span title={t("ปรับความเร็วคลิปให้ตรงกับ BPM ของโปรเจกต์", "Match the clip's speed to the project BPM")}>Warp</span>
                </label>
                <label className="daw-field">
                  <span>{t("เกน", "Gain")}</span>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.01}
                    value={single ? single.gain : selectedClips[0].gain}
                    onChange={(e) => setClipField({ gain: Number(e.target.value) }, false)}
                    aria-label={t("เกนของคลิป", "Clip gain")}
                  />
                </label>
                <div className="daw-insp-actions">
                  <button type="button" className="daw-btn" onClick={splitAtPlayhead}>{t("ตัดที่เพลย์เฮด", "Split at playhead")}</button>
                  <button type="button" className="daw-btn" onClick={sliceSelected} title={t("หั่นตามช่วงสแนปปัจจุบัน", "Cut at every snap step")}>{t("หั่นตามกริด", "Slice to grid")}</button>
                  <button type="button" className="daw-btn" onClick={() => repeatSelected(1)} title="Ctrl/⌘ D">{t("ทำซ้ำ", "Duplicate")}</button>
                  <button type="button" className="daw-btn" onClick={() => repeatSelected(3)}>{t("ลูป ×4", "Loop ×4")}</button>
                  <button type="button" className="daw-btn" onClick={() => repeatSelected(7)}>{t("ลูป ×8", "Loop ×8")}</button>
                  <button type="button" className="daw-btn daw-btn-danger" onClick={deleteSelected} title="Delete">{t("ลบ", "Delete")}</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function newTrack(index: number): DawTrack {
  return { id: uid("t"), name: `Track ${index + 1}`, volume: 0.9, pan: 0, muted: false, solo: false, fx: defaultFx() };
}

// Keep emptyProject referenced so a future "New project" action can reuse it.
export const createEmptyProject = emptyProject;

import { useMemo, type CSSProperties } from "react";
import { useLanguage } from "./Language";

/** Deterministic pseudo-random bars so every clip has its own "waveform". */
function bars(seed: number, count: number): number[] {
  let a = seed * 2654435761;
  return Array.from({ length: count }, (_, i) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return 18 + Math.round((0.35 + 0.65 * Math.abs(Math.sin(i * 0.55 + seed))) * r * 82);
  });
}

interface PreviewClip {
  from: number; // bar position 0..8
  len: number;
  seed: number;
}

const LANES: { key: string; th: string; en: string; color: string; clips: PreviewClip[]; fx?: string }[] = [
  { key: "vocals", th: "เสียงร้อง", en: "Vocals", color: "#e08fa3", clips: [{ from: 0, len: 1.9, seed: 3 }, { from: 2.1, len: 0.9, seed: 3 }, { from: 4, len: 2, seed: 8 }, { from: 6.2, len: 1.8, seed: 3 }], fx: "Reverb" },
  { key: "drums", th: "กลอง", en: "Drums", color: "#e0a15f", clips: [{ from: 0, len: 1, seed: 11 }, { from: 1, len: 1, seed: 11 }, { from: 2, len: 1, seed: 11 }, { from: 3, len: 1, seed: 11 }, { from: 4, len: 1, seed: 14 }, { from: 5, len: 1, seed: 11 }, { from: 6, len: 1, seed: 11 }, { from: 7, len: 1, seed: 14 }], fx: "Filter" },
  { key: "bass", th: "เบส", en: "Bass", color: "#6fa8dc", clips: [{ from: 0, len: 4, seed: 21 }, { from: 4, len: 4, seed: 22 }], fx: "EQ" },
  { key: "other", th: "เสียงอื่น ๆ", en: "Other", color: "#a98fd9", clips: [{ from: 1, len: 3, seed: 31 }, { from: 5, len: 3, seed: 31 }], fx: "Delay" },
];

/**
 * An animated miniature of the Mini DAW: ruler, loop bracket, a sweeping playhead,
 * clips with waveforms, a chop marker that flashes, and the per-track FX tags.
 * Purely decorative (aria-hidden); the surrounding text carries the meaning.
 */
export function DawPreview() {
  const { t } = useLanguage();
  const lanes = useMemo(() => LANES.map((l) => ({ ...l, clips: l.clips.map((c) => ({ ...c, bars: bars(c.seed, Math.max(6, Math.round(c.len * 14))) })) })), []);
  return (
    <div className="dawpv" aria-hidden="true">
      <div className="dawpv-top">
        <span className="dawpv-dot" />
        <span className="dawpv-dot" />
        <span className="dawpv-dot" />
        <span className="dawpv-title">Stemlab · Mini DAW</span>
        <span className="dawpv-bpm">120 BPM</span>
      </div>
      <div className="dawpv-body">
        <div className="dawpv-ruler">
          <div className="dawpv-corner" />
          <div className="dawpv-bars">
            {Array.from({ length: 8 }, (_, i) => (
              <span key={i}>{i + 1}</span>
            ))}
            <div className="dawpv-loop"><b>LOOP</b></div>
          </div>
        </div>
        <div className="dawpv-lanes">
          {lanes.map((lane) => (
            <div className="dawpv-row" key={lane.key} style={{ "--c": lane.color } as CSSProperties}>
              <div className="dawpv-head">
                <span>{t(lane.th, lane.en)}</span>
                <em>{lane.fx}</em>
              </div>
              <div className="dawpv-lane">
                {lane.clips.map((c, i) => (
                  <div className="dawpv-clip" key={i} style={{ left: `${(c.from / 8) * 100}%`, width: `calc(${(c.len / 8) * 100}% - 2px)` }}>
                    {c.bars.map((h, k) => (
                      <i key={k} style={{ height: `${h}%` }} />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="dawpv-playhead" />
          <div className="dawpv-chop"><span>✂</span></div>
        </div>
      </div>
      <div className="dawpv-fxbar">
        <svg viewBox="0 0 120 28" className="dawpv-eq">
          <path d="M0 14 C14 14 18 6 30 6 S46 22 60 22 S78 8 92 8 S108 14 120 14" />
        </svg>
        {["Filter", "EQ Eight", "Delay", "Reverb"].map((n) => (
          <span key={n} className="dawpv-fxchip"><b />{n}</span>
        ))}
      </div>
    </div>
  );
}

interface Capability {
  glyph: string;
  th: string;
  en: string;
  thDesc: string;
  enDesc: string;
}

const CAPABILITIES: Capability[] = [
  { glyph: "✂", th: "หั่น (Chop)", en: "Chop", thDesc: "คลิกบนคลิปเพื่อตัดท่อนฮุก ตัดคำร้อง หรือหั่นตามกริดด้วยปุ่ม S / C", enDesc: "Click a clip to cut a hook or a vocal word, or slice to the grid with S / C." },
  { glyph: "↻", th: "ลูป", en: "Loop", thDesc: "ลากกำหนดช่วงลูปบนไม้บรรทัด หรือทำซ้ำคลิป ×4 / ×8 ได้ในคลิกเดียว", enDesc: "Drag a loop region on the ruler, or repeat a clip ×4 / ×8 in one click." },
  { glyph: "▦", th: "Timeline อิสระ", en: "Free timeline", thDesc: "ลากวาง ย้าย ตัดขอบ คัดลอก (Alt+ลาก) พร้อมเส้นกริดตามห้องและจังหวะ", enDesc: "Drag, move, trim, copy (Alt+drag) on a grid of bars and beats, like Ableton." },
  { glyph: "♩", th: "Warp ตาม BPM", en: "Warp to BPM", thDesc: "ตรวจ BPM ให้อัตโนมัติ และยืดหด stem ให้ลงจังหวะเดียวกัน", enDesc: "Tempo is detected for you, and stems are stretched to lock to one tempo." },
  { glyph: "≋", th: "Quick FX ต่อแทร็ก", en: "Quick FX per track", thDesc: "Filter, EQ 8 แบนด์, Delay ซิงก์ BPM และ Reverb แยกอิสระทีละแทร็ก", enDesc: "Filter, 8-band EQ, tempo-synced Delay and Reverb, independent on every track." },
  { glyph: "⤓", th: "ส่งออก WAV", en: "Export WAV", thDesc: "เรนเดอร์สเก็ตช์พร้อมเอฟเฟกต์และหางเสียง ไปต่อใน DAW ตัวโปรดของคุณ", enDesc: "Render your sketch with effects and tails, then continue in your favourite DAW." },
];

const KEYS: { k: string; th: string; en: string }[] = [
  { k: "Space", th: "เล่น / หยุด", en: "Play / pause" },
  { k: "C", th: "เครื่องมือหั่น", en: "Chop tool" },
  { k: "S", th: "ตัดที่เพลย์เฮด", en: "Split at playhead" },
  { k: "L", th: "เปิด/ปิดลูป", en: "Toggle loop" },
  { k: "⌘/Ctrl D", th: "ทำซ้ำ", en: "Duplicate" },
  { k: "⌘/Ctrl Z", th: "ย้อนกลับ", en: "Undo" },
];

/** Landing page: a pitch with the animated preview. */
export function DawLandingSection({ onOpen }: { onOpen: () => void }) {
  const { t } = useLanguage();
  const pills = [t("หั่นท่อนฮุก", "Chop hooks"), t("ลูปกลอง", "Loop drums"), t("EQ · Reverb · Delay", "EQ · Reverb · Delay"), t("ส่งออก WAV", "Export WAV")];
  return (
    <section id="mini-daw" className="dawland">
      <div className="dawland-glow" aria-hidden="true" />
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 sm:px-8 md:grid-cols-[0.85fr_1.15fr] md:py-28">
        <div>
          <p className="dawland-badge"><span>NEW</span>{t("สเก็ตช์แพดสำหรับ remix", "A sketchpad for remixing")}</p>
          <h2 className="daw-title dawland-title">Mini <span>DAW</span></h2>
          <p className="mt-5 max-w-md leading-8 text-neutral-300">
            {t(
              "แยกเสร็จแล้วไม่ต้องจบแค่นั้น เอา stem มาหั่น ลูป เรียงใหม่บน timeline สไตล์ Ableton แต่งเสียงด้วยเอฟเฟกต์ทีละแทร็ก แล้วส่งออกไปต่อยอดได้ทันที ทั้งหมดในเบราว์เซอร์",
              "Separation is only the start. Chop, loop and rearrange stems on an Ableton-style timeline, shape each track with effects, then export, all in your browser.",
            )}
          </p>
          <ul className="dawland-pills">
            {pills.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <button type="button" className="daw-cta daw-cta-lg mt-9" onClick={onOpen}>
            <span className="daw-cta-bars" aria-hidden="true"><i /><i /><i /><i /></span>
            {t("ลองเปิด Mini DAW", "Try the Mini DAW")}
            <span aria-hidden="true">↗</span>
          </button>
        </div>
        <DawPreview />
      </div>
    </section>
  );
}

/** How-it-works page: what it is for and everything you can do with it. */
export function DawGuideSection({ onOpen }: { onOpen: () => void }) {
  const { t } = useLanguage();
  const flow = [
    { n: "1", th: "แยกเพลงเป็น stem", en: "Separate a song", thD: "จากหน้าสตูดิโอ จนได้ vocals, drums, bass, other", enD: "In the studio, until you have vocals, drums, bass and other." },
    { n: "2", th: "กด “เปิดใน Mini DAW”", en: "Press “Open in Mini DAW”", thD: "สเตมทั้งสี่ลงแทร็กให้เองและตั้ง BPM ให้ตรง", enD: "The four stems land on tracks and the tempo is set for you." },
    { n: "3", th: "หั่น ลูป แต่งเสียง", en: "Chop, loop, shape", thD: "เรียงใหม่ ใส่เอฟเฟกต์ทีละแทร็ก แล้วส่งออก WAV", enD: "Rearrange, add effects per track, then export a WAV." },
  ];
  return (
    <section id="mini-daw" className="dawguide">
      <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 md:py-24">
        <p className="eyebrow">{t("เครื่องมือเสริม", "Companion tool")}</p>
        <div className="mt-4 grid items-end gap-6 md:grid-cols-[1.1fr_0.9fr]">
          <h2 className="daw-title dawguide-title">Mini <span>DAW</span></h2>
          <p className="leading-8 text-neutral-300">
            {t(
              "Mini DAW คือสเก็ตช์แพดสำหรับคนทำเพลงที่อยากเอา stem ไปเล่นต่อทันที ไม่ได้มีไว้แทนโปรแกรมทำเพลงเต็มรูปแบบ แต่ช่วยให้ไอเดียเรื่อง remix, mashup และการเลือกท่อนมาลูป ออกมาเป็นเสียงได้ภายในไม่กี่นาที",
              "The Mini DAW is a sketchpad for producers who want to play with stems straight away. It does not replace a full DAW, but it turns remix, mashup and loop ideas into sound in minutes.",
            )}
          </p>
        </div>

        <div className="dawguide-stage">
          <DawPreview />
        </div>

        <ol className="dawguide-flow">
          {flow.map((f) => (
            <li key={f.n}>
              <span>{f.n}</span>
              <div>
                <strong>{t(f.th, f.en)}</strong>
                <p>{t(f.thD, f.enD)}</p>
              </div>
            </li>
          ))}
        </ol>

        <h3 className="dawguide-h">{t("มีอะไรให้ใช้บ้าง", "What you can do")}</h3>
        <div className="dawguide-grid">
          {CAPABILITIES.map((c) => (
            <article className="dawguide-card" key={c.en}>
              <span className="dawguide-glyph" aria-hidden="true">{c.glyph}</span>
              <h4>{t(c.th, c.en)}</h4>
              <p>{t(c.thDesc, c.enDesc)}</p>
            </article>
          ))}
        </div>

        <h3 className="dawguide-h">{t("คีย์ลัดที่ใช้บ่อย", "Shortcuts you will use")}</h3>
        <ul className="dawguide-keys">
          {KEYS.map((k) => (
            <li key={k.k}>
              <kbd>{k.k}</kbd>
              <span>{t(k.th, k.en)}</span>
            </li>
          ))}
        </ul>

        <div className="dawguide-cta">
          <p>{t("ไฟล์ในคลังและโปรเจกต์อยู่ในเบราว์เซอร์ของคุณ ปิดหน้าแล้วจะหายไป อย่าลืมส่งออก WAV เก็บไว้", "Your library and project live in the browser and disappear when you close the page, so export a WAV to keep your work.")}</p>
          <button type="button" className="daw-cta daw-cta-lg" onClick={onOpen}>
            <span className="daw-cta-bars" aria-hidden="true"><i /><i /><i /><i /></span>
            {t("เปิด Mini DAW", "Open the Mini DAW")}
            <span aria-hidden="true">↗</span>
          </button>
        </div>
      </div>
    </section>
  );
}

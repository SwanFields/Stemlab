import { useEffect, type CSSProperties, type RefObject } from "react";
import { useLanguage } from "./Language";

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const easeInOut = (v: number) => (v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2);

/**
 * One scroll engine for the whole landing page (no libraries).
 *
 *   data-plx-y="0.2"    vertical parallax: + = slower than the page (background), - = faster (foreground)
 *   data-plx-x="0.6"    horizontal drift linked to scroll
 *   data-plx-fade="1.4" fades out as the element's section scrolls away
 *   data-plx-rotx="14"  tilts back (deg) as the section scrolls away
 *   data-plx-mouse="12" follows the pointer by up to N px
 *   data-reveal         fades / rises in once when scrolled into view
 *   data-story          tall section; writes --p, --s0..--s3, --m, --scan and data-stage on it
 *   data-progress       thin page-progress bar
 *
 * The page's real scroll is untouched. Layers read an eased copy of scrollY, which is what
 * gives the soft, inertial feel; the loop sleeps whenever nothing is moving.
 */
export function useParallaxScene(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const cleanups: Array<() => void> = [];
    root.classList.add("plx-ready");
    cleanups.push(() => root.classList.remove("plx-ready", "plx-static"));

    const reveals = Array.from(root.querySelectorAll<HTMLElement>("[data-reveal]"));
    if (reduced || typeof IntersectionObserver === "undefined") {
      reveals.forEach((el) => el.classList.add("in"));
    } else {
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              entry.target.classList.add("in");
              io.unobserve(entry.target);
            }
          }
        },
        { threshold: 0.14, rootMargin: "0px 0px -6% 0px" },
      );
      reveals.forEach((el) => io.observe(el));
      cleanups.push(() => io.disconnect());
    }

    const story = root.querySelector<HTMLElement>("[data-story]");
    const progressBar = root.querySelector<HTMLElement>("[data-progress]");

    const setStory = (p: number) => {
      if (!story) return;
      story.style.setProperty("--p", p.toFixed(4));
      for (let i = 0; i < 4; i++) {
        story.style.setProperty(`--s${i}`, easeInOut(clamp((p - 0.16 - i * 0.045) / 0.42)).toFixed(4));
      }
      story.style.setProperty("--m", clamp((p - 0.74) / 0.2).toFixed(4));
      story.style.setProperty("--scan", clamp((p - 0.08) / 0.3).toFixed(4));
      story.style.setProperty("--scan-o", (p > 0.08 && p < 0.4 ? 1 : 0).toString());
      story.dataset.stage = String(p < 0.2 ? 0 : p < 0.45 ? 1 : p < 0.74 ? 2 : 3);
    };

    if (reduced) {
      root.classList.add("plx-static");
      setStory(1);
      return () => cleanups.forEach((fn) => fn());
    }

    const layers = Array.from(
      root.querySelectorAll<HTMLElement>(
        "[data-plx-y],[data-plx-x],[data-plx-fade],[data-plx-rotx],[data-plx-mouse]",
      ),
    );

    let target = window.scrollY;
    let cur = target;
    let vel = 0;
    let mx = 0;
    let my = 0;
    let tx = 0;
    let ty = 0;
    let raf = 0;
    let running = false;

    const frame = () => {
      const vh = window.innerHeight;
      const sy = window.scrollY;
      target = sy;
      const prev = cur;
      cur += (target - cur) * 0.11;
      if (Math.abs(target - cur) < 0.05) cur = target;
      vel += (clamp(Math.abs(cur - prev) / 38) - vel) * 0.14;
      mx += (tx - mx) * 0.06;
      my += (ty - my) * 0.06;
      root.style.setProperty("--vel", vel.toFixed(3));

      for (const el of layers) {
        const parent = el.parentElement;
        if (!parent) continue;
        const rect = parent.getBoundingClientRect();
        // position in the document of the parent's centre, compared with the *eased* scroll
        const off = (rect.top + sy + rect.height / 2 - cur - vh / 2) / vh;
        if (Math.abs(off) > 2.2) continue; // far off-screen: skip the work
        const d = el.dataset;
        const mouse = parseFloat(d.plxMouse ?? "0") || 0;
        const x = off * vh * (parseFloat(d.plxX ?? "0") || 0) + mx * mouse;
        const y = off * vh * (parseFloat(d.plxY ?? "0") || 0) + my * mouse;
        const rot = Math.max(0, -off) * (parseFloat(d.plxRotx ?? "0") || 0);
        el.style.transform =
          `${rot ? "perspective(1400px) " : ""}translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)` +
          (rot ? ` rotateX(${rot.toFixed(2)}deg)` : "");
        if (d.plxFade) el.style.opacity = clamp(1 - Math.max(0, -off) * parseFloat(d.plxFade)).toFixed(3);
      }

      if (story) {
        const rect = story.getBoundingClientRect();
        const total = rect.height - vh;
        if (total > 0) setStory(clamp((cur - (rect.top + sy)) / total));
      }
      if (progressBar) {
        const max = document.documentElement.scrollHeight - vh;
        progressBar.style.transform = `scaleX(${max > 0 ? clamp(cur / max).toFixed(4) : 0})`;
      }

      const moving = Math.abs(target - cur) > 0.05 || vel > 0.004 || Math.abs(tx - mx) > 0.002 || Math.abs(ty - my) > 0.002;
      if (moving) {
        raf = requestAnimationFrame(frame);
      } else {
        running = false;
      }
    };

    const wake = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(frame);
    };
    const onPointer = (event: PointerEvent) => {
      tx = (event.clientX / window.innerWidth - 0.5) * 2;
      ty = (event.clientY / window.innerHeight - 0.5) * 2;
      wake();
    };

    window.addEventListener("scroll", wake, { passive: true });
    window.addEventListener("resize", wake);
    root.addEventListener("pointermove", onPointer, { passive: true });
    wake();
    cleanups.push(() => {
      cancelAnimationFrame(raf);
      running = false;
      window.removeEventListener("scroll", wake);
      window.removeEventListener("resize", wake);
      root.removeEventListener("pointermove", onPointer);
      root.style.removeProperty("--vel");
      for (const el of layers) {
        el.style.transform = "";
        el.style.opacity = "";
      }
    });

    return () => cleanups.forEach((fn) => fn());
  }, [rootRef]);
}

/* ---------- hero backdrop: depth layers behind the headline ---------- */
const FLOOR_BARS = 72;

export function HeroBackdrop() {
  return (
    <div className="hero-backdrop" aria-hidden="true">
      <div className="hero-layer" data-plx-y="0.32" data-plx-mouse="10">
        <svg className="hero-rings" viewBox="0 0 800 800" fill="none">
          {[120, 200, 290, 380].map((r, i) => (
            <circle key={r} cx="400" cy="400" r={r} strokeDasharray={i % 2 ? "2 9" : "none"} />
          ))}
        </svg>
      </div>
      <div className="hero-layer" data-plx-y="0.18" data-plx-mouse="22"><span className="hero-orb orb-a" /></div>
      <div className="hero-layer" data-plx-y="0.42" data-plx-mouse="34"><span className="hero-orb orb-b" /></div>
      <div className="hero-layer" data-plx-y="-0.1" data-plx-mouse="-18"><span className="hero-orb orb-c" /></div>
      <div className="hero-floor">
        {Array.from({ length: FLOOR_BARS }, (_, i) => (
          <i
            key={i}
            style={{
              "--k": (0.5 + Math.abs(Math.sin(i * 0.61) * Math.cos(i * 0.23)) * 1.6).toFixed(2),
              "--d": `${(i % 9) * 0.17}s`,
            } as CSSProperties}
          />
        ))}
      </div>
    </div>
  );
}

/* ---------- giant words that slide sideways while you scroll ---------- */
export function StemMarquee() {
  const row = (words: string[]) => (
    <>
      {words.concat(words).map((w, i) => (
        <span key={i} className={i % 2 ? "outline" : ""}>{w}<em aria-hidden="true">✦</em></span>
      ))}
    </>
  );
  return (
    <section className="stem-marquee" aria-hidden="true">
      <div className="marquee-row" data-plx-x="0.55">{row(["VOCALS", "DRUMS", "BASS", "OTHER"])}</div>
      <div className="marquee-row" data-plx-x="-0.55">{row(["SEPARATE", "MIX", "EXPORT", "CREATE"])}</div>
    </section>
  );
}

/* ---------- pinned scroll story: one song splits into four stems ---------- */
const STEMS = [
  { key: "vocals", color: "#e08fa3", th: "เสียงร้อง", en: "Vocals", seed: 3 },
  { key: "drums", color: "#e0a15f", th: "กลอง", en: "Drums", seed: 11 },
  { key: "bass", color: "#6fa8dc", th: "เบส", en: "Bass", seed: 21 },
  { key: "other", color: "#a98fd9", th: "เสียงอื่น ๆ", en: "Other", seed: 31 },
] as const;

const BARS = 44;

function barHeights(seed: number): number[] {
  return Array.from({ length: BARS }, (_, i) => {
    const v = Math.abs(Math.sin(i * 0.43 + seed) * Math.cos(i * 0.17 + seed * 1.7));
    return 16 + Math.round(v * 84);
  });
}

export function StemStory({ onStart }: { onStart: () => void }) {
  const { t, language } = useLanguage();
  const caps = [
    { n: "01", title: t("ลากเพลงมาวาง", "Drop in a song"), body: t("เริ่มจากไฟล์เพลงเดียว MP3, WAV หรือ FLAC ทุกเสียงถูกมิกซ์รวมกันอยู่ในแทร็กเดียว", "Start with one file — MP3, WAV or FLAC. Every sound is mixed into a single track.") },
    { n: "02", title: t("AI ฟังทุกเลเยอร์", "AI listens to every layer"), body: t("โมเดล Demucs สแกนเพลงตลอดความยาว แยกแยะว่าแต่ละเสียงมาจากแหล่งไหน", "The Demucs model scans the whole song and works out which sound belongs to which source.") },
    { n: "03", title: t("แยกออกเป็น 4 สเต็ม", "Split into four stems"), body: t("เสียงร้อง กลอง เบส และเครื่องดนตรีอื่น ๆ แยกออกจากกันเป็นแทร็กอิสระ", "Vocals, drums, bass and everything else — each one an independent track.") },
    { n: "04", title: t("มิกซ์ ปรับ แล้วดาวน์โหลด", "Mix, shape, download"), body: t("ปรับความดัง ปิดเสียง หรือเปิดเฉพาะแทร็กเดียว แล้วส่งออกไปสร้างสรรค์ต่อ", "Balance levels, mute or solo, then export to keep creating.") },
  ];

  return (
    <section className="story" data-story data-stage="0" id="story" aria-label={t("เพลงหนึ่งเพลงแยกเป็นสี่สเต็มอย่างไร", "How one song becomes four stems")}>
      <div className="story-sticky">
        <div className="story-inner mx-auto grid max-w-6xl items-center gap-6 px-5 sm:px-8 md:grid-cols-[0.9fr_1.1fr]">
          <div className="story-text">
            <p className="eyebrow">{t("เลื่อนลงเพื่อดูการทำงาน", "Scroll to watch it work")}</p>
            <div className="story-caps">
              {caps.map((c, i) => (
                <div key={c.n} className={`story-cap cap-${i}`}>
                  <span className="story-num">{c.n}</span>
                  <h2>{c.title}</h2>
                  <p>{c.body}</p>
                  {i === 3 && (
                    <button className="button button-small story-cta" onClick={onStart}>
                      {t("ลองแยกเพลงของคุณ", "Try your own song")} <span aria-hidden="true">↗</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="story-dots" aria-hidden="true">
              {caps.map((c, i) => <span key={c.n} className={`dot-${i}`} />)}
            </div>
          </div>

          <div className="story-scene" aria-hidden="true">
            <div className="story-stack">
              {STEMS.map((s, i) => (
                <div
                  key={s.key}
                  className="story-slab"
                  style={{ "--i": i, "--c": s.color, "--s": `var(--s${i})` } as CSSProperties}
                >
                  <div className="slab-bars">
                    {barHeights(s.seed).map((h, b) => (
                      <b key={b} style={{ height: `${h}%`, "--b": b } as CSSProperties} />
                    ))}
                  </div>
                  <span className="slab-merge" />
                  <span className="slab-play" />
                  <span className="slab-label">{language === "th" ? s.th : s.en}</span>
                  <span className="slab-level"><i /></span>
                </div>
              ))}
              <span className="story-scan" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

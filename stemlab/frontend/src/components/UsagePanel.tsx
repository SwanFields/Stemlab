import { useMemo, useState } from "react";
import type { MonthlyStat, StemName, Stats } from "../api";
import { useLanguage } from "./Language";

export const STEM_ORDER: StemName[] = ["vocals", "drums", "bass", "other"];

export const STEM_LABEL: Record<StemName, { th: string; en: string }> = {
  vocals: { th: "เสียงร้อง", en: "Vocals" },
  drums: { th: "กลอง", en: "Drums" },
  bass: { th: "เบส", en: "Bass" },
  other: { th: "เครื่องดนตรีอื่นๆ", en: "Other" },
};

const STEM_COLOR: Record<StemName, string> = {
  vocals: "var(--stem-vocals)",
  drums: "var(--stem-drums)",
  bass: "var(--stem-bass)",
  other: "var(--stem-other)",
};

type Metric = "minutes" | "songs";

function formatMinutes(minutes: number, t: (th: string, en: string) => string): string {
  if (minutes < 1) return `${Math.round(minutes * 60)} ${t("วินาที", "sec")}`;
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return `${h} ${t("ชม.", "h")} ${m} ${t("นาที", "min")}`;
  }
  return `${minutes.toFixed(1).replace(/\.0$/, "")} ${t("นาที", "min")}`;
}

interface Props {
  stats: Stats | null;
  loading: boolean;
  error: string | null;
}

export default function UsagePanel({ stats, loading, error }: Props) {
  const { t, language } = useLanguage();
  const [metric, setMetric] = useState<Metric>("minutes");
  const [selected, setSelected] = useState<string | null>(null); // YYYY-MM, null = all time

  const locale = language === "th" ? "th-TH" : "en-US";
  const monthLabel = (key: string, long = false) => {
    const [y, m] = key.split("-").map(Number);
    return new Intl.DateTimeFormat(locale, {
      month: long ? "long" : "short",
      year: long ? "numeric" : "2-digit",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(y, m - 1, 1)));
  };

  // The chart shows the latest 12 months; older ones stay in the totals.
  const visibleMonths = useMemo<MonthlyStat[]>(() => (stats ? stats.months.slice(-12) : []), [stats]);

  if (loading && !stats) {
    return <section className="usage-card mt-8"><p className="text-sm text-neutral-400" aria-live="polite">{t("กำลังโหลดสถิติการใช้งาน...", "Loading usage statistics...")}</p></section>;
  }
  if (error || !stats) {
    return <section className="usage-card mt-8"><p className="auth-error" role="alert">{error ?? t("โหลดสถิติไม่สำเร็จ", "Could not load statistics.")}</p></section>;
  }

  const activeMonth = selected ? stats.months.find((m) => m.month === selected) ?? null : null;
  const stemCounts: Record<StemName, number> = activeMonth ? activeMonth.stems : stats.stem_totals;
  const stemTotal = STEM_ORDER.reduce((sum, k) => sum + stemCounts[k], 0);
  const topStem = stemTotal > 0 ? STEM_ORDER.reduce((a, b) => (stemCounts[b] > stemCounts[a] ? b : a)) : null;

  const values = visibleMonths.map((m) => (metric === "minutes" ? m.minutes : m.songs));
  const max = metric === "songs" ? Math.max(2, Math.ceil(Math.max(...values) / 2) * 2) : Math.max(1, Math.ceil(Math.max(...values)));
  const hasAnyUsage = stats.total_songs > 0 || stats.total_stem_downloads > 0;

  const tiles = [
    { label: t("เวลาเพลงที่อัปโหลดทั้งหมด", "Total audio uploaded"), value: formatMinutes(stats.total_minutes, t), note: t("นับเฉพาะงานที่แยกสำเร็จ", "Completed separations only") },
    { label: t("เพลงที่แยกแล้ว", "Songs separated"), value: String(stats.total_songs), note: t("ตั้งแต่เริ่มเปิดบัญชี", "Since you joined") },
    {
      label: t("สเต็มที่ใช้บ่อยที่สุด", "Most used stem"),
      value: stats.top_stem ? (language === "th" ? STEM_LABEL[stats.top_stem].th : STEM_LABEL[stats.top_stem].en) : "—",
      note: stats.top_stem ? `${stats.stem_totals[stats.top_stem]} ${t("ครั้งที่บันทึก", "saves")}` : t("ยังไม่มีการบันทึกสเต็ม", "No stems saved yet"),
    },
    {
      label: t("สมาชิกตั้งแต่", "Member since"),
      value: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(stats.member_since * 1000)),
      note: `${stats.months.length} ${t("เดือน", stats.months.length === 1 ? "month" : "months")}`,
    },
  ];

  const chartW = 640;
  const chartH = 220;
  const padL = 34;
  const padB = 26;
  const padT = 12;
  const slot = (chartW - padL) / Math.max(1, visibleMonths.length);
  const barW = Math.min(34, slot * 0.58);
  const plotH = chartH - padB - padT;
  const ticks = [0, 0.5, 1];

  return (
    <section className="usage-card mt-8" aria-labelledby="usage-title">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.16em] text-neutral-500">{t("สถิติการใช้งาน", "Usage analytics")}</p>
          <h2 id="usage-title" className="mt-2 text-xl font-medium text-white">{t("Audio Analytics & Processing Stats", "Audio Analytics & Processing Stats")}</h2>
        </div>
        <div className="usage-toggle" role="group" aria-label={t("เลือกตัวชี้วัดของกราฟ", "Choose chart metric")}>
          {(["minutes", "songs"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={metric === m} className={metric === m ? "active" : ""} onClick={() => setMetric(m)}>
              {m === "minutes" ? t("นาที", "Minutes") : t("จำนวนเพลง", "Songs")}
            </button>
          ))}
        </div>
      </div>

      <div className="usage-tiles mt-6">
        {tiles.map((tile) => (
          <div key={tile.label} className="usage-tile">
            <p className="usage-tile-label">{tile.label}</p>
            <p className="usage-tile-value">{tile.value}</p>
            <p className="usage-tile-note">{tile.note}</p>
          </div>
        ))}
      </div>

      {!hasAnyUsage && (
        <p className="usage-empty mt-6">{t("ยังไม่มีข้อมูล — แยกเพลงแรกของคุณแล้วสถิติจะปรากฏที่นี่", "Nothing yet — separate your first song and your stats will appear here.")}</p>
      )}

      <div className="usage-grid mt-8">
        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="usage-subtitle">{metric === "minutes" ? t("นาทีที่อัปโหลดรายเดือน", "Minutes uploaded per month") : t("เพลงที่แยกรายเดือน", "Songs separated per month")}</h3>
            {selected && <button type="button" className="usage-link" onClick={() => setSelected(null)}>{t("ดูทั้งหมด", "Show all time")}</button>}
          </div>
          <div className="usage-chart-wrap mt-3">
            <svg viewBox={`0 0 ${chartW} ${chartH}`} className="usage-chart" role="img" aria-label={t("กราฟแท่งการใช้งานรายเดือน", "Monthly usage bar chart")}>
              {ticks.map((f) => {
                const y = padT + plotH * (1 - f);
                return (
                  <g key={f}>
                    <line x1={padL} x2={chartW} y1={y} y2={y} className="usage-grid-line" />
                    <text x={padL - 8} y={y + 3.5} textAnchor="end" className="usage-axis">{Math.round(max * f * 10) / 10}</text>
                  </g>
                );
              })}
              {visibleMonths.map((m, i) => {
                const v = values[i];
                const h = Math.max(v > 0 ? 3 : 0, (v / max) * plotH);
                const x = padL + slot * i + (slot - barW) / 2;
                const y = padT + plotH - h;
                const isSel = selected === m.month;
                return (
                  <g key={m.month}>
                    <rect
                      x={x}
                      y={y}
                      width={barW}
                      height={h}
                      rx={2}
                      className={`usage-bar ${isSel ? "selected" : ""} ${selected && !isSel ? "dim" : ""}`}
                    />
                    <rect
                      x={padL + slot * i}
                      y={padT}
                      width={slot}
                      height={plotH + padB}
                      fill="transparent"
                      className="usage-hit"
                      tabIndex={0}
                      role="button"
                      aria-pressed={isSel}
                      aria-label={`${monthLabel(m.month, true)}: ${formatMinutes(m.minutes, t)}, ${m.songs} ${t("เพลง", "songs")}`}
                      onClick={() => setSelected(isSel ? null : m.month)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(isSel ? null : m.month); } }}
                    >
                      <title>{`${monthLabel(m.month, true)} · ${formatMinutes(m.minutes, t)} · ${m.songs} ${t("เพลง", "songs")}`}</title>
                    </rect>
                    <text x={x + barW / 2} y={chartH - 8} textAnchor="middle" className={`usage-axis ${isSel ? "selected" : ""}`}>{monthLabel(m.month)}</text>
                  </g>
                );
              })}
            </svg>
          </div>
          <p className="usage-note mt-2">
            {activeMonth
              ? `${monthLabel(activeMonth.month, true)}: ${formatMinutes(activeMonth.minutes, t)} · ${activeMonth.songs} ${t("เพลง", "songs")}`
              : t("คลิกที่แท่งเพื่อดูรายละเอียดของเดือนนั้น", "Select a bar to see that month in detail.")}
            {stats.months.length > 12 && ` · ${t("แสดง 12 เดือนล่าสุด", "Showing the last 12 months")}`}
          </p>
        </div>

        <div className="min-w-0">
          <h3 className="usage-subtitle">
            {t("สเต็มที่ถูกบันทึกบ่อยที่สุด", "Most saved stems")} · {activeMonth ? monthLabel(activeMonth.month, true) : t("ทั้งหมด", "All time")}
          </h3>
          <ul className="usage-stems mt-4">
            {STEM_ORDER.map((stem) => {
              const count = stemCounts[stem];
              const pct = stemTotal > 0 ? (count / stemTotal) * 100 : 0;
              return (
                <li key={stem} className={topStem === stem ? "top" : ""}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="text-neutral-200">{language === "th" ? STEM_LABEL[stem].th : STEM_LABEL[stem].en}</span>
                    <span className="text-neutral-400">{count} <span className="text-neutral-600">({Math.round(pct)}%)</span></span>
                  </div>
                  <div className="usage-stem-track" role="presentation"><span style={{ width: `${pct}%`, background: STEM_COLOR[stem] }} /></div>
                </li>
              );
            })}
          </ul>
          <p className="usage-note mt-4">
            {t(
              "Stemlab แยกครบทั้ง 4 สเต็มทุกครั้ง จึงนับจากสเต็มที่คุณกดบันทึกหรือดาวน์โหลดแทน",
              "Every song is split into all 4 stems, so this counts the stems you save or download.",
            )}
          </p>
        </div>
      </div>
    </section>
  );
}

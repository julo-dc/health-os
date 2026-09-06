"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fmtDay, fmtDayLong } from "@/lib/format";

export type Pt = { date: string; value: number };
export type Band = { date: string; p10: number; p25: number; p50: number; p75: number; p90: number };

/** Measure the container so charts are responsive without distorting stroke widths. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    setW(ref.current.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const fmtDate = (iso: string, long = false) => (long ? fmtDayLong(iso) : fmtDay(iso));

export function fmtNum(v: number | null | undefined, precision = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (a >= 10_000) return (v / 1000).toFixed(1) + "k";
  // Grouped by hand: toLocaleString picks a separator from the runtime locale,
  // which differs between the Node server and the browser and breaks hydration.
  if (a >= 1000) return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return v.toFixed(precision);
}

/** Like fmtNum but drops trailing zeros — for targets and baselines, where
 *  "67kg" reads better than the "67.00kg" that full precision would give. */
export function fmtTrim(v: number | null | undefined, maxPrecision = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 10_000) return fmtNum(v, 1);
  return String(Number(v.toFixed(maxPrecision)));
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) out.push(Number(t.toFixed(10)));
  return out;
}

/* ── Line chart with optional forecast cone and crosshair tooltip ─────────── */

export type Series = { key: string; label: string; points: Pt[]; color: string; dashed?: boolean; width?: number };

export function LineChart({
  series, bands, height = 240, targetLine, unit, precision = 1, markers, yZero = false, emptyLabel = "No data yet",
}: {
  series: Series[];
  bands?: Band[];
  height?: number;
  targetLine?: { value: number; label: string } | null;
  unit?: string | null;
  precision?: number;
  markers?: { date: string; label: string; tone?: string }[];
  yZero?: boolean;
  emptyLabel?: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ x: number; date: string } | null>(null);

  const pad = { t: 12, r: 12, b: 24, l: 46 };
  const iw = Math.max(10, w - pad.l - pad.r);
  const ih = height - pad.t - pad.b;

  const model = useMemo(() => {
    const allDates = new Set<string>();
    for (const s of series) for (const p of s.points) allDates.add(p.date);
    if (bands) for (const b of bands) allDates.add(b.date);
    const dates = [...allDates].sort();
    if (!dates.length) return null;

    const t0 = Date.parse(dates[0]);
    const t1 = Date.parse(dates[dates.length - 1]);
    const span = Math.max(1, t1 - t0);
    const X = (iso: string) => ((Date.parse(iso) - t0) / span) * iw;

    const vals: number[] = [];
    for (const s of series) for (const p of s.points) if (Number.isFinite(p.value)) vals.push(p.value);
    if (bands) for (const b of bands) vals.push(b.p10, b.p90);
    if (targetLine) vals.push(targetLine.value);
    if (!vals.length) return null;

    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (yZero) lo = Math.min(0, lo);
    const margin = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1;
    lo -= margin; hi += margin;
    const Y = (v: number) => ih - ((v - lo) / (hi - lo)) * ih;

    return { dates, X, Y, lo, hi, t0, span };
  }, [series, bands, iw, ih, targetLine, yZero]);

  if (!w) return <div ref={ref} style={{ height }} />;
  if (!model) return (
    <div ref={ref} style={{ height }} className="flex items-center justify-center text-sm" >
      <span style={{ color: "var(--text-muted)" }}>{emptyLabel}</span>
    </div>
  );

  const { X, Y, lo, hi, t0, span } = model;
  const ticks = niceTicks(lo, hi, 4);

  const path = (pts: Pt[]) =>
    pts.filter((p) => Number.isFinite(p.value))
      .map((p, i) => `${i ? "L" : "M"}${X(p.date).toFixed(2)},${Y(p.value).toFixed(2)}`).join(" ");

  const area = (bs: Band[], a: keyof Band, b: keyof Band) => {
    if (!bs.length) return "";
    const up = bs.map((d) => `${X(d.date).toFixed(2)},${Y(d[a] as number).toFixed(2)}`);
    const down = [...bs].reverse().map((d) => `${X(d.date).toFixed(2)},${Y(d[b] as number).toFixed(2)}`);
    return `M${up.join("L")}L${down.join("L")}Z`;
  };

  // Nearest date to the pointer, for the crosshair
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = t0 + (x / iw) * span;
    let best = model.dates[0], bd = Infinity;
    for (const d of model.dates) {
      const dist = Math.abs(Date.parse(d) - t);
      if (dist < bd) { bd = dist; best = d; }
    }
    setHover({ x: X(best), date: best });
  };

  const hoverVals = hover
    ? series.map((s) => ({ s, p: s.points.find((p) => p.date === hover.date) }))
        .filter((h): h is { s: Series; p: Pt } => Boolean(h.p))
    : [];
  const hoverBand = hover && bands ? bands.find((b) => b.date === hover.date) : null;

  return (
    <div ref={ref} className="relative" style={{ height }}>
      <svg width={w} height={height} role="img" aria-label={series.map((s) => s.label).join(", ")}>
        <g transform={`translate(${pad.l},${pad.t})`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={0} x2={iw} y1={Y(t)} y2={Y(t)} stroke="var(--gridline)" strokeWidth={1} />
              <text x={-8} y={Y(t)} dy="0.32em" textAnchor="end" fontSize={10}
                    fill="var(--text-muted)" className="num">{fmtNum(t, precision)}</text>
            </g>
          ))}

          {/* Forecast cone: 80% outer, 50% inner. Same hue, stacked opacity. */}
          {bands?.length ? (
            <>
              <path d={area(bands, "p90", "p10")} fill="var(--series-1)" opacity={0.10} />
              <path d={area(bands, "p75", "p25")} fill="var(--series-1)" opacity={0.16} />
              <path d={path(bands.map((b) => ({ date: b.date, value: b.p50 })))}
                    fill="none" stroke="var(--series-1)" strokeWidth={2}
                    strokeDasharray="5 4" strokeLinecap="round" opacity={0.85} />
            </>
          ) : null}

          {targetLine ? (
            <>
              <line x1={0} x2={iw} y1={Y(targetLine.value)} y2={Y(targetLine.value)}
                    stroke="var(--status-good)" strokeWidth={2} strokeDasharray="2 4" opacity={0.9} />
              {/* Anchored left: the right edge is where the forecast cone lands. */}
              <text x={2} y={Y(targetLine.value) - 6} textAnchor="start" fontSize={10}
                    fill="var(--status-good)" fontWeight={600}>{targetLine.label}</text>
            </>
          ) : null}

          {markers?.map((m) => (
            <line key={m.date + m.label} x1={X(m.date)} x2={X(m.date)} y1={0} y2={ih}
                  stroke="var(--text-muted)" strokeWidth={1} strokeDasharray="2 3" opacity={0.7} />
          ))}

          {series.map((s) => (
            <path key={s.key} d={path(s.points)} fill="none" stroke={s.color}
                  strokeWidth={s.width ?? 2} strokeLinecap="round" strokeLinejoin="round"
                  strokeDasharray={s.dashed ? "4 4" : undefined} />
          ))}

          {hover ? (
            <>
              <line x1={hover.x} x2={hover.x} y1={0} y2={ih} stroke="var(--axis)" strokeWidth={1} />
              {hoverVals.map(({ s, p }) => (
                <circle key={s.key} cx={hover.x} cy={Y(p.value)} r={4.5} fill={s.color}
                        stroke="var(--surface-1)" strokeWidth={2} />
              ))}
            </>
          ) : null}

          <line x1={0} x2={iw} y1={ih} y2={ih} stroke="var(--axis)" strokeWidth={1} />
          <text x={0} y={ih + 16} fontSize={10} fill="var(--text-muted)">{fmtDate(model.dates[0])}</text>
          <text x={iw} y={ih + 16} fontSize={10} fill="var(--text-muted)" textAnchor="end">
            {fmtDate(model.dates[model.dates.length - 1])}
          </text>

          <rect x={0} y={0} width={iw} height={ih} fill="transparent"
                onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </g>
      </svg>

      {hover && (hoverVals.length || hoverBand) ? (
        <div className="pointer-events-none absolute z-10 rounded-lg px-3 py-2 text-xs"
             style={{
               left: Math.min(Math.max(hover.x + pad.l - 60, 4), w - 150),
               top: 4, background: "var(--surface-2)",
               border: "1px solid var(--border-strong)", boxShadow: "var(--shadow)", minWidth: 130,
             }}>
          <div className="mb-1 font-medium" style={{ color: "var(--text-secondary)" }}>{fmtDate(hover.date, true)}</div>
          {hoverVals.map(({ s, p }) => (
            <div key={s.key} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5" style={{ color: "var(--text-secondary)" }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />{s.label}
              </span>
              <span className="num font-semibold">{fmtNum(p.value, precision)}{unit}</span>
            </div>
          ))}
          {hoverBand ? (
            <div className="mt-1 num" style={{ color: "var(--text-muted)" }}>
              forecast {fmtNum(hoverBand.p50, precision)} · 80% {fmtNum(hoverBand.p10, precision)}–{fmtNum(hoverBand.p90, precision)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Legend — always present for 2+ series, so identity is never colour-alone. */
export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  if (items.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span style={{
            width: 12, height: i.dashed ? 0 : 3, borderRadius: 2,
            background: i.dashed ? undefined : i.color,
            borderTop: i.dashed ? `2px dashed ${i.color}` : undefined,
          }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/* ── Sparkline ───────────────────────────────────────────────────────────── */

export function Sparkline({ points, color = "var(--series-1)", height = 34, width = 100 }: {
  points: Pt[]; color?: string; height?: number; width?: number;
}) {
  if (points.length < 2) return <div style={{ height, width }} />;
  const vals = points.map((p) => p.value).filter(Number.isFinite);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const d = points.map((p, i) =>
    `${i ? "L" : "M"}${((i / (points.length - 1)) * width).toFixed(1)},${(height - 3 - ((p.value - lo) / span) * (height - 6)).toFixed(1)}`
  ).join(" ");
  const lastY = height - 3 - ((points[points.length - 1].value - lo) / span) * (height - 6);
  return (
    <svg width={width} height={height} aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" opacity={0.9} />
      <circle cx={width} cy={lastY} r={2.5} fill={color} />
    </svg>
  );
}

/* ── Bars ────────────────────────────────────────────────────────────────── */

export function BarChart({ data, height = 200, unit, precision = 1, colorFor }: {
  data: { label: string; value: number; tone?: string }[];
  height?: number; unit?: string | null; precision?: number;
  colorFor?: (d: { label: string; value: number }) => string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length) return <div style={{ height }} />;

  const pad = { t: 8, r: 8, b: 26, l: 44 };
  const iw = Math.max(10, w - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const vals = data.map((d) => d.value);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const Y = (v: number) => ih - ((v - lo) / span) * ih;
  const bw = Math.max(2, (iw / data.length) - 2); // 2px surface gap between bars
  const ticks = niceTicks(lo, hi, 3);

  return (
    <div ref={ref} className="relative" style={{ height }}>
      {w ? (
        <svg width={w} height={height}>
          <g transform={`translate(${pad.l},${pad.t})`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={0} x2={iw} y1={Y(t)} y2={Y(t)} stroke="var(--gridline)" strokeWidth={1} />
                <text x={-8} y={Y(t)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--text-muted)" className="num">
                  {fmtNum(t, precision)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const x = (i / data.length) * iw + 1;
              const y = Math.min(Y(d.value), Y(0));
              const h = Math.max(1, Math.abs(Y(d.value) - Y(0)));
              return (
                <rect key={d.label + i} x={x} y={y} width={bw} height={h} rx={3}
                      fill={d.tone ?? colorFor?.(d) ?? "var(--series-1)"}
                      opacity={hover === null || hover === i ? 1 : 0.45}
                      onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
              );
            })}
            <line x1={0} x2={iw} y1={Y(0)} y2={Y(0)} stroke="var(--axis)" strokeWidth={1} />
            {data.map((d, i) =>
              data.length <= 14 || i % Math.ceil(data.length / 10) === 0 ? (
                <text key={"l" + i} x={(i / data.length) * iw + bw / 2 + 1} y={ih + 15}
                      fontSize={9.5} fill="var(--text-muted)" textAnchor="middle">{d.label}</text>
              ) : null
            )}
          </g>
        </svg>
      ) : null}
      {hover !== null ? (
        <div className="pointer-events-none absolute top-0 rounded-lg px-2.5 py-1.5 text-xs num"
             style={{
               left: Math.min((hover / data.length) * iw + pad.l, w - 110),
               background: "var(--surface-2)", border: "1px solid var(--border-strong)", boxShadow: "var(--shadow)",
             }}>
          <span style={{ color: "var(--text-secondary)" }}>{data[hover].label}</span>{" "}
          <b>{fmtNum(data[hover].value, precision)}{unit}</b>
        </div>
      ) : null}
    </div>
  );
}

/* ── Progress meter ──────────────────────────────────────────────────────── */

export function ProgressBar({ value, expected, tone = "var(--series-1)", height = 8 }: {
  value: number; expected?: number | null; tone?: string; height?: number;
}) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="relative w-full rounded-full" style={{ height, background: "var(--gridline)" }}>
      <div className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
           style={{ width: `${v * 100}%`, background: tone }} />
      {expected !== null && expected !== undefined ? (
        <div className="absolute inset-y-[-3px] w-[2px] rounded"
             style={{ left: `${Math.min(100, Math.max(0, expected * 100))}%`, background: "var(--text-primary)", opacity: .55 }}
             title={`Expected pace: ${Math.round(expected * 100)}%`} />
      ) : null}
    </div>
  );
}

/* ── Radial score ────────────────────────────────────────────────────────── */

export function RadialScore({ value, max = 100, size = 132, label, sublabel, tone = "var(--series-1)", precision = 0 }: {
  value: number | null; max?: number; size?: number; label?: string; sublabel?: string; tone?: string; precision?: number;
}) {
  const r = size / 2 - 9;
  const c = 2 * Math.PI * r;
  const frac = value === null ? 0 : Math.max(0, Math.min(1, value / max));
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--gridline)" strokeWidth={9} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth={9}
                strokeLinecap="round" strokeDasharray={c}
                strokeDashoffset={c * (1 - frac)}
                style={{ transition: "stroke-dashoffset .7s cubic-bezier(.2,.7,.3,1)" }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="num text-3xl font-semibold leading-none">
          {value === null ? "—" : fmtNum(value, precision)}
        </span>
        {label ? <span className="label mt-1.5">{label}</span> : null}
        {sublabel ? <span className="mt-0.5 text-[11px]" style={{ color: "var(--text-muted)" }}>{sublabel}</span> : null}
      </div>
    </div>
  );
}

/* ── Calendar heatmap ────────────────────────────────────────────────────── */

export function Heatmap({ points, weeks = 26, hue = "var(--series-1)", unit, precision = 1 }: {
  points: Pt[]; weeks?: number; hue?: string; unit?: string | null; precision?: number;
}) {
  const [hover, setHover] = useState<Pt | null>(null);
  const map = new Map(points.map((p) => [p.date, p.value]));
  const vals = points.map((p) => p.value).filter(Number.isFinite);
  if (!vals.length) return <div className="text-sm" style={{ color: "var(--text-muted)" }}>No data yet</div>;
  const lo = Math.min(...vals), hi = Math.max(...vals);

  const today = new Date();
  const end = new Date(today);
  end.setDate(end.getDate() - end.getDay() + 6);
  const cells: { date: string; v: number | undefined }[][] = [];
  for (let wk = weeks - 1; wk >= 0; wk--) {
    const col: { date: string; v: number | undefined }[] = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(end);
      day.setDate(end.getDate() - wk * 7 - (6 - d));
      const iso = day.toISOString().slice(0, 10);
      col.push({ date: iso, v: map.get(iso) });
    }
    cells.push(col);
  }

  return (
    <div className="relative">
      <div className="flex gap-[3px] overflow-x-auto pb-1">
        {cells.map((col, i) => (
          <div key={i} className="flex flex-col gap-[3px]">
            {col.map((cell) => {
              const t = cell.v === undefined ? null : (cell.v - lo) / (hi - lo || 1);
              return (
                <div key={cell.date}
                     onMouseEnter={() => cell.v !== undefined && setHover({ date: cell.date, value: cell.v })}
                     onMouseLeave={() => setHover(null)}
                     className="h-[11px] w-[11px] rounded-[2.5px] transition-transform hover:scale-125"
                     style={{
                       background: t === null ? "var(--gridline)" : hue,
                       opacity: t === null ? 0.45 : 0.25 + t * 0.75,
                     }}
                     title={cell.v !== undefined ? `${cell.date}: ${fmtNum(cell.v, precision)}` : cell.date} />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px]" style={{ color: "var(--text-muted)" }}>
        <span>{weeks} weeks</span>
        <span className="num">
          {hover ? `${fmtDate(hover.date, true)}: ${fmtNum(hover.value, precision)}${unit ?? ""}` :
            `${fmtNum(lo, precision)} – ${fmtNum(hi, precision)}${unit ?? ""}`}
        </span>
      </div>
    </div>
  );
}

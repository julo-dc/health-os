"use client";
import { useEffect, useState } from "react";
import type { MetricDef } from "@/lib/metric-meta";
import { CATEGORY_LABELS } from "@/lib/metric-meta";
import { LineChart, BarChart, Heatmap, Legend, fmtNum } from "@/components/charts";
import { Section, Empty, Spinner, StatusPill } from "@/components/ui";
import { Explain, Term } from "@/components/explain";
import { SEMANTICS } from "@/lib/semantics";

export function AnalyzeClient({ metrics, counts, initial }: {
  metrics: MetricDef[]; counts: Record<string, number>; initial: string | null;
}) {
  const [metric, setMetric] = useState(initial ?? "");
  const [against, setAgainst] = useState("");
  const [days, setDays] = useState(180);
  const [horizon, setHorizon] = useState(60);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!metric) return;
    setLoading(true);
    const q = new URLSearchParams({ metric, days: String(days), horizon: String(horizon) });
    if (against) q.set("against", against);
    fetch(`/api/analyze?${q}`).then((r) => r.json()).then(setData).finally(() => setLoading(false));
  }, [metric, against, days, horizon]);

  const def = metrics.find((m) => m.key === metric);
  const dp = def?.precision ?? 1;
  const grouped = metrics.reduce((a, m) => { (a[m.category] ||= []).push(m); return a; }, {} as Record<string, MetricDef[]>);

  if (!metrics.length) {
    return <Empty>No metrics with data yet. Sync or import something first.</Empty>;
  }

  const gridPoints = (arr: (number | null)[] | undefined) =>
    !arr || !data?.grid ? [] : data.grid.dates.map((d: string, i: number) => ({ date: d, value: arr[i] }))
      .filter((p: any) => p.value !== null);

  return (
    <div className="space-y-5 rise">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Analyze</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
          Trend tests, change points, forecasts, correlations.
        </p>
      </div>

      {/* Filters in one row above the charts */}
      <div className="card-tight flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="label mb-1 block">Metric</span>
          <select className="input w-auto min-w-[190px]" value={metric} onChange={(e) => setMetric(e.target.value)}>
            {Object.entries(grouped).map(([cat, items]) => (
              <optgroup key={cat} label={CATEGORY_LABELS[cat] ?? cat}>
                {items.map((m) => <option key={m.key} value={m.key}>{m.label} ({counts[m.key]})</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="label mb-1 block">Compare against</span>
          <select className="input w-auto min-w-[170px]" value={against} onChange={(e) => setAgainst(e.target.value)}>
            <option value="">— none —</option>
            {metrics.filter((m) => m.key !== metric).map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </label>
        <label className="text-xs">
          <span className="label mb-1 block">Window</span>
          <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[30, 90, 180, 365, 730].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
        </label>
        <label className="text-xs">
          <span className="label mb-1 block">Forecast</span>
          <select className="input w-auto" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
            {[0, 30, 60, 90, 180].map((d) => <option key={d} value={d}>{d ? `${d} days` : "off"}</option>)}
          </select>
        </label>
        {loading ? <span className="ml-auto flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}><Spinner /> Computing…</span> : null}
      </div>

      {data?.sparse ? <Empty>Only {data.points?.length ?? 0} readings — not enough to analyse.</Empty> : data ? (
        <>
          <Section
            title={<span className="flex items-center gap-1.5"><Explain metric={metric}>{data.label}</Explain></span> as any}
            subtitle={SEMANTICS[metric]?.what ?? "Raw readings with 7-day and 28-day exponential smoothing, plus the forecast cone"}>
            <LineChart
              height={300} precision={dp} unit={data.unit}
              series={[
                { key: "raw", label: "Daily", points: data.points, color: "var(--axis)", width: 1.25 },
                { key: "s7", label: "7-day", points: gridPoints(data.grid?.smooth7), color: "var(--series-1)" },
                { key: "s28", label: "28-day", points: gridPoints(data.grid?.smooth28), color: "var(--series-2)" },
              ]}
              bands={data.forecast?.bands}
              markers={data.changePoints?.map((c: any) => ({ date: c.date, label: "shift" }))}
            />
            <div className="mt-3">
              <Legend items={[
                { label: "Daily", color: "var(--axis)" },
                { label: "7-day average", color: "var(--series-1)" },
                { label: "28-day average", color: "var(--series-2)" },
                ...(data.forecast ? [{ label: "Forecast", color: "var(--series-1)", dashed: true }] : []),
              ]} />
            </div>
          </Section>

          <div className="grid gap-5 lg:grid-cols-3">
            <Section title="Trend" subtitle="Mann-Kendall, autocorrelation-corrected">
              {SEMANTICS[metric]?.caveat ? (
                <p className="mb-3 rounded-lg px-2.5 py-2 text-[11px] bg-warning">
                  <b className="tone-warning">Careful. </b>
                  <span style={{ color: "var(--text-secondary)" }}>{SEMANTICS[metric].caveat}</span>
                </p>
              ) : null}
              {!data.trend ? <Empty>Not enough data.</Empty> : (
                <div className="space-y-3 text-sm">
                  <div className="flex items-center gap-2">
                    <StatusPill tone={data.trend.significant ? (data.trend.direction === "rising" ? "good" : "warning") : "neutral"}>
                      {data.trend.significant ? data.trend.direction : "no clear trend"}
                    </StatusPill>
                  </div>
                  <Row label={<Term term="trend">{`Rate (${days}d)`}</Term>} value={`${fmtNum(data.trend.senSlopePerDay * 7, 3)}${data.unit ?? ""}/wk`} />
                  {data.trend28 ? <Row label="Rate (28d)" value={`${fmtNum(data.trend28.senSlopePerDay * 7, 3)}${data.unit ?? ""}/wk`} /> : null}
                  <Row label={<Term term="significance">Significance</Term>} value={`p = ${data.trend.mkP.toFixed(3)}`} />
                  <Row label="Fit quality" value={`R² = ${data.trend.r2.toFixed(2)}`} />
                  <Row label="Change" value={data.trend.changePct !== null ? `${data.trend.changePct > 0 ? "+" : ""}${data.trend.changePct.toFixed(1)}%` : "—"} />
                  <Row label={<Term term="coverage">Coverage</Term>} value={`${Math.round((data.coverage?.ratio ?? 0) * 100)}% of days`} />
                </div>
              )}
            </Section>

            <Section title="Day of week" subtitle="Difference from your average">
              <BarChart height={180} precision={dp} unit={data.unit}
                        data={(data.weekday ?? []).filter((w: any) => w.delta !== null)
                          .map((w: any) => ({
                            label: w.day,
                            value: w.delta,
                            tone: !w.significant ? "var(--gridline)"
                              : w.delta >= 0 ? "var(--series-1)" : "var(--series-2)",
                          }))} />
              <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                Coloured bars are days that differ significantly from the rest (p&lt;0.05).
                {(data.weekday ?? []).some((w: any) => w.significant)
                  ? " Grey bars are within normal variation."
                  : " Nothing here clears the noise — no real weekday pattern."}
              </p>
            </Section>

            <Section title="Consistency" subtitle="Every day in the window">
              <Heatmap points={data.points} weeks={Math.min(30, Math.ceil(days / 7))} precision={dp} unit={data.unit} />
            </Section>
          </div>

          {data.comparison ? (
            <Section title={`${data.label} vs ${data.comparison.label}`}
                     subtitle="Rank correlation by lag. Lag 1 = yesterday against today.">
              <div className="grid gap-5 lg:grid-cols-2">
                <div>
                  <BarChart height={190}
                            data={(data.comparison.lags ?? []).map((l: any) => ({
                              label: `${l.lag}d`, value: l.r,
                              tone: l.p < 0.05 ? (l.r > 0 ? "var(--series-3)" : "var(--series-2)") : "var(--gridline)",
                            }))}
                            precision={2} />
                  <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                    Solid bars are statistically significant (p&lt;0.05); grey bars are noise.
                  </p>
                </div>
                <div className="space-y-3 text-sm">
                  {data.comparison.best ? (
                    <div className="rounded-lg p-3" style={{ background: "var(--surface-2)" }}>
                      <div className="label mb-1">Strongest relationship</div>
                      <p style={{ color: "var(--text-secondary)" }}>
                        <b style={{ color: "var(--text-primary)" }}>r = {data.comparison.best.r.toFixed(2)}</b> at a{" "}
                        {data.comparison.best.lag}-day lag, over {data.comparison.best.n} overlapping days
                        {data.comparison.best.p < 0.05 ? "" : " — not significant, treat as noise"}.
                      </p>
                    </div>
                  ) : null}
                  {data.comparison.split ? (
                    <div className="rounded-lg p-3" style={{ background: "var(--surface-2)" }}>
                      <div className="label mb-1">Split by behaviour</div>
                      <p style={{ color: "var(--text-secondary)" }}>
                        On days after <b>{data.comparison.label}</b> was above {fmtNum(data.comparison.split.threshold, 1)},
                        your {data.label.toLowerCase()} averaged{" "}
                        <b className="num" style={{ color: "var(--text-primary)" }}>{fmtNum(data.comparison.split.highMean, dp)}</b>{" "}
                        vs <b className="num" style={{ color: "var(--text-primary)" }}>{fmtNum(data.comparison.split.lowMean, dp)}</b> below
                        {data.comparison.split.deltaPct !== null ? ` — a ${Math.abs(data.comparison.split.deltaPct).toFixed(0)}% difference` : ""}.
                      </p>
                      <p className="mt-1.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
                        {data.comparison.split.nHigh} high days vs {data.comparison.split.nLow} low days. Association, not proof of cause.
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>
            </Section>
          ) : null}

          <div className="grid gap-5 lg:grid-cols-2">
            <Section title="Related metrics" subtitle="Strongest correlations, at best lag">
              {!data.related?.length ? <Empty>Nothing correlates significantly.</Empty> : (
                <ul className="space-y-2">
                  {data.related.map((r: any) => (
                    <li key={r.key}>
                      <button onClick={() => setAgainst(r.key)} className="flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors hover:brightness-110"
                              style={{ background: "var(--surface-2)" }}>
                        <span className="flex-1 truncate text-xs">{r.label}</span>
                        <span className="text-[11px] num" style={{ color: "var(--text-muted)" }}>{r.lag}d lag</span>
                        <span className="num text-xs font-semibold"
                              style={{ color: r.r > 0 ? "var(--series-3)" : "var(--series-2)" }}>
                          {r.r > 0 ? "+" : ""}{r.r.toFixed(2)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title={<span className="flex items-center gap-1.5"><Term term="change_point">Change points &amp; outliers</Term></span> as any}
                     subtitle="Level shifts and outliers">
              {!data.changePoints?.length && !data.anomalies?.length ? <Empty>Nothing detected.</Empty> : (
                <ul className="space-y-2 text-xs">
                  {data.changePoints?.map((c: any) => (
                    <li key={"c" + c.date} className="flex gap-3">
                      <span className="num shrink-0" style={{ color: "var(--text-muted)" }}>{c.date}</span>
                      <span style={{ color: "var(--text-secondary)" }}>
                        Level shifted <span className="num">{fmtNum(c.before, dp)}</span> → <span className="num">{fmtNum(c.after, dp)}</span>{" "}
                        <span style={{ color: "var(--text-muted)" }}>({Math.abs(c.effectSize).toFixed(1)}σ, p={c.pValue.toFixed(3)})</span>
                      </span>
                    </li>
                  ))}
                  {data.anomalies?.slice(-6).map((a: any) => (
                    <li key={"a" + a.date} className="flex gap-3">
                      <span className="num shrink-0" style={{ color: "var(--text-muted)" }}>{a.date}</span>
                      <span style={{ color: "var(--text-secondary)" }}>
                        Outlier {a.direction}: <span className="num">{fmtNum(a.value, dp)}</span>{" "}
                        <span style={{ color: "var(--text-muted)" }}>({Math.abs(a.z).toFixed(1)} SDs)</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        </>
      ) : loading ? (
        <div className="flex h-40 items-center justify-center" style={{ color: "var(--text-muted)" }}><Spinner size={22} /></div>
      ) : null}
    </div>
  );
}

function Row({ label, value, hint }: { label: React.ReactNode; value: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-3" title={hint}>
      <span className="flex items-center gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span className="num text-sm font-semibold">{value}</span>
    </div>
  );
}

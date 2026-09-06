"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Section, Empty, Spinner, StatusPill } from "@/components/ui";
import { fmtNum } from "@/components/charts";
import { SyncDiagnosisCard } from "@/components/dashboard";
import type { SyncDiagnosis } from "@/app/api/sync/route";

type Column = { header: string; suggested: string | null; numericRatio: number; dateRatio: number; sample: string[] };
type ColumnPlan = {
  header: string; metric: string | null; transform: string; scale?: number;
  confidence: "high" | "medium" | "low"; reasoning: string;
  isNew: boolean; newMetric?: { label: string; unit: string | null; category: string };
};
type Plan = {
  kind: "metrics" | "workouts" | "sets"; sourceGuess: string; summary: string;
  warnings: string[]; columns: ColumnPlan[]; classifiedBy: "llm" | "rules";
  fallbackReason?: string;
};
type Preview = {
  filename: string; headers: string[]; rowCount: number;
  plan: Plan; columns: Column[]; preview: string[][];
  metricOptions: { key: string; label: string; unit: string | null; category: string }[];
};

const TRANSFORM_LABELS: Record<string, string> = {
  none: "as-is", lb_to_kg: "lb → kg", st_to_kg: "stone → kg", g_to_kg: "g → kg",
  mi_to_km: "mi → km", m_to_km: "m → km", mm_to_km: "mm → km", ft_to_m: "ft → m",
  in_to_cm: "in → cm", s_to_min: "s → min", min_to_h: "min → h", h_to_min: "h → min",
  ms_to_s: "ms → s", fraction_to_pct: "0-1 → %", pct_to_fraction: "% → 0-1",
};
const WORKOUT_FIELDS = ["date","type","name","duration_min","distance_km","avg_hr","max_hr","calories","elevation_m","rpe"];
const SET_FIELDS = ["date","session_name","exercise","set_order","weight_kg","reps","rpe","distance_km","duration_s","session_min","notes"];
const KIND_LABEL: Record<string, string> = {
  metrics: "One row per day",
  workouts: "One row per workout",
  sets: "One row per set",
};

export type ConnectionHealth = {
  connected: boolean; hasRefresh: boolean;
  consentAgeDays: number | null; daysLeftIfTesting: number | null;
};

export function DataClient({ syncLog, coverage, workouts, connected, health }: {
  syncLog: { data_type: string; ok: boolean; rows: number; message: string | null; ran_at: string }[];
  coverage: { metric_key: string; n: number; first: string; last: string; sources: string[] }[];
  workouts: { n: number; first: string | null; last: string | null };
  connected: boolean;
  health: ConnectionHealth;
}) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [syncDays, setSyncDays] = useState(180);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncDiag, setSyncDiag] = useState<SyncDiagnosis | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [hint, setHint] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  const sync = async () => {
    setSyncing(true); setSyncMsg(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: syncDays }),
      });
      const j = await res.json();
      setSyncMsg(res.ok ? j.summary : j.error);
      setSyncDiag(res.ok ? j.diagnosis ?? null : null);
      if (res.ok) router.refresh();
    } catch (e) { setSyncMsg(e instanceof Error ? e.message : "Failed"); }
    finally { setSyncing(false); }
  };

  const doPreview = async (f: File) => {
    setErr(null); setResult(null); setFile(f); setReading(true); setPreview(null); setPlan(null);
    try {
      const fd = new FormData();
      fd.append("file", f);
      if (hint.trim()) fd.append("hint", hint.trim());
      const res = await fetch("/api/import/preview", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      setPreview(j);
      setPlan(j.plan);
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not read that file"); }
    finally { setReading(false); }
  };

  const updateCol = (header: string, patch: Partial<ColumnPlan>) =>
    setPlan((p) => p && { ...p, columns: p.columns.map((c) => (c.header === header ? { ...c, ...patch } : c)) });

  const commit = async () => {
    if (!file || !plan) return;
    setImporting(true); setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("plan", JSON.stringify(plan));
      const res = await fetch("/api/import/commit", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      setResult(j); setPreview(null); setPlan(null); setFile(null); setHint("");
      router.refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : "Import failed"); }
    finally { setImporting(false); }
  };

  const mapped = plan?.columns.filter((c) => c.metric).length ?? 0;
  const hasDate = plan?.columns.some((c) => c.metric === "date") ?? false;

  return (
    <div className="space-y-5 rise">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Data</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
          Sources, imports, and coverage.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Google Health" subtitle="Fitbit, via Google's cloud API">
          <div className="flex flex-wrap items-end gap-3">
            <StatusPill tone={connected ? "good" : "critical"}>{connected ? "Connected" : "Not connected"}</StatusPill>
            <label className="text-xs">
              <span className="label mb-1 block">History</span>
              <select className="input w-auto" value={syncDays} onChange={(e) => setSyncDays(Number(e.target.value))}>
                {[30, 90, 180].map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </label>
            {connected ? (
              <button onClick={sync} disabled={syncing} className="btn btn-primary">
                {syncing ? <><Spinner /> Syncing…</> : "Sync now"}
              </button>
            ) : (
              <a href="/api/auth/login" className="btn btn-primary">Reconnect Google</a>
            )}
          </div>
          {syncMsg ? <p className="mt-3 text-sm" style={{ color: "var(--text-secondary)" }}>{syncMsg}</p> : null}
          {syncDiag ? <div className="mt-3"><SyncDiagnosisCard diag={syncDiag} /></div> : null}

          {connected && health.daysLeftIfTesting !== null && health.daysLeftIfTesting < 8 ? (
            <div className={`mt-3 rounded-lg px-3 py-2.5 text-xs ${health.daysLeftIfTesting < 2 ? "bg-critical" : "bg-warning"}`}>
              <b className={health.daysLeftIfTesting < 2 ? "tone-critical" : "tone-warning"}>
                {health.daysLeftIfTesting < 0.5
                  ? "Google consent has likely expired."
                  : `Google consent expires in about ${Math.floor(health.daysLeftIfTesting)} day${Math.floor(health.daysLeftIfTesting) === 1 ? "" : "s"}.`}
              </b>
              <p className="mt-1" style={{ color: "var(--text-secondary)" }}>
                Google expires refresh tokens after 7 days while your OAuth consent screen is in
                <b> Testing</b> status. Either reconnect when it lapses, or switch the app to
                <b> In production</b> in the Google Auth Platform to stop the clock. Your data is unaffected either way.
              </p>
              <a href="/api/auth/login" className="btn mt-2 text-xs">Reconnect now</a>
            </div>
          ) : null}

          {syncLog.length ? (
            <div className="mt-4">
              <div className="label mb-2">Last result per data type</div>
              <div className="max-h-56 space-y-1 overflow-y-auto pr-1 text-xs">
                {syncLog.sort((a, b) => Number(b.ok) - Number(a.ok) || a.data_type.localeCompare(b.data_type)).map((s) => (
                  <div key={s.data_type} className="flex items-center gap-2">
                    <span aria-hidden style={{ color: s.ok ? "var(--status-good)" : "var(--status-critical)" }}>
                      {s.ok ? "✓" : "✕"}
                    </span>
                    <span className="w-44 shrink-0 truncate num">{s.data_type}</span>
                    <span style={{ color: "var(--text-muted)" }}>
                      {s.ok ? `${s.rows} rows` : (s.message ?? "failed").slice(0, 90)}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                A failed type usually means no data of that kind, or a scope not granted.
              </p>
            </div>
          ) : null}
        </Section>

        <Section title="Import a CSV"
                 subtitle="Anything with a date column">
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-[220px] flex-1 text-xs">
              <span className="label mb-1 block">What is this file? (optional)</span>
              <input className="input" value={hint} placeholder="e.g. my race times, exported from Garmin"
                     onChange={(e) => setHint(e.target.value)} />
            </label>
            <label className={`btn btn-primary ${reading ? "pointer-events-none opacity-50" : ""}`}>
              {reading ? <><Spinner /> Reading…</> : "Choose CSV"}
              <input type="file" accept=".csv,.tsv,.txt,text/csv" className="hidden" disabled={reading}
                     onChange={(e) => e.target.files?.[0] && doPreview(e.target.files[0])} />
            </label>
          </div>
          <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
            Columns, units and file type are detected first. You confirm before anything is stored.
          </p>
          {err ? <p className="mt-3 text-sm tone-critical">{err}</p> : null}
          {result ? (
            <div className="mt-3 rounded-lg px-3 py-2.5 text-sm bg-good">
              <b className="tone-good">Imported.</b>{" "}
              <span style={{ color: "var(--text-secondary)" }}>
                {result.kind === "workouts"
                  ? `${result.workouts} workouts.`
                  : result.kind === "sets"
                  ? `${result.sets} sets rolled into ${result.sessions} sessions.`
                  : `${result.written} readings across ${result.metrics?.length ?? 0} metrics${result.dateRange ? ` (${result.dateRange.from} → ${result.dateRange.to})` : ""}.`}
              </span>
            </div>
          ) : null}
        </Section>
      </div>

      {/* ── Review what the model made of the file ───────────────────── */}
      {preview && plan ? (
        <Section
          title={`Reading of "${preview.filename}"`}
          subtitle={`${preview.rowCount} rows · ${mapped} of ${preview.headers.length} columns mapped · ${
            plan.classifiedBy === "llm" ? `interpreted as ${plan.sourceGuess}` : "matched by header names"}`}
          action={
            <div className="flex gap-2">
              <button onClick={() => { setPreview(null); setPlan(null); setFile(null); }} className="btn btn-ghost text-xs">Cancel</button>
              <button onClick={commit} disabled={importing || !hasDate} className="btn btn-primary text-xs">
                {importing ? <><Spinner /> Importing…</> : `Import ${plan.kind === "sets" ? "sets" : plan.kind}`}
              </button>
            </div>
          }>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="chip" style={{ color: "var(--series-1)" }}>{KIND_LABEL[plan.kind]}</span>
            {plan.classifiedBy === "llm"
              ? <span className="chip" style={{ color: "var(--text-muted)" }}>read by {" "}{plan.sourceGuess}</span>
              : <span className="chip tone-warning">header matching only</span>}
          </div>

          {plan.summary ? (
            <p className="mb-3 text-sm" style={{ color: "var(--text-secondary)" }}>{plan.summary}</p>
          ) : null}

          {plan.fallbackReason ? (
            <div className="mb-4 rounded-lg px-3 py-2.5 text-xs bg-warning">
              <b className="tone-warning">The file wasn&apos;t interpreted by the model.</b>
              <p className="mt-1" style={{ color: "var(--text-secondary)" }}>{plan.fallbackReason}</p>
            </div>
          ) : null}

          {plan.warnings?.length ? (
            <div className="mb-4 rounded-lg px-3 py-2.5 text-xs bg-warning">
              <b className="tone-warning">Worth checking</b>
              <ul className="mt-1 space-y-0.5" style={{ color: "var(--text-secondary)" }}>
                {plan.warnings.map((w, i) => <li key={i}>· {w}</li>)}
              </ul>
            </div>
          ) : null}

          {!hasDate ? (
            <div className="mb-3 rounded-lg px-3 py-2 text-sm bg-critical tone-critical">
              No column is mapped to <b>date</b>. Pick one below before importing.
            </div>
          ) : null}

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ color: "var(--text-muted)" }}>
                  <th className="pb-2 pr-4 text-left font-medium">Column</th>
                  <th className="pb-2 pr-4 text-left font-medium">Sample</th>
                  <th className="pb-2 pr-4 text-left font-medium">Read as</th>
                  <th className="pb-2 pr-4 text-left font-medium">Units</th>
                  <th className="pb-2 text-left font-medium">Why</th>
                </tr>
              </thead>
              <tbody>
                {plan.columns.map((c) => {
                  const prof = preview.columns.find((p) => p.header === c.header);
                  const tone = !c.metric ? "neutral" : c.confidence === "high" ? "good" : c.confidence === "medium" ? "warning" : "critical";
                  return (
                    <tr key={c.header} style={{ borderTop: "1px solid var(--border)", opacity: c.metric ? 1 : 0.55 }}>
                      <td className="py-2 pr-4 align-top font-medium">
                        {c.header}
                        {c.isNew ? <span className="chip ml-1.5 text-[11px]" style={{ color: "var(--series-3)" }}>new</span> : null}
                      </td>
                      <td className="py-2 pr-4 align-top num" style={{ color: "var(--text-muted)" }}>
                        {(prof?.sample ?? []).join(" · ").slice(0, 40) || "—"}
                      </td>
                      <td className="py-2 pr-4 align-top">
                        <select className="input w-auto min-w-[170px] py-1 text-xs"
                                value={c.metric ?? "-"}
                                onChange={(e) => updateCol(c.header, {
                                  metric: e.target.value === "-" ? null : e.target.value,
                                  isNew: false,
                                })}>
                          <option value="-">— ignore —</option>
                          <option value="date">date</option>
                          {plan.kind === "workouts" || plan.kind === "sets"
                            ? (plan.kind === "sets" ? SET_FIELDS : WORKOUT_FIELDS)
                                .filter((f) => f !== "date").map((f) => <option key={f} value={f}>{f}</option>)
                            : <>
                                {c.isNew && c.metric ? <option value={c.metric}>{c.newMetric?.label ?? c.metric} (new)</option> : null}
                                {preview.metricOptions.map((m) => (
                                  <option key={m.key} value={m.key}>{m.label}{m.unit ? ` (${m.unit})` : ""}</option>
                                ))}
                              </>}
                        </select>
                      </td>
                      <td className="py-2 pr-4 align-top">
                        {c.metric && !["date", "type", "name", "session_name", "exercise", "notes"].includes(c.metric) ? (
                          <select className="input w-auto py-1 text-xs" value={c.transform}
                                  onChange={(e) => updateCol(c.header, { transform: e.target.value })}>
                            {Object.entries(TRANSFORM_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                          </select>
                        ) : <span style={{ color: "var(--text-muted)" }}>—</span>}
                      </td>
                      <td className="py-2 align-top" style={{ color: "var(--text-muted)", maxWidth: 260 }}>
                        <span className={`tone-${tone}`}>●</span> {c.reasoning}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-[11px]" style={{ color: "var(--text-muted)" }}>
            Dots show confidence. Change anything that looks wrong — what you see here is exactly what gets stored.
          </p>
        </Section>
      ) : null}

      {/* ── Data health ──────────────────────────────────────────────── */}
      <Section title="Coverage" subtitle="Every metric, its span, and its source">
        {!coverage.length ? <Empty>No data yet.</Empty> : (
          <>
            {workouts.n > 0 ? (
              <p className="mb-4 text-xs" style={{ color: "var(--text-secondary)" }}>
                <b className="num">{workouts.n}</b> workouts from {workouts.first} to {workouts.last}.
              </p>
            ) : null}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ color: "var(--text-muted)" }}>
                    <th className="pb-2 pr-4 text-left font-medium">Metric</th>
                    <th className="pb-2 pr-4 text-right font-medium">Readings</th>
                    <th className="pb-2 pr-4 text-left font-medium">Span</th>
                    <th className="pb-2 text-left font-medium">Sources</th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.map((c) => (
                    <tr key={c.metric_key} style={{ borderTop: "1px solid var(--border)" }}>
                      <td className="py-1.5 pr-4 num">{c.metric_key}</td>
                      <td className="py-1.5 pr-4 text-right num">{fmtNum(c.n, 0)}</td>
                      <td className="py-1.5 pr-4 num" style={{ color: "var(--text-muted)" }}>{c.first} → {c.last}</td>
                      <td className="py-1.5">
                        <span className="flex flex-wrap gap-1">
                          {c.sources.map((s) => <span key={s} className="chip text-[11px]" style={{ color: "var(--text-muted)" }}>{s}</span>)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>
    </div>
  );
}

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "custom";

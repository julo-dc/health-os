"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useMemo, useEffect } from "react";
import type { FullReport } from "@/lib/report";
import type { Briefing } from "@/app/api/insights/route";
import type { SyncDiagnosis } from "@/app/api/sync/route";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/analytics/goal";
import { LineChart, Sparkline, ProgressBar, RadialScore, Legend, fmtNum, fmtTrim, type Band } from "@/components/charts";
import { Section, StatusPill, Empty, Spinner, Confidence, TONE_COLOR } from "@/components/ui";
import { fmtDay, fmtDayLong, fmtStamp } from "@/lib/format";
import { Explain, Term } from "@/components/explain";

export function Dashboard({ report, briefing, briefingAt, llmEnabled, stats }: {
  report: FullReport;
  briefing: Briefing | null;
  briefingAt: string | null;
  llmEnabled: boolean;
  stats: { metrics: number; workouts: number; lastSync: string | null };
}) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [progress, setProgress] = useState<{ phase: string; steps: number; tools: string[] } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [diag, setDiag] = useState<SyncDiagnosis | null>(null);
  const g = report.goal;

  const sync = async () => {
    setSyncing(true); setMsg(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: 90 }),
      });
      const j = await res.json();
      setMsg(res.ok ? j.summary : j.error);
      setDiag(res.ok ? j.diagnosis ?? null : null);
      if (res.ok) router.refresh();
    } catch (e) { setMsg(e instanceof Error ? e.message : "Sync failed"); }
    finally { setSyncing(false); }
  };

  /**
   * Drive the briefing job to completion.
   *
   * The investigation takes minutes across a dozen model turns, which no
   * serverless function will hold open, so each request advances one step and
   * the loop lives here. The upside is that the user watches the model work —
   * which tools it reached for — rather than a spinner.
   */
  const brief = async () => {
    setThinking(true); setMsg(null); setProgress(null);
    try {
      const started = await fetch("/api/insights", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const job = await started.json();
      if (!started.ok) { setMsg(job.error); return; }

      let consecutiveFailures = 0;
      for (let i = 0; i < 30; i++) {
        // A step that times out at the platform level leaves the job untouched,
        // so retrying simply re-runs it. Only give up after several in a row.
        let s: any;
        try {
          const res = await fetch(`/api/insights/job/${job.jobId}`, { method: "POST" });
          s = await res.json();
          if (!res.ok) throw new Error(s?.error ?? `HTTP ${res.status}`);
          consecutiveFailures = 0;
        } catch (stepErr) {
          if (++consecutiveFailures >= 3) {
            setMsg(stepErr instanceof Error ? stepErr.message : "Briefing failed");
            return;
          }
          continue;
        }

        setProgress({
          phase: s.phase, steps: s.steps,
          tools: [...new Set<string>(s.toolsUsed ?? [])],
        });

        if (s.status === "error") { setMsg(s.error ?? "Briefing failed"); return; }
        if (s.status === "done") { router.refresh(); return; }
      }
      setMsg("The briefing did not finish in time. Try again.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setThinking(false); setProgress(null);
    }
  };

  if (stats.metrics === 0) return <FirstRun onSync={sync} syncing={syncing} msg={msg} diag={diag} />;

  return (
    <div className="space-y-5 rise">
      {/* ── Hero ───────────────────────────────────────────────────────── */}
      {g ? <GoalHero report={report} onSync={sync} syncing={syncing} msg={msg} diag={diag} stats={stats} /> : (
        <Section title="No goal set" subtitle="Everything here is measured against a goal — set one to begin.">
          <Empty cta={<Link href="/goals" className="btn btn-primary">Set your goal</Link>}>
            Describe what you&apos;re working toward in plain language and it becomes a measurable target set.
          </Empty>
        </Section>
      )}

      {/* ── Targets ────────────────────────────────────────────────────── */}
      {g && g.targets.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {g.targets.map((t) => <TargetCard key={t.metricKey} t={t} />)}
        </div>
      ) : null}

      {/* ── Forecast + briefing ────────────────────────────────────────── */}
      <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
        {g ? <ForecastPanel report={report} /> : <div />}
        <BriefingPanel briefing={briefing} at={briefingAt} llmEnabled={llmEnabled}
                       onGenerate={brief} thinking={thinking} progress={progress} hasGoal={Boolean(g)} />
      </div>

      {/* ── State of the body ──────────────────────────────────────────── */}
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        <ReadinessPanel report={report} />
        <LoadPanel report={report} />
        <RecompPanel report={report} />
      </div>

      {/* ── Drivers + events ───────────────────────────────────────────── */}
      <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
        <DriverPanel report={report} />
        <EventsPanel report={report} />
      </div>

      <SnapshotGrid report={report} />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */

export function SyncDiagnosisCard({ diag }: { diag: SyncDiagnosis }) {
  const tone = diag.severity === "error" ? "critical" : "warning";
  return (
    <div className={`rounded-xl p-4 bg-${tone}`}>
      <div className="flex items-start gap-2.5">
        <span aria-hidden className={`tone-${tone} mt-0.5 text-sm`}>{diag.severity === "error" ? "!" : "●"}</span>
        <div className="flex-1">
          <p className={`text-sm font-semibold tone-${tone}`}>{diag.title}</p>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{diag.detail}</p>
          {diag.actionUrl ? (
            <a href={diag.actionUrl}
               target={diag.actionUrl.startsWith("http") ? "_blank" : undefined}
               rel={diag.actionUrl.startsWith("http") ? "noreferrer" : undefined}
               className="btn mt-3 text-xs">
              {diag.actionLabel ?? "Fix this"}
              {diag.actionUrl.startsWith("http") ? <span aria-hidden>↗</span> : null}
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FirstRun({ onSync, syncing, msg, diag }: {
  onSync: () => void; syncing: boolean; msg: string | null; diag: SyncDiagnosis | null;
}) {
  const steps = [
    { n: 1, title: "Connect Google Health", body: "Pulls sleep, resting HR, HRV, steps, weight, body fat, workouts and more from your Fitbit via Google's cloud API.", action: <button onClick={onSync} disabled={syncing} className="btn btn-primary">{syncing ? <><Spinner /> Syncing…</> : "Sync now"}</button> },
    { n: 2, title: "Upload your CSVs", body: "Race timings, workout exports, or any spreadsheet you keep. Columns are auto-mapped and you confirm before anything is stored.", action: <Link href="/data" className="btn">Import data</Link> },
    { n: 3, title: "Set your goal", body: "Describe it in plain language — \"build my business and do a full recomp\" — and it becomes a measurable target set.", action: <Link href="/goals" className="btn">Set a goal</Link> },
  ];
  return (
    <div className="mx-auto max-w-2xl py-10 rise">
      <h1 className="text-2xl font-semibold tracking-tight">Let&apos;s get your data in.</h1>
      <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
        Three steps. You can do them in any order, but the goal is what makes everything else mean something.
      </p>
      {diag ? <div className="mt-5"><SyncDiagnosisCard diag={diag} /></div>
            : msg ? <div className="mt-4 card-tight text-sm">{msg}</div> : null}
      <div className="mt-6 space-y-3">
        {steps.map((s) => (
          <div key={s.n} className="card-pad flex items-start gap-4">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold"
                  style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)" }}>{s.n}</span>
            <div className="flex-1">
              <h3 className="text-sm font-semibold">{s.title}</h3>
              <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{s.body}</p>
            </div>
            <div className="shrink-0">{s.action}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GoalHero({ report, onSync, syncing, msg, diag, stats }: {
  report: FullReport; onSync: () => void; syncing: boolean; msg: string | null;
  diag: SyncDiagnosis | null;
  stats: { metrics: number; workouts: number; lastSync: string | null };
}) {
  const g = report.goal!;
  const tone = STATUS_TONE[g.status] ?? "neutral";
  return (
    <section className="card-pad">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
        <div className="flex items-center gap-5">
          <RadialScore value={g.index} label="Progress" tone={TONE_COLOR[tone]}
                       sublabel={g.expectedIndex !== null ? `${Math.round(g.expectedIndex)} expected` : undefined} />
          <div>
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <StatusPill tone={tone}>{STATUS_LABEL[g.status]}</StatusPill>
              <span className="chip" style={{ color: "var(--text-secondary)" }}>{g.goal.kind}</span>
            </div>
            <h1 className="text-xl font-semibold leading-tight tracking-tight">{g.goal.title}</h1>
            <p className="mt-1.5 max-w-xl text-sm" style={{ color: "var(--text-secondary)" }}>{g.headline}</p>
          </div>
        </div>

        <div className="lg:ml-auto lg:text-right">
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm lg:justify-end">
            <Stat label="Days left" value={g.daysRemaining !== null ? String(g.daysRemaining) : "—"} />
            <Stat label={<Term term="pace">Pace</Term>} value={g.paceRatio !== null ? `${g.paceRatio.toFixed(2)}×` : "—"} />
            <Stat label="Readings" value={fmtNum(stats.metrics, 0)} />
          </div>
          <div className="mt-4 flex flex-wrap gap-2 lg:justify-end">
            <button onClick={onSync} disabled={syncing} className="btn">
              {syncing ? <><Spinner /> Syncing…</> : "Sync Google Health"}
            </button>
            <Link href="/goals" className="btn btn-ghost">Edit goal</Link>
          </div>
          {stats.lastSync ? (
            <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
              Last sync {fmtStamp(stats.lastSync)}
            </p>
          ) : null}
        </div>
      </div>
      {msg ? (
        <div className="mt-4 rounded-lg px-3 py-2 text-sm" style={{ background: "var(--surface-2)", color: "var(--text-secondary)" }}>{msg}</div>
      ) : null}
      {diag ? <div className="mt-3"><SyncDiagnosisCard diag={diag} /></div> : null}
    </section>
  );
}

function Stat({ label, value, hint }: { label: React.ReactNode; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <div className="label flex items-center gap-1 lg:justify-end">{label}</div>
      <div className="num mt-0.5 text-lg font-semibold">{value}</div>
    </div>
  );
}

function TargetCard({ t }: { t: FullReport["goal"] extends null ? never : NonNullable<FullReport["goal"]>["targets"][number] }) {
  const tone = STATUS_TONE[t.status] ?? "neutral";
  const prob = t.projection ? Math.round(t.projection.probability * 100) : null;
  const dp = t.precision;
  const verb = t.direction === "maintain" ? "Hold at" : t.direction === "increase" ? "Increase to" : "Decrease to";

  return (
    <div className="card-pad">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1 text-sm font-semibold"><Explain metric={t.metricKey}>{t.label}</Explain></h3>
          <p className="mt-0.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
            {verb} {fmtTrim(t.target)}{t.unit}
          </p>
        </div>
        <StatusPill tone={tone}>{STATUS_LABEL[t.status]}</StatusPill>
      </div>

      <div className="mt-3">
        <div>
          <div className="num text-2xl font-semibold leading-none">{fmtNum(t.smoothed, dp)}<span className="ml-0.5 text-sm font-normal" style={{ color: "var(--text-muted)" }}>{t.unit}</span></div>
          <div className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
            from {fmtTrim(t.baseline)}{t.unit}
          </div>
        </div>
      </div>

      <div className="mt-3">
        <ProgressBar value={t.progress ?? 0} expected={t.expected} tone={TONE_COLOR[tone]} />
        <div className="mt-1.5 flex items-center justify-between text-[11px]" style={{ color: "var(--text-muted)" }}>
          <span className="num">{t.progress !== null ? `${Math.round(t.progress * 100)}% there` : "no baseline yet"}</span>
          <Confidence level={t.confidence} />
        </div>
      </div>

      {t.trend || prob !== null ? (
        <div className="divider mt-3 pt-3 text-[11px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          {t.trend ? (
            <div>
              {t.trend.significant
                ? <>Trending <b>{t.trend.direction}</b> {fmtNum(Math.abs(t.trend.senSlopePerDay * 7), 2)}{t.unit}/week</>
                : <>No significant trend yet <span style={{ color: "var(--text-muted)" }}>(p={t.trend.mkP.toFixed(2)})</span></>}
            </div>
          ) : null}
          {prob !== null ? (
            <div className="mt-1">
              <Term term="probability">
              <b className={prob >= 65 ? "tone-good" : prob >= 35 ? "tone-warning" : "tone-critical"}>{prob}%</b> chance of hitting this by the deadline
            </Term>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ForecastPanel({ report }: { report: FullReport }) {
  const g = report.goal!;
  const [sel, setSel] = useState(0);
  const t = g.targets[sel];
  const [data, setData] = useState<{ points: any[]; bands: Band[] } | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (i: number) => {
    setSel(i); setLoading(true);
    const target = g.targets[i];
    try {
      const horizon = g.daysRemaining && g.daysRemaining > 0 ? Math.min(g.daysRemaining, 365) : 60;
      const res = await fetch(`/api/analyze?metric=${target.metricKey}&days=365&horizon=${horizon}`);
      const j = await res.json();
      setData({ points: j.points ?? [], bands: j.forecast?.bands ?? [] });
    } finally { setLoading(false); }
  };

  useEffect(() => { if (g.targets.length) load(0); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  if (!t) return <div />;
  const dp = t.precision;

  return (
    <Section
      title="Where this is heading"
      subtitle={<span className="flex items-center gap-1"><Term term="forecast">Damped-trend model, simulated 800 times against your own residuals</Term></span>}
      action={
        <select className="input w-auto text-xs" value={sel} onChange={(e) => load(Number(e.target.value))}>
          {g.targets.map((tt, i) => <option key={tt.metricKey} value={i}>{tt.label}</option>)}
        </select>
      }>
      {loading && !data ? (
        <div className="flex h-[260px] items-center justify-center" style={{ color: "var(--text-muted)" }}><Spinner size={20} /></div>
      ) : (
        <>
          <LineChart
            height={260}
            precision={dp}
            unit={t.unit}
            series={[{ key: "actual", label: t.label, points: data?.points ?? [], color: "var(--series-1)" }]}
            bands={data?.bands}
            targetLine={t.target !== null ? { value: t.target, label: `target ${fmtTrim(t.target)}${t.unit ?? ""}` } : null}
            emptyLabel="Not enough readings to forecast yet"
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <Legend items={[
              { label: "Recorded", color: "var(--series-1)" },
              { label: "Forecast", color: "var(--series-1)", dashed: true },
            ]} />
            {t.projection ? (
              <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
                Needs <b className="num">{fmtNum(t.projection.requiredRatePerWeek, 2)}{t.unit}</b>/week ·
                currently <b className="num">{fmtNum(t.projection.currentRatePerWeek, 2)}{t.unit}</b>/week
              </p>
            ) : null}
          </div>
        </>
      )}
    </Section>
  );
}

function BriefingPanel({ briefing, at, llmEnabled, onGenerate, thinking, progress, hasGoal }: {
  briefing: Briefing | null; at: string | null; llmEnabled: boolean;
  onGenerate: () => void; thinking: boolean;
  progress: { phase: string; steps: number; tools: string[] } | null;
  hasGoal: boolean;
}) {
  const [showTrace, setShowTrace] = useState(false);
  const toneFor = (v: string) => v === "yes" ? "good" : v === "partly" ? "warning" : v === "no" ? "critical" : "neutral";
  return (
    <Section
      title="Coach briefing"
      subtitle={at ? `Generated ${fmtDayLong(at)}` : "Reads your computed statistics and tells you what to do about them"}
      action={
        llmEnabled && hasGoal ? (
          <button onClick={onGenerate} disabled={thinking} className="btn text-xs">
            {thinking ? <><Spinner /> Thinking…</> : briefing ? "Regenerate" : "Generate"}
          </button>
        ) : null
      }>
      {thinking && progress ? (
        <div className="rounded-xl p-4" style={{ background: "var(--surface-2)" }}>
          <div className="flex items-center gap-2 text-sm font-medium">
            <Spinner />
            {progress.phase === "write" ? "Writing the briefing…" : `Investigating — step ${progress.steps}`}
          </div>
          {progress.tools.length ? (
            <div className="mt-2.5">
              <div className="label mb-1.5">Looked at so far</div>
              <div className="flex flex-wrap gap-1.5">
                {progress.tools.map((t) => (
                  <span key={t} className="chip text-[10px]" style={{ color: "var(--text-secondary)" }}>
                    {t.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          <p className="mt-2.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
            This takes a couple of minutes. It runs as a resumable job, so leaving the page
            won&apos;t lose the work — it will be here when you come back.
          </p>
        </div>
      ) : !llmEnabled ? (
        <Empty>Add <code>OPENROUTER_API_KEY</code> to your environment to enable AI briefings. Everything statistical works without it.</Empty>
      ) : !hasGoal ? (
        <Empty>Set a goal first — the briefing is written against it.</Empty>
      ) : !briefing ? (
        <Empty cta={<button onClick={onGenerate} disabled={thinking} className="btn btn-primary">{thinking ? "Thinking…" : "Generate briefing"}</button>}>
          No briefing yet.
        </Empty>
      ) : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={toneFor(briefing.onTrack)}>
              {briefing.onTrack === "yes" ? "On track" : briefing.onTrack === "partly" ? "Partly" : briefing.onTrack === "no" ? "Off track" : "Unclear"}
            </StatusPill>
            {briefing.checked?.length ? (
              <button onClick={() => setShowTrace((v) => !v)} className="chip transition-colors hover:brightness-110"
                      style={{ color: "var(--text-muted)" }}>
                checked {briefing.checked.length} things {showTrace ? "▲" : "▼"}
              </button>
            ) : null}
          </div>

          {showTrace && briefing.checked?.length ? (
            <div className="rounded-lg p-2.5 text-[11px]" style={{ background: "var(--surface-2)" }}>
              <div className="label mb-1.5">What it looked at</div>
              <ul className="space-y-0.5 num" style={{ color: "var(--text-secondary)" }}>
                {briefing.checked.map((c, i) => (
                  <li key={i}>
                    {c.tool.replace(/_/g, " ")}
                    {Object.keys(c.args).length ? (
                      <span style={{ color: "var(--text-muted)" }}> · {Object.values(c.args).join(", ")}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {briefing.headlineNumber ? (
            <div className="rounded-xl p-3.5" style={{ background: "var(--surface-2)" }}>
              <div className="num text-2xl font-semibold leading-none">{briefing.headlineNumber.value}</div>
              <div className="label mt-1.5">{briefing.headlineNumber.label}</div>
              <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>{briefing.headlineNumber.context}</p>
            </div>
          ) : null}

          <p style={{ color: "var(--text-primary)" }}>{briefing.verdict}</p>

          {briefing.targets?.length ? (
            <div>
              <div className="label mb-2">Target by target</div>
              <div className="space-y-2">
                {briefing.targets.map((t, i) => (
                  <details key={i} className="rounded-lg p-2.5" style={{ background: "var(--surface-2)" }}>
                    <summary className="cursor-pointer list-none">
                      <span className="flex items-start justify-between gap-2">
                        <span className="flex items-center gap-1 font-medium">
                          <Explain metric={t.metric}>{t.metric.replace(/_/g, " ")}</Explain>
                        </span>
                        <span className="shrink-0 text-[11px]" style={{ color: "var(--text-muted)" }}>{t.status}</span>
                      </span>
                    </summary>
                    <div className="mt-2 space-y-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
                      <p>{t.whatsHappening}</p>
                      {t.whyItMatters ? <p style={{ color: "var(--text-muted)" }}>{t.whyItMatters}</p> : null}
                      {t.doThis ? <p style={{ color: "var(--text-primary)" }}><b>Do: </b>{t.doThis}</p> : null}
                    </div>
                  </details>
                ))}
              </div>
            </div>
          ) : null}

          {briefing.actions?.length ? (
            <div>
              <div className="label mb-2">Do this week</div>
              <ul className="space-y-2">
                {briefing.actions.map((a, i) => (
                  <li key={i} className="rounded-lg p-2.5" style={{ background: "var(--surface-2)" }}>
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium">{a.action}</span>
                      <span className="chip shrink-0 text-[10px]" style={{ color: "var(--text-muted)" }}>{a.effort}</span>
                    </div>
                    <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>{a.why}</p>
                    {a.expectedEffect ? (
                      <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                        <b>Expect: </b>{a.expectedEffect}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            {briefing.wins?.length ? (
              <div>
                <div className="label mb-1.5 tone-good">Working</div>
                <ul className="space-y-1 text-xs" style={{ color: "var(--text-secondary)" }}>
                  {briefing.wins.map((wn, i) => <li key={i}>· {wn}</li>)}
                </ul>
              </div>
            ) : null}
            {briefing.risks?.length ? (
              <div>
                <div className="label mb-1.5 tone-warning">Watch</div>
                <ul className="space-y-1 text-xs" style={{ color: "var(--text-secondary)" }}>
                  {briefing.risks.map((r, i) => <li key={i}>· {r}</li>)}
                </ul>
              </div>
            ) : null}
          </div>

          {briefing.dataQuality?.length ? (
            <details className="rounded-lg p-2.5" style={{ background: "var(--surface-2)" }}>
              <summary className="cursor-pointer text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                How much to trust this ({briefing.dataQuality.length} caveat{briefing.dataQuality.length === 1 ? "" : "s"})
              </summary>
              <ul className="mt-2 space-y-1 text-xs" style={{ color: "var(--text-muted)" }}>
                {briefing.dataQuality.map((d, i) => <li key={i}>· {d}</li>)}
              </ul>
            </details>
          ) : null}

          {briefing.experiment ? (
            <div className="rounded-lg p-3" style={{ background: "var(--surface-2)" }}>
              <div className="label mb-1">Experiment to run</div>
              <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
                <b style={{ color: "var(--text-primary)" }}>{briefing.experiment.hypothesis}</b><br />
                {briefing.experiment.test} — measure {briefing.experiment.measure}.
              </p>
            </div>
          ) : null}

          {briefing.question ? (
            <p className="text-xs italic" style={{ color: "var(--text-muted)" }}>&ldquo;{briefing.question}&rdquo;</p>
          ) : null}
        </div>
      )}
    </Section>
  );
}

function ReadinessPanel({ report }: { report: FullReport }) {
  const r = report.readiness;
  const tone = r.value === null ? "neutral" : r.value >= 66 ? "good" : r.value >= 40 ? "warning" : "critical";
  return (
    <Section title="Readiness" subtitle="HRV, resting HR, sleep and form — each vs your own 60-day baseline">
      {r.value === null ? (
        <Empty>Needs about two weeks of HRV, resting HR or sleep data.</Empty>
      ) : (
        <div className="flex items-center gap-5">
          <RadialScore value={r.value} size={110} tone={TONE_COLOR[tone]} label="today" />
          <div className="flex-1">
            <LineChart height={90} series={[{ key: "r", label: "Readiness", points: r.series, color: TONE_COLOR[tone] }]} precision={0} />
          </div>
        </div>
      )}
    </Section>
  );
}

function LoadPanel({ report }: { report: FullReport }) {
  const l = report.load;
  if (l.ctl === null) {
    return (
      <Section title="Training load" subtitle="Fitness, fatigue and form from your sessions">
        <Empty cta={<Link href="/data" className="btn text-xs">Import workouts</Link>}>No workouts recorded yet.</Empty>
      </Section>
    );
  }
  // Until a full 42-day chronic base exists the numbers are unbiased but
  // high-variance, so the risk thresholds must not be coloured — that is what
  // made every new user's first six weeks look like an injury emergency.
  const warming = !l.established;
  const acwrTone = warming || l.acwr === null ? "neutral"
    : l.acwr > 1.5 ? "critical" : l.acwr > 1.3 ? "warning" : l.acwr < 0.8 ? "warning" : "good";
  const formTone = warming || l.tsb === null ? "neutral"
    : l.tsb < -25 ? "critical" : l.tsb < -10 ? "warning" : l.tsb > 20 ? "warning" : "good";
  return (
    <Section title="Training load" subtitle="Banister impulse-response model over your sessions">
      {warming ? (
        <div className="mb-3 rounded-lg px-3 py-2.5 text-xs" style={{ background: "var(--surface-2)" }}>
          <b>Establishing baseline</b>
          <span style={{ color: "var(--text-secondary)" }}>
            {" "}— {l.warmupDaysRemaining} more {l.warmupDaysRemaining === 1 ? "day" : "days"} of
            history before fitness and injury-risk thresholds mean anything. The numbers below
            are real; the colour-coding is held back until there is a chronic base to compare against.
          </span>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Metric label="Fitness (CTL)" value={fmtNum(l.ctl, 1)} metric="ctl" />
        <Metric label="Fatigue (ATL)" value={fmtNum(l.atl, 1)} metric="atl" />
        <Metric label="Form (TSB)" value={fmtNum(l.tsb, 1)} tone={formTone} metric="tsb" />
        <Metric label="Acute:chronic" value={l.acwr !== null ? `${l.acwr.toFixed(2)}×` : "—"} tone={acwrTone} metric="acwr" />
      </div>
      {l.monotony !== null ? (
        <p className="mt-3 text-[11px]" style={{ color: "var(--text-muted)" }}>
          7-day monotony {l.monotony.toFixed(2)} — high values mean every day looks the same, which is harder to recover from than the same load with hard/easy variation.
        </p>
      ) : null}
    </Section>
  );
}

function RecompPanel({ report }: { report: FullReport }) {
  const r = report.recomp;
  return (
    <Section title="Body recomposition" subtitle="What the scale can't tell you: fat vs lean">
      {!r ? (
        <Empty cta={<Link href="/log" className="btn text-xs">Log weight &amp; body fat</Link>}>
          Needs weight <em>and</em> body-fat % on the same days.
        </Empty>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2">
            <StatusPill tone={r.verdict === "recomposing" ? "good" : r.verdict === "losing both" || r.verdict === "gaining fat" ? "warning" : "neutral"}>
              {r.verdict}
            </StatusPill>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>last {r.days} days</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Metric label="Lean mass" value={`${r.deltaLean >= 0 ? "+" : ""}${r.deltaLean.toFixed(2)} kg`}
                    tone={r.deltaLean >= -0.1 ? "good" : "warning"} />
            <Metric label="Fat mass" value={`${r.deltaFat >= 0 ? "+" : ""}${r.deltaFat.toFixed(2)} kg`}
                    tone={r.deltaFat <= 0 ? "good" : "warning"} />
          </div>
          <div className="mt-3">
            <div className="mb-1.5 flex justify-between text-[11px]" style={{ color: "var(--text-muted)" }}>
              <span>Recomp quality</span><span className="num">{Math.round(r.quality)}/100</span>
            </div>
            <ProgressBar value={r.quality / 100} tone={r.quality >= 60 ? "var(--status-good)" : r.quality >= 40 ? "var(--status-warning)" : "var(--status-critical)"} />
          </div>
        </>
      )}
    </Section>
  );
}

function Metric({ label, value, tone, hint, metric }: {
  label: string; value: string; tone?: string; hint?: string; metric?: string;
}) {
  return (
    <div className="rounded-lg p-2.5" style={{ background: "var(--surface-2)" }} title={hint}>
      <div className="label flex items-center gap-1">
        {metric ? <Explain metric={metric}>{label}</Explain> : label}
      </div>
      <div className={`num mt-1 text-lg font-semibold ${tone ? `tone-${tone}` : ""}`}>{value}</div>
    </div>
  );
}

function DriverPanel({ report }: { report: FullReport }) {
  const d = report.drivers;
  return (
    <Section
      title={(<span className="flex items-center gap-1.5">
        <Term term="driver">{d ? `What moves your ${d.targetLabel.toLowerCase()}` : "Driver analysis"}</Term>
      </span>) as any}
      subtitle={d ? `Ridge regression on ${d.n} days, each input at its most predictive lag. Adjusted R² ${d.adjR2.toFixed(2)}.` : undefined}>
      {!d ? (
        <Empty>Needs about 20 days of overlapping data between your goal metric and your daily inputs.</Empty>
      ) : (
        <>
          <div className="space-y-2.5">
            {d.items.map((it) => {
              const color = it.favourable === null ? "var(--series-1)"
                : it.favourable ? "var(--series-3)" : "var(--series-2)";
              return (
                <div key={it.key} className="flex items-center gap-3">
                  <div className="w-36 shrink-0 truncate text-xs" title={it.label}>{it.label}</div>
                  <div className="relative h-5 flex-1">
                    <div className="absolute inset-y-0 left-1/2 w-px" style={{ background: "var(--axis)" }} />
                    <div className="absolute inset-y-[5px] rounded-[3px]"
                         style={{
                           background: color,
                           width: `${Math.min(48, Math.abs(it.coefficient) * 60)}%`,
                           left: it.direction === "raises" ? "50%" : undefined,
                           right: it.direction === "lowers" ? "50%" : undefined,
                         }} />
                  </div>
                  <div className="w-32 shrink-0 text-right text-[11px] num" style={{ color: "var(--text-muted)" }}>
                    {it.lag > 0 ? `${it.lag}d lag · ` : ""}{it.direction === "raises" ? "↑" : "↓"} r={it.correlation.toFixed(2)}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex items-center justify-between">
            <Legend items={
              d.items.some((i) => i.favourable !== null)
                ? [{ label: "Moves it your way", color: "var(--series-3)" }, { label: "Moves it against you", color: "var(--series-2)" }]
                : [{ label: "Association strength", color: "var(--series-1)" }]
            } />
            <Link href={`/analyze?metric=${d.target}`} className="text-xs underline" style={{ color: "var(--text-secondary)" }}>Explore</Link>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            Associations in your own data, not proof of cause — and inputs that move together (sleep, HRV, resting HR) share credit here. A lag of 1 day means yesterday&apos;s value lines up with today&apos;s outcome, which at least rules out the reverse direction in time.
          </p>
        </>
      )}
    </Section>
  );
}

function EventsPanel({ report }: { report: FullReport }) {
  const events = [
    ...report.changePoints.map((c) => ({ ...c, kind: "shift" as const })),
    ...report.anomalies.map((a) => ({ ...a, kind: "anomaly" as const })),
  ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);

  return (
    <Section title="What changed" subtitle="Statistically significant level shifts and outlier days">
      {!events.length ? (
        <Empty>Nothing unusual detected. That&apos;s a good thing.</Empty>
      ) : (
        <ul className="space-y-2.5">
          {events.map((e, i) => (
            <li key={i} className="flex items-start gap-3 text-xs">
              <span className="mt-0.5 shrink-0 num" style={{ color: "var(--text-muted)" }}>
                {fmtDay(e.date)}
              </span>
              {e.kind === "shift" ? (
                <span style={{ color: "var(--text-secondary)" }}>
                  <b style={{ color: "var(--text-primary)" }}>{e.label}</b> shifted from{" "}
                  <span className="num">{fmtNum(e.before, 1)}</span> to <span className="num">{fmtNum(e.after, 1)}</span>
                  <span style={{ color: "var(--text-muted)" }}> (effect {Math.abs(e.effectSize).toFixed(1)}σ)</span>
                </span>
              ) : (
                <span style={{ color: "var(--text-secondary)" }}>
                  <b style={{ color: "var(--text-primary)" }}>{e.label}</b> unusually {e.direction} at{" "}
                  <span className="num">{fmtNum(e.value, 1)}</span>
                  <span style={{ color: "var(--text-muted)" }}> ({Math.abs(e.z).toFixed(1)} SDs)</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function SnapshotGrid({ report }: { report: FullReport }) {
  const groups = useMemo(() => {
    const by: Record<string, typeof report.snapshots> = {};
    for (const s of report.snapshots) (by[s.category] ||= []).push(s);
    return by;
  }, [report.snapshots]);

  const LABELS: Record<string, string> = {
    body: "Body", cardio: "Cardio & recovery", sleep: "Sleep", activity: "Activity",
    derived: "Training model", nutrition: "Nutrition", work: "Work", cognitive: "Cognitive", custom: "Custom",
  };

  return (
    <Section title="Everything else" subtitle="7-day average vs the week before" action={
      <Link href="/analyze" className="btn btn-ghost text-xs">Deep dive</Link>
    }>
      <div className="space-y-5">
        {Object.entries(groups).map(([cat, items]) => (
          <div key={cat}>
            <div className="label mb-2">{LABELS[cat] ?? cat}</div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {items.map((s) => {
                const good = s.higherBetter === null || s.deltaPct === null ? null
                  : (s.deltaPct > 0) === s.higherBetter;
                return (
                  <Link key={s.key} href={`/analyze?metric=${s.key}`}
                        className="flex items-center gap-3 rounded-lg p-2.5 transition-colors hover:brightness-110"
                        style={{ background: "var(--surface-2)" }}>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs" style={{ color: "var(--text-secondary)" }}>{s.label}</div>
                      <div className="num mt-0.5 text-base font-semibold">
                        {fmtNum(s.avg7 ?? s.latest, Math.abs(s.avg7 ?? 0) < 10 ? 1 : 0)}
                        <span className="ml-0.5 text-[11px] font-normal" style={{ color: "var(--text-muted)" }}>{s.unit}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <Sparkline points={s.spark} width={64} height={26}
                                 color={good === null ? "var(--series-1)" : good ? "var(--status-good)" : "var(--status-warning)"} />
                      {s.deltaPct !== null ? (
                        <div className="num text-[10px]"
                             style={{ color: good === null ? "var(--text-muted)" : good ? "var(--success-text)" : "var(--status-warning)" }}>
                          {s.deltaPct > 0 ? "+" : ""}{s.deltaPct.toFixed(1)}%
                        </div>
                      ) : null}
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

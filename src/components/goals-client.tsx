"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { MetricDef } from "@/lib/metric-meta";
import type { Goal, GoalTarget } from "@/lib/analytics/goal";
import { Section, Empty, Spinner, StatusPill } from "@/components/ui";
import { CATEGORY_LABELS } from "@/lib/metric-meta";

type GoalRow = Goal & { targets: GoalTarget[] };
type Draft = {
  title: string; kind: string; description: string; start_date: string; target_date: string;
  targets: {
    metric_key: string; direction: string; target_value: string; weight: number; notes: string;
    currentValue?: number | null; unit?: string | null; hasData?: boolean; stale?: boolean;
  }[];
};

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const EXAMPLES = [
  "Build my business and do a full body recomp over the next 4 months",
  "Train for an Ironman in September while holding my weight steady",
  "Get sharper: more deep work, better sleep, less screen time",
];

export function GoalsClient({ goals, metrics, llmEnabled }: {
  goals: GoalRow[]; metrics: MetricDef[]; llmEnabled: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState("");
  const [deadline, setDeadline] = useState(plusDays(120));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  const active = goals.find((g) => g.status === "active");
  const archive = goals.filter((g) => g.status !== "active");
  const byKey = Object.fromEntries(metrics.map((m) => [m.key, m]));

  const parse = async () => {
    if (!text.trim()) return;
    setBusy("parse"); setErr(null); setMissing([]); setWarnings([]);
    try {
      const res = await fetch("/api/goals/parse", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, targetDate: deadline }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      setDraft({
        title: j.title, kind: j.kind, description: j.description ?? "",
        start_date: today(), target_date: j.target_date ?? deadline,
        targets: (j.targets ?? []).map((t: any) => ({
          metric_key: t.metric_key, direction: t.direction,
          target_value: t.target_value ?? "", weight: t.weight ?? 1, notes: t.notes ?? "",
          currentValue: t.currentValue, unit: t.unit, hasData: t.hasData, stale: t.stale,
        })),
      });
      setMissing(j.missing ?? []);
      setWarnings(j.warnings ?? []);
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(null); }
  };

  const blank = () => setDraft({
    title: "", kind: "mixed", description: "", start_date: today(), target_date: plusDays(90),
    targets: [{ metric_key: metrics[0]?.key ?? "weight_kg", direction: "decrease", target_value: "", weight: 2, notes: "" }],
  });

  const save = async () => {
    if (!draft?.title.trim()) { setErr("Give the goal a title"); return; }
    setBusy("save"); setErr(null);
    try {
      const res = await fetch("/api/goals", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...draft,
          targets: draft.targets
            .filter((t) => t.metric_key)
            .map((t) => ({ ...t, target_value: t.target_value === "" ? null : Number(t.target_value) })),
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      setDraft(null); setText("");
      router.refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(null); }
  };

  const setStatus = async (id: number, status: string) => {
    setBusy(`g${id}`);
    await fetch(`/api/goals/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
    });
    setBusy(null); router.refresh();
  };

  const remove = async (id: number) => {
    setBusy(`g${id}`);
    await fetch(`/api/goals/${id}`, { method: "DELETE" });
    setBusy(null); router.refresh();
  };

  const upd = (i: number, patch: Partial<Draft["targets"][number]>) =>
    setDraft((d) => d && { ...d, targets: d.targets.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  return (
    <div className="space-y-5 rise">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Goals</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
          One active goal at a time. Everything on the dashboard is measured against it.
        </p>
      </div>

      {/* ── Composer ─────────────────────────────────────────────────── */}
      {!draft ? (
        <Section title="Set a new goal"
                 subtitle={llmEnabled ? "Describe it in plain language and it becomes a measurable target set" : "Add OPENROUTER_API_KEY to describe goals in plain language"}>
          {llmEnabled ? (
            <div className="space-y-3">
              <textarea className="input min-h-[92px] resize-y" value={text} placeholder="What are you working toward?"
                        onChange={(e) => setText(e.target.value)} />
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((ex) => (
                  <button key={ex} onClick={() => setText(ex)} className="chip transition-colors hover:brightness-110"
                          style={{ color: "var(--text-secondary)" }}>{ex}</button>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-xs">
                  <span className="label mb-1 block">Deadline</span>
                  <input type="date" className="input w-auto" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
                </label>
                <button onClick={parse} disabled={busy === "parse" || !text.trim()} className="btn btn-primary">
                  {busy === "parse" ? <><Spinner /> Reading your data…</> : "Turn into targets"}
                </button>
                <button onClick={blank} className="btn btn-ghost">Build manually</button>
              </div>
              {err ? <p className="text-sm tone-critical">{err}</p> : null}
            </div>
          ) : (
            <button onClick={blank} className="btn btn-primary">Build a goal manually</button>
          )}
        </Section>
      ) : (
        <Section title="Review your goal"
                 subtitle="Adjust anything before saving — these targets drive every projection"
                 action={<button onClick={() => setDraft(null)} className="btn btn-ghost text-xs">Cancel</button>}>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs">
                <span className="label mb-1 block">Title</span>
                <input className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </label>
              <label className="text-xs">
                <span className="label mb-1 block">Type</span>
                <select className="input" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                  <option value="physical">Physical</option>
                  <option value="work">Work / business</option>
                  <option value="cognitive">Cognitive</option>
                  <option value="mixed">Mixed</option>
                </select>
              </label>
              <label className="text-xs">
                <span className="label mb-1 block">Start</span>
                <input type="date" className="input" value={draft.start_date} onChange={(e) => setDraft({ ...draft, start_date: e.target.value })} />
              </label>
              <label className="text-xs">
                <span className="label mb-1 block">Deadline</span>
                <input type="date" className="input" value={draft.target_date} onChange={(e) => setDraft({ ...draft, target_date: e.target.value })} />
              </label>
            </div>
            <label className="block text-xs">
              <span className="label mb-1 block">Description</span>
              <textarea className="input min-h-[60px] resize-y" value={draft.description}
                        onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </label>

            {warnings.length ? (
              <div className="rounded-lg px-3 py-2.5 text-xs bg-warning">
                <b className="tone-warning">Check these before saving</b>
                <ul className="mt-1.5 space-y-1" style={{ color: "var(--text-secondary)" }}>
                  {warnings.map((w, i) => <li key={i}>· {w}</li>)}
                </ul>
              </div>
            ) : null}

            <div>
              <div className="label mb-2">Targets</div>
              <div className="space-y-2">
                {draft.targets.map((t, i) => (
                  <div key={i} className="rounded-lg p-3" style={{ background: "var(--surface-2)" }}>
                    <div className="grid gap-2 sm:grid-cols-[1.6fr_1fr_1fr_auto_auto]">
                      <select className="input" value={t.metric_key} onChange={(e) => upd(i, { metric_key: e.target.value })}>
                        {Object.entries(
                          metrics.reduce((acc, m) => { (acc[m.category] ||= []).push(m); return acc; }, {} as Record<string, MetricDef[]>)
                        ).map(([cat, items]) => (
                          <optgroup key={cat} label={CATEGORY_LABELS[cat] ?? cat}>
                            {items.map((m) => <option key={m.key} value={m.key}>{m.label}{m.unit ? ` (${m.unit})` : ""}</option>)}
                          </optgroup>
                        ))}
                      </select>
                      <select className="input" value={t.direction} onChange={(e) => upd(i, { direction: e.target.value })}>
                        <option value="increase">Increase to</option>
                        <option value="decrease">Decrease to</option>
                        <option value="maintain">Maintain at</option>
                      </select>
                      <input className="input num" type="number" step="any" placeholder="target"
                             value={t.target_value} onChange={(e) => upd(i, { target_value: e.target.value })} />
                      <select className="input w-auto" value={t.weight} onChange={(e) => upd(i, { weight: Number(e.target.value) })}
                              title="Relative importance">
                        <option value={1}>×1</option><option value={2}>×2</option><option value={3}>×3</option>
                      </select>
                      <button onClick={() => setDraft({ ...draft, targets: draft.targets.filter((_, j) => j !== i) })}
                              className="btn btn-ghost px-2" aria-label="Remove target">×</button>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
                      <span className="num">
                        now{" "}
                        <b style={{ color: "var(--text-primary)" }}>
                          {t.currentValue === null || t.currentValue === undefined
                            ? "—"
                            : Math.abs(t.currentValue) >= 100
                              ? Math.round(t.currentValue)
                              : Math.round(t.currentValue * 10) / 10}
                        </b>{t.unit}
                        {" → "}
                        <b style={{ color: "var(--text-primary)" }}>{t.target_value || "?"}</b>{t.unit}
                      </span>
                      {t.hasData === false ? <span className="chip tone-warning text-[9px]">never logged</span> : null}
                      {t.stale ? <span className="chip tone-warning text-[9px]">stale</span> : null}
                      {t.notes ? <span>{t.notes}</span> : null}
                    </div>
                  </div>
                ))}
              </div>
              <button onClick={() => setDraft({ ...draft, targets: [...draft.targets, { metric_key: metrics[0]?.key ?? "", direction: "increase", target_value: "", weight: 1, notes: "" }] })}
                      className="btn btn-ghost mt-2 text-xs">+ Add target</button>
            </div>

            {err ? <p className="text-sm tone-critical">{err}</p> : null}
            <div className="flex gap-2">
              <button onClick={save} disabled={busy === "save"} className="btn btn-primary">
                {busy === "save" ? <><Spinner /> Saving…</> : "Save and make active"}
              </button>
            </div>
          </div>
        </Section>
      )}

      {/* ── Active ───────────────────────────────────────────────────── */}
      {active ? (
        <Section title="Active goal" action={
          <button onClick={() => setStatus(active.id, "archived")} disabled={busy === `g${active.id}`} className="btn btn-ghost text-xs">
            Archive
          </button>
        }>
          <GoalDetail g={active} byKey={byKey} />
        </Section>
      ) : null}

      {/* ── Archive ──────────────────────────────────────────────────── */}
      <Section title="Past goals" subtitle="Your history — what you were chasing and how it went">
        {!archive.length ? <Empty>Nothing archived yet.</Empty> : (
          <div className="space-y-3">
            {archive.map((g) => (
              <div key={g.id} className="rounded-lg p-3" style={{ background: "var(--surface-2)" }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold">{g.title}</h3>
                      <StatusPill tone={g.status === "achieved" ? "good" : "neutral"}>{g.status}</StatusPill>
                    </div>
                    <p className="mt-0.5 text-[11px] num" style={{ color: "var(--text-muted)" }}>
                      {g.start_date} → {g.target_date ?? "open"}
                    </p>
                    <GoalDetail g={g} byKey={byKey} compact />
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button onClick={() => setStatus(g.id, "active")} disabled={busy === `g${g.id}`} className="btn btn-ghost text-xs">Reactivate</button>
                    <button onClick={() => remove(g.id)} disabled={busy === `g${g.id}`} className="btn btn-ghost text-xs tone-critical">Delete</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function GoalDetail({ g, byKey, compact }: { g: GoalRow; byKey: Record<string, MetricDef>; compact?: boolean }) {
  return (
    <div className={compact ? "mt-2" : ""}>
      {!compact ? (
        <>
          <h3 className="text-base font-semibold">{g.title}</h3>
          {g.description ? <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{g.description}</p> : null}
          <p className="mt-1 text-xs num" style={{ color: "var(--text-muted)" }}>
            {g.start_date} → {g.target_date ?? "open-ended"}
          </p>
        </>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {g.targets.map((t) => (
          <span key={t.id} className="chip num" style={{ color: "var(--text-secondary)" }}>
            {byKey[t.metric_key]?.label ?? t.metric_key}{" "}
            <span style={{ color: "var(--text-muted)" }}>
              {t.direction === "maintain" ? "@" : t.direction === "increase" ? "↑" : "↓"} {t.target_value ?? "?"}
              {byKey[t.metric_key]?.unit}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

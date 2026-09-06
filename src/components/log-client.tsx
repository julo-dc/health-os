"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { MetricDef } from "@/lib/metric-meta";
import { CATEGORY_LABELS } from "@/lib/metric-meta";
import { Section, Empty, Spinner } from "@/components/ui";
import { fmtWeekday } from "@/lib/format";
import { fmtNum } from "@/components/charts";

/** Metrics worth offering by default when nothing is pinned to a goal. */
const QUICK = ["weight_kg", "body_fat_pct", "deep_work_hours", "focus_score", "mood", "energy", "stress"];

export function LogClient({ metrics, recent, notes, today, goalKeys }: {
  metrics: MetricDef[];
  recent: { date: string; metric_key: string; value: number; source: string }[];
  notes: { id: number; date: string; body: string; kind: string }[];
  today: string;
  goalKeys: string[];
}) {
  const router = useRouter();
  const [date, setDate] = useState(today);
  const [values, setValues] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [extra, setExtra] = useState<string[]>([]);
  const [custom, setCustom] = useState({ key: "", label: "", unit: "" });
  const [showCustom, setShowCustom] = useState(false);

  const byKey = Object.fromEntries(metrics.map((m) => [m.key, m]));
  // Goal metrics first — those are the ones you actually need to keep current.
  const fields = useMemo(() => {
    const keys = [...new Set([...goalKeys, ...QUICK, ...extra])].filter((k) => byKey[k]);
    return keys.map((k) => byKey[k]);
  }, [goalKeys, extra, metrics]);

  const existing = useMemo(() => {
    const m: Record<string, { value: number; source: string }> = {};
    for (const r of recent) if (r.date === date) m[r.metric_key] = { value: Number(r.value), source: r.source };
    return m;
  }, [recent, date]);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const payload = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
      const res = await fetch("/api/log", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, values: payload, note: note || undefined }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      setMsg(`Saved ${j.written} value${j.written === 1 ? "" : "s"}${note ? " and a note" : ""}.`);
      setValues({}); setNote("");
      router.refresh();
    } catch (e) { setMsg(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(false); }
  };

  const addCustom = async () => {
    const key = custom.key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if (!key) return;
    await fetch("/api/log", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, values: {} }),
    });
    setExtra((e) => [...e, key]);
    setShowCustom(false);
    setCustom({ key: "", label: "", unit: "" });
    // The key materialises as a metric definition on first save with a value.
    setValues((v) => ({ ...v, [key]: "" }));
  };

  const grouped = metrics.reduce((a, m) => { (a[m.category] ||= []).push(m); return a; }, {} as Record<string, MetricDef[]>);

  return (
    <div className="space-y-5 rise">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Log</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
          Anything a device can&apos;t measure. Manual entries always win over synced values for the same day.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Section title="Today's entry" action={
          <input type="date" className="input w-auto text-xs" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
        }>
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((m) => (
              <label key={m.key} className="text-xs">
                <span className="mb-1 flex items-center justify-between">
                  <span className="label">{m.label}{m.unit ? ` (${m.unit})` : ""}</span>
                  {goalKeys.includes(m.key) ? <span className="chip text-[11px]" style={{ color: "var(--series-1)" }}>goal</span> : null}
                </span>
                <input
                  className="input num" type="number" step="any" inputMode="decimal"
                  placeholder={existing[m.key] ? `${fmtNum(existing[m.key].value, m.precision)} (${existing[m.key].source})` : "—"}
                  value={values[m.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [m.key]: e.target.value }))} />
              </label>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select className="input w-auto text-xs" value="" onChange={(e) => e.target.value && setExtra((x) => [...x, e.target.value])}>
              <option value="">+ Add another metric…</option>
              {Object.entries(grouped).map(([cat, items]) => (
                <optgroup key={cat} label={CATEGORY_LABELS[cat] ?? cat}>
                  {items.filter((m) => !fields.some((f) => f.key === m.key))
                    .map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                </optgroup>
              ))}
            </select>
            <button onClick={() => setShowCustom((s) => !s)} className="btn btn-ghost text-xs">Create custom metric</button>
          </div>

          {showCustom ? (
            <div className="mt-3 grid gap-2 rounded-lg p-3 sm:grid-cols-[1fr_1fr_auto]" style={{ background: "var(--surface-2)" }}>
              <input className="input" placeholder="Name (e.g. client calls)" value={custom.label}
                     onChange={(e) => setCustom({ ...custom, label: e.target.value, key: e.target.value })} />
              <input className="input" placeholder="Unit (optional)" value={custom.unit}
                     onChange={(e) => setCustom({ ...custom, unit: e.target.value })} />
              <button onClick={addCustom} className="btn">Add</button>
            </div>
          ) : null}

          <label className="mt-4 block text-xs">
            <span className="label mb-1 block">Note</span>
            <textarea className="input min-h-[80px] resize-y" value={note} placeholder="How the day went, what you changed, anything the numbers miss…"
                      onChange={(e) => setNote(e.target.value)} />
            <span className="mt-1 block text-[11px]" style={{ color: "var(--text-muted)" }}>
              Notes are given to the coach briefing as context.
            </span>
          </label>

          <div className="mt-4 flex items-center gap-3">
            <button onClick={save} disabled={busy} className="btn btn-primary">
              {busy ? <><Spinner /> Saving…</> : "Save entry"}
            </button>
            {msg ? <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{msg}</span> : null}
          </div>
        </Section>

        <div className="space-y-5">
          <Section title="Last 14 days" subtitle="Everything recorded, from every source">
            {!recent.length ? <Empty>Nothing yet.</Empty> : (
              <div className="max-h-[320px] space-y-3 overflow-y-auto pr-1">
                {Object.entries(recent.reduce((a, r) => { (a[r.date] ||= []).push(r); return a; }, {} as Record<string, typeof recent>))
                  .map(([d, rows]) => (
                    <div key={d}>
                      <div className="label mb-1.5">{fmtWeekday(d)}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {rows.map((r) => (
                          <span key={r.metric_key} className="chip num" style={{ color: "var(--text-secondary)" }}
                                title={`source: ${r.source}`}>
                            {byKey[r.metric_key]?.label ?? r.metric_key}{" "}
                            <b style={{ color: "var(--text-primary)" }}>
                              {fmtNum(Number(r.value), byKey[r.metric_key]?.precision ?? 1)}
                            </b>
                            {byKey[r.metric_key]?.unit}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </Section>

          <Section title="Journal" subtitle="Your own words, fed into the briefing">
            {!notes.length ? <Empty>No notes yet.</Empty> : (
              <ul className="max-h-[260px] space-y-2.5 overflow-y-auto pr-1 text-xs">
                {notes.map((n) => (
                  <li key={n.id}>
                    <div className="num" style={{ color: "var(--text-muted)" }}>{n.date}</div>
                    <p className="mt-0.5" style={{ color: "var(--text-secondary)" }}>{n.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

"use client";
import { useState, useMemo } from "react";
import type { MetricDef } from "@/lib/metric-meta";
import { CATEGORY_LABELS } from "@/lib/metric-meta";
import { SEMANTICS, STAT_TERMS } from "@/lib/semantics";
import { Section, Empty } from "@/components/ui";
import { fmtNum } from "@/components/charts";
import Link from "next/link";

export function GlossaryClient({ defs, counts }: { defs: MetricDef[]; counts: Record<string, number> }) {
  const [q, setQ] = useState("");
  const [onlyMine, setOnlyMine] = useState(true);

  const filtered = useMemo(() => {
    const needle = q.toLowerCase().trim();
    return defs.filter((d) => {
      if (onlyMine && !counts[d.key]) return false;
      if (!needle) return true;
      const s = SEMANTICS[d.key];
      return [d.key, d.label, d.category, s?.what, s?.read].filter(Boolean)
        .some((x) => String(x).toLowerCase().includes(needle));
    });
  }, [defs, counts, q, onlyMine]);

  const byCategory = useMemo(() => {
    const m: Record<string, MetricDef[]> = {};
    for (const d of filtered) (m[d.category] ||= []).push(d);
    return m;
  }, [filtered]);

  return (
    <div className="space-y-5 rise">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Glossary</h1>
        <p className="mt-1 max-w-2xl text-sm" style={{ color: "var(--text-secondary)" }}>
          What every number means, how it&apos;s measured, and how to read it. This is the same
          reference the AI reads before analysing your data, so its interpretations and these
          definitions can&apos;t drift apart.
        </p>
      </div>

      <div className="card-tight flex flex-wrap items-center gap-3">
        <input className="input max-w-xs" placeholder="Search metrics and terms…"
               value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-2 text-xs" style={{ color: "var(--text-secondary)" }}>
          <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
          Only metrics I have data for
        </label>
        <span className="ml-auto text-xs" style={{ color: "var(--text-muted)" }}>
          {filtered.length} metric{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

      <Section title="How the statistics work"
               subtitle="The techniques behind every claim this app makes">
        <div className="grid gap-3 sm:grid-cols-2">
          {Object.entries(STAT_TERMS).map(([k, v]) => (
            <div key={k} className="rounded-lg p-3" style={{ background: "var(--surface-2)" }}>
              <div className="text-sm font-semibold capitalize">{k.replace(/_/g, " ")}</div>
              <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>{v.what}</p>
              <p className="mt-1.5 text-xs" style={{ color: "var(--text-primary)" }}>{v.read}</p>
            </div>
          ))}
        </div>
      </Section>

      {!filtered.length ? (
        <Empty>Nothing matches that search.</Empty>
      ) : (
        Object.entries(byCategory).map(([cat, items]) => (
          <Section key={cat} title={CATEGORY_LABELS[cat] ?? cat}
                   subtitle={`${items.length} metric${items.length === 1 ? "" : "s"}`}>
            <div className="space-y-3">
              {items.map((d) => {
                const s = SEMANTICS[d.key];
                const n = counts[d.key] ?? 0;
                return (
                  <div key={d.key} className="rounded-xl p-4" style={{ background: "var(--surface-2)" }}>
                    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                      <h3 className="text-sm font-semibold">{d.label}</h3>
                      <code className="num text-[11px]" style={{ color: "var(--text-muted)" }}>{d.key}</code>
                      {d.unit ? <span className="chip text-[10px]" style={{ color: "var(--text-muted)" }}>{d.unit}</span> : null}
                      {d.higher_is_better !== null ? (
                        <span className="chip text-[10px]" style={{ color: "var(--text-muted)" }}>
                          {d.higher_is_better ? "higher is better" : "lower is better"}
                        </span>
                      ) : null}
                      <span className="ml-auto text-[11px] num" style={{ color: n ? "var(--text-secondary)" : "var(--text-muted)" }}>
                        {n ? `${fmtNum(n, 0)} readings` : "no data yet"}
                      </span>
                    </div>

                    {s ? (
                      <div className="mt-2 space-y-2 text-xs" style={{ color: "var(--text-secondary)" }}>
                        <p style={{ color: "var(--text-primary)" }}>{s.what}</p>
                        <p><b style={{ color: "var(--text-muted)" }}>Measured by </b>{s.how}</p>
                        <p><b style={{ color: "var(--text-muted)" }}>How to read it </b>{s.read}</p>
                        {s.typical ? <p><b style={{ color: "var(--text-muted)" }}>Typical </b>{s.typical}</p> : null}
                        {s.caveat ? (
                          <p className="rounded-lg px-2.5 py-2 bg-warning">
                            <b className="tone-warning">Careful. </b>{s.caveat}
                          </p>
                        ) : null}
                        <div className="flex flex-wrap gap-x-4 gap-y-1 pt-0.5">
                          {s.derivedFrom?.length ? (
                            <span><b style={{ color: "var(--text-muted)" }}>Computed from </b>{s.derivedFrom.join(", ")}</span>
                          ) : null}
                          {s.relatedTo?.length ? (
                            <span><b style={{ color: "var(--text-muted)" }}>Read alongside </b>{s.relatedTo.join(", ")}</span>
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
                        {d.is_custom
                          ? "Your own metric — it means whatever you decided it means when you created it."
                          : `${d.label}${d.unit ? `, measured in ${d.unit}` : ""}. No extended description written for this one yet.`}
                      </p>
                    )}

                    {n ? (
                      <Link href={`/analyze?metric=${d.key}`} className="mt-2.5 inline-block text-xs underline"
                            style={{ color: "var(--text-secondary)" }}>Analyse your data →</Link>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Section>
        ))
      )}
    </div>
  );
}

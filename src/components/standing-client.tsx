"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Section, Empty, Spinner } from "@/components/ui";
import { fmtNum } from "@/components/charts";

/** 1st, 2nd, 3rd, 4th ... 21st, 42nd, 53rd. */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

type Anchor = { p: number; value: number };
type Row = {
  label: string; unit?: string; value: number; percentile: number; band: string;
  capped: "low" | "high" | null; anchors: Anchor[]; higherIsBetter?: boolean;
  stale?: boolean; staleDays?: number;
  source?: string; population?: string; quality?: string; caveat?: string;
  exercise?: string; ratio?: number; e1rm?: number; bodyweight?: number;
};

export function StandingClient() {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/benchmarks")
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; })
      .then(setData)
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed to load"));
  }, []);

  if (err) return <Empty>{err}</Empty>;
  if (!data) return <div className="flex h-40 items-center justify-center" style={{ color: "var(--text-muted)" }}><Spinner size={20} /></div>;

  if (!data.ready) {
    return (
      <div className="mx-auto max-w-3xl space-y-5 rise">
        <Header />
        <Section title="Needs your age and sex">
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>{data.note}</p>
          <Link href="/settings" className="btn btn-primary mt-3">Add them in Settings</Link>
        </Section>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 rise">
      <Header decade={data.decade} sex={data.sex} />

      {data.lifts?.length ? (
        <Section title="Strength" subtitle={`Estimated 1RM per kg of bodyweight (${data.bodyweight}kg)`}>
          <div className="space-y-6">
            {data.lifts.map((l: Row & { lift: string }) => (
              <Row2 key={l.lift} row={l} display={`${l.ratio}×`} sub={`${l.e1rm}kg · ${l.exercise}`} />
            ))}
          </div>
          {data.liftSource ? <Provenance {...data.liftSource} /> : null}
        </Section>
      ) : null}

      {data.standings?.length ? (
        <Section title="Health and fitness" subtitle="28-day average against population reference data">
          <div className="space-y-6">
            {data.standings.map((s: Row) => (
              <div key={s.label}>
                <Row2 row={s} display={`${fmtNum(s.value, 1)}${s.unit ?? ""}`}
                      sub={s.stale ? `last recorded ${s.staleDays} days ago` : undefined} />
                <Provenance source={s.source!} population={s.population!} quality={s.quality!} caveat={s.caveat} compact />
              </div>
            ))}
          </div>
        </Section>
      ) : (
        <Section title="Health and fitness">
          <Empty>Not enough data yet for any benchmarked metric.</Empty>
        </Section>
      )}
    </div>
  );
}

function Header({ decade, sex }: { decade?: string; sex?: string } = {}) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Standing</h1>
      <p className="mt-1 max-w-2xl text-sm" style={{ color: "var(--text-secondary)" }}>
        {decade
          ? <>Where you sit against published reference data for {sex === "female" ? "women" : "men"} in their {decade}.</>
          : "Where you sit against published population reference data."}
      </p>
      <p className="mt-2 max-w-2xl text-[11px]" style={{ color: "var(--text-muted)" }}>
        This is not a rank against other users of this app. There is one user. Every figure below
        compares you to an external published cohort, and each states which cohort and from where.
      </p>
    </div>
  );
}

/**
 * A percentile is only as good as the anchors behind it, so every anchor is
 * labelled with the value it represents. "48th" alone is a claim; "48th, where
 * the 50th is 1.65x and the 75th is 2.20x" is something you can check.
 */
function Row2({ row, display, sub }: { row: Row; display: string; sub?: string }) {
  const p = row.percentile;
  const tone = p >= 75 ? "var(--status-good)" : p >= 40 ? "var(--series-1)" : "var(--status-warning)";
  const lower = row.higherIsBetter === false;

  const anchors = row.anchors;
  const lo = anchors[0].value, hi = anchors[anchors.length - 1].value;
  const span = hi - lo || 1;
  const you = row.ratio ?? row.value;
  const at = (v: number) => {
    const x = ((v - lo) / span) * 100;
    return Math.min(100, Math.max(0, lower ? 100 - x : x));
  };

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm font-semibold">{row.label}</span>
        <span className="flex items-baseline gap-2">
          <span className="num text-lg font-semibold">{display}</span>
          <span className="num text-sm font-semibold" style={{ color: tone }}>
            {row.capped === "high" ? "top 10%" : row.capped === "low" ? "bottom 10%" : ordinal(p)}
          </span>
          <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>{row.band}</span>
        </span>
      </div>
      {sub ? <div className="num mt-0.5 text-[11px]" style={{ color: "var(--text-muted)" }}>{sub}</div> : null}

      <div className="relative mt-3 mb-7 h-2">
        <div className="absolute inset-x-0 top-0.5 h-1 rounded-full" style={{ background: "var(--gridline)" }} />
        <div className="absolute top-0.5 h-1 rounded-full"
             style={{ width: `${at(you)}%`, background: tone }} />

        {anchors.map((a) => (
          <span key={a.p} className="absolute top-0 flex flex-col items-center"
                style={{ left: `${at(a.value)}%`, transform: "translateX(-50%)" }}>
            <span className="h-2 w-px" style={{ background: "var(--axis)" }} />
            <span className="num mt-1 text-[11px] leading-none" style={{ color: "var(--text-secondary)" }}>
              {a.value}
            </span>
            <span className="num mt-0.5 text-[11px] leading-none" style={{ color: "var(--text-muted)" }}>
              {a.p}th
            </span>
          </span>
        ))}

        {/* Your position, drawn over the scale so it is unmistakably yours. */}
        <span className="absolute -top-1 flex flex-col items-center"
              style={{ left: `${at(you)}%`, transform: "translateX(-50%)" }}>
          <span className="h-4 w-[3px] rounded-full" style={{ background: tone }} />
        </span>
      </div>
    </div>
  );
}

function Provenance({ source, population, quality, caveat, compact }: {
  source: string; population: string; quality: string; caveat?: string; compact?: boolean;
}) {
  return (
    <div className={compact ? "mt-1.5" : "mt-4"}>
      <details className="text-[11px]" style={{ color: "var(--text-muted)" }}>
        <summary className="cursor-pointer">
          {quality === "strong" ? "Strong reference" : "Indicative reference"} · where this comes from
        </summary>
        <div className="mt-1.5 space-y-1 rounded-lg p-2.5" style={{ background: "var(--surface-2)" }}>
          <p><b>Source </b>{source}</p>
          <p><b>Population </b>{population}</p>
          {caveat ? <p style={{ color: "var(--text-secondary)" }}><b>Careful </b>{caveat}</p> : null}
        </div>
      </details>
    </div>
  );
}

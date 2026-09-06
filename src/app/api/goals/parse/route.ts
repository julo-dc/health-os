import { route, bad } from "@/lib/api";
import { chatJson, llmEnabled } from "@/lib/openrouter";
import { getMetricDefs, getSeriesMulti, todayISO, addDays } from "@/lib/metrics";
import { PLAUSIBLE_RANGES, GOAL_KINDS, type MetricDef } from "@/lib/metric-meta";
import { mean, median } from "@/lib/analytics/stats";

export const maxDuration = 180;

type RawTarget = {
  metric_key: string; direction: string;
  target_value: number | null; weight: number; notes: string;
};
type ParsedGoal = {
  title: string; kind: string; description: string; target_date: string | null;
  targets: RawTarget[]; missing: string[];
};

/**
 * Turn "build my business and do a full recomp" into a structured, measurable goal.
 *
 * The model may only use metrics that already exist, and is shown each one's
 * recent *average* rather than its last reading — the latest value is often a
 * partial day (334 steps at 9am) and anchoring targets to it produces nonsense.
 * Everything it proposes is then checked: valid key, valid direction, absolute
 * value rather than a delta, inside the metric's plausible range, and actually
 * pointing the way the stated direction claims.
 */
export const POST = route(async (user, req) => {
  if (!llmEnabled()) throw bad("Set OPENROUTER_API_KEY to use natural-language goals.");
  const { text, targetDate } = await req.json();
  if (!text?.trim()) throw bad("Describe your goal first");

  const today = todayISO();
  const defs = await getMetricDefs(user.id);
  const keys = defs.map((d) => d.key);
  const series = await getSeriesMulti(user.id, keys, addDays(today, -90));

  type Stat = {
  def: MetricDef; n: number; recent: number | null; longer: number | null;
  lo: number | null; hi: number | null; lastDate: string | null;
};
  const stats = new Map<string, Stat>();
  for (const d of defs) {
    // Exclude today: a partial day drags every average down.
    const pts = (series[d.key] ?? []).filter((p) => p.date < today);
    const last14 = pts.filter((p) => p.date > addDays(today, -15)).map((p) => p.value);
    const vals = pts.map((p) => p.value);
    stats.set(d.key, {
      def: d, n: pts.length,
      recent: last14.length ? mean(last14) : null,
      longer: vals.length ? mean(vals) : null,
      lo: vals.length ? Math.min(...vals) : null,
      hi: vals.length ? Math.max(...vals) : null,
      lastDate: pts.length ? pts[pts.length - 1].date : null,
    });
  }

  const r = (n: number | null) => (n === null ? "?" : Math.abs(n) >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));
  const vocabulary = defs.map((d) => {
    const s = stats.get(d.key)!;
    const per = d.agg === "sum" ? " per day" : "";
    return s.n
      ? `${d.key} — ${d.label}${d.unit ? ` in ${d.unit}` : ""}${per} | last 14d avg ${r(s.recent)} | 90d avg ${r(s.longer)} | seen ${r(s.lo)}-${r(s.hi)} | ${s.n} readings`
      : `${d.key} — ${d.label}${d.unit ? ` in ${d.unit}` : ""}${per} | NO DATA YET`;
  }).join("\n");

  const parsed = await chatJson<ParsedGoal>([
    {
      role: "system",
      content:
`You convert a goal written in plain language into a measurable specification.

THE SINGLE MOST IMPORTANT RULE
target_value is the ABSOLUTE VALUE the metric should READ when the goal is met — never a change, never a delta, never a weekly total.
  Right: body_fat_pct decrease to 14   (they will weigh in at 14%)
  Wrong: body_fat_pct decrease to 5    (meaning "lose 5 points") — this is forbidden
Metrics marked "per day" are DAILY values. If the person thinks in weekly terms, divide.
  Right: deep_work_hours increase to 3   (3 hours on a typical day)
  Wrong: deep_work_hours increase to 15  (a weekly total) — forbidden

OTHER RULES
- metric_key MUST appear verbatim in the vocabulary. Never invent one.
- Anchor every target to the metric's "last 14d avg". The target must be a
  realistic move from there over the time available — a stretch, not a fantasy.
- The target must agree with its direction: an "increase" target is ABOVE the
  current average, a "decrease" target is BELOW it. Check each one.
- Strongly prefer metrics that have data. A metric marked NO DATA YET cannot be
  scored, so only include one if it is genuinely central — and list its key in "missing".
- Choose 3-6 targets. Cover every strand of the goal (e.g. business AND body).
- weight: 1-3, relative importance. The single most important target gets 3.
- kind: exactly one of ${GOAL_KINDS.join(", ")}.
- direction: exactly one of increase, decrease, maintain.
- today is ${today}. With no stated deadline, set target_date about 90 days out.

Return ONLY JSON:
{"title","kind","description","target_date","targets":[{"metric_key","direction","target_value","weight","notes"}],"missing":[]}
notes: one short sentence on why that target serves the goal.`,
    },
    {
      role: "user",
      content: `AVAILABLE METRICS:\n${vocabulary}\n\nMY GOAL: ${text}${targetDate ? `\nDEADLINE: ${targetDate}` : ""}`,
    },
  ], { maxTokens: 16000, temperature: 0.25, effort: "medium" });

  /* ── validate everything the model proposed ─────────────────────────── */
  const valid = new Set(keys);
  const warnings: string[] = [];
  const targets = (parsed.targets ?? []).filter((t) => {
    if (!valid.has(t.metric_key)) {
      warnings.push(`Dropped "${t.metric_key}" — not a metric you track.`);
      return false;
    }
    return true;
  }).map((t) => {
    const s = stats.get(t.metric_key)!;
    const dir = ["increase", "decrease", "maintain"].includes(t.direction) ? t.direction : "increase";
    let value = typeof t.target_value === "number" && Number.isFinite(t.target_value) ? t.target_value : null;
    const label = s.def.label;

    // A target outside what the metric can physically read is a delta in
    // disguise, or a weekly total mistaken for a daily one.
    const range = PLAUSIBLE_RANGES[t.metric_key];
    if (value !== null && range && (value < range[0] || value > range[1])) {
      warnings.push(`${label}: target ${value}${s.def.unit ?? ""} is outside the plausible range ${range[0]}-${range[1]} — check it isn't a weekly total or a "lose X" amount.`);
    }

    // Fall back to the 90-day average when nothing was logged recently —
    // a stale reading still anchors far better than nothing.
    const anchor = s.recent ?? s.longer;

    // Direction and target must agree, or the progress maths runs backwards.
    if (value !== null && anchor !== null && dir !== "maintain") {
      const wrongWay = dir === "increase" ? value <= anchor : value >= anchor;
      if (wrongWay) {
        warnings.push(`${label}: asks to ${dir} but the target (${r(value)}) is on the wrong side of your current ${r(anchor)}. Adjust it or flip the direction.`);
      }
    }

    // "Never logged" and "not logged lately" need different advice.
    if (s.n === 0) {
      warnings.push(`${label}: never logged, so this target can't be scored until you start recording it.`);
    } else if (s.recent === null) {
      const days = s.lastDate ? Math.round((Date.parse(today) - Date.parse(s.lastDate)) / 86_400_000) : null;
      warnings.push(`${label}: last recorded ${days !== null ? `${days} days ago` : "a while ago"} — log it more often or progress will be measured against stale data.`);
    }

    return {
      metric_key: t.metric_key,
      direction: dir,
      target_value: value,
      weight: Math.max(1, Math.min(3, Number(t.weight) || 1)),
      notes: String(t.notes ?? "").slice(0, 200),
      currentValue: s.recent ?? s.longer,
      stale: s.n > 0 && s.recent === null,
      unit: s.def.unit,
      label,
      hasData: s.n > 0,
    };
  });

  if (!targets.length) throw bad("Could not map that goal to any tracked metric. Try naming what you'd measure.");

  return {
    title: String(parsed.title ?? "").slice(0, 120) || "Untitled goal",
    kind: (GOAL_KINDS as readonly string[]).includes(parsed.kind) ? parsed.kind : "mixed",
    description: String(parsed.description ?? "").slice(0, 600),
    target_date: parsed.target_date ?? targetDate ?? addDays(today, 90),
    targets,
    missing: (parsed.missing ?? []).filter((m) => valid.has(m)),
    warnings,
  };
});

const r = (n: number | null) => (n === null ? "?" : Math.abs(n) >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));

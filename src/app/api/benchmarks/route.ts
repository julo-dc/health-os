import { route } from "@/lib/api";
import { sql } from "@/lib/db";
import { getSeriesMulti, todayISO, addDays } from "@/lib/metrics";
import { mean } from "@/lib/analytics/stats";
import {
  BENCHMARKS, LIFTS, LIFT_SOURCE, percentileFrom, anchorsFor, band, ageDecade, type Sex,
} from "@/lib/benchmarks";

export const maxDuration = 60;

export type Standing = {
  metric: string; label: string; unit: string;
  value: number; percentile: number; band: string;
  capped: "low" | "high" | null;
  anchors: { p: number; value: number }[];
  source: string; population: string; quality: "strong" | "indicative"; caveat?: string;
  higherIsBetter: boolean;
  lastDate: string; staleDays: number; stale: boolean;
};

/**
 * Where the person stands against published population reference data.
 *
 * Not a rank among other users of this app — there is exactly one. Every figure
 * is against an external reference cohort, matched on age and sex, and each
 * carries its source so the reader can judge how much it applies.
 */
export const GET = route(async (user) => {
  const [settings] = await sql<{ prefs: { age?: number; sex?: Sex } | null }[]>`
    SELECT prefs FROM settings WHERE user_id = ${user.id}`;
  const age = Number(settings?.prefs?.age) || null;
  const sex = settings?.prefs?.sex ?? null;

  if (!age || !sex) {
    return {
      ready: false,
      missing: [!age && "age", !sex && "sex"].filter(Boolean),
      note: "Population norms are stratified by age and sex; without both there is nothing meaningful to compare against.",
      standings: [], lifts: [],
    };
  }

  const today = todayISO();
  const keys = BENCHMARKS.map((b) => b.metric);
  // 180 days: these are slow-moving measures, and VO2max in particular is only
  // re-estimated after a qualifying run, so a 90-day window silently dropped it.
  const series = await getSeriesMulti(user.id, [...keys, "weight_kg"], addDays(today, -180));

  const standings: Standing[] = [];
  for (const b of BENCHMARKS) {
    const pts = (series[b.metric] ?? []).filter((p) => p.date < today);
    if (pts.length < 3) continue;
    // Compare a recent average, not a single reading: one bad night should not
    // move where you sit in a population.
    const recent = pts.slice(-28).map((p) => p.value);
    const value = mean(recent);
    const anchors = anchorsFor(b, sex, age);
    if (value === null || !anchors) continue;
    const lastDate = pts[pts.length - 1].date;
    const staleDays = Math.round((Date.parse(today) - Date.parse(lastDate)) / 86_400_000);

    const { percentile, capped } = percentileFrom(anchors, value, b.higherIsBetter);
    standings.push({
      metric: b.metric, label: b.label, unit: b.unit,
      value: Math.round(value * 10) / 10,
      percentile, band: band(percentile), capped,
      anchors: anchors.map(([p, v]) => ({ p, value: v })),
      source: b.source, population: b.population, quality: b.quality, caveat: b.caveat,
      higherIsBetter: b.higherIsBetter,
      // Surfaced rather than silently dropped: an old reading still says
      // something, but the reader should know how old it is.
      lastDate, staleDays, stale: staleDays > 45,
    });
  }

  // ── relative strength ────────────────────────────────────────────────────
  const weightPts = series.weight_kg ?? [];
  const bodyweight = weightPts.length ? weightPts[weightPts.length - 1].value : null;

  const best = await sql<{ exercise: string; e1rm: number }[]>`
    SELECT exercise, MAX(weight_kg * (1 + reps / 30.0)) AS e1rm
    FROM strength_sets
    WHERE user_id = ${user.id} AND weight_kg > 0 AND reps BETWEEN 1 AND 12
      AND date > ${addDays(today, -365)}
    GROUP BY exercise`;

  const lifts = bodyweight
    ? LIFTS.map((l) => {
        // Prefer a barbell variant; they are what the standards are set on.
        const matches = best.filter((b) => l.matches.test(b.exercise));
        const barbell = matches.filter((m) => /barbell/i.test(m.exercise));
        const pick = (barbell.length ? barbell : matches)
          .sort((a, b) => Number(b.e1rm) - Number(a.e1rm))[0];
        if (!pick) return null;
        const ratio = Number(pick.e1rm) / bodyweight;
        const { percentile, capped } = percentileFrom(l.anchors[sex], ratio, true);
        return {
          lift: l.lift, label: l.label, exercise: pick.exercise,
          e1rm: Math.round(Number(pick.e1rm) * 10) / 10,
          bodyweight: Math.round(bodyweight * 10) / 10,
          ratio: Math.round(ratio * 100) / 100,
          percentile, band: band(percentile), capped,
          anchors: l.anchors[sex].map(([p, v]) => ({ p, value: v })),
        };
      }).filter(Boolean)
    : [];

  return {
    ready: true,
    age, sex, decade: ageDecade(age),
    standings,
    lifts,
    liftSource: bodyweight ? LIFT_SOURCE : null,
    bodyweight,
  };
});

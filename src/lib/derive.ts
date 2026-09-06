import { sql } from "./db";
import { getSeriesMulti, upsertMetrics, toISO, type Point } from "./metrics";
import { sessionLoad, estimateMaxHr, trainingLoad, readinessSeries, bodyComposition } from "./analytics/load";
import { median } from "./analytics/stats";

/**
 * Recompute every metric that is a function of other metrics, and store it with
 * source='derived'. Runs after any ingest so the dashboard never has to derive
 * on read. Idempotent — safe to run as often as you like.
 */
export async function recomputeDerived(userId: number): Promise<{ written: number; parts: Record<string, number> }> {
  const parts: Record<string, number> = {};
  const rows: { date: string; key: string; value: number; source: string }[] = [];

  const base = await getSeriesMulti(userId, [
    "weight_kg", "body_fat_pct", "resting_hr", "hrv_ms", "sleep_hours", "avg_hr", "max_hr_daily",
  ]);

  // --- body composition ---
  const { lean, fat } = bodyComposition(base.weight_kg ?? [], base.body_fat_pct ?? []);
  for (const p of lean) rows.push({ date: p.date, key: "lean_mass_kg", value: p.value, source: "derived" });
  for (const p of fat) rows.push({ date: p.date, key: "fat_mass_kg", value: p.value, source: "derived" });
  parts.body_composition = lean.length + fat.length;

  // --- training load from workouts ---
  const allWorkouts = await sql<{
    date: Date; duration_min: number | null; avg_hr: number | null; max_hr: number | null;
    rpe: number | null; calories: number | null; type: string | null; source: string;
  }[]>`
    SELECT date, duration_min, avg_hr, max_hr, rpe, calories, type, source
    FROM workouts WHERE user_id = ${userId} ORDER BY date ASC`;

  /**
   * The same session often arrives twice: once auto-detected by the wearable and
   * once from the person's own log. Counting both doubles the training load and
   * inflates fitness, fatigue and injury risk together.
   *
   * Within a date and activity type, a logged session wins over an auto-detected
   * one — you know what you did; the watch guessed. Genuinely separate sessions
   * of *different* types on the same day are all kept.
   */
  type W = (typeof allWorkouts)[number];
  const SOURCE_RANK: Record<string, number> = { manual: 3, csv: 2, google_health: 1 };
  const groups = new Map<string, W[]>();
  for (const w of allWorkouts) {
    const family = (w.type ?? "other").toUpperCase().includes("STRENGTH") ? "STRENGTH" : (w.type ?? "other").toUpperCase();
    const k = `${toISO(w.date)}|${family}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(w);
  }
  const workouts: W[] = [];
  let deduped = 0;
  for (const list of groups.values()) {
    if (list.length === 1) { workouts.push(list[0]); continue; }
    const bestRank = Math.max(...list.map((w) => SOURCE_RANK[w.source] ?? 0));
    const kept = list.filter((w) => (SOURCE_RANK[w.source] ?? 0) === bestRank);
    deduped += list.length - kept.length;
    workouts.push(...kept);
  }
  parts.workouts_deduped = deduped;

  if (workouts.length) {
    const restingHr = median((base.resting_hr ?? []).map((p) => p.value)) ?? 55;
    // Sessions carry no max HR, so the highest daily peak from the heart-rate
    // rollup is the best observed maximum available for the intensity model.
    const observedMax = Math.max(0, ...(base.max_hr_daily ?? []).map((p) => p.value));
    const [profile] = await sql<{ prefs: { age?: number } | null }[]>`
      SELECT prefs FROM settings WHERE user_id = ${userId}`;
    const maxHr = estimateMaxHr(profile?.prefs?.age ?? null, observedMax || null);

    const byDate = new Map<string, { load: number; min: number }>();
    for (const w of workouts) {
      const d = toISO(w.date);
      const load = sessionLoad(
        {
          date: d,
          duration_min: w.duration_min !== null ? Number(w.duration_min) : null,
          avg_hr: w.avg_hr !== null ? Number(w.avg_hr) : null,
          max_hr: w.max_hr !== null ? Number(w.max_hr) : null,
          rpe: w.rpe !== null ? Number(w.rpe) : null,
          calories: w.calories !== null ? Number(w.calories) : null,
          type: w.type,
        },
        restingHr,
        maxHr
      );
      const cur = byDate.get(d) ?? { load: 0, min: 0 };
      cur.load += load;
      cur.min += Number(w.duration_min ?? 0);
      byDate.set(d, cur);
    }

    const daily = [...byDate.entries()]
      .map(([date, v]) => ({ date, load: v.load }))
      .sort((a, b) => a.date.localeCompare(b.date));

    for (const [date, v] of byDate) {
      rows.push({ date, key: "training_load", value: v.load, source: "derived" });
      if (v.min > 0) rows.push({ date, key: "workout_min", value: v.min, source: "derived" });
    }

    const ls = trainingLoad(daily);
    for (let i = 0; i < ls.dates.length; i++) {
      rows.push({ date: ls.dates[i], key: "ctl", value: ls.ctl[i], source: "derived" });
      rows.push({ date: ls.dates[i], key: "atl", value: ls.atl[i], source: "derived" });
      rows.push({ date: ls.dates[i], key: "tsb", value: ls.tsb[i], source: "derived" });
      if (ls.acwr[i] > 0) rows.push({ date: ls.dates[i], key: "acwr", value: ls.acwr[i], source: "derived" });
    }
    parts.training_load = ls.dates.length * 4;

    // --- readiness (needs form, so it comes after the load model) ---
    const tsbPoints: Point[] = ls.dates.map((d, i) => ({ date: d, value: ls.tsb[i] }));
    const readiness = readinessSeries({
      hrv: base.hrv_ms ?? [],
      restingHr: base.resting_hr ?? [],
      sleep: base.sleep_hours ?? [],
      tsb: tsbPoints,
    });
    for (const r of readiness) rows.push({ date: r.date, key: "readiness", value: r.value, source: "derived" });
    parts.readiness = readiness.length;
  } else {
    const readiness = readinessSeries({
      hrv: base.hrv_ms ?? [],
      restingHr: base.resting_hr ?? [],
      sleep: base.sleep_hours ?? [],
    });
    for (const r of readiness) rows.push({ date: r.date, key: "readiness", value: r.value, source: "derived" });
    parts.readiness = readiness.length;
  }

  // --- strength training, from set-level rows ---
  const strength = await sql<{
    date: string; volume: number | null; sets: number; reps: number | null;
    hard: number; top: number | null;
  }[]>`
    SELECT date::text,
           SUM(weight_kg * reps)                              AS volume,
           COUNT(*)::int                                      AS sets,
           SUM(reps)                                          AS reps,
           COUNT(*) FILTER (WHERE rpe >= 7)::int              AS hard,
           MAX(weight_kg)                                     AS top
    FROM strength_sets WHERE user_id = ${userId}
    GROUP BY date ORDER BY date`;

  for (const r of strength) {
    if (r.volume) rows.push({ date: r.date, key: "training_volume_kg", value: Number(r.volume), source: "derived" });
    if (r.sets) rows.push({ date: r.date, key: "sets_count", value: r.sets, source: "derived" });
    if (r.reps) rows.push({ date: r.date, key: "reps_total", value: Number(r.reps), source: "derived" });
    if (r.hard) rows.push({ date: r.date, key: "hard_sets", value: r.hard, source: "derived" });
    if (r.top) rows.push({ date: r.date, key: "top_set_kg", value: Number(r.top), source: "derived" });
  }
  parts.strength = strength.length * 4;

  /**
   * Strength index: the sum of estimated one-rep maxes across the person's main
   * lifts, carried forward between sessions.
   *
   * This is the number that answers "am I holding strength while losing fat?",
   * which raw volume cannot — volume falls when you deload and rises when you do
   * more junk sets. e1RM uses Epley (w x (1 + reps/30)), capped at 12 reps where
   * the formula stops being meaningful.
   */
  const e1rm = await sql<{ date: string; exercise: string; best: number }[]>`
    WITH main AS (
      SELECT exercise FROM strength_sets
      WHERE user_id = ${userId} AND weight_kg > 0 AND reps BETWEEN 1 AND 12
      GROUP BY exercise ORDER BY COUNT(*) DESC LIMIT 6
    )
    SELECT date::text, s.exercise, MAX(s.weight_kg * (1 + s.reps / 30.0)) AS best
    FROM strength_sets s JOIN main ON main.exercise = s.exercise
    WHERE s.user_id = ${userId} AND s.weight_kg > 0 AND s.reps BETWEEN 1 AND 12
    GROUP BY date, s.exercise ORDER BY date`;

  if (e1rm.length) {
    const best = new Map<string, number>();     // exercise -> latest e1RM
    const byDate = new Map<string, number>();
    for (const r of e1rm) {
      // Keep the best-ever per lift so a light day doesn't read as regression.
      best.set(r.exercise, Math.max(best.get(r.exercise) ?? 0, Number(r.best)));
      byDate.set(r.date, [...best.values()].reduce((a, b) => a + b, 0));
    }
    for (const [date, v] of byDate) {
      rows.push({ date, key: "strength_index", value: v, source: "derived" });
    }
    parts.strength_index = byDate.size;
  }

  const written = await upsertMetrics(userId, rows);
  return { written, parts };
}

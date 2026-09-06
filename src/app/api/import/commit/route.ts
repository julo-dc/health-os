import { route, bad } from "@/lib/api";
import { sql } from "@/lib/db";
import { parseCsv, parseDate, parseNumber } from "@/lib/csv";
import { applyTransform, type ColumnPlan, type ImportPlan } from "@/lib/csv-classify";
import { upsertMetrics, ensureMetricDef } from "@/lib/metrics";
import { recomputeDerived } from "@/lib/derive";

export const maxDuration = 120;

/** Apply a confirmed import plan. The plan is whatever the user approved in the
 *  UI — possibly edited from what the model proposed. */
export const POST = route(async (user, req) => {
  const form = await req.formData();
  const file = form.get("file");
  const planRaw = form.get("plan");
  if (!(file instanceof File)) throw bad("No file uploaded");
  if (typeof planRaw !== "string") throw bad("No import plan supplied");

  const plan = JSON.parse(planRaw) as ImportPlan;
  const { headers, rows } = parseCsv(await file.text());
  const col = (key: string) => plan.columns.findIndex((c) => c.metric === key);
  const dateCol = col("date");
  if (dateCol < 0) throw bad("Map one column to 'date' before importing.");

  const idx = (h: string) => headers.indexOf(h);
  const valueOf = (r: string[], c: ColumnPlan): number | null => {
    const raw = r[idx(c.header)];
    if (raw === undefined) return null;
    const n = parseNumber(raw);
    return n === null ? null : applyTransform(n, c.transform, c.scale);
  };

  /* ── workouts ─────────────────────────────────────────────────────────── */
  if (plan.kind === "workouts") {
    const byField = (k: string) => plan.columns.find((c) => c.metric === k);
    let n = 0, skipped = 0;

    for (const [i, r] of rows.entries()) {
      const date = parseDate(r[idx(plan.columns[dateCol].header)] ?? "");
      if (!date) { skipped++; continue; }
      const numField = (k: string) => { const c = byField(k); return c ? valueOf(r, c) : null; };
      const strField = (k: string) => { const c = byField(k); return c ? (r[idx(c.header)] ?? "").trim() || null : null; };

      await sql`
        INSERT INTO workouts (user_id, start_time, date, type, name, duration_min, distance_km,
                              avg_hr, max_hr, calories, elevation_m, rpe, source, external_id)
        VALUES (${user.id}, NULL, ${date}, ${strField("type")}, ${strField("name")},
                ${numField("duration_min")}, ${numField("distance_km")}, ${numField("avg_hr")},
                ${numField("max_hr")}, ${numField("calories")}, ${numField("elevation_m")},
                ${numField("rpe")}, 'csv', ${`csv:${file.name}:${date}:${i}`.slice(0, 200)})
        ON CONFLICT (user_id, source, external_id) DO UPDATE SET
          duration_min = EXCLUDED.duration_min, distance_km = EXCLUDED.distance_km,
          avg_hr = EXCLUDED.avg_hr, max_hr = EXCLUDED.max_hr, calories = EXCLUDED.calories,
          rpe = EXCLUDED.rpe, type = EXCLUDED.type, name = EXCLUDED.name`;
      n++;
    }
    const derived = await recomputeDerived(user.id);
    await log(user.id, file.name, n);
    return { ok: true, kind: "workouts", workouts: n, skipped, derived: derived.written };
  }

  /* ── set-level strength log ───────────────────────────────────────────── */
  if (plan.kind === "sets") {
    const f = (k: string) => plan.columns.find((c) => c.metric === k);
    const dateC = plan.columns[dateCol];
    let n = 0, skipped = 0;

    for (const [i, r] of rows.entries()) {
      const rawDate = r[idx(dateC.header)] ?? "";
      const date = parseDate(rawDate);
      const exercise = f("exercise") ? (r[idx(f("exercise")!.header)] ?? "").trim() : "";
      if (!date || !exercise) { skipped++; continue; }

      const numOf = (k: string) => { const c = f(k); return c ? valueOf(r, c) : null; };
      const strOf = (k: string) => { const c = f(k); return c ? (r[idx(c.header)] ?? "").trim() || null : null; };
      const session = strOf("session_name");

      await sql`
        INSERT INTO strength_sets (user_id, date, started_at, session_name, exercise, set_order,
                                   weight_kg, reps, rpe, distance_km, duration_s, session_min, source, external_id)
        VALUES (${user.id}, ${date}, ${Date.parse(rawDate) ? new Date(rawDate) : null}, ${session},
                ${exercise}, ${numOf("set_order")}, ${numOf("weight_kg")}, ${numOf("reps")},
                ${numOf("rpe")}, ${numOf("distance_km")}, ${numOf("duration_s")}, ${numOf("session_min")},
                'csv', ${`csv:${file.name}:${i}`.slice(0, 200)})
        ON CONFLICT (user_id, source, external_id) DO UPDATE SET
          weight_kg = EXCLUDED.weight_kg, reps = EXCLUDED.reps, rpe = EXCLUDED.rpe,
          exercise = EXCLUDED.exercise, set_order = EXCLUDED.set_order`;
      n++;
    }

    const sessions = await materialiseStrengthSessions(user.id);
    const derived = await recomputeDerived(user.id);
    await log(user.id, file.name, n);
    return { ok: true, kind: "sets", sets: n, skipped, sessions, derived: derived.written };
  }

  /* ── daily metrics ────────────────────────────────────────────────────── */
  // Materialise any metric the plan proposes that we don't already have.
  for (const c of plan.columns) {
    if (!c.metric || c.metric === "date") continue;
    await ensureMetricDef(user.id, c.metric, c.isNew && c.newMetric ? {
      label: c.newMetric.label, unit: c.newMetric.unit, category: c.newMetric.category,
      higher_is_better: c.newMetric.higher_is_better, agg: c.newMetric.agg, precision: c.newMetric.precision,
    } : {});
  }

  const out: { date: string; key: string; value: number; source: string }[] = [];
  const badDates: string[] = [];
  for (const r of rows) {
    const date = parseDate(r[idx(plan.columns[dateCol].header)] ?? "");
    if (!date) { if (badDates.length < 5) badDates.push(r[idx(plan.columns[dateCol].header)] ?? "(empty)"); continue; }
    for (const c of plan.columns) {
      if (!c.metric || c.metric === "date") continue;
      const v = valueOf(r, c);
      if (v !== null) out.push({ date, key: c.metric, value: v, source: "csv" });
    }
  }

  const written = await upsertMetrics(user.id, out);
  const derived = await recomputeDerived(user.id);
  await log(user.id, file.name, written);

  const dates = out.map((r) => r.date).sort();
  return {
    ok: true, kind: "metrics", written, derived: derived.written,
    metrics: [...new Set(out.map((r) => r.key))],
    dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    skippedSample: badDates,
  };
});

/**
 * Roll set rows up into one workout per session so the training-load model sees
 * lifting alongside cardio. Session length repeats on every row of a workout, so
 * it is taken once per session rather than summed.
 */
async function materialiseStrengthSessions(userId: number): Promise<number> {
  const rows = await sql<{ date: string; session_name: string | null; mins: number | null; sets: number; started: Date | null }[]>`
    SELECT date::text, session_name,
           MAX(session_min) AS mins,           -- repeats per row: take it once
           COUNT(*)::int    AS sets,
           MIN(started_at)  AS started
    FROM strength_sets WHERE user_id = ${userId}
    GROUP BY date, session_name`;

  let n = 0;
  for (const r of rows) {
    // A logged session length past 4 hours is almost always a timer left
    // running, not training. Fall back to the set count in that case rather
    // than letting it dominate the load model.
    const estimate = Math.min(Math.max(r.sets * 3, 20), 180);
    const duration = r.mins && r.mins > 0 && r.mins <= 240 ? r.mins : estimate;
    await sql`
      INSERT INTO workouts (user_id, start_time, date, type, name, duration_min, source, external_id)
      VALUES (${userId}, ${r.started}, ${r.date}, 'STRENGTH_TRAINING',
              ${r.session_name ?? "Strength session"}, ${duration}, 'csv',
              ${`sets:${r.date}:${r.session_name ?? ""}`.slice(0, 200)})
      ON CONFLICT (user_id, source, external_id) DO UPDATE SET
        duration_min = EXCLUDED.duration_min, name = EXCLUDED.name`;
    n++;
  }
  return n;
}

async function log(userId: number, filename: string, rows: number) {
  await sql`INSERT INTO sync_log (user_id, provider, data_type, ok, rows)
            VALUES (${userId}, 'csv', ${filename}, true, ${rows})`;
}

/**
 * Seeds a realistic ~6 months of correlated demo data so you can see the app
 * working before connecting anything real.
 * Runs through the app's own ingest + derive pipeline, so it exercises the
 * real code paths rather than writing rows straight to the tables.
 */
import { migrate, sql } from "../src/lib/db";
import { upsertMetrics, addDays } from "../src/lib/metrics";
import { seedMetricDefs } from "../src/lib/metrics";
import { recomputeDerived } from "../src/lib/derive";

const rnd = (() => { let s = 42; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 0.8;

async function main() {
  // This writes ~4,000 fabricated readings. Guarded so it can never be run
  // against a database holding real data by accident.
  if (!process.env.SEED_DEMO_EMAIL) {
    console.error(
      "Refusing to run.\n\n" +
      "This seeds fabricated demo data. To use it on a throwaway database:\n" +
      "  SEED_DEMO_EMAIL=you@example.com npm run seed\n"
    );
    process.exit(1);
  }
  const email = process.env.SEED_DEMO_EMAIL;
  await migrate();
  const [u] = await sql<{ id: number }[]>`
    INSERT INTO users (email, name) VALUES (${email}, 'Demo')
    ON CONFLICT (email) DO UPDATE SET name = users.name RETURNING id`;
  const uid = u.id;
  await seedMetricDefs(uid);
  await sql`INSERT INTO settings (user_id, prefs) VALUES (${uid}, '{"age":31}'::jsonb)
            ON CONFLICT (user_id) DO UPDATE SET prefs = '{"age":31}'::jsonb`;
  await sql`DELETE FROM metrics WHERE user_id = ${uid}`;
  await sql`DELETE FROM workouts WHERE user_id = ${uid}`;
  await sql`DELETE FROM goals WHERE user_id = ${uid}`;

  const today = new Date().toISOString().slice(0, 10);
  const N = 186;
  const start = addDays(today, -N);

  const rows: { date: string; key: string; value: number; source: string }[] = [];
  const push = (date: string, key: string, value: number) =>
    rows.push({ date, key, value: Math.round(value * 1000) / 1000, source: "google_health" });

  let sleepPrev = 7.1;
  const workouts: any[] = [];

  for (let i = 0; i <= N; i++) {
    const date = addDays(start, i);
    const t = i / N;
    const dow = new Date(date + "T00:00:00Z").getUTCDay();
    const weekend = dow === 0 || dow === 6;

    // Body recomp: fat down steadily, lean creeping up, with a plateau mid-way.
    const plateau = t > 0.45 && t < 0.62 ? 0.45 : t;
    const weight = 84.2 - 4.6 * plateau + gauss() * 0.55;
    const bf = 22.4 - 6.0 * plateau + gauss() * 0.5;
    if (i % 1 === 0) { push(date, "weight_kg", weight); push(date, "body_fat_pct", bf); }

    // Sleep: better on weekends, mild upward drift.
    const sleep = 6.8 + 0.5 * t + (weekend ? 0.7 : 0) + gauss() * 0.55;
    push(date, "sleep_hours", sleep);
    push(date, "sleep_efficiency", 86 + 4 * t + gauss() * 2.5);
    push(date, "deep_sleep_min", 62 + 18 * t + gauss() * 12);
    push(date, "rem_sleep_min", 88 + gauss() * 16);

    // Recovery markers respond to last night's sleep.
    const hrv = 44 + 20 * t + (sleep - 7) * 4.5 + gauss() * 5;
    push(date, "hrv_ms", hrv);
    push(date, "resting_hr", 58 - 6 * t - (sleep - 7) * 1.1 + gauss() * 1.8);
    push(date, "spo2_pct", 96.5 + gauss() * 0.7);
    push(date, "respiratory_rate", 14.5 + gauss() * 0.8);

    push(date, "steps", 8200 + 3200 * t + (weekend ? -1500 : 0) + gauss() * 1800);
    push(date, "calories_in", 2450 - 250 * t + gauss() * 260);
    push(date, "protein_g", 145 + 45 * t + gauss() * 20);
    push(date, "active_zone_min", Math.max(0, 28 + 22 * t + gauss() * 14));

    // Deep work depends on yesterday's sleep — the relationship the driver
    // analysis should recover.
    const deepWork = Math.max(0, (weekend ? 1.2 : 3.0) + 2.0 * t + (sleepPrev - 7) * 0.85 + gauss() * 0.7);
    push(date, "deep_work_hours", deepWork);
    push(date, "focus_score", Math.min(10, 5.6 + 2.0 * t + (sleepPrev - 7) * 0.7 + gauss() * 0.8));
    push(date, "mood", Math.min(10, 6.4 + 1.4 * t + gauss() * 0.9));
    push(date, "energy", Math.min(10, 6.0 + 1.6 * t + (sleepPrev - 7) * 0.6 + gauss() * 0.8));
    push(date, "stress", Math.max(1, 5.5 - 1.5 * t + gauss() * 1.1));
    if (dow === 1) push(date, "mrr", 4200 + 9800 * t + gauss() * 250);
    push(date, "revenue", Math.max(0, 180 + 520 * t + gauss() * 120));
    sleepPrev = sleep;

    // 4-5 sessions a week, harder as fitness builds.
    if ([1, 2, 4, 5, 6].includes(dow) && rnd() > 0.18) {
      const long = dow === 6;
      const dur = long ? 75 + rnd() * 60 : 42 + rnd() * 28;
      workouts.push({
        date, start_time: `${date}T07:30:00Z`,
        type: long ? "RUN" : rnd() > 0.5 ? "STRENGTH" : "CYCLE",
        name: long ? "Long run" : rnd() > 0.5 ? "Strength" : "Ride",
        duration_min: dur,
        distance_km: long ? 12 + rnd() * 8 : rnd() > 0.5 ? 6 + rnd() * 4 : null,
        avg_hr: 128 + 18 * t + rnd() * 14,
        max_hr: 168 + rnd() * 16,
        calories: dur * (7 + rnd() * 3),
        external_id: `seed:${date}`,
      });
    }
  }

  const n = await upsertMetrics(uid, rows);
  for (const w of workouts) {
    await sql`
      INSERT INTO workouts (user_id, start_time, date, type, name, duration_min, distance_km, avg_hr, max_hr, calories, source, external_id)
      VALUES (${uid}, ${w.start_time}, ${w.date}, ${w.type}, ${w.name}, ${w.duration_min},
              ${w.distance_km}, ${w.avg_hr}, ${w.max_hr}, ${w.calories}, 'google_health', ${w.external_id})
      ON CONFLICT (user_id, source, external_id) DO NOTHING`;
  }

  const [g] = await sql<{ id: number }[]>`
    INSERT INTO goals (user_id, title, kind, description, start_date, target_date, status)
    VALUES (${uid}, 'Build the business and complete a full recomp', 'mixed',
            'Grow MRR while dropping body fat and holding lean mass. Deep work is the input that drives both.',
            ${start}, ${addDays(today, 74)}, 'active') RETURNING id`;

  const targets: [string, string, number, number][] = [
    ["body_fat_pct", "decrease", 13, 3],
    ["lean_mass_kg", "increase", 67, 2],
    ["mrr", "increase", 20000, 3],
    ["deep_work_hours", "increase", 5.5, 2],
    ["hrv_ms", "increase", 72, 1],
  ];
  for (const [key, dir, target, weight] of targets) {
    await sql`INSERT INTO goal_targets (goal_id, metric_key, direction, target_value, weight)
              VALUES (${g.id}, ${key}, ${dir}, ${target}, ${weight})`;
  }

  await sql`INSERT INTO entries (user_id, date, kind, body) VALUES
    (${uid}, ${addDays(today, -4)}, 'note', 'Big launch week. Slept badly Tuesday, felt it Wednesday.'),
    (${uid}, ${addDays(today, -11)}, 'note', 'Added a third strength session. Legs wrecked but energy is good.')`;

  const d = await recomputeDerived(uid);
  console.log(`Seeded ${n} readings, ${workouts.length} workouts, ${d.written} derived values for user ${uid}.`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });

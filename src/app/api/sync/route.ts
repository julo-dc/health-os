import { route, bad } from "@/lib/api";
import { sql } from "@/lib/db";
import { getAccessToken } from "@/lib/auth";
import { upsertMetrics, addDays, todayISO } from "@/lib/metrics";
import { recomputeDerived } from "@/lib/derive";
import {
  ROLLUP_TYPES, DAILY_LIST_TYPES, SAMPLE_LIST_TYPES,
  fetchRollup, fetchDailyList, fetchSleep, fetchExercise,
} from "@/lib/googleHealth";

export const maxDuration = 60;

/**
 * Pull from the Google Health API. Each data type is fetched independently and
 * failures are logged per type rather than aborting the run — one unsupported
 * type must not cost you the other twenty.
 */
export const POST = route(async (user, req) => {
  const token = await getAccessToken(user.id);
  if (!token) throw bad("Google is not connected, or the refresh token expired. Reconnect in Settings.");

  const body = await req.json().catch(() => ({}));
  // Capped at 180 days per request: each data type paginates, and four of them
  // are limited to a 14-day window by Google, so a year would be hundreds of
  // round trips — more than a 60s function can finish. The client asks for
  // older ranges separately.
  const days = Math.min(Math.max(Number(body.days) || 90, 1), 180);
  const to = body.to && /^\d{4}-\d{2}-\d{2}$/.test(body.to) ? body.to : todayISO();
  const from = addDays(to, -days);
  const only: string[] | null = Array.isArray(body.types) && body.types.length ? body.types : null;

  type Result = { type: string; ok: boolean; rows: number; message?: string };
  const results: Result[] = [];
  let totalRows = 0;

  /** Run tasks with a concurrency cap — Google rate-limits, so not unbounded. */
  async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
    const queue = [...items];
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item !== undefined) await fn(item);
      }
    }));
  }

  const jobs: { type: string; run: () => Promise<number> }[] = [];
  for (const type of Object.keys(ROLLUP_TYPES)) {
    if (only && !only.includes(type)) continue;
    jobs.push({ type, run: async () => {
      const { rows } = await fetchRollup(token, type, from, to);
      return upsertMetrics(user.id, rows);
    }});
  }
  for (const type of [...Object.keys(DAILY_LIST_TYPES), ...Object.keys(SAMPLE_LIST_TYPES)]) {
    if (only && !only.includes(type)) continue;
    jobs.push({ type, run: async () => {
      const { rows } = await fetchDailyList(token, type, from, to);
      return upsertMetrics(user.id, rows);
    }});
  }
  if (!only || only.includes("sleep")) {
    jobs.push({ type: "sleep", run: async () => {
      const { rows } = await fetchSleep(token, from, to);
      return upsertMetrics(user.id, rows);
    }});
  }
  if (!only || only.includes("exercise")) {
    jobs.push({ type: "exercise", run: async () => {
      const workouts = await fetchExercise(token, from, to);
      if (!workouts.length) return 0;
      const batch = workouts.map((w) => ({
        user_id: user.id, start_time: w.start_time, date: w.date, type: w.type, name: w.name,
        duration_min: w.duration_min, distance_km: w.distance_km, avg_hr: w.avg_hr,
        max_hr: w.max_hr, calories: w.calories, elevation_m: w.elevation_m,
        source: "google_health", external_id: w.external_id, raw: sql.json(w.raw as never),
      }));
      // One statement instead of one per session.
      await sql`
        INSERT INTO workouts ${sql(batch, "user_id", "start_time", "date", "type", "name",
          "duration_min", "distance_km", "avg_hr", "max_hr", "calories", "elevation_m",
          "source", "external_id", "raw")}
        ON CONFLICT (user_id, source, external_id) DO UPDATE SET
          duration_min = EXCLUDED.duration_min, distance_km = EXCLUDED.distance_km,
          avg_hr = EXCLUDED.avg_hr, calories = EXCLUDED.calories`;
      return batch.length;
    }});
  }

  await pool(jobs, 5, async (job) => {
    try {
      const n = await job.run();
      totalRows += n;
      results.push({ type: job.type, ok: true, rows: n });
    } catch (e) {
      results.push({ type: job.type, ok: false, rows: 0, message: e instanceof Error ? e.message : String(e) });
    }
  });

  // One insert for the whole log. Previously each type awaited its own, inside
  // the catch handler — so a failure to log aborted the remaining sync.
  if (results.length) {
    await sql`
      INSERT INTO sync_log ${sql(results.map((r) => ({
        user_id: user.id, provider: "google_health", data_type: r.type,
        ok: r.ok, rows: r.rows, message: r.message ?? null,
      })), "user_id", "provider", "data_type", "ok", "rows", "message")}`;
  }

  const derived = await recomputeDerived(user.id);
  const failed = results.filter((r) => !r.ok);
  const succeeded = results.filter((r) => r.ok);

  return {
    ok: true,
    range: { from, to },
    metricsWritten: totalRows,
    derived: derived.written,
    results: results.sort((a, b) => Number(b.ok) - Number(a.ok) || b.rows - a.rows),
    diagnosis: diagnose(failed, succeeded.length),
    summary: `${totalRows} readings from ${succeeded.length} data types` +
      (failed.length ? `, ${failed.length} unavailable` : ""),
  };
});

export type SyncDiagnosis = {
  severity: "error" | "warning";
  title: string;
  detail: string;
  actionUrl?: string;
  actionLabel?: string;
};

/**
 * Turn a pile of raw API failures into the one thing the user actually has to do.
 *
 * When every data type fails it is almost always a single account-level cause —
 * an API that was never enabled, a scope that wasn't granted, a lapsed token —
 * and reporting "21 unavailable" buries that behind noise. Google's own error
 * text carries the fix, including the exact console URL, so lift it out.
 */
function diagnose(
  failed: { type: string; message?: string }[],
  okCount: number
): SyncDiagnosis | null {
  if (!failed.length) return null;
  const blob = failed.map((f) => f.message ?? "").join("\n");
  const allFailed = okCount === 0;

  // The API was never switched on for this Cloud project.
  if (/has not been used in project|is disabled/i.test(blob)) {
    const url = blob.match(/https:\/\/console\.developers\.google\.com\/apis\/api\/health\.googleapis\.com\/overview\?project=\d+/)?.[0];
    const project = blob.match(/project (\d+)/)?.[1];
    return {
      severity: "error",
      title: "The Google Health API isn't enabled on your Google Cloud project.",
      detail:
        `Signing in worked, but the API itself is switched off${project ? ` for project ${project}` : ""}, ` +
        `so every request is refused. Enable it, wait a minute for it to propagate, then sync again.`,
      actionUrl: url ?? "https://console.cloud.google.com/apis/library/health.googleapis.com",
      actionLabel: "Enable the Google Health API",
    };
  }

  // Consent lapsed or was revoked.
  if (/\b401\b|UNAUTHENTICATED|invalid_grant|Invalid Credentials/i.test(blob)) {
    return {
      severity: "error",
      title: "Your Google connection has expired.",
      detail:
        "Google caps refresh tokens at 7 days while your OAuth consent screen is in Testing status. " +
        "Reconnect to continue, or switch the app to In production to stop the clock.",
      actionUrl: "/api/auth/login",
      actionLabel: "Reconnect Google",
    };
  }

  // Signed in, API on, but the needed scopes were never granted.
  if (allFailed && /\b403\b|PERMISSION_DENIED|insufficient|scope/i.test(blob)) {
    return {
      severity: "error",
      title: "Google refused access to your health data.",
      detail:
        "The API is reachable but your grant doesn't cover these scopes. Reconnect and accept every " +
        "permission on the consent screen. Check the Data Access page of the Google Auth Platform lists all five Health scopes.",
      actionUrl: "/api/auth/login",
      actionLabel: "Reconnect and grant scopes",
    };
  }

  // Everything worked except a handful — almost always types you have no data for.
  if (!allFailed) {
    return {
      severity: "warning",
      title: `${failed.length} data ${failed.length === 1 ? "type" : "types"} returned nothing.`,
      detail:
        `Usually this just means your account has no data of that kind: ` +
        failed.slice(0, 6).map((f) => f.type).join(", ") +
        (failed.length > 6 ? `, and ${failed.length - 6} more.` : "."),
    };
  }

  return {
    severity: "error",
    title: "Every data type failed to sync.",
    detail: (failed[0].message ?? "No error detail was returned.").slice(0, 300),
  };
}

/**
 * Google Health API client (health.googleapis.com/v4).
 *
 * The cloud successor to the Google Fit REST API (closed to new signups since
 * 2024-05-01, sunsetting end of 2026); it is what serves Fitbit data.
 *
 * Every request shape and response field below was verified against the live
 * API rather than inferred from the docs, which do not publish the inner value
 * shapes. Three of them are genuinely surprising:
 *   - CivilDateTime nests as { date: {year,month,day}, time: {...} }
 *   - sending `pageSize` on a rollup triggers a bogus INVALID_ROLLUP_QUERY_DURATION
 *   - list-type points carry their date at <valueKey>.date, not at the top level
 */
import { addDays, daysBetween } from "./metric-meta";

const BASE = "https://health.googleapis.com/v4";

/** Google caps the rollup window per data type. */
const MAX_WINDOW: Record<string, number> = {
  "heart-rate": 14, "active-minutes": 14, "total-calories": 14, "calories-in-heart-rate-zone": 14,
};
const DEFAULT_WINDOW = 90;

export type Row = { date: string; key: string; value: number; source: string; meta?: unknown };
type Out = { key: string; value: number };

/* ── value coercion ──────────────────────────────────────────────────────── */

/** Google encodes int64 as a string, and durations as "36120s". */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v !== "") {
    const d = v.endsWith("s") ? Number(v.slice(0, -1)) : Number(v);
    return Number.isFinite(d) ? d : null;
  }
  return null;
}
const secs = (v: unknown) => { const n = num(v); return n === null ? null : n; };

function emit(key: string, v: number | null, scale = (n: number) => n): Out[] {
  return v === null ? [] : [{ key, value: scale(v) }];
}

/* ── dailyRollUp data types ──────────────────────────────────────────────── */

export const ROLLUP_TYPES: Record<string, { valueKey: string; extract: (v: any) => Out[] }> = {
  steps: { valueKey: "steps", extract: (v) => emit("steps", num(v.countSum)) },

  distance: {
    valueKey: "distance",
    extract: (v) => emit("distance_km", num(v.millimetersSum), (n) => n / 1e6),
  },

  floors: { valueKey: "floors", extract: (v) => emit("floors", num(v.countSum)) },

  "heart-rate": {
    valueKey: "heartRate",
    extract: (v) => [
      ...emit("avg_hr", num(v.beatsPerMinuteAvg)),
      ...emit("max_hr_daily", num(v.beatsPerMinuteMax)),
      ...emit("min_hr_daily", num(v.beatsPerMinuteMin)),
    ],
  },

  // Split across one field per heart-rate zone; the headline number is their sum.
  "active-zone-minutes": {
    valueKey: "activeZoneMinutes",
    extract: (v) => {
      const zones = ["sumInFatBurnHeartZone", "sumInCardioHeartZone", "sumInPeakHeartZone"];
      const vals = zones.map((z) => num(v[z])).filter((n): n is number => n !== null);
      return vals.length ? [{ key: "active_zone_min", value: vals.reduce((a, b) => a + b, 0) }] : [];
    },
  },

  // Arrives as an array broken down by activity level.
  "active-minutes": {
    valueKey: "activeMinutes",
    extract: (v) => {
      const rows = v.activeMinutesRollupByActivityLevel ?? [];
      if (!Array.isArray(rows) || !rows.length) return [];
      const total = rows.reduce((a: number, r: any) => a + (num(r.activeMinutesSum) ?? 0), 0);
      const brisk = rows
        .filter((r: any) => r.activityLevel && r.activityLevel !== "LIGHT")
        .reduce((a: number, r: any) => a + (num(r.activeMinutesSum) ?? 0), 0);
      return [
        { key: "active_minutes", value: total },
        ...(brisk > 0 ? [{ key: "moderate_vigorous_min", value: brisk }] : []),
      ];
    },
  },

  "total-calories":       { valueKey: "totalCalories",      extract: (v) => emit("calories_out", num(v.kcalSum)) },
  "active-energy-burned": { valueKey: "activeEnergyBurned", extract: (v) => emit("active_calories", num(v.kcalSum)) },

  "sedentary-period": {
    valueKey: "sedentaryPeriod",
    extract: (v) => emit("sedentary_min", secs(v.durationSum), (n) => n / 60),
  },

  "nutrition-log": {
    valueKey: "nutritionLog",
    extract: (v) => [
      ...emit("calories_in", num(v.kcalSum)),
      ...emit("protein_g", num(v.proteinGramsSum)),
      ...emit("carbs_g", num(v.carbohydrateGramsSum ?? v.carbsGramsSum)),
      ...emit("fat_g", num(v.fatGramsSum)),
    ],
  },

  "hydration-log": {
    valueKey: "hydrationLog",
    extract: (v) => emit("water_l", num(v.millilitersSum), (n) => n / 1000),
  },
};

/* ── list types carrying one summary per day ─────────────────────────────── */

export const DAILY_LIST_TYPES: Record<string, { valueKey: string; extract: (v: any) => Out[] }> = {
  "daily-resting-heart-rate": {
    valueKey: "dailyRestingHeartRate",
    extract: (v) => emit("resting_hr", num(v.beatsPerMinute)),
  },
  "daily-heart-rate-variability": {
    valueKey: "dailyHeartRateVariability",
    extract: (v) => [
      ...emit("hrv_ms", num(v.averageHeartRateVariabilityMilliseconds)),
      ...emit("hrv_deep_ms", num(v.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds)),
    ],
  },
  "daily-oxygen-saturation": {
    valueKey: "dailyOxygenSaturation",
    extract: (v) => emit("spo2_pct", num(v.averagePercentage)),
  },
  "daily-respiratory-rate": {
    valueKey: "dailyRespiratoryRate",
    extract: (v) => emit("respiratory_rate", num(v.breathsPerMinute)),
  },
  "daily-vo2-max": {
    valueKey: "dailyVo2Max",
    extract: (v) => emit("vo2max", num(v.vo2Max)),
  },
};

/**
 * Sample-based list types. These are occasional measurements rather than daily
 * summaries — a weigh-in happens when it happens — so they come from the list
 * endpoint and carry their timestamp under sampleTime, not a plain date.
 */
export const SAMPLE_LIST_TYPES: Record<string, { valueKey: string; extract: (v: any) => Out[] }> = {
  weight:     { valueKey: "weight",   extract: (v) => emit("weight_kg", num(v.weightGrams), (n) => n / 1000) },
  "body-fat": { valueKey: "bodyFat",  extract: (v) => emit("body_fat_pct", num(v.percentage ?? v.bodyFatPercentage)) },
  height:     { valueKey: "height",   extract: (v) => emit("height_cm", num(v.heightMillimeters), (n) => n / 10) },
};

/* ── request helpers ─────────────────────────────────────────────────────── */

/** CivilDateTime: { date: {year,month,day}, time: {hours,minutes,seconds} }. */
function civil(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return { date: { year, month, day }, time: { hours: 0, minutes: 0, seconds: 0 } };
}

/** Read an ISO day out of any of the shapes Google uses for a civil date. */
function civilToISO(c: unknown): string | null {
  if (!c) return null;
  if (typeof c === "string") return /^\d{4}-\d{2}-\d{2}/.test(c) ? c.slice(0, 10) : null;
  const o = c as Record<string, any>;
  const d = o.date ?? o.civilTime?.date ?? o;   // {date:{...}} | sampleTime.civilTime.date | bare
  if (typeof d?.year === "number" && d.month && d.day) {
    return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  }
  return null;
}

async function call(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`, Accept: "application/json",
      "Content-Type": "application/json", ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path.split("?")[0]}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

/* ── fetchers ────────────────────────────────────────────────────────────── */

export async function fetchRollup(token: string, dataType: string, from: string, to: string) {
  const spec = ROLLUP_TYPES[dataType];
  if (!spec) throw new Error(`Unknown rollup data type: ${dataType}`);
  const window = MAX_WINDOW[dataType] ?? DEFAULT_WINDOW;
  const rows: Row[] = [];
  let sample: unknown = null;

  for (let start = from; daysBetween(start, to) >= 0; start = addDays(start, window)) {
    const chunkEnd = daysBetween(start, to) < window ? addDays(to, 1) : addDays(start, window);
    let pageToken: string | undefined;
    do {
      // NB: no pageSize — sending one makes the API reject the range as too long.
      const body: Record<string, unknown> = {
        range: { start: civil(start), end: civil(chunkEnd) },
        windowSizeDays: 1,
      };
      if (pageToken) body.pageToken = pageToken;

      const json = await call(token, `/users/me/dataTypes/${dataType}/dataPoints:dailyRollUp`, {
        method: "POST", body: JSON.stringify(body),
      });

      for (const p of json.rollupDataPoints ?? []) {
        const date = civilToISO(p.civilStartTime);
        const val = p[spec.valueKey];
        if (!date || val == null) continue;
        if (!sample) sample = { dataType, value: val };
        for (const o of spec.extract(val)) {
          rows.push({ date, key: o.key, value: o.value, source: "google_health" });
        }
      }
      pageToken = json.nextPageToken || undefined;
    } while (pageToken);
  }
  return { rows: dedupe(rows), sample };
}

export async function fetchDailyList(token: string, dataType: string, from: string, to: string) {
  const spec = DAILY_LIST_TYPES[dataType] ?? SAMPLE_LIST_TYPES[dataType];
  if (!spec) throw new Error(`Unknown list data type: ${dataType}`);
  const points = await listPoints(token, dataType, from, to);
  const rows: Row[] = [];
  let sample: unknown = null;

  for (const p of points) {
    const val = p[spec.valueKey];
    if (val == null) continue;
    const date = civilToISO(val.date) ?? civilToISO(val.sampleTime?.civilTime) ??
                 (typeof val.sampleTime?.physicalTime === "string" ? val.sampleTime.physicalTime.slice(0, 10) : null);
    if (!date || date < from || date > to) continue;
    if (!sample) sample = { dataType, point: p };
    for (const o of spec.extract(val)) {
      rows.push({ date, key: o.key, value: o.value, source: "google_health" });
    }
  }
  return { rows: dedupe(rows), sample };
}

/**
 * Sleep sessions -> nightly duration, efficiency, stage minutes, bedtime, naps.
 *
 * A night often has several records: a nap, or a CLASSIC record alongside the
 * STAGES one. Summing them produces 20-hour "nights", so the main sleep is
 * singled out (Fitbit flags it, and where it doesn't, the longest session wins)
 * and naps are tracked separately instead of being folded in or thrown away.
 *
 * Where Fitbit supplies its own summary, that is preferred over re-deriving
 * totals from the stage intervals.
 */
export async function fetchSleep(token: string, from: string, to: string) {
  const points = await listPoints(token, "sleep", from, to);

  type Session = {
    date: string; start: string; offsetSec: number; main: boolean;
    minutesAsleep: number; minutesInPeriod: number;
    deep: number; rem: number; light: number; awake: number;
  };
  const sessions: Session[] = [];
  let sample: unknown = null;

  for (const p of points) {
    const s = p.sleep;
    const iv = s?.interval;
    if (!iv?.startTime || !iv.endTime) continue;
    if (!sample) sample = p;

    const date = iv.endTime.slice(0, 10);            // attributed to the morning you wake
    if (date < from || date > to) continue;

    const spanMin = (Date.parse(iv.endTime) - Date.parse(iv.startTime)) / 60000;
    const sum = s.summary ?? {};
    const stageMin = (kind: string) => {
      const fromSummary = (sum.stagesSummary ?? []).find((x: any) => String(x.type).toUpperCase() === kind);
      if (fromSummary) return num(fromSummary.minutes) ?? 0;
      return (s.stages ?? [])
        .filter((st: any) => String(st.type ?? "").toUpperCase() === kind && st.startTime && st.endTime)
        .reduce((a: number, st: any) => a + (Date.parse(st.endTime) - Date.parse(st.startTime)) / 60000, 0);
    };

    sessions.push({
      date,
      start: iv.startTime,
      offsetSec: secs(iv.startUtcOffset) ?? 0,
      main: s.metadata?.mainSleep === true,
      minutesAsleep: num(sum.minutesAsleep) ?? spanMin,
      minutesInPeriod: num(sum.minutesInSleepPeriod) ?? spanMin,
      deep: stageMin("DEEP"), rem: stageMin("REM"),
      light: stageMin("LIGHT"), awake: stageMin("AWAKE"),
    });
  }

  const byDate = new Map<string, Session[]>();
  for (const s of sessions) {
    const list = byDate.get(s.date) ?? [];
    list.push(s);
    byDate.set(s.date, list);
  }

  const rows: Row[] = [];
  for (const [date, list] of byDate) {
    // Fitbit's own flag first; otherwise the longest session is the real night.
    const main = list.find((s) => s.main)
      ?? [...list].sort((a, b) => b.minutesAsleep - a.minutesAsleep)[0];
    // Fitbit often returns a CLASSIC record alongside the STAGES one for the
    // same night. Those overlap the main sleep and are duplicates, not naps —
    // counting them produced six-hour "naps".
    const mainStart = Date.parse(main.start);
    const mainEnd = mainStart + main.minutesInPeriod * 60000;
    const naps = list.filter((s) => {
      if (s === main) return false;
      const st = Date.parse(s.start);
      const en = st + s.minutesInPeriod * 60000;
      const overlap = Math.min(mainEnd, en) - Math.max(mainStart, st);
      return overlap <= 0 || overlap < 0.5 * (en - st);
    });

    if (main.minutesAsleep > 0) {
      rows.push({ date, key: "sleep_hours", value: main.minutesAsleep / 60, source: "google_health" });
    }
    if (main.minutesInPeriod > 0 && main.minutesAsleep > 0) {
      rows.push({
        date, key: "sleep_efficiency",
        value: Math.min(100, (main.minutesAsleep / main.minutesInPeriod) * 100),
        source: "google_health",
      });
    }
    if (main.deep > 0) rows.push({ date, key: "deep_sleep_min", value: main.deep, source: "google_health" });
    if (main.rem > 0) rows.push({ date, key: "rem_sleep_min", value: main.rem, source: "google_health" });
    if (main.awake > 0) rows.push({ date, key: "sleep_awake_min", value: main.awake, source: "google_health" });

    const napMin = naps.reduce((a, s) => a + s.minutesAsleep, 0);
    if (napMin > 0) rows.push({ date, key: "nap_min", value: napMin, source: "google_health" });

    // Bedtime in LOCAL time: startTime is UTC and the offset is what makes
    // 22:42Z on a +2h day read correctly as 00:42, not 22:42.
    const local = new Date(Date.parse(main.start) + main.offsetSec * 1000);
    let h = local.getUTCHours() + local.getUTCMinutes() / 60;
    if (h > 12) h -= 24;   // 23:30 -> -0.5, so bedtimes either side of midnight average sensibly
    rows.push({ date, key: "sleep_start_hour", value: h, source: "google_health" });
  }
  return { rows: dedupe(rows), sample };
}

/** Exercise sessions -> workout rows for the training-load model. */
export async function fetchExercise(token: string, from: string, to: string) {
  const points = await listPoints(token, "exercise", from, to);
  return points.map((p) => {
    const e = p.exercise ?? {};
    const iv = e.interval ?? {};
    const start: string | null = iv.startTime ?? null;
    const ms = e.metricsSummary ?? {};

    const activeMin = secs(e.activeDuration) !== null ? secs(e.activeDuration)! / 60 : null;
    const spanMin = start && iv.endTime ? (Date.parse(iv.endTime) - Date.parse(start)) / 60000 : null;
    // Auto-detected sessions occasionally carry a runaway duration (multi-day
    // "strength training"). Anything past 6 hours is a recording artefact, not a
    // workout, and letting it through inflates the whole training-load model.
    const raw = activeMin ?? spanMin;
    const duration_min = raw !== null && raw > 0 && raw <= 360 ? raw : null;

    return {
      external_id: String(p.name ?? "").split("/").pop() ?? null,
      start_time: start,
      date: (start ?? "").slice(0, 10),
      type: e.exerciseType ?? null,
      name: e.displayName ?? e.exerciseType ?? "Workout",
      duration_min,
      distance_km: num(ms.distanceMillimeters) !== null ? num(ms.distanceMillimeters)! / 1e6 : null,
      calories: num(ms.caloriesKcal),
      avg_hr: num(ms.averageHeartRateBeatsPerMinute),
      // The API exposes no per-session max HR; the daily heart-rate rollup
      // supplies the observed maximum the load model needs instead.
      max_hr: null as number | null,
      elevation_m: num(ms.elevationGainMeters),
      active_zone_min: num(ms.activeZoneMinutes),
      raw: p,
    };
  }).filter((w) => w.date && w.date >= from && w.date <= to && w.duration_min !== null);
}

async function listPoints(token: string, dataType: string, from: string, to: string) {
  const out: Record<string, any>[] = [];
  let pageToken: string | undefined;
  let guard = 0;
  do {
    const q = new URLSearchParams({ pageSize: "1000" });
    if (pageToken) q.set("pageToken", pageToken);
    const json = await call(token, `/users/me/dataTypes/${dataType}/dataPoints?${q}`);
    out.push(...(json.dataPoints ?? []));
    pageToken = json.nextPageToken || undefined;
  } while (pageToken && ++guard < 40);
  return out;
}

function dedupe(rows: Row[]): Row[] {
  const m = new Map<string, Row>();
  for (const r of rows) m.set(`${r.date}|${r.key}`, r);
  return [...m.values()];
}

export const ALL_SYNC_TYPES = [
  ...Object.keys(ROLLUP_TYPES).map((t) => ({ type: t, mode: "rollup" as const })),
  ...Object.keys(DAILY_LIST_TYPES).map((t) => ({ type: t, mode: "list" as const })),
  ...Object.keys(SAMPLE_LIST_TYPES).map((t) => ({ type: t, mode: "list" as const })),
  { type: "sleep", mode: "sleep" as const },
  { type: "exercise", mode: "exercise" as const },
];

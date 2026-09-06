/** Dependency-free CSV handling: RFC4180 parsing, type sniffing, header
 *  auto-mapping for common exports, and conversion to metric/workout rows. */

export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const clean = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const delimiter = sniffDelimiter(clean);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (!nonEmpty.length) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map((h) => h.trim());
  return { headers, rows: nonEmpty.slice(1) };
}

function sniffDelimiter(text: string): string {
  const line = text.slice(0, text.indexOf("\n") > 0 ? text.indexOf("\n") : 500);
  const counts = [",", ";", "\t", "|"].map((d) => [d, line.split(d).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0][1] > 1 ? counts.sort((a, b) => b[1] - a[1])[0][0] : ",";
}

/** Parse a wide range of date formats into ISO. Ambiguous d/m vs m/d is resolved
 *  in favour of day-first, matching UK/EU exports. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  const slash = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (slash) {
    let [, a, b, y] = slash;
    let year = Number(y);
    if (year < 100) year += year > 50 ? 1900 : 2000;
    let day = Number(a), month = Number(b);
    if (month > 12 && day <= 12) [day, month] = [month, day]; // clearly m/d
    if (month > 12 || day > 31) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return null;
}

/** Parse numbers tolerating thousands separators, units, and durations in
 *  "1:23:45", "1h 15min", "2h" or "45m" form. */
export function parseNumber(raw: string): number | null {
  const s = raw.trim();
  if (!s || /^(n\/?a|null|-|--)$/i.test(s)) return null;

  // Compound durations as lifting apps write them: "1h 15min", "2h", "45m".
  // Without this the non-numeric strip turns "1h 15min" into 115.
  const compound = s.match(/^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?)?$/i);
  if (compound && (compound[1] || compound[2] || compound[3]) && /[hms]/i.test(s)) {
    const h = Number(compound[1] ?? 0), m = Number(compound[2] ?? 0), sec = Number(compound[3] ?? 0);
    return h * 60 + m + sec / 60;   // minutes
  }

  const hms = s.match(/^(\d+):([0-5]?\d)(?::([0-5]?\d(?:\.\d+)?))?$/);
  if (hms) {
    const [, a, b, c] = hms;
    return c !== undefined
      ? Number(a) * 60 + Number(b) + Number(c) / 60   // h:mm:ss -> minutes
      : Number(a) + Number(b) / 60;                    // h:mm    -> hours
  }

  const cleaned = s.replace(/[^0-9.,\-+eE]/g, "");
  if (!cleaned) return null;
  // "1.234,56" (EU) vs "1,234.56" (US)
  const norm = /,\d{1,2}$/.test(cleaned) && !/\./.test(cleaned)
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : cleaned.replace(/,/g, "");
  const n = Number(norm);
  return Number.isFinite(n) ? n : null;
}

/** Header aliases seen across Fitbit, Strava, Garmin, Apple Health and Whoop exports. */
const ALIASES: Record<string, string[]> = {
  date: ["date", "day", "timestamp", "start time", "start_date", "start date", "activity date", "datetime", "time", "start_date_local", "cycle start time"],
  weight_kg: ["weight", "weight (kg)", "weight_kg", "body weight", "bodyweight", "mass"],
  body_fat_pct: ["fat", "body fat", "body fat %", "bodyfat", "body_fat", "fat %", "fat percentage"],
  steps: ["steps", "step count", "total steps", "daily steps"],
  resting_hr: ["resting heart rate", "resting hr", "rhr", "resting_heart_rate"],
  hrv_ms: ["hrv", "heart rate variability", "hrv (ms)", "rmssd", "heart rate variability (ms)"],
  sleep_hours: ["sleep", "sleep duration", "hours of sleep", "asleep time", "sleep (h)", "time asleep", "sleep hours"],
  sleep_efficiency: ["sleep efficiency", "efficiency", "sleep score", "sleep performance %"],
  deep_sleep_min: ["deep sleep", "minutes deep sleep", "deep (min)", "deep sleep duration"],
  rem_sleep_min: ["rem sleep", "minutes rem sleep", "rem (min)", "rem sleep duration"],
  calories_out: ["calories burned", "calories out", "total calories", "energy burned", "active calories"],
  calories_in: ["calories", "calories in", "energy", "kcal", "calories consumed"],
  protein_g: ["protein", "protein (g)", "protein_g"],
  carbs_g: ["carbs", "carbohydrates", "carbs (g)"],
  fat_g: ["fat (g)", "fat_g", "total fat"],
  distance_km: ["distance", "distance (km)", "distance_km", "total distance"],
  vo2max: ["vo2 max", "vo2max", "vo2_max", "cardio fitness score"],
  spo2_pct: ["spo2", "oxygen saturation", "spo2 %", "blood oxygen"],
  active_zone_min: ["active zone minutes", "azm", "zone minutes"],
  mood: ["mood", "mood score", "feeling"],
  energy: ["energy", "energy level"],
  stress: ["stress", "stress level", "stress score"],
  focus_score: ["focus", "focus score", "concentration"],
  deep_work_hours: ["deep work", "deep work hours", "focus hours", "focused time"],
  revenue: ["revenue", "sales", "income", "mrr delta"],
  mrr: ["mrr", "monthly recurring revenue"],
  waist_cm: ["waist", "waist (cm)", "waist circumference"],
};

const WORKOUT_ALIASES: Record<string, string[]> = {
  type: ["activity type", "type", "sport", "activity", "workout type", "exercise"],
  name: ["activity name", "name", "title", "description"],
  duration_min: ["duration", "elapsed time", "moving time", "time", "total time", "duration (min)", "activity duration"],
  distance_km: ["distance", "distance (km)", "total distance"],
  avg_hr: ["average heart rate", "avg hr", "average hr", "heart rate average", "avg heart rate"],
  max_hr: ["max heart rate", "max hr", "maximum heart rate"],
  calories: ["calories", "calories burned", "energy"],
  elevation_m: ["elevation gain", "total ascent", "elevation", "ascent"],
  rpe: ["rpe", "perceived exertion", "effort", "relative effort"],
};

const norm = (s: string) => s.toLowerCase().trim().replace(/[_\s]+/g, " ").replace(/["']/g, "");

/** Best-guess mapping from CSV headers to canonical keys. The UI shows this as
 *  a pre-filled mapping the user can correct — never applied silently. */
export function autoMap(headers: string[], kind: "metrics" | "workouts" = "metrics"): Record<string, string> {
  const table = kind === "workouts" ? { ...WORKOUT_ALIASES, date: ALIASES.date } : ALIASES;
  const map: Record<string, string> = {};
  const used = new Set<string>();

  for (const [key, aliases] of Object.entries(table)) {
    const hit = headers.find((h) => !used.has(h) && aliases.includes(norm(h)));
    if (hit) { map[hit] = key; used.add(hit); }
  }
  // second pass: substring match for anything still unclaimed
  for (const [key, aliases] of Object.entries(table)) {
    if (Object.values(map).includes(key)) continue;
    const hit = headers.find((h) => !used.has(h) && aliases.some((a) => norm(h).includes(a)));
    if (hit) { map[hit] = key; used.add(hit); }
  }
  return map;
}

export type ColumnProfile = {
  header: string;
  suggested: string | null;
  numericRatio: number;
  dateRatio: number;
  sample: string[];
};

export function profileColumns(headers: string[], rows: string[][], kind: "metrics" | "workouts" = "metrics"): ColumnProfile[] {
  const auto = autoMap(headers, kind);
  const sampleRows = rows.slice(0, 200);
  return headers.map((h, i) => {
    const vals = sampleRows.map((r) => r[i] ?? "").filter((v) => v.trim() !== "");
    const numeric = vals.filter((v) => parseNumber(v) !== null).length;
    const dates = vals.filter((v) => parseDate(v) !== null).length;
    return {
      header: h,
      suggested: auto[h] ?? null,
      numericRatio: vals.length ? numeric / vals.length : 0,
      dateRatio: vals.length ? dates / vals.length : 0,
      sample: vals.slice(0, 3),
    };
  });
}

/** Apply a mapping to produce metric rows. Unmapped columns are ignored. */
export function toMetricRows(
  headers: string[],
  rows: string[][],
  mapping: Record<string, string>,
  source = "csv"
) {
  const dateCol = headers.findIndex((h) => mapping[h] === "date");
  if (dateCol < 0) throw new Error("No column is mapped to 'date'.");

  const out: { date: string; key: string; value: number; source: string }[] = [];
  const skipped: string[] = [];

  for (const r of rows) {
    const date = parseDate(r[dateCol] ?? "");
    if (!date) { if (skipped.length < 5) skipped.push(r[dateCol] ?? "(empty)"); continue; }
    headers.forEach((h, i) => {
      const key = mapping[h];
      if (!key || key === "date" || key === "-") return;
      const v = parseNumber(r[i] ?? "");
      if (v !== null) out.push({ date, key, value: v, source });
    });
  }
  return { rows: out, skipped };
}

/** Apply a mapping to produce workout rows. */
export function toWorkoutRows(
  headers: string[],
  rows: string[][],
  mapping: Record<string, string>,
  source = "csv"
) {
  const col = (key: string) => headers.findIndex((h) => mapping[h] === key);
  const dateCol = col("date");
  if (dateCol < 0) throw new Error("No column is mapped to 'date'.");

  const num = (r: string[], key: string) => {
    const i = col(key);
    return i >= 0 ? parseNumber(r[i] ?? "") : null;
  };
  const str = (r: string[], key: string) => {
    const i = col(key);
    return i >= 0 ? (r[i] ?? "").trim() || null : null;
  };

  return rows.flatMap((r, idx) => {
    const date = parseDate(r[dateCol] ?? "");
    if (!date) return [];
    let distance = num(r, "distance_km");
    // Strava exports metres; anything over 400 in a "km" column is really metres
    if (distance !== null && distance > 400) distance = distance / 1000;
    let duration = num(r, "duration_min");
    // Garmin/Strava often give seconds
    if (duration !== null && duration > 600) duration = duration / 60;

    return [{
      date,
      start_time: r[dateCol] ?? null,
      type: str(r, "type"),
      name: str(r, "name"),
      duration_min: duration,
      distance_km: distance,
      avg_hr: num(r, "avg_hr"),
      max_hr: num(r, "max_hr"),
      calories: num(r, "calories"),
      elevation_m: num(r, "elevation_m"),
      rpe: num(r, "rpe"),
      source,
      external_id: `${source}:${date}:${idx}:${str(r, "name") ?? ""}`.slice(0, 200),
    }];
  });
}

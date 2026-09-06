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

/** Normalise the characters spreadsheets and locales insert into numbers. */
function normaliseText(raw: string): string {
  return raw
    .replace(/[\u2212\u2012\u2013\u2014\u2015]/g, "-")   // typographic minus / dashes
    .replace(/[\u00a0\u202f\u2009\u2007]/g, " ")          // non-breaking / thin spaces
    .replace(/\u2019/g, "")                                // Swiss thousands apostrophe
    .trim();
}

const EMPTY = /^(n\/?a|null|none|nil|-{1,2}|\u2014|\u2013|\?|)$/i;
/** A date, in any of the shapes we accept — never a plain number. */
const DATE_SHAPE = /^\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4}/;
/** A clock or duration — belongs to parseDuration, not parseNumber. */
const DURATION_SHAPE = /^\d+:\d+|[0-9]\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/i;

/**
 * Parse a plain number.
 *
 * Deliberately narrow: it returns a dimensionless number or null, and NEVER
 * infers a unit. A value that is really a date or a duration is rejected rather
 * than salvaged — "12/05/2024" used to come back as 12052024, and "7.5h" as
 * 450, both of which reached the database silently. The import flow already
 * asks the user to confirm each column's unit, so a refusal here surfaces as a
 * question rather than as a wrong number.
 */
export function parseNumber(raw: string): number | null {
  const s = normaliseText(raw);
  if (EMPTY.test(s)) return null;
  if (DATE_SHAPE.test(s)) return null;
  if (DURATION_SHAPE.test(s)) return null;

  // Accounting negatives: (1.5) means -1.5
  const paren = s.match(/^\((.+)\)$/);
  const body = paren ? paren[1].trim() : s;
  const negate = Boolean(paren);

  // Whole-string scientific notation only — never rescued from a unit word,
  // which is how "1000 steps" used to become NaN.
  if (/^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/.test(body)) {
    const n = Number(body);
    return Number.isFinite(n) ? (negate ? -n : n) : null;
  }

  // Optional currency/sign prefix, digits with separators, optional unit suffix.
  const m = body.match(/^([+-]?)\s*[$£€¥]?\s*([\d.,]+)\s*([%a-zA-Zµ°/·]*)$/);
  if (!m) return null;
  const [, sign, digits, unit] = m;
  if (!/\d/.test(digits)) return null;
  // A trailing token that looks like a duration unit was handled above; anything
  // else (kg, steps, reps, %) is a label we ignore, not part of the value.
  if (unit && /^[eE]$/.test(unit)) return null;

  const n = decodeSeparators(digits);
  if (n === null) return null;
  const v = sign === "-" ? -n : n;
  return negate ? -v : v;
}

/**
 * Resolve thousands separators against decimal separators.
 *
 * The rule is symmetric: when both appear, the RIGHTMOST one is the decimal
 * point. That single rule handles "1,234.56" and "1.234,56" alike — the old
 * guard excluded any string containing a dot, which is exactly the European
 * case it claimed to handle, and turned 1.234,56 into 1.23456.
 */
function decodeSeparators(digits: string): number | null {
  const lastComma = digits.lastIndexOf(",");
  const lastDot = digits.lastIndexOf(".");

  let cleaned: string;
  if (lastComma >= 0 && lastDot >= 0) {
    cleaned = lastComma > lastDot
      ? digits.replace(/\./g, "").replace(",", ".")
      : digits.replace(/,/g, "");
  } else if (lastComma >= 0) {
    const after = digits.length - lastComma - 1;
    const groups = digits.split(",");
    // "1,234" is genuinely ambiguous; 3 digits after a single comma with a
    // leading group of 1-3 reads as a thousands separator, which is the
    // overwhelmingly more common spreadsheet output.
    cleaned = after === 3 && groups.length >= 2 && groups[0].length <= 3
      ? digits.replace(/,/g, "")
      : digits.replace(",", ".");
  } else {
    cleaned = digits;
  }

  if ((cleaned.match(/\./g) ?? []).length > 1) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a duration. Always returns MINUTES.
 *
 * parseNumber used to handle these inconsistently — "1:30" came back as 1.5
 * (hours) while "1h 30m" came back as 90 (minutes), from the same function. A
 * sleep column exported as "7.5h" was stored as 450 hours of sleep.
 */
export function parseDuration(raw: string): number | null {
  const s = normaliseText(raw);
  if (EMPTY.test(s)) return null;

  // ISO-8601, as Garmin and Apple Health emit
  const iso = s.match(/^P(?:\d+D)?T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (iso && (iso[1] || iso[2] || iso[3])) {
    return Number(iso[1] ?? 0) * 60 + Number(iso[2] ?? 0) + Number(iso[3] ?? 0) / 60;
  }

  // Clock form. Two fields are h:mm, three are h:mm:ss.
  const clock = s.match(/^(\d+):([0-5]?\d)(?::([0-5]?\d(?:\.\d+)?))?$/);
  if (clock) {
    const [, a, b, c] = clock;
    return c !== undefined
      ? Number(a) * 60 + Number(b) + Number(c) / 60
      : Number(a) * 60 + Number(b);
  }

  // Compound form: 1h 15min 30s, 2h, 45min, 1.5h
  const unit = /(\d+(?:\.\d+)?)\s*(h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)/gi;
  let total = 0, matched = false, m: RegExpExecArray | null;
  while ((m = unit.exec(s)) !== null) {
    const v = Number(m[1]);
    const u = m[2][0].toLowerCase();
    total += u === "h" ? v * 60 : u === "m" ? v : v / 60;
    matched = true;
  }
  // A bare number carries no unit and must not be guessed at.
  return matched ? total : null;
}

/**
 * Parse a date into ISO, rejecting anything that isn't a real calendar day.
 *
 * The old version returned its input verbatim for "2024-13-45" and rolled
 * "31/02/2024" over into "2024-02-31" — which then reached weekdayProfile and
 * threw, because getUTCDay() on an impossible date is NaN.
 */
export function parseDate(raw: string, opts: { dayFirst?: boolean } = {}): string | null {
  const s = normaliseText(raw);
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return validISO(+iso[1], +iso[2], +iso[3]);

  const slash = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (slash) {
    let [, a, b, y] = slash;
    let year = Number(y);
    if (year < 100) year += year > 50 ? 1900 : 2000;
    let day = Number(a), month = Number(b);
    // Day-first by default (UK/EU exports); flip when the first field can only
    // be a month, or when the caller knows better.
    if (opts.dayFirst === false || (month > 12 && day <= 12)) [day, month] = [month, day];
    return validISO(year, month, day);
  }

  // Textual dates ("Mar 12, 2024"). Extract in UTC: the rest of the app is UTC
  // throughout, and reading local components here shifted rows by a day for
  // anyone not on UTC.
  const t = Date.parse(s);
  if (!Number.isNaN(t) && /[A-Za-z]{3}/.test(s)) {
    const d = new Date(t);
    return validISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  return null;
}

/** Build an ISO date only if that calendar day genuinely exists. */
function validISO(year: number, month: number, day: number): string | null {
  if (!year || !month || !day) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 1900 || year > 2200) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Round-trip: JS rolls 31 Feb over to 2 Mar, so compare the parts back.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
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
    // parseNumber now refuses date- and duration-shaped values, so a date
    // column no longer reports numericRatio 1.0 and get mapped as a metric.
    const numeric = vals.filter((v) => parseNumber(v) !== null || parseDuration(v) !== null).length;
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

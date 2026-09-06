/**
 * LLM-assisted CSV understanding.
 *
 * The deterministic parser in csv.ts still reads the file — an LLM has no
 * business tokenising 20,000 rows. What the model does is the part rules are bad
 * at: working out *what this file is*, what each column means, and which unit it
 * is in, from headers and a handful of sample rows.
 *
 * Two hard boundaries:
 *   - the model may only choose metric keys from the supplied vocabulary, or
 *     explicitly propose a new one; anything else is dropped
 *   - it may only pick a transform from a fixed enum, never supply an expression
 * Its output is a *proposal* the user confirms in the UI, never a direct write.
 */
import { chatJson, llmEnabled } from "./openrouter";
import { autoMap, parseNumber, type ColumnProfile } from "./csv";
import { PLAUSIBLE_RANGES, type MetricDef } from "./metric-meta";

/** Unit conversions the model may request. A closed set — never arbitrary code. */
export const TRANSFORMS = {
  none:          { label: "as-is",              fn: (n: number) => n },
  lb_to_kg:      { label: "lb → kg",            fn: (n: number) => n * 0.45359237 },
  st_to_kg:      { label: "stone → kg",         fn: (n: number) => n * 6.35029318 },
  g_to_kg:       { label: "g → kg",             fn: (n: number) => n / 1000 },
  mi_to_km:      { label: "miles → km",         fn: (n: number) => n * 1.609344 },
  m_to_km:       { label: "m → km",             fn: (n: number) => n / 1000 },
  mm_to_km:      { label: "mm → km",            fn: (n: number) => n / 1e6 },
  ft_to_m:       { label: "ft → m",             fn: (n: number) => n * 0.3048 },
  in_to_cm:      { label: "in → cm",            fn: (n: number) => n * 2.54 },
  s_to_min:      { label: "seconds → minutes",  fn: (n: number) => n / 60 },
  s_to_h:        { label: "seconds → hours",    fn: (n: number) => n / 3600 },
  min_to_h:      { label: "minutes → hours",    fn: (n: number) => n / 60 },
  h_to_min:      { label: "hours → minutes",    fn: (n: number) => n * 60 },
  ms_to_s:       { label: "ms → s",             fn: (n: number) => n / 1000 },
  fraction_to_pct: { label: "0-1 → %",          fn: (n: number) => n * 100 },
  pct_to_fraction: { label: "% → 0-1",          fn: (n: number) => n / 100 },
} as const;

export type TransformId = keyof typeof TRANSFORMS;

export function applyTransform(v: number, id: TransformId | undefined, scale?: number): number {
  const t = TRANSFORMS[(id ?? "none") as TransformId] ?? TRANSFORMS.none;
  const out = t.fn(v);
  return typeof scale === "number" && Number.isFinite(scale) && scale !== 0 ? out * scale : out;
}

export type NewMetricSpec = {
  label: string; unit: string | null; category: string;
  higher_is_better: boolean | null; agg: "mean" | "sum" | "last" | "max" | "min"; precision: number;
};

export type ColumnPlan = {
  header: string;
  metric: string | null;          // canonical key, or null to ignore
  transform: TransformId;
  scale?: number;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  isNew: boolean;
  newMetric?: NewMetricSpec;
};

/**
 * Conversions that make sense for each metric, by the unit it is stored in.
 * Without this the "did you mean" search will happily suggest millimetres-to-
 * kilometres for a column of seconds, purely because the arithmetic lands in
 * range — a suggestion that is worse than none at all.
 */
const TIME_H  = ["none", "s_to_h", "min_to_h"] as TransformId[];
const TIME_MIN = ["none", "s_to_min", "h_to_min"] as TransformId[];
const MASS_KG = ["none", "lb_to_kg", "st_to_kg", "g_to_kg"] as TransformId[];
const DIST_KM = ["none", "mi_to_km", "m_to_km", "mm_to_km"] as TransformId[];
const PCT     = ["none", "fraction_to_pct", "pct_to_fraction"] as TransformId[];

const CANDIDATES: Record<string, TransformId[]> = {
  sleep_hours: TIME_H, deep_work_hours: TIME_H, screen_time_h: TIME_H,
  deep_sleep_min: TIME_MIN, rem_sleep_min: TIME_MIN, nap_min: TIME_MIN,
  active_zone_min: TIME_MIN, active_minutes: TIME_MIN, sedentary_min: TIME_MIN,
  meditation_min: TIME_MIN,
  weight_kg: MASS_KG, lean_mass_kg: MASS_KG, fat_mass_kg: MASS_KG,
  distance_km: DIST_KM,
  waist_cm: ["none", "in_to_cm"], height_cm: ["none", "in_to_cm"],
  body_fat_pct: PCT, sleep_efficiency: PCT, spo2_pct: PCT,
};

/**
 * Apply each column's proposed transform to the real sample values and check the
 * result lands somewhere a human body or working day could produce. Anything
 * outside gets its confidence dropped and a warning the user will actually see.
 */
export function checkPlausibility(
  plan: ImportPlan,
  headers: string[],
  rows: string[][]
): ImportPlan {
  if (plan.kind !== "metrics") return plan;
  const warnings = [...plan.warnings];

  for (const c of plan.columns) {
    if (!c.metric || c.metric === "date") continue;
    const range = PLAUSIBLE_RANGES[c.metric];
    if (!range) continue;

    const i = headers.indexOf(c.header);
    if (i < 0) continue;
    const vals = rows.slice(0, 200)
      .map((r) => parseNumber(r[i] ?? ""))
      .filter((n): n is number => n !== null)
      .map((n) => applyTransform(n, c.transform, c.scale));
    if (vals.length < 2) continue;

    const sorted = [...vals].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    if (median >= range[0] && median <= range[1]) continue;

    // Would a different transform land it in range? Only consider conversions
    // that are meaningful for this metric's unit — suggesting a distance
    // conversion for a column of seconds is worse than saying nothing.
    const raw = median / (TRANSFORMS[c.transform].fn(1) || 1);
    const better = (CANDIDATES[c.metric] ?? ["none"] as TransformId[]).find((t) => {
      if (t === c.transform) return false;
      const m = applyTransform(raw, t);
      return m >= range[0] && m <= range[1];
    });

    c.confidence = "low";
    c.reasoning = `${c.reasoning} — but the values land at ~${fmt(median)}, outside the ${range[0]}-${range[1]} expected here`;
    warnings.push(
      `"${c.header}" mapped to ${c.metric} gives about ${fmt(median)}, outside the plausible range ` +
      `${range[0]}-${range[1]}.` + (better ? ` Try the "${TRANSFORMS[better].label}" conversion.` : " Check the units.")
    );
  }
  return { ...plan, warnings: warnings.slice(0, 10) };
}

const fmt = (n: number) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString("en-US") : Number(n.toFixed(2)).toString());

export type ImportKind = "metrics" | "workouts" | "sets";

export type ImportPlan = {
  kind: ImportKind;
  sourceGuess: string;
  summary: string;
  warnings: string[];
  columns: ColumnPlan[];
  classifiedBy: "llm" | "rules";
  /** Why the model wasn't used, when it wasn't. Shown to the user so a silent
   *  downgrade to header matching is never mistaken for a confident reading. */
  fallbackReason?: string;
};

const CATEGORIES = ["body", "cardio", "sleep", "activity", "nutrition", "work", "cognitive", "custom"];

/**
 * Ask the model to interpret the file. Falls back to the deterministic header
 * matcher when there is no API key, when the call fails, or when the model
 * returns something unusable — the import must never become LLM-dependent.
 */
export async function classifyCsv(
  headers: string[],
  rows: string[][],
  profiles: ColumnProfile[],
  vocabulary: MetricDef[],
  hint?: string
): Promise<ImportPlan> {
  if (!llmEnabled())
    return rulesPlan(headers, profiles, "rules", "metrics",
      "No OPENROUTER_API_KEY is set, so the file was matched on header names alone.");

  const sample = rows.slice(0, 8).map((r) => headers.map((_, i) => r[i] ?? "").join(" | ")).join("\n");
  const vocab = vocabulary
    .map((v) => `${v.key} (${v.label}${v.unit ? `, ${v.unit}` : ", no unit"}, ${v.category})`)
    .join("\n");

  try {
    const plan = await chatJson<ImportPlan>([
      {
        role: "system",
        content:
`You interpret a CSV a person has exported from a fitness, health, or business tool, and map it onto their existing metric vocabulary.

DECIDE FIRST which of THREE shapes this file has:
  - "sets"      — one row per SET of a strength exercise. The giveaway is per-set weight and
                  reps columns, an exercise name, and a set index, with the date and session
                  fields REPEATING across many consecutive rows. Strong, Hevy and most lifting
                  apps export this shape. Choose this whenever weight-and-reps columns exist.
  - "workouts"  — one row per exercise SESSION (a duration, activity type or distance per row,
                  one row per session, no per-set detail).
  - "metrics"   — one row per DATE, with several different measurements across the columns.
A file with one row per day is "metrics" even if it contains exercise columns.

FOR EVERY COLUMN return an entry with:
  header      exactly as given
  metric      a key from the VOCABULARY, or a new snake_case key you propose, or null to ignore it
              For kind "workouts" the valid keys are instead: date, type, name, duration_min,
              distance_km, avg_hr, max_hr, calories, elevation_m, rpe
              For kind "sets" the valid keys are instead: date, session_name, exercise,
              set_order, weight_kg, reps, rpe, distance_km, duration_s, session_min, notes
                date        the timestamp identifying the workout (repeats across the set rows)
                session_name the workout's own title, e.g. "Afternoon Workout" or "Push Day"
                exercise    the movement performed, e.g. "Incline Bench Press (Dumbbell)"
                set_order   the set's index within its exercise
                weight_kg   load lifted for that set — set transform lb_to_kg if the values are pounds
                reps        repetitions in that set
                session_min the whole session's length, which REPEATS on every row of that session
              Never map two columns to the same key. Never map a set index to a duration.
  transform   one of: ${Object.keys(TRANSFORMS).join(", ")}
              Infer the source unit from the header text AND the magnitude of the sample values.
              A "Distance" column of values around 10000 is metres, not kilometres. A "Weight"
              column around 185 is pounds; around 84 it is kilograms. A "Duration" of 3600 is seconds.
  scale       optional extra multiplier, only when no listed transform fits
  confidence  high | medium | low
  reasoning   one short clause naming the evidence you used (header wording, magnitude, units)
  isNew       true only when proposing a key that is NOT in the vocabulary
  newMetric   required when isNew: {label, unit, category, higher_is_better, agg, precision}
              category one of: ${CATEGORIES.join(", ")}
              higher_is_better: true, false, or null when neither direction is inherently good
              agg: how to collapse several readings in one day (sum for counts/totals, mean for levels, last for standing values)

RULES
- Exactly one column maps to "date". If several look like dates, choose the one identifying the row.
- Prefer an existing vocabulary key over inventing one. Only propose new keys for genuinely new concepts.
- Ignore (metric: null) index columns, IDs, notes, URLs and anything not numeric or date-like.
- Never invent a vocabulary key that isn't listed — either use one verbatim or set isNew: true.
- warnings: anything the person should check — ambiguous units, a date format that could be
  day-first or month-first, mixed content, sparse columns.

Return ONLY JSON:
{"kind","sourceGuess","summary","warnings":[],"columns":[{"header","metric","transform","scale","confidence","reasoning","isNew","newMetric"}]}
sourceGuess: which tool this looks like it came from, or "unknown".
summary: one sentence on what the file contains and its date span.`,
      },
      {
        role: "user",
        content:
`VOCABULARY (existing metric keys):
${vocab}

CSV HEADERS:
${headers.join(" | ")}

FIRST ROWS:
${sample}

TOTAL ROWS: ${rows.length}${hint ? `\n\nUSER HINT: ${hint}` : ""}`,
      },
    ], { maxTokens: 16000, temperature: 0.1, effort: "low" });

    return checkPlausibility(sanitise(plan, headers, profiles, vocabulary), headers, rows);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return checkPlausibility(
      rulesPlan(headers, profiles, "rules", "metrics",
        `The model could not be reached, so header matching was used instead. ${msg.slice(0, 300)}`),
      headers, rows);
  }
}

/**
 * Never trust the model with the key space or the transform set. Anything
 * outside the vocabulary that isn't explicitly flagged as new is dropped;
 * unknown transforms fall back to identity.
 */
function sanitise(
  plan: ImportPlan,
  headers: string[],
  profiles: ColumnProfile[],
  vocabulary: MetricDef[]
): ImportPlan {
  const known = new Set(vocabulary.map((v) => v.key));
  const workoutFields = new Set(["date", "type", "name", "duration_min", "distance_km",
                                 "avg_hr", "max_hr", "calories", "elevation_m", "rpe"]);
  const setFields = new Set(["date", "session_name", "exercise", "set_order", "weight_kg",
                             "reps", "rpe", "distance_km", "duration_s", "session_min", "notes"]);
  const kind: ImportPlan["kind"] =
    plan.kind === "workouts" ? "workouts" : plan.kind === "sets" ? "sets" : "metrics";
  const fixedFields = kind === "workouts" ? workoutFields : kind === "sets" ? setFields : null;
  const claimed = new Set<string>();
  const byHeader = new Map((plan.columns ?? []).map((c) => [c.header, c]));

  const columns: ColumnPlan[] = headers.map((h) => {
    const c = byHeader.get(h);
    const fallback: ColumnPlan = {
      header: h, metric: null, transform: "none", confidence: "low",
      reasoning: "Not classified", isNew: false,
    };
    if (!c) return fallback;

    let metric = typeof c.metric === "string" && c.metric !== "-" ? c.metric.trim() : null;
    let isNew = Boolean(c.isNew);

    if (metric) {
      if (fixedFields) {
        // Fixed schemas have one slot per field — a second column claiming an
        // occupied slot silently overwrote the first.
        if (!fixedFields.has(metric) || claimed.has(metric)) { metric = null; isNew = false; }
        else { claimed.add(metric); }
      } else if (!known.has(metric)) {
        // A key we don't have is only allowed through as a declared new metric.
        if (isNew && /^[a-z][a-z0-9_]{1,48}$/.test(metric)) isNew = true;
        else { metric = null; isNew = false; }
      } else {
        isNew = false;
      }
    }

    const transform: TransformId = (c.transform && c.transform in TRANSFORMS ? c.transform : "none") as TransformId;
    return {
      header: h,
      metric,
      transform,
      scale: typeof c.scale === "number" && Number.isFinite(c.scale) ? c.scale : undefined,
      confidence: ["high", "medium", "low"].includes(c.confidence) ? c.confidence : "medium",
      reasoning: String(c.reasoning ?? "").slice(0, 200),
      isNew,
      newMetric: isNew ? normaliseNewMetric(c.newMetric, h) : undefined,
    };
  });

  // A metrics import is meaningless without a date column; fall back to the
  // deterministic detector rather than shipping a broken plan.
  if (!columns.some((c) => c.metric === "date")) {
    const guess = profiles.find((p) => p.dateRatio > 0.8)?.header
      ?? profiles.slice().sort((a, b) => b.dateRatio - a.dateRatio)[0]?.header;
    const target = columns.find((c) => c.header === guess);
    if (target) {
      target.metric = "date";
      target.isNew = false;
      target.transform = "none";
      target.reasoning = "Detected as the date column (the model did not identify one)";
    }
  }

  return {
    kind,
    sourceGuess: String(plan.sourceGuess ?? "unknown").slice(0, 80),
    summary: String(plan.summary ?? "").slice(0, 400),
    warnings: (plan.warnings ?? []).slice(0, 6).map((w) => String(w).slice(0, 220)),
    columns,
    classifiedBy: "llm",
  };
}

function normaliseNewMetric(m: Partial<NewMetricSpec> | undefined, header: string): NewMetricSpec {
  const aggs = ["mean", "sum", "last", "max", "min"];
  return {
    label: String(m?.label ?? header).slice(0, 60),
    unit: m?.unit ? String(m.unit).slice(0, 16) : null,
    category: CATEGORIES.includes(String(m?.category)) ? String(m!.category) : "custom",
    higher_is_better: typeof m?.higher_is_better === "boolean" ? m.higher_is_better : null,
    agg: (aggs.includes(String(m?.agg)) ? m!.agg : "mean") as NewMetricSpec["agg"],
    precision: Number.isFinite(Number(m?.precision)) ? Math.max(0, Math.min(4, Number(m!.precision))) : 2,
  };
}

/** Deterministic fallback: the original alias matcher, in ImportPlan shape. */
export function rulesPlan(
  headers: string[],
  profiles: ColumnProfile[],
  classifiedBy: "llm" | "rules",
  kind: "metrics" | "workouts" = "metrics",
  fallbackReason?: string
): ImportPlan {
  const auto = autoMap(headers, kind);
  const columns: ColumnPlan[] = headers.map((h) => ({
    header: h,
    metric: auto[h] ?? null,
    transform: "none" as TransformId,
    confidence: auto[h] ? ("medium" as const) : ("low" as const),
    reasoning: auto[h] ? "Matched a known header name" : "No confident match",
    isNew: false,
  }));

  // Without a date column the import is blocked outright, so fall back to the
  // column that actually parses as dates rather than leaving the user stuck.
  if (!columns.some((c) => c.metric === "date")) {
    const best = profiles.filter((p) => p.dateRatio > 0.5).sort((a, b) => b.dateRatio - a.dateRatio)[0];
    const target = best && columns.find((c) => c.header === best.header);
    if (target) {
      target.metric = "date";
      target.confidence = "medium";
      target.reasoning = `${Math.round(best.dateRatio * 100)}% of values parse as dates`;
    }
  }

  return {
    kind,
    sourceGuess: "unknown",
    summary: "Columns were matched on header names only — check every row below before importing.",
    warnings: [],
    columns,
    classifiedBy,
    fallbackReason,
  };
}

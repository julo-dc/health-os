/**
 * Pure metric vocabulary: types, the canonical metric list, and date helpers.
 *
 * Deliberately free of any database import so client components can use these
 * without pulling the Postgres driver into the browser bundle.
 */

export type Agg = "mean" | "sum" | "last" | "max" | "min";
export type MetricDef = {
  key: string;
  label: string;
  unit: string | null;
  category: string;
  higher_is_better: boolean | null;
  agg: Agg;
  precision: number;
  is_custom?: boolean;
};

/**
 * Canonical metric vocabulary. Every ingest path (Google Health, CSV, manual,
 * photo, derived) normalises into these keys, so the analytics engine never has
 * to know where a number came from.
 */
export const CORE_METRICS: MetricDef[] = [
  // --- body composition ---
  { key: "weight_kg",        label: "Weight",            unit: "kg",    category: "body",     higher_is_better: null,  agg: "mean", precision: 2 },
  { key: "body_fat_pct",     label: "Body fat",          unit: "%",     category: "body",     higher_is_better: false, agg: "mean", precision: 1 },
  { key: "lean_mass_kg",     label: "Lean mass",         unit: "kg",    category: "body",     higher_is_better: true,  agg: "mean", precision: 2 },
  { key: "fat_mass_kg",      label: "Fat mass",          unit: "kg",    category: "body",     higher_is_better: false, agg: "mean", precision: 2 },
  { key: "waist_cm",         label: "Waist",             unit: "cm",    category: "body",     higher_is_better: false, agg: "mean", precision: 1 },

  // --- cardio / recovery ---
  { key: "resting_hr",       label: "Resting HR",        unit: "bpm",   category: "cardio",   higher_is_better: false, agg: "mean", precision: 0 },
  { key: "hrv_ms",           label: "HRV (RMSSD)",       unit: "ms",    category: "cardio",   higher_is_better: true,  agg: "mean", precision: 0 },
  { key: "vo2max",           label: "VO2 max",           unit: "ml/kg", category: "cardio",   higher_is_better: true,  agg: "mean", precision: 1 },
  { key: "spo2_pct",         label: "SpO2",              unit: "%",     category: "cardio",   higher_is_better: true,  agg: "mean", precision: 1 },
  { key: "respiratory_rate", label: "Respiratory rate",  unit: "br/m",  category: "cardio",   higher_is_better: false, agg: "mean", precision: 1 },
  { key: "avg_hr",           label: "Average HR",        unit: "bpm",   category: "cardio",   higher_is_better: null,  agg: "mean", precision: 0 },
  { key: "max_hr_daily",     label: "Peak HR",           unit: "bpm",   category: "cardio",   higher_is_better: null,  agg: "max",  precision: 0 },
  { key: "min_hr_daily",     label: "Lowest HR",         unit: "bpm",   category: "cardio",   higher_is_better: false, agg: "min",  precision: 0 },
  { key: "hrv_deep_ms",      label: "HRV (deep sleep)",  unit: "ms",    category: "cardio",   higher_is_better: true,  agg: "mean", precision: 0 },
  { key: "height_cm",        label: "Height",            unit: "cm",    category: "body",     higher_is_better: null,  agg: "last", precision: 0 },
  { key: "active_calories",  label: "Active calories",   unit: "kcal",  category: "activity", higher_is_better: null,  agg: "sum",  precision: 0 },
  { key: "moderate_vigorous_min", label: "Mod+vigorous",  unit: "min",  category: "activity", higher_is_better: true,  agg: "sum",  precision: 0 },

  // --- sleep ---
  { key: "sleep_hours",      label: "Sleep duration",    unit: "h",     category: "sleep",    higher_is_better: true,  agg: "sum",  precision: 2 },
  { key: "sleep_efficiency", label: "Sleep efficiency",  unit: "%",     category: "sleep",    higher_is_better: true,  agg: "mean", precision: 1 },
  { key: "deep_sleep_min",   label: "Deep sleep",        unit: "min",   category: "sleep",    higher_is_better: true,  agg: "sum",  precision: 0 },
  { key: "rem_sleep_min",    label: "REM sleep",         unit: "min",   category: "sleep",    higher_is_better: true,  agg: "sum",  precision: 0 },
  { key: "sleep_start_hour", label: "Bedtime",           unit: "h",     category: "sleep",    higher_is_better: null,  agg: "mean", precision: 2 },
  { key: "sleep_awake_min",  label: "Awake in bed",      unit: "min",   category: "sleep",    higher_is_better: false, agg: "sum",  precision: 0 },
  { key: "nap_min",          label: "Naps",              unit: "min",   category: "sleep",    higher_is_better: null,  agg: "sum",  precision: 0 },

  // --- activity ---
  { key: "steps",            label: "Steps",             unit: "",      category: "activity", higher_is_better: true,  agg: "sum",  precision: 0 },
  { key: "distance_km",      label: "Distance",          unit: "km",    category: "activity", higher_is_better: true,  agg: "sum",  precision: 2 },
  { key: "floors",           label: "Floors",            unit: "",      category: "activity", higher_is_better: true,  agg: "sum",  precision: 0 },
  { key: "active_zone_min",  label: "Active zone min",   unit: "min",   category: "activity", higher_is_better: true,  agg: "sum",  precision: 0 },
  { key: "active_minutes",   label: "Active minutes",    unit: "min",   category: "activity", higher_is_better: true,  agg: "sum",  precision: 0 },
  { key: "sedentary_min",    label: "Sedentary time",    unit: "min",   category: "activity", higher_is_better: false, agg: "sum",  precision: 0 },
  { key: "calories_out",     label: "Calories burned",   unit: "kcal",  category: "activity", higher_is_better: null,  agg: "sum",  precision: 0 },
  { key: "training_load",    label: "Training load",     unit: "au",    category: "activity", higher_is_better: null,  agg: "sum",  precision: 0 },
  { key: "workout_min",      label: "Workout time",      unit: "min",   category: "activity", higher_is_better: true,  agg: "sum",  precision: 0 },

  // --- strength training ---
  { key: "training_volume_kg", label: "Training volume",   unit: "kg",    category: "strength", higher_is_better: true,  agg: "sum",  precision: 0 },
  { key: "sets_count",         label: "Sets",              unit: "",      category: "strength", higher_is_better: true,  agg: "sum",  precision: 0 },
  { key: "hard_sets",          label: "Hard sets (RPE 7+)", unit: "",     category: "strength", higher_is_better: true,  agg: "sum",  precision: 0 },
  { key: "reps_total",         label: "Total reps",        unit: "",      category: "strength", higher_is_better: true,  agg: "sum",  precision: 0 },
  { key: "top_set_kg",         label: "Heaviest set",      unit: "kg",    category: "strength", higher_is_better: true,  agg: "max",  precision: 1 },
  { key: "strength_index",     label: "Strength index",    unit: "kg",    category: "strength", higher_is_better: true,  agg: "last", precision: 1 },

  // --- derived training-load model ---
  { key: "ctl",              label: "Fitness (CTL)",     unit: "au",    category: "derived",  higher_is_better: true,  agg: "last", precision: 1 },
  { key: "atl",              label: "Fatigue (ATL)",     unit: "au",    category: "derived",  higher_is_better: null,  agg: "last", precision: 1 },
  { key: "tsb",              label: "Form (TSB)",        unit: "au",    category: "derived",  higher_is_better: null,  agg: "last", precision: 1 },
  { key: "acwr",             label: "Acute:chronic",     unit: "x",     category: "derived",  higher_is_better: null,  agg: "last", precision: 2 },
  { key: "readiness",        label: "Readiness",         unit: "/100",  category: "derived",  higher_is_better: true,  agg: "last", precision: 0 },

  // --- nutrition ---
  { key: "calories_in",      label: "Calories eaten",    unit: "kcal",  category: "nutrition", higher_is_better: null, agg: "sum",  precision: 0 },
  { key: "protein_g",        label: "Protein",           unit: "g",     category: "nutrition", higher_is_better: true, agg: "sum",  precision: 0 },
  { key: "carbs_g",          label: "Carbs",             unit: "g",     category: "nutrition", higher_is_better: null, agg: "sum",  precision: 0 },
  { key: "fat_g",            label: "Fat",               unit: "g",     category: "nutrition", higher_is_better: null, agg: "sum",  precision: 0 },
  { key: "alcohol_units",    label: "Alcohol",           unit: "units", category: "nutrition", higher_is_better: false, agg: "sum", precision: 1 },
  { key: "water_l",          label: "Water",             unit: "L",     category: "nutrition", higher_is_better: true, agg: "sum",  precision: 2 },

  // --- work / business ---
  { key: "deep_work_hours",  label: "Deep work",         unit: "h",     category: "work",     higher_is_better: true,  agg: "sum",  precision: 2 },
  { key: "revenue",          label: "Revenue",           unit: "",      category: "work",     higher_is_better: true,  agg: "sum",  precision: 2 },
  { key: "mrr",              label: "MRR",               unit: "",      category: "work",     higher_is_better: true,  agg: "last", precision: 2 },
  { key: "customers",        label: "Customers",         unit: "",      category: "work",     higher_is_better: true,  agg: "last", precision: 0 },
  { key: "sales_calls",      label: "Sales calls",       unit: "",      category: "work",     higher_is_better: true,  agg: "sum",  precision: 0 },
  { key: "shipped_items",    label: "Things shipped",    unit: "",      category: "work",     higher_is_better: true,  agg: "sum",  precision: 0 },

  // --- cognitive / subjective ---
  { key: "focus_score",      label: "Focus",             unit: "/10",   category: "cognitive", higher_is_better: true, agg: "mean", precision: 1 },
  { key: "mood",             label: "Mood",              unit: "/10",   category: "cognitive", higher_is_better: true, agg: "mean", precision: 1 },
  { key: "energy",           label: "Energy",            unit: "/10",   category: "cognitive", higher_is_better: true, agg: "mean", precision: 1 },
  { key: "stress",           label: "Stress",            unit: "/10",   category: "cognitive", higher_is_better: false, agg: "mean", precision: 1 },
  { key: "meditation_min",   label: "Meditation",        unit: "min",   category: "cognitive", higher_is_better: true, agg: "sum",  precision: 0 },
  { key: "reading_min",      label: "Reading",           unit: "min",   category: "cognitive", higher_is_better: true, agg: "sum",  precision: 0 },
  { key: "screen_time_h",    label: "Screen time",       unit: "h",     category: "cognitive", higher_is_better: false, agg: "sum", precision: 2 },
];

/**
 * Metrics that are computed *from* other metrics.
 *
 * Correlating one of these against a parent is arithmetic, not discovery — fat
 * mass is weight x body-fat %, so it will always return r = 1.00 and crowd a
 * genuine finding out of the list. Used to filter both the related-metric list
 * and the driver model's candidate pool.
 */
export const DERIVED_FROM: Record<string, string[]> = {
  lean_mass_kg: ["weight_kg", "body_fat_pct", "fat_mass_kg"],
  fat_mass_kg:  ["weight_kg", "body_fat_pct", "lean_mass_kg"],
  readiness:    ["hrv_ms", "resting_hr", "sleep_hours", "tsb"],
  ctl:          ["training_load", "atl", "tsb", "acwr", "workout_min"],
  atl:          ["training_load", "ctl", "tsb", "acwr", "workout_min"],
  tsb:          ["training_load", "ctl", "atl", "acwr"],
  acwr:         ["training_load", "ctl", "atl", "tsb"],
  training_load:["workout_min", "ctl", "atl", "tsb", "acwr"],
};

/** True when two metrics are related by construction rather than by behaviour. */
export function isDerivedPair(a: string, b: string): boolean {
  return (DERIVED_FROM[a] ?? []).includes(b) || (DERIVED_FROM[b] ?? []).includes(a);
}

/**
 * Ranges a metric can plausibly take, as a daily value. Used to sanity-check
 * anything a model proposes — a CSV column's units, or a goal target — before
 * it reaches the database.
 */
export const PLAUSIBLE_RANGES: Record<string, [number, number]> = {
  weight_kg: [30, 250], lean_mass_kg: [20, 150], fat_mass_kg: [1, 120],
  body_fat_pct: [3, 60], waist_cm: [40, 200], height_cm: [100, 250],
  resting_hr: [30, 110], avg_hr: [35, 180], hrv_ms: [5, 250],
  spo2_pct: [70, 100], respiratory_rate: [5, 35], vo2max: [15, 90],
  sleep_hours: [0, 14], sleep_efficiency: [30, 100],
  deep_sleep_min: [0, 400], rem_sleep_min: [0, 400], nap_min: [0, 400],
  steps: [0, 60000], distance_km: [0, 300], floors: [0, 500],
  active_zone_min: [0, 600], active_minutes: [0, 900], sedentary_min: [0, 1440],
  calories_in: [300, 9000], calories_out: [500, 9000], protein_g: [0, 500],
  carbs_g: [0, 1200], fat_g: [0, 500], water_l: [0, 12], alcohol_units: [0, 40],
  deep_work_hours: [0, 16], screen_time_h: [0, 24], meditation_min: [0, 300],
  training_volume_kg: [0, 100000], sets_count: [0, 100], hard_sets: [0, 80],
  reps_total: [0, 1500], top_set_kg: [0, 500], strength_index: [0, 2000],
  reading_min: [0, 600],
  focus_score: [0, 10], mood: [0, 10], energy: [0, 10], stress: [0, 10],
};

export const GOAL_KINDS = ["physical", "work", "cognitive", "mixed"] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

export const CATEGORY_LABELS: Record<string, string> = {
  body: "Body composition",
  cardio: "Cardio & recovery",
  sleep: "Sleep",
  activity: "Activity",
  strength: "Strength training",
  derived: "Training model",
  nutrition: "Nutrition",
  work: "Work & business",
  cognitive: "Cognitive & mood",
  custom: "Custom",
};

/**
 * Source precedence when the same (date, metric) exists more than once.
 * A number you typed in beats a number a device guessed.
 */
export const SOURCE_PRIORITY: Record<string, number> = {
  manual: 100,
  csv: 80,
  google_health: 60,
  photo: 40,
  derived: 20,
};

export type Point = { date: string; value: number };

export function toISO(d: Date | string): string {
  if (typeof d === "string") return d.slice(0, 10);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000
  );
}

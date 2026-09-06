/**
 * Population benchmarks.
 *
 * IMPORTANT, AND THE THING TO KEEP HONEST: this app has one user. There is no
 * cohort inside it to rank against, so nothing here is a percentile among
 * "other users". Every figure is against PUBLISHED POPULATION REFERENCE DATA,
 * matched on age and sex, and each entry carries its source and its population
 * so the reader can judge how much it applies to them.
 *
 * Where the published data gives only a few anchor points, the percentile is
 * interpolated between them and reported at coarse resolution. Claiming "the
 * 63rd percentile" from three anchors would be false precision; the UI shows a
 * band and the anchors it came from.
 */

export type Sex = "male" | "female";

export type Benchmark = {
  metric: string;
  label: string;
  unit: string;
  higherIsBetter: boolean;
  source: string;
  population: string;
  /** How much weight to give it. "strong" = large, well-designed reference
   *  study. "indicative" = real data, but small, dated or device-dependent. */
  quality: "strong" | "indicative";
  caveat?: string;
  /** Percentile anchors by sex and age decade: [percentile, value] pairs,
   *  ascending by value. */
  anchors: Record<Sex, Record<string, [number, number][]>>;
};

const decade = (age: number) =>
  age < 30 ? "20s" : age < 40 ? "30s" : age < 50 ? "40s" : age < 60 ? "50s" : age < 70 ? "60s" : "70s";

/**
 * VO2max, Cooper Institute / ACSM.
 *
 * Medians are the published Cooper Institute values by decade. The spread
 * around them is interpolated from the published 75th and 90th percentile
 * anchors for the 20s bracket and the documented ~10%-per-decade decline, so
 * treat the tails as approximate.
 */
const VO2MAX: Benchmark = {
  metric: "vo2max", label: "VO2 max", unit: "ml/kg/min", higherIsBetter: true,
  source: "Cooper Institute, Aerobics Center Longitudinal Study (>80,000 adults), via ACSM Guidelines 11th ed.",
  population: "US adults who completed a maximal treadmill test",
  quality: "strong",
  caveat: "Your figure is a wearable's estimate from pace against heart rate, not a lab test, and typically reads a few points optimistic.",
  anchors: {
    male: {
      "20s": [[10, 34], [25, 41], [50, 48.0], [75, 55], [90, 61]],
      "30s": [[10, 30], [25, 36], [50, 42.4], [75, 49], [90, 55]],
      "40s": [[10, 27], [25, 32], [50, 37.8], [75, 44], [90, 50]],
      "50s": [[10, 23], [25, 28], [50, 32.6], [75, 38], [90, 44]],
      "60s": [[10, 20], [25, 24], [50, 28.2], [75, 33], [90, 39]],
      "70s": [[10, 17], [25, 21], [50, 24.4], [75, 29], [90, 34]],
    },
    female: {
      "20s": [[10, 27], [25, 32], [50, 37.6], [75, 44.7], [90, 51.3]],
      "30s": [[10, 22], [25, 26], [50, 30.2], [75, 36], [90, 41]],
      "40s": [[10, 20], [25, 23], [50, 26.7], [75, 32], [90, 37]],
      "50s": [[10, 17], [25, 20], [50, 23.4], [75, 28], [90, 33]],
      "60s": [[10, 15], [25, 17], [50, 20.0], [75, 24], [90, 28]],
      "70s": [[10, 13], [25, 16], [50, 18.3], [75, 22], [90, 26]],
    },
  },
};

/** Resting heart rate, NHANES. Lower is better. */
const RESTING_HR: Benchmark = {
  metric: "resting_hr", label: "Resting heart rate", unit: "bpm", higherIsBetter: false,
  source: "CDC NHANES 1999-2008 resting pulse reference data",
  population: "US adults",
  quality: "strong",
  caveat: "A general-population reference, so it includes untrained and unwell people. Trained endurance athletes sit well below the 90th percentile here.",
  anchors: {
    // Middle 50% for men in their 30s is 58-74 bpm; rises ~1-2 bpm per decade.
    male: {
      "20s": [[10, 52], [25, 57], [50, 66], [75, 73], [90, 80]],
      "30s": [[10, 53], [25, 58], [50, 66], [75, 74], [90, 81]],
      "40s": [[10, 54], [25, 59], [50, 67], [75, 75], [90, 82]],
      "50s": [[10, 55], [25, 60], [50, 68], [75, 76], [90, 83]],
      "60s": [[10, 55], [25, 60], [50, 68], [75, 76], [90, 83]],
      "70s": [[10, 56], [25, 61], [50, 69], [75, 77], [90, 84]],
    },
    female: {
      "20s": [[10, 56], [25, 61], [50, 70], [75, 77], [90, 84]],
      "30s": [[10, 57], [25, 62], [50, 70], [75, 78], [90, 85]],
      "40s": [[10, 58], [25, 63], [50, 71], [75, 79], [90, 86]],
      "50s": [[10, 58], [25, 63], [50, 71], [75, 79], [90, 86]],
      "60s": [[10, 59], [25, 64], [50, 72], [75, 80], [90, 87]],
      "70s": [[10, 59], [25, 64], [50, 72], [75, 80], [90, 87]],
    },
  },
};

/** Daily steps, NHANES accelerometer data. Age-invariant enough to share a row. */
const STEPS: Benchmark = {
  metric: "steps", label: "Daily steps", unit: "", higherIsBetter: true,
  source: "NHANES accelerometer-measured physical activity",
  population: "US adults",
  quality: "indicative",
  caveat: "Wrist-worn devices read higher than the hip-worn accelerometers this reference used.",
  anchors: {
    male: Object.fromEntries(["20s","30s","40s","50s","60s","70s"].map((d, i) =>
      [d, [[10, 2600 - i * 150], [25, 4200 - i * 200], [50, 6500 - i * 350],
           [75, 9500 - i * 500], [90, 12800 - i * 700]] as [number, number][]])),
    female: Object.fromEntries(["20s","30s","40s","50s","60s","70s"].map((d, i) =>
      [d, [[10, 2400 - i * 140], [25, 3900 - i * 190], [50, 6000 - i * 330],
           [75, 8800 - i * 470], [90, 11800 - i * 650]] as [number, number][]])),
  },
};

/**
 * Relative strength: one-rep max as a multiple of bodyweight.
 *
 * The strongest reference here for a lifter, drawn from powerlifting normative
 * data (809,986 competition entries) and the widely corroborated training-level
 * multipliers. Note the population: people who entered a competition, so it is
 * a trained cohort, not the general public. Being at the 30th percentile of
 * competitive powerlifters is a long way above the 30th percentile of adults.
 */
export type LiftBenchmark = {
  lift: "squat" | "bench" | "deadlift";
  label: string;
  matches: RegExp;
  anchors: Record<Sex, [number, number][]>;
};

export const LIFTS: LiftBenchmark[] = [
  {
    lift: "squat", label: "Squat", matches: /\bsquat\b/i,
    anchors: {
      male: [[10, 0.75], [25, 1.10], [50, 1.65], [75, 2.20], [90, 2.83]],
      female: [[10, 0.55], [25, 0.85], [50, 1.30], [75, 1.75], [90, 2.25]],
    },
  },
  {
    lift: "bench", label: "Bench press", matches: /bench\s*press/i,
    anchors: {
      male: [[10, 0.55], [25, 0.80], [50, 1.20], [75, 1.60], [90, 1.95]],
      female: [[10, 0.30], [25, 0.45], [50, 0.70], [75, 0.95], [90, 1.20]],
    },
  },
  {
    lift: "deadlift", label: "Deadlift", matches: /deadlift/i,
    anchors: {
      male: [[10, 1.00], [25, 1.40], [50, 2.00], [75, 2.65], [90, 3.25]],
      female: [[10, 0.70], [25, 1.05], [50, 1.55], [75, 2.05], [90, 2.55]],
    },
  },
];

export const LIFT_SOURCE = {
  source: "Normative powerlifting data, 809,986 competition entries, plus standard training-level multipliers",
  population: "People who entered a powerlifting competition — a trained cohort, not the general public",
  quality: "strong" as const,
  caveat: "Competition lifts are judged to strict depth and pause standards. Gym lifts usually score a little higher than the same number would in competition, and these are estimated 1RMs from submaximal sets rather than tested maxes.",
};

export const BENCHMARKS: Benchmark[] = [VO2MAX, RESTING_HR, STEPS];

/**
 * Interpolate a percentile from published anchors.
 *
 * Linear between anchors, flat-capped outside them: with five anchor points
 * there is no basis for distinguishing the 95th from the 99th, so both report
 * as "top 10%" rather than inventing a number.
 */
export function percentileFrom(anchors: [number, number][], value: number, higherIsBetter: boolean): {
  percentile: number; capped: "low" | "high" | null;
} {
  const a = [...anchors].sort((x, y) => x[1] - y[1]);
  const lo = a[0], hi = a[a.length - 1];

  const raw = (() => {
    if (value <= lo[1]) return { p: lo[0], capped: "low" as const };
    if (value >= hi[1]) return { p: hi[0], capped: "high" as const };
    for (let i = 0; i < a.length - 1; i++) {
      const [p1, v1] = a[i], [p2, v2] = a[i + 1];
      if (value >= v1 && value <= v2) {
        const t = v2 === v1 ? 0 : (value - v1) / (v2 - v1);
        return { p: p1 + t * (p2 - p1), capped: null };
      }
    }
    return { p: 50, capped: null };
  })();

  // For a lower-is-better metric, being at the low end of the value scale means
  // being at the TOP of the population.
  const percentile = higherIsBetter ? raw.p : 100 - raw.p;
  const capped = raw.capped === null ? null
    : higherIsBetter ? raw.capped
    : raw.capped === "low" ? "high" : "low";
  return { percentile: Math.round(percentile), capped };
}

export function anchorsFor(b: Benchmark, sex: Sex, age: number): [number, number][] | null {
  return b.anchors[sex]?.[decade(age)] ?? null;
}

export const ageDecade = decade;

/** Plain-language band, so the number is never the only thing on offer. */
export function band(p: number): string {
  if (p >= 90) return "top 10%";
  if (p >= 75) return "top quarter";
  if (p >= 60) return "above average";
  if (p >= 40) return "around average";
  if (p >= 25) return "below average";
  return "bottom quarter";
}

import { mean, stdev, clamp } from "./stats";
import type { Point } from "../metric-meta";
import { addDays, daysBetween } from "../metric-meta";

export type WorkoutLike = {
  date: string;
  duration_min: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  rpe: number | null;
  calories: number | null;
  type: string | null;
};

/**
 * Session load in arbitrary units, best-available method:
 *   1. Banister TRIMP when heart rate is present (weights time by intensity
 *      exponentially, so an hour at threshold counts far more than an easy hour)
 *   2. session-RPE (duration x RPE) when you logged a perceived effort
 *   3. duration alone as a last resort
 */
export function sessionLoad(w: WorkoutLike, restingHr: number, maxHr: number): number {
  const dur = w.duration_min ?? 0;
  if (dur <= 0) return 0;

  // A single session above ~600 load units is a data artefact, not training.
  const cap = (n: number) => Math.min(n, 600);

  if (w.avg_hr && maxHr > restingHr) {
    const hrr = clamp((w.avg_hr - restingHr) / (maxHr - restingHr), 0, 1);
    // Banister's exponential intensity weighting (male coefficient 1.92)
    return cap(dur * hrr * 0.64 * Math.exp(1.92 * hrr));
  }
  if (w.rpe) return cap(dur * w.rpe);

  // Without heart rate or RPE, duration is all we have — but a minute of it
  // means different things by modality. Lifting is intermittent: most of a
  // two-hour session is rest between sets, so charging it the same per-minute
  // rate as a steady run massively overstates the systemic stress.
  const t = (w.type ?? "").toUpperCase();
  const perMinute =
    /STRENGTH|WEIGHT|LIFT|RESISTANCE/.test(t) ? 1.4
    : /WALK|YOGA|STRETCH|PILATES|MOBILITY/.test(t) ? 1.0
    : /RUN|BIKE|CYCL|SWIM|ROW|HIIT|INTERVAL/.test(t) ? 3.5
    : 2.5;
  return cap(dur * perMinute);
}

export function estimateMaxHr(age: number | null, observedMax: number | null): number {
  const tanaka = age ? 208 - 0.7 * age : 190; // Tanaka: more accurate than 220-age
  return Math.max(observedMax ?? 0, tanaka);
}

export type LoadSeries = {
  dates: string[];
  daily: number[];
  ctl: number[];              // chronic training load — "fitness"
  atl: number[];              // acute training load — "fatigue"
  tsb: (number | null)[];     // training stress balance — "form"; null on day 0
  acwr: (number | null)[];    // acute:chronic ratio; null before a chronic base exists
  /** True once a full chronic window has elapsed. Below this the values are
   *  unbiased but high-variance, so risk thresholds must not be applied. */
  established: boolean[];
  warmupDays: number;
};

/**
 * Impulse-response training model.
 *
 * CTL (42-day EWMA) is what you've built; ATL (7-day) is what you're carrying.
 * Form = CTL - ATL: negative means buried, strongly positive means fresh but
 * detraining. ACWR flags spikes — sustained values above ~1.5 are where injury
 * risk climbs sharply in the sports-science literature.
 */
export function trainingLoad(daily: { date: string; load: number }[], ctlDays = 42, atlDays = 7): LoadSeries {
  if (!daily.length) {
    return { dates: [], daily: [], ctl: [], atl: [], tsb: [], acwr: [], established: [], warmupDays: ctlDays };
  }
  const start = daily[0].date;
  const end = daily[daily.length - 1].date;
  const map = new Map(daily.map((d) => [d.date, d.load]));

  const dates: string[] = [], loads: number[] = [];
  for (let d = start; daysBetween(d, end) >= 0; d = addDays(d, 1)) {
    dates.push(d);
    loads.push(map.get(d) ?? 0);
  }

  const aC = 1 - Math.exp(-1 / ctlDays);
  const aA = 1 - Math.exp(-1 / atlDays);
  const ctl: number[] = [], atl: number[] = [];
  const tsb: (number | null)[] = [], acwr: (number | null)[] = [];
  const established: boolean[] = [];

  let c = 0, a = 0;
  for (let i = 0; i < loads.length; i++) {
    // Form is measured *before* today's session lands, so it uses yesterday's
    // debiased values.
    const prevBiasC = i > 0 ? 1 - Math.pow(1 - aC, i) : 0;
    const prevBiasA = i > 0 ? 1 - Math.pow(1 - aA, i) : 0;
    tsb.push(i > 0 ? c / prevBiasC - a / prevBiasA : null);

    c = c + aC * (loads[i] - c);
    a = a + aA * (loads[i] - a);

    // Both averages start at zero, so early on they under-report by a known
    // factor. For a constant load L the raw EWMA is exactly L(1-(1-alpha)^(i+1)),
    // so dividing by that recovers L from day one. Without this the 7-day
    // average converges ~6x faster than the 42-day one and their ratio starts
    // near 5.7 — which the app read as an injury-risk spike for every new user's
    // first six weeks, on identical daily training.
    const biasC = 1 - Math.pow(1 - aC, i + 1);
    const biasA = 1 - Math.pow(1 - aA, i + 1);
    const ctlI = c / biasC;
    const atlI = a / biasA;

    ctl.push(ctlI);
    atl.push(atlI);
    acwr.push(ctlI > 1 ? atlI / ctlI : null);
    established.push(i >= ctlDays);
  }
  return { dates, daily: loads, ctl, atl, tsb, acwr, established, warmupDays: ctlDays };
}

/** Foster's monotony & strain: same load every day is more damaging than the
 *  same total with hard/easy variation. High strain precedes overreaching. */
export function monotonyStrain(loads: number[]) {
  const w = loads.slice(-7);
  if (w.length < 7) return null;
  const m = mean(w)!;
  const s = stdev(w);
  if (!s) return null;
  const monotony = m / s;
  return { monotony, strain: m * 7 * monotony, weeklyLoad: m * 7 };
}

export type ReadinessInput = {
  hrv: Point[];
  restingHr: Point[];
  sleep: Point[];
  tsb?: { date: string; value: number }[];
};

/**
 * Daily readiness, 0-100.
 *
 * Each input is scored against *your own* trailing 60-day baseline rather than
 * population norms — an HRV of 45ms means nothing in the abstract, but 45 when
 * you normally run 70 means something. Weights favour HRV and resting HR, the
 * two most responsive autonomic markers.
 */
export function readinessSeries(input: ReadinessInput, window = 60) {
  const comps: { points: Point[]; weight: number; higherBetter: boolean }[] = [
    { points: input.hrv, weight: 0.35, higherBetter: true },
    { points: input.restingHr, weight: 0.3, higherBetter: false },
    { points: input.sleep, weight: 0.25, higherBetter: true },
  ];

  const allDates = new Set<string>();
  for (const c of comps) for (const p of c.points) allDates.add(p.date);
  if (input.tsb) for (const p of input.tsb) allDates.add(p.date);
  const dates = [...allDates].sort();

  const out: { date: string; value: number; parts: Record<string, number> }[] = [];
  for (const date of dates) {
    let sum = 0, wsum = 0;
    const parts: Record<string, number> = {};
    const names = ["hrv", "resting_hr", "sleep"];

    comps.forEach((c, i) => {
      const hist = c.points.filter((p) => p.date < date).slice(-window).map((p) => p.value);
      const todayPt = c.points.find((p) => p.date === date);
      if (!todayPt || hist.length < 10) return;
      const m = mean(hist)!;
      const s = stdev(hist);
      if (!s) return;
      let z = (todayPt.value - m) / s;
      if (!c.higherBetter) z = -z;
      const score = 50 + 20 * clamp(z, -2.5, 2.5); // ~1 SD = 20 points
      parts[names[i]] = score;
      sum += score * c.weight;
      wsum += c.weight;
    });

    // Form contributes a small nudge: deeply negative TSB drags readiness down.
    const tsbPt = input.tsb?.find((p) => p.date === date);
    if (tsbPt) {
      const score = 50 + clamp(tsbPt.value, -40, 25) * 0.8;
      parts.form = score;
      sum += score * 0.1;
      wsum += 0.1;
    }

    if (wsum >= 0.5) out.push({ date, value: clamp(sum / wsum, 0, 100), parts });
  }
  return out;
}

/** Fat-free mass from weight + body fat %, and the recomp signal that matters:
 *  are you losing fat while holding (or building) lean tissue? */
export function bodyComposition(weight: Point[], bodyFat: Point[]) {
  const bfMap = new Map(bodyFat.map((p) => [p.date, p.value]));
  const lean: Point[] = [], fat: Point[] = [];
  for (const w of weight) {
    const bf = bfMap.get(w.date);
    if (bf === undefined) continue;
    fat.push({ date: w.date, value: w.value * (bf / 100) });
    lean.push({ date: w.date, value: w.value * (1 - bf / 100) });
  }
  return { lean, fat };
}

/**
 * Recomposition quality: of the weight you changed, how much came from fat?
 * The number people actually want when they say "full recomp" — losing 4kg of
 * which 4kg is fat is a completely different outcome from losing 4kg of which
 * 2kg is muscle, and the scale alone cannot tell them apart.
 */
export function recompScore(lean: Point[], fat: Point[], days = 56) {
  if (lean.length < 4 || fat.length < 4) return null;
  const cutoff = addDays(lean[lean.length - 1].date, -days);
  const lw = lean.filter((p) => p.date >= cutoff);
  const fw = fat.filter((p) => p.date >= cutoff);
  if (lw.length < 3 || fw.length < 3) return null;

  const leanStart = mean(lw.slice(0, 3).map((p) => p.value))!;
  const leanEnd = mean(lw.slice(-3).map((p) => p.value))!;
  const fatStart = mean(fw.slice(0, 3).map((p) => p.value))!;
  const fatEnd = mean(fw.slice(-3).map((p) => p.value))!;

  const dLean = leanEnd - leanStart;
  const dFat = fatEnd - fatStart;
  const total = Math.abs(dLean) + Math.abs(dFat);

  // Ideal recomp: fat down, lean up or flat.
  let quality: number;
  if (total < 0.05) quality = 50;
  else quality = clamp(50 + ((-dFat + dLean) / total) * 50, 0, 100);

  return {
    days, deltaLean: dLean, deltaFat: dFat, quality,
    verdict:
      dFat < -0.2 && dLean >= -0.1 ? "recomposing"
      : dFat < -0.2 && dLean < -0.1 ? "losing both"
      : dFat >= 0.2 && dLean > 0.2 ? "gaining both"
      : dFat >= 0.2 ? "gaining fat"
      : "holding",
  };
}

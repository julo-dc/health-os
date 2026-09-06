import { mean, median, stdev, normCdf, linreg, welch, cohensD, robustZ, clamp } from "./stats";
import type { Point } from "../metric-meta";
import { addDays, daysBetween } from "../metric-meta";

/** Fill a series onto a continuous daily grid. `gaps` stays null so we never
 *  invent data; smoothing carries the last value forward instead. */
export function toGrid(points: Point[], from?: string, to?: string) {
  if (!points.length) return { dates: [] as string[], values: [] as (number | null)[] };
  const start = from ?? points[0].date;
  const end = to ?? points[points.length - 1].date;
  const map = new Map(points.map((p) => [p.date, p.value]));
  const dates: string[] = [];
  const values: (number | null)[] = [];
  for (let d = start; daysBetween(d, end) >= 0; d = addDays(d, 1)) {
    dates.push(d);
    values.push(map.has(d) ? map.get(d)! : null);
  }
  return { dates, values };
}

/** Exponentially weighted moving average over a gridded series.
 *  Missing days decay the estimate rather than resetting it. */
export function ewma(values: (number | null)[], halfLife = 7): (number | null)[] {
  const alpha = 1 - Math.exp(Math.LN2 / -halfLife);
  let s: number | null = null;
  return values.map((v) => {
    if (v === null) return s;
    s = s === null ? v : alpha * v + (1 - alpha) * s;
    return s;
  });
}

/** Centred rolling mean, ignoring nulls inside the window. */
export function rollingMean(values: (number | null)[], window = 7, centred = false): (number | null)[] {
  const out: (number | null)[] = [];
  const half = Math.floor(window / 2);
  for (let i = 0; i < values.length; i++) {
    const lo = centred ? Math.max(0, i - half) : Math.max(0, i - window + 1);
    const hi = centred ? Math.min(values.length - 1, i + half) : i;
    const w = values.slice(lo, hi + 1).filter((v): v is number => v !== null);
    out.push(w.length ? mean(w) : null);
  }
  return out;
}

export type TrendResult = {
  n: number;
  slopePerDay: number;
  slopePerWeek: number;
  senSlopePerDay: number;
  r2: number;
  pValue: number;
  mkZ: number;
  mkP: number;
  direction: "rising" | "falling" | "flat";
  significant: boolean;
  first: number;
  last: number;
  changePct: number | null;
};

/**
 * Trend analysis combining OLS with the Mann-Kendall test.
 *
 * Mann-Kendall is non-parametric: it only looks at the direction of every
 * pairwise comparison, so a couple of wild readings can't manufacture a trend
 * the way they can with a least-squares line. When the two disagree, MK is the
 * one to trust for noisy biometric series.
 */
export function analyseTrend(points: Point[]): TrendResult | null {
  const pts = points.filter((p) => Number.isFinite(p.value));
  if (pts.length < 5) return null;
  const t0 = pts[0].date;
  const x = pts.map((p) => daysBetween(t0, p.date));
  const y = pts.map((p) => p.value);

  const fit = linreg(x, y);
  if (!fit) return null;
  const { z, p } = mannKendall(y);
  const sen = senSlope(x, y);

  const first = y[0], last = y[y.length - 1];
  const significant = p < 0.05;
  const direction = !significant ? "flat" : sen > 0 ? "rising" : sen < 0 ? "falling" : "flat";

  return {
    n: pts.length,
    slopePerDay: fit.slope,
    slopePerWeek: fit.slope * 7,
    senSlopePerDay: sen,
    r2: fit.r2,
    pValue: fit.p,
    mkZ: z,
    mkP: p,
    direction,
    significant,
    first,
    last,
    changePct: first !== 0 ? ((last - first) / Math.abs(first)) * 100 : null,
  };
}

/** Mann-Kendall trend test with tie correction. */
export function mannKendall(y: number[]) {
  const n = y.length;
  let S = 0;
  for (let i = 0; i < n - 1; i++)
    for (let j = i + 1; j < n; j++) S += Math.sign(y[j] - y[i]);

  const counts = new Map<number, number>();
  for (const v of y) counts.set(v, (counts.get(v) ?? 0) + 1);
  let tieAdj = 0;
  for (const c of counts.values()) if (c > 1) tieAdj += c * (c - 1) * (2 * c + 5);

  const varS = (n * (n - 1) * (2 * n + 5) - tieAdj) / 18;
  if (varS <= 0) return { S, z: 0, p: 1 };
  const z = S > 0 ? (S - 1) / Math.sqrt(varS) : S < 0 ? (S + 1) / Math.sqrt(varS) : 0;
  return { S, z, p: 2 * (1 - normCdf(Math.abs(z))) };
}

/** Theil-Sen slope: the median of all pairwise slopes. Robust to ~29% outliers. */
export function senSlope(x: number[], y: number[]): number {
  const slopes: number[] = [];
  for (let i = 0; i < x.length - 1; i++)
    for (let j = i + 1; j < x.length; j++) {
      const dx = x[j] - x[i];
      if (dx !== 0) slopes.push((y[j] - y[i]) / dx);
    }
  return median(slopes) ?? 0;
}

export type ChangePoint = {
  date: string;
  index: number;
  before: number;
  after: number;
  delta: number;
  effectSize: number;
  pValue: number;
};

/**
 * Binary segmentation change-point detection.
 *
 * Recursively splits the series at the point of maximum Welch t-statistic,
 * keeping splits that clear a significance and effect-size bar. This is what
 * surfaces "something changed on March 12th" — a training block starting, a
 * business push, an illness — without you having to remember it.
 */
export function findChangePoints(
  points: Point[],
  opts: { minSegment?: number; maxPoints?: number; alpha?: number; minEffect?: number } = {}
): ChangePoint[] {
  const { minSegment = 10, maxPoints = 4, alpha = 0.01, minEffect = 0.8 } = opts;
  const pts = points.filter((p) => Number.isFinite(p.value));
  if (pts.length < minSegment * 2) return [];
  const y = pts.map((p) => p.value);
  const found: ChangePoint[] = [];

  const search = (lo: number, hi: number) => {
    if (found.length >= maxPoints || hi - lo < minSegment * 2) return;
    let bestT = 0, bestI = -1;
    for (let i = lo + minSegment; i <= hi - minSegment; i++) {
      const w = welch(y.slice(lo, i), y.slice(i, hi));
      if (w && Math.abs(w.t) > bestT) { bestT = Math.abs(w.t); bestI = i; }
    }
    if (bestI < 0) return;
    const before = y.slice(lo, bestI), after = y.slice(bestI, hi);
    const w = welch(before, after)!;
    const d = cohensD(before, after);
    if (w.p > alpha || d === null || Math.abs(d) < minEffect) return;

    found.push({
      date: pts[bestI].date,
      index: bestI,
      before: w.meanA,
      after: w.meanB,
      delta: w.delta,
      effectSize: d,
      pValue: w.p,
    });
    search(lo, bestI);
    search(bestI, hi);
  };

  search(0, y.length);
  return found.sort((a, b) => a.date.localeCompare(b.date));
}

export type Anomaly = { date: string; value: number; z: number; direction: "high" | "low" };

/** Flag readings that are extreme relative to a trailing baseline. */
export function findAnomalies(points: Point[], lookback = 42, threshold = 3): Anomaly[] {
  const out: Anomaly[] = [];
  for (let i = lookback; i < points.length; i++) {
    const base = points.slice(i - lookback, i).map((p) => p.value);
    const z = robustZ(base, points[i].value);
    if (z !== null && Math.abs(z) >= threshold) {
      out.push({ date: points[i].date, value: points[i].value, z, direction: z > 0 ? "high" : "low" });
    }
  }
  return out;
}

/**
 * Day-of-week effect: is your Saturday systematically different from your Tuesday?
 *
 * Plotted as a deviation from your overall average, a tight axis will happily
 * render pure noise as a convincing weekday pattern. So each bucket also carries
 * whether its deviation actually clears its own sampling error — the UI greys
 * out the ones that don't, rather than inviting you to read a story into them.
 */
export function weekdayProfile(points: Point[]) {
  const buckets: number[][] = Array.from({ length: 7 }, () => []);
  for (const p of points) {
    const dow = new Date(p.date + "T00:00:00Z").getUTCDay();
    buckets[dow].push(p.value);
  }
  const all = points.map((p) => p.value);
  const overall = mean(all);
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return buckets.map((b, i) => {
    const m = mean(b);
    const delta = overall !== null && b.length ? (m ?? 0) - overall : null;
    // Welch against every other day, so a weekday is judged relative to the rest.
    const rest = buckets.filter((_, j) => j !== i).flat();
    const w = b.length >= 3 && rest.length >= 3 ? welch(rest, b) : null;
    return {
      day: names[i],
      n: b.length,
      mean: m,
      delta,
      pValue: w?.p ?? null,
      significant: w !== null && w.p < 0.05,
    };
  });
}

/** Fraction of days in the window that actually have a reading. Analytics on a
 *  40%-covered series is a guess, and the UI should say so. */
export function coverage(points: Point[], from: string, to: string) {
  const days = daysBetween(from, to) + 1;
  const inRange = points.filter((p) => p.date >= from && p.date <= to).length;
  return { days, observed: inRange, ratio: days > 0 ? clamp(inRange / days, 0, 1) : 0 };
}

/** Consecutive-day streak ending today, for adherence-style metrics. */
export function streak(points: Point[], predicate: (v: number) => boolean, endDate: string) {
  const map = new Map(points.map((p) => [p.date, p.value]));
  let n = 0;
  for (let d = endDate; ; d = addDays(d, -1)) {
    const v = map.get(d);
    if (v === undefined || !predicate(v)) break;
    n++;
    if (n > 3650) break;
  }
  return n;
}

import { stdev, quantile, mulberry32, clamp } from "./stats";
import type { Point } from "../metric-meta";
import { addDays, daysBetween } from "../metric-meta";
import { toGrid } from "./trend";

export type HoltModel = {
  alpha: number; beta: number; phi: number;
  level: number; trend: number;
  residuals: number[]; sigma: number; sse: number; n: number;
};

/**
 * Holt's linear method with a damped trend.
 *
 * Damping (phi < 1) matters here: an undamped linear extrapolation of a weight
 * loss trend happily predicts you weigh 40kg by Christmas. phi flattens the
 * projection as the horizon grows, which is the honest shape for biological and
 * business series that plateau.
 */
export function fitHolt(values: (number | null)[]): HoltModel | null {
  const y = interpolate(values);
  if (y.length < 8) return null;

  let best: HoltModel | null = null;
  for (let a = 0.05; a <= 0.95; a += 0.05)
    for (let b = 0.0; b <= 0.5; b += 0.05)
      for (const phi of [0.80, 0.90, 0.95, 0.98, 1.0]) {
        const m = runHolt(y, a, b, phi);
        if (m && (!best || m.sse < best.sse)) best = m;
      }
  return best;
}

function runHolt(y: number[], alpha: number, beta: number, phi: number): HoltModel | null {
  let level = y[0];
  let trend = y.length > 3 ? (y[3] - y[0]) / 3 : 0;
  const residuals: number[] = [];
  let sse = 0;

  for (let t = 1; t < y.length; t++) {
    const pred = level + phi * trend;
    const err = y[t] - pred;
    residuals.push(err);
    sse += err * err;
    const prevLevel = level;
    level = alpha * y[t] + (1 - alpha) * pred;
    trend = beta * (level - prevLevel) + (1 - beta) * phi * trend;
  }
  if (!Number.isFinite(sse)) return null;
  return {
    alpha, beta, phi, level, trend, residuals,
    sigma: stdev(residuals) ?? 0,
    sse, n: y.length,
  };
}

/** Linear interpolation across interior gaps; leading nulls are dropped. */
function interpolate(values: (number | null)[]): number[] {
  const firstIdx = values.findIndex((v) => v !== null);
  if (firstIdx < 0) return [];
  const v = values.slice(firstIdx);
  const out: number[] = [];
  for (let i = 0; i < v.length; i++) {
    if (v[i] !== null) { out.push(v[i]!); continue; }
    let j = i;
    while (j < v.length && v[j] === null) j++;
    const prev = out[out.length - 1];
    if (j >= v.length) { out.push(prev); continue; }
    const next = v[j]!;
    // walk 1/remaining of the way to `next` each step -> a straight line across the gap
    const remaining = j - i + 1;
    out.push(prev + (next - prev) / remaining);
  }
  return out;
}

export type ForecastBand = {
  date: string;
  p10: number; p25: number; p50: number; p75: number; p90: number;
};

export type Forecast = {
  bands: ForecastBand[];
  /** Terminal value of every simulated path — the exact distribution to test goals against. */
  terminal: number[];
  model: { alpha: number; beta: number; phi: number; sigma: number; n: number };
  lastDate: string;
  lastValue: number;
};

/**
 * Simulate the fitted model forward, bootstrapping residuals rather than
 * assuming normal errors — real biometric residuals are fat-tailed and skewed,
 * and resampling the actual ones keeps that shape in the prediction interval.
 */
export function forecast(
  points: Point[],
  horizonDays: number,
  sims = 800,
  /** Hard limits the metric cannot physically exceed, e.g. [0, 100] for a
   *  percentage or a 0-100 score. Without these a score bounded at 100 happily
   *  forecasts a band of -14 to 102, which discredits the whole projection. */
  bounds?: [number, number]
): Forecast | null {
  if (points.length < 8) return null;
  const { dates, values } = toGrid(points);
  const model = fitHolt(values);
  if (!model || !model.residuals.length) return null;

  const rand = mulberry32(hash(points[0].date + points.length + horizonDays));
  const res = model.residuals;
  const paths: number[][] = [];

  for (let s = 0; s < sims; s++) {
    let level = model.level, trend = model.trend;
    const path: number[] = [];
    for (let h = 0; h < horizonDays; h++) {
      const pred = level + model.phi * trend;
      const eps = res[Math.floor(rand() * res.length)];
      let obs = pred + eps;
      if (bounds) obs = clamp(obs, bounds[0], bounds[1]);
      path.push(obs);
      const prevLevel = level;
      level = model.alpha * obs + (1 - model.alpha) * pred;
      trend = model.beta * (level - prevLevel) + (1 - model.beta) * model.phi * trend;
    }
    paths.push(path);
  }

  const lastDate = dates[dates.length - 1];
  const bands: ForecastBand[] = [];
  for (let h = 0; h < horizonDays; h++) {
    const col = paths.map((p) => p[h]);
    bands.push({
      date: addDays(lastDate, h + 1),
      p10: quantile(col, 0.1)!, p25: quantile(col, 0.25)!,
      p50: quantile(col, 0.5)!,
      p75: quantile(col, 0.75)!, p90: quantile(col, 0.9)!,
    });
  }

  return {
    bands,
    terminal: paths.map((p) => p[horizonDays - 1]),
    model: { alpha: model.alpha, beta: model.beta, phi: model.phi, sigma: model.sigma, n: model.n },
    lastDate,
    lastValue: points[points.length - 1].value,
  };
}

export type Projection = {
  probability: number;
  projected: number;
  projectedLow: number;
  projectedHigh: number;
  targetDate: string;
  currentValue: number;
  requiredRatePerWeek: number;
  currentRatePerWeek: number;
  etaDate: string | null;
  horizonDays: number;
};

/**
 * Probability of reaching `target` by `targetDate`, from the simulated paths.
 * "Reaching" is directional and sticky-free: we test the value on the day, not
 * whether it ever touched the target en route.
 */
export function projectToTarget(
  points: Point[],
  target: number,
  direction: "increase" | "decrease" | "maintain",
  targetDate: string,
  today: string,
  tolerance = 0,
  bounds?: [number, number]
): Projection | null {
  if (points.length < 8) return null;
  const horizon = daysBetween(today, targetDate);
  if (horizon <= 0) return null;
  const f = forecast(points, Math.min(horizon, 730), 800, bounds);
  if (!f) return null;

  const hit = (v: number) =>
    direction === "increase" ? v >= target
      : direction === "decrease" ? v <= target
      : Math.abs(v - target) <= (tolerance || Math.abs(target) * 0.02);

  const band = f.bands[f.bands.length - 1];
  // Count outcomes across the simulated paths directly — exact, and it handles
  // the two-sided "maintain" band that a quantile reconstruction would fumble.
  const probability = f.terminal.length
    ? clamp(f.terminal.filter(hit).length / f.terminal.length, 0, 1)
    : 0;

  const current = points[points.length - 1].value;
  const recent = points.slice(-28);
  const currentRate =
    recent.length >= 4
      ? ((recent[recent.length - 1].value - recent[0].value) /
          Math.max(1, daysBetween(recent[0].date, recent[recent.length - 1].date))) * 7
      : 0;
  const requiredRate = ((target - current) / Math.max(1, horizon)) * 7;

  // First day the median path crosses the target.
  let eta: string | null = null;
  for (const b of f.bands) if (hit(b.p50)) { eta = b.date; break; }

  return {
    probability,
    projected: band.p50,
    projectedLow: band.p10,
    projectedHigh: band.p90,
    targetDate,
    currentValue: current,
    requiredRatePerWeek: requiredRate,
    currentRatePerWeek: currentRate,
    etaDate: eta,
    horizonDays: horizon,
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

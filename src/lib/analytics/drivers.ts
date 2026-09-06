import { pearson, spearman, mean, stdev, tTestP, normCdf } from "./stats";
import type { Point } from "../metric-meta";
import { addDays } from "../metric-meta";

/** Align two series on the dates they share, optionally shifting x back by `lag` days. */
export function align(x: Point[], y: Point[], lag = 0) {
  const xm = new Map(x.map((p) => [p.date, p.value]));
  const ax: number[] = [], ay: number[] = [], dates: string[] = [];
  for (const p of y) {
    const v = xm.get(addDays(p.date, -lag));
    if (v !== undefined && Number.isFinite(v) && Number.isFinite(p.value)) {
      ax.push(v); ay.push(p.value); dates.push(p.date);
    }
  }
  return { x: ax, y: ay, dates };
}

export type LagResult = { lag: number; r: number; n: number; p: number };

/**
 * Cross-correlation across candidate lags.
 *
 * Lag k means "x from k days ago vs y today", so a peak at lag 1 for
 * sleep -> focus reads as "last night's sleep predicts today's focus". This is
 * correlational, not causal, but the lag structure at least rules out the
 * reverse direction in time.
 */
export function laggedCorrelation(x: Point[], y: Point[], maxLag = 7): LagResult[] {
  const out: LagResult[] = [];
  for (let lag = 0; lag <= maxLag; lag++) {
    const a = align(x, y, lag);
    if (a.x.length < 10) continue;
    const r = spearman(a.x, a.y);
    if (r === null) continue;
    // Fisher z-transform for the significance of a correlation
    const n = a.x.length;
    const z = 0.5 * Math.log((1 + r) / (1 - r)) * Math.sqrt(n - 3);
    out.push({ lag, r, n, p: 2 * (1 - normCdf(Math.abs(z))) });
  }
  return out;
}

export function bestLag(x: Point[], y: Point[], maxLag = 7): LagResult | null {
  const all = laggedCorrelation(x, y, maxLag);
  if (!all.length) return null;
  return all.reduce((b, c) => (Math.abs(c.r) > Math.abs(b.r) ? c : b));
}

export type Driver = {
  key: string;
  label: string;
  lag: number;
  correlation: number;
  coefficient: number;      // standardised — comparable across metrics
  contribution: number;     // share of explained movement, 0..1
  n: number;
  p: number;
  /** Sign of the effect on the metric itself. */
  direction: "raises" | "lowers";
  /** Whether that effect moves the metric the way you want it to go.
   *  null when the metric has no inherent good direction. */
  favourable: boolean | null;
};

/**
 * Which inputs actually move the target metric?
 *
 * Ridge regression on standardised, best-lag-aligned features. Ridge rather than
 * plain OLS because health inputs are heavily collinear (steps, active minutes
 * and calories all move together) and OLS responds by handing out enormous
 * cancelling coefficients. The L2 penalty keeps them interpretable.
 */
export function driverAnalysis(
  target: Point[],
  candidates: { key: string; label: string; points: Point[] }[],
  opts: {
    maxLag?: number; lambda?: number; minOverlap?: number;
    /** true = higher is better for the target, false = lower, null = neither. */
    higherBetter?: boolean | null;
    /** Rows required per predictor before a feature earns its place. */
    rowsPerFeature?: number;
  } = {}
): { drivers: Driver[]; r2: number; adjR2: number; n: number } {
  const { maxLag = 3, lambda = 1.0, minOverlap = 20, higherBetter = null, rowsPerFeature = 8 } = opts;

  // 1. Pick each candidate's most predictive lag.
  const chosen: { key: string; label: string; lag: number; r: number; p: number; map: Map<string, number> }[] = [];
  for (const c of candidates) {
    const bl = bestLag(c.points, target, maxLag);
    if (!bl || bl.n < minOverlap) continue;
    chosen.push({
      key: c.key, label: c.label, lag: bl.lag, r: bl.r, p: bl.p,
      map: new Map(c.points.map((p) => [p.date, p.value])),
    });
  }
  if (!chosen.length) return { drivers: [], r2: 0, adjR2: 0, n: 0 };

  // Rank by raw association and keep only the strongest few. Ridge tolerates
  // collinearity but nothing rescues 15 predictors fitted on 40 rows, and an
  // overfitted model produces confident-looking coefficients that mean nothing.
  chosen.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  chosen.splice(8);

  // 2. Build the design matrix on dates where every feature is present.
  const rowsX: number[][] = [];
  const rowsY: number[] = [];
  for (const t of target) {
    const row: number[] = [];
    let ok = true;
    for (const c of chosen) {
      const v = c.map.get(addDays(t.date, -c.lag));
      if (v === undefined || !Number.isFinite(v)) { ok = false; break; }
      row.push(v);
    }
    if (ok && Number.isFinite(t.value)) { rowsX.push(row); rowsY.push(t.value); }
  }
  if (rowsX.length < Math.max(minOverlap, chosen.length + 5)) return { drivers: [], r2: 0, adjR2: 0, n: rowsX.length };

  // Complete-case rows are scarcer than any single pairwise overlap. Drop the
  // weakest predictors until the model has enough rows to support the ones left.
  while (chosen.length > 1 && rowsX.length < chosen.length * rowsPerFeature) {
    const drop = chosen.length - 1;
    chosen.splice(drop, 1);
    for (const r of rowsX) r.splice(drop, 1);
  }

  // 3. Standardise so coefficients are directly comparable.
  const p = chosen.length;
  const mu: number[] = [], sd: number[] = [];
  for (let j = 0; j < p; j++) {
    const col = rowsX.map((r) => r[j]);
    mu.push(mean(col)!);
    sd.push(stdev(col) || 1);
  }
  const X = rowsX.map((r) => r.map((v, j) => (v - mu[j]) / sd[j]));
  const yMu = mean(rowsY)!, ySd = stdev(rowsY) || 1;
  const Y = rowsY.map((v) => (v - yMu) / ySd);

  const beta = ridge(X, Y, lambda);
  if (!beta) return { drivers: [], r2: 0, adjR2: 0, n: rowsX.length };

  // 4. R^2 of the fitted model.
  let ssr = 0, sst = 0;
  for (let i = 0; i < X.length; i++) {
    const pred = X[i].reduce((a, v, j) => a + v * beta[j], 0);
    ssr += (Y[i] - pred) ** 2;
    sst += Y[i] ** 2;
  }
  const r2 = sst ? Math.max(0, 1 - ssr / sst) : 0;
  // Adjusted R² is the honest number to show: raw R² only ever climbs as you
  // add predictors, so on a short series it flatters a model that has learned
  // the noise. This penalises each predictor for the row it costs.
  const dof = X.length - p - 1;
  const adjR2 = dof > 0 ? Math.max(0, 1 - (1 - r2) * (X.length - 1) / dof) : 0;

  const totalAbs = beta.reduce((a, b) => a + Math.abs(b), 0) || 1;
  const drivers: Driver[] = chosen.map((c, j) => ({
    key: c.key,
    label: c.label,
    lag: c.lag,
    correlation: c.r,
    coefficient: beta[j],
    contribution: Math.abs(beta[j]) / totalAbs,
    n: rowsX.length,
    p: c.p,
    direction: (beta[j] >= 0 ? "raises" : "lowers") as Driver["direction"],
    // A driver that lowers body fat is favourable; one that lowers HRV is not.
    favourable: higherBetter === null ? null : (beta[j] >= 0) === higherBetter,
  })).sort((a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient));

  return { drivers, r2, adjR2, n: rowsX.length };
}

/** Solve (X'X + lambda*I) beta = X'y by Gaussian elimination with partial pivoting. */
function ridge(X: number[][], y: number[], lambda: number): number[] | null {
  const n = X.length, p = X[0].length;
  const A: number[][] = Array.from({ length: p }, () => new Array(p + 1).fill(0));

  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += X[k][i] * X[k][j];
      A[i][j] = s + (i === j ? lambda : 0);
    }
    let s = 0;
    for (let k = 0; k < n; k++) s += X[k][i] * y[k];
    A[i][p] = s;
  }

  for (let col = 0; col < p; col++) {
    let piv = col;
    for (let r = col + 1; r < p; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = 0; r < p; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c <= p; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map((row, i) => row[p] / A[i][i]);
}

/**
 * A/B comparison of the target metric on days when a behaviour was above vs
 * below its own median. Reads far more plainly than a coefficient:
 * "on high-sleep days your focus averages 7.4 vs 5.9".
 */
export function behaviourSplit(behaviour: Point[], target: Point[], lag = 1) {
  const a = align(behaviour, target, lag);
  if (a.x.length < 12) return null;
  const sorted = [...a.x].sort((p, q) => p - q);
  const med = sorted[sorted.length >> 1];
  const low: number[] = [], high: number[] = [];
  for (let i = 0; i < a.x.length; i++) (a.x[i] > med ? high : low).push(a.y[i]);
  if (low.length < 4 || high.length < 4) return null;
  const ml = mean(low)!, mh = mean(high)!;
  return {
    threshold: med, lag,
    lowMean: ml, highMean: mh,
    delta: mh - ml,
    deltaPct: ml !== 0 ? ((mh - ml) / Math.abs(ml)) * 100 : null,
    nLow: low.length, nHigh: high.length,
  };
}

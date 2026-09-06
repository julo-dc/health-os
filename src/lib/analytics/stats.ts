/** Foundational statistics. Every function tolerates short/empty input by
 *  returning null rather than NaN, so the UI can say "not enough data". */

export const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : null);

export function median(x: number[]): number | null {
  if (!x.length) return null;
  const s = [...x].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(x: number[], q: number): number | null {
  if (!x.length) return null;
  const s = [...x].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function stdev(x: number[]): number | null {
  if (x.length < 2) return null;
  const m = mean(x)!;
  return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1));
}

/** Median absolute deviation, scaled to be a consistent estimator of sigma. */
export function mad(x: number[]): number | null {
  const m = median(x);
  if (m === null) return null;
  const d = median(x.map((v) => Math.abs(v - m)));
  return d === null ? null : d * 1.4826;
}

/** Outlier-resistant z-score. Preferred over the plain z for health data,
 *  where one bad sensor reading otherwise inflates sigma and hides real signal. */
export function robustZ(x: number[], v: number): number | null {
  const m = median(x);
  const s = mad(x);
  if (m === null || !s) return null;
  return (v - m) / s;
}

export function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const ma = mean(a.slice(0, n))!;
  const mb = mean(b.slice(0, n))!;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

const rank = (x: number[]) => {
  const idx = x.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
  const r = new Array(x.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; // average rank for ties
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
};

/** Rank correlation — catches monotone but non-linear relationships. */
export const spearman = (a: number[], b: number[]) => pearson(rank(a), rank(b));

export type Fit = {
  slope: number; intercept: number; r2: number;
  se: number; t: number; p: number; n: number;
};

/** Ordinary least squares of y on x, with a significance test on the slope. */
export function linreg(x: number[], y: number[]): Fit | null {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const mx = mean(x.slice(0, n))!, my = mean(y.slice(0, n))!;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;

  let ssr = 0, sst = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * x[i];
    ssr += (y[i] - pred) ** 2;
    sst += (y[i] - my) ** 2;
  }
  const df = n - 2;
  const se = Math.sqrt(ssr / df / sxx);
  const t = se === 0 ? 0 : slope / se;
  return { slope, intercept, r2: sst === 0 ? 0 : 1 - ssr / sst, se, t, p: tTestP(Math.abs(t), df), n };
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf). */
export function normCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export function erf(x: number): number {
  const s = Math.sign(x);
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return s * y;
}

/** Two-tailed p-value for Student's t. Normal approximation past df=30, which is
 *  accurate to <1% there and keeps this dependency-free. */
export function tTestP(t: number, df: number): number {
  if (df <= 0) return 1;
  if (df > 30) return 2 * (1 - normCdf(t));
  // Cornish-Fisher style adjustment for small samples
  const z = t * (1 - 1 / (4 * df)) / Math.sqrt(1 + (t * t) / (2 * df));
  return Math.min(1, Math.max(0, 2 * (1 - normCdf(z))));
}

/** Welch's t-test — unequal variances, the right default for comparing periods. */
export function welch(a: number[], b: number[]) {
  if (a.length < 2 || b.length < 2) return null;
  const ma = mean(a)!, mb = mean(b)!;
  const va = stdev(a)! ** 2, vb = stdev(b)! ** 2;
  const na = a.length, nb = b.length;
  const sed = Math.sqrt(va / na + vb / nb);
  if (!sed) return null;
  const t = (mb - ma) / sed;
  const df = (va / na + vb / nb) ** 2 /
    ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1));
  return { t, df, p: tTestP(Math.abs(t), df), meanA: ma, meanB: mb, delta: mb - ma };
}

/** Cohen's d — how big the change is, not just whether it's significant. */
export function cohensD(a: number[], b: number[]): number | null {
  if (a.length < 2 || b.length < 2) return null;
  const sa = stdev(a)!, sb = stdev(b)!;
  const pooled = Math.sqrt(((a.length - 1) * sa ** 2 + (b.length - 1) * sb ** 2) / (a.length + b.length - 2));
  if (!pooled) return null;
  return (mean(b)! - mean(a)!) / pooled;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Deterministic PRNG so forecasts don't jitter between page loads. */
export function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

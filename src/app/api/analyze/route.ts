import { route, bad } from "@/lib/api";
import { getSeries, getSeriesMulti, getMetricDefMap, todayISO, addDays, isDerivedPair } from "@/lib/metrics";
import { analyseTrend, findChangePoints, findAnomalies, weekdayProfile, coverage, toGrid, ewma, rollingMean } from "@/lib/analytics/trend";
import { forecast } from "@/lib/analytics/forecast";
import { PLAUSIBLE_RANGES } from "@/lib/metric-meta";
import { laggedCorrelation, bestLag, behaviourSplit, driverAnalysis } from "@/lib/analytics/drivers";

export const maxDuration = 60;

/**
 * Deep dive on a single metric: smoothing, trend tests, change points,
 * anomalies, weekday effects, a forecast, and what correlates with it.
 */
export const GET = route(async (user, req) => {
  const url = new URL(req.url);
  const key = url.searchParams.get("metric");
  if (!key) throw bad("metric is required");
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 180, 14), 1825);
  const horizon = Math.min(Math.max(Number(url.searchParams.get("horizon")) || 60, 0), 365);
  const against = url.searchParams.get("against");

  const today = todayISO();
  const from = addDays(today, -days);
  const defs = await getMetricDefMap(user.id);
  const points = await getSeries(user.id, key, from, today);
  if (points.length < 3) return { key, label: defs[key]?.label ?? key, points, sparse: true };

  const { dates, values } = toGrid(points, from, today);
  const smooth7 = ewma(values, 7);
  const smooth28 = ewma(values, 28);
  const roll7 = rollingMean(values, 7, true);

  let comparison = null;
  if (against) {
    const other = await getSeries(user.id, against, from, today);
    if (other.length >= 10) {
      comparison = {
        key: against,
        label: defs[against]?.label ?? against,
        lags: laggedCorrelation(other, points, 7),
        best: bestLag(other, points, 7),
        split: behaviourSplit(other, points, 1),
        points: other,
      };
    }
  }

  // What else in the dataset moves with this metric?
  const allKeys = Object.keys(defs).filter((k) => k !== key && !isDerivedPair(k, key));
  const others = await getSeriesMulti(user.id, allKeys, from, today);
  const related = allKeys
    .filter((k) => (others[k]?.length ?? 0) >= 20)
    .map((k) => {
      const bl = bestLag(others[k], points, 3);
      return bl ? { key: k, label: defs[k]?.label ?? k, lag: bl.lag, r: bl.r, p: bl.p, n: bl.n } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null && Math.abs(x.r) > 0.2 && x.p < 0.05)
    .sort((a, b) => Math.abs(b.r) - Math.abs(a.r))
    .slice(0, 8);

  return {
    key,
    label: defs[key]?.label ?? key,
    unit: defs[key]?.unit ?? null,
    higherBetter: defs[key]?.higher_is_better ?? null,
    points,
    grid: { dates, values, smooth7, smooth28, roll7 },
    trend: analyseTrend(points),
    trend28: analyseTrend(points.filter((p) => p.date > addDays(today, -28))),
    changePoints: findChangePoints(points),
    anomalies: findAnomalies(points).slice(-12),
    weekday: weekdayProfile(points),
    coverage: coverage(points, from, today),
    forecast: horizon > 0 ? forecast(points, horizon, 800, PLAUSIBLE_RANGES[key]) : null,
    comparison,
    related,
  };
});

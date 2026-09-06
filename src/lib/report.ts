import { sql } from "./db";
import { getSeriesMulti, getMetricDefMap, todayISO, addDays, daysBetween, isDerivedPair, type Point } from "./metrics";
import { analyseTarget, buildGoalReport, type Goal, type GoalTarget, type GoalReport } from "./analytics/goal";
import { analyseTrend, findChangePoints, findAnomalies } from "./analytics/trend";
import { driverAnalysis, type Driver } from "./analytics/drivers";
import { recompScore, bodyComposition, monotonyStrain } from "./analytics/load";
import { mean } from "./analytics/stats";

export type Snapshot = {
  key: string; label: string; unit: string | null; category: string;
  latest: number | null; latestDate: string | null;
  avg7: number | null; avg28: number | null; deltaPct: number | null;
  higherBetter: boolean | null;
  spark: Point[];
  trendDirection: "rising" | "falling" | "flat" | null;
};

export type FullReport = {
  today: string;
  goal: GoalReport | null;
  otherGoals: { id: number; title: string; status: string }[];
  snapshots: Snapshot[];
  readiness: { value: number | null; date: string | null; series: Point[]; parts: Record<string, number> | null };
  recomp: ReturnType<typeof recompScore>;
  load: {
    ctl: number | null; atl: number | null; tsb: number | null; acwr: number | null;
    strain: number | null; monotony: number | null;
    /** False while the chronic base is still building — risk thresholds must
     *  not be applied to the numbers above until this is true. */
    established: boolean;
    warmupDaysRemaining: number | null;
  };
  drivers: { target: string; targetLabel: string; r2: number; adjR2: number; n: number; items: Driver[] } | null;
  changePoints: { metric: string; label: string; date: string; before: number; after: number; delta: number; effectSize: number }[];
  anomalies: { metric: string; label: string; date: string; value: number; z: number; direction: string }[];
  dataHealth: { key: string; label: string; coverage: number; lastSeen: string | null; source: string | null }[];
  streaks: { label: string; days: number }[];
};

const KEY_SNAPSHOT_METRICS = [
  "weight_kg", "body_fat_pct", "lean_mass_kg", "resting_hr", "hrv_ms", "sleep_hours",
  "readiness", "steps", "active_zone_min", "ctl", "tsb", "deep_work_hours", "focus_score", "vo2max",
];

/**
 * Candidate inputs for the driver model.
 *
 * Deliberately excludes `readiness`: it is computed *from* HRV, resting HR and
 * sleep, which are all candidates here. Feeding a composite in alongside its own
 * components makes the regression split one effect across four collinear terms
 * and hands back coefficients whose signs contradict the raw correlations.
 */
const DRIVER_CANDIDATES = [
  "sleep_hours", "sleep_efficiency", "deep_sleep_min", "rem_sleep_min", "sleep_start_hour",
  "hrv_ms", "resting_hr", "steps", "active_zone_min", "training_load", "workout_min",
  "calories_in", "protein_g", "alcohol_units", "water_l", "tsb",
  "meditation_min", "screen_time_h", "stress", "energy",
];

export async function getGoals(userId: number) {
  return sql<(Goal & { archived_at: Date | null })[]>`
    SELECT id, title, kind, description, start_date::text, target_date::text, status, archived_at
    FROM goals WHERE user_id = ${userId}
    ORDER BY (status = 'active') DESC, start_date DESC`;
}

export async function getGoalTargets(goalId: number) {
  return sql<GoalTarget[]>`
    SELECT id, metric_key, direction, baseline, target_value, weight, notes
    FROM goal_targets WHERE goal_id = ${goalId} ORDER BY id`;
}

export async function buildFullReport(userId: number, goalId?: number): Promise<FullReport> {
  const today = todayISO();
  const defs = await getMetricDefMap(userId);
  const goals = await getGoals(userId);
  const active = goalId ? goals.find((g) => g.id === goalId) : goals.find((g) => g.status === "active");

  // ---- goal report ----
  let goalReport: GoalReport | null = null;
  let targetKeys: string[] = [];
  if (active) {
    const targets = await getGoalTargets(active.id);
    targetKeys = targets.map((t) => t.metric_key);
    const series = await getSeriesMulti(userId, targetKeys);
    const progress = targets.map((t) =>
      analyseTarget(t, series[t.metric_key] ?? [], {
        label: defs[t.metric_key]?.label ?? t.metric_key,
        unit: defs[t.metric_key]?.unit ?? null,
        precision: defs[t.metric_key]?.precision ?? 1,
      }, active, today)
    );
    goalReport = buildGoalReport(active, progress, today);
  }

  // ---- snapshots ----
  const snapKeys = [...new Set([...KEY_SNAPSHOT_METRICS, ...targetKeys])];
  const snapSeries = await getSeriesMulti(userId, snapKeys, addDays(today, -180));
  const snapshots: Snapshot[] = [];
  for (const key of snapKeys) {
    const pts = snapSeries[key] ?? [];
    if (!pts.length) continue;
    const def = defs[key];
    const last7 = pts.filter((p) => p.date > addDays(today, -7)).map((p) => p.value);
    const prev7 = pts.filter((p) => p.date > addDays(today, -14) && p.date <= addDays(today, -7)).map((p) => p.value);
    const last28 = pts.filter((p) => p.date > addDays(today, -28)).map((p) => p.value);
    const a7 = mean(last7), p7 = mean(prev7);
    const trend = analyseTrend(pts.slice(-60));
    snapshots.push({
      key,
      label: def?.label ?? key,
      unit: def?.unit ?? null,
      category: def?.category ?? "custom",
      latest: pts[pts.length - 1].value,
      latestDate: pts[pts.length - 1].date,
      avg7: a7, avg28: mean(last28),
      deltaPct: a7 !== null && p7 !== null && p7 !== 0 ? ((a7 - p7) / Math.abs(p7)) * 100 : null,
      higherBetter: def?.higher_is_better ?? null,
      spark: pts.slice(-90),
      trendDirection: trend?.direction ?? null,
    });
  }

  // ---- readiness, body comp, load ----
  const support = await getSeriesMulti(userId, [
    "readiness", "weight_kg", "body_fat_pct", "ctl", "atl", "tsb", "acwr", "training_load",
  ], addDays(today, -365));

  const readinessPts = support.readiness ?? [];
  const { lean, fat } = bodyComposition(support.weight_kg ?? [], support.body_fat_pct ?? []);
  const loadPts = support.training_load ?? [];
  const ms = monotonyStrain(loadPts.slice(-7).map((p) => p.value));

  const lastOf = (pts: Point[]) => (pts.length ? pts[pts.length - 1].value : null);

  // How long the training model has had to build a chronic base.
  const ctlPts = support.ctl ?? [];
  const loadDays = ctlPts.length ? daysBetween(ctlPts[0].date, today) + 1 : 0;

  // ---- drivers ----
  let drivers: FullReport["drivers"] = null;
  const driverTargetKey =
    goalReport?.targets.find((t) => t.observations >= 20)?.metricKey ??
    (readinessPts.length >= 25 ? "readiness" : null);

  if (driverTargetKey) {
    const cands = DRIVER_CANDIDATES.filter((k) => k !== driverTargetKey && !isDerivedPair(k, driverTargetKey));
    const all = await getSeriesMulti(userId, [driverTargetKey, ...cands], addDays(today, -365));
    const targetPts = all[driverTargetKey] ?? [];
    if (targetPts.length >= 20) {
      const res = driverAnalysis(
        targetPts,
        cands
          .filter((k) => (all[k]?.length ?? 0) >= 20)
          .map((k) => ({ key: k, label: defs[k]?.label ?? k, points: all[k] })),
        { maxLag: 3, higherBetter: defs[driverTargetKey]?.higher_is_better ?? null }
      );
      if (res.drivers.length) {
        drivers = {
          target: driverTargetKey,
          targetLabel: defs[driverTargetKey]?.label ?? driverTargetKey,
          r2: res.r2, adjR2: res.adjR2, n: res.n,
          items: res.drivers.slice(0, 6),
        };
      }
    }
  }

  // ---- change points & anomalies across the metrics that matter ----
  const watchKeys = [...new Set([...targetKeys, "weight_kg", "resting_hr", "hrv_ms", "sleep_hours", "readiness"])];
  const watchSeries = await getSeriesMulti(userId, watchKeys, addDays(today, -365));
  const changePoints: FullReport["changePoints"] = [];
  const anomalies: FullReport["anomalies"] = [];

  for (const key of watchKeys) {
    const pts = watchSeries[key] ?? [];
    if (pts.length < 25) continue;
    for (const cp of findChangePoints(pts, { maxPoints: 2 })) {
      changePoints.push({ metric: key, label: defs[key]?.label ?? key, date: cp.date, before: cp.before, after: cp.after, delta: cp.delta, effectSize: cp.effectSize });
    }
    for (const a of findAnomalies(pts).filter((a) => a.date > addDays(today, -21))) {
      anomalies.push({ metric: key, label: defs[key]?.label ?? key, date: a.date, value: a.value, z: a.z, direction: a.direction });
    }
  }
  changePoints.sort((a, b) => b.date.localeCompare(a.date));
  anomalies.sort((a, b) => b.date.localeCompare(a.date));

  // ---- data health ----
  const health = await sql<{ metric_key: string; last_seen: string; source: string; n: number }[]>`
    SELECT metric_key, MAX(date)::text AS last_seen,
           (ARRAY_AGG(source ORDER BY date DESC))[1] AS source,
           COUNT(*)::int AS n
    FROM metrics WHERE user_id = ${userId} AND date > ${addDays(today, -90)}
    GROUP BY metric_key ORDER BY n DESC LIMIT 40`;

  const dataHealth = health.map((h) => ({
    key: h.metric_key,
    label: defs[h.metric_key]?.label ?? h.metric_key,
    coverage: Math.min(1, h.n / 90),
    lastSeen: h.last_seen,
    source: h.source,
  }));

  return {
    today,
    goal: goalReport,
    otherGoals: goals.filter((g) => g.id !== active?.id).map((g) => ({ id: g.id, title: g.title, status: g.status })),
    snapshots,
    readiness: {
      value: lastOf(readinessPts),
      date: readinessPts.length ? readinessPts[readinessPts.length - 1].date : null,
      series: readinessPts.slice(-90),
      parts: null,
    },
    recomp: recompScore(lean, fat),
    load: {
      ctl: lastOf(support.ctl ?? []), atl: lastOf(support.atl ?? []),
      tsb: lastOf(support.tsb ?? []), acwr: lastOf(support.acwr ?? []),
      strain: ms?.strain ?? null, monotony: ms?.monotony ?? null,
      established: loadDays >= 42,
      warmupDaysRemaining: loadDays >= 42 ? null : 42 - loadDays,
    },
    drivers,
    changePoints: changePoints.slice(0, 6),
    anomalies: anomalies.slice(0, 6),
    dataHealth,
    streaks: [],
  };
}

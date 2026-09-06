import { mean, clamp } from "./stats";
import { analyseTrend, toGrid, ewma, coverage, type TrendResult } from "./trend";
import { PLAUSIBLE_RANGES } from "../metric-meta";
import { projectToTarget, type Projection } from "./forecast";
import type { Point } from "../metric-meta";
import { addDays, daysBetween, todayISO } from "../metric-meta";

export type GoalTarget = {
  id: number;
  metric_key: string;
  direction: "increase" | "decrease" | "maintain";
  baseline: number | null;
  target_value: number | null;
  weight: number;
  notes: string | null;
};

export type Goal = {
  id: number;
  title: string;
  kind: string;
  description: string | null;
  start_date: string;
  target_date: string | null;
  status: string;
};

export type TargetProgress = {
  metricKey: string;
  label: string;
  unit: string | null;
  /** Decimal places this metric is meaningfully measured to. */
  precision: number;
  direction: string;
  baseline: number | null;
  current: number | null;
  smoothed: number | null;
  target: number | null;
  weight: number;

  progress: number | null;        // 0..1+ of the distance from baseline to target
  expected: number | null;        // where you'd be on a linear pace
  pace: number | null;            // progress / expected
  status: "ahead" | "on_track" | "behind" | "at_risk" | "achieved" | "no_data";

  trend: TrendResult | null;
  projection: Projection | null;
  coverage: number;
  confidence: "high" | "medium" | "low";
  observations: number;
};

export type GoalReport = {
  goal: Goal;
  index: number | null;           // Goal Progress Index, 0-100
  expectedIndex: number | null;
  paceRatio: number | null;
  status: "ahead" | "on_track" | "behind" | "at_risk" | "no_data";
  elapsedFraction: number | null;
  daysRemaining: number | null;
  targets: TargetProgress[];
  headline: string;
};

/**
 * Establish where you started. An explicit baseline wins; otherwise take the
 * median of the first two weeks after the goal began, which is far steadier
 * than picking whatever single number happened to land on day one.
 */
export function deriveBaseline(points: Point[], startDate: string, explicit: number | null): number | null {
  if (explicit !== null && explicit !== undefined) return explicit;
  const window = points.filter((p) => p.date >= startDate && p.date <= addDays(startDate, 14));
  const pool = window.length >= 3 ? window : points.filter((p) => p.date >= addDays(startDate, -14) && p.date <= addDays(startDate, 21));
  if (!pool.length) return null;
  return mean(pool.map((p) => p.value));
}

/** Current value as the EWMA-smoothed level, not the last raw reading. Daily
 *  weight swings 1kg on water alone; the smoothed level is the real position. */
export function smoothedCurrent(points: Point[], halfLife = 7): number | null {
  if (!points.length) return null;
  const { values } = toGrid(points);
  const sm = ewma(values, halfLife);
  for (let i = sm.length - 1; i >= 0; i--) if (sm[i] !== null) return sm[i];
  return null;
}

function progressFraction(
  baseline: number | null,
  current: number | null,
  target: number | null,
  direction: string
): number | null {
  if (baseline === null || current === null || target === null) return null;
  if (direction === "maintain") {
    // Progress = how well you're holding the line, relative to a 5% drift band
    const band = Math.abs(target) * 0.05 || 1;
    return clamp(1 - Math.abs(current - target) / band, 0, 1);
  }
  const span = target - baseline;
  if (Math.abs(span) < 1e-9) return current === target ? 1 : null;
  return (current - baseline) / span;
}

export function analyseTarget(
  t: GoalTarget,
  points: Point[],
  meta: { label: string; unit: string | null; precision: number },
  goal: Goal,
  today = todayISO()
): TargetProgress {
  const inGoal = points.filter((p) => p.date >= goal.start_date && p.date <= today);
  const baseline = deriveBaseline(points, goal.start_date, t.baseline);
  const smoothed = smoothedCurrent(inGoal.length >= 3 ? inGoal : points);
  const current = inGoal.length ? inGoal[inGoal.length - 1].value : null;
  const target = t.target_value;

  const progress = progressFraction(baseline, smoothed, target, t.direction);
  const total = goal.target_date ? daysBetween(goal.start_date, goal.target_date) : null;
  const elapsed = daysBetween(goal.start_date, today);
  const expected = total && total > 0 ? clamp(elapsed / total, 0, 1) : null;
  const pace = progress !== null && expected !== null && expected > 0.02 ? progress / expected : null;

  const cov = coverage(inGoal, goal.start_date, today);
  const trend = analyseTrend(inGoal.length >= 5 ? inGoal : points);
  const projection =
    goal.target_date && target !== null && inGoal.length >= 8
      ? projectToTarget(inGoal, target, t.direction as any, goal.target_date, today, 0,
          PLAUSIBLE_RANGES[t.metric_key])
      : null;

  let status: TargetProgress["status"] = "no_data";
  if (progress === null) status = "no_data";
  else if (progress >= 1) status = "achieved";
  else if (pace === null) status = progress > 0 ? "on_track" : "behind";
  else if (pace >= 1.1) status = "ahead";
  else if (pace >= 0.85) status = "on_track";
  else if (pace >= 0.5) status = "behind";
  else status = "at_risk";

  // A confident read needs both enough days and enough of them covered.
  const confidence: TargetProgress["confidence"] =
    inGoal.length >= 21 && cov.ratio >= 0.6 ? "high"
    : inGoal.length >= 8 && cov.ratio >= 0.3 ? "medium"
    : "low";

  return {
    metricKey: t.metric_key,
    label: meta.label,
    unit: meta.unit,
    precision: meta.precision,
    direction: t.direction,
    baseline, current, smoothed, target,
    weight: t.weight ?? 1,
    progress, expected, pace, status,
    trend, projection,
    coverage: cov.ratio,
    confidence,
    observations: inGoal.length,
  };
}

/**
 * Goal Progress Index: a single 0-100 number for "how am I doing".
 *
 * Weighted mean of per-target progress, clamped so one runaway metric can't
 * paper over three stalled ones. Read it next to `expectedIndex` — being at 40%
 * is good at the halfway mark and bad at the three-quarter mark.
 */
export function buildGoalReport(
  goal: Goal,
  targets: TargetProgress[],
  today = todayISO()
): GoalReport {
  const usable = targets.filter((t) => t.progress !== null);
  const wsum = usable.reduce((a, t) => a + t.weight, 0);
  const index = wsum > 0
    ? (usable.reduce((a, t) => a + clamp(t.progress!, 0, 1) * t.weight, 0) / wsum) * 100
    : null;

  const total = goal.target_date ? daysBetween(goal.start_date, goal.target_date) : null;
  const elapsed = daysBetween(goal.start_date, today);
  const elapsedFraction = total && total > 0 ? clamp(elapsed / total, 0, 1) : null;
  const expectedIndex = elapsedFraction !== null ? elapsedFraction * 100 : null;
  const paceRatio = index !== null && expectedIndex && expectedIndex > 2 ? index / expectedIndex : null;

  let status: GoalReport["status"] = "no_data";
  if (index === null) status = "no_data";
  else if (paceRatio === null) status = "on_track";
  else if (paceRatio >= 1.1) status = "ahead";
  else if (paceRatio >= 0.85) status = "on_track";
  else if (paceRatio >= 0.5) status = "behind";
  else status = "at_risk";

  const daysRemaining = goal.target_date ? daysBetween(today, goal.target_date) : null;

  return {
    goal, index, expectedIndex, paceRatio, status,
    elapsedFraction, daysRemaining, targets,
    headline: headlineFor(status, index, expectedIndex, daysRemaining, targets),
  };
}

function headlineFor(
  status: GoalReport["status"],
  index: number | null,
  expected: number | null,
  daysRemaining: number | null,
  targets: TargetProgress[]
): string {
  if (index === null) return "Not enough data yet — connect a source or log a few days.";
  const pct = Math.round(index);
  const exp = expected !== null ? Math.round(expected) : null;
  const behind = targets.filter((t) => t.status === "behind" || t.status === "at_risk");
  const lagging = behind.length ? ` ${behind.map((t) => t.label).slice(0, 2).join(" and ")} ${behind.length === 1 ? "is" : "are"} holding you back.` : "";
  const timeLeft = daysRemaining !== null && daysRemaining > 0 ? ` ${daysRemaining} days left.` : "";

  switch (status) {
    case "ahead":    return `${pct}% there${exp !== null ? ` against ${exp}% expected` : ""} — you're ahead of pace.${timeLeft}`;
    case "on_track": return `${pct}% there${exp !== null ? ` against ${exp}% expected` : ""} — on track.${timeLeft}${lagging}`;
    case "behind":   return `${pct}% there but ${exp}% of the time is gone — you're behind pace.${lagging}${timeLeft}`;
    case "at_risk":  return `${pct}% there with ${exp}% of the time gone — this goal is at risk.${lagging}${timeLeft}`;
    default:         return `${pct}% there.${timeLeft}`;
  }
}

export const STATUS_TONE: Record<string, "good" | "warning" | "serious" | "critical" | "neutral"> = {
  ahead: "good",
  achieved: "good",
  on_track: "good",
  behind: "warning",
  at_risk: "critical",
  no_data: "neutral",
};

export const STATUS_LABEL: Record<string, string> = {
  ahead: "Ahead of pace",
  achieved: "Achieved",
  on_track: "On track",
  behind: "Behind pace",
  at_risk: "At risk",
  no_data: "No data",
};

/**
 * Analysis tools the model can call.
 *
 * A briefing built from one fixed snapshot can only comment on what the snapshot
 * happened to include. Given tools, the model investigates instead: it sees a
 * stalled metric, asks what correlates with it, checks the coverage, and looks
 * for a change point — the sequence an analyst would actually follow.
 *
 * Every tool returns computed statistics, never long lists of raw numbers. The
 * model is good at deciding what to look at and what it means, and bad at doing
 * arithmetic over a thousand values; this split plays to that.
 */
import { sql } from "./db";
import {
  getSeries, getSeriesMulti, getMetricDefMap, todayISO, addDays, isDerivedPair, type Point,
} from "./metrics";
import { analyseTrend, findChangePoints, findAnomalies, coverage, weekdayProfile, toGrid, ewma } from "./analytics/trend";
import { forecast, projectToTarget } from "./analytics/forecast";
import { laggedCorrelation, bestLag, behaviourSplit, driverAnalysis } from "./analytics/drivers";
import { mean, median, stdev, quantile } from "./analytics/stats";
import { SEMANTICS, semanticsFor } from "./semantics";
import { PLAUSIBLE_RANGES } from "./metric-meta";
import { chat, type ChatMessage, type ToolCall } from "./openrouter";

export type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

const n2 = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d));

/* ── tool schemas ────────────────────────────────────────────────────────── */

export const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "list_metrics",
      description:
        "List every metric with data: how many readings, the date span, coverage, and the latest 7-day average. " +
        "Call this first to see what is actually available before reasoning about anything.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "describe_metric",
      description:
        "Everything known about one metric: what it means, how it is measured, how to read it, its caveats, " +
        "what it is derived from, plus current statistics (recent averages, distribution, trend, coverage).",
      parameters: {
        type: "object",
        properties: { metric: { type: "string", description: "Metric key, e.g. hrv_ms" } },
        required: ["metric"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyse_metric",
      description:
        "Full statistical analysis of one metric: Mann-Kendall trend with significance, Theil-Sen slope, " +
        "change points (level shifts), outlier days, weekday effects and coverage.",
      parameters: {
        type: "object",
        properties: {
          metric: { type: "string" },
          days: { type: "integer", description: "Lookback window, default 180" },
        },
        required: ["metric"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_metrics",
      description:
        "Test whether two metrics move together. Returns rank correlation at each lag (lag 1 = yesterday's " +
        "value against today's outcome), the strongest lag, and a plain split of the target on days when the " +
        "other metric was above vs below its median. Association only, never proof of cause.",
      parameters: {
        type: "object",
        properties: {
          metric: { type: "string", description: "The outcome you care about" },
          against: { type: "string", description: "The possible influence" },
          days: { type: "integer", description: "Lookback window, default 180" },
        },
        required: ["metric", "against"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_drivers",
      description:
        "Ridge regression finding which of the person's other metrics best explain one target metric, each at " +
        "its most predictive lag. Returns standardised coefficients and adjusted R². Use when you want the " +
        "whole picture rather than one pairwise comparison.",
      parameters: {
        type: "object",
        properties: {
          metric: { type: "string" },
          days: { type: "integer", description: "Lookback window, default 365" },
        },
        required: ["metric"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forecast_metric",
      description:
        "Project a metric forward with a damped-trend model simulated 800 times. Optionally give a target and " +
        "deadline to get the probability of reaching it, the required rate, and the current rate.",
      parameters: {
        type: "object",
        properties: {
          metric: { type: "string" },
          horizonDays: { type: "integer", description: "How far ahead, default 60" },
          target: { type: "number", description: "Optional target value" },
          direction: { type: "string", enum: ["increase", "decrease", "maintain"] },
        },
        required: ["metric"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_series",
      description:
        "Actual values for a metric, downsampled to at most ~40 points (weekly or monthly buckets as needed). " +
        "Use only when the shape of the curve matters and the summary statistics are not enough.",
      parameters: {
        type: "object",
        properties: {
          metric: { type: "string" },
          days: { type: "integer", description: "Lookback window, default 180" },
        },
        required: ["metric"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_workouts",
      description: "Recent training sessions: date, type, duration, distance, average heart rate and computed load.",
      parameters: {
        type: "object",
        properties: { days: { type: "integer", description: "Lookback window, default 60" } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_strength",
      description:
        "Per-exercise strength progression: sessions, best estimated 1RM, most recent working weight and the " +
        "change over the window. Empty when no set-level strength log has been imported.",
      parameters: {
        type: "object",
        properties: { days: { type: "integer", description: "Lookback window, default 180" } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_notes",
      description:
        "The person's own journal entries — context the numbers cannot supply, such as illness, travel, " +
        "a deload or a launch week.",
      parameters: {
        type: "object",
        properties: { days: { type: "integer", description: "Lookback window, default 60" } },
        required: [],
      },
    },
  },
];

/* ── tool execution ──────────────────────────────────────────────────────── */

export async function runTool(userId: number, name: string, args: Record<string, any>): Promise<unknown> {
  const today = todayISO();
  const defs = await getMetricDefMap(userId);
  const label = (k: string) => defs[k]?.label ?? k;

  switch (name) {
    case "list_metrics": {
      const rows = await sql<{ metric_key: string; n: number; first: string; last: string }[]>`
        SELECT metric_key, COUNT(*)::int AS n, MIN(date)::text AS first, MAX(date)::text AS last
        FROM metrics WHERE user_id = ${userId} GROUP BY metric_key ORDER BY COUNT(*) DESC`;
      const recent = await getSeriesMulti(userId, rows.map((r) => r.metric_key), addDays(today, -8));
      return {
        today,
        metrics: rows.map((r) => {
          const last7 = (recent[r.metric_key] ?? []).filter((p) => p.date < today).map((p) => p.value);
          const span = Math.max(1, (Date.parse(r.last) - Date.parse(r.first)) / 86_400_000 + 1);
          return {
            key: r.metric_key, label: label(r.metric_key), unit: defs[r.metric_key]?.unit ?? null,
            category: defs[r.metric_key]?.category, readings: r.n,
            from: r.first, to: r.last,
            coverage: n2(r.n / span, 2),
            avg7: n2(mean(last7) ?? null, 2),
            stale: r.last < addDays(today, -10),
          };
        }),
      };
    }

    case "describe_metric": {
      const key = String(args.metric);
      const pts = await getSeries(userId, key);
      const s = semanticsFor(key);
      if (!pts.length) return { metric: key, semantics: s, error: "No data recorded for this metric." };
      const vals = pts.map((p) => p.value);
      const w = (d: number) => pts.filter((p) => p.date > addDays(today, -d) && p.date < today).map((p) => p.value);
      return {
        metric: key, label: label(key), unit: defs[key]?.unit ?? null,
        higherIsBetter: defs[key]?.higher_is_better ?? null,
        semantics: s,
        readings: pts.length, from: pts[0].date, to: pts[pts.length - 1].date,
        stale: pts[pts.length - 1].date < addDays(today, -10),
        avg7: n2(mean(w(7)) ?? null), avg28: n2(mean(w(28)) ?? null), avg90: n2(mean(w(90)) ?? null),
        median: n2(median(vals)), sd: n2(stdev(vals)),
        p10: n2(quantile(vals, 0.1)), p90: n2(quantile(vals, 0.9)),
        min: n2(Math.min(...vals)), max: n2(Math.max(...vals)),
        latest: n2(vals[vals.length - 1]), latestDate: pts[pts.length - 1].date,
      };
    }

    case "analyse_metric": {
      const key = String(args.metric);
      const days = Math.min(Math.max(Number(args.days) || 180, 14), 1095);
      const pts = await getSeries(userId, key, addDays(today, -days), today);
      if (pts.length < 5) return { metric: key, error: `Only ${pts.length} readings in that window — too few to analyse.` };
      const t = analyseTrend(pts);
      const cov = coverage(pts, addDays(today, -days), today);
      return {
        metric: key, label: label(key), unit: defs[key]?.unit ?? null, windowDays: days,
        readings: pts.length,
        coverage: { ratio: n2(cov.ratio), observed: cov.observed, days: cov.days,
          note: cov.ratio < 0.5 ? "Under half the days have readings — treat conclusions as weak." : null },
        trend: t && {
          direction: t.direction,
          perWeek: n2(t.senSlopePerDay * 7, 3),
          significant: t.significant,
          pValue: n2(t.mkP, 4),
          r2: n2(t.r2),
          changePct: n2(t.changePct, 1),
          interpretation: t.significant
            ? `Genuinely ${t.direction} at ${n2(Math.abs(t.senSlopePerDay * 7), 3)}${defs[key]?.unit ?? ""}/week.`
            : "No statistically reliable trend — treat any apparent movement as noise.",
        },
        changePoints: findChangePoints(pts).map((c) => ({
          date: c.date, before: n2(c.before), after: n2(c.after),
          shift: n2(c.delta), effectSizeSD: n2(c.effectSize),
        })),
        outliers: findAnomalies(pts).slice(-6).map((a) => ({ date: a.date, value: n2(a.value), robustSDs: n2(a.z, 1), direction: a.direction })),
        weekday: weekdayProfile(pts).filter((w) => w.delta !== null).map((w) => ({
          day: w.day, vsAverage: n2(w.delta), significant: w.significant, n: w.n,
        })),
      };
    }

    case "compare_metrics": {
      const a = String(args.metric), b = String(args.against);
      const days = Math.min(Math.max(Number(args.days) || 180, 21), 1095);
      if (isDerivedPair(a, b)) {
        return { error: `${label(a)} and ${label(b)} are related by construction — one is computed from the other, so any correlation is arithmetic, not a finding.` };
      }
      const [pa, pb] = await Promise.all([
        getSeries(userId, a, addDays(today, -days), today),
        getSeries(userId, b, addDays(today, -days), today),
      ]);
      if (pa.length < 10 || pb.length < 10) return { error: `Not enough overlapping data (${pa.length} and ${pb.length} readings).` };
      const lags = laggedCorrelation(pb, pa, 7);
      const best = bestLag(pb, pa, 7);
      const split = behaviourSplit(pb, pa, best?.lag ?? 1);
      return {
        outcome: label(a), influence: label(b), windowDays: days,
        lags: lags.map((l) => ({ lagDays: l.lag, r: n2(l.r), p: n2(l.p, 4), n: l.n, significant: l.p < 0.05 })),
        strongest: best && { lagDays: best.lag, r: n2(best.r), p: n2(best.p, 4), n: best.n, significant: best.p < 0.05 },
        split: split && {
          threshold: n2(split.threshold), lagDays: split.lag,
          whenHigh: n2(split.highMean), whenLow: n2(split.lowMean),
          difference: n2(split.delta), differencePct: n2(split.deltaPct, 1),
          nHigh: split.nHigh, nLow: split.nLow,
        },
        caution: "Association only. Both may follow a third cause, and a lag rules out reverse timing but not confounding.",
      };
    }

    case "find_drivers": {
      const key = String(args.metric);
      const days = Math.min(Math.max(Number(args.days) || 365, 30), 1095);
      const all = Object.keys(defs).filter((k) => k !== key && !isDerivedPair(k, key));
      const series = await getSeriesMulti(userId, [key, ...all], addDays(today, -days), today);
      const target = series[key] ?? [];
      if (target.length < 20) return { error: `Only ${target.length} readings for ${label(key)} — need at least 20.` };
      const res = driverAnalysis(
        target,
        all.filter((k) => (series[k]?.length ?? 0) >= 20).map((k) => ({ key: k, label: label(k), points: series[k] })),
        { maxLag: 3, higherBetter: defs[key]?.higher_is_better ?? null }
      );
      return {
        target: label(key), days: res.n, adjustedR2: n2(res.adjR2),
        note: res.adjR2 < 0.2 ? "Weak model — these inputs explain little of the movement." : null,
        drivers: res.drivers.map((d) => ({
          metric: d.label, lagDays: d.lag, coefficient: n2(d.coefficient, 3),
          correlation: n2(d.correlation), movesItUp: d.direction === "raises",
          favourable: d.favourable, shareOfExplained: n2(d.contribution),
        })),
        caution: "Standardised associations, not causes. Collinear inputs share credit.",
      };
    }

    case "forecast_metric": {
      const key = String(args.metric);
      const horizon = Math.min(Math.max(Number(args.horizonDays) || 60, 7), 365);
      const pts = await getSeries(userId, key);
      if (pts.length < 8) return { error: `Only ${pts.length} readings — need at least 8 to forecast.` };
      const bounds = PLAUSIBLE_RANGES[key];
      const f = forecast(pts, horizon, 800, bounds);
      const out: Record<string, unknown> = {
        metric: label(key), unit: defs[key]?.unit ?? null, horizonDays: horizon,
        current: n2(pts[pts.length - 1].value),
        projected: f && n2(f.bands[f.bands.length - 1].p50),
        band80: f && [n2(f.bands[f.bands.length - 1].p10), n2(f.bands[f.bands.length - 1].p90)],
        note: "Assumes current behaviour continues; the band widens with the horizon.",
      };
      if (typeof args.target === "number") {
        const p = projectToTarget(pts, args.target, (args.direction ?? "increase") as any,
          addDays(today, horizon), today, 0, bounds);
        if (p) out.target = {
          value: args.target, probability: n2(p.probability),
          requiredPerWeek: n2(p.requiredRatePerWeek, 3),
          currentPerWeek: n2(p.currentRatePerWeek, 3),
          etaIfPaceHolds: p.etaDate,
        };
      }
      return out;
    }

    case "get_series": {
      const key = String(args.metric);
      const days = Math.min(Math.max(Number(args.days) || 180, 14), 1095);
      const pts = await getSeries(userId, key, addDays(today, -days), today);
      if (!pts.length) return { error: "No data in that window." };
      // Bucket down to ~40 points: the shape survives, the token cost doesn't.
      const bucketDays = Math.max(1, Math.ceil(days / 40));
      const buckets = new Map<string, number[]>();
      for (const p of pts) {
        const i = Math.floor((Date.parse(p.date) - Date.parse(pts[0].date)) / 86_400_000 / bucketDays);
        const k = addDays(pts[0].date, i * bucketDays);
        (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(p.value);
      }
      return {
        metric: label(key), unit: defs[key]?.unit ?? null,
        bucketDays, bucket: bucketDays === 1 ? "daily" : `${bucketDays}-day average`,
        points: [...buckets.entries()].map(([date, v]) => ({ date, value: n2(mean(v) ?? null) })),
      };
    }

    case "get_workouts": {
      const days = Math.min(Math.max(Number(args.days) || 60, 7), 730);
      const rows = await sql<any[]>`
        SELECT date::text, type, name, duration_min, distance_km, avg_hr, calories
        FROM workouts WHERE user_id = ${userId} AND date > ${addDays(today, -days)}
        ORDER BY date DESC LIMIT 60`;
      const load = await getSeries(userId, "training_load", addDays(today, -days), today);
      const byDate = new Map(load.map((p) => [p.date, p.value]));
      return {
        windowDays: days, sessions: rows.length,
        byType: Object.entries(rows.reduce((a: Record<string, number>, r) => {
          a[r.type ?? "unknown"] = (a[r.type ?? "unknown"] ?? 0) + 1; return a;
        }, {})).map(([type, count]) => ({ type, count })),
        workouts: rows.map((r) => ({
          date: r.date, type: r.type, minutes: n2(r.duration_min, 0),
          km: n2(r.distance_km), avgHr: n2(r.avg_hr, 0), load: n2(byDate.get(r.date) ?? null, 0),
        })),
      };
    }

    case "get_strength": {
      const days = Math.min(Math.max(Number(args.days) || 180, 14), 1095);
      const rows = await sql<any[]>`
        SELECT exercise,
               COUNT(DISTINCT date)::int AS sessions,
               MAX(weight_kg * (1 + reps / 30.0)) FILTER (WHERE reps BETWEEN 1 AND 12) AS best_e1rm,
               MAX(weight_kg) AS heaviest,
               SUM(weight_kg * reps) AS volume,
               MIN(date)::text AS first, MAX(date)::text AS last
        FROM strength_sets
        WHERE user_id = ${userId} AND date > ${addDays(today, -days)} AND weight_kg > 0
        GROUP BY exercise ORDER BY SUM(weight_kg * reps) DESC LIMIT 12`;
      if (!rows.length) return { note: "No set-level strength log imported, so per-exercise progression is unavailable." };
      return {
        windowDays: days,
        exercises: rows.map((r) => ({
          exercise: r.exercise, sessions: r.sessions,
          bestEstimated1RM: n2(r.best_e1rm, 1), heaviestSet: n2(r.heaviest, 1),
          totalVolumeKg: n2(r.volume, 0), from: r.first, to: r.last,
        })),
        note: "Estimated 1RM uses Epley on sets of 1-12 reps.",
      };
    }

    case "get_notes": {
      const days = Math.min(Math.max(Number(args.days) || 60, 7), 365);
      const rows = await sql<{ date: string; body: string; kind: string }[]>`
        SELECT date::text, body, kind FROM entries
        WHERE user_id = ${userId} AND date > ${addDays(today, -days)} AND body IS NOT NULL
        ORDER BY date DESC LIMIT 25`;
      return { windowDays: days, notes: rows.map((r) => ({ date: r.date, note: r.body.slice(0, 400) })) };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/* ── the loop ────────────────────────────────────────────────────────────── */

export type AgentTrace = { tool: string; args: Record<string, unknown>; ms: number };
export type Investigation = { trace: AgentTrace[]; steps: number; messages: any[] };

/**
 * Advance a tool-using conversation by exactly ONE model turn.
 *
 * A serverless function has a hard wall-clock limit — 60s on Vercel's free
 * tier — and a full investigation needs several minutes of model time. Rather
 * than hold one request open and hope, each call here does a single turn
 * (typically 10-30s) and hands the conversation back to be persisted, so the
 * work is resumable and the user sees progress instead of a spinner.
 */
export async function runAgentStep(
  userId: number,
  messages: any[],
  opts: { maxTokens?: number; temperature?: number; effort?: "low" | "medium" | "high"; force?: boolean } = {}
): Promise<{ messages: any[]; calls: AgentTrace[]; done: boolean }> {
  const { maxTokens = 8000, temperature = 0.4, effort = "low", force = false } = opts;
  const convo = [...messages];

  const res = await chat(convo as ChatMessage[], {
    maxTokens, temperature, tools: TOOLS, effort,
    toolChoice: force ? "none" : "auto",
  });

  if (!res.toolCalls?.length) {
    if (res.content?.trim()) convo.push({ role: "assistant", content: res.content });
    return { messages: convo, calls: [], done: true };
  }

  convo.push({ role: "assistant", content: res.content ?? "", tool_calls: res.toolCalls });
  const calls: AgentTrace[] = [];

  // Tool calls in one turn are independent, so run them together rather than
  // paying their latency serially.
  const results = await Promise.all(res.toolCalls.map(async (call: ToolCall) => {
    const started = Date.now();
    let args: Record<string, any> = {};
    try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* tolerate */ }
    let result: unknown;
    try { result = await runTool(userId, call.function.name, args); }
    catch (e) { result = { error: e instanceof Error ? e.message : "Tool failed" }; }
    calls.push({ tool: call.function.name, args, ms: Date.now() - started });
    return { call, result };
  }));

  for (const { call, result } of results) {
    convo.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result) });
  }
  return { messages: convo, calls, done: false };
}

/**
 * Run the tool-calling investigation and hand back the whole conversation.
 *
 * The write-up is deliberately NOT produced here. Letting the model draft prose
 * and then reformatting it into JSON means paying for two long generations of
 * the same content; instead the loop gathers evidence cheaply, and the caller
 * makes one structured call over the accumulated tool results.
 *
 * The trace is returned because "it checked these twelve things" is much of what
 * makes the output trustworthy.
 */
export async function runAgent(
  userId: number,
  messages: ChatMessage[],
  opts: { maxSteps?: number; maxTokens?: number; temperature?: number; deadlineMs?: number } = {}
): Promise<Investigation> {
  const { maxSteps = 12, maxTokens = 20000, temperature = 0.4, deadlineMs = 240_000 } = opts;
  const convo: any[] = [...messages];
  const trace: AgentTrace[] = [];
  const startedAt = Date.now();

  for (let step = 0; step < maxSteps; step++) {
    // Deciding which tool to call next is routing, not deliberation. Deep
    // reasoning on every hop is what makes these loops take minutes, so the
    // investigation runs at low effort and only the final write-up thinks hard.
    const elapsed = Date.now() - startedAt;
    const outOfTime = elapsed > deadlineMs;
    const lastStep = step === maxSteps - 1 || outOfTime;

    const res = await chat(convo as ChatMessage[], {
      maxTokens, temperature,
      tools: TOOLS,
      effort: lastStep ? "medium" : "low",
      // Force a final answer once the budget or the clock is nearly spent.
      toolChoice: lastStep ? "none" : "auto",
    });
    console.log(`[agent] step ${step + 1}/${maxSteps} ${Math.round(elapsed / 1000)}s elapsed` +
                (res.toolCalls?.length ? ` -> ${res.toolCalls.map((c: any) => c.function.name).join(", ")}` : " -> final answer"));

    if (!res.toolCalls?.length) {
      // The model has stopped gathering; anything it said here is a preamble to
      // the real answer, which the caller produces in structured form.
      if (res.content?.trim()) convo.push({ role: "assistant", content: res.content });
      return { trace, steps: step + 1, messages: convo };
    }

    convo.push({ role: "assistant", content: res.content ?? "", tool_calls: res.toolCalls });

    for (const call of res.toolCalls) {
      const started = Date.now();
      let args: Record<string, any> = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* tolerate malformed args */ }
      let result: unknown;
      try {
        result = await runTool(userId, call.function.name, args);
      } catch (e) {
        result = { error: e instanceof Error ? e.message : "Tool failed" };
      }
      trace.push({ tool: call.function.name, args, ms: Date.now() - started });
      console.log(`[agent]   ${call.function.name}(${JSON.stringify(args).slice(0, 70)}) ${Date.now() - started}ms`);
      convo.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result) });
    }
  }

  return { trace, steps: maxSteps, messages: convo };
}

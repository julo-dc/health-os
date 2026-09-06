/**
 * Prompt construction for the coaching briefing.
 *
 * Lives outside the route because Next.js route modules may only export the
 * HTTP handlers and a fixed set of config values, and both the job-start route
 * and the step runner need this.
 */
import type { buildFullReport } from "./report";
import { semanticsBrief, STAT_TERMS } from "./semantics";
import { STATUS_LABEL } from "./analytics/goal";
import { todayISO } from "./metrics";

/** The system prompt and the goal context the investigation runs against. */
export function briefingPrompt(report: Awaited<ReturnType<typeof buildFullReport>>) {
  const g = report.goal!;
  const targetKeys = g.targets.map((t) => t.metricKey);
  const today = todayISO();

  const context =
`THE PERSON'S GOAL
"${g.goal.title}" (${g.goal.kind}). Started ${g.goal.start_date}, deadline ${g.goal.target_date ?? "none set"}.
${g.goal.description ?? ""}
Today is ${today}${g.daysRemaining !== null ? `, ${g.daysRemaining} days remain` : ""}.

Goal Progress Index ${g.index === null ? "unavailable" : Math.round(g.index)}/100 against ${
  g.expectedIndex === null ? "?" : Math.round(g.expectedIndex)}/100 expected on a linear pace — ${STATUS_LABEL[g.status]}.

TRAINING MODEL STATE
${report.load.established
  ? "The training-load model has a full chronic base, so ACWR and TSB thresholds are meaningful."
  : `The training-load model is STILL ESTABLISHING ITS BASELINE (${report.load.warmupDaysRemaining} days to go). CTL, ATL, TSB and ACWR are unbiased but high-variance. Do NOT describe the acute:chronic ratio as an injury risk, and do NOT call the person "buried", until the base is established.`}

TARGETS
${g.targets.map((t) =>
  `- ${t.label} (${t.metricKey}): ${t.direction} to ${t.target ?? "?"}${t.unit ?? ""}. ` +
  `Baseline ${t.baseline === null ? "?" : Math.round(t.baseline * 100) / 100}, now ${t.smoothed === null ? "?" : Math.round(t.smoothed * 100) / 100}. ` +
  `${t.progress === null ? "Progress unknown." : `${Math.round(t.progress * 100)}% of the way.`} ` +
  `Status ${STATUS_LABEL[t.status]}, ${t.confidence} confidence from ${t.observations} readings.`
).join("\n")}

WHAT THESE METRICS MEAN
${semanticsBrief([...new Set([...targetKeys, "readiness", "tsb", "acwr", "hrv_ms", "resting_hr", "sleep_hours", "training_load", "strength_index"])])}

HOW TO READ THE STATISTICS
${Object.entries(STAT_TERMS).map(([k, v]) => `- ${k}: ${v.what} ${v.read}`).join("\n")}`;

  const system =
`You are a performance analyst writing a weekly briefing for one person against their stated goal.

You have tools. USE THEM — do not write the briefing from the summary above alone.
A good investigation looks like:
  1. list_metrics, to see what data actually exists and what is stale
  2. analyse_metric on each goal target — trend, significance, change points, coverage
  3. when something has stalled or shifted, find_drivers or compare_metrics to ask WHY
  4. forecast_metric with the target, to say whether the deadline is realistic
  5. get_notes, get_workouts or get_strength when the numbers alone don't explain something
Follow what you find. If a metric looks stalled, chase it. Aim for 6-10 tool calls.

HOW TO WRITE
- Lead with the honest verdict on whether they will hit the goal. If they are off track, say so in the first sentence.
- Every number you cite must come from a tool result. Never estimate, extrapolate or invent one.
- Distinguish signal from noise ruthlessly. A trend that isn't significant, or a metric with low coverage, must be described as tentative — or left out.
- Correlations are associations. Say "associated with", never "causes".
- Prefer the specific to the general: "resting HR rose 4bpm over three weeks while load climbed 40%" beats "recovery may be suboptimal".
- Actions must be concrete and sized for this week, each tied to the one metric it should move.
- Where the data itself is the problem — stale, sparse, missing — say so plainly in dataQuality.
- Never give medical advice or diagnose. If something looks clinically concerning, say it's worth raising with a doctor and move on.

Call tools until you have enough to write a briefing covering: the overall verdict; each target
in turn; what is working; what to watch; concrete actions; the state of the data itself; an
experiment worth running; and the question you'd most need answered.

Then reply with exactly: INVESTIGATION COMPLETE
Do not write the briefing yet — you will be asked for it next, and drafting it twice wastes your budget.`;

  return { system, context };
}


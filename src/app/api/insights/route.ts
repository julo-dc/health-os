import { route, bad } from "@/lib/api";
import { sql } from "@/lib/db";
import { chatJson, llmEnabled, textModel } from "@/lib/openrouter";
import { runAgent, type AgentTrace } from "@/lib/agent";
import { buildFullReport } from "@/lib/report";
import { semanticsBrief, STAT_TERMS } from "@/lib/semantics";
import { todayISO, addDays } from "@/lib/metrics";
import { STATUS_LABEL } from "@/lib/analytics/goal";

export const maxDuration = 300;

export type TargetRead = {
  metric: string;
  status: string;
  whatsHappening: string;
  whyItMatters: string;
  doThis: string;
};

export type Briefing = {
  verdict: string;
  onTrack: "yes" | "partly" | "no" | "unknown";
  headlineNumber: { value: string; label: string; context: string } | null;
  targets: TargetRead[];
  wins: string[];
  risks: string[];
  actions: { action: string; why: string; metric: string; effort: "low" | "medium" | "high"; expectedEffect: string }[];
  dataQuality: string[];
  experiment: { hypothesis: string; test: string; measure: string } | null;
  question: string;
  checked?: AgentTrace[];
};

export const GET = route(async (user) => {
  const [latest] = await sql<{ payload: Briefing; created_at: Date; model: string }[]>`
    SELECT payload, created_at, model FROM insights
    WHERE user_id = ${user.id} AND kind = 'briefing'
    ORDER BY created_at DESC LIMIT 1`;
  return {
    briefing: latest?.payload ?? null,
    createdAt: latest?.created_at ?? null,
    model: latest?.model ?? null,
    llmEnabled: llmEnabled(),
  };
});

/**
 * Generate a coaching briefing.
 *
 * The model investigates with real analysis tools rather than reading one fixed
 * snapshot: it can look up what a metric means, test its trend, compare it
 * against another at a lag, check coverage, and forecast it. That is the
 * sequence an analyst follows, and it lets the briefing chase the thing that is
 * actually wrong instead of commenting on whatever the snapshot happened to
 * include. It never sees long lists of raw numbers — every tool returns
 * computed statistics, so its job stays interpretation, not arithmetic.
 */
export const POST = route(async (user, req) => {
  if (!llmEnabled()) throw bad("Set OPENROUTER_API_KEY to generate briefings.");
  const body = await req.json().catch(() => ({}));
  const report = await buildFullReport(user.id, body.goalId);
  if (!report.goal) throw bad("Set a goal first — the briefing is written against your goal.");

  const g = report.goal;
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
- Where the data itself is the problem — stale, sparse, missing — say so plainly in dataQuality. Advice built on 3 readings from 11 weeks ago is worse than admitting the gap.
- Never give medical advice or diagnose. If something looks clinically concerning, say it's worth raising with a doctor and move on.

Call tools until you have enough to write a briefing that covers: the overall verdict; each target
in turn; what is working; what to watch; concrete actions; the state of the data itself; an
experiment worth running; and the question you'd most need answered.

Then reply with exactly: INVESTIGATION COMPLETE
Do not write the briefing yet — you will be asked for it next, and drafting it twice wastes your budget.`;

  const { trace, steps, messages } = await runAgent(user.id, [
    { role: "system", content: system },
    { role: "user", content: context + "\n\nInvestigate the data, then reply INVESTIGATION COMPLETE." },
  ], { maxSteps: 10, maxTokens: 12000, temperature: 0.4, deadlineMs: 150_000 });

  if (!trace.length) throw bad("The model did not investigate the data. Try again.");

  // One structured generation over everything the investigation turned up.
  const briefing = await chatJson<Briefing>([
    { role: "system", content: system },
    ...messages.filter((m: any) => m.role !== "system"),
    {
      role: "user",
      content:
`Now write the briefing, using ONLY what your tool calls returned above. Return JSON:

{"verdict","onTrack":"yes|partly|no|unknown",
 "headlineNumber":{"value","label","context"} or null,
 "targets":[{"metric","status","whatsHappening","whyItMatters","doThis"}],
 "wins":[],"risks":[],
 "actions":[{"action","why","metric","effort":"low|medium|high","expectedEffect"}],
 "dataQuality":[],
 "experiment":{"hypothesis","test","measure"} or null,
 "question":""}

headlineNumber: the single figure that best captures where they stand, with one clause of context.
targets: one entry per goal target discussed.
expectedEffect: what should move, and roughly by how much, if the action is taken.
dataQuality: gaps, staleness or sparsity that limit what can be concluded.

Every number must trace to a tool result. Keep the caveats — a finding without its limitation is worse than no finding.`,
    },
  ], { maxTokens: 16000, temperature: 0.4 });

  briefing.checked = trace;

  await sql`
    INSERT INTO insights (user_id, goal_id, kind, period_start, period_end, payload, model)
    VALUES (${user.id}, ${g.goal.id}, 'briefing', ${addDays(today, -28)}, ${today},
            ${sql.json(briefing as never)}, ${textModel()})`;

  return { briefing, model: textModel(), steps, toolCalls: trace.length };
});

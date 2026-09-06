import { route, bad } from "@/lib/api";
import { sql } from "@/lib/db";
import { chatJson, textModel } from "@/lib/openrouter";
import { runAgentStep, type AgentTrace } from "@/lib/agent";
import type { Briefing } from "@/app/api/insights/route";
import { todayISO, addDays } from "@/lib/metrics";

// One model turn per request, comfortably inside the free tier's 60s cap.
export const maxDuration = 60;

const MAX_STEPS = 12;

type JobRow = {
  id: number; status: string; phase: string; steps: number;
  state: any[]; trace: AgentTrace[]; result: Briefing | null;
  error: string | null; goal_id: number | null;
};

/** Poll without advancing — for reconnecting to a job already in flight. */
export const GET = route(async (user, _req, ctx) => {
  const id = Number((await ctx.params).id);
  const job = await load(user.id, id);
  return summarise(job);
});

/**
 * Advance the job by one step.
 *
 * The client calls this in a loop. Each call performs a single model turn:
 * during `investigate` that is a round of tool calls; during `write` it is the
 * one structured generation that produces the briefing. Splitting the write
 * into its own phase matters because it is the longest single generation and
 * would otherwise share a request with a tool round.
 */
export const POST = route(async (user, _req, ctx) => {
  const id = Number((await ctx.params).id);
  const job = await load(user.id, id);
  if (job.status !== "running") return summarise(job);

  try {
    if (job.phase === "investigate") {
      const force = job.steps >= MAX_STEPS - 1;
      const { messages, calls, done } = await runAgentStep(user.id, job.state, { force });
      const trace = [...(job.trace ?? []), ...calls];

      if (done || force) {
        await sql`UPDATE jobs SET phase = 'write', steps = steps + 1, state = ${sql.json(messages as never)},
                  trace = ${sql.json(trace as never)}, updated_at = now() WHERE id = ${id}`;
      } else {
        await sql`UPDATE jobs SET steps = steps + 1, state = ${sql.json(messages as never)},
                  trace = ${sql.json(trace as never)}, updated_at = now() WHERE id = ${id}`;
      }
      return summarise(await load(user.id, id));
    }

    if (job.phase === "write") {
      const briefing = await chatJson<Briefing>([
        ...job.state,
        { role: "user", content: WRITE_INSTRUCTION },
        // Low reasoning effort: by this point the investigation is done and the
        // findings are in the conversation, so this turn is composition rather
        // than analysis. At medium effort it spent 62s — over the 60s cap.
      ], { maxTokens: 12000, temperature: 0.4, effort: "low" });
      briefing.checked = job.trace ?? [];

      await sql`
        INSERT INTO insights (user_id, goal_id, kind, period_start, period_end, payload, model)
        VALUES (${user.id}, ${job.goal_id}, 'briefing', ${addDays(todayISO(), -28)}, ${todayISO()},
                ${sql.json(briefing as never)}, ${textModel()})`;
      await sql`UPDATE jobs SET status = 'done', phase = 'finished', result = ${sql.json(briefing as never)},
                updated_at = now() WHERE id = ${id}`;
      return summarise(await load(user.id, id));
    }

    return summarise(job);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Step failed";
    await sql`UPDATE jobs SET status = 'error', error = ${msg}, updated_at = now() WHERE id = ${id}`;
    return summarise(await load(user.id, id));
  }
});

const WRITE_INSTRUCTION =
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

Every number must trace to a tool result. Keep the caveats — a finding without its limitation is worse than no finding.`;

async function load(userId: number, id: number): Promise<JobRow> {
  const [job] = await sql<JobRow[]>`
    SELECT id, status, phase, steps, state, trace, result, error, goal_id
    FROM jobs WHERE id = ${id} AND user_id = ${userId}`;
  if (!job) throw bad("No such job");
  return job;
}

/** Never return `state` — it holds the whole conversation and is large. */
function summarise(job: JobRow) {
  return {
    jobId: job.id,
    status: job.status,
    phase: job.phase,
    steps: job.steps,
    maxSteps: MAX_STEPS,
    toolsUsed: (job.trace ?? []).map((t) => t.tool),
    checked: job.trace ?? [],
    briefing: job.result,
    error: job.error,
  };
}

import { route, bad } from "@/lib/api";
import { sql } from "@/lib/db";
import { chatJson, llmEnabled, textModel } from "@/lib/openrouter";
import { type AgentTrace } from "@/lib/agent";
import { buildFullReport } from "@/lib/report";
import { briefingPrompt } from "@/lib/briefing";
import { todayISO, addDays } from "@/lib/metrics";

export const maxDuration = 60;

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
 * Briefings run as a resumable job.
 *
 * The investigation makes 12-16 tool calls across several model turns and takes
 * minutes end to end, which no serverless function will hold open on a free
 * plan. POST here starts the job and returns immediately; the client then calls
 * /api/insights/job/[id] repeatedly, each call advancing one step. The user
 * watches the model work instead of watching a spinner.
 */
export const POST = route(async (user, req) => {
  if (!llmEnabled()) throw bad("Set OPENROUTER_API_KEY to generate briefings.");
  const body = await req.json().catch(() => ({}));
  const report = await buildFullReport(user.id, body.goalId);
  if (!report.goal) throw bad("Set a goal first — the briefing is written against your goal.");

  const { system, context } = briefingPrompt(report);

  // Supersede any job still running for this user; only the newest matters.
  await sql`UPDATE jobs SET status = 'error', error = 'superseded by a newer run'
            WHERE user_id = ${user.id} AND kind = 'briefing' AND status = 'running'`;

  const [job] = await sql<{ id: number }[]>`
    INSERT INTO jobs (user_id, kind, status, goal_id, phase, state, trace)
    VALUES (${user.id}, 'briefing', 'running', ${report.goal.goal.id}, 'investigate',
            ${sql.json([
              { role: "system", content: system },
              { role: "user", content: context + "\n\nInvestigate the data, then reply INVESTIGATION COMPLETE." },
            ] as never)},
            ${sql.json([] as never)})
    RETURNING id`;

  return { jobId: job.id, status: "running", phase: "investigate" };
});

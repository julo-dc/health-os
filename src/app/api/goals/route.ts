import { route, bad } from "@/lib/api";
import { sql } from "@/lib/db";
import { ensureMetricDef, todayISO } from "@/lib/metrics";
import { getGoals, getGoalTargets } from "@/lib/report";

export const GET = route(async (user) => {
  const goals = await getGoals(user.id);
  const withTargets = await Promise.all(
    goals.map(async (g) => ({ ...g, targets: await getGoalTargets(g.id) }))
  );
  return { goals: withTargets };
});

export const POST = route(async (user, req) => {
  const b = await req.json();
  if (!b.title?.trim()) throw bad("A goal needs a title");
  const targets = (b.targets ?? []) as {
    metric_key: string; direction: string; baseline?: number | null;
    target_value?: number | null; weight?: number; notes?: string;
  }[];

  // Only one goal is "active" at a time; the rest become the archive.
  if ((b.status ?? "active") === "active") {
    await sql`UPDATE goals SET status = 'archived', archived_at = now()
              WHERE user_id = ${user.id} AND status = 'active'`;
  }

  const [goal] = await sql<{ id: number }[]>`
    INSERT INTO goals (user_id, title, kind, description, start_date, target_date, status, narrative)
    VALUES (${user.id}, ${b.title}, ${b.kind ?? "mixed"}, ${b.description ?? null},
            ${b.start_date ?? todayISO()}, ${b.target_date ?? null},
            ${b.status ?? "active"}, ${b.narrative ?? null})
    RETURNING id`;

  for (const t of targets) {
    if (!t.metric_key) continue;
    await ensureMetricDef(user.id, t.metric_key);
    await sql`
      INSERT INTO goal_targets (goal_id, metric_key, direction, baseline, target_value, weight, notes)
      VALUES (${goal.id}, ${t.metric_key}, ${t.direction ?? "increase"}, ${t.baseline ?? null},
              ${t.target_value ?? null}, ${t.weight ?? 1}, ${t.notes ?? null})`;
  }
  return { ok: true, id: goal.id };
});

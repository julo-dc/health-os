import { route, bad } from "@/lib/api";
import { sql } from "@/lib/db";
import { ensureMetricDef } from "@/lib/metrics";

async function owned(userId: number, id: number) {
  const [g] = await sql`SELECT id FROM goals WHERE id = ${id} AND user_id = ${userId}`;
  if (!g) throw bad("Goal not found");
}

export const PATCH = route(async (user, req, ctx) => {
  const id = Number((await ctx.params).id);
  await owned(user.id, id);
  const b = await req.json();

  if (b.status === "active") {
    await sql`UPDATE goals SET status = 'archived', archived_at = now()
              WHERE user_id = ${user.id} AND status = 'active' AND id <> ${id}`;
  }

  await sql`
    UPDATE goals SET
      title       = COALESCE(${b.title ?? null}, title),
      kind        = COALESCE(${b.kind ?? null}, kind),
      description = COALESCE(${b.description ?? null}, description),
      start_date  = COALESCE(${b.start_date ?? null}::date, start_date),
      target_date = COALESCE(${b.target_date ?? null}::date, target_date),
      status      = COALESCE(${b.status ?? null}, status),
      archived_at = CASE WHEN ${b.status ?? null} = 'archived' THEN now() ELSE archived_at END
    WHERE id = ${id}`;

  if (Array.isArray(b.targets)) {
    await sql`DELETE FROM goal_targets WHERE goal_id = ${id}`;
    for (const t of b.targets) {
      if (!t.metric_key) continue;
      await ensureMetricDef(user.id, t.metric_key);
      await sql`
        INSERT INTO goal_targets (goal_id, metric_key, direction, baseline, target_value, weight, notes)
        VALUES (${id}, ${t.metric_key}, ${t.direction ?? "increase"}, ${t.baseline ?? null},
                ${t.target_value ?? null}, ${t.weight ?? 1}, ${t.notes ?? null})`;
    }
  }
  return { ok: true };
});

export const DELETE = route(async (user, _req, ctx) => {
  const id = Number((await ctx.params).id);
  await owned(user.id, id);
  await sql`DELETE FROM goals WHERE id = ${id}`;
  return { ok: true };
});

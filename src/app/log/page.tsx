import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { getMetricDefs, todayISO, addDays } from "@/lib/metrics";
import { sql, ensureDb } from "@/lib/db";
import { LogClient } from "@/components/log-client";

export const dynamic = "force-dynamic";

export default async function LogPage() {
  const user = await getUser();
  if (!user) redirect("/login");
  await ensureDb();

  const defs = await getMetricDefs(user.id);
  const recent = await sql<{ date: string; metric_key: string; value: number; source: string }[]>`
    SELECT date::text, metric_key, value, source FROM metrics
    WHERE user_id = ${user.id} AND date > ${addDays(todayISO(), -14)}
    ORDER BY date DESC, metric_key`;
  const notes = await sql<{ id: number; date: string; body: string; kind: string }[]>`
    SELECT id, date::text, body, kind FROM entries
    WHERE user_id = ${user.id} ORDER BY date DESC, id DESC LIMIT 30`;
  const goalKeys = await sql<{ metric_key: string }[]>`
    SELECT gt.metric_key FROM goal_targets gt
    JOIN goals g ON g.id = gt.goal_id
    WHERE g.user_id = ${user.id} AND g.status = 'active'`;

  return <LogClient metrics={defs} recent={recent} notes={notes} today={todayISO()}
                    goalKeys={goalKeys.map((g) => g.metric_key)} />;
}

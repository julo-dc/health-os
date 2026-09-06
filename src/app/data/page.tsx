import { redirect } from "next/navigation";
import { getUser, getAccessToken, getConnectionHealth } from "@/lib/auth";
import { sql, ensureDb } from "@/lib/db";
import { DataClient } from "@/components/data-client";

export const dynamic = "force-dynamic";

export default async function DataPage() {
  const user = await getUser();
  if (!user) redirect("/login");
  await ensureDb();

  const [syncLog, coverage, token] = await Promise.all([
    sql<{ data_type: string; ok: boolean; rows: number; message: string | null; ran_at: Date }[]>`
      SELECT DISTINCT ON (data_type) data_type, ok, rows, message, ran_at
      FROM sync_log WHERE user_id = ${user.id}
      ORDER BY data_type, ran_at DESC`,
    sql<{ metric_key: string; n: number; first: string; last: string; sources: string[] }[]>`
      SELECT metric_key, COUNT(*)::int AS n, MIN(date)::text AS first, MAX(date)::text AS last,
             ARRAY_AGG(DISTINCT source) AS sources
      FROM metrics WHERE user_id = ${user.id}
      GROUP BY metric_key ORDER BY COUNT(*) DESC`,
    getAccessToken(user.id).catch(() => null),
  ]);
  const health = await getConnectionHealth(user.id);

  const workouts = await sql<{ n: number; first: string | null; last: string | null }[]>`
    SELECT COUNT(*)::int AS n, MIN(date)::text AS first, MAX(date)::text AS last
    FROM workouts WHERE user_id = ${user.id}`;

  return <DataClient syncLog={syncLog.map((s) => ({ ...s, ran_at: s.ran_at.toISOString() }))}
                     coverage={coverage} workouts={workouts[0]} connected={Boolean(token)}
                     health={health} />;
}

import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { buildFullReport } from "@/lib/report";
import { llmEnabled } from "@/lib/openrouter";
import { sql, ensureDb } from "@/lib/db";
import { Dashboard } from "@/components/dashboard";
import type { Briefing } from "@/app/api/insights/route";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getUser();
  if (!user) redirect("/login");
  await ensureDb();

  const [report, latestBriefing, counts] = await Promise.all([
    buildFullReport(user.id),
    sql<{ payload: Briefing; created_at: Date }[]>`
      SELECT payload, created_at FROM insights
      WHERE user_id = ${user.id} AND kind = 'briefing' ORDER BY created_at DESC LIMIT 1`,
    sql<{ metrics: number; workouts: number; last_sync: Date | null }[]>`
      SELECT (SELECT COUNT(*) FROM metrics WHERE user_id = ${user.id})::int AS metrics,
             (SELECT COUNT(*) FROM workouts WHERE user_id = ${user.id})::int AS workouts,
             (SELECT MAX(ran_at) FROM sync_log WHERE user_id = ${user.id} AND ok) AS last_sync`,
  ]);

  return (
    <Dashboard
      report={report}
      briefing={latestBriefing[0]?.payload ?? null}
      briefingAt={latestBriefing[0]?.created_at?.toISOString() ?? null}
      llmEnabled={llmEnabled()}
      stats={{
        metrics: counts[0]?.metrics ?? 0,
        workouts: counts[0]?.workouts ?? 0,
        lastSync: counts[0]?.last_sync?.toISOString() ?? null,
      }}
    />
  );
}

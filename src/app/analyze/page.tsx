import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { getMetricDefs } from "@/lib/metrics";
import { sql, ensureDb } from "@/lib/db";
import { AnalyzeClient } from "@/components/analyze-client";

export const dynamic = "force-dynamic";

export default async function AnalyzePage({ searchParams }: { searchParams: Promise<{ metric?: string }> }) {
  const user = await getUser();
  if (!user) redirect("/login");
  await ensureDb();
  const { metric } = await searchParams;

  const defs = await getMetricDefs(user.id);
  // Only offer metrics that actually have data.
  const populated = await sql<{ metric_key: string; n: number }[]>`
    SELECT metric_key, COUNT(*)::int AS n FROM metrics WHERE user_id = ${user.id}
    GROUP BY metric_key HAVING COUNT(*) >= 3`;
  const have = new Set(populated.map((p) => p.metric_key));
  const counts = Object.fromEntries(populated.map((p) => [p.metric_key, p.n]));

  return (
    <AnalyzeClient
      metrics={defs.filter((d) => have.has(d.key))}
      counts={counts}
      initial={metric ?? populated.sort((a, b) => b.n - a.n)[0]?.metric_key ?? null}
    />
  );
}

import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { getMetricDefs } from "@/lib/metrics";
import { ensureDb, sql } from "@/lib/db";
import { GlossaryClient } from "@/components/glossary-client";

export const dynamic = "force-dynamic";

export default async function GlossaryPage() {
  const user = await getUser();
  if (!user) redirect("/login");
  await ensureDb();
  const defs = await getMetricDefs(user.id);
  const have = await sql<{ metric_key: string; n: number }[]>`
    SELECT metric_key, COUNT(*)::int AS n FROM metrics WHERE user_id = ${user.id} GROUP BY metric_key`;
  return <GlossaryClient defs={defs} counts={Object.fromEntries(have.map((h) => [h.metric_key, h.n]))} />;
}

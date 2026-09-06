import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { getGoals, getGoalTargets } from "@/lib/report";
import { getMetricDefs } from "@/lib/metrics";
import { llmEnabled } from "@/lib/openrouter";
import { GoalsClient } from "@/components/goals-client";
import { ensureDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function GoalsPage() {
  const user = await getUser();
  if (!user) redirect("/login");
  await ensureDb();

  const goals = await getGoals(user.id);
  const withTargets = await Promise.all(goals.map(async (g) => ({ ...g, targets: await getGoalTargets(g.id) })));
  const defs = await getMetricDefs(user.id);

  return <GoalsClient goals={withTargets} metrics={defs} llmEnabled={llmEnabled()} />;
}

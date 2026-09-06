import { route } from "@/lib/api";
import { buildFullReport } from "@/lib/report";

export const maxDuration = 60;

export const GET = route(async (user, req) => {
  const goalId = new URL(req.url).searchParams.get("goal");
  return buildFullReport(user.id, goalId ? Number(goalId) : undefined);
});

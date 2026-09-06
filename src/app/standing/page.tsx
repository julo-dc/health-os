import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { ensureDb } from "@/lib/db";
import { StandingClient } from "@/components/standing-client";

export const dynamic = "force-dynamic";

export default async function StandingPage() {
  const user = await getUser();
  if (!user) redirect("/login");
  await ensureDb();
  return <StandingClient />;
}

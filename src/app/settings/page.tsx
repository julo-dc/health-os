import { redirect } from "next/navigation";
import { getUser, getAccessToken, getConnectionHealth, GOOGLE_SCOPES } from "@/lib/auth";
import { sql, ensureDb } from "@/lib/db";
import { llmEnabled, textModel, visionModel } from "@/lib/openrouter";
import { SettingsClient } from "@/components/settings-client";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getUser();
  if (!user) redirect("/login");
  await ensureDb();

  const [tok] = await sql<{ scope: string; expires_at: Date; refresh_token: string | null }[]>`
    SELECT scope, expires_at, refresh_token FROM oauth_tokens
    WHERE user_id = ${user.id} AND provider = 'google'`;
  const [settings] = await sql<{ tz: string; prefs: Record<string, unknown> }[]>`
    SELECT tz, prefs FROM settings WHERE user_id = ${user.id}`;
  const counts = await sql<{ metrics: number; workouts: number; photos: number; entries: number }[]>`
    SELECT (SELECT COUNT(*) FROM metrics  WHERE user_id = ${user.id})::int AS metrics,
           (SELECT COUNT(*) FROM workouts WHERE user_id = ${user.id})::int AS workouts,
           (SELECT COUNT(*) FROM photos   WHERE user_id = ${user.id})::int AS photos,
           (SELECT COUNT(*) FROM entries  WHERE user_id = ${user.id})::int AS entries`;

  const token = await getAccessToken(user.id).catch(() => null);
  const health = await getConnectionHealth(user.id);

  return (
    <SettingsClient
      user={{ email: user.email, name: user.name }}
      google={{
        connected: Boolean(token),
        hasRefresh: Boolean(tok?.refresh_token),
        scopes: tok?.scope?.split(" ") ?? [],
        expected: GOOGLE_SCOPES,
        daysLeftIfTesting: health.daysLeftIfTesting,
      }}
      llm={{ enabled: llmEnabled(), model: textModel(), vision: visionModel() }}
      prefs={{ tz: settings?.tz ?? "UTC", age: (settings?.prefs as any)?.age ?? null, sex: (settings?.prefs as any)?.sex ?? null }}
      counts={counts[0]}
    />
  );
}

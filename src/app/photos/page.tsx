import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { sql, ensureDb } from "@/lib/db";
import { llmEnabled } from "@/lib/openrouter";
import { PhotosClient } from "@/components/photos-client";
import type { PhotoAnalysis } from "@/app/api/photos/route";

export const dynamic = "force-dynamic";

export default async function PhotosPage() {
  const user = await getUser();
  if (!user) redirect("/login");
  await ensureDb();
  const photos = await sql<{ id: number; date: string; kind: string; analysis: PhotoAnalysis | null }[]>`
    SELECT id, date::text, kind, analysis FROM photos
    WHERE user_id = ${user.id} ORDER BY date DESC, id DESC`;
  return <PhotosClient photos={photos} llmEnabled={llmEnabled()} />;
}

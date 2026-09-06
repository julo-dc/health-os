import { route } from "@/lib/api";
import { sql } from "@/lib/db";
import { recomputeDerived } from "@/lib/derive";

// Recomputes the derived series, so this needs more than the 10s default.
export const maxDuration = 60;

export const POST = route(async (user, req) => {
  const b = await req.json();
  const patch: Record<string, unknown> = {};
  if (b.age !== undefined) patch.age = b.age;

  await sql`
    INSERT INTO settings (user_id, tz, prefs)
    VALUES (${user.id}, ${b.tz ?? "UTC"}, ${sql.json(patch as never)})
    ON CONFLICT (user_id) DO UPDATE SET
      tz = COALESCE(${b.tz ?? null}, settings.tz),
      prefs = settings.prefs || ${sql.json(patch as never)}`;

  // Max-HR feeds the load model, so a changed age changes every derived value.
  if (b.age !== undefined) await recomputeDerived(user.id);
  return { ok: true };
});

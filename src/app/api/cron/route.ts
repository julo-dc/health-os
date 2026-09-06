import { NextResponse } from "next/server";
import { sql, ensureDb } from "@/lib/db";
import { recomputeDerived } from "@/lib/derive";

export const maxDuration = 60;

/**
 * Scheduled recompute. Point Vercel Cron at this with a CRON_SECRET set.
 * Deliberately does not sync Google — token refresh needs the user's consent
 * to still be valid, and a silent failure at 4am is worse than a manual button.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  await ensureDb();
  const users = await sql<{ id: number }[]>`SELECT id FROM users`;
  const out: Record<string, number> = {};
  for (const u of users) {
    const r = await recomputeDerived(u.id);
    out[String(u.id)] = r.written;
  }
  return NextResponse.json({ ok: true, users: users.length, derived: out });
}

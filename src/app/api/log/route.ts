import { route, bad } from "@/lib/api";
import { sql } from "@/lib/db";
import { upsertMetrics, ensureMetricDef, todayISO } from "@/lib/metrics";
import { recomputeDerived } from "@/lib/derive";

/** Manual entry: metric values and/or a journal note for one date. */
export const POST = route(async (user, req) => {
  const body = await req.json();
  const date: string = body.date ?? todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad("Invalid date");

  const values = (body.values ?? {}) as Record<string, number | string | null>;
  const rows = Object.entries(values)
    .map(([key, v]) => ({ key, value: typeof v === "string" ? parseFloat(v) : (v as number) }))
    .filter((r) => Number.isFinite(r.value))
    .map((r) => ({ date, key: r.key, value: r.value, source: "manual" }));

  for (const r of rows) await ensureMetricDef(user.id, r.key);
  const written = await upsertMetrics(user.id, rows);

  if (body.note && String(body.note).trim()) {
    await sql`INSERT INTO entries (user_id, date, kind, body, meta)
              VALUES (${user.id}, ${date}, ${body.kind ?? "note"}, ${String(body.note)},
                      ${sql.json((body.meta ?? {}) as never)})`;
  }

  if (written) await recomputeDerived(user.id);
  return { ok: true, written, date };
});

/** Delete a manually-entered value. */
export const DELETE = route(async (user, req) => {
  const url = new URL(req.url);
  const date = url.searchParams.get("date");
  const key = url.searchParams.get("key");
  if (!date || !key) throw bad("date and key are required");
  await sql`DELETE FROM metrics WHERE user_id = ${user.id} AND date = ${date}
            AND metric_key = ${key} AND source = 'manual'`;
  return { ok: true };
});

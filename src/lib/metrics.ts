import { sql } from "./db";
import { CORE_METRICS, SOURCE_PRIORITY, toISO, type MetricDef, type Point } from "./metric-meta";

export * from "./metric-meta";

/** Insert the core vocabulary for a user; never overwrites customised rows. */
export async function seedMetricDefs(userId: number) {
  for (const m of CORE_METRICS) {
    await sql`
      INSERT INTO metric_defs (user_id, key, label, unit, category, higher_is_better, agg, precision, is_custom)
      VALUES (${userId}, ${m.key}, ${m.label}, ${m.unit}, ${m.category},
              ${m.higher_is_better}, ${m.agg}, ${m.precision}, false)
      ON CONFLICT (user_id, key) DO NOTHING`;
  }
}

export async function getMetricDefs(userId: number): Promise<MetricDef[]> {
  return sql<MetricDef[]>`
    SELECT key, label, unit, category, higher_is_better, agg, precision, is_custom
    FROM metric_defs WHERE user_id = ${userId} ORDER BY category, label`;
}

export async function getMetricDefMap(userId: number): Promise<Record<string, MetricDef>> {
  const defs = await getMetricDefs(userId);
  return Object.fromEntries(defs.map((d) => [d.key, d]));
}

/** Create a metric definition on the fly for an unknown key (custom CSV column etc). */
export async function ensureMetricDef(userId: number, key: string, partial: Partial<MetricDef> = {}) {
  const label = partial.label ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  await sql`
    INSERT INTO metric_defs (user_id, key, label, unit, category, higher_is_better, agg, precision, is_custom)
    VALUES (${userId}, ${key}, ${label}, ${partial.unit ?? null}, ${partial.category ?? "custom"},
            ${partial.higher_is_better ?? null}, ${partial.agg ?? "mean"}, ${partial.precision ?? 2}, true)
    ON CONFLICT (user_id, key) DO NOTHING`;
}

/** Fetch one metric as a date-ordered series, collapsing duplicate sources by priority. */
export async function getSeries(
  userId: number,
  key: string,
  from?: string,
  to?: string
): Promise<Point[]> {
  const rows = await sql<{ date: Date; value: number; source: string }[]>`
    SELECT date, value, source FROM metrics
    WHERE user_id = ${userId} AND metric_key = ${key}
      ${from ? sql`AND date >= ${from}` : sql``}
      ${to ? sql`AND date <= ${to}` : sql``}
    ORDER BY date ASC`;

  const best = new Map<string, { value: number; prio: number }>();
  for (const r of rows) {
    const d = toISO(r.date);
    const prio = SOURCE_PRIORITY[r.source] ?? 0;
    const cur = best.get(d);
    if (!cur || prio > cur.prio) best.set(d, { value: Number(r.value), prio });
  }
  return [...best.entries()]
    .map(([date, v]) => ({ date, value: v.value }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Fetch many metrics at once, keyed by metric. */
export async function getSeriesMulti(
  userId: number,
  keys: string[],
  from?: string,
  to?: string
): Promise<Record<string, Point[]>> {
  if (!keys.length) return {};
  const rows = await sql<{ date: Date; metric_key: string; value: number; source: string }[]>`
    SELECT date, metric_key, value, source FROM metrics
    WHERE user_id = ${userId} AND metric_key = ANY(${keys})
      ${from ? sql`AND date >= ${from}` : sql``}
      ${to ? sql`AND date <= ${to}` : sql``}
    ORDER BY date ASC`;

  const best = new Map<string, { value: number; prio: number }>();
  for (const r of rows) {
    const id = `${r.metric_key}|${toISO(r.date)}`;
    const prio = SOURCE_PRIORITY[r.source] ?? 0;
    const cur = best.get(id);
    if (!cur || prio > cur.prio) best.set(id, { value: Number(r.value), prio });
  }
  const out: Record<string, Point[]> = Object.fromEntries(keys.map((k) => [k, []]));
  for (const [id, v] of best) {
    const [k, date] = id.split("|");
    (out[k] ||= []).push({ date, value: v.value });
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/** Bulk upsert. Values that are not finite are skipped rather than poisoning the series. */
export async function upsertMetrics(
  userId: number,
  rows: { date: string; key: string; value: number; source: string; meta?: unknown }[]
): Promise<number> {
  const clean = rows.filter((r) => Number.isFinite(r.value) && /^\d{4}-\d{2}-\d{2}$/.test(r.date));
  if (!clean.length) return 0;

  let written = 0;
  const CHUNK = 500;
  for (let i = 0; i < clean.length; i += CHUNK) {
    const batch = clean.slice(i, i + CHUNK).map((r) => ({
      user_id: userId,
      date: r.date,
      metric_key: r.key,
      value: r.value,
      source: r.source,
      meta: r.meta ? sql.json(r.meta as never) : null,
    }));
    await sql`
      INSERT INTO metrics ${sql(batch, "user_id", "date", "metric_key", "value", "source", "meta")}
      ON CONFLICT (user_id, date, metric_key, source)
      DO UPDATE SET value = EXCLUDED.value, meta = EXCLUDED.meta`;
    written += batch.length;
  }
  return written;
}


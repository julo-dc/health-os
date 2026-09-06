import { route, bad } from "@/lib/api";
import { parseCsv, profileColumns } from "@/lib/csv";
import { classifyCsv } from "@/lib/csv-classify";
import { getMetricDefs } from "@/lib/metrics";

export const maxDuration = 60;

/**
 * Parse an uploaded CSV and have the model work out what it is.
 * Returns a *proposal* — nothing is written until the user confirms it.
 */
export const POST = route(async (user, req) => {
  const form = await req.formData();
  const file = form.get("file");
  const hint = (form.get("hint") as string) || undefined;
  if (!(file instanceof File)) throw bad("No file uploaded");
  if (file.size > 25 * 1024 * 1024) throw bad("File is larger than 25MB");

  const text = await file.text();
  const { headers, rows } = parseCsv(text);
  if (!headers.length) throw bad("Could not read any columns from that file");
  if (!rows.length) throw bad("That file has headers but no data rows");

  const vocabulary = await getMetricDefs(user.id);
  const profiles = profileColumns(headers, rows, "metrics");
  const plan = await classifyCsv(headers, rows, profiles, vocabulary, hint);

  return {
    filename: file.name,
    headers,
    rowCount: rows.length,
    plan,
    columns: profiles,
    preview: rows.slice(0, 8),
    metricOptions: vocabulary.map((d) => ({ key: d.key, label: d.label, unit: d.unit, category: d.category })),
  };
});

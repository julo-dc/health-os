import { route, bad } from "@/lib/api";
import { sql } from "@/lib/db";
import { chatJson, llmEnabled, visionModel } from "@/lib/openrouter";
import { upsertMetrics, todayISO } from "@/lib/metrics";
import { recomputeDerived } from "@/lib/derive";

export const maxDuration = 120;

export type PhotoAnalysis = {
  summary: string;
  observations: string[];
  estimatedBodyFatRange: [number, number] | null;
  visibleMuscleGroups: string[];
  postureNotes: string | null;
  comparisonToPrevious: string | null;
  extractedValues: Record<string, number>;
  confidence: "low" | "medium" | "high";
  caveat: string;
};

export const GET = route(async (user) => {
  const rows = await sql<{ id: number; date: string; kind: string; analysis: PhotoAnalysis | null; created_at: Date }[]>`
    SELECT id, date::text, kind, analysis, created_at FROM photos
    WHERE user_id = ${user.id} ORDER BY date DESC, id DESC`;
  return { photos: rows, llmEnabled: llmEnabled() };
});

/**
 * Upload a photo. Two distinct jobs depending on `kind`:
 *   - progress: a physique photo -> qualitative body-composition read
 *   - screenshot: a scale / app / whiteboard screenshot -> extract the numbers
 *     and write them straight into the metric store
 */
export const POST = route(async (user, req) => {
  const form = await req.formData();
  const file = form.get("file");
  const date = (form.get("date") as string) || todayISO();
  const kind = (form.get("kind") as string) || "progress";
  const note = (form.get("note") as string) || "";
  if (!(file instanceof File)) throw bad("No file uploaded");
  if (file.size > 10 * 1024 * 1024) throw bad("Image is larger than 10MB — resize it first");
  if (!file.type.startsWith("image/")) throw bad("That is not an image");

  const buf = Buffer.from(await file.arrayBuffer());
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO photos (user_id, date, mime, bytes, kind)
    VALUES (${user.id}, ${date}, ${file.type}, ${buf}, ${kind}) RETURNING id`;

  if (!llmEnabled()) return { ok: true, id: row.id, analysis: null, note: "Stored. Add OPENROUTER_API_KEY to analyse images." };

  // Give the model the previous photo's summary so it can comment on change.
  const [prev] = await sql<{ date: string; analysis: PhotoAnalysis | null }[]>`
    SELECT date::text, analysis FROM photos
    WHERE user_id = ${user.id} AND kind = ${kind} AND id <> ${row.id} AND analysis IS NOT NULL
    ORDER BY date DESC LIMIT 1`;

  const dataUrl = `data:${file.type};base64,${buf.toString("base64")}`;
  const system = kind === "screenshot"
    ? `You extract numeric health/fitness/business data from a screenshot (smart scale, tracking app, dashboard, whiteboard).

Put every number you can read confidently into extractedValues, keyed by these canonical names where they apply:
weight_kg, body_fat_pct, lean_mass_kg, waist_cm, resting_hr, hrv_ms, sleep_hours, sleep_efficiency, steps, vo2max, calories_in, protein_g, revenue, mrr, customers, deep_work_hours, focus_score, mood, energy, stress.
Convert units to match those keys (lbs->kg, minutes->hours for sleep). If a number's meaning is ambiguous, leave it out rather than guessing.
Set estimatedBodyFatRange to null. Set confidence by how legible the screenshot is.

Return ONLY JSON: {"summary","observations":[],"estimatedBodyFatRange":null,"visibleMuscleGroups":[],"postureNotes":null,"comparisonToPrevious":null,"extractedValues":{},"confidence","caveat"}`
    : `You analyse a physique progress photo for someone tracking a body recomposition.

Be specific and useful about what is visibly apparent: definition, apparent muscle fullness, posture, where fat appears to be carried. Comment on change versus the previous photo's description if given.

Hard rules:
- A visual body-fat estimate is a wide range (e.g. [14, 18]), never a single number, and you say it is a rough visual read.
- Never comment on attractiveness, and never moralise about the person's body.
- Do not diagnose anything medical.
- extractedValues should be {} unless a number is literally written in the image.
- Lighting, pump, angle and time of day change apparent physique enormously — put that in caveat.

Return ONLY JSON: {"summary","observations":[],"estimatedBodyFatRange":[low,high]|null,"visibleMuscleGroups":[],"postureNotes","comparisonToPrevious","extractedValues":{},"confidence","caveat"}`;

  try {
    const analysis = await chatJson<PhotoAnalysis>([
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text:
            `Date: ${date}.` +
            (note ? ` My note: ${note}` : "") +
            (prev?.analysis ? `\n\nPrevious photo (${prev.date}) was described as: ${prev.analysis.summary}` : "\n\nNo previous photo to compare against.") },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ], { model: visionModel(), maxTokens: 12000, temperature: 0.3 });

    await sql`UPDATE photos SET analysis = ${sql.json(analysis as never)} WHERE id = ${row.id}`;

    // Numbers read out of a screenshot become real metrics.
    const extracted = Object.entries(analysis.extractedValues ?? {})
      .filter(([, v]) => Number.isFinite(Number(v)))
      .map(([key, v]) => ({ date, key, value: Number(v), source: "photo" }));
    if (extracted.length) {
      await upsertMetrics(user.id, extracted);
      await recomputeDerived(user.id);
    }
    if (note) {
      await sql`INSERT INTO entries (user_id, date, kind, body) VALUES (${user.id}, ${date}, 'photo', ${note})`;
    }

    return { ok: true, id: row.id, analysis, extracted: extracted.length };
  } catch (e) {
    return { ok: true, id: row.id, analysis: null, error: e instanceof Error ? e.message : "Analysis failed" };
  }
});

export const DELETE = route(async (user, req) => {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!id) throw bad("id is required");
  await sql`DELETE FROM photos WHERE id = ${id} AND user_id = ${user.id}`;
  return { ok: true };
});

"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PhotoAnalysis } from "@/app/api/photos/route";
import { Section, Empty, Spinner, StatusPill } from "@/components/ui";

type Photo = { id: number; date: string; kind: string; analysis: PhotoAnalysis | null };

export function PhotosClient({ photos, llmEnabled }: { photos: Photo[]; llmEnabled: boolean }) {
  const router = useRouter();
  const [kind, setKind] = useState<"progress" | "screenshot">("progress");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<Photo | null>(null);
  const [compare, setCompare] = useState<[Photo | null, Photo | null]>([null, null]);

  /** Downscale in the browser: keeps uploads small and the DB lean. */
  const shrink = (file: File): Promise<Blob> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const max = 1400;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not process image"))), "image/jpeg", 0.86);
      };
      img.onerror = () => reject(new Error("Could not read that image"));
      img.src = url;
    });

  const upload = async (file: File) => {
    setBusy(true); setMsg(null);
    try {
      const blob = await shrink(file);
      const fd = new FormData();
      fd.append("file", new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" }));
      fd.append("date", date); fd.append("kind", kind); fd.append("note", note);
      const res = await fetch("/api/photos", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      setMsg(j.analysis
        ? `Analysed.${j.extracted ? ` Extracted ${j.extracted} value${j.extracted === 1 ? "" : "s"} into your metrics.` : ""}`
        : j.error ?? j.note ?? "Stored.");
      setNote("");
      router.refresh();
    } catch (e) { setMsg(e instanceof Error ? e.message : "Upload failed"); }
    finally { setBusy(false); }
  };

  const remove = async (id: number) => {
    await fetch(`/api/photos?id=${id}`, { method: "DELETE" });
    setOpen(null); router.refresh();
  };

  const progress = photos.filter((p) => p.kind === "progress");

  return (
    <div className="space-y-5 rise">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Photos</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
          Progress photos get a visual read. Screenshots of scales, apps or whiteboards get their numbers pulled straight into your metrics.
        </p>
      </div>

      <Section title="Upload">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex rounded-lg p-0.5" style={{ background: "var(--surface-2)" }}>
            {(["progress", "screenshot"] as const).map((k) => (
              <button key={k} onClick={() => setKind(k)}
                      className="rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors"
                      style={{
                        background: kind === k ? "var(--series-1)" : "transparent",
                        color: kind === k ? "#fff" : "var(--text-secondary)",
                      }}>{k}</button>
            ))}
          </div>
          <label className="text-xs">
            <span className="label mb-1 block">Date</span>
            <input type="date" className="input w-auto" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="min-w-[200px] flex-1 text-xs">
            <span className="label mb-1 block">Note (optional)</span>
            <input className="input" value={note} placeholder={kind === "progress" ? "morning, fasted…" : "what this screenshot is"}
                   onChange={(e) => setNote(e.target.value)} />
          </label>
          <label className={`btn btn-primary ${busy ? "pointer-events-none opacity-50" : ""}`}>
            {busy ? <><Spinner /> Analysing…</> : "Choose image"}
            <input type="file" accept="image/*" className="hidden" disabled={busy}
                   onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </label>
        </div>
        {msg ? <p className="mt-3 text-sm" style={{ color: "var(--text-secondary)" }}>{msg}</p> : null}
        {!llmEnabled ? (
          <p className="mt-3 text-xs tone-warning">
            Images will be stored but not analysed — add <code>OPENROUTER_API_KEY</code> to enable vision.
          </p>
        ) : null}
      </Section>

      {progress.length >= 2 ? (
        <Section title="Compare" subtitle="Pick two dates to see them side by side">
          <div className="mb-4 flex flex-wrap gap-3">
            {[0, 1].map((i) => (
              <select key={i} className="input w-auto text-xs"
                      value={compare[i]?.id ?? ""}
                      onChange={(e) => {
                        const p = progress.find((x) => x.id === Number(e.target.value)) ?? null;
                        setCompare((c) => (i === 0 ? [p, c[1]] : [c[0], p]));
                      }}>
                <option value="">{i === 0 ? "Before…" : "After…"}</option>
                {progress.map((p) => <option key={p.id} value={p.id}>{p.date}</option>)}
              </select>
            ))}
          </div>
          {compare[0] && compare[1] ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {compare.map((p, i) => p ? (
                <figure key={i}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/photos/${p.id}/image`} alt={`Progress photo ${p.date}`}
                       className="w-full rounded-xl object-cover" style={{ border: "1px solid var(--border)" }} />
                  <figcaption className="mt-2 text-xs num" style={{ color: "var(--text-muted)" }}>{p.date}</figcaption>
                </figure>
              ) : null)}
            </div>
          ) : <Empty>Choose two photos.</Empty>}
        </Section>
      ) : null}

      <Section title="Timeline" subtitle={`${photos.length} image${photos.length === 1 ? "" : "s"}`}>
        {!photos.length ? <Empty>Nothing uploaded yet.</Empty> : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {photos.map((p) => (
              <button key={p.id} onClick={() => setOpen(p)} className="group text-left">
                <div className="relative overflow-hidden rounded-xl" style={{ border: "1px solid var(--border)" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/photos/${p.id}/image`} alt={`${p.kind} ${p.date}`}
                       className="aspect-[3/4] w-full object-cover transition-transform group-hover:scale-105" />
                  <span className="absolute left-2 top-2 chip text-[10px]"
                        style={{ background: "rgba(0,0,0,.6)", color: "#fff", borderColor: "transparent" }}>{p.kind}</span>
                </div>
                <div className="mt-2 num text-xs" style={{ color: "var(--text-muted)" }}>{p.date}</div>
                {p.analysis?.summary ? (
                  <p className="mt-1 line-clamp-2 text-xs" style={{ color: "var(--text-secondary)" }}>{p.analysis.summary}</p>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </Section>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
             style={{ background: "rgba(0,0,0,.7)" }} onClick={() => setOpen(null)}>
          <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl"
               style={{ background: "var(--surface-1)", border: "1px solid var(--border-strong)" }}
               onClick={(e) => e.stopPropagation()}>
            <div className="grid gap-0 md:grid-cols-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/photos/${open.id}/image`} alt="" className="max-h-[80vh] w-full object-contain" style={{ background: "var(--plane)" }} />
              <div className="p-5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="num text-sm font-semibold">{open.date}</div>
                    <div className="text-xs capitalize" style={{ color: "var(--text-muted)" }}>{open.kind}</div>
                  </div>
                  <button onClick={() => setOpen(null)} className="btn btn-ghost px-2">×</button>
                </div>

                {open.analysis ? (
                  <div className="mt-4 space-y-3 text-sm">
                    <StatusPill tone={open.analysis.confidence === "high" ? "good" : open.analysis.confidence === "medium" ? "warning" : "neutral"}>
                      {open.analysis.confidence} confidence
                    </StatusPill>
                    <p>{open.analysis.summary}</p>

                    {open.analysis.estimatedBodyFatRange ? (
                      <div className="rounded-lg p-2.5" style={{ background: "var(--surface-2)" }}>
                        <div className="label">Visual body-fat estimate</div>
                        <div className="num mt-0.5 text-lg font-semibold">
                          {open.analysis.estimatedBodyFatRange[0]}–{open.analysis.estimatedBodyFatRange[1]}%
                        </div>
                        <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
                          A rough visual read, not a measurement. Use a scale or calipers for the real number.
                        </p>
                      </div>
                    ) : null}

                    {Object.keys(open.analysis.extractedValues ?? {}).length ? (
                      <div>
                        <div className="label mb-1.5">Values pulled into your metrics</div>
                        <div className="flex flex-wrap gap-1.5">
                          {Object.entries(open.analysis.extractedValues).map(([k, v]) => (
                            <span key={k} className="chip num" style={{ color: "var(--text-secondary)" }}>{k} <b>{String(v)}</b></span>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {open.analysis.observations?.length ? (
                      <div>
                        <div className="label mb-1">Observations</div>
                        <ul className="space-y-1 text-xs" style={{ color: "var(--text-secondary)" }}>
                          {open.analysis.observations.map((o, i) => <li key={i}>· {o}</li>)}
                        </ul>
                      </div>
                    ) : null}

                    {open.analysis.comparisonToPrevious ? (
                      <div>
                        <div className="label mb-1">Versus last photo</div>
                        <p className="text-xs" style={{ color: "var(--text-secondary)" }}>{open.analysis.comparisonToPrevious}</p>
                      </div>
                    ) : null}

                    {open.analysis.caveat ? (
                      <p className="text-[11px] italic" style={{ color: "var(--text-muted)" }}>{open.analysis.caveat}</p>
                    ) : null}
                  </div>
                ) : (
                  <p className="mt-4 text-sm" style={{ color: "var(--text-muted)" }}>No analysis for this image.</p>
                )}

                <button onClick={() => remove(open.id)} className="btn btn-ghost mt-5 text-xs tone-critical">Delete photo</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

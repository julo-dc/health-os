"use client";
import { useState, useRef, useEffect, type ReactNode } from "react";
import { SEMANTICS, STAT_TERMS } from "@/lib/semantics";

/**
 * The same dictionary the model reads, shown to the reader.
 *
 * Detail is only useful if it can be interrogated, so every metric and every
 * statistical term carries its own explanation in place — what it measures, how
 * it is derived, how to read a change, and what makes it unreliable. Nothing is
 * duplicated: this renders `semantics.ts`, which is also what goes into the
 * prompts, so the app and the model can never drift apart on what a number means.
 */
export function Explain({ metric, term, children, side = "bottom" }: {
  metric?: string; term?: string; children?: ReactNode; side?: "bottom" | "top";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  const s = metric ? SEMANTICS[metric] : null;
  const t = term ? STAT_TERMS[term] : null;
  if (!s && !t) return <>{children ?? null}</>;

  const title = children ?? (term ? term.replace(/_/g, " ") : metric);

  return (
    <span ref={ref} className="relative inline-flex items-center gap-1">
      {children ? <span>{children}</span> : null}
      <button
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen((o) => !o); }}
        aria-label={`What is ${typeof title === "string" ? title : metric ?? term}?`}
        className="grid h-[15px] w-[15px] shrink-0 place-items-center rounded-full text-[11px] font-semibold leading-none transition-colors"
        style={{
          border: "1px solid var(--border-strong)",
          color: open ? "#fff" : "var(--text-muted)",
          background: open ? "var(--series-1)" : "transparent",
        }}>?</button>

      {open ? (
        <span
          onClick={(e) => e.stopPropagation()}
          className="absolute z-50 w-[300px] cursor-default rounded-xl p-3.5 text-left text-xs font-normal normal-case tracking-normal"
          style={{
            [side === "bottom" ? "top" : "bottom"]: "calc(100% + 8px)", left: 0,
            background: "var(--surface-2)", border: "1px solid var(--border-strong)",
            boxShadow: "var(--shadow)", color: "var(--text-secondary)", lineHeight: 1.55,
          } as React.CSSProperties}>
          {t ? (
            <>
              <b className="block capitalize" style={{ color: "var(--text-primary)" }}>{term!.replace(/_/g, " ")}</b>
              <span className="mt-1 block">{t.what}</span>
              <span className="mt-1.5 block" style={{ color: "var(--text-primary)" }}>{t.read}</span>
            </>
          ) : s ? (
            <>
              <span className="block" style={{ color: "var(--text-primary)" }}>{s.what}</span>
              <Row label="Measured by">{s.how}</Row>
              <Row label="How to read it">{s.read}</Row>
              {s.typical ? <Row label="Typical">{s.typical}</Row> : null}
              {s.caveat ? (
                <span className="mt-2 block rounded-lg px-2 py-1.5 bg-warning">
                  <b className="tone-warning">Careful. </b>{s.caveat}
                </span>
              ) : null}
              {s.derivedFrom?.length ? (
                <Row label="Computed from">{s.derivedFrom.map((k) => SEMANTICS[k] ? k : k).join(", ")}</Row>
              ) : null}
              {s.relatedTo?.length ? <Row label="Read alongside">{s.relatedTo.slice(0, 4).join(", ")}</Row> : null}
            </>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="mt-2 block">
      <b className="block text-[11px] uppercase tracking-[0.07em]" style={{ color: "var(--text-muted)" }}>{label}</b>
      <span className="block">{children}</span>
    </span>
  );
}

/** Inline label with its explanation attached — for stat rows and table headers. */
export function Term({ term, children }: { term: string; children: ReactNode }) {
  return <Explain term={term}>{children}</Explain>;
}

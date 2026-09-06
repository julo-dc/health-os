"use client";
import type { ReactNode } from "react";

export const TONE_CLASS: Record<string, string> = {
  good: "tone-good bg-good",
  warning: "tone-warning bg-warning",
  serious: "tone-serious bg-serious",
  critical: "tone-critical bg-critical",
  neutral: "tone-neutral bg-neutral",
};
export const TONE_COLOR: Record<string, string> = {
  good: "var(--status-good)",
  warning: "var(--status-warning)",
  serious: "var(--status-serious)",
  critical: "var(--status-critical)",
  neutral: "var(--text-muted)",
};

/** Status is never colour alone — every pill carries an icon and a word. */
export function StatusPill({ tone, children }: { tone: string; children: ReactNode }) {
  const icon = tone === "good" ? "▲" : tone === "critical" ? "▼" : tone === "warning" || tone === "serious" ? "●" : "–";
  return (
    <span className={`chip ${TONE_CLASS[tone] ?? TONE_CLASS.neutral}`} style={{ borderColor: "transparent" }}>
      <span aria-hidden className="text-[9px]">{icon}</span>{children}
    </span>
  );
}

export function Section({ title, subtitle, action, children, className = "" }: {
  title: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`card-pad ${className}`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>{subtitle}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children, cta }: { children: ReactNode; cta?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed px-4 py-8 text-center text-sm"
         style={{ borderColor: "var(--border-strong)", color: "var(--text-muted)" }}>
      {children}
      {cta ? <div className="mt-3">{cta}</div> : null}
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="spin" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" opacity=".25" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Confidence({ level }: { level: "high" | "medium" | "low" }) {
  const n = level === "high" ? 3 : level === "medium" ? 2 : 1;
  return (
    <span className="inline-flex items-center gap-1 text-[10px]" style={{ color: "var(--text-muted)" }}
          title={`${level} confidence — based on how many readings and how much of the period is covered`}>
      <span className="flex gap-[2px]">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-[9px] w-[3px] rounded-sm"
                style={{ background: i < n ? "var(--text-secondary)" : "var(--gridline)" }} />
        ))}
      </span>
      {level}
    </span>
  );
}

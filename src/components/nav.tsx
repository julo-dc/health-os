"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/goals", label: "Goals" },
  { href: "/analyze", label: "Analyze" },
  { href: "/standing", label: "Standing" },
  { href: "/log", label: "Log" },
  { href: "/photos", label: "Photos" },
  { href: "/data", label: "Data" },
  { href: "/glossary", label: "Glossary" },
];

export function Nav({ user }: { user: { name: string | null; email: string; picture: string | null } }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 backdrop-blur"
            style={{ background: "color-mix(in srgb, var(--plane) 88%, transparent)", borderBottom: "1px solid var(--border)" }}>
      <div className="mx-auto flex max-w-[1400px] items-center gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <span className="grid h-7 w-7 place-items-center rounded-lg text-[13px] font-bold text-white"
                style={{ background: "var(--series-1)" }}>V</span>
          Vector
        </Link>

        <nav className="ml-2 hidden items-center gap-0.5 md:flex">
          {LINKS.map((l) => {
            const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
            return (
              <Link key={l.href} href={l.href}
                    className="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
                    style={{
                      color: active ? "var(--text-primary)" : "var(--text-secondary)",
                      background: active ? "var(--surface-2)" : "transparent",
                    }}>
                {l.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link href="/settings" className="btn btn-ghost hidden sm:inline-flex">Settings</Link>
          <div className="relative">
            <button onClick={() => setOpen((o) => !o)}
                    className="grid h-8 w-8 place-items-center overflow-hidden rounded-full text-xs font-semibold"
                    style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)" }}
                    aria-label="Account menu">
              {user.picture
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={user.picture} alt="" className="h-full w-full object-cover" />
                : (user.name ?? user.email)[0].toUpperCase()}
            </button>
            {open ? (
              <div className="absolute right-0 mt-2 w-56 rounded-xl p-1.5 text-sm"
                   style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", boxShadow: "var(--shadow)" }}>
                <div className="px-2.5 py-2 text-xs" style={{ color: "var(--text-muted)" }}>{user.email}</div>
                <div className="divider my-1" />
                {LINKS.map((l) => (
                  <Link key={l.href} href={l.href} onClick={() => setOpen(false)}
                        className="block rounded-lg px-2.5 py-1.5 md:hidden" style={{ color: "var(--text-secondary)" }}>
                    {l.label}
                  </Link>
                ))}
                <Link href="/settings" onClick={() => setOpen(false)}
                      className="block rounded-lg px-2.5 py-1.5" style={{ color: "var(--text-secondary)" }}>Settings</Link>
                <form action="/api/auth/logout" method="post">
                  <button type="submit" className="w-full rounded-lg px-2.5 py-1.5 text-left" style={{ color: "var(--status-critical)" }}>
                    Sign out
                  </button>
                </form>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </header>
  );
}

"use client";
import { useState } from "react";
import { Section, StatusPill, Spinner } from "@/components/ui";
import { fmtNum } from "@/components/charts";

export function SettingsClient({ user, google, llm, prefs, counts }: {
  user: { email: string; name: string | null };
  google: { connected: boolean; hasRefresh: boolean; scopes: string[]; expected: string[]; daysLeftIfTesting: number | null };
  llm: { enabled: boolean; model: string; vision: string };
  prefs: { tz: string; age: number | null; sex: "male" | "female" | null };
  counts: { metrics: number; workouts: number; photos: number; entries: number };
}) {
  const [age, setAge] = useState(prefs.age ?? "");
  const [sex, setSex] = useState<string>(prefs.sex ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const savePrefs = async () => {
    setSaving(true); setSaved(false);
    await fetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ age: age === "" ? null : Number(age), sex: sex || null }),
    });
    setSaving(false); setSaved(true);
  };

  const missing = google.expected.filter((s) => !google.scopes.includes(s));

  return (
    <div className="space-y-5 rise">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{user.email}</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Google Health" subtitle="One consent covers sign-in and read-only health data">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={google.connected ? "good" : "critical"}>
              {google.connected ? "Connected" : "Disconnected"}
            </StatusPill>
            {!google.hasRefresh && google.connected ? (
              <StatusPill tone="warning">No refresh token — reconnect for background sync</StatusPill>
            ) : null}
            {google.connected && google.daysLeftIfTesting !== null ? (
              <StatusPill tone={google.daysLeftIfTesting < 2 ? "critical" : google.daysLeftIfTesting < 8 ? "warning" : "good"}>
                {google.daysLeftIfTesting < 0.5
                  ? "Consent expired"
                  : `~${Math.floor(google.daysLeftIfTesting)}d of consent left`}
              </StatusPill>
            ) : null}
          </div>
          {google.connected && google.daysLeftIfTesting !== null && google.daysLeftIfTesting < 8 ? (
            <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
              Google caps refresh tokens at 7 days while the consent screen sits in <b>Testing</b>.
              Setting the app to <b>In production</b> in the Google Auth Platform removes the cap —
              you&apos;ll click past one &quot;unverified app&quot; warning, and full verification is only
              required above 100 users.
            </p>
          ) : null}

          {missing.length ? (
            <div className="mt-3 rounded-lg px-3 py-2.5 text-xs bg-warning">
              <b className="tone-warning">Some scopes weren&apos;t granted.</b>
              <ul className="mt-1.5 space-y-0.5 num" style={{ color: "var(--text-secondary)" }}>
                {missing.map((s) => <li key={s}>· {s.split("/").pop()}</li>)}
              </ul>
              <p className="mt-1.5" style={{ color: "var(--text-muted)" }}>
                Data covered by these won&apos;t sync. Reconnect and tick every box on the consent screen.
              </p>
            </div>
          ) : google.connected ? (
            <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>All requested scopes granted.</p>
          ) : null}

          <a href="/api/auth/login" className="btn mt-4">
            {google.connected ? "Reconnect / re-grant scopes" : "Connect Google"}
          </a>
        </Section>

        <Section title="AI model" subtitle="OpenRouter — used for briefings, goal parsing and photo analysis">
          <div className="flex items-center gap-2">
            <StatusPill tone={llm.enabled ? "good" : "warning"}>
              {llm.enabled ? "Key configured" : "No API key"}
            </StatusPill>
          </div>
          {llm.enabled ? (
            <dl className="mt-3 space-y-2 text-xs">
              <div className="flex justify-between gap-3">
                <dt style={{ color: "var(--text-secondary)" }}>Text model</dt>
                <dd className="num font-medium">{llm.model}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt style={{ color: "var(--text-secondary)" }}>Vision model</dt>
                <dd className="num font-medium">{llm.vision}</dd>
              </div>
            </dl>
          ) : null}
          <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
            Set <code>OPENROUTER_API_KEY</code>, and optionally <code>OPENROUTER_MODEL</code> /{" "}
            <code>OPENROUTER_VISION_MODEL</code>, in your environment. Every statistical feature works without a key —
            only the written interpretation needs one.
          </p>
        </Section>

        <Section title="Personal" subtitle="Used by the training model and population benchmarks">
          <div className="flex flex-wrap gap-3">
            <label className="block text-xs">
              <span className="label mb-1 block">Age</span>
              <input className="input num w-24" type="number" value={age} placeholder="—"
                     onChange={(e) => setAge(e.target.value)} />
            </label>
            <label className="block text-xs">
              <span className="label mb-1 block">Sex</span>
              <select className="input w-32" value={sex} onChange={(e) => setSex(e.target.value)}>
                <option value="">—</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
            </label>
          </div>
          <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
            Age sets your estimated max heart rate (Tanaka), which scales training-load intensity.
            Both are needed for population benchmarks, which are stratified by age and sex.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <button onClick={savePrefs} disabled={saving} className="btn">
              {saving ? <><Spinner /> Saving…</> : "Save"}
            </button>
            {saved ? <span className="text-xs tone-good">Saved</span> : null}
          </div>
        </Section>

        <Section title="Your data" subtitle="Everything lives in your own Postgres database">
          <div className="grid grid-cols-2 gap-3">
            {[
              ["Metric readings", counts.metrics],
              ["Workouts", counts.workouts],
              ["Photos", counts.photos],
              ["Journal entries", counts.entries],
            ].map(([label, n]) => (
              <div key={label as string} className="rounded-lg p-3" style={{ background: "var(--surface-2)" }}>
                <div className="label">{label as string}</div>
                <div className="num mt-1 text-xl font-semibold">{fmtNum(n as number, 0)}</div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
            Nothing is sent anywhere except Google (to read your health data) and OpenRouter (only the computed
            statistics and any images you upload, when you ask for a briefing or analysis).
          </p>
        </Section>
      </div>
    </div>
  );
}

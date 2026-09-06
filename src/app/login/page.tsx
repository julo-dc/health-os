export const dynamic = "force-dynamic";

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const missing = [
    ["GOOGLE_CLIENT_ID", process.env.GOOGLE_CLIENT_ID],
    ["GOOGLE_CLIENT_SECRET", process.env.GOOGLE_CLIENT_SECRET],
    ["OAUTH_REDIRECT_URI", process.env.OAUTH_REDIRECT_URI],
    ["SESSION_SECRET", process.env.SESSION_SECRET],
    ["DATABASE_URL", process.env.DATABASE_URL],
    ["ALLOWED_EMAILS", process.env.ALLOWED_EMAILS],
  ].filter(([, v]) => !v).map(([k]) => k as string);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rise">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl text-lg font-bold text-white"
               style={{ background: "var(--series-1)" }}>V</div>
          <h1 className="text-2xl font-semibold tracking-tight">Vector</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
            Your health, training and work data, pointed at one goal.
          </p>
        </div>

        <div className="card-pad">
          {error ? (
            <div className="mb-4 rounded-lg px-3 py-2.5 text-sm bg-critical tone-critical">
              <b>Sign-in failed.</b> {decodeURIComponent(error)}
            </div>
          ) : null}

          {missing.length ? (
            <div className="mb-4 rounded-lg px-3 py-2.5 text-sm bg-warning">
              <b className="tone-warning">Not configured yet.</b>
              <div className="mt-1.5" style={{ color: "var(--text-secondary)" }}>
                Missing environment {missing.length === 1 ? "variable" : "variables"}:
                <code className="ml-1 num">{missing.join(", ")}</code>
              </div>
              <div className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
                Copy <code>.env.example</code> to <code>.env.local</code> and fill it in, then restart.
              </div>
            </div>
          ) : null}

          <a href="/api/auth/login" className="btn btn-primary w-full">
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
              <path fill="currentColor" d="M12.24 10.3v3.55h5.03a4.3 4.3 0 0 1-1.87 2.82l3.02 2.34c1.76-1.62 2.78-4.02 2.78-6.87 0-.66-.06-1.3-.17-1.9z"/>
              <path fill="currentColor" d="M12.24 21c2.52 0 4.64-.83 6.18-2.26l-3.02-2.34c-.84.56-1.9.9-3.16.9-2.43 0-4.5-1.64-5.23-3.85l-3.12 2.4A9.34 9.34 0 0 0 12.24 21"/>
              <path fill="currentColor" d="M7.01 13.45a5.6 5.6 0 0 1 0-3.57l-3.12-2.4a9.3 9.3 0 0 0 0 8.37z"/>
              <path fill="currentColor" d="M12.24 5.98c1.37 0 2.6.47 3.57 1.4l2.67-2.67C16.87 3.2 14.75 2.3 12.24 2.3a9.34 9.34 0 0 0-8.35 5.18l3.12 2.4c.73-2.21 2.8-3.9 5.23-3.9"/>
            </svg>
            Continue with Google
          </a>

          <p className="mt-4 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
            One consent covers sign-in and read-only access to your Google Health data
            (the cloud API that serves Fitbit). Only addresses listed in{" "}
            <code>ALLOWED_EMAILS</code> can sign in.
          </p>
        </div>
      </div>
    </div>
  );
}

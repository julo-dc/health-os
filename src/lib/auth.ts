import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { sql, ensureDb } from "./db";
import { seedMetricDefs } from "./metrics";

const COOKIE = "vector_session";
const DAY = 60 * 60 * 24;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set (openssl rand -base64 32)");
  return new TextEncoder().encode(s);
}

export type SessionUser = { id: number; email: string; name: string | null; picture: string | null };

/**
 * Scopes requested in a single consent screen: identity for sign-in, plus the
 * read-only Google Health scopes that cover everything Fitbit records.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  "https://www.googleapis.com/auth/googlehealth.nutrition.readonly",
  "https://www.googleapis.com/auth/googlehealth.profile.readonly",
];

export function authUrl(state: string) {
  const p = new URLSearchParams({
    client_id: requireEnv("GOOGLE_CLIENT_ID"),
    redirect_uri: requireEnv("OAUTH_REDIRECT_URI"),
    response_type: "code",
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    scope: GOOGLE_SCOPES.join(" "),
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export async function exchangeCode(code: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      redirect_uri: requireEnv("OAUTH_REDIRECT_URI"),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    id_token: string;
  };
}

/** Decode the id_token payload. Signature is implicitly trusted: it came straight
 *  from Google's token endpoint over TLS in direct response to our own code. */
export function decodeIdToken(idToken: string) {
  const [, payload] = idToken.split(".");
  const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json) as { email: string; name?: string; picture?: string; email_verified?: boolean };
}

export function emailAllowed(email: string): boolean {
  const allow = (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!allow.length) return false;
  return allow.includes(email.toLowerCase());
}

export async function upsertUser(profile: { email: string; name?: string; picture?: string }) {
  await ensureDb();
  const [u] = await sql<{ id: number }[]>`
    INSERT INTO users (email, name, picture)
    VALUES (${profile.email}, ${profile.name ?? null}, ${profile.picture ?? null})
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, picture = EXCLUDED.picture
    RETURNING id`;
  await seedMetricDefs(u.id);
  await sql`INSERT INTO settings (user_id) VALUES (${u.id}) ON CONFLICT DO NOTHING`;
  return u.id;
}

export async function saveTokens(
  userId: number,
  t: { access_token: string; refresh_token?: string; expires_in: number; scope: string }
) {
  const expires = new Date(Date.now() + (t.expires_in - 60) * 1000);
  // Only stamp the consent time when Google actually returned a refresh token,
  // so this tracks consent age rather than the last access-token refresh.
  const consentAt = t.refresh_token ? new Date() : null;

  await sql`
    INSERT INTO oauth_tokens (user_id, provider, access_token, refresh_token, expires_at, scope,
                              updated_at, refresh_issued_at)
    VALUES (${userId}, 'google', ${t.access_token}, ${t.refresh_token ?? null}, ${expires}, ${t.scope},
            now(), ${consentAt})
    ON CONFLICT (user_id, provider) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      -- Google only returns a refresh_token on first consent; never clobber
      -- either it or its timestamp with the null of a plain token refresh.
      refresh_token     = COALESCE(EXCLUDED.refresh_token, oauth_tokens.refresh_token),
      refresh_issued_at = COALESCE(EXCLUDED.refresh_issued_at, oauth_tokens.refresh_issued_at),
      expires_at = EXCLUDED.expires_at,
      scope = EXCLUDED.scope,
      updated_at = now()`;
}

/** Returns a valid access token, refreshing it if it has expired. */
export async function getAccessToken(userId: number): Promise<string | null> {
  const [row] = await sql<
    { access_token: string; refresh_token: string | null; expires_at: Date }[]
  >`SELECT access_token, refresh_token, expires_at FROM oauth_tokens
    WHERE user_id = ${userId} AND provider = 'google'`;
  if (!row) return null;
  if (row.expires_at && row.expires_at.getTime() > Date.now()) return row.access_token;
  if (!row.refresh_token) return null;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: row.refresh_token,
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) return null;
  const t = (await res.json()) as { access_token: string; expires_in: number; scope?: string };
  await sql`
    UPDATE oauth_tokens SET access_token = ${t.access_token},
      expires_at = ${new Date(Date.now() + (t.expires_in - 60) * 1000)}, updated_at = now()
    WHERE user_id = ${userId} AND provider = 'google'`;
  return t.access_token;
}

/**
 * Health of the Google connection.
 *
 * Google expires refresh tokens after 7 days for External apps whose consent
 * screen is still in "Testing" status and which request sensitive scopes —
 * health data qualifies. Rather than letting a sync fail mystifyingly a week
 * later, surface how long the current consent has left.
 */
export const TESTING_REFRESH_TOKEN_DAYS = 7;

export async function getConnectionHealth(userId: number) {
  const [row] = await sql<
    { refresh_token: string | null; refresh_issued_at: Date | null; scope: string | null }[]
  >`SELECT refresh_token, refresh_issued_at, scope FROM oauth_tokens
    WHERE user_id = ${userId} AND provider = 'google'`;

  if (!row) return { connected: false, hasRefresh: false, consentAgeDays: null, daysLeftIfTesting: null };

  const ageMs = row.refresh_issued_at ? Date.now() - row.refresh_issued_at.getTime() : null;
  const consentAgeDays = ageMs === null ? null : ageMs / 86_400_000;
  return {
    connected: true,
    hasRefresh: Boolean(row.refresh_token),
    consentAgeDays,
    daysLeftIfTesting: consentAgeDays === null
      ? null
      : Math.max(0, TESTING_REFRESH_TOKEN_DAYS - consentAgeDays),
  };
}

export async function createSession(userId: number) {
  const jwt = await new SignJWT({ uid: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret());
  (await cookies()).set(COOKIE, jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * DAY,
  });
}

export async function destroySession() {
  (await cookies()).delete(COOKIE);
}

/** Current signed-in user, or null. */
export async function getUser(): Promise<SessionUser | null> {
  try {
    const jar = await cookies();
    const token = jar.get(COOKIE)?.value;
    if (!token) return null;
    const { payload } = await jwtVerify(token, secret());
    const uid = payload.uid as number;
    await ensureDb();
    const [u] = await sql<SessionUser[]>`
      SELECT id, email, name, picture FROM users WHERE id = ${uid}`;
    return u ?? null;
  } catch {
    return null;
  }
}

/** Use inside API routes: throws a 401-shaped error when unauthenticated. */
export async function requireUser(): Promise<SessionUser> {
  const u = await getUser();
  if (!u) throw new HttpError(401, "Not signed in");
  return u;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

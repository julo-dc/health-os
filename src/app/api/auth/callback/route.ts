import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeCode, decodeIdToken, emailAllowed, upsertUser, saveTokens, createSession } from "@/lib/auth";

function home(req: Request, path: string) {
  return NextResponse.redirect(new URL(path, new URL(req.url).origin));
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");
  if (err) return home(req, `/login?error=${encodeURIComponent(err)}`);
  if (!code) return home(req, "/login?error=missing_code");

  const expected = (await cookies()).get("oauth_state")?.value;
  if (!expected || expected !== state) return home(req, "/login?error=state_mismatch");

  try {
    const tokens = await exchangeCode(code);
    const profile = decodeIdToken(tokens.id_token);
    if (!profile.email) return home(req, "/login?error=no_email");
    if (!emailAllowed(profile.email)) {
      return home(req, `/login?error=${encodeURIComponent(`${profile.email} is not in ALLOWED_EMAILS`)}`);
    }
    const userId = await upsertUser(profile);
    await saveTokens(userId, tokens);
    await createSession(userId);
    const res = home(req, "/");
    res.cookies.delete("oauth_state");
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "auth_failed";
    return home(req, `/login?error=${encodeURIComponent(msg)}`);
  }
}

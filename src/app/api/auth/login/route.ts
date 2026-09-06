import { NextResponse } from "next/server";
import { authUrl } from "@/lib/auth";
import { randomBytes } from "crypto";

export async function GET() {
  try {
    const state = randomBytes(16).toString("hex");
    const res = NextResponse.redirect(authUrl(state));
    res.cookies.set("oauth_state", state, {
      httpOnly: true, secure: process.env.NODE_ENV === "production",
      sameSite: "lax", path: "/", maxAge: 600,
    });
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Auth not configured";
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(msg)}`, process.env.OAUTH_REDIRECT_URI ?? "http://localhost:3000"));
  }
}

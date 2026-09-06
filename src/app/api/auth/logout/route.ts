import { NextResponse } from "next/server";
import { destroySession } from "@/lib/auth";

export async function POST(req: Request) {
  await destroySession();
  return NextResponse.redirect(new URL("/login", new URL(req.url).origin), { status: 303 });
}

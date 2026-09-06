import { NextResponse } from "next/server";
import { requireUser, HttpError, type SessionUser } from "./auth";
import { ensureDb } from "./db";

/** Wraps a route handler with auth + schema bootstrap + uniform error shape. */
export function route<T>(
  handler: (user: SessionUser, req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<T>
) {
  return async (req: Request, ctx: { params: Promise<Record<string, string>> }) => {
    try {
      await ensureDb();
      const user = await requireUser();
      const result = await handler(user, req, ctx);
      return result instanceof NextResponse ? result : NextResponse.json(result);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof Error ? e.message : "Unexpected error";
      if (status >= 500) console.error("[api]", message, e);
      return NextResponse.json({ error: message }, { status });
    }
  };
}

export const bad = (msg: string) => new HttpError(400, msg);

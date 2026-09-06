import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { sql, ensureDb } from "@/lib/db";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ensureDb();
  const user = await getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const id = Number((await ctx.params).id);

  const [row] = await sql<{ bytes: Buffer; mime: string }[]>`
    SELECT bytes, mime FROM photos WHERE id = ${id} AND user_id = ${user.id}`;
  if (!row) return new NextResponse("Not found", { status: 404 });

  return new NextResponse(new Uint8Array(row.bytes), {
    headers: {
      "Content-Type": row.mime || "image/jpeg",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}

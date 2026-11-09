import { NextResponse, type NextRequest } from "next/server";
import { recordOpen } from "@/lib/marketing/campaigns";
import { PIXEL_GIF, verifyToken } from "@/lib/marketing/tracking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Open pixel. Always answers with a 1×1 GIF — a bad token simply records nothing. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const payload = verifyToken(token);
  if (payload?.kind === "open") await recordOpen(payload.recipientId).catch(() => undefined);
  return new NextResponse(new Uint8Array(PIXEL_GIF), {
    status: 200,
    headers: { "Content-Type": "image/gif", "Content-Length": String(PIXEL_GIF.length), "Cache-Control": "no-store, no-cache, must-revalidate, private", Pragma: "no-cache", "X-Robots-Tag": "noindex" },
  });
}

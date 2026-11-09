import { NextResponse, type NextRequest } from "next/server";
import { recordVital, VitalSchema } from "@/lib/vitals";
import { clientIp, rateLimitAsync } from "@/lib/request-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/vitals — anonymous Core Web Vitals sink for `<WebVitals />`.
 *
 *  - No auth, no cookies read, nothing identifying stored (see src/lib/vitals.ts).
 *  - Strict schema; the body is read once as text and capped at 2 KiB.
 *  - Rate-limited per IP and globally so a hostile client cannot grow the table.
 *  - Always 204 on success and 202 when the table is absent (migration pending)
 *    so the client never retries.
 */
const PER_IP = { limit: 60, windowMs: 60_000 } as const;
const GLOBAL = { limit: 3_000, windowMs: 60_000 } as const;

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const mine = await rateLimitAsync(`vitals:${ip}`, PER_IP);
  if (!mine.allowed) return new NextResponse(null, { status: 429 });
  const all = await rateLimitAsync("vitals:global", GLOBAL);
  if (!all.allowed) return new NextResponse(null, { status: 429 });

  const raw = await req.text().catch(() => "");
  if (raw.length > 2_048) return new NextResponse(null, { status: 413 });
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  const parsed = VitalSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });

  try {
    const stored = await recordVital(parsed.data);
    return new NextResponse(null, { status: stored ? 204 : 202 });
  } catch (err) {
    console.warn("[vitals] insert failed:", err instanceof Error ? err.message : err);
    return new NextResponse(null, { status: 202 });
  }
}

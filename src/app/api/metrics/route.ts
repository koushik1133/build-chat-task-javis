import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { collectGauges } from "@/lib/metrics/collect";
import { renderPrometheus } from "@/lib/metrics/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** GET /api/metrics — Prometheus text format. 404 when METRICS_TOKEN is unset; 401 without the bearer. */
export async function GET(req: Request) {
  const expected = process.env.METRICS_TOKEN?.trim();
  if (!expected) return new NextResponse("Not found", { status: 404 });
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m || !tokenMatches(m[1].trim(), expected)) {
    return new NextResponse("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  }
  const gauges = await collectGauges().catch(() => []);
  return new NextResponse(renderPrometheus(gauges), {
    status: 200,
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" },
  });
}

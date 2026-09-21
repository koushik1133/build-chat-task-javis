import { NextResponse } from "next/server";
import { z } from "zod";
import { putPageView } from "@/lib/dynamodb";
import { corsHeadersFor, corsPreflight, siteAllowedOrigins } from "@/lib/cors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ siteId: string }> };

async function corsFor(siteId: string) {
  const allowedOrigins = z.string().uuid().safeParse(siteId).success ? await siteAllowedOrigins(siteId) : [];
  return { allowedOrigins };
}

export async function OPTIONS(req: Request, { params }: Ctx) {
  const { siteId } = await params;
  return corsPreflight(req, await corsFor(siteId));
}

/**
 * Public analytics endpoint — called by the injected <script> in every
 * generated site.  No auth required; writes a page-view event to DynamoDB.
 *
 * DynamoDB is the ideal store for this workload:
 *   • High-throughput, append-only writes
 *   • Reads always scoped to a single siteId (partition key)
 *   • No relational queries needed
 */
export async function POST(req: Request, { params }: Ctx) {
  const { siteId } = await params;
  const corsHeaders = corsHeadersFor(req, await corsFor(siteId));
  try {

    if (!z.string().uuid().safeParse(siteId).success) {
      return NextResponse.json(
        { error: "Invalid site ID" },
        { status: 400, headers: corsHeaders }
      );
    }

    const body = await req.json().catch(() => ({}));
    const path = typeof body.path === "string" ? body.path : "/";
    const userAgent = req.headers.get("user-agent") ?? "Unknown";

    await putPageView({
      evtId: crypto.randomUUID(),
      siteId,
      path,
      userAgent,
      createdAt: new Date().toISOString(),
    });

    return NextResponse.json({ success: true }, { status: 200, headers: corsHeaders });
  } catch (e) {
    console.error("[analytics] error:", e);
    return NextResponse.json(
      { error: "Bad request" },
      { status: 400, headers: corsHeaders }
    );
  }
}

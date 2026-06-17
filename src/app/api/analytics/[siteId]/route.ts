import { NextResponse } from "next/server";
import { z } from "zod";
import { putPageView } from "@/lib/dynamodb";

export const runtime = "nodejs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200, headers: corsHeaders });
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
export async function POST(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> }
) {
  try {
    const { siteId } = await params;

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

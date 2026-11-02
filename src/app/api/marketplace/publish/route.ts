import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { publishListing } from "@/lib/marketplace/catalog";
import { listPublishable } from "@/lib/marketplace/export";
import { CATEGORIES, LISTING_KINDS, VISIBILITIES } from "@/lib/marketplace/types";
import { errorResponse, parseBody } from "@/lib/money/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    kind: z.enum(LISTING_KINDS),
    entityId: z.string().trim().min(1).max(200),
    visibility: z.enum(VISIBILITIES).optional(),
    title: z.string().trim().max(160).nullable().optional(),
    summary: z.string().trim().max(500).nullable().optional(),
    description_md: z.string().max(20_000).nullable().optional(),
    category: z.enum(CATEGORIES).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(30)).max(12).nullable().optional(),
    slug: z.string().trim().max(60).nullable().optional(),
  })
  .strict();

/** What the caller could publish (pickers for the publish dialog). */
export async function GET() {
  try {
    const scope = await requireScope({ area: "agents", edit: true });
    return NextResponse.json({ publishable: await listPublishable(scope.dataId) });
  } catch (err) {
    return errorResponse(err, "marketplace.publish.GET");
  }
}

/** Export an entity from the caller's org and create / re-version its listing. */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "agents", edit: true });
    const body = await parseBody(req, Body, 64_000);
    if (!body.ok) return body.res;
    const out = await publishListing(scope.dataId, body.data);
    return NextResponse.json({ listing: out.listing, scrubbed: out.scrubbed, updated: out.updated }, { status: out.updated ? 200 : 201 });
  } catch (err) {
    return errorResponse(err, "marketplace.publish.POST");
  }
}

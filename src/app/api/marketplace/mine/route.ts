import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { deleteListing, listMine, updateListing } from "@/lib/marketplace/catalog";
import { CATEGORIES, VISIBILITIES } from "@/lib/marketplace/types";
import { errorResponse, parseBody } from "@/lib/money/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Patch = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    summary: z.string().trim().max(500).nullable().optional(),
    description_md: z.string().max(20_000).nullable().optional(),
    category: z.enum(CATEGORIES).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(30)).max(12).optional(),
    visibility: z.enum(VISIBILITIES).optional(),
  })
  .strict();

function idParam(req: NextRequest): string | null {
  const id = req.nextUrl.searchParams.get("id")?.trim();
  return id && id.length <= 200 ? id : null;
}

export async function GET() {
  try {
    const scope = await requireScope({ area: "agents" });
    return NextResponse.json({ listings: await listMine(scope.dataId) });
  } catch (err) {
    return errorResponse(err, "marketplace.mine.GET");
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "agents", edit: true });
    const id = idParam(req);
    if (!id) return NextResponse.json({ error: "invalid_body", detail: "id query param required" }, { status: 400 });
    const body = await parseBody(req, Patch, 64_000);
    if (!body.ok) return body.res;
    return NextResponse.json({ listing: await updateListing(scope.dataId, id, body.data) });
  } catch (err) {
    return errorResponse(err, "marketplace.mine.PATCH");
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "agents", edit: true });
    const id = idParam(req);
    if (!id) return NextResponse.json({ error: "invalid_body", detail: "id query param required" }, { status: 400 });
    const ok = await deleteListing(scope.dataId, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "marketplace.mine.DELETE");
  }
}

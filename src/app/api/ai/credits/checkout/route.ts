import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { startCheckout } from "@/lib/credits/checkout";
import { getPack } from "@/lib/credits/packs";

export const runtime = "nodejs";

const Body = z.object({ packId: z.string().min(1).max(40) }).strict();

/** POST /api/ai/credits/checkout { packId } → 201 { url, purchaseId, provider } */
export async function POST(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "packId is required" }, { status: 400 });
  if (!getPack(parsed.data.packId)) return NextResponse.json({ error: "Unknown credit pack" }, { status: 404 });
  try {
    const out = await startCheckout(scope.dataId, parsed.data.packId);
    return NextResponse.json(
      { url: out.url, purchaseId: out.purchaseId, provider: out.provider, pack: out.pack },
      { status: 201, headers: { Location: out.url } }
    );
  } catch (err) {
    console.error("[ai/credits/checkout] failed:", err);
    return NextResponse.json({ error: "Could not start checkout." }, { status: 500 });
  }
}

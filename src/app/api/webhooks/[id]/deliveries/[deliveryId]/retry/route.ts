import { NextRequest, NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { retryDelivery } from "@/lib/webhooks/dispatch";

export const runtime = "nodejs";

/** POST /api/webhooks/[id]/deliveries/[deliveryId]/retry — re-queue a delivery for the next cron tick. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string; deliveryId: string }> }) {
  try {
    const scope = await requireScope({ area: "settings", edit: true });
    const { id, deliveryId } = await params;
    const delivery = await retryDelivery(scope.dataId, id, deliveryId);
    if (!delivery) return NextResponse.json({ error: "not_found", detail: "Delivery not found or not retryable" }, { status: 404 });
    return NextResponse.json({ delivery });
  } catch (err) {
    return scopeErrorResponse(err) ?? (console.error("[webhooks] retry failed:", err), NextResponse.json({ error: "Could not retry the delivery." }, { status: 500 }));
  }
}

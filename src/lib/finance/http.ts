import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/money/http";
import { isInsufficientStock } from "@/lib/inventory/stock";

/** Error mapping for inventory/finance routes: stock conflicts → 409, then the billing defaults. */
export function financeErrorResponse(err: unknown, log: string): NextResponse {
  if (isInsufficientStock(err)) {
    return NextResponse.json(
      { error: "insufficient_stock", detail: err.message, product_id: err.productId, requested: err.requested, available: err.available },
      { status: 409 }
    );
  }
  return errorResponse(err, log);
}

/** Read an optional ISO date-ish query param; returns null when absent or invalid. */
export function dateParam(req: NextRequest, name: string): string | null {
  const v = req.nextUrl.searchParams.get(name);
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function idParam(req: NextRequest): string | null {
  const v = req.nextUrl.searchParams.get("id")?.trim();
  return v && v.length <= 100 ? v : null;
}

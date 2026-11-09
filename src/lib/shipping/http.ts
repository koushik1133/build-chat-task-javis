import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/money/http";
import { planLimitResponse } from "@/lib/plans/http";
import { ShippingError } from "./types";

/** Error mapping shared by the shipping routes: domain errors keep their status, plan limits are 402. */
export function shippingError(err: unknown, log: string): NextResponse {
  if (err instanceof ShippingError) return NextResponse.json({ error: err.code, detail: err.message }, { status: err.status });
  return planLimitResponse(err) ?? errorResponse(err, log);
}

export const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;
